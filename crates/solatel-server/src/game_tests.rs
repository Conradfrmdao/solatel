//! What the lobby decides: who gets into a match, what a trigger does, and
//! where the money goes.
//!
//! A child module of `game`, so it can reach the lobby's private state
//! directly rather than through the command channel. These are unit tests of
//! the rules, not of the transport: every one drives `Lobby::handle` and
//! `Lobby::step` exactly as the connection layer does, and then reads the
//! same state the snapshot is built from.
//!
//! The shots go through `look_direction` rather than aiming the trace by
//! hand, because that is the function a real client's yaw and pitch pass
//! through. A test that aimed the ray directly would still pass if the
//! server started reading the look from somewhere other than the command it
//! fired on.

use super::*;
use solatel_protocol::glam::Vec3;
use solatel_protocol::sim::{Buttons, HEAD_BOTTOM, LEGS_TOP, MAX_HEALTH, look_direction};

/// Puts a player into the lobby and hands back what it decided.
///
/// The real connection layer does this and then waits on the reply before it
/// can write a `Welcome`, because only the lobby knows whether a token names
/// a player worth taking back.
fn join(
    lobby: &mut Lobby,
    name: &str,
    resume: Option<ResumeToken>,
    outbound: mpsc::Sender<ServerMsg>,
) -> (JoinOutcome, SessionId) {
    let session_id = SessionId::new();
    let (reply_tx, reply_rx) = oneshot::channel();
    lobby.handle(GameCommand::Join {
        session_id,
        account: None,
        name: name.into(),
        resume,
        outbound,
        reply: reply_tx,
    });
    let outcome = reply_rx
        .blocking_recv()
        .expect("the lobby should always answer a join");
    (outcome, session_id)
}

/// Yaw and pitch that look from `from` towards `to`.
///
/// The inverse of `look_direction`, checked against it on every call so a
/// mistake here cannot quietly aim every test somewhere else.
fn aim(from: Vec3, to: Vec3) -> (f32, f32) {
    let d = (to - from).normalize();
    let pitch = d.y.clamp(-1.0, 1.0).asin();
    let yaw = (-d.x).atan2(-d.z);
    let check = look_direction(yaw, pitch);
    assert!(
        (check - d).length() < 1e-3,
        "aim did not invert look_direction: wanted {d:?}, got {check:?}"
    );
    (yaw, pitch)
}

fn drain(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<ServerMsg> {
    let mut out = Vec::new();
    while let Ok(msg) = rx.try_recv() {
        out.push(msg);
    }
    out
}

/// How long a line waits in these tests before starting short of full.
///
/// Three seconds rather than the two minutes a real server waits. The rule
/// being tested is "hold the line, then start", and holding it for two
/// minutes of game time would mean stepping seven and a half thousand ticks
/// in every test that forms a match. Long enough that a test can look at the
/// line partway through the hold and see it still waiting. The one test that
/// cares about the real number reads `QUEUE_WAIT` itself.
const TEST_WAIT: f32 = 3.0;

/// A lobby with one table and no money in play.
///
/// Free play is the default for these because most of them are about the
/// rules rather than the till; the ones about money attach a recording ledger
/// and say so.
fn free_play() -> Lobby {
    let mut lobby = Lobby::new();
    lobby.floor = 1;
    lobby.wait = TEST_WAIT;
    lobby
}

/// Put a player in line for a named map at a named stake.
fn queue_map(
    lobby: &mut Lobby,
    player: PlayerId,
    session: SessionId,
    map_name: &str,
    dollars: i64,
) {
    lobby.handle(GameCommand::Queue {
        player_id: player,
        session_id: session,
        map: map_name.to_string(),
        tier_dollars: dollars,
    });
}

/// Put a player in line and run the matchmaker until something happens.
fn queue(lobby: &mut Lobby, player: PlayerId, session: SessionId, dollars: i64) {
    lobby.handle(GameCommand::Queue {
        player_id: player,
        session_id: session,
        // The tests play the arena unless they say otherwise: two of them
        // assert things about its staircases specifically, and the rest only
        // need somewhere with clear ground.
        map: map::TEST_MAP.name.to_string(),
        tier_dollars: dollars,
    });
}

/// Step until every queued player is in a match, or give up.
///
/// The matchmaker runs on its own interval and a line short of a full table
/// waits out its window before starting, so "form a match" is a span of time
/// rather than a call.
fn run_matchmaker(lobby: &mut Lobby) {
    let ticks = ((lobby.wait + 1.0) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        lobby.step();
        if lobby.matches.values().any(|m| m.running()) {
            return;
        }
    }
}

// --- Matchmaking ----------------------------------------------------------

#[test]
fn a_player_who_joins_is_in_the_lobby_and_in_no_match() {
    let mut lobby = free_play();
    let (tx, mut rx) = mpsc::channel(64);
    let (outcome, _session) = join(&mut lobby, "Newcomer", None, tx);

    assert!(
        lobby.matches.is_empty(),
        "arriving should not start a match on its own"
    );
    assert_eq!(
        lobby.connections[&outcome.player_id].at,
        Whereabouts::Idle,
        "a player who has asked for nothing should be waiting for nothing"
    );
    let told = drain(&mut rx)
        .into_iter()
        .any(|msg| matches!(msg, ServerMsg::Lobby { .. }));
    assert!(told, "a player who joins should be shown the tables");
}

#[test]
fn a_full_line_seats_everybody_it_took() {
    let mut lobby = free_play();
    let seats = map::active().max_players;
    let mut players = Vec::new();
    for i in 0..seats {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut lobby, &format!("P{i}"), None, tx);
        queue(&mut lobby, outcome.player_id, session, 1);
        players.push(outcome.player_id);
    }

    // No patience needed: a full table starts at once.
    for _ in 0..(MATCHMAKE_INTERVAL as usize + 2) {
        lobby.step();
    }

    assert_eq!(lobby.matches.len(), 1, "a full line should form one match");
    let game = lobby.matches.values().next().unwrap();
    assert!(game.running());
    assert_eq!(
        game.bodies.len(),
        seats,
        "everybody in line should be in it"
    );
}

#[test]
fn a_short_line_waits_and_then_starts_anyway() {
    let mut lobby = free_play();
    lobby.floor = 2;
    let mut sessions = Vec::new();
    for i in 0..2 {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut lobby, &format!("P{i}"), None, tx);
        queue(&mut lobby, outcome.player_id, session, 1);
        sessions.push(outcome.player_id);
    }

    // Two is under the target, so nothing happens for a good while.
    for _ in 0..(MATCHMAKE_INTERVAL as usize + 2) {
        lobby.step();
    }
    assert!(
        lobby.matches.is_empty(),
        "a short line should not start the instant it forms"
    );

    // But it does start. A queue that insisted on a full table would never
    // start on a quiet server, and a player staring at "waiting for players"
    // has been told the game is broken.
    run_matchmaker(&mut lobby);
    assert_eq!(
        lobby.matches.len(),
        1,
        "a short line should start once it has waited long enough"
    );
}

#[test]
fn a_line_holds_for_latecomers_rather_than_starting_the_instant_it_can() {
    let mut lobby = free_play();
    lobby.floor = 4;
    let seats = map::active().max_players;
    assert!(
        lobby.floor < seats,
        "this test needs a table that seats more than the floor"
    );

    let queue_one = |lobby: &mut Lobby, i: usize| {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(lobby, &format!("P{i}"), None, tx);
        queue(lobby, outcome.player_id, session, 1);
    };

    for i in 0..lobby.floor {
        queue_one(&mut lobby, i);
    }
    // Enough to play. Starting now would be responsive and wasteful: it is
    // what split thirteen people arriving together into a match of six and a
    // match of seven, because the sixth tripped the threshold while the rest
    // were still queueing.
    for _ in 0..(MATCHMAKE_INTERVAL as usize * 2) {
        lobby.step();
    }
    assert!(
        lobby.matches.is_empty(),
        "the line started before it had given anybody else a chance to join it"
    );

    // Three more arrive during the window and belong in the same match.
    let floor = lobby.floor;
    for i in floor..floor + 3 {
        queue_one(&mut lobby, i);
    }
    let ticks = ((lobby.wait + 1.0) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        lobby.step();
    }

    assert_eq!(lobby.matches.len(), 1, "one line should make one match");
    assert_eq!(
        lobby.matches.values().next().unwrap().bodies.len(),
        floor + 3,
        "everybody who arrived during the window should be in it"
    );
}

