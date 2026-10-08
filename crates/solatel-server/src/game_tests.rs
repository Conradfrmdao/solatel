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
use solatel_protocol::sim::{
    Buttons, GRENADE_FUSE, GRENADES_PER_LIFE, HEAD_BOTTOM, LEGS_TOP, MAX_HEALTH, REGEN_DELAY,
    REGEN_SECONDS, look_direction,
    PLAYER_HALF_EXTENTS,
    weapon::{Loadout, Optic, Round, Slot, Weapon},
};

/// What the rifle - every test's gun unless it says otherwise - does to a
/// region at the three metres the duel is fought over.
fn rifle(region: HitRegion) -> i16 {
    Weapon::Rifle.damage(region, 3.0)
}

/// The rifle's magazine, and the seconds a reload of it takes.
fn rifle_magazine() -> u32 {
    Weapon::Rifle.stats().magazine
}

fn rifle_reload_seconds() -> f32 {
    Weapon::Rifle.stats().reload_ticks as f32 * TICK_DT
}

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
    // Live the moment it starts. The warm-up and the wait for maps to load
    // have tests of their own; every other test is about what happens once a
    // match is being played.
    lobby.warmup = 0.0;
    lobby.load_wait = 0.0;
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
        loadout: Loadout::default(),
    });
}

/// Put a player in line and run the matchmaker until something happens.
fn queue(lobby: &mut Lobby, player: PlayerId, session: SessionId, dollars: i64) {
    queue_armed(lobby, player, session, dollars, Loadout::default());
}

/// Put a player in line carrying `loadout`.
fn queue_armed(
    lobby: &mut Lobby,
    player: PlayerId,
    session: SessionId,
    dollars: i64,
    loadout: Loadout,
) {
    lobby.handle(GameCommand::Queue {
        player_id: player,
        session_id: session,
        // The tests play the arena unless they say otherwise: two of them
        // assert things about its staircases specifically, and the rest only
        // need somewhere with clear ground.
        map: map::TEST_MAP.name.to_string(),
        tier_dollars: dollars,
        loadout,
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
        Self::armed(Loadout::default())
    }

    /// A duel whose shooter carries `loadout`; everybody else the rifle.
    fn armed(loadout: Loadout) -> Self {
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
        queue_armed(&mut lobby, shooter, shooter_session, 1, loadout);
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

    /// Let enough time pass for the gun in hand to be ready again.
    fn reload(&mut self) {
        let ticks = self.body(self.shooter).arms.weapon().stats().fire_ticks as usize + 1;
        for _ in 0..ticks {
            self.lobby.step();
        }
    }

    /// However many shots to the chest a kill currently takes.
    ///
    /// Derived rather than typed, so rebalancing the weapon does not silently
    /// turn every test below into "shoot them a bit and see".
    fn shots_to_kill() -> u32 {
        MAX_HEALTH.div_euclid(rifle(HitRegion::Body)) as u32
            + u32::from(MAX_HEALTH % rifle(HitRegion::Body) != 0)
    }

    fn kill_the_victim(&mut self) {
        let centre = self.position(self.victim);
        for _ in 0..Self::shots_to_kill() {
            self.fire_at(centre);
            self.reload();
        }
    }

    /// Ticks in which the shooter looks at `target` without firing.
    fn look_at(&mut self, target: Vec3, ticks: usize) {
        for _ in 0..ticks {
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
                    buttons: Buttons(0),
                }],
            });
            self.lobby.step();
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
        MAX_HEALTH - rifle(HitRegion::Body),
        "a shot at the chest should do body damage"
    );
    let stats = duel.stats(duel.shooter);
    assert_eq!(stats.shots_hit, 1);
    assert_eq!(stats.headshots, 0);
    assert_eq!(stats.damage_dealt, rifle(HitRegion::Body) as u32);
}