#[test]
fn a_full_table_starts_before_the_window_is_anywhere_near_up() {
    // The real window, not the short one these tests otherwise use: what is
    // being proved is that filling the table skips it entirely.
    let mut lobby = free_play();
    lobby.floor = 4;
    lobby.wait = QUEUE_WAIT;
    let seats = map::active().max_players;
    for i in 0..seats {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut lobby, &format!("P{i}"), None, tx);
        queue(&mut lobby, outcome.player_id, session, 1);
    }

    for _ in 0..(MATCHMAKE_INTERVAL as usize + 2) {
        lobby.step();
    }
    assert_eq!(
        lobby.matches.len(),
        1,
        "a full table should not sit out a two minute window"
    );
    assert!(lobby.matches.values().next().unwrap().running());
}

#[test]
fn a_line_under_the_floor_waits_however_long_it_has_been_there() {
    let mut lobby = free_play();
    lobby.floor = 4;
    for i in 0..3 {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut lobby, &format!("P{i}"), None, tx);
        queue(&mut lobby, outcome.player_id, session, 1);
    }

    // Several windows go by. Three people is under the floor, and a match
    // below it is not worth running however long they have waited.
    let ticks = ((lobby.wait * 5.0) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        lobby.step();
    }
    assert!(
        lobby.matches.is_empty(),
        "a line under the floor started anyway"
    );

    // A fourth arrives and it goes.
    let (tx, _rx) = mpsc::channel(64);
    let (outcome, session) = join(&mut lobby, "P3", None, tx);
    queue(&mut lobby, outcome.player_id, session, 1);
    run_matchmaker(&mut lobby);
    assert_eq!(
        lobby.matches.len(),
        1,
        "the floor was reached and the window had long since passed"
    );
    assert_eq!(lobby.matches.values().next().unwrap().bodies.len(), 4);
}

#[test]
fn a_full_table_seats_exactly_what_it_holds() {
    let mut lobby = free_play();
    lobby.floor = 2;
    let seats = map::active().max_players;
    for i in 0..seats {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut lobby, &format!("P{i}"), None, tx);
        queue(&mut lobby, outcome.player_id, session, 1);
    }
    // Well inside the gather window. A full table has nothing to gain by
    // holding, and everybody in it has something to lose.
    for _ in 0..(MATCHMAKE_INTERVAL as usize + 2) {
        lobby.step();
    }
    assert_eq!(
        lobby.matches.len(),
        1,
        "a full table should start at once rather than sitting out the hold"
    );
}

#[test]
fn a_line_below_the_floor_never_starts() {
    let mut lobby = free_play();
    lobby.floor = 2;
    let (tx, _rx) = mpsc::channel(64);
    let (outcome, session) = join(&mut lobby, "Lonely", None, tx);
    queue(&mut lobby, outcome.player_id, session, 1);

    run_matchmaker(&mut lobby);
    assert!(
        lobby.matches.is_empty(),
        "one player alone has nobody to play against, so there is no match to make"
    );
}

#[test]
fn several_matches_run_at_once() {
    let mut lobby = free_play();
    lobby.floor = 2;
    lobby.tiers = vec![
        Stakes::from_usd(1).unwrap(),
        Stakes::from_usd(5).unwrap(),
        Stakes::from_usd(10).unwrap(),
    ];

    for (i, dollars) in [1i64, 1, 5, 5, 10, 10].into_iter().enumerate() {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut lobby, &format!("P{i}"), None, tx);
        queue(&mut lobby, outcome.player_id, session, dollars);
    }

    let ticks = ((lobby.wait + 1.0) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        lobby.step();
    }

    assert_eq!(
        lobby.matches.len(),
        3,
        "three tables with two players each should be three matches, not one queue"
    );
    let mut stakes: Vec<i64> = lobby.matches.values().map(|m| m.stakes.dollars()).collect();
    stakes.sort_unstable();
    assert_eq!(stakes, vec![1, 5, 10]);
}

#[test]
fn a_player_is_never_placed_into_two_matches() {
    let mut lobby = free_play();
    lobby.floor = 1;
    let (tx, _rx) = mpsc::channel(64);
    let (outcome, session) = join(&mut lobby, "Eager", None, tx);
    queue(&mut lobby, outcome.player_id, session, 1);
    run_matchmaker(&mut lobby);

    // Asking again while in a match is refused: one entry fee buys one life,
    // and the way back is a new match after this one lets them go.
    queue(&mut lobby, outcome.player_id, session, 1);
    for _ in 0..(MATCHMAKE_INTERVAL as usize * 4) {
        lobby.step();
    }
    assert_eq!(
        lobby.matches.len(),
        1,
        "a player already in a match was put in line for another"
    );
}

#[test]
fn leaving_the_queue_takes_a_player_out_of_the_reckoning() {
    let mut lobby = free_play();
    lobby.floor = 2;
    let mut ids = Vec::new();
    for i in 0..2 {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut lobby, &format!("P{i}"), None, tx);
        queue(&mut lobby, outcome.player_id, session, 1);
        ids.push((outcome.player_id, session));
    }
    lobby.handle(GameCommand::LeaveQueue {
        player_id: ids[0].0,
        session_id: ids[0].1,
    });

    run_matchmaker(&mut lobby);
    assert!(
        lobby.matches.is_empty(),
        "the line was one short once somebody left it, so nothing should have formed"
    );
}

#[test]
fn a_player_whose_socket_dropped_is_not_placed_into_a_match() {
    let mut lobby = free_play();
    lobby.floor = 2;
    let mut ids = Vec::new();
    for i in 0..2 {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut lobby, &format!("P{i}"), None, tx);
        queue(&mut lobby, outcome.player_id, session, 1);
        ids.push((outcome.player_id, session));
    }
    // One of them closes the tab while waiting. Their place is held until
    // the resume window closes, but putting them in a match would charge an
    // entry fee to somebody who is not there to play it.
    lobby.handle(GameCommand::Leave {
        player_id: ids[0].0,
        session_id: ids[0].1,
    });

    run_matchmaker(&mut lobby);
    assert!(
        lobby.matches.is_empty(),
        "a match was formed around somebody who had already gone"
    );

    // And they are back in the line the moment they are.
    let token = lobby.connections[&ids[0].0].resume_token;
    let (tx, _rx) = mpsc::channel(64);
    let (outcome, _session) = join(&mut lobby, "P0", Some(token), tx);
    assert!(outcome.resumed);
    run_matchmaker(&mut lobby);
    assert_eq!(
        lobby.matches.len(),
        1,
        "coming back should put them in line where they left off"
    );
}

#[test]
fn one_table_can_run_several_matches_at_once() {
    let mut lobby = free_play();
    lobby.floor = 2;
    let seats = map::active().max_players;
    // Two and a bit tables' worth of people, all wanting the same stake.
    for i in 0..(seats * 2 + 3) {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut lobby, &format!("P{i}"), None, tx);
        queue(&mut lobby, outcome.player_id, session, 1);
    }

    // Two full tables form at once. The three left over are above the floor
    // but below the target, so they wait out the longer fallback rather than
    // the gather - which is the right answer and is why this waits for it.
    for _ in 0..(MATCHMAKE_INTERVAL as usize + 2) {
        lobby.step();
    }
    assert_eq!(
        lobby.matches.len(),
        2,
        "two full tables should form immediately"
    );

    let ticks = ((lobby.wait + 1.0) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        lobby.step();
    }
    assert_eq!(
        lobby.matches.len(),
        3,
        "one line long enough for three matches should make three, not one"
    );
    assert!(
        lobby.matches.values().all(|m| m.stakes.dollars() == 1),
        "all three are the same table; nothing about a match is exclusive to its stake"
    );
    let seated: usize = lobby.matches.values().map(|m| m.bodies.len()).sum();
    assert_eq!(seated, seats * 2 + 3, "everybody in line should be playing");
    let ids: std::collections::HashSet<MatchId> = lobby.matches.keys().copied().collect();
    assert_eq!(ids.len(), 3, "three matches, three identities");
}

#[test]
fn a_match_ends_when_only_one_player_is_left() {
    let mut duel = Duel::new();
    // Two of the three die, and the third has won. Holding them on an empty
    // map for the rest of five minutes is not suspense, it is a player
    // waiting to be given their stake back.
    for id in [duel.victim, duel.bystander] {
        duel.lobby
            .matches
            .get_mut(&duel.match_id)
            .unwrap()
            .bodies
            .get_mut(&id)
            .unwrap()
            .state
            .health = 0;
    }
    duel.lobby.step();

    assert!(
        !duel.lobby.matches.contains_key(&duel.match_id),
        "a match with one player left standing should be over"
    );
    assert_eq!(
        duel.lobby.connections[&duel.shooter].at,
        Whereabouts::Idle,
        "the winner should be back in the lobby"
    );
}

#[test]
fn a_table_only_shows_a_countdown_when_one_means_something() {
    let mut lobby = free_play();
    lobby.floor = 4;
    let seats = map::active().max_players;
    let table = |lobby: &Lobby| lobby.tables().into_iter().next().unwrap();

    // Nobody waiting: nothing is going to happen, so nothing is counted down.
    assert_eq!(table(&lobby).forming_in_ms, 0);
    assert_eq!(table(&lobby).needed, 4, "the floor is what a player needs");

    // Under the floor. Still not counting down to anything - a clock here
    // would run out and be followed by nothing, which is worse than no clock.
    for i in 0..3 {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut lobby, &format!("P{i}"), None, tx);
        queue(&mut lobby, outcome.player_id, session, 1);
    }
    lobby.step();
    assert_eq!(table(&lobby).waiting, 3);
    assert_eq!(
        table(&lobby).forming_in_ms,
        0,
        "a line under the floor was given a countdown it will not honour"
    );

    // At the floor, there is a real window to report.
    let (tx, _rx) = mpsc::channel(64);
    let (outcome, session) = join(&mut lobby, "P3", None, tx);
    queue(&mut lobby, outcome.player_id, session, 1);
    lobby.step();
    assert!(
        table(&lobby).forming_in_ms > 0,
        "a line at the floor is counting down and should say so"
    );

    // A full table is not counting down, it is starting.
    let mut full = free_play();
    full.floor = 4;
    full.wait = QUEUE_WAIT;
    for i in 0..seats {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut full, &format!("F{i}"), None, tx);
        queue(&mut full, outcome.player_id, session, 1);
    }
    assert_eq!(
        full.tables()[0].forming_in_ms,
        0,
        "a full table has nothing to wait for"
    );
}

#[test]
fn a_table_is_a_map_and_a_stake() {
    let mut lobby = free_play();
    lobby.floor = 2;
    let maps: Vec<&str> = map::MAPS.iter().map(|m| m.name).collect();
    assert!(maps.len() >= 2, "this test needs two maps");

    // Two people want the arena at a dollar and two want the yard at a
    // dollar. Same stake, different ground: two lines, not one.
    for (i, ground) in [maps[0], maps[0], maps[1], maps[1]].into_iter().enumerate() {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut lobby, &format!("P{i}"), None, tx);
        queue_map(&mut lobby, outcome.player_id, session, ground, 1);
    }

    let ticks = ((lobby.wait + 1.0) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        lobby.step();
    }

    assert_eq!(
        lobby.matches.len(),
        2,
        "the same stake on two maps is two tables, and two matches"
    );
    let mut grounds: Vec<&str> = lobby.matches.values().map(|m| m.map.name).collect();
    grounds.sort_unstable();
    assert_eq!(grounds, vec![maps[0], maps[1]]);
    for game in lobby.matches.values() {
        assert_eq!(game.bodies.len(), 2, "nobody was put on the wrong map");
    }
}

#[test]
fn a_match_is_played_on_its_own_ground() {
    let mut lobby = free_play();
    lobby.floor = 2;
    let other = map::MAPS
        .iter()
        .find(|m| m.name != map::TEST_MAP.name)
        .expect("a second map");

    for i in 0..2 {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut lobby, &format!("P{i}"), None, tx);
        queue_map(&mut lobby, outcome.player_id, session, other.name, 1);
    }
    run_matchmaker(&mut lobby);

    let game = lobby.matches.values().next().expect("a match");
    assert_eq!(game.map.name, other.name);
    // Spawned on that map's own points, not on the one a global would have
    // handed out.
    for body in game.bodies.values() {
        let on_this_map = other
            .spawns
            .iter()
            .any(|s| (s.position - body.state.position).length() < 0.01);
        assert!(
            on_this_map,
            "a body started somewhere that is not a spawn of the map it is playing"
        );
    }
}

#[test]
fn a_map_this_build_does_not_have_is_ignored() {
    let mut lobby = free_play();
    let (tx, _rx) = mpsc::channel(64);
    let (outcome, session) = join(&mut lobby, "Optimist", None, tx);

    queue_map(&mut lobby, outcome.player_id, session, "atlantis", 1);
    assert_eq!(
        lobby.connections[&outcome.player_id].at,
        Whereabouts::Idle,
        "a map name the client made up should leave the player where they were"
    );
}

#[test]
fn a_table_this_server_does_not_run_is_ignored() {
    let mut lobby = free_play();
    lobby.tiers = vec![Stakes::from_usd(1).unwrap()];
    let (tx, _rx) = mpsc::channel(64);
    let (outcome, session) = join(&mut lobby, "Optimist", None, tx);

    queue(&mut lobby, outcome.player_id, session, 1000);
    assert_eq!(
        lobby.connections[&outcome.player_id].at,
        Whereabouts::Idle,
        "a stake this server does not offer should leave the player where they were"
    );
}

#[test]
fn everybody_in_a_match_gets_their_own_spawn() {
    let mut lobby = free_play();
    lobby.floor = 2;
    let seats = map::active().max_players;
    for i in 0..seats {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut lobby, &format!("P{i}"), None, tx);
        queue(&mut lobby, outcome.player_id, session, 1);
    }
    run_matchmaker(&mut lobby);

    let game = lobby.matches.values().next().expect("a match");
    let mut seen: Vec<(i32, i32, i32)> = game
        .bodies
        .values()
        .map(|b| {
            (
                (b.state.position.x * 100.0) as i32,
                (b.state.position.y * 100.0) as i32,
                (b.state.position.z * 100.0) as i32,
            )
        })
        .collect();
    seen.sort_unstable();
    let count = seen.len();
    seen.dedup();
    assert_eq!(
        seen.len(),
        count,
        "two players started in the same place, which is two players who cannot miss"
    );
}

#[test]
fn two_matches_on_one_map_do_not_line_everybody_up_identically() {
    let mut lobby = free_play();
    lobby.floor = 2;
    lobby.tiers = vec![Stakes::from_usd(1).unwrap(), Stakes::from_usd(5).unwrap()];
    for (i, dollars) in [1i64, 1, 1, 5, 5, 5].into_iter().enumerate() {
        let (tx, _rx) = mpsc::channel(64);
        let (outcome, session) = join(&mut lobby, &format!("P{i}"), None, tx);
        queue(&mut lobby, outcome.player_id, session, dollars);
    }
    let ticks = ((lobby.wait + 1.0) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        lobby.step();
    }

    let arrangements: Vec<Vec<(i32, i32)>> = lobby
        .matches
        .values()
        .map(|m| {
            let mut points: Vec<(i32, i32)> = m
                .spawns
                .iter()
                .map(|s| ((s.position.x * 100.0) as i32, (s.position.z * 100.0) as i32))
                .collect();
            points.sort_unstable();
            points
        })
        .collect();
    assert_eq!(arrangements.len(), 2);
    assert_ne!(
        arrangements[0], arrangements[1],
        "both matches picked the same corner of the map to start everybody in"
    );
}

// --- Shooting -------------------------------------------------------------
//
// Two players three metres apart on open ground, and a third somewhere else
// on the map doing nothing. Built around a spawn rather than around
// coordinates typed in here: spawns are chosen with clear ground in front of
// them, so "three metres along the way this one faces" is open by
// construction and stays open when the map changes.
//
// The third player is not decoration. One life each and no respawn means a
// match with one player left alive is decided, and the lobby ends it there
// rather than holding the winner on an empty map for the rest of five
// minutes. A two player duel would therefore be over the instant anybody
// died, and every test below that looks at the match afterwards would be
// looking at a match that no longer exists. The bystander keeps it running.

struct Duel {
    lobby: Lobby,
    match_id: MatchId,
    shooter: PlayerId,
    victim: PlayerId,
    /// Alive, elsewhere, and doing nothing. See above.
    bystander: PlayerId,
    shooter_rx: mpsc::Receiver<ServerMsg>,
    victim_rx: mpsc::Receiver<ServerMsg>,
    shooter_session: SessionId,
    victim_session: SessionId,
    seq: u32,
}

impl Duel {
    fn new() -> Self {
        let mut lobby = free_play();
        lobby.floor = 2;
        let (shooter_tx, shooter_rx) = mpsc::channel(512);
        let (victim_tx, victim_rx) = mpsc::channel(512);
        let (bystander_tx, _bystander_rx) = mpsc::channel(512);
        let (shooter_join, shooter_session) = join(&mut lobby, "Shooter", None, shooter_tx);
        let (victim_join, victim_session) = join(&mut lobby, "Victim", None, victim_tx);
        let (bystander_join, bystander_session) = join(&mut lobby, "Bystander", None, bystander_tx);
        let shooter = shooter_join.player_id;
        let victim = victim_join.player_id;
        let bystander = bystander_join.player_id;
        queue(&mut lobby, shooter, shooter_session, 1);
        queue(&mut lobby, victim, victim_session, 1);
        queue(&mut lobby, bystander, bystander_session, 1);
        run_matchmaker(&mut lobby);

        let match_id = *lobby
            .matches
            .iter()
            .find(|(_, m)| m.running())
            .expect("the duel needs a match")
            .0;

        let spawn = map::active().spawn(0);
        let ahead = look_direction(spawn.yaw, 0.0);
        {
            let game = lobby.matches.get_mut(&match_id).unwrap();
            game.bodies.get_mut(&shooter).unwrap().state.position = spawn.position;
            game.bodies.get_mut(&victim).unwrap().state.position = spawn.position + ahead * 3.0;
            // The bystander is left wherever the scatter put them, which is a
            // different spawn point and therefore tens of metres away. Every
            // shot below is at a body three metres off, and a trace takes the
            // nearest player it meets.
        }

        let mut duel = Self {
            lobby,
            match_id,
            shooter,
            victim,
            bystander,
            shooter_rx,
            victim_rx,
            shooter_session,
            victim_session,
            seq: 0,
        };
        // Settle both onto the floor and fill their history, so the lag
        // compensation rewind finds real entries rather than falling back to
        // the live state and testing a path production never takes.
        for _ in 0..40 {
            duel.lobby.step();
        }
        duel
    }