#[test]
fn a_headshot_takes_head_damage_and_is_counted() {
    let mut duel = Duel::new();
    let head = duel.position(duel.victim) + Vec3::new(0.0, HEAD_BOTTOM + 0.1, 0.0);
    duel.fire_at(head);

    assert_eq!(
        duel.health(duel.victim),
        MAX_HEALTH - rifle(HitRegion::Head),
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
        MAX_HEALTH - rifle(HitRegion::Legs),
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
        lobby.warmup = 0.0;
        lobby.load_wait = 0.0;
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
        usdc_mint: crate::solana::Address::parse(crate::solana::USDC_DEVNET).unwrap(),
        usdc_account: crate::solana::Treasury::from_seed([3u8; 32]).address,
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

// ---- match history and the anti-cheat ------------------------------------

fn record(duel: &mut Duel) -> mpsc::Receiver<crate::records::Life> {
    let (handle, lives) = crate::records::RecordsHandle::recording();
    duel.lobby.records = Some(handle);
    lives
}

fn lives_of(lives: &mut mpsc::Receiver<crate::records::Life>) -> Vec<crate::records::Life> {
    std::iter::from_fn(|| lives.try_recv().ok()).collect()
}

#[test]
fn a_kill_writes_the_victims_life_into_history() {
    use crate::records::Outcome;
    let mut duel = Duel::new();
    let _ledger = charge(&mut duel);
    let mut lives = record(&mut duel);

    duel.kill_the_victim();

    let written = lives_of(&mut lives);
    assert_eq!(written.len(), 1, "one life ended, so one should be written");
    let life = &written[0];
    assert_eq!(life.player_id, duel.victim);
    assert_eq!(life.match_id, duel.match_id);
    assert_eq!(
        life.outcome,
        Outcome::Killed {
            killer: duel.shooter
        }
    );
    assert_eq!(
        life.stake,
        duel.lobby.matches[&duel.match_id].stakes.entry()
    );
    assert!(life.alive_ms > 0, "the victim was alive for a while");
}

#[test]
fn a_survivor_is_written_with_what_they_did() {
    use crate::records::Outcome;
    let mut duel = Duel::new();
    let _ledger = charge(&mut duel);
    let mut lives = record(&mut duel);
    duel.kill_the_victim();
    let _ = lives_of(&mut lives);
    let reward = duel.lobby.matches[&duel.match_id].stakes.reward();

    duel.lobby.end_match(duel.match_id);

    let written = lives_of(&mut lives);
    let shooter = written
        .iter()
        .find(|l| l.player_id == duel.shooter)
        .expect("the shooter survived and should be written");
    assert_eq!(shooter.outcome, Outcome::Survived);
    assert_eq!(shooter.counts.kills, 1);
    assert_eq!(
        shooter.counts.shots_fired,
        Duel::shots_to_kill(),
        "every shot the weapon took is counted, and only those"
    );
    assert_eq!(shooter.counts.shots_hit, shooter.counts.shots_fired);
    assert_eq!(
        shooter.winnings, reward,
        "the history says what the kill paid"
    );
    assert!(
        !written.iter().any(|l| l.player_id == duel.victim),
        "a life is written once, when it ends, and the victim's already had"
    );
}

#[test]
fn a_finished_match_is_recorded_for_review() {
    let mut duel = Duel::new();
    let (handle, _lives, mut replays) = crate::records::RecordsHandle::recording_replays();
    duel.lobby.records = Some(handle);
    duel.kill_the_victim();
    duel.lobby.end_match(duel.match_id);

    let recording = replays
        .try_recv()
        .expect("a match that ended should hand over its recording")
        .finish();
    let names: Vec<&str> = recording["players"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    let index = |name: &str| names.iter().position(|n| *n == name).unwrap() as i64;
    // Sampled through the match, every shot that was taken, and the kill.
    assert!(recording["frames"].as_array().unwrap().len() > 3);
    assert_eq!(
        recording["shots"].as_array().unwrap().len() as u32,
        Duel::shots_to_kill(),
        "every shot the match was told about"
    );
    let kill = &recording["kills"][0];
    assert_eq!(kill[1].as_i64(), Some(index("Shooter")));
    assert_eq!(kill[2].as_i64(), Some(index("Victim")));
    assert!(replays.try_recv().is_err(), "one recording per match");
}

#[test]
fn nothing_is_written_in_free_play() {
    let mut duel = Duel::new();
    duel.kill_the_victim();
    duel.lobby.end_match(duel.match_id);
    // No records handle attached: a free-play lobby has no payout to guard
    // and no history to keep. The point is that nothing panics without one.
    assert!(duel.lobby.records.is_none());
}

#[test]
fn a_hit_at_the_end_of_a_flick_is_counted_as_one() {
    let mut duel = Duel::new();
    let target = duel.position(duel.victim);
    let from = duel.body(duel.shooter).state.eye_position();
    // Looking well away - ninety degrees off - for longer than the window,
    // then onto the target and firing in the same tick.
    let away = from + (target - from).cross(Vec3::Y).normalize() * 5.0;
    duel.look_at(away, 20);
    duel.fire_at(target);

    let stats = duel.stats(duel.shooter);
    assert_eq!(stats.shots_hit, 1, "the flick should still have landed");
    assert_eq!(stats.snap_hits, 1, "and it should be counted as a flick");
}

#[test]
fn a_hit_after_tracking_the_target_is_not_a_flick() {
    let mut duel = Duel::new();
    let target = duel.position(duel.victim);
    duel.look_at(target, 20);
    duel.fire_at(target);

    let stats = duel.stats(duel.shooter);
    assert_eq!(stats.shots_hit, 1);
    assert_eq!(
        stats.snap_hits, 0,
        "aim held on the target is tracking, not a flick"
    );
}

// ---- reaction times ----------------------------------------------------------
//
// The victim's live body stays where the duel put it, in plain view. What
// changes is its history: rewritten so that, as the shooter was seeing it, it
// stood behind a wall until a chosen number of ticks before the shot. That is
// exactly what the measurement reads, and it keeps the test off whatever
// stepping out from cover would do to a body's position on any given map.

impl Duel {
    /// Somewhere behind a wall from where the shooter stands.
    fn hiding_place(&self) -> Vec3 {
        let shooter = self.body(self.shooter).state;
        let eye = shooter.eye_position();
        let map = self.lobby.matches[&self.match_id].map;
        (0..64)
            .filter_map(|i| {
                let direction = look_direction(i as f32 * std::f32::consts::TAU / 64.0, 0.0);
                let wall = hitscan::trace_world(eye, direction, 60.0, map)?;
                let mut behind = shooter;
                behind.position = eye + direction * (wall + 1.0);
                behind.position.y = shooter.position.y;
                (!in_sight(eye, &behind, map)).then_some(behind.position)
            })
            .next()
            .expect("somewhere on this map is out of sight of this spawn")
    }

    /// Rewrites the victim's history so that, to the shooter, it came out
    /// from behind a wall `ticks` before the next shot.
    fn sighted(&mut self, ticks: u32) {
        let hidden = self.hiding_place();
        let rewind = (INTERPOLATION_DELAY_MS / (TICK_DT * 1000.0)).round() as u32;
        // The shot is resolved on the tick the next step runs.
        let shot_at = self.lobby.tick + 1;
        let victim = self.victim;
        let body = self
            .lobby
            .matches
            .get_mut(&self.match_id)
            .unwrap()
            .bodies
            .get_mut(&victim)
            .unwrap();
        for (tick, state) in body.history.iter_mut() {
            if *tick + rewind + ticks < shot_at {
                state.position = hidden;
            }
        }
    }
}

#[test]
fn a_hit_the_moment_a_target_appears_is_quicker_than_a_person() {
    let mut duel = Duel::new();
    let target = duel.position(duel.victim);
    duel.look_at(target, 20);
    duel.sighted(2);
    duel.fire_at(target);

    let stats = duel.stats(duel.shooter);
    assert_eq!(stats.shots_hit, 1);
    assert_eq!(
        stats.reactions, 1,
        "the first hit after a sighting is measured"
    );
    assert_eq!(
        stats.quick_reactions, 1,
        "two ticks is faster than anybody sees"
    );
}

#[test]
fn a_hit_at_human_speed_after_a_sighting_is_measured_and_not_quick() {
    let mut duel = Duel::new();
    let target = duel.position(duel.victim);
    duel.look_at(target, 20);
    // A third of a second: a fast human's reaction, aim and shot.
    duel.sighted((0.33 / TICK_DT) as u32);
    duel.fire_at(target);

    let stats = duel.stats(duel.shooter);
    assert_eq!(stats.reactions, 1);
    assert_eq!(stats.quick_reactions, 0);
}

#[test]
fn a_target_watched_for_the_whole_window_is_not_a_reaction() {
    let mut duel = Duel::new();
    let target = duel.position(duel.victim);
    duel.look_at(target, 20);
    duel.fire_at(target);

    let stats = duel.stats(duel.shooter);
    assert_eq!(stats.shots_hit, 1);
    assert_eq!(
        stats.reactions, 0,
        "in sight all along is tracking, not reacting"
    );
}

#[test]
fn a_burst_at_one_sighting_is_one_reaction() {
    let mut duel = Duel::new();
    let target = duel.position(duel.victim);
    duel.look_at(target, 20);
    duel.sighted(2);
    duel.fire_at(target);
    duel.reload();
    duel.fire_at(target);

    let stats = duel.stats(duel.shooter);
    assert_eq!(stats.shots_hit, 2);
    assert_eq!(
        stats.reactions, 1,
        "the second round of a burst is not a second fight"
    );
}

// ---- the zone, health coming back, the magazine and grenades ---------------

impl Duel {
    /// One tick in which the shooter holds `buttons`, looking at `target`.
    fn press(&mut self, buttons: u8, target: Vec3) {
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
                buttons: Buttons(buttons),
            }],
        });
        self.lobby.step();
    }

    fn steps(&mut self, ticks: usize) {
        for _ in 0..ticks {
            self.lobby.step();
        }
    }

    fn body_mut(&mut self, id: PlayerId) -> &mut Body {
        self.lobby
            .matches
            .get_mut(&self.match_id)
            .unwrap()
            .bodies
            .get_mut(&id)
            .unwrap()
    }

    /// Put the match this far into its clock, where the circle is small.
    fn late_in_the_match(&mut self) {
        let late = (solatel_protocol::sim::ZONE_STEP * 4.5 / TICK_DT) as u32;
        let game = self.lobby.matches.get_mut(&self.match_id).unwrap();
        let start = game.warm_from.or(game.started_tick).unwrap();
        // Wrapping, as `elapsed` counts: early in a test the tick is small.
        // The clock runs from when the countdown began, so that is what
        // moves back; the start goes with it.
        game.started_tick = Some(start.wrapping_sub(late));
        game.warm_from = Some(start.wrapping_sub(late));
        // And the victim out on the east side of the arena, on open ground
        // well beyond where the circle has closed to.
        let victim = self.victim;
        let body = self.body_mut(victim);
        body.state.position.x = 40.0;
        body.state.position.z = 0.0;
        body.state.position.y += 0.5;
        body.history.clear();
    }
}

fn seconds(s: f32) -> usize {
    (s / TICK_DT).ceil() as usize
}

#[test]
fn the_zone_burns_whoever_is_outside_it_and_moves_nobody() {
    let mut duel = Duel::new();
    duel.late_in_the_match();
    let before = duel.position(duel.victim);
    // The duel is set up around a spawn well away from the middle, so late
    // in a match the victim is outside the circle.
    let zone = duel.lobby.matches[&duel.match_id].zone(duel.lobby.tick);
    assert!(
        zone.excludes(before),
        "test setup: the victim should be outside ({zone:?}, at {before:?}, tick {}, started {:?})",
        duel.lobby.tick,
        duel.lobby.matches[&duel.match_id].started_tick
    );
    duel.steps(seconds(1.0));
    assert!(
        duel.health(duel.victim) < MAX_HEALTH,
        "the zone did no damage"
    );
    let after = duel.position(duel.victim);
    let moved = Vec3::new(after.x - before.x, 0.0, after.z - before.z).length();
    assert!(moved < 0.1, "the zone moved somebody {moved:.2} m");
}

#[test]
fn a_zone_death_after_a_shot_is_the_shooters_kill() {
    let mut duel = Duel::new();
    let mut ledger = charge(&mut duel);
    let centre = duel.position(duel.victim);
    duel.fire_at(centre);
    duel.late_in_the_match();
    duel.body_mut(duel.victim).state.health = 5;
    duel.steps(seconds(2.0));
    assert!(
        !duel.alive(duel.victim),
        "the zone should have finished them"
    );
    assert!(
        asked_of(&mut ledger).contains(&LedgerRequest::SettleKill {
            entry: EntryId {
                match_id: duel.match_id,
                player_id: duel.victim,
            },
            killer: duel.shooter,
        }),
        "running into the zone must not be a way out of a fight"
    );
}

#[test]
fn a_zone_death_nobody_caused_settles_as_a_walk_away() {
    let mut duel = Duel::new();
    let mut ledger = charge(&mut duel);
    duel.late_in_the_match();
    duel.body_mut(duel.victim).state.health = 3;
    duel.steps(seconds(2.0));
    assert!(!duel.alive(duel.victim));
    assert!(
        asked_of(&mut ledger).contains(&LedgerRequest::AbandonEntry {
            entry: EntryId {
                match_id: duel.match_id,
                player_id: duel.victim,
            },
        })
    );
}

#[test]
fn health_comes_back_after_a_pause_and_is_full_in_about_eleven_seconds() {
    let mut duel = Duel::new();
    let centre = duel.position(duel.victim);
    duel.fire_at(centre);
    duel.body_mut(duel.victim).state.health = 10;
    duel.steps(seconds(REGEN_DELAY - 0.5));
    assert_eq!(
        duel.health(duel.victim),
        10,
        "nothing came back during the pause"
    );
    duel.steps(seconds(0.5 + REGEN_SECONDS * 0.5));
    let halfway = duel.health(duel.victim);
    assert!(
        halfway > 40 && halfway < MAX_HEALTH,
        "half way through at {halfway}"
    );
    duel.steps(seconds(REGEN_SECONDS * 0.5 + 0.5));
    assert_eq!(duel.health(duel.victim), MAX_HEALTH);
}