    fn body(&self, id: PlayerId) -> &Body {
        &self.lobby.matches[&self.match_id].bodies[&id]
    }

    fn position(&self, id: PlayerId) -> Vec3 {
        self.body(id).state.position
    }

    fn health(&self, id: PlayerId) -> i16 {
        self.body(id).state.health
    }

    fn stats(&self, id: PlayerId) -> Stats {
        self.body(id).stats
    }

    fn alive(&self, id: PlayerId) -> bool {
        self.lobby.matches[&self.match_id]
            .bodies
            .get(&id)
            .is_some_and(|b| b.state.is_alive())
    }

    /// One tick in which the shooter pulls the trigger at `target`.
    fn fire_at(&mut self, target: Vec3) {
        let from = self.body(self.shooter).state.eye_position();
        let (yaw, pitch) = aim(from, target);
        self.seq += 1;
        self.lobby.handle(GameCommand::Inputs {
            player_id: self.shooter,
            session_id: self.shooter_session,
            commands: vec![InputCommand {
                seq: self.seq,
                forward: 0.0,
                right: 0.0,
                yaw,
                pitch,
                buttons: Buttons(Buttons::FIRE),
            }],
        });
        self.lobby.step();
    }

    /// Let enough time pass for the weapon to be ready again.
    fn reload(&mut self) {
        let ticks = (WEAPON_FIRE_INTERVAL / TICK_DT).ceil() as usize + 1;
        for _ in 0..ticks {
            self.lobby.step();
        }
    }

    /// However many shots to the chest a kill currently takes.
    ///
    /// Derived rather than typed, so rebalancing the weapon does not silently
    /// turn every test below into "shoot them a bit and see".
    fn shots_to_kill() -> u32 {
        MAX_HEALTH.div_euclid(HitRegion::Body.damage()) as u32
            + u32::from(MAX_HEALTH % HitRegion::Body.damage() != 0)
    }

    fn kill_the_victim(&mut self) {
        let centre = self.position(self.victim);
        for _ in 0..Self::shots_to_kill() {
            self.fire_at(centre);
            self.reload();
        }
    }
}

#[test]
fn a_body_shot_takes_body_damage() {
    let mut duel = Duel::new();
    let centre = duel.position(duel.victim);
    duel.fire_at(centre);

    assert_eq!(
        duel.health(duel.victim),
        MAX_HEALTH - HitRegion::Body.damage(),
        "a shot at the chest should do body damage"
    );
    let stats = duel.stats(duel.shooter);
    assert_eq!(stats.shots_hit, 1);
    assert_eq!(stats.headshots, 0);
    assert_eq!(stats.damage_dealt, HitRegion::Body.damage() as u32);
}

#[test]
fn a_headshot_takes_head_damage_and_is_counted() {
    let mut duel = Duel::new();
    let head = duel.position(duel.victim) + Vec3::new(0.0, HEAD_BOTTOM + 0.1, 0.0);
    duel.fire_at(head);

    assert_eq!(
        duel.health(duel.victim),
        MAX_HEALTH - HitRegion::Head.damage(),
        "a shot at the head should do head damage"
    );
    assert_eq!(duel.stats(duel.shooter).headshots, 1);
}

#[test]
fn a_leg_shot_takes_leg_damage() {
    let mut duel = Duel::new();
    let shin = duel.position(duel.victim) + Vec3::new(0.0, LEGS_TOP - 0.25, 0.0);
    duel.fire_at(shin);

    assert_eq!(
        duel.health(duel.victim),
        MAX_HEALTH - HitRegion::Legs.damage(),
        "a shot at the shins should do leg damage"
    );
    assert_eq!(duel.stats(duel.shooter).headshots, 0);
}

#[test]
fn holding_the_trigger_is_not_counted_as_missing() {
    let mut duel = Duel::new();
    let centre = duel.position(duel.victim);
    // Fire on consecutive ticks, far faster than the weapon will take.
    for _ in 0..10 {
        duel.fire_at(centre);
    }
    let stats = duel.stats(duel.shooter);
    assert!(
        stats.shots_fired < 10,
        "the weapon should have refused most of those, not counted them"
    );
    assert_eq!(
        stats.shots_hit, stats.shots_fired,
        "every shot the weapon took was aimed at a body three metres away"
    );
}

#[test]
fn body_shots_kill_and_the_record_says_so() {
    let mut duel = Duel::new();
    duel.kill_the_victim();

    assert!(!duel.alive(duel.victim), "enough body shots should kill");
    assert_eq!(duel.stats(duel.shooter).kills, 1);
    assert_eq!(duel.stats(duel.victim).deaths, 1);
}

#[test]
fn a_corpse_cannot_be_shot_for_a_second_kill() {
    let mut duel = Duel::new();
    duel.kill_the_victim();
    let centre = duel.position(duel.victim);
    duel.reload();
    duel.fire_at(centre);

    assert_eq!(
        duel.stats(duel.shooter).kills,
        1,
        "a body was killed twice, which is a second payout"
    );
}

#[test]
fn only_the_shooter_is_told_how_much_a_hit_took() {
    let mut duel = Duel::new();
    let centre = duel.position(duel.victim);
    duel.fire_at(centre);

    let to_shooter = drain(&mut duel.shooter_rx);
    assert!(
        to_shooter
            .iter()
            .any(|m| matches!(m, ServerMsg::HitConfirmed { .. })),
        "the shooter should be told their shot landed"
    );
    let to_victim = drain(&mut duel.victim_rx);
    assert!(
        !to_victim
            .iter()
            .any(|m| matches!(m, ServerMsg::HitConfirmed { .. })),
        "the victim was told how hurt somebody else is"
    );
    assert!(
        to_victim
            .iter()
            .any(|m| matches!(m, ServerMsg::Damaged { .. })),
        "the victim should be told they were hit"
    );
}

#[test]
fn there_is_no_respawn_however_long_you_wait() {
    let mut duel = Duel::new();
    duel.kill_the_victim();
    assert!(!duel.alive(duel.victim));

    // A player gets one life per match. Waiting does not earn another and
    // neither does asking: the only way back onto a map is a new match.
    for _ in 0..(TICK_HZ as usize * 5) {
        queue(&mut duel.lobby, duel.victim, duel.victim_session, 1);
        duel.lobby.step();
    }
    assert!(
        !duel.alive(duel.victim),
        "a dead player got back into the match they had already been killed in"
    );
}

#[test]
fn a_killed_player_is_back_in_the_lobby_at_once() {
    let mut duel = Duel::new();
    duel.kill_the_victim();

    assert_eq!(
        duel.lobby.connections[&duel.victim].at,
        Whereabouts::Idle,
        "being killed should put a player back in the lobby, not leave them watching"
    );
    let told = drain(&mut duel.victim_rx)
        .into_iter()
        .any(|m| matches!(m, ServerMsg::Eliminated { .. }));
    assert!(told, "the victim should be told their match is over");
}

#[test]
fn a_killed_player_can_be_in_another_match_seconds_later() {
    let mut duel = Duel::new();
    duel.kill_the_victim();
    let first = duel.match_id;

    // Two more players and the eliminated one, and a second match forms
    // around them while the first is still running.
    duel.lobby.floor = 2;
    let (tx, _rx) = mpsc::channel(64);
    let (other, other_session) = join(&mut duel.lobby, "Fresh", None, tx);
    queue(&mut duel.lobby, other.player_id, other_session, 1);
    queue(&mut duel.lobby, duel.victim, duel.victim_session, 1);

    let ticks = ((duel.lobby.wait + 1.0) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        duel.lobby.step();
    }

    let second = duel
        .lobby
        .matches
        .iter()
        .find(|(id, m)| **id != first && m.running())
        .map(|(id, _)| *id);
    assert!(
        second.is_some(),
        "a player killed in one match should not have to wait for it to end"
    );
    assert_eq!(
        duel.lobby.connections[&duel.victim].at,
        Whereabouts::Playing(second.unwrap()),
        "the eliminated player should be in the new match"
    );
    assert!(
        duel.lobby.matches.contains_key(&first),
        "the match they died in should still be running without them"
    );
}

#[test]
fn the_board_is_ordered_by_the_server() {
    let mut duel = Duel::new();
    duel.kill_the_victim();

    let board = duel.lobby.score_entries(duel.match_id);
    assert_eq!(board.len(), 3);
    assert_eq!(board[0].name, "Shooter", "the killer should be on top");
    assert_eq!(board[0].kills, 1);
    let victim = board
        .iter()
        .find(|e| e.name == "Victim")
        .expect("the victim should be on the board");
    assert_eq!(victim.deaths, 1);
    assert!(!victim.alive);
    assert_eq!(
        board.last().unwrap().name,
        "Victim",
        "a death should sort below somebody with neither kills nor deaths"
    );
}

#[test]
fn a_dead_body_is_kept_for_the_board_and_off_the_map() {
    let mut duel = Duel::new();
    duel.kill_the_victim();
    let _ = drain(&mut duel.shooter_rx);
    duel.lobby.broadcast_snapshot(duel.match_id);

    let drawn = drain(&mut duel.shooter_rx)
        .into_iter()
        .rev()
        .find_map(|m| match m {
            ServerMsg::Snapshot { players, .. } => Some(players),
            _ => None,
        })
        .expect("a snapshot");
    assert!(
        !drawn.iter().any(|p| p.id == duel.victim),
        "a corpse was left lying on the map for the rest of the match"
    );
    assert_eq!(
        duel.lobby.score_entries(duel.match_id).len(),
        3,
        "the board should still say who was killed"
    );
}

// --- Coming back ----------------------------------------------------------
//
// A reload must not be a way out of a fight that is going badly, and must not
// cost a player the place they had paid for. Those pull in opposite
// directions, and the body staying in the world is what satisfies both: it is
// still there to be shot while its owner is away, and it is still theirs when
// they get back.

#[test]
fn the_right_token_gets_the_same_player_back() {
    let mut duel = Duel::new();
    let token = duel.lobby.connections[&duel.victim].resume_token;
    let before = duel.position(duel.victim);

    duel.lobby.handle(GameCommand::Leave {
        player_id: duel.victim,
        session_id: duel.victim_session,
    });
    for _ in 0..20 {
        duel.lobby.step();
    }

    let (tx, _rx) = mpsc::channel(64);
    let (outcome, _session) = join(&mut duel.lobby, "Victim", Some(token), tx);
    assert!(outcome.resumed, "a valid token should resume");
    assert_eq!(outcome.player_id, duel.victim, "and resume the same player");
    assert_eq!(
        duel.lobby.connections[&duel.victim].at,
        Whereabouts::Playing(duel.match_id),
        "they should come back to the match they left"
    );
    assert!(
        (duel.position(duel.victim) - before).length() < 2.0,
        "and come back roughly where they were standing"
    );
}

#[test]
fn a_token_nobody_issued_is_simply_ignored() {
    let mut lobby = free_play();
    let (tx, _rx) = mpsc::channel(64);
    let (outcome, _session) = join(&mut lobby, "Stranger", Some(ResumeToken::new()), tx);
    assert!(
        !outcome.resumed,
        "a token the server never issued should join as a new player"
    );
}

#[test]
fn the_connection_that_was_taken_over_can_no_longer_move_the_body() {
    let mut duel = Duel::new();
    let token = duel.lobby.connections[&duel.victim].resume_token;
    let old_session = duel.victim_session;

    let (tx, _rx) = mpsc::channel(64);
    let (outcome, _new_session) = join(&mut duel.lobby, "Victim", Some(token), tx);
    assert!(outcome.resumed);

    // The old socket may not have noticed. It must not be able to steer.
    duel.lobby.handle(GameCommand::Inputs {
        player_id: duel.victim,
        session_id: old_session,
        commands: vec![InputCommand {
            seq: 900,
            forward: 1.0,
            right: 0.0,
            yaw: 0.0,
            pitch: 0.0,
            buttons: Buttons::empty(),
        }],
    });
    assert!(
        duel.body(duel.victim).pending.is_empty(),
        "a superseded connection queued an input for a body it no longer drives"
    );
}

#[test]
fn a_body_is_retired_once_the_window_closes() {
    let mut duel = Duel::new();
    let token = duel.lobby.connections[&duel.victim].resume_token;
    duel.lobby.handle(GameCommand::Leave {
        player_id: duel.victim,
        session_id: duel.victim_session,
    });

    let ticks = ((RESUME_WINDOW / TICK_DT).ceil() as usize) + TICK_HZ as usize + 2;
    for _ in 0..ticks {
        duel.lobby.step();
    }

    assert!(
        !duel.lobby.connections.contains_key(&duel.victim),
        "a player outstayed their resume window"
    );
    // And the token dies with them, rather than resurrecting somebody nobody
    // else can still see.
    let (tx, _rx) = mpsc::channel(64);
    let (outcome, _session) = join(&mut duel.lobby, "Victim", Some(token), tx);
    assert!(!outcome.resumed, "a token outlived the player it named");
}

// ---------------------------------------------------------------------------
// Money
//
// A paid lobby, driven against a ledger that records rather than posts. What
// is being proved here is the lobby's half: that nobody is on a map before
// they have paid, that one entry fee buys one life, that the thing which ends
// that life is settled once and to the right person, and that a player who
// leaves does not take their stake with them.
//
// The rule underneath all of it: **a kill moves the victim's entry fee and
// nothing else.** What the victim had already won is theirs, was posted to
// their wallet as they won it, and is not on the table.
//
// Whether the legs balance in Postgres is a different question, proved in a
// different place - `./x ledger`.
// ---------------------------------------------------------------------------

use crate::ledger::{EntryId, LedgerRequest};

struct Paid {
    lobby: Lobby,
    ledger: mpsc::Receiver<LedgerRequest>,
}

impl Paid {
    fn new() -> Self {
        let (handle, ledger) = crate::ledger::LedgerHandle::recording();
        let mut lobby = Lobby::new();
        lobby.ledger = Some(handle);
        lobby.floor = 2;
        Self { lobby, ledger }
    }

    fn join(&mut self, name: &str) -> (PlayerId, SessionId, mpsc::Receiver<ServerMsg>) {
        let (tx, rx) = mpsc::channel(512);
        let (outcome, session) = join(&mut self.lobby, name, None, tx);
        (outcome.player_id, session, rx)
    }

    /// Every *money* event the lobby has asked the ledger for since this was
    /// last called, in order.
    ///
    /// Reads are dropped. `ReadBalance` moves nothing - it is how a player's
    /// wallet gets a figure in it when they arrive - and every assertion
    /// below is about money moving.
    fn asked(&mut self) -> Vec<LedgerRequest> {
        std::iter::from_fn(|| self.ledger.try_recv().ok())
            .filter(|r| !matches!(r, LedgerRequest::ReadBalance { .. }))
            .collect()
    }

    /// Answer a match's buy-in the way the ledger task would.
    ///
    /// `paid` is everybody whose stake is in escrow; anybody else who was
    /// asked about could not afford it.
    fn fund(&mut self, match_id: MatchId, paid: &[PlayerId], asked: &[PlayerId]) {
        self.lobby.handle(GameCommand::MatchFunded {
            match_id,
            paid: paid.to_vec(),
            balances: asked.iter().map(|id| (*id, 0)).collect(),
        });
    }

    /// The match that is currently forming, if one is.
    fn forming(&self) -> Option<MatchId> {
        self.lobby
            .matches
            .iter()
            .find(|(_, m)| !m.running())
            .map(|(id, _)| *id)
    }

    fn alive(&self, id: PlayerId) -> bool {
        self.lobby
            .matches
            .values()
            .any(|m| m.bodies.get(&id).is_some_and(|b| b.state.is_alive()))
    }

    /// Queue two players and run the matchmaker until a match is forming.
    fn form(&mut self) -> (PlayerId, SessionId, PlayerId, SessionId) {
        let (a, a_session, _) = self.join("A");
        let (b, b_session, _) = self.join("B");
        queue(&mut self.lobby, a, a_session, 1);
        queue(&mut self.lobby, b, b_session, 1);
        let ticks = ((self.lobby.wait + 1.0) / TICK_DT).ceil() as usize;
        for _ in 0..ticks {
            self.lobby.step();
            if !self.lobby.matches.is_empty() {
                break;
            }
        }
        (a, a_session, b, b_session)
    }
}

#[test]
fn queueing_costs_nothing() {
    let mut paid = Paid::new();
    let (player, session, _rx) = paid.join("Browser");
    queue(&mut paid.lobby, player, session, 1);
    for _ in 0..(MATCHMAKE_INTERVAL as usize * 2) {
        paid.lobby.step();
    }

    assert!(
        paid.asked().is_empty(),
        "standing in a line that has not filled should cost nobody anything"
    );
}