#[test]
fn a_magazine_runs_out_and_a_reload_refills_it() {
    let mut duel = Duel::new();
    // Aim at nothing, so the victim survives the whole magazine.
    let sky = duel.body(duel.shooter).state.eye_position() + Vec3::new(0.0, 50.0, -1.0);
    for _ in 0..(rifle_magazine() as usize + 5) {
        duel.press(Buttons::FIRE, sky);
        duel.reload();
    }
    let stats = duel.stats(duel.shooter);
    assert_eq!(
        stats.shots_fired,
        rifle_magazine(),
        "fired past the end of the magazine"
    );
    assert!(
        duel.body(duel.shooter).arms.reloading()
            || duel.body(duel.shooter).arms.rounds() == rifle_magazine()
    );
    duel.steps(seconds(rifle_reload_seconds() + 0.1));
    assert_eq!(
        duel.body(duel.shooter).arms.rounds(),
        rifle_magazine(),
        "the reload did not finish"
    );
}

#[test]
fn reloading_by_hand_blocks_the_trigger_until_it_is_done() {
    let mut duel = Duel::new();
    let sky = duel.body(duel.shooter).state.eye_position() + Vec3::new(0.0, 50.0, -1.0);
    duel.press(Buttons::FIRE, sky);
    duel.reload();
    duel.press(Buttons::RELOAD, sky);
    let fired = duel.stats(duel.shooter).shots_fired;
    for _ in 0..10 {
        duel.press(Buttons::FIRE, sky);
    }
    assert_eq!(
        duel.stats(duel.shooter).shots_fired,
        fired,
        "fired mid-reload"
    );
    duel.steps(seconds(rifle_reload_seconds()));
    assert_eq!(duel.body(duel.shooter).arms.rounds(), rifle_magazine());
}

/// Whether the victim's latest snapshot says the shooter is aiming.
fn seen_aiming(duel: &mut Duel) -> bool {
    let _ = drain(&mut duel.victim_rx);
    duel.lobby.broadcast_snapshot(duel.match_id);
    drain(&mut duel.victim_rx)
        .into_iter()
        .rev()
        .find_map(|m| match m {
            ServerMsg::Snapshot { players, .. } => Some(players),
            _ => None,
        })
        .expect("a snapshot")
        .iter()
        .find(|p| p.id == duel.shooter)
        .expect("the shooter in it")
        .aiming
}

#[test]
fn aiming_is_seen_by_everybody_and_decides_nothing() {
    // Other players drew everybody shouldered all the time, which told
    // nobody anything. The aim button is told to them instead, as a reload
    // is: it is done in plain view.
    let mut duel = Duel::new();
    let at = duel.position(duel.victim);
    assert!(!seen_aiming(&mut duel), "nobody is aiming to begin with");
    duel.press(Buttons::AIM, at);
    assert!(seen_aiming(&mut duel), "the rifle came up");
    // A late packet carries a posture on, as it does a crouch.
    duel.steps(3);
    assert!(seen_aiming(&mut duel), "a late packet lowered the rifle");
    duel.press(0, at);
    assert!(!seen_aiming(&mut duel), "and went down again");

    // Where a shot lands is the same either way.
    duel.press(Buttons::FIRE | Buttons::AIM, at);
    let aimed = MAX_HEALTH - duel.health(duel.victim);
    duel.body_mut(duel.victim).state.health = MAX_HEALTH;
    duel.reload();
    duel.press(Buttons::FIRE, at);
    let unaimed = MAX_HEALTH - duel.health(duel.victim);
    assert!(aimed > 0, "test setup: the shot should land");
    assert_eq!(aimed, unaimed, "aiming changed what a shot did");
}

#[test]
fn a_grenade_kill_pays_the_thrower() {
    let mut duel = Duel::new();
    let mut ledger = charge(&mut duel);
    let victim_at = duel.position(duel.victim);
    // Lob it at the victim's feet, three metres away.
    duel.press(Buttons::THROW, victim_at - Vec3::new(0.0, 0.6, 0.0));
    assert_eq!(duel.body(duel.shooter).grenades, GRENADES_PER_LIFE - 1);
    // Holding the button is still one throw.
    duel.press(Buttons::THROW, victim_at);
    assert_eq!(duel.body(duel.shooter).grenades, GRENADES_PER_LIFE - 1);
    duel.body_mut(duel.victim).state.health = 20;
    // The shooter steps well back so only the victim is caught.
    let away = (victim_at - duel.position(duel.shooter)).normalize() * 12.0;
    let shooter = duel.shooter;
    duel.body_mut(shooter).state.position -= away;
    duel.steps(seconds(GRENADE_FUSE + 0.2));
    assert!(
        !duel.alive(duel.victim),
        "the blast should have finished them"
    );
    assert!(asked_of(&mut ledger).contains(&LedgerRequest::SettleKill {
        entry: EntryId {
            match_id: duel.match_id,
            player_id: duel.victim,
        },
        killer: duel.shooter,
    }));
}

// --- Waiting for everybody's map ------------------------------------------

/// A match that has just started, who is in it and what each of them is told.
type Loading = (
    Lobby,
    MatchId,
    Vec<(PlayerId, SessionId)>,
    Vec<mpsc::Receiver<ServerMsg>>,
);

/// `n` players in a match that has just started, with a one second warm-up
/// and `load_wait` seconds of patience for their maps.
fn loading(n: usize, load_wait: f32) -> Loading {
    let mut lobby = free_play();
    lobby.warmup = 1.0;
    lobby.load_wait = load_wait;
    let mut players = Vec::new();
    let mut receivers = Vec::new();
    for i in 0..n {
        let (tx, rx) = mpsc::channel(8192);
        let (joined, session) = join(&mut lobby, &format!("Loader {i}"), None, tx);
        queue(&mut lobby, joined.player_id, session, 1);
        players.push((joined.player_id, session));
        receivers.push(rx);
    }
    run_matchmaker(&mut lobby);
    let match_id = *lobby
        .matches
        .iter()
        .find(|(_, m)| m.running())
        .expect("a match")
        .0;
    assert_eq!(
        lobby.matches[&match_id].bodies.len(),
        n,
        "test setup: everybody in"
    );
    (lobby, match_id, players, receivers)
}

fn loaded(lobby: &mut Lobby, (player, session): (PlayerId, SessionId), match_id: MatchId) {
    lobby.handle(GameCommand::Loaded {
        player_id: player,
        session_id: session,
        match_id,
    });
}

/// The last snapshot's countdown and how many it said were still loading.
fn countdown(rx: &mut mpsc::Receiver<ServerMsg>) -> (u32, u32) {
    drain(rx)
        .into_iter()
        .filter_map(|m| match m {
            ServerMsg::Snapshot {
                starts_in_ms,
                loading,
                ..
            } => Some((starts_in_ms, loading)),
            _ => None,
        })
        .next_back()
        .expect("snapshots")
}

#[test]
fn the_countdown_waits_for_everybodys_map() {
    // Conrad's countdown appeared at five: the warm-up started with the
    // match, and his map took ten seconds to load and draw. It now starts
    // when the last player in the match says their map is drawn.
    let (mut lobby, match_id, players, mut rx) = loading(2, 30.0);
    for _ in 0..200 {
        lobby.step();
    }
    let (left, waiting) = countdown(&mut rx[0]);
    assert_eq!(waiting, 2, "both still loading");
    assert_eq!(left, 1000, "and the countdown not counting: {left} ms");
    assert!(lobby.matches[&match_id].warming_up(lobby.tick));

    loaded(&mut lobby, players[0], match_id);
    for _ in 0..100 {
        lobby.step();
    }
    let (left, waiting) = countdown(&mut rx[0]);
    assert_eq!((left, waiting), (1000, 1), "one is enough to wait for");

    loaded(&mut lobby, players[1], match_id);
    for _ in 0..20 {
        lobby.step();
    }
    let (left, waiting) = countdown(&mut rx[1]);
    assert_eq!(waiting, 0);
    assert!(
        left < 1000 && left > 0,
        "counting down once both are in: {left} ms"
    );

    for _ in 0..80 {
        lobby.step();
    }
    assert!(
        !lobby.matches[&match_id].warming_up(lobby.tick),
        "and live after it"
    );
}

#[test]
fn a_map_that_never_loads_holds_nobody_past_the_wait() {
    // One machine that never finishes - or a client too old to say so -
    // must not hold everybody else on their spawns for the whole match.
    let (mut lobby, match_id, players, mut rx) = loading(2, 0.5);
    loaded(&mut lobby, players[0], match_id);
    for _ in 0..20 {
        lobby.step();
    }
    assert_eq!(countdown(&mut rx[0]), (1000, 1), "waiting, for now");
    for _ in 0..((0.5 + 0.2) / TICK_DT) as usize {
        lobby.step();
    }
    let (left, waiting) = countdown(&mut rx[0]);
    assert_eq!(waiting, 0, "no longer waiting");
    assert!(left < 1000, "counting down without the last one: {left} ms");
}

#[test]
fn a_player_who_dropped_is_not_waited_for() {
    let (mut lobby, match_id, players, mut rx) = loading(2, 30.0);
    lobby.handle(GameCommand::Leave {
        player_id: players[1].0,
        session_id: players[1].1,
    });
    loaded(&mut lobby, players[0], match_id);
    for _ in 0..20 {
        lobby.step();
    }
    let (left, waiting) = countdown(&mut rx[0]);
    assert_eq!(waiting, 0);
    assert!(left < 1000, "counting down: {left} ms");
}

#[test]
fn a_loaded_for_another_match_or_from_another_socket_counts_for_nothing() {
    let (mut lobby, match_id, players, mut rx) = loading(1, 30.0);
    loaded(&mut lobby, players[0], MatchId::new());
    lobby.handle(GameCommand::Loaded {
        player_id: players[0].0,
        session_id: SessionId::new(),
        match_id,
    });
    for _ in 0..20 {
        lobby.step();
    }
    assert_eq!(
        countdown(&mut rx[0]),
        (1000, 1),
        "still waiting for the real one"
    );
    loaded(&mut lobby, players[0], match_id);
    for _ in 0..20 {
        lobby.step();
    }
    assert!(countdown(&mut rx[0]).0 < 1000);
}

// --- The warm-up -----------------------------------------------------------

/// One player, in a match that has just started with a one second warm-up.
fn warming_up() -> (
    Lobby,
    MatchId,
    PlayerId,
    SessionId,
    mpsc::Receiver<ServerMsg>,
) {
    let mut lobby = free_play();
    lobby.warmup = 1.0;
    let (tx, rx) = mpsc::channel(4096);
    let (joined, session) = join(&mut lobby, "Eager", None, tx);
    queue(&mut lobby, joined.player_id, session, 1);
    run_matchmaker(&mut lobby);
    let match_id = *lobby
        .matches
        .iter()
        .find(|(_, m)| m.running())
        .expect("a match")
        .0;
    (lobby, match_id, joined.player_id, session, rx)
}

/// Everything a client could try in one tick: run, jump, shoot, throw,
/// reload, crouch, and look somewhere new.
fn everything_at_once(lobby: &mut Lobby, player: PlayerId, session: SessionId, seq: u32, yaw: f32) {
    lobby.handle(GameCommand::Inputs {
        player_id: player,
        session_id: session,
        commands: vec![InputCommand {
            seq,
            forward: 1.0,
            right: 1.0,
            yaw,
            pitch: 0.2,
            buttons: Buttons(
                Buttons::JUMP
                    | Buttons::FIRE
                    | Buttons::CROUCH
                    | Buttons::RELOAD
                    | Buttons::THROW
                    | Buttons::AIM,
            ),
        }],
    });
}

#[test]
fn the_warm_up_gathers_everybody_and_lets_them_walk_but_not_fight() {
    // Conrad asked for it: everybody together while the countdown runs, so
    // a match is seen to be full of people, and on their own spawns when it
    // ends. Walking about is allowed - it buys nothing, since everybody is
    // moved anyway - and anything that could hurt anybody is not.
    let (mut lobby, match_id, player, session, _rx) = warming_up();
    let game = &lobby.matches[&match_id];
    assert!(game.gathered, "a match with a warm-up gathers");
    let (_, gx, gz) = *GATHERINGS
        .iter()
        .find(|(name, _, _)| *name == game.map.name)
        .expect("this map has a gathering");
    let body = &game.bodies[&player];
    let from_gathering = Vec3::new(body.state.position.x - gx, 0.0, body.state.position.z - gz);
    assert!(
        from_gathering.length() < 6.0,
        "waiting on the gathering ground, not {from_gathering:?} from it"
    );
    let spawn = body.spawn;
    assert!(
        (spawn.position - body.state.position).length() > 3.0,
        "test setup: the spawn should be somewhere else"
    );

    for _ in 0..20 {
        lobby.step();
    }
    let start = lobby.matches[&match_id].bodies[&player].state.position;
    let warmup_ticks = lobby.matches[&match_id].warmup_ticks;
    let mut seq = 0;
    for _ in 20..warmup_ticks.saturating_sub(2) {
        seq += 1;
        everything_at_once(&mut lobby, player, session, seq, 1.0);
        lobby.step();
    }
    let game = &lobby.matches[&match_id];
    let body = &game.bodies[&player];
    let walked = Vec3::new(
        body.state.position.x - start.x,
        0.0,
        body.state.position.z - start.z,
    );
    assert!(
        walked.length() > 0.5,
        "free to walk in the gathering: {walked:?}"
    );
    assert_eq!(body.stats.shots_fired, 0, "nothing is fired in the warm-up");
    assert_eq!(
        body.grenades, GRENADES_PER_LIFE,
        "nothing is thrown in the warm-up"
    );
    assert!(game.grenades.is_empty());
    assert!(!body.arms.reloading(), "nothing reloaded");
    assert!(body.previous_buttons.aim(), "the rifle may come up");

    // The countdown ends: on their own spawn, facing its way.
    for _ in 0..4 {
        lobby.step();
    }
    let game = &lobby.matches[&match_id];
    assert!(!game.gathered && !game.warming_up(lobby.tick));
    let body = &game.bodies[&player];
    let off = Vec3::new(
        body.state.position.x - spawn.position.x,
        0.0,
        body.state.position.z - spawn.position.z,
    );
    assert!(off.length() < 0.6, "put on their spawn, but {off:?} off it");
    assert!(
        body.history
            .iter()
            .all(|(_, s)| (s.position - spawn.position).length() < 2.0),
        "no history from the gathering for a shot to be rewound into"
    );
}

#[test]
fn a_map_with_nowhere_to_gather_holds_everybody_still_but_lets_them_look() {
    let (mut lobby, match_id, player, session, _rx) = warming_up();
    // As on a map with no gathering ground: on their own spawn, held.
    {
        let game = lobby.matches.get_mut(&match_id).unwrap();
        game.gathered = false;
        let body = game.bodies.get_mut(&player).unwrap();
        body.state = PlayerState::spawned_at(body.spawn);
        body.home = body.spawn;
    }
    // Onto the floor first: gravity is not held, only the player is.
    for _ in 0..20 {
        lobby.step();
    }
    let start = lobby.matches[&match_id].bodies[&player].state.position;
    let warmup_ticks = lobby.matches[&match_id].warmup_ticks;
    assert!(lobby.matches[&match_id].warming_up(lobby.tick));

    let mut seq = 0;
    for _ in 20..warmup_ticks.saturating_sub(1) {
        seq += 1;
        everything_at_once(&mut lobby, player, session, seq, 1.0);
        lobby.step();
    }
    let game = &lobby.matches[&match_id];
    let body = &game.bodies[&player];
    let moved = Vec3::new(
        body.state.position.x - start.x,
        0.0,
        body.state.position.z - start.z,
    );
    assert!(
        moved.length() < 1e-4,
        "held on the spawn, but moved {moved:?}"
    );
    assert_eq!(body.stats.shots_fired, 0, "nothing is fired in the warm-up");
    assert_eq!(
        body.grenades, GRENADES_PER_LIFE,
        "nothing is thrown in the warm-up"
    );
    assert!(game.grenades.is_empty());
    assert!(!body.state.crouched && !body.arms.reloading());
    assert!(
        (body.state.yaw - 1.0).abs() < 1e-4,
        "the aim is theirs to move"
    );
    assert!(body.previous_buttons.aim(), "and so is the rifle");

    // Past it, the same command does what it says.
    for _ in 0..40 {
        seq += 1;
        everything_at_once(&mut lobby, player, session, seq, 1.0);
        lobby.step();
    }
    let body = &lobby.matches[&match_id].bodies[&player];
    let moved = Vec3::new(
        body.state.position.x - start.x,
        0.0,
        body.state.position.z - start.z,
    );
    assert!(
        moved.length() > 0.5,
        "live, and still standing still at {moved:?}"
    );
    assert!(
        body.stats.shots_fired > 0,
        "live, and the trigger does nothing"
    );
}

#[test]
fn every_map_has_room_to_gather_a_full_match() {
    for map in solatel_protocol::sim::map::MAPS {
        let spots = gathering_spots(map, map.max_players);
        assert_eq!(
            spots.len(),
            map.max_players,
            "{} gathers {} of its {} seats",
            map.name,
            spots.len(),
            map.max_players
        );
        for (i, a) in spots.iter().enumerate() {
            for b in &spots[i + 1..] {
                assert!(
                    (a.position - b.position).length() > 1.0,
                    "{}: two players on one spot",
                    map.name
                );
            }
        }
    }
}