#[test]
fn nobody_is_on_the_map_before_they_have_paid() {
    let mut paid = Paid::new();
    let (a, _, b, _) = paid.form();
    let match_id = paid.forming().expect("a forming match");

    // One request for the whole match, not one per player: every purchase is
    // a database round trip, and a match cannot wait for one each.
    let asked = paid.asked();
    assert_eq!(asked.len(), 1, "a match should buy in once");
    match &asked[0] {
        LedgerRequest::BuyMatch { players, .. } => {
            assert_eq!(
                players.len(),
                2,
                "both players should be on the one purchase"
            );
            assert!(players.contains(&a) && players.contains(&b));
        }
        other => panic!("unexpected request {other:?}"),
    }
    assert!(!paid.alive(a) && !paid.alive(b), "nobody pays afterwards");

    paid.fund(match_id, &[a, b], &[a, b]);
    for _ in 0..4 {
        paid.lobby.step();
    }
    assert!(paid.alive(a) && paid.alive(b), "paid stakes should play");
}

#[test]
fn a_purchase_names_the_table_it_is_for() {
    let mut paid = Paid::new();
    paid.lobby.tiers = vec![Stakes::from_usd(5).unwrap()];
    let (a, a_session, _) = paid.join("A");
    let (b, b_session, _) = paid.join("B");
    queue(&mut paid.lobby, a, a_session, 5);
    queue(&mut paid.lobby, b, b_session, 5);
    let ticks = ((paid.lobby.wait + 1.0) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        paid.lobby.step();
        if !paid.lobby.matches.is_empty() {
            break;
        }
    }

    let asked = paid.asked();
    assert!(!asked.is_empty(), "the match should have charged somebody");
    for request in asked {
        match request {
            LedgerRequest::BuyMatch { stakes, .. } => {
                assert_eq!(
                    stakes.entry().to_string(),
                    "$5.00",
                    "a five dollar table charged something else"
                );
            }
            other => panic!("unexpected request {other:?}"),
        }
    }
}

#[test]
fn a_player_who_cannot_afford_it_goes_back_to_the_lobby() {
    let mut paid = Paid::new();
    let (a, _, b, _) = paid.form();
    let match_id = paid.forming().expect("a forming match");
    let _ = paid.asked();

    // One of the two is short. The other should not be stopped from playing
    // by somebody else's empty wallet - but with a floor of two there is
    // nobody left to play against, so this particular match dissolves.
    paid.fund(match_id, &[b], &[a, b]);
    assert!(!paid.alive(a));
    assert_eq!(
        paid.lobby.connections[&a].at,
        Whereabouts::Idle,
        "a player who could not pay should be back in the lobby, not stuck in a match"
    );
    for _ in 0..4 {
        paid.lobby.step();
    }
    let refunded = paid.asked();
    assert!(
        refunded
            .iter()
            .any(|r| matches!(r, LedgerRequest::RefundEntry { entry } if entry.player_id == b)),
        "a match that could not fill should hand back what it took"
    );
}

#[test]
fn a_dissolved_match_returns_the_whole_stake() {
    let mut paid = Paid::new();
    let (a, _, b, _) = paid.form();
    let match_id = paid.forming().expect("a forming match");
    let _ = paid.asked();
    paid.fund(match_id, &[a], &[a, b]);
    for _ in 0..4 {
        paid.lobby.step();
    }

    let asked = paid.asked();
    assert_eq!(
        asked,
        vec![LedgerRequest::RefundEntry {
            entry: EntryId {
                match_id,
                player_id: a,
            }
        }],
        "nobody was shot at, so the stake goes back whole rather than less the rake"
    );
    assert!(
        paid.lobby.matches.is_empty(),
        "a match nobody could fill should not be left running"
    );
}

#[test]
fn money_that_lands_after_the_door_closed_goes_straight_back() {
    let mut paid = Paid::new();
    let (a, _, b, _) = paid.form();
    let match_id = paid.forming().expect("a forming match");
    let _ = paid.asked();

    // The match gives up waiting and starts without them, which is what
    // `FORMING_TIMEOUT` is for. With nobody paid it dissolves instead - so
    // put one body in first, the way a partial answer would.
    paid.fund(match_id, &[a], &[a]);
    let ticks = ((FORMING_TIMEOUT + 1.0) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        paid.lobby.step();
    }
    let _ = paid.asked();

    // And now b's money arrives, for a match that has already started or is
    // already gone. It must not sit in escrow with nobody standing on it.
    paid.fund(match_id, &[b], &[b]);
    let asked = paid.asked();
    assert!(
        asked.iter().any(|r| matches!(
            r,
            LedgerRequest::RefundEntry { entry } if entry.player_id == b
        )),
        "a stake paid too late was left sitting in escrow: {asked:?}"
    );
}

#[test]
fn a_broke_player_does_not_stop_the_rest_playing() {
    let mut paid = Paid::new();
    paid.lobby.floor = 2;
    let (a, a_session, _) = paid.join("A");
    let (b, b_session, _) = paid.join("B");
    let (c, c_session, _) = paid.join("Skint");
    for (id, session) in [(a, a_session), (b, b_session), (c, c_session)] {
        queue(&mut paid.lobby, id, session, 1);
    }
    let ticks = ((paid.lobby.wait + 1.0) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        paid.lobby.step();
        if !paid.lobby.matches.is_empty() {
            break;
        }
    }
    let match_id = paid.forming().expect("a forming match");
    let _ = paid.asked();

    paid.fund(match_id, &[a, b], &[a, b, c]);
    for _ in 0..4 {
        paid.lobby.step();
    }

    assert!(
        paid.alive(a) && paid.alive(b),
        "two players who paid should be playing"
    );
    assert!(!paid.alive(c), "the one who could not pay should not be");
    assert!(
        paid.asked().is_empty(),
        "nothing should have been handed back: the match went ahead"
    );
}

/// Attach a ledger to a duel already in progress, and give both players the
/// paid entry they would have bought had one been attached when they joined.
fn charge(duel: &mut Duel) -> mpsc::Receiver<LedgerRequest> {
    let (handle, ledger) = crate::ledger::LedgerHandle::recording();
    duel.lobby.ledger = Some(handle);
    for id in [duel.shooter, duel.victim, duel.bystander] {
        duel.lobby
            .matches
            .get_mut(&duel.match_id)
            .unwrap()
            .bodies
            .get_mut(&id)
            .unwrap()
            .staked = true;
    }
    ledger
}

fn asked_of(ledger: &mut mpsc::Receiver<LedgerRequest>) -> Vec<LedgerRequest> {
    std::iter::from_fn(|| ledger.try_recv().ok())
        .filter(|r| !matches!(r, LedgerRequest::ReadBalance { .. }))
        .collect()
}

#[test]
fn a_kill_settles_the_entry_that_ended_to_the_player_who_ended_it() {
    let mut duel = Duel::new();
    let mut ledger = charge(&mut duel);

    duel.kill_the_victim();

    assert_eq!(
        asked_of(&mut ledger),
        vec![LedgerRequest::SettleKill {
            entry: EntryId {
                match_id: duel.match_id,
                player_id: duel.victim,
            },
            killer: duel.shooter,
        }],
        "a kill should settle the stake that ended, exactly once, to the shooter"
    );
}

#[test]
fn a_kill_pays_a_fixed_reward_and_takes_nothing_from_the_victim() {
    let mut duel = Duel::new();
    let _ledger = charge(&mut duel);
    let reward = duel.lobby.matches[&duel.match_id].stakes.reward().micros();

    // The victim is not a beginner: they have already won some of their own.
    // A kill must not reach into that.
    let earned = reward * 4;
    duel.lobby
        .matches
        .get_mut(&duel.match_id)
        .unwrap()
        .bodies
        .get_mut(&duel.victim)
        .unwrap()
        .winnings_micro_usd = earned;

    duel.kill_the_victim();

    assert_eq!(
        duel.body(duel.victim).winnings_micro_usd,
        earned,
        "being killed took money off the victim"
    );
    assert_eq!(
        duel.body(duel.shooter).winnings_micro_usd,
        reward,
        "a kill should be worth exactly one reward, whatever the victim was carrying"
    );
}