#[test]
fn the_match_clock_and_the_circle_start_when_the_warm_up_ends() {
    let (mut lobby, match_id, _player, _session, mut rx) = warming_up();
    let started = drain(&mut rx)
        .into_iter()
        .find_map(|m| match m {
            ServerMsg::MatchStarted { starts_in_ms, .. } => Some(starts_in_ms),
            _ => None,
        })
        .expect("told the match started");
    assert!(
        (900..=1000).contains(&started),
        "the start says how long the warm-up is: {started} ms"
    );

    for _ in 0..30 {
        lobby.step();
    }
    let game = &lobby.matches[&match_id];
    assert_eq!(
        game.elapsed(lobby.tick),
        0.0,
        "no match time passes in the warm-up"
    );
    let full = game.zone(lobby.tick).radius;
    let snapshot = drain(&mut rx)
        .into_iter()
        .filter_map(|m| match m {
            ServerMsg::Snapshot {
                starts_in_ms,
                match_remaining_ms,
                ..
            } => Some((starts_in_ms, match_remaining_ms)),
            _ => None,
        })
        .next_back()
        .expect("snapshots in the warm-up");
    assert!(
        snapshot.0 > 0 && snapshot.0 < started,
        "counting down: {snapshot:?}"
    );
    assert_eq!(
        snapshot.1,
        (MATCH_DURATION * 1000.0) as u32,
        "the clock has not started"
    );

    // Well past the warm-up and a whole stage of the circle.
    let ticks = ((1.0 + solatel_protocol::sim::ZONE_STEP * 2.0) / TICK_DT) as usize;
    for _ in 0..ticks {
        lobby.step();
    }
    let game = &lobby.matches[&match_id];
    let elapsed = game.elapsed(lobby.tick);
    let since_start = (30 + ticks) as f32 * TICK_DT;
    assert!(
        (elapsed - (since_start - 1.0)).abs() < 0.05,
        "the clock runs from the end of the warm-up: {elapsed} of {since_start}"
    );
    assert!(
        game.zone(lobby.tick).radius < full,
        "and so does the circle"
    );
    let live = drain(&mut rx)
        .into_iter()
        .filter_map(|m| match m {
            ServerMsg::Snapshot { starts_in_ms, .. } => Some(starts_in_ms),
            _ => None,
        })
        .next_back()
        .expect("snapshots once live");
    assert_eq!(live, 0, "a live match has no countdown");
}

#[test]
fn a_match_found_is_said_the_moment_it_forms_before_any_money_moves() {
    let mut paid = Paid::new();
    let (a, a_session, mut a_rx) = paid.join("A");
    let (b, b_session, mut b_rx) = paid.join("B");
    queue(&mut paid.lobby, a, a_session, 1);
    queue(&mut paid.lobby, b, b_session, 1);
    let ticks = ((paid.lobby.wait + 1.0) / TICK_DT).ceil() as usize;
    for _ in 0..ticks {
        paid.lobby.step();
        if paid.forming().is_some() {
            break;
        }
    }
    let match_id = paid.forming().expect("a forming match");
    for rx in [&mut a_rx, &mut b_rx] {
        let told = drain(rx);
        assert!(
            told.iter().any(|m| matches!(
                m,
                ServerMsg::MatchFound { match_id: found, players: 2, .. } if *found == match_id
            )),
            "each player hears the match was found: {told:?}"
        );
        assert!(
            !told
                .iter()
                .any(|m| matches!(m, ServerMsg::MatchStarted { .. })),
            "and not that it started, because nobody has paid yet"
        );
    }
}

// ---- late inputs, and what a shot is judged against -----------------------

/// One player alone in a match, standing on their spawn.
struct Walker {
    lobby: Lobby,
    match_id: MatchId,
    id: PlayerId,
    session: SessionId,
    _rx: mpsc::Receiver<ServerMsg>,
}

impl Walker {
    fn new() -> Self {
        let mut lobby = free_play();
        let (tx, rx) = mpsc::channel(4096);
        let (joined, session) = join(&mut lobby, "Walker", None, tx);
        queue(&mut lobby, joined.player_id, session, 1);
        run_matchmaker(&mut lobby);
        let match_id = *lobby
            .matches
            .iter()
            .find(|(_, m)| m.running())
            .expect("a match of one")
            .0;
        let mut walker = Self {
            lobby,
            match_id,
            id: joined.player_id,
            session,
            _rx: rx,
        };
        // Settled on the floor before anything is sent.
        for _ in 0..40 {
            walker.lobby.step();
        }
        walker
    }

    fn body(&self) -> &Body {
        &self.lobby.matches[&self.match_id].bodies[&self.id]
    }

    fn ground(&self) -> &'static map::Map {
        self.lobby.matches[&self.match_id].map
    }

    /// Sends these commands as a client would, as many to a message as the
    /// wire allows.
    fn send(&mut self, commands: &[InputCommand]) {
        for chunk in commands.chunks(MAX_INPUTS_PER_MESSAGE) {
            self.lobby.handle(GameCommand::Inputs {
                player_id: self.id,
                session_id: self.session,
                commands: chunk.to_vec(),
            });
        }
    }

    /// One command a tick, on time.
    fn on_time(&mut self, commands: &[InputCommand]) {
        for command in commands {
            self.send(&[*command]);
            self.lobby.step();
        }
    }
}

/// Running, swerving and turning: a guess of the last command gets this
/// wrong every tick, so putting it right shows.
fn swerving(from: u32, count: u32) -> Vec<InputCommand> {
    (from..from + count)
        .map(|seq| InputCommand {
            seq,
            forward: 1.0,
            right: if seq % 12 < 6 { 0.7 } else { -0.7 },
            yaw: seq as f32 * 0.03,
            pitch: 0.0,
            buttons: Buttons(0),
        })
        .collect()
}

/// Where these commands take a body, stepped by hand: what its owner's
/// client predicts.
fn predicted(mut state: PlayerState, commands: &[InputCommand], ground: &map::Map) -> PlayerState {
    for command in commands {
        solatel_protocol::sim::step_tick(&mut state, command, ground);
    }
    state
}

#[test]
fn late_commands_cost_their_owner_nothing() {
    let mut walker = Walker::new();
    let start = walker.body().state;
    let ground = walker.ground();
    let commands = swerving(1, 30);

    walker.on_time(&commands[..10]);
    // Six ticks with nothing arriving: the body carries on on a guess.
    for _ in 0..6 {
        walker.lobby.step();
    }
    let own = predicted(start, &commands[..10], ground);
    assert!(
        walker.body().guess.is_some(),
        "a tick with nothing to run is guessed"
    );
    assert_ne!(
        walker.body().state.position,
        own.position,
        "everybody else should see the body carry on"
    );
    assert_eq!(
        walker.body().reported_state().position,
        own.position,
        "and its owner where their own commands left it"
    );

    // The six late ones arrive with this tick's, and all seven run now.
    walker.send(&commands[10..17]);
    walker.lobby.step();
    let own = predicted(start, &commands[..17], ground);
    assert_eq!(walker.body().last_applied_seq, 17);
    assert!(walker.body().guess.is_none());
    assert_eq!(
        walker.body().state.position,
        own.position,
        "the body should be exactly where its owner's prediction put it"
    );
    assert_eq!(walker.body().state.velocity, own.velocity);

    // And no further behind for it: the next command runs on the next tick.
    walker.on_time(&commands[17..18]);
    assert_eq!(walker.body().last_applied_seq, 18);
    assert!(walker.body().pending.is_empty());
}

#[test]
fn holding_commands_back_does_not_move_a_body_any_faster() {
    let mut walker = Walker::new();
    let start = walker.body().state;
    let ground = walker.ground();
    let commands = swerving(1, 30);

    walker.on_time(&commands[..1]);
    for _ in 0..8 {
        walker.lobby.step();
    }
    // Everything at once: twenty commands after nine ticks.
    walker.send(&commands[1..21]);
    walker.lobby.step();
    assert_eq!(
        walker.body().last_applied_seq,
        10,
        "one command for every tick and not one more: eight guessed, and this"
    );
    assert_eq!(
        walker.body().state.position,
        predicted(start, &commands[..10], ground).position
    );

    // The rest were sent early, and waiting is lag: the backlog goes.
    walker.lobby.step();
    assert!(walker.body().pending.len() < BACKLOG_LIMIT);
}

#[test]
fn a_guess_too_old_to_put_right_stands() {
    let mut walker = Walker::new();
    let ground = walker.ground();
    let commands = swerving(1, 40);

    walker.on_time(&commands[..5]);
    for _ in 0..GUESS_WINDOW_TICKS + 10 {
        walker.lobby.step();
    }
    let guessed = walker.body().state;
    assert_eq!(
        walker.body().reported_state().position,
        guessed.position,
        "past the window, its owner is told the guess stands"
    );

    walker.send(&commands[5..30]);
    walker.lobby.step();
    assert_eq!(
        walker.body().last_applied_seq,
        30,
        "only the newest runs: the rest were for ticks long gone"
    );
    assert!(walker.body().pending.is_empty());
    assert_eq!(
        walker.body().state.position,
        predicted(guessed, &commands[29..30], ground).position
    );
}

#[test]
fn a_throw_held_across_a_late_packet_is_one_throw() {
    let mut walker = Walker::new();
    let throwing = |seq: u32| InputCommand {
        seq,
        forward: 0.0,
        right: 0.0,
        yaw: 0.0,
        pitch: 0.3,
        buttons: Buttons(Buttons::THROW),
    };
    walker.on_time(&[throwing(1)]);
    for _ in 0..3 {
        walker.lobby.step();
    }
    walker.send(&[throwing(2), throwing(3), throwing(4), throwing(5)]);
    walker.lobby.step();
    assert_eq!(walker.body().last_applied_seq, 5);
    assert_eq!(
        walker.body().grenades,
        GRENADES_PER_LIFE - 1,
        "the button never came up, so there was only ever one throw"
    );
}

/// A duel with the victim written into their own history running sideways
/// at `metres` a tick, the shooter `rtt_ms` away. Returns where the victim
/// was `ticks` ago as of the tick the next shot is resolved on.
///
/// The run is put somewhere the shooter can see all of, square enough to
/// the line of fire that a shot at one place in it cannot clip the box at
/// another: the duel's three metres would make every shot at the run so
/// oblique that it passes through the front of several.
fn running_target(duel: &mut Duel, rtt_ms: f32, metres: f32) -> impl Fn(f32) -> Vec3 + use<> {
    duel.lobby
        .connections
        .get_mut(&duel.shooter)
        .unwrap()
        .rtt_ms = rtt_ms;
    let spawn = map::active().spawn(0);
    let ahead = look_direction(spawn.yaw, 0.0);
    let across = look_direction(spawn.yaw + std::f32::consts::FRAC_PI_2, 0.0);
    let eye = duel.body(duel.shooter).state.eye_position();
    let ground = duel.lobby.matches[&duel.match_id].map;
    let (base, side) = [6.0f32, 8.0, 10.0, 12.0]
        .into_iter()
        .flat_map(|off| [(off, across), (off, -across)])
        .map(|(off, side)| (duel.position(duel.shooter) + ahead * off, side))
        .find(|&(base, side)| {
            (0..=24).all(|k| {
                let at = base + side * (k as f32 * metres);
                let to = at - eye;
                hitscan::trace_world(eye, to.normalize(), to.length(), ground).is_none()
            })
        })
        .expect("somewhere in front of the first spawn the shooter can see a run across");
    let resolved_on = duel.lobby.tick.wrapping_add(1);
    let body = duel
        .lobby
        .matches
        .get_mut(&duel.match_id)
        .unwrap()
        .bodies
        .get_mut(&duel.victim)
        .unwrap();
    body.state.position = base;
    for (tick, state) in body.history.iter_mut() {
        state.position = base + side * (resolved_on.wrapping_sub(*tick) as f32 * metres);
    }
    move |ticks: f32| base + side * (ticks * metres)
}

#[test]
fn a_shot_is_judged_against_what_its_shooter_could_see() {
    let mut duel = Duel::new();
    let was = running_target(&mut duel, 100.0, 0.2);
    // The whole round trip, the tick the command waited, and the buffer the
    // shooter renders everybody else behind by.
    let rewind = 100.0 + waited_ms(1) + INTERPOLATION_DELAY_MS;
    duel.fire_at(was((rewind / (TICK_DT * 1000.0)).round()));
    assert!(
        duel.health(duel.victim) < MAX_HEALTH,
        "a shot at where the victim was on the shooter's screen should land"
    );
}

#[test]
fn a_shot_is_not_judged_against_where_the_target_got_to_since() {
    let mut duel = Duel::new();
    let was = running_target(&mut duel, 100.0, 0.2);
    // Half the round trip, which is what the rewind used to be: the target a
    // few ticks further on than the shooter ever saw them.
    let rewind = 50.0 + INTERPOLATION_DELAY_MS;
    duel.fire_at(was((rewind / (TICK_DT * 1000.0)).round()));
    assert_eq!(
        duel.health(duel.victim),
        MAX_HEALTH,
        "nobody was standing there on the shooter's screen"
    );
}

#[test]
fn a_late_tick_is_made_up_so_game_time_keeps_the_walls() {
    let period = std::time::Duration::from_secs_f32(TICK_DT);
    let start = tokio::time::Instant::now();
    let mut clock = TickClock::new(start, period);
    // Ten ticks, the third a whole 40 ms late: the ones after it run at once
    // until the schedule is back where it was.
    let mut now = start;
    for n in 1..=10u32 {
        now = now.max(clock.due());
        if n == 3 {
            now += std::time::Duration::from_millis(40);
        }
        clock.advance(now);
    }
    assert_eq!(
        clock.due(),
        start + period * 11,
        "the eleventh tick is due when it always was"
    );
}

#[test]
fn a_stall_is_not_fast_forwarded() {
    let period = std::time::Duration::from_secs_f32(TICK_DT);
    let start = tokio::time::Instant::now();
    let mut clock = TickClock::new(start, period);
    // A paused container: two seconds between one tick and the next.
    let woke = clock.due() + std::time::Duration::from_secs(2);
    clock.advance(woke);
    assert_eq!(
        clock.due(),
        woke + period,
        "the clock starts again from when it woke, rather than running two seconds of ticks"
    );
}

#[test]
fn a_body_whose_owner_leaves_mid_guess_stands_where_they_left_it() {
    let mut walker = Walker::new();
    let start = walker.body().state;
    let ground = walker.ground();
    let commands = swerving(1, 10);
    walker.on_time(&commands);
    for _ in 0..8 {
        walker.lobby.step();
    }
    assert!(walker.body().guess.is_some());
    walker.lobby.handle(GameCommand::Leave {
        player_id: walker.id,
        session_id: walker.session,
    });
    assert!(walker.body().guess.is_none());
    assert_eq!(
        walker.body().state.position,
        predicted(start, &commands, ground).position,
        "the guess carried them on after their last command, and is taken back"
    );
}

// ---- the guns ----------------------------------------------------------
//
// Five of them, and what tells them apart is all the server's: the rate, the
// magazine, the reload, the draw, the damage at each range and the round's
// flight. Most of these are fought over the duel's three metres, where a
// round lands inside the tick it is fired; the long ones are moved onto
// open ground, because no map has a clear 300 metres and a test that fired
// across one would be measuring its buildings.

/// Flat ground as far as anybody can shoot.
static OPEN_BRUSHES: &[map::Brush] = &[map::Brush::new(
    Vec3::new(-2000.0, -1.0, -2000.0),
    Vec3::new(2000.0, 0.0, 2000.0),
)];
static OPEN_SPAWNS: &[map::Spawn] = &[map::Spawn {
    position: Vec3::new(0.0, 1.0, 0.0),
    yaw: 0.0,
}];
static OPEN_GROUND: map::Map =
    map::Map::new("open", 1.0, 2000.0, 2000.0, OPEN_BRUSHES, OPEN_SPAWNS, 30);

impl Duel {
    /// The duel moved onto open ground: the shooter at the origin facing
    /// -Z, the victim `distance` metres down the line, the bystander well
    /// off it, every history filled where they now stand.
    fn out_in_the_open(&mut self, distance: f32) {
        let stand = |x: f32, z: f32| {
            PlayerState::spawned_at(map::Spawn {
                position: Vec3::new(x, PLAYER_HALF_EXTENTS.y, z),
                yaw: 0.0,
            })
        };
        let game = self.lobby.matches.get_mut(&self.match_id).unwrap();
        game.map = &OPEN_GROUND;
        for (id, state) in [
            (self.shooter, stand(0.0, 0.0)),
            (self.victim, stand(0.0, -distance)),
            (self.bystander, stand(400.0, 400.0)),
        ] {
            let body = game.bodies.get_mut(&id).unwrap();
            body.state = state;
            body.guess = None;
            body.history.clear();
            body.last_input = idle_input(state);
        }
        self.steps(40);
    }

    /// One tick of the victim running `right` (-1 to 1) across the line of
    /// fire while the shooter does `shooter_buttons` at `target`.
    fn strafe_tick(&mut self, right: f32, shooter_buttons: u8, target: Vec3) {
        self.seq += 1;
        let victim_yaw = self.body(self.victim).state.yaw;
        self.lobby.handle(GameCommand::Inputs {
            player_id: self.victim,
            session_id: self.victim_session,
            commands: vec![InputCommand {
                seq: self.seq,
                forward: 0.0,
                right,
                yaw: victim_yaw,
                pitch: 0.0,
                buttons: Buttons(0),
            }],
        });
        self.press(shooter_buttons, target);
    }

    fn shooter_saw(&mut self) -> Vec<ServerMsg> {
        drain(&mut self.shooter_rx)
    }
}

/// How far under the line of sight `weapon`'s round is `distance` metres
/// out, and how long it took to get there, by the shared flight.
fn flight_to(weapon: Weapon, distance: f32) -> (f32, f32) {
    let mut round = Round::fired(weapon, Vec3::ZERO, 0.0, 0.0);
    let mut seconds = 0.0;
    while -round.position.z < distance {
        round.step(weapon.stats().drag, TICK_DT);
        seconds += TICK_DT;
    }
    (-round.position.y, seconds)
}