#[test]
fn winnings_are_the_reward_times_the_kills_and_nothing_else() {
    let mut duel = Duel::new();
    let _ledger = charge(&mut duel);
    let reward = duel.lobby.matches[&duel.match_id].stakes.reward().micros();

    // Three kills in a row on the same body, resurrected between them, which
    // is not a thing the game does but is the cheapest way to count rewards.
    //
    // The wait after each resurrection is not padding. Shots are resolved
    // against where the shooter could *see* the target, which means against
    // the rewound history - and the history of a body that has just been dead
    // is full of dead states, which are not shootable. Refilling it is what
    // makes the next kill land, and needing to is the lag compensation
    // working rather than a fault in it.
    for n in 1..=3i64 {
        {
            let body = duel
                .lobby
                .matches
                .get_mut(&duel.match_id)
                .unwrap()
                .bodies
                .get_mut(&duel.victim)
                .unwrap();
            body.state.health = MAX_HEALTH;
            body.staked = true;
        }
        duel.lobby.connections.get_mut(&duel.victim).unwrap().at =
            Whereabouts::Playing(duel.match_id);
        for _ in 0..40 {
            duel.lobby.step();
        }
        duel.kill_the_victim();
        assert_eq!(
            duel.body(duel.shooter).winnings_micro_usd,
            reward * n,
            "after {n} kills the winnings should be {n} rewards"
        );
    }
}

#[test]
fn falling_out_of_the_world_settles_the_stake() {
    let mut duel = Duel::new();
    let mut ledger = charge(&mut duel);

    // Below the floor of the world, where there is nobody to credit.
    duel.lobby
        .matches
        .get_mut(&duel.match_id)
        .unwrap()
        .bodies
        .get_mut(&duel.victim)
        .unwrap()
        .state
        .position
        .y = -60.0;
    duel.lobby.step();

    assert_eq!(
        asked_of(&mut ledger),
        vec![LedgerRequest::AbandonEntry {
            entry: EntryId {
                match_id: duel.match_id,
                player_id: duel.victim,
            }
        }],
        "a fall should settle the stake rather than leave it in escrow"
    );
}

#[test]
fn a_player_who_never_comes_back_pays_the_rake_and_keeps_the_rest() {
    let mut duel = Duel::new();
    let mut ledger = charge(&mut duel);

    duel.lobby.handle(GameCommand::Leave {
        player_id: duel.victim,
        session_id: duel.victim_session,
    });
    let ticks = ((RESUME_WINDOW / TICK_DT).ceil() as usize) + TICK_HZ as usize + 2;
    for _ in 0..ticks {
        duel.lobby.step();
    }

    assert!(
        asked_of(&mut ledger).contains(&LedgerRequest::AbandonEntry {
            entry: EntryId {
                match_id: duel.match_id,
                player_id: duel.victim,
            }
        }),
        "pulling the cable left a stake sitting in escrow"
    );
}

#[test]
fn surviving_to_the_whistle_gets_the_stake_back() {
    let mut duel = Duel::new();
    let mut ledger = charge(&mut duel);

    // Nobody killed either of them, so nobody won either stake.
    duel.lobby.end_match(duel.match_id);

    let asked = asked_of(&mut ledger);
    assert_eq!(asked.len(), 3, "every survivor should have been refunded");
    for id in [duel.shooter, duel.victim, duel.bystander] {
        assert!(
            asked.contains(&LedgerRequest::RefundEntry {
                entry: EntryId {
                    match_id: duel.match_id,
                    player_id: id,
                }
            }),
            "a player who survived the match did not get their stake back"
        );
    }
}

#[test]
fn a_player_killed_before_the_whistle_is_not_also_refunded() {
    let mut duel = Duel::new();
    let mut ledger = charge(&mut duel);
    duel.kill_the_victim();
    let _ = asked_of(&mut ledger);

    duel.lobby.end_match(duel.match_id);

    let asked = asked_of(&mut ledger);
    assert!(
        !asked.iter().any(|r| matches!(
            r,
            LedgerRequest::RefundEntry { entry } if entry.player_id == duel.victim
        )),
        "a stake somebody else had already won was refunded as well"
    );
    assert!(
        asked.contains(&LedgerRequest::RefundEntry {
            entry: EntryId {
                match_id: duel.match_id,
                player_id: duel.shooter,
            }
        }),
        "the survivor should still get theirs back"
    );
}

#[test]
fn a_stake_leaves_escrow_exactly_once() {
    let mut duel = Duel::new();
    let mut ledger = charge(&mut duel);
    duel.kill_the_victim();
    assert_eq!(asked_of(&mut ledger).len(), 1);

    // Everything that could settle it again: the whistle, and the resume
    // window closing on a body that is already dead.
    duel.lobby.handle(GameCommand::Leave {
        player_id: duel.victim,
        session_id: duel.victim_session,
    });
    let ticks = ((RESUME_WINDOW / TICK_DT).ceil() as usize) + TICK_HZ as usize + 2;
    for _ in 0..ticks {
        duel.lobby.step();
    }
    duel.lobby.end_match(duel.match_id);

    let again = asked_of(&mut ledger);
    assert!(
        !again.iter().any(|r| matches!(
            r,
            LedgerRequest::SettleKill { entry, .. }
                | LedgerRequest::AbandonEntry { entry }
                | LedgerRequest::RefundEntry { entry }
                if entry.player_id == duel.victim
        )),
        "a stake that had already been won was settled a second time: {again:?}"
    );
}

#[test]
fn the_pot_is_what_is_still_staked_on_this_match() {
    let mut duel = Duel::new();
    let _ledger = charge(&mut duel);
    let entry = duel.lobby.matches[&duel.match_id].stakes.entry().micros();

    assert_eq!(
        duel.lobby.matches[&duel.match_id].pot_micro_usd(),
        entry * 3,
        "three stakes on the table is three entry fees"
    );

    duel.kill_the_victim();
    assert_eq!(
        duel.lobby.matches[&duel.match_id].pot_micro_usd(),
        entry * 2,
        "a kill takes one stake off the table, so the pot falls by one entry fee"
    );
}

#[test]
fn one_match_cannot_see_another() {
    let mut duel = Duel::new();
    duel.lobby.floor = 2;
    let (tx, mut rx) = mpsc::channel(512);
    let (other, other_session) = join(&mut duel.lobby, "Elsewhere", None, tx);
    let (tx2, _rx2) = mpsc::channel(512);
    let (other2, other2_session) = join(&mut duel.lobby, "Elsewhere2", None, tx2);
    queue(&mut duel.lobby, other.player_id, other_session, 1);
    queue(&mut duel.lobby, other2.player_id, other2_session, 1);
    let ticks = ((duel.lobby.wait + 1.0) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        duel.lobby.step();
    }
    assert_eq!(duel.lobby.matches.len(), 2, "there should be two matches");
    let _ = drain(&mut rx);

    duel.kill_the_victim();

    let seen = drain(&mut rx);
    assert!(
        !seen.iter().any(|m| matches!(m, ServerMsg::Killed { .. })),
        "a player in one match was told about a kill in another"
    );
    for msg in &seen {
        if let ServerMsg::Snapshot { match_id, .. } = msg {
            assert_ne!(
                *match_id, duel.match_id,
                "a player was sent a snapshot of a match they are not in"
            );
        }
    }
}

// ---- accounts ---------------------------------------------------------------

/// Join as a named account, the way the connection layer does once it has
/// signed somebody in.
fn join_as(
    lobby: &mut Lobby,
    account: PlayerId,
    resume: Option<ResumeToken>,
    outbound: mpsc::Sender<ServerMsg>,
) -> (JoinOutcome, SessionId) {
    let session_id = SessionId::new();
    let (reply_tx, reply_rx) = oneshot::channel();
    lobby.handle(GameCommand::Join {
        session_id,
        account: Some(account),
        name: "Account".into(),
        resume,
        outbound,
        reply: reply_tx,
    });
    let outcome = reply_rx
        .blocking_recv()
        .expect("the lobby should always answer a join");
    (outcome, session_id)
}

#[test]
fn an_account_is_the_same_player_every_time_it_signs_in() {
    // The reason accounts exist: a balance hangs off the player id, and a
    // player id that changed with every tab would lose a deposit the first
    // time somebody closed one.
    let mut lobby = free_play();
    let account = PlayerId::new();
    let (tx, _rx) = mpsc::channel(64);
    let (first, _) = join_as(&mut lobby, account, None, tx);
    assert_eq!(first.player_id, account);
    assert!(!first.resumed, "nobody was here to take back");

    // Gone for good - past the resume window - and back days later.
    lobby.connections.remove(&account);
    let (tx, _rx) = mpsc::channel(64);
    let (again, _) = join_as(&mut lobby, account, None, tx);
    assert_eq!(
        again.player_id, account,
        "signing in again is being them again"
    );
}