#[test]
fn every_automatic_gun_fires_at_its_own_rate_and_no_faster() {
    for weapon in [Weapon::Smg, Weapon::Rifle, Weapon::Lmg] {
        let mut duel = Duel::armed(Loadout {
            primary: weapon,
            optic: weapon.default_optic(),
        });
        let sky = duel.body(duel.shooter).state.eye_position() + Vec3::new(0.0, 50.0, -1.0);
        // The trigger held for a second, every tick.
        for _ in 0..TICK_HZ {
            duel.press(Buttons::FIRE, sky);
        }
        let every = weapon.stats().fire_ticks;
        let expected = (TICK_HZ - 1) / every + 1;
        assert_eq!(
            duel.stats(duel.shooter).shots_fired,
            expected,
            "{weapon:?} fires every {every} ticks"
        );
    }
}

#[test]
fn a_bolt_or_a_pistol_fires_once_a_pull_however_long_it_is_held() {
    let mut duel = Duel::armed(Loadout {
        primary: Weapon::Sniper,
        optic: Optic::X4,
    });
    let sky = duel.body(duel.shooter).state.eye_position() + Vec3::new(0.0, 50.0, -1.0);
    for _ in 0..200 {
        duel.press(Buttons::FIRE, sky);
    }
    assert_eq!(duel.stats(duel.shooter).shots_fired, 1, "held, it fired once");

    // Pulled as fast as a finger can - every other tick - the bolt still
    // decides: the first pull fires, and then one a second and a quarter.
    for i in 0..200 {
        duel.press(if i % 2 == 0 { 0 } else { Buttons::FIRE }, sky);
    }
    let bolt = Weapon::Sniper.stats().fire_ticks;
    assert_eq!(duel.stats(duel.shooter).shots_fired, 1 + 1 + (200 - 2) / bolt);

    // The pistol the same way, with its own rate.
    duel.steps(seconds(1.5));
    for _ in 0..seconds(0.5) {
        duel.press(Buttons::SIDEARM, sky);
    }
    let before = duel.stats(duel.shooter).shots_fired;
    for _ in 0..50 {
        duel.press(Buttons::SIDEARM | Buttons::FIRE, sky);
    }
    assert_eq!(duel.stats(duel.shooter).shots_fired, before + 1);
    for i in 0..60 {
        let fire = if i % 2 == 0 { 0 } else { Buttons::FIRE };
        duel.press(Buttons::SIDEARM | fire, sky);
    }
    let pistol = Weapon::Pistol.stats().fire_ticks;
    assert_eq!(duel.stats(duel.shooter).shots_fired, before + 1 + 60 / pistol);
}

#[test]
fn changing_guns_takes_the_drawn_guns_time_and_puts_away_a_reload() {
    let mut duel = Duel::new();
    let sky = duel.body(duel.shooter).state.eye_position() + Vec3::new(0.0, 50.0, -1.0);
    for _ in 0..3 {
        duel.press(Buttons::FIRE, sky);
        duel.reload();
    }
    duel.press(Buttons::RELOAD, sky);
    assert!(duel.body(duel.shooter).arms.reloading());

    // Out comes the pistol, and the magazine that was going in is not in.
    duel.press(Buttons::SIDEARM, sky);
    let arms = duel.body(duel.shooter).arms;
    assert_eq!(arms.held, Slot::Sidearm);
    assert!(!arms.reloading(), "the reload went away with the rifle");
    assert_eq!(arms.spare(), rifle_magazine() - 3);

    // Not ready until it is drawn.
    let fired = duel.stats(duel.shooter).shots_fired;
    let draw = Weapon::Pistol.stats().draw_ticks as usize;
    for _ in 0..(draw - 2) / 2 {
        duel.press(Buttons::SIDEARM | Buttons::FIRE, sky);
        duel.press(Buttons::SIDEARM, sky);
    }
    assert_eq!(duel.stats(duel.shooter).shots_fired, fired, "fired while drawing");
    duel.steps(4);
    duel.press(Buttons::SIDEARM, sky);
    duel.press(Buttons::SIDEARM | Buttons::FIRE, sky);
    assert_eq!(duel.stats(duel.shooter).shots_fired, fired + 1);
    assert_eq!(
        duel.body(duel.shooter).arms.rounds(),
        Weapon::Pistol.stats().magazine - 1
    );

    // And back: the rifle takes its own time, longer than the pistol's.
    duel.press(0, sky);
    let arms = duel.body(duel.shooter).arms;
    assert_eq!(arms.weapon(), Weapon::Rifle);
    assert_eq!(arms.ready_at - duel.lobby.tick, Weapon::Rifle.stats().draw_ticks);
    assert!(Weapon::Rifle.stats().draw_ticks > Weapon::Pistol.stats().draw_ticks);
}

#[test]
fn a_long_shot_takes_time_to_arrive() {
    let mut duel = Duel::new();
    duel.out_in_the_open(200.0);
    let chest = duel.position(duel.victim);
    let _ = duel.shooter_saw();
    duel.fire_at(chest);

    // Fired, and not there yet: 200 metres is a quarter of a second for a
    // rifle round, and the shooter's lag covers a tenth of it.
    assert_eq!(duel.health(duel.victim), MAX_HEALTH, "a round arrived instantly");
    assert_eq!(duel.lobby.matches[&duel.match_id].rounds.len(), 1);
    let fired = duel
        .shooter_saw()
        .into_iter()
        .find_map(|m| match m {
            ServerMsg::ShotFired {
                shot,
                weapon,
                landed,
                velocity,
                ..
            } => Some((shot, weapon, landed, velocity)),
            _ => None,
        })
        .expect("the shot was told");
    assert_eq!(fired.1, Weapon::Rifle);
    assert!(fired.2.is_none(), "it had not landed when it was told");
    assert!((fired.3.length() - Weapon::Rifle.stats().muzzle_velocity).abs() < 1.0);

    let (_, arrives) = flight_to(Weapon::Rifle, 200.0);
    duel.steps(seconds(arrives));
    assert_eq!(
        duel.health(duel.victim),
        MAX_HEALTH - Weapon::Rifle.damage(HitRegion::Body, 200.0),
        "and then it did, doing what a rifle does at 200 m"
    );
    let landed = duel.shooter_saw().into_iter().find_map(|m| match m {
        ServerMsg::ShotLanded { shot, landing, .. } => Some((shot, landing)),
        _ => None,
    });
    let (shot, landing) = landed.expect("its landing was told");
    assert_eq!(shot, fired.0, "paired with the shot it was");
    assert!(landing.hit_player && landing.struck);
    assert!(duel.lobby.matches[&duel.match_id].rounds.is_empty());
}

#[test]
fn a_long_shot_falls_and_has_to_be_aimed_over() {
    let sniper = Loadout {
        primary: Weapon::Sniper,
        optic: Optic::X4,
    };
    let distance = 300.0;
    let (drop, arrives) = flight_to(Weapon::Sniper, distance);
    assert!(drop > 0.4, "a .308 round drops {drop} m by {distance} m");

    // Aimed at the middle of the head, it falls into the body.
    let mut duel = Duel::armed(sniper);
    duel.out_in_the_open(distance);
    let head = duel.position(duel.victim) + Vec3::new(0.0, (HEAD_BOTTOM + PLAYER_HALF_EXTENTS.y) / 2.0, 0.0);
    duel.fire_at(head);
    duel.steps(seconds(arrives));
    assert_eq!(
        duel.health(duel.victim),
        MAX_HEALTH - Weapon::Sniper.damage(HitRegion::Body, distance),
        "a round aimed at a head 300 m away should land in the body"
    );
    assert_eq!(duel.stats(duel.shooter).headshots, 0);

    // Held over by the drop, it is the head, and with this gun that is all.
    let mut duel = Duel::armed(sniper);
    duel.out_in_the_open(distance);
    duel.fire_at(head + Vec3::new(0.0, drop, 0.0));
    duel.steps(seconds(arrives));
    assert!(!duel.alive(duel.victim), "held over, the round found the head");
    assert_eq!(duel.stats(duel.shooter).headshots, 1);
}

#[test]
fn a_running_target_has_to_be_led() {
    let distance = 300.0;
    let (drop, arrives) = flight_to(Weapon::Rifle, distance);
    let run = |lead: bool| {
        let mut duel = Duel::new();
        duel.out_in_the_open(distance);
        // Up to speed across the line of fire.
        let chest = duel.position(duel.victim);
        for _ in 0..20 {
            duel.strafe_tick(1.0, 0, chest);
        }
        let speed = duel.body(duel.victim).state.velocity;
        assert!(speed.length() > 7.0, "test setup: running at {speed:?}");
        // The round's clock starts where the shooter's screen was, and the
        // target is where it really is when the round gets there: led by
        // its speed times what is left of the flight once the round has
        // caught up with now.
        let behind = (duel.lobby.matches[&duel.match_id].rounds.len(), ());
        assert_eq!(behind.0, 0);
        let caught_up = 7.0 * TICK_DT;
        let aim = duel.position(duel.victim)
            + Vec3::new(0.0, drop, 0.0)
            + if lead { speed * (arrives - caught_up) } else { Vec3::ZERO };
        duel.strafe_tick(1.0, Buttons::FIRE, aim);
        for _ in 0..seconds(arrives) {
            duel.strafe_tick(1.0, 0, aim);
        }
        duel.health(duel.victim)
    };
    assert_eq!(run(false), MAX_HEALTH, "a running target shot where it stood was missed");
    assert!(run(true) < MAX_HEALTH, "led by its run, it was hit");
}

#[test]
fn damage_falls_off_with_range_and_never_for_the_sniper() {
    for (weapon, distance) in [
        (Weapon::Rifle, 75.0),
        (Weapon::Rifle, 150.0),
        (Weapon::Smg, 20.0),
        (Weapon::Smg, 60.0),
        (Weapon::Sniper, 250.0),
    ] {
        let mut duel = Duel::armed(Loadout {
            primary: weapon,
            optic: weapon.default_optic(),
        });
        duel.out_in_the_open(distance);
        let (drop, arrives) = flight_to(weapon, distance);
        let chest = duel.position(duel.victim) + Vec3::new(0.0, drop, 0.0);
        duel.fire_at(chest);
        duel.steps(seconds(arrives) + 2);
        assert_eq!(
            duel.health(duel.victim),
            MAX_HEALTH - weapon.damage(HitRegion::Body, distance),
            "{weapon:?} at {distance} m"
        );
    }
    assert!(Weapon::Rifle.damage(HitRegion::Body, 150.0) < Weapon::Rifle.damage(HitRegion::Body, 10.0));
}

#[test]
fn one_sniper_round_to_the_head_kills_and_the_feed_says_which_gun() {
    let mut duel = Duel::armed(Loadout {
        primary: Weapon::Sniper,
        optic: Optic::X3,
    });
    let head = duel.position(duel.victim) + Vec3::new(0.0, HEAD_BOTTOM + 0.1, 0.0);
    let _ = drain(&mut duel.victim_rx);
    duel.fire_at(head);
    assert!(!duel.alive(duel.victim), "one round to the head");
    let cause = drain(&mut duel.victim_rx).into_iter().find_map(|m| match m {
        ServerMsg::Killed { cause, headshot, .. } => Some((cause, headshot)),
        _ => None,
    });
    assert_eq!(cause, Some((DeathCause::Sniper, true)));
}

#[test]
fn a_round_that_meets_nothing_is_spent_at_its_range() {
    let mut duel = Duel::new();
    duel.out_in_the_open(50.0);
    // Out over the empty ground, a little up, past the victim's side.
    let away = duel.body(duel.shooter).state.eye_position() + Vec3::new(30.0, 2.0, -100.0);
    let _ = duel.shooter_saw();
    duel.press(Buttons::SIDEARM, away);
    duel.steps(seconds(0.5));
    duel.press(Buttons::SIDEARM | Buttons::FIRE, away);
    duel.steps(seconds(1.0));
    let landed = duel.shooter_saw().into_iter().find_map(|m| match m {
        ServerMsg::ShotLanded { landing, .. } => Some(landing),
        ServerMsg::ShotFired {
            landed: Some(landing),
            ..
        } => Some(landing),
        _ => None,
    });
    let landing = landed.expect("the pistol round came down somewhere");
    assert!(!landing.hit_player);
    if !landing.struck {
        // Out of range in the open: as far as a pistol round goes.
        let gone = (landing.at - Vec3::new(0.0, 0.0, 0.0)).length();
        assert!(gone > Weapon::Pistol.stats().range * 0.9, "spent at {gone} m");
    }
    assert!(duel.lobby.matches[&duel.match_id].rounds.is_empty());
    assert_eq!(duel.health(duel.victim), MAX_HEALTH);
}

#[test]
fn the_loadout_is_the_one_queued_with_as_the_game_allows_it() {
    let mut lobby = free_play();
    let (tx, mut rx) = mpsc::channel(4096);
    let (joined, session) = join(&mut lobby, "Choosy", None, tx);
    let player = joined.player_id;
    // An SMG cannot carry a 4x: it gets its own red dot.
    queue_armed(&mut lobby, player, session, 1, Loadout {
        primary: Weapon::Smg,
        optic: Optic::X4,
    });
    // Asking again in line changes it and keeps the place.
    queue_armed(&mut lobby, player, session, 1, Loadout {
        primary: Weapon::Lmg,
        optic: Optic::X3,
    });
    run_matchmaker(&mut lobby);
    let match_id = lobby.match_of(player).expect("in a match");
    let wanted = Loadout {
        primary: Weapon::Lmg,
        optic: Optic::X3,
    };
    assert_eq!(lobby.matches[&match_id].bodies[&player].arms.loadout, wanted);
    let told = drain(&mut rx).into_iter().find_map(|m| match m {
        ServerMsg::MatchStarted { loadout, .. } => Some(loadout),
        _ => None,
    });
    assert_eq!(told, Some(wanted), "the match says what it settled on");
    let arms = lobby.matches[&match_id].bodies[&player].arms;
    assert_eq!(arms.rounds(), Weapon::Lmg.stats().magazine);
    assert_eq!(arms.spare(), Weapon::Pistol.stats().magazine);

    // And a pistol as a primary is the rifle.
    assert_eq!(
        Loadout {
            primary: Weapon::Pistol,
            optic: Optic::Irons,
        }
        .sanitized()
        .primary,
        Weapon::Rifle
    );
}

#[test]
fn everybody_sees_the_gun_in_hand_and_its_owner_sees_both_magazines() {
    let mut duel = Duel::armed(Loadout {
        primary: Weapon::Sniper,
        optic: Optic::X3,
    });
    let sky = duel.body(duel.shooter).state.eye_position() + Vec3::new(0.0, 50.0, -1.0);
    let seen = |duel: &mut Duel| {
        let _ = drain(&mut duel.victim_rx);
        duel.lobby.broadcast_snapshot(duel.match_id);
        drain(&mut duel.victim_rx)
            .into_iter()
            .rev()
            .find_map(|m| match m {
                ServerMsg::Snapshot { players, .. } => Some(players),
                _ => None,
            })
            .expect("a snapshot")
            .into_iter()
            .find(|p| p.id == duel.shooter)
            .expect("the shooter in it")
    };
    let before = seen(&mut duel);
    assert_eq!((before.weapon, before.optic), (Weapon::Sniper, Optic::X3));

    duel.press(Buttons::SIDEARM, sky);
    let after = seen(&mut duel);
    assert_eq!(after.weapon, Weapon::Pistol, "the pistol is seen in hand");

    let _ = duel.shooter_saw();
    duel.lobby.broadcast_snapshot(duel.match_id);
    let own = duel.shooter_saw().into_iter().rev().find_map(|m| match m {
        ServerMsg::Snapshot {
            weapon,
            ammo,
            spare_ammo,
            switch_ms,
            ..
        } => Some((weapon, ammo, spare_ammo, switch_ms)),
        _ => None,
    });
    let (weapon, ammo, spare, switch_ms) = own.expect("the shooter's own snapshot");
    assert_eq!(weapon, Weapon::Pistol);
    assert_eq!(ammo, Weapon::Pistol.stats().magazine);
    assert_eq!(spare, Weapon::Sniper.stats().magazine);
    assert!(switch_ms > 0 && switch_ms <= 350, "drawing for {switch_ms} ms");
}

#[test]
fn a_late_packet_leaves_the_gun_in_hand() {
    let mut duel = Duel::new();
    let sky = duel.body(duel.shooter).state.eye_position() + Vec3::new(0.0, 50.0, -1.0);
    for _ in 0..seconds(0.5) {
        duel.press(Buttons::SIDEARM, sky);
    }
    assert_eq!(duel.body(duel.shooter).arms.held, Slot::Sidearm);
    // Nothing from the shooter for a while: the body runs on a guess, and a
    // guess that forgot the pistol would put the rifle back in their hands
    // and cost them its draw when the packets came.
    duel.steps(10);
    assert!(duel.body(duel.shooter).guess.is_some(), "test setup: guessing");
    assert_eq!(duel.body(duel.shooter).arms.held, Slot::Sidearm);
    assert!(duel.body(duel.shooter).arms.ready(duel.lobby.tick));
}

#[test]
fn the_warm_up_lets_everybody_change_guns_and_fire_none_of_them() {
    let (mut lobby, match_id, player, session, _rx) = warming_up();
    for seq in 1..20 {
        lobby.handle(GameCommand::Inputs {
            player_id: player,
            session_id: session,
            commands: vec![InputCommand {
                seq,
                forward: 0.0,
                right: 0.0,
                yaw: 0.0,
                pitch: 0.0,
                buttons: Buttons(Buttons::SIDEARM | Buttons::FIRE),
            }],
        });
        lobby.step();
    }
    let body = &lobby.matches[&match_id].bodies[&player];
    assert!(lobby.matches[&match_id].warming_up(lobby.tick));
    assert_eq!(body.arms.held, Slot::Sidearm, "the pistol may come out");
    assert_eq!(body.stats.shots_fired, 0, "and may not be fired");
}