#[test]
fn a_second_tab_takes_the_player_over_and_the_first_is_told_why() {
    let mut lobby = free_play();
    let account = PlayerId::new();
    let (tx, mut first_rx) = mpsc::channel(64);
    let (_, first_session) = join_as(&mut lobby, account, None, tx);
    let _ = drain(&mut first_rx);

    let (tx, _rx) = mpsc::channel(64);
    let (second, second_session) = join_as(&mut lobby, account, None, tx);
    assert!(second.resumed, "one player, not two");
    assert_eq!(second.player_id, account);
    assert_eq!(lobby.connections.len(), 1);
    assert_eq!(lobby.connections[&account].session_id, second_session);

    // The displaced tab is told in words the client recognises, because a
    // client that simply reconnected would take the player straight back.
    let told = drain(&mut first_rx);
    assert!(
        told.iter()
            .any(|m| matches!(m, ServerMsg::Rejected { reason } if reason == TAKEN_OVER)),
        "the displaced connection was not told it had been taken over: {told:?}"
    );

    // And it no longer speaks for the player.
    queue_map(&mut lobby, account, first_session, map::ARENA.name, 1);
    assert!(
        matches!(lobby.connections[&account].at, Whereabouts::Idle),
        "a superseded connection queued the player"
    );
}

#[test]
fn a_resume_token_cannot_be_used_to_become_somebody_else() {
    let mut lobby = free_play();
    let victim = PlayerId::new();
    let (tx, _rx) = mpsc::channel(64);
    let (victims, _) = join_as(&mut lobby, victim, None, tx);

    // Somebody signed in as themselves, presenting the victim's token.
    let thief = PlayerId::new();
    let (tx, _rx) = mpsc::channel(64);
    let (outcome, _) = join_as(&mut lobby, thief, Some(victims.resume_token), tx);
    assert_eq!(
        outcome.player_id, thief,
        "the token was honoured for the wrong account"
    );
    assert!(!outcome.resumed);
    assert_eq!(lobby.connections.len(), 2);
}

#[test]
fn coming_back_asks_the_ledger_for_the_wallet_again() {
    // A reload used to leave the menu showing a dash: the new socket had been
    // told nothing, and the balance was only ever sent when it changed.
    let (handle, mut ledger) = crate::ledger::LedgerHandle::recording();
    let mut lobby = free_play();
    lobby.ledger = Some(handle);
    let account = PlayerId::new();
    let (tx, _rx) = mpsc::channel(64);
    join_as(&mut lobby, account, None, tx);
    let (tx, _rx) = mpsc::channel(64);
    join_as(&mut lobby, account, None, tx);

    let reads = std::iter::from_fn(|| ledger.try_recv().ok())
        .filter(|r| matches!(r, LedgerRequest::ReadBalance { player_id } if *player_id == account))
        .count();
    assert_eq!(reads, 2, "arriving and coming back should each ask");
}

// ---- withdrawals ------------------------------------------------------------

fn wallet_terms() -> crate::wallet::Terms {
    crate::wallet::Terms {
        treasury: crate::solana::Treasury::from_seed([1u8; 32]).address,
        rate: crate::wallet::SolUsd::parse("140").unwrap(),
        withdrawals_open: true,
    }
}

fn somebody_elses_wallet() -> String {
    crate::solana::Treasury::from_seed([2u8; 32])
        .address
        .to_string()
}

fn withdraw(paid: &mut Paid, player: PlayerId, session: SessionId, micros: i64) {
    paid.lobby.handle(GameCommand::Withdraw {
        player_id: player,
        session_id: session,
        amount_micro_usd: micros,
        destination: somebody_elses_wallet(),
    });
}

fn refusals(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<String> {
    drain(rx)
        .into_iter()
        .filter_map(|m| match m {
            ServerMsg::WithdrawalRefused { reason } => Some(reason),
            _ => None,
        })
        .collect()
}

#[test]
fn a_withdrawal_goes_to_the_ledger_quoted_at_the_configured_rate() {
    let mut paid = Paid::new();
    paid.lobby.wallet = Some(wallet_terms());
    let (player, session, mut rx) = paid.join("Cashing out");
    let _ = paid.asked();

    withdraw(&mut paid, player, session, 5_000_000);

    let asked = paid.asked();
    let [
        LedgerRequest::Withdraw {
            player_id, quote, ..
        },
    ] = asked.as_slice()
    else {
        panic!("expected exactly one withdrawal, got {asked:?}");
    };
    assert_eq!(*player_id, player);
    assert_eq!(quote.amount.micros(), 5_000_000);
    assert_eq!(quote.lamports, 35_714_285, "$5 at $140 a SOL, rounded down");
    assert!(refusals(&mut rx).is_empty());
}

#[test]
fn a_bad_withdrawal_never_reaches_the_ledger() {
    let mut paid = Paid::new();
    paid.lobby.wallet = Some(wallet_terms());
    let (player, session, mut rx) = paid.join("Chancer");
    let _ = paid.asked();

    // Under the minimum.
    withdraw(&mut paid, player, session, 1_000_000);
    // Nowhere in particular. Past the cooldown, so the address is what is
    // being refused rather than the timing.
    let ticks = ((WITHDRAW_COOLDOWN + 0.1) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        paid.lobby.step();
    }
    paid.lobby.handle(GameCommand::Withdraw {
        player_id: player,
        session_id: session,
        amount_micro_usd: 5_000_000,
        destination: "my wallet please".into(),
    });

    assert!(
        paid.asked().is_empty(),
        "the ledger was asked about a bad withdrawal"
    );
    assert_eq!(refusals(&mut rx).len(), 2, "each refusal should say why");
}

#[test]
fn a_server_with_no_wallet_says_so() {
    let mut paid = Paid::new();
    let (player, session, mut rx) = paid.join("Hopeful");
    let _ = paid.asked();
    withdraw(&mut paid, player, session, 5_000_000);
    assert!(paid.asked().is_empty());
    assert_eq!(refusals(&mut rx).len(), 1);
}

#[test]
fn withdrawals_are_off_while_development_money_is_handed_out() {
    let mut paid = Paid::new();
    let mut terms = wallet_terms();
    terms.withdrawals_open = false;
    paid.lobby.wallet = Some(terms);
    let (player, session, mut rx) = paid.join("Granted");
    let _ = paid.asked();
    withdraw(&mut paid, player, session, 5_000_000);
    assert!(paid.asked().is_empty(), "grant money left as SOL");
    assert_eq!(refusals(&mut rx).len(), 1);
}

#[test]
fn a_withdrawal_from_a_superseded_connection_is_ignored() {
    let mut paid = Paid::new();
    paid.lobby.wallet = Some(wallet_terms());
    let (player, _session, _rx) = paid.join("Moved on");
    let _ = paid.asked();
    withdraw(&mut paid, player, SessionId::new(), 5_000_000);
    assert!(paid.asked().is_empty());
}

#[test]
fn withdrawals_cannot_be_fired_off_as_fast_as_a_client_can_send() {
    let mut paid = Paid::new();
    paid.lobby.wallet = Some(wallet_terms());
    let (player, session, mut rx) = paid.join("Impatient");
    let _ = paid.asked();

    withdraw(&mut paid, player, session, 5_000_000);
    withdraw(&mut paid, player, session, 5_000_000);
    assert_eq!(paid.asked().len(), 1, "the second should wait");
    assert_eq!(refusals(&mut rx).len(), 1);

    let ticks = ((WITHDRAW_COOLDOWN + 0.1) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        paid.lobby.step();
    }
    withdraw(&mut paid, player, session, 5_000_000);
    assert_eq!(paid.asked().len(), 1, "and then be taken");
}

#[test]
fn coming_back_mid_match_is_being_told_which_match_and_which_map() {
    // A reloaded page knows nothing. Being in the match on the server is not
    // enough: the new page has to be told which match it is in and on which
    // ground, or it throws away every snapshot as a straggler and sits on the
    // menu while its body stands in the match being shot at. That is what a
    // reload did once the menu came first, until this was sent again.
    let mut duel = Duel::new();
    let token = duel.lobby.connections[&duel.victim].resume_token;
    duel.lobby.handle(GameCommand::Leave {
        player_id: duel.victim,
        session_id: duel.victim_session,
    });
    duel.lobby.step();

    let (tx, mut rx) = mpsc::channel(64);
    let (outcome, _) = join(&mut duel.lobby, "Victim", Some(token), tx);
    assert!(outcome.resumed);
    let told = drain(&mut rx);
    let map = duel.lobby.matches[&duel.match_id].map.name;
    assert!(
        told.iter().any(|m| matches!(
            m,
            ServerMsg::MatchStarted { match_id, map_name, .. }
                if *match_id == duel.match_id && map_name == map
        )),
        "a player back in a running match was not told which one: {told:?}"
    );
}

#[test]
fn coming_back_to_the_lobby_is_not_being_told_about_a_match() {
    let mut lobby = free_play();
    let account = PlayerId::new();
    let (tx, _rx) = mpsc::channel(64);
    join_as(&mut lobby, account, None, tx);
    let (tx, mut rx) = mpsc::channel(64);
    join_as(&mut lobby, account, None, tx);
    assert!(
        !drain(&mut rx)
            .iter()
            .any(|m| matches!(m, ServerMsg::MatchStarted { .. })),
        "somebody in the lobby was told they were in a match"
    );
}
