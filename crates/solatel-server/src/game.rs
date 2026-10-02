//! The lobby, the matches it runs, and everything that decides an outcome.
//!
//! # Shape
//!
//! One process holds one [`Lobby`]. The lobby owns every connection and every
//! match, and matches come and go underneath it:
//!
//! ```text
//!   Lobby
//!     connections : PlayerId -> Connection   (who is here, and where)
//!     matches     : MatchId  -> Match        (several, at once)
//! ```
//!
//! A [`Connection`] is a person: their socket, their name, their wallet, the
//! token that gets their body back. Who that person *is* is decided before
//! they get here - an account key is resolved to a [`PlayerId`] by
//! `account.rs` - and the lobby only ever sees the id. A [`Body`] is that person inside one
//! match: where they are standing, what they have hit, what they have won.
//! The split is what lets a player be eliminated from one match and be
//! standing in another a second later without any of their identity being
//! rebuilt.
//!
//! # Why one process rather than one process per match
//!
//! The industry answer at scale is a matchmaker that allocates a dedicated
//! server per match - Agones, GameLift and Open Match all describe that
//! shape. It is the right answer when matches outgrow a machine, and the
//! wrong one here, for a specific reason: **the escrow sweep assumes one
//! process owns the escrow account**. A second process pointing at this
//! database would settle the first one's live stakes out from under it, and
//! those are real money being played for. Keeping every match in one process
//! keeps that assumption true. Splitting later means giving each server its
//! own escrow account, or a lease on that sweep, and that is the work to do
//! first rather than afterwards.
//!
//! Nothing else about this is load bearing. A match is a `HashMap` of bodies
//! and a tick; hundreds fit in one process long before the simulation is what
//! runs out.
//!
//! # Matchmaking
//!
//! Queue, form, charge, start - the sequence PlayFab and Open Match both
//! describe, with the money put where it has to go.
//!
//! 1. A player asks for a **table** by its stake. They are in line, and
//!    nothing has been charged.
//! 2. Every [`MATCHMAKE_INTERVAL`] the lobby looks at each line and decides
//!    whether to form a match: full, or enough to start, or not enough but
//!    waiting too long. That last case is what Fortnite does with a player
//!    target and a fifteen second fallback, and it is the difference between
//!    a quiet server and one that looks broken.
//! 3. The entry fee is charged **at formation**, not on queueing, so a line
//!    that never fills costs nobody anything.
//! 4. Everyone who paid is scattered across the map and the match starts.
//!
//! A player killed in a match is back in the lobby immediately and may queue
//! again at once. They do not wait for the match they died in to finish -
//! that is the whole reason for running several.

use solatel_protocol::{
    Stakes,
    ids::{MatchId, PlayerId, ResumeToken, SessionId, WithdrawalId},
    net::{
        DeathCause, GrenadeSnapshot, INTERPOLATION_DELAY_MS, MAX_INPUTS_PER_MESSAGE,
        MAX_LAG_COMPENSATION_MS, PlayerSnapshot, SNAPSHOT_HZ, ScoreEntry, ServerMsg, TICK_DT,
        TICK_HZ, TableStatus, Tier,
    },
    sim::{
        Buttons, GRENADE_FUSE, GRENADES_PER_LIFE, HitRegion, InputCommand, KILL_CREDIT_SECONDS,
        MAGAZINE, MATCH_DURATION, MAX_HEALTH, PlayerState, REGEN_DELAY, REGEN_SECONDS,
        RELOAD_SECONDS, WEAPON_FIRE_INTERVAL, WEAPON_RANGE, Zone, grenade, hitscan, map, zone_at,
        zone_damage_per_second,
    },
};
use std::collections::{HashMap, HashSet, VecDeque};
use tokio::sync::{mpsc, oneshot};

/// Inputs a player may have waiting for the simulation.
///
/// Room for every command a stall the guess can make good leaves behind (see
/// [`GUESS_WINDOW_TICKS`]), which all arrive at once when it ends. It is not
/// how far behind a player may run: that is [`BACKLOG_LIMIT`].
const MAX_QUEUED_INPUTS: usize = GUESS_WINDOW_TICKS as usize + 8;

/// Commands that may wait while nothing is owed before the oldest are
/// dropped.
///
/// The server runs one command a tick, so a command that waits is lag: the
/// player's body is where they were that many ticks ago, for everybody else
/// and for their shots. A late command does not wait - it is run the tick it
/// arrives, over the guess made in its place - so a queue this deep only
/// forms behind a stall too long to make good, or from a client sending
/// faster than the server steps, and in both its oldest commands are for
/// ticks long gone. Dropping them keeps the player at the front of their own
/// input stream, at the price of a correction on their screen.
const BACKLOG_LIMIT: usize = 4;

/// Ticks a guess keeps moving a body on its owner's last input.
///
/// A quarter of a second. Short enough that a client which has gone away stops
/// moving almost at once, long enough that a single dropped packet does not
/// make somebody stutter.
const MAX_CARRY_FORWARD_TICKS: u32 = 16;

/// How long a guess can still be put right when the real commands arrive.
///
/// A body whose owner's next command is late is moved on a guess - their last
/// one again - so that everybody else sees them carry on rather than stop.
/// When the real commands come, the body goes back to where the owner's own
/// last command left it and runs them, every one, in the tick they arrive.
/// The owner's prediction was made from those commands and nothing else, so
/// it is then exactly right: a late packet costs them nothing on their own
/// screen. Running the late ones on top of the guess, as this did once, put
/// the body a step ahead of the owner for every tick guessed and left the
/// queue that much deeper for good - after one stall on a lossy link, a
/// correction on most snapshots and an eighth of a second of lag for the
/// rest of the match.
///
/// Half a second covers a lost packet on a TCP link - the retransmission
/// timer, a round trip, and a frame that hitched while it waited - on any
/// connection worth playing on: three eighths of a second did not, measured
/// with `client/lag.mjs`. A guess older than this stands, and the commands it
/// stood in for are dropped as history.
const GUESS_WINDOW_TICKS: u32 = 32;

/// One second of authoritative states, which is what lag compensation rewinds
/// through.
const HISTORY_TICKS: usize = TICK_HZ as usize;

const TICKS_PER_SNAPSHOT: u32 = TICK_HZ / SNAPSHOT_HZ;

/// The scoreboard goes out once a second. It changes a few times a minute and
/// costs a name plus six counters per player; at snapshot rate it would be
/// most of a kilobyte a second per client to say nothing had happened.
const TICKS_PER_SCOREBOARD: u32 = TICK_HZ;

/// How often the lobby looks at its lines and decides whether to form a
/// match. Twice a second: fast enough that a full queue starts at once, slow
/// enough to be free.
const MATCHMAKE_INTERVAL: u32 = TICK_HZ / 2;

/// How long a disconnected player's body stays in the world.
///
/// Their stake is still on the table for this long and their body is still
/// shootable, so pulling the cable is not an escape from a fight. Past it,
/// nobody won the stake and it comes back to them less the rake.
const RESUME_WINDOW: f32 = 45.0;

/// How long to wait before asking the ledger again for a player who could not
/// afford the last entry.
///
/// A client is an untrusted source of inputs, and one asking twice a second
/// is a balance query against the database twice a second. The answer cannot
/// change without the player doing something outside the match, so a slow
/// retry loses nothing.
const BROKE_RETRY: f32 = 10.0;

/// Fewest players a match is worth running.
///
/// Four. Below that a match is one or two people on a map built for twenty or
/// thirty, which is a long walk between fights and a poor way to spend a
/// dollar. Overridden by `SOLATEL_MATCH_FLOOR`, and a server being tested by
/// one person sets it to 1.
const MATCH_FLOOR: usize = 4;

/// How long a line waits before starting short of a full table.
///
/// Two minutes, measured from when the first person joined that line. A full
/// table does not wait at all - there is nothing left to gain and everybody
/// in it has something to lose - and a line still short of the floor keeps
/// waiting, because a match below it is not worth running.
///
/// The window is what stops a line forming a match the instant it is merely
/// *able* to. Without it, thirteen people arriving together were split into
/// a match of six and a match of seven, because the sixth tripped the
/// threshold while the other seven were still queueing. Twenty people in one
/// match is a better game than two thin ones.
///
/// Overridden by `SOLATEL_QUEUE_WAIT`, in seconds.
const QUEUE_WAIT: f32 = 120.0;

/// How long a match holds everybody on their spawn before it goes live,
/// counted from when everybody's map has loaded (see [`LOAD_WAIT`]).
///
/// Twenty seconds: Counter-Strike's freeze time is fifteen, and Conrad
/// asked for at least sixteen of countdown that a player actually sees. A
/// match that went live the instant its map finished loading would start
/// with whoever's machine loaded fastest already moving, and on a slow
/// connection a player's first sight of the map could be the shot that ends
/// their stake. So everybody is placed, frozen, and told how long: they may
/// look round and nothing else, and nobody can hurt anybody. The match clock
/// and the circle start when it ends. Overridden by `SOLATEL_WARMUP`, in
/// seconds.
pub const WARMUP: f32 = 20.0;

/// How long a started match waits for everybody's map to load before its
/// warm-up starts without the slowest.
///
/// The warm-up used to start with the match, and loading a map - what was
/// not cached, then building it and compiling its shaders - took most of it
/// on a slow machine: Conrad's countdown appeared at five. Each client now
/// says when its map is drawn (`ClientMsg::Loaded`) and the countdown waits
/// for the last of them, or for this, whichever is sooner, so one machine
/// that never finishes cannot hold everybody. Nobody who has dropped is
/// waited for. Overridden by `SOLATEL_LOAD_WAIT`, in seconds.
pub const LOAD_WAIT: f32 = 30.0;

/// Where a match's players stand together while it warms up, map by map:
/// the middle of a patch of open ground, picked from each map's collision as
/// the most open place there is - the yard's is the strip behind its south
/// fence where Conrad was put, and asked that everybody be put.
///
/// Gathered, players see that the match is full of people, and may walk and
/// jump among each other; nothing can be fired, thrown or reloaded, and
/// nothing can hurt anybody. The countdown's end puts each on their own
/// spawn (`disperse_if_live`), so where they wandered meanwhile buys nothing.
const GATHERINGS: [(&str, f32, f32); 3] = [
    ("arena", -10.2, 13.0),
    ("yard", -35.0, -114.5),
    ("facility", -89.2, 17.2),
];

/// Metres between players in a gathering: room to walk between, close
/// enough to be a crowd.
const GATHERING_SPACING: f32 = 1.6;

/// What the warm-up lets a body do.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Hold {
    /// Live: everything.
    Free,
    /// Together on the gathering ground: walk, jump, crouch and raise the
    /// rifle, and nothing that could hurt anybody.
    Gathered,
    /// On their own spawn, for a map with nowhere to gather: look round -
    /// along the sights too - and nothing else, or the warm-up would be a
    /// head start.
    Still,
}

/// Where up to `seats` players stand in `map`'s gathering, facing its
/// middle: a grid spiralling out from the gathering's centre, every place a
/// standing player fits without touching anything. Empty for a map that has
/// no gathering.
fn gathering_spots(map: &map::Map, seats: usize) -> Vec<map::Spawn> {
    use solatel_protocol::sim::{PLAYER_HALF_EXTENTS, collide::overlaps_any};
    let Some(&(_, x, z)) = GATHERINGS.iter().find(|(name, _, _)| *name == map.name) else {
        return Vec::new();
    };
    let yaw = x.atan2(z);
    let standing = solatel_protocol::glam::Vec3::new(0.0, 1.2, 0.0);
    let mut spots = Vec::new();
    for ring in 0_i32..12 {
        for i in -ring..=ring {
            for j in -ring..=ring {
                if i.abs().max(j.abs()) != ring {
                    continue;
                }
                let position = solatel_protocol::glam::Vec3::new(
                    x + i as f32 * GATHERING_SPACING,
                    standing.y,
                    z + j as f32 * GATHERING_SPACING,
                );
                let clear = !overlaps_any(position, PLAYER_HALF_EXTENTS, map);
                let floored = overlaps_any(
                    position - solatel_protocol::glam::Vec3::Y * 1.0,
                    PLAYER_HALF_EXTENTS,
                    map,
                );
                if clear && floored {
                    spots.push(map::Spawn { position, yaw });
                    if spots.len() >= seats {
                        return spots;
                    }
                }
            }
        }
    }
    spots
}

/// How long a forming match waits for its entry fees to land.
///
/// Every purchase is a database round trip, and against a database on the
/// other side of the internet that is seconds. Past this, the match starts
/// with whoever paid, or dissolves and hands the money back.
const FORMING_TIMEOUT: f32 = 30.0;

/// How long after one withdrawal request before another is taken.
///
/// Each is a ledger round trip, and a client is an untrusted source of
/// requests. Nobody withdraws twice in five seconds on purpose.
const WITHDRAW_COOLDOWN: f32 = 5.0;

/// What a displaced connection is told. The client matches on this and stops
/// reconnecting: with accounts, the displaced tab would otherwise sign in
/// again and take the player straight back, and two tabs would pass one
/// player between them every two seconds.
pub const TAKEN_OVER: &str = "this player was taken over by another connection";

/// What the connection layer needs back from a join.
pub struct JoinOutcome {
    pub player_id: PlayerId,
    pub resume_token: ResumeToken,
    /// Whether this took over an existing player rather than making one.
    pub resumed: bool,
}

pub enum GameCommand {
    /// A new connection, or one presenting a token for a player it left.
    Join {
        session_id: SessionId,
        /// Who the connection signed in as. `None` only in tests; a real
        /// connection always has one, even if it was made a moment ago.
        account: Option<PlayerId>,
        name: String,
        resume: Option<ResumeToken>,
        outbound: mpsc::Sender<ServerMsg>,
        reply: oneshot::Sender<JoinOutcome>,
    },
    /// The socket closed. The body is held, not removed - see
    /// [`RESUME_WINDOW`].
    Leave {
        player_id: PlayerId,
        session_id: SessionId,
    },
    /// Input for whichever match this player is currently in.
    Inputs {
        /// Which connection sent it. A superseded socket - one whose player
        /// has been taken over, whether or not it has noticed - cannot keep
        /// driving a body somebody else is now playing.
        session_id: SessionId,
        player_id: PlayerId,
        commands: Vec<InputCommand>,
    },
    /// Put this player in line for a table - one map at one stake.
    Queue {
        player_id: PlayerId,
        session_id: SessionId,
        map: String,
        tier_dollars: i64,
    },
    /// Take them back out of it. No money has moved, so nothing is returned.
    LeaveQueue {
        player_id: PlayerId,
        session_id: SessionId,
    },
    /// Their client has the match's map loaded and drawn. See [`LOAD_WAIT`].
    Loaded {
        player_id: PlayerId,
        session_id: SessionId,
        match_id: MatchId,
    },
    /// Take money out of the wallet, to a Solana address.
    Withdraw {
        player_id: PlayerId,
        session_id: SessionId,
        amount_micro_usd: i64,
        destination: String,
    },
    /// Measured from ping/pong, used to decide how far to rewind this
    /// player's shots. Reported by the server's own timing, not by the client.
    RttSample { player_id: PlayerId, rtt_ms: f32 },
    /// The ledger has taken a forming match's entry fees.
    ///
    /// Nobody is put on the map until this arrives naming them. Putting
    /// players in first and charging afterwards would leave a window in which
    /// somebody can be shot while occupying a place nobody has paid for, and
    /// the kill would then settle against an escrow with nothing in it.
    ///
    /// One message for the whole match, because it was one transaction - see
    /// [`crate::ledger::LedgerRequest::BuyMatch`].
    MatchFunded {
        match_id: MatchId,
        /// Everybody whose stake is in escrow. Exactly these play.
        paid: Vec<PlayerId>,
        /// Everybody who was asked about, and what they have left.
        balances: Vec<(PlayerId, i64)>,
    },
    /// A player's wallet changed for a reason other than buying in: they were
    /// paid for a kill, or handed their stake back.
    BalanceChanged {
        player_id: PlayerId,
        balance_micro_usd: i64,
    },
    /// A message for one player from somewhere other than the lobby - a
    /// pong, a deposit landing, a withdrawal moving on - that still travels
    /// through their outbound queue, so it stays ordered with respect to
    /// everything else they are sent.
    Tell {
        player_id: PlayerId,
        /// Boxed: a `Welcome`-sized message would make every command that
        /// size, and most are a few words.
        message: Box<ServerMsg>,
    },
}

#[derive(Clone)]
pub struct GameHandle {
    commands: mpsc::Sender<GameCommand>,
}

impl GameHandle {
    /// Sends a command to the lobby. Returns false if the task is gone.
    pub async fn send(&self, command: GameCommand) -> bool {
        self.commands.send(command).await.is_ok()
    }
}

/// What the server counted while resolving this player's shots.
///
/// Every field is a tally kept here, at the one place that decides outcomes.
/// None of it is reported by a client and none of it could be: a client that
/// could say how many of its shots landed could say all of them did, and
/// accuracy is a number people are paid against.
#[derive(Debug, Clone, Copy, Default)]
struct Stats {
    kills: u32,
    deaths: u32,
    /// Counted when the trigger is honoured, not when it is pulled. A client
    /// may send `fire` every tick; charging it for shots the fire rate
    /// refused would make holding the trigger look like terrible aim.
    shots_fired: u32,
    shots_hit: u32,
    headshots: u32,
    damage_dealt: u32,
    /// Hits that landed at the end of a flick. Never shown to anybody; it is
    /// one of the things `records` judges a player's record on.
    snap_hits: u32,
    /// First hits of an engagement whose target had come into sight within
    /// [`REACTION_WINDOW_MS`](crate::records::REACTION_WINDOW_MS) - and of
    /// those, how many landed under
    /// [`REACTION_QUICK_MS`](crate::records::REACTION_QUICK_MS) of it.
    reactions: u32,
    quick_reactions: u32,
}

/// Where a connected player is.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Whereabouts {
    /// In the lobby, not waiting for anything.
    Idle,
    /// In line for a table: one map at one stake, with the game time they
    /// joined it - which decides who gets into the next match, and when the
    /// line gives up waiting for itself to fill.
    ///
    /// A table is a map *and* a stake. The arena seats twenty and the yard
    /// thirty, and a player who wanted one is not served by being put in the
    /// other.
    Queued {
        map: &'static str,
        dollars: i64,
        since: f32,
    },
    /// In a match. Inputs route here and nowhere else.
    Playing(MatchId),
}

/// One connected player: the person, not the body.
///
/// Everything here outlives any particular match. A player eliminated from
/// one keeps their name, their wallet, their socket and their resume token,
/// and can be standing in another a second later without any of it being
/// rebuilt.
struct Connection {
    session_id: SessionId,
    /// The one token that will take this player back. Replaced every time it
    /// is spent, so a leaked token is worth nothing after its owner returns.
    resume_token: ResumeToken,
    /// Game time this connection dropped, if it has. `None` while somebody is
    /// actually playing.
    away_since: Option<f32>,
    /// Display only. Identity is the `PlayerId` this is stored under.
    name: String,
    at: Whereabouts,
    /// Last known balance, so the client can be shown its wallet and told why
    /// it cannot buy in.
    balance_micro_usd: i64,
    /// Game time before which this player will not be asked about again,
    /// because the last answer was that they cannot afford to play.
    broke_until: f32,
    /// Game time before which another withdrawal request is not taken.
    withdraw_after: f32,
    outbound: mpsc::Sender<ServerMsg>,
    rtt_ms: f32,
}

impl Connection {
    /// Drops messages rather than blocking when a client cannot keep up.
    fn send(&self, msg: ServerMsg) {
        if self.outbound.try_send(msg).is_err() {
            tracing::trace!(session = %self.session_id, "dropped a message to a slow client");
        }
    }
}

/// One player inside one match.
struct Body {
    stats: Stats,
    /// What they have won in this match, in micro-USD.
    ///
    /// Already in their balance - every kill settles as it happens - so this
    /// is a statement of where the money came from, not a promise of money to
    /// come. Nobody can take it off them by killing them.
    winnings_micro_usd: i64,
    state: PlayerState,
    /// Commands waiting to be run, each with the tick it arrived on - how
    /// long it waited is part of how far its shot is rewound.
    pending: VecDeque<(InputCommand, u32)>,
    /// Last command actually consumed by the simulation. Sent back to the
    /// client so it knows what to re-predict from.
    last_applied_seq: u32,
    /// Retained so a tick with no fresh input can continue the player's motion
    /// rather than stopping them dead on a single dropped packet.
    last_input: InputCommand,
    /// Game time of the last shot, for enforcing the fire rate.
    last_fire_at: f32,
    /// The body is being moved on a guess while its owner's commands are
    /// late. See [`GUESS_WINDOW_TICKS`].
    guess: Option<Guess>,
    /// Recent authoritative states, newest last, for lag compensation.
    history: VecDeque<(u32, PlayerState)>,
    /// False once their stake has left escrow, however it left.
    staked: bool,
    /// Rounds in the magazine, and when the reload under way finishes.
    ammo: u32,
    reload_until: Option<f32>,
    /// Grenades left this life.
    grenades: u32,
    /// Buttons of the last command consumed, so a throw happens on the
    /// press and not on every tick it is held.
    previous_buttons: Buttons,
    /// Game time of the last damage from anything, for regeneration.
    last_hurt_at: f32,
    /// Who last hurt them and when, for crediting a death that was not
    /// anybody's shot. See [`KILL_CREDIT_SECONDS`].
    last_attacker: Option<(PlayerId, f32)>,
    /// Fractions of a point of health, carried between ticks: the zone and
    /// regeneration both work in health per second and health is whole.
    zone_carry: f32,
    regen_carry: f32,
    /// The last engagement a reaction was measured for: who, and the tick
    /// they came into sight. Every shot of a burst would otherwise measure
    /// the same exposure again, a little later each time.
    last_reaction: Option<(PlayerId, u32)>,
    /// Their own spawn, where the match puts them when it goes live.
    spawn: map::Spawn,
    /// Where they were put to wait: the gathering, or their spawn. A fall in
    /// the warm-up puts them back here rather than ending anything.
    home: map::Spawn,
}

impl Body {
    fn new(state: PlayerState) -> Self {
        Self {
            stats: Stats::default(),
            winnings_micro_usd: 0,
            state,
            pending: VecDeque::new(),
            last_applied_seq: 0,
            last_input: idle_input(state),
            last_fire_at: f32::NEG_INFINITY,
            guess: None,
            history: VecDeque::with_capacity(HISTORY_TICKS),
            staked: true,
            ammo: MAGAZINE,
            reload_until: None,
            grenades: GRENADES_PER_LIFE,
            previous_buttons: Buttons::empty(),
            last_hurt_at: f32::NEG_INFINITY,
            last_attacker: None,
            zone_carry: 0.0,
            regen_carry: 0.0,
            last_reaction: None,
            spawn: map::Spawn {
                position: state.position,
                yaw: state.yaw,
            },
            home: map::Spawn {
                position: state.position,
                yaw: state.yaw,
            },
        }
    }

    /// The state to tell this body's owner they are in.
    ///
    /// While a guess stands in for commands still on their way, that is where
    /// the owner's own last command left them, not where the guess has taken
    /// them: their client replays everything it sent since that command, and
    /// replaying it on top of the guess would count the guessed ticks twice.
    /// Health is as it is now - a guessed body takes real damage.
    fn reported_state(&self) -> PlayerState {
        match self.guess {
            Some(guess) if guess.ticks <= GUESS_WINDOW_TICKS => PlayerState {
                health: self.state.health,
                ..guess.from
            },
            _ => self.state,
        }
    }

    /// This tick's commands for this body.
    ///
    /// Normally one: the next in line. When none has arrived, a guess - the
    /// last one again - so the body carries on for everybody watching. When
    /// commands arrive behind a guess, the guess is undone and every one of
    /// them is run now: one for each tick guessed and one for this. See
    /// [`GUESS_WINDOW_TICKS`]. That is never more commands than ticks: each
    /// tick runs one, or guesses and owes one, so no client can make a body
    /// move faster by holding its commands back and sending them together.
    #[allow(clippy::too_many_arguments)]
    fn advance(
        &mut self,
        id: PlayerId,
        tick: u32,
        hold: Hold,
        now: f32,
        ground: &map::Map,
        shots: &mut Vec<Shot>,
        throws: &mut Vec<(PlayerId, PlayerState)>,
    ) {
        if self.pending.is_empty() {
            self.guess_on(ground);
            return;
        }
        let mut owed = 1;
        match self.guess {
            Some(guess) if guess.ticks <= GUESS_WINDOW_TICKS => {
                owed += guess.ticks as usize;
                self.end_guess();
            }
            Some(guess) => {
                self.guess = None;
                // Gone too long to make good. The guess stands, and only the
                // newest command is run on it: the rest were for ticks long
                // gone, and running them one a tick would only be lag.
                tracing::debug!(player = %id, ticks = guess.ticks, waiting = self.pending.len(), "guess too old to put right");
                while self.pending.len() > 1 {
                    self.pending.pop_front();
                }
            }
            None => {
                if self.pending.len() > BACKLOG_LIMIT {
                    tracing::debug!(player = %id, waiting = self.pending.len(), "backlog dropped");
                }
                while self.pending.len() > BACKLOG_LIMIT {
                    self.pending.pop_front();
                }
            }
        }
        let run = owed.min(self.pending.len());
        for _ in 0..run {
            let Some((command, arrived)) = self.pending.pop_front() else {
                break;
            };
            let waited = tick.wrapping_sub(arrived);
            self.run_command(id, command, waited, hold, now, ground, shots, throws);
        }
        // Still short of this tick: guess the rest from here.
        for _ in run..owed {
            self.guess_on(ground);
        }
    }

    /// Ends a guess. Within the window the body goes back to where its
    /// owner's own last command left it - its position, motion, aim and
    /// crouch, not its health, because a guessed body takes real damage.
    /// Past the window the guess stands.
    fn end_guess(&mut self) {
        if let Some(guess) = self.guess.take()
            && guess.ticks <= GUESS_WINDOW_TICKS
        {
            self.state = PlayerState {
                health: self.state.health,
                ..guess.from
            };
            self.previous_buttons = guess.buttons;
        }
    }

    /// One of the owner's commands, exactly as their client predicted it.
    #[allow(clippy::too_many_arguments)]
    fn run_command(
        &mut self,
        id: PlayerId,
        mut command: InputCommand,
        waited: u32,
        hold: Hold,
        now: f32,
        ground: &map::Map,
        shots: &mut Vec<Shot>,
        throws: &mut Vec<(PlayerId, PlayerState)>,
    ) {
        match hold {
            Hold::Free => {}
            Hold::Gathered => {
                command.buttons =
                    Buttons(command.buttons.0 & (Buttons::JUMP | Buttons::CROUCH | Buttons::AIM));
            }
            Hold::Still => {
                // Looking round is allowed, and raising the rifle is looking.
                command.forward = 0.0;
                command.right = 0.0;
                command.buttons = Buttons(command.buttons.0 & Buttons::AIM);
            }
        }
        self.last_applied_seq = command.seq;
        self.last_input = command;
        solatel_protocol::sim::step_tick(&mut self.state, &command, ground);
        if command.buttons.fire() {
            // From where this command left them: when several are run in one
            // tick, each shot leaves from its own place.
            shots.push(Shot {
                shooter: id,
                command,
                origin: self.state.eye_position(),
                waited,
            });
        }
        // A throw is the press, not the holding of it.
        if command.buttons.throw() && !self.previous_buttons.throw() && self.grenades > 0 {
            throws.push((id, self.state));
        }
        if command.buttons.reload() && self.reload_until.is_none() && self.ammo < MAGAZINE {
            self.reload_until = Some(now + RELOAD_SECONDS);
        }
        self.previous_buttons = command.buttons;
    }

    /// One tick on a guess: the last command again, but never anything it
    /// fired, threw or reloaded - a late packet must not fire the gun - and
    /// without its movement once the silence looks less like a late packet
    /// than a client that has gone.
    fn guess_on(&mut self, ground: &map::Map) {
        let guess = self.guess.get_or_insert(Guess {
            from: self.state,
            buttons: self.previous_buttons,
            ticks: 0,
        });
        guess.ticks = guess.ticks.saturating_add(1);
        let mut carried = self.last_input;
        // A crouch is a posture, not an action: it is held, and a late
        // packet should not stand anybody up. Nor lower their rifle.
        let held = carried.buttons;
        carried.buttons = Buttons::empty();
        carried.buttons.set(Buttons::CROUCH, held.crouch());
        carried.buttons.set(Buttons::AIM, held.aim());
        if guess.ticks > MAX_CARRY_FORWARD_TICKS {
            carried.forward = 0.0;
            carried.right = 0.0;
        }
        solatel_protocol::sim::step_tick(&mut self.state, &carried, ground);
        self.previous_buttons = carried.buttons;
    }

    /// The state this body was in `rewind_ms` ago, as best the server
    /// recorded.
    fn state_at(&self, current_tick: u32, rewind_ms: f32) -> PlayerState {
        let rewind_ticks = (rewind_ms / (TICK_DT * 1000.0)).round() as u32;
        let target_tick = current_tick.saturating_sub(rewind_ticks);

        // History is ordered, so the newest entry at or before the target tick
        // is the one the shooter plausibly saw.
        self.history
            .iter()
            .rev()
            .find(|(tick, _)| *tick <= target_tick)
            .map(|(_, state)| *state)
            .unwrap_or(self.state)
    }
}

/// A body moved on a guess while its owner's commands are late: where their
/// own last command left it, and how many ticks have been guessed since.
#[derive(Clone, Copy, Debug)]
struct Guess {
    from: PlayerState,
    /// The buttons that command held, so a throw held across the gap is the
    /// same throw and not a second one.
    buttons: Buttons,
    ticks: u32,
}

/// A trigger pull to resolve once everybody has moved this tick.
#[derive(Clone, Copy, Debug)]
struct Shot {
    shooter: PlayerId,
    command: InputCommand,
    /// The shooter's eyes as this command left them.
    origin: solatel_protocol::glam::Vec3,
    /// Ticks the command waited on the server, counting the one it ran on.
    waited: u32,
}

/// One match: a map, a stake, a clock, and the bodies playing it.
struct Match {
    /// The ground this match is played on.
    ///
    /// Held rather than read from `map::active()`, because several matches
    /// run at once and they are not all on the same map. Every call into the
    /// simulation already takes the map as an argument - the global was only
    /// ever a convenience for a server that ran one match at a time.
    map: &'static map::Map,
    stakes: Stakes,
    /// The tick this match started running on. `None` while it is still
    /// forming - that is, while the entry fees are still being taken.
    started_tick: Option<u32>,
    /// Ticks of warm-up after `warm_from` before the match goes live.
    /// See [`WARMUP`].
    warmup_ticks: u32,
    /// The tick the warm-up's countdown began: when the last player in it
    /// had loaded the map, or `load_wait_ticks` after `started_tick`. `None`
    /// while it is still waiting for them. See [`LOAD_WAIT`].
    warm_from: Option<u32>,
    /// The longest the warm-up waits for anybody's map to load.
    load_wait_ticks: u32,
    /// Who has said their map is loaded and drawn.
    loaded: HashSet<PlayerId>,
    /// Where its players wait together until it goes live (see
    /// [`GATHERINGS`]), and whether they are there now. Empty, and never
    /// gathered, for a match with no warm-up.
    gathering: Vec<map::Spawn>,
    next_gathering: usize,
    gathered: bool,
    /// Game time after which a forming match stops waiting for money.
    forming_until: f32,
    /// Players whose entry fee is still in flight.
    awaiting: HashSet<PlayerId>,
    bodies: HashMap<PlayerId, Body>,
    /// Spawns for this match, shuffled at formation so that two matches on
    /// one map do not line everybody up identically.
    spawns: Vec<map::Spawn>,
    next_spawn: usize,
    /// Grenades thrown and not yet gone off.
    grenades: Vec<LiveGrenade>,
    next_grenade: u32,
    /// Everything this match is, as it is played, for a reviewer. In a cell
    /// because it is written from `to_match`, which everything that tells a
    /// match anything already goes through with a shared borrow.
    recorder: std::cell::RefCell<crate::replay::Recorder>,
}

/// A grenade in the air or on the ground, with its fuse burning.
struct LiveGrenade {
    id: u32,
    thrower: PlayerId,
    flight: grenade::Flight,
    goes_off_at: f32,
}

impl Match {
    /// Seconds since the match went live. Zero while forming and all
    /// through the warm-up, so the match clock and the circle both start
    /// when the players can first move.
    fn elapsed(&self, tick: u32) -> f32 {
        match self.warm_from {
            Some(start) => {
                tick.wrapping_sub(start).saturating_sub(self.warmup_ticks) as f32 * TICK_DT
            }
            None => 0.0,
        }
    }

    /// Whether everybody is still being held on their spawn: waiting for
    /// maps to load, or counting down.
    fn warming_up(&self, tick: u32) -> bool {
        self.running()
            && self
                .warm_from
                .is_none_or(|start| tick.wrapping_sub(start) < self.warmup_ticks)
    }

    /// Milliseconds of warm-up left, for the countdown the client shows: the
    /// whole of it, not counting, while maps are still loading.
    fn starts_in_ms(&self, tick: u32) -> u32 {
        let left = match self.warm_from {
            Some(start) => self.warmup_ticks.saturating_sub(tick.wrapping_sub(start)),
            None => self.warmup_ticks,
        };
        (left as f32 * TICK_DT * 1000.0).round() as u32
    }

    /// How many players the warm-up is still waiting on to load the map:
    /// in the match, connected, and not yet said so. Zero once it counts.
    fn loading(&self, connections: &HashMap<PlayerId, Connection>) -> u32 {
        if self.warm_from.is_some() || !self.running() {
            return 0;
        }
        self.bodies
            .keys()
            .filter(|id| !self.loaded.contains(id))
            .filter(|id| connections.get(id).is_some_and(|c| c.away_since.is_none()))
            .count() as u32
    }

    fn running(&self) -> bool {
        self.started_tick.is_some()
    }

    /// The circle players are held inside right now.
    fn zone(&self, tick: u32) -> Zone {
        zone_at(self.map.full_radius(), self.elapsed(tick))
    }

    /// What is still staked on this match, in micro-USD.
    ///
    /// Counted from the stakes that have not yet left escrow rather than from
    /// the number of players, because those two stop agreeing the first time
    /// somebody dies. The client formats this and never computes it.
    fn pot_micro_usd(&self) -> i64 {
        let live = self.bodies.values().filter(|b| b.staked).count() as i64;
        self.stakes.entry().micros().saturating_mul(live)
    }
}

/// One process, every match, everybody connected.
struct Lobby {
    /// Where money goes. `None` is free play: no charging, no payouts.
    /// `main` refuses to start without one unless free play is asked for
    /// explicitly, so this is never accidentally `None` in front of players.
    ledger: Option<crate::ledger::LedgerHandle>,
    /// What a withdrawal is judged against. `None` when the server has no
    /// chain configured, and every withdrawal is refused with a reason.
    wallet: Option<crate::wallet::Terms>,
    /// Where finished lives are written, for match history and the
    /// anti-cheat. `None` in free play, where there is no payout to guard.
    records: Option<crate::records::RecordsHandle>,
    /// The tables this server runs, cheapest first.
    tiers: Vec<Stakes>,
    /// Fewest players a match will start with. See [`MATCH_FLOOR`].
    floor: usize,
    /// How long a line waits before starting short of full. See
    /// [`QUEUE_WAIT`].
    wait: f32,
    /// Seconds a started match holds everybody still. See [`WARMUP`].
    warmup: f32,
    /// Seconds a started match waits for maps to load. See [`LOAD_WAIT`].
    load_wait: f32,
    connections: HashMap<PlayerId, Connection>,
    matches: HashMap<MatchId, Match>,
    tick: u32,
    /// State for the spawn shuffle. See [`Lobby::random`].
    seed: u64,
}

impl Lobby {
    fn new() -> Self {
        Self {
            ledger: None,
            wallet: None,
            records: None,
            tiers: vec![Stakes::DEFAULT],
            floor: MATCH_FLOOR,
            wait: QUEUE_WAIT,
            warmup: WARMUP,
            load_wait: LOAD_WAIT,
            connections: HashMap::new(),
            matches: HashMap::new(),
            tick: 0,
            seed: 0x2545_f491_4f6c_dd1d,
        }
    }

    fn game_time(&self) -> f32 {
        self.tick as f32 * TICK_DT
    }

    /// Xorshift64*, for shuffling spawns and nothing else.
    ///
    /// Deliberately not a dependency and deliberately not seeded from the
    /// clock. Nothing here decides an outcome - it decides which of several
    /// equally valid spawn points a player starts on - so what matters is
    /// only that it is cheap and that two matches formed on one tick do not
    /// come out identical.
    fn random(&mut self) -> u32 {
        self.seed ^= self.seed >> 12;
        self.seed ^= self.seed << 25;
        self.seed ^= self.seed >> 27;
        (self.seed.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 32) as u32
    }

    fn tier(&self, dollars: i64) -> Option<Stakes> {
        self.tiers.iter().copied().find(|s| s.dollars() == dollars)
    }

    // ---- who is where ---------------------------------------------------

    /// Everybody in line for a table, longest wait first.
    ///
    /// Longest first because the alternative is a player who has waited five
    /// minutes watching people who arrived after them get into matches.
    ///
    /// A player whose socket has dropped is not in the line, even though
    /// their place is held until the resume window closes. Placing them
    /// would charge an entry fee to somebody who is not there to play it,
    /// and take a seat from somebody who is. They keep their place: if they
    /// come back inside the window they are in line where they left off.
    fn queued_for(&self, map: &str, dollars: i64) -> Vec<(PlayerId, f32)> {
        let mut waiting: Vec<(PlayerId, f32)> = self
            .connections
            .iter()
            .filter(|(_, c)| c.away_since.is_none())
            .filter_map(|(id, c)| match c.at {
                Whereabouts::Queued {
                    map: m,
                    dollars: d,
                    since,
                } if d == dollars && m == map => Some((*id, since)),
                _ => None,
            })
            .collect();
        waiting.sort_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        waiting
    }

    /// Where a player's inputs should go, if anywhere.
    fn match_of(&self, player_id: PlayerId) -> Option<MatchId> {
        match self.connections.get(&player_id)?.at {
            Whereabouts::Playing(id) => Some(id),
            _ => None,
        }
    }

    // ---- money ----------------------------------------------------------

    /// Ask the ledger for a whole forming match's entry fees, and say
    /// whether anybody is listening.
    ///
    /// One request for the match rather than one per player. Charging player
    /// by player is the obvious shape and is the wrong one: every purchase is
    /// a database round trip, and thirteen in a row took longer than the
    /// match was willing to wait, so a thirteen player match started with six.
    ///
    /// In free play there is no ledger and the answer is "granted", which is
    /// what keeps the game runnable without a database behind it.
    fn request_entries(&mut self, match_id: MatchId, players: Vec<PlayerId>) -> bool {
        // The stake belongs to the match, not to the server: several tables
        // are running and these players are buying into one of them.
        let Some(stakes) = self.matches.get(&match_id).map(|m| m.stakes) else {
            return false;
        };
        match &self.ledger {
            Some(ledger) => {
                ledger.send(crate::ledger::LedgerRequest::BuyMatch {
                    match_id,
                    stakes,
                    players,
                });
                false
            }
            None => true,
        }
    }

    /// The stake a body holds, if there is anything of theirs in escrow.
    fn entry_of(&self, match_id: MatchId, player_id: PlayerId) -> Option<crate::ledger::EntryId> {
        let body = self.matches.get(&match_id)?.bodies.get(&player_id)?;
        body.staked.then_some(crate::ledger::EntryId {
            match_id,
            player_id,
        })
    }

    /// Take a stake out of escrow, exactly once, by whichever route.
    ///
    /// The `staked` flag is cleared here rather than when the ledger answers,
    /// because the answer comes back asynchronously and a second settlement
    /// raised meanwhile would be a second payout. The key would refuse it at
    /// the database, but asking is already wrong.
    fn settle_stake(
        &mut self,
        match_id: MatchId,
        player_id: PlayerId,
        route: impl FnOnce(crate::ledger::EntryId) -> crate::ledger::LedgerRequest,
    ) {
        let Some(entry) = self.entry_of(match_id, player_id) else {
            return;
        };
        let request = route(entry);
        if let Some(body) = self
            .matches
            .get_mut(&match_id)
            .and_then(|m| m.bodies.get_mut(&player_id))
        {
            body.staked = false;
        }
        self.record_life(match_id, player_id, &request);
        if let Some(ledger) = &self.ledger {
            ledger.send(request);
        }
    }

    /// Write a life into match history as its stake settles.
    ///
    /// Here, because this is the one place every life ends through - a kill,
    /// the whistle, a walk-away - and the moment its numbers stop changing.
    fn record_life(
        &self,
        match_id: MatchId,
        player_id: PlayerId,
        request: &crate::ledger::LedgerRequest,
    ) {
        use crate::ledger::LedgerRequest;
        use crate::records::{Counts, Life, Outcome};
        let Some(records) = &self.records else {
            return;
        };
        let outcome = match request {
            LedgerRequest::SettleKill { killer, .. } => Outcome::Killed { killer: *killer },
            LedgerRequest::AbandonEntry { .. } => Outcome::Abandoned,
            LedgerRequest::RefundEntry { .. } => Outcome::Survived,
            _ => return,
        };
        let Some(game) = self.matches.get(&match_id) else {
            return;
        };
        let Some(body) = game.bodies.get(&player_id) else {
            return;
        };
        let stats = body.stats;
        records.send(Life {
            match_id,
            player_id,
            map: game.map.name,
            stake: game.stakes.entry(),
            outcome,
            counts: Counts {
                kills: stats.kills,
                shots_fired: stats.shots_fired,
                shots_hit: stats.shots_hit,
                headshots: stats.headshots,
                damage_dealt: stats.damage_dealt,
                snap_hits: stats.snap_hits,
                reactions: stats.reactions,
                quick_reactions: stats.quick_reactions,
            },
            winnings: solatel_protocol::MicroUsd(body.winnings_micro_usd),
            alive_ms: (game.elapsed(self.tick) * 1000.0) as u32,
        });
    }

    // ---- matchmaking ----------------------------------------------------

    /// Look at every line and start whatever should start.
    fn matchmake(&mut self) {
        let now = self.game_time();

        // A table is a map and a stake, so every combination of the two has
        // its own line. Each is drained until it will not fill another match,
        // so a line of forty-five on a twenty seat map becomes three matches
        // on this pass rather than one every half second. Several matches at
        // one table run side by side; nothing about a match is exclusive to
        // the line it came from.
        for map in map::MAPS {
            for stakes in self.tiers.clone() {
                while self.form_one(map, stakes, now) {}
            }
        }
    }

    /// Form at most one match out of one table's line. Returns whether it did.
    ///
    /// Three outcomes, and no others:
    ///
    /// * the table is **full** - start at once,
    /// * the **window has run out** and there are at least [`Lobby::floor`]
    ///   people - start with whoever is there,
    /// * otherwise - keep waiting.
    fn form_one(&mut self, map: &'static map::Map, stakes: Stakes, now: f32) -> bool {
        let seats = map.max_players;
        let waiting = self.queued_for(map.name, stakes.dollars());
        if waiting.is_empty() {
            return false;
        }
        let waited = now - waiting[0].1;
        let take = if waiting.len() >= seats {
            // A full table. Nothing is gained by holding it, and everybody in
            // it has something to lose.
            seats
        } else if waiting.len() >= self.floor && waited >= self.wait {
            // The window is up and there are enough to play. Whoever is in
            // line goes in; whoever was not quick enough waits for the next.
            waiting.len()
        } else {
            // Either still gathering, or still short of the floor. A line
            // under the floor keeps waiting however long it has been there:
            // a match below it is a handful of people on a map built for
            // twenty, which is a long walk between fights.
            return false;
        };

        let chosen: Vec<PlayerId> = waiting.into_iter().take(take).map(|(id, _)| id).collect();
        self.form(map, stakes, chosen);
        true
    }

    /// Open a match and start charging the people who will be in it.
    fn form(&mut self, map: &'static map::Map, stakes: Stakes, players: Vec<PlayerId>) {
        let id = MatchId::new();
        let seats = players.len();

        // Drawn before the match exists, because the shuffle needs the
        // lobby's randomness and the match needs the shuffle.
        let draw: Vec<u32> = (0..map.spawns.len()).map(|_| self.random()).collect();
        let mut i = 0;
        let spawns = map.scatter(seats.max(1), || {
            let value = draw[i % draw.len()];
            i += 1;
            value
        });

        let gathering = if self.warmup > 0.0 {
            gathering_spots(map, seats.max(1))
        } else {
            Vec::new()
        };
        self.matches.insert(
            id,
            Match {
                map,
                stakes,
                started_tick: None,
                warmup_ticks: (self.warmup / TICK_DT).round() as u32,
                warm_from: None,
                load_wait_ticks: (self.load_wait / TICK_DT).round() as u32,
                loaded: HashSet::new(),
                gathered: !gathering.is_empty(),
                gathering,
                next_gathering: 0,
                forming_until: self.game_time() + FORMING_TIMEOUT,
                awaiting: players.iter().copied().collect(),
                bodies: HashMap::new(),
                spawns,
                next_spawn: 0,
                grenades: Vec::new(),
                next_grenade: 0,
                recorder: Default::default(),
            },
        );
        tracing::info!(
            match_id = %id, map = map.name, stake = %stakes.entry(), players = seats,
            "match forming"
        );
        let names: Vec<(PlayerId, String)> =
            players.iter().map(|p| (*p, self.name_of(*p))).collect();
        if let Some(game) = self.matches.get(&id) {
            let mut recorder = game.recorder.borrow_mut();
            for (player, name) in names {
                recorder.introduce(player, name);
            }
        }

        let found = ServerMsg::MatchFound {
            match_id: id,
            map_name: map.name.to_string(),
            tier: tier_of(stakes),
            players: seats as u32,
        };
        for player_id in &players {
            // Out of the queue and into this match before the money moves, so
            // the next pass over the lines cannot place them twice.
            if let Some(connection) = self.connections.get_mut(player_id) {
                connection.at = Whereabouts::Playing(id);
                connection.send(found.clone());
            }
        }
        if self.request_entries(id, players.clone()) {
            for player_id in players {
                self.admit(player_id, id);
            }
        }
        self.broadcast_lobby();
    }

    /// Put a paid player into a match.
    fn admit(&mut self, player_id: PlayerId, match_id: MatchId) {
        let Some(game) = self.matches.get_mut(&match_id) else {
            return;
        };
        let spawn = game.spawns[game.next_spawn % game.spawns.len()];
        game.next_spawn += 1;
        // Gathered with everybody else for the warm-up, when there is one;
        // on their own spawn when the match goes live.
        let home = if game.gathered && !game.gathering.is_empty() {
            let spot = game.gathering[game.next_gathering % game.gathering.len()];
            game.next_gathering += 1;
            spot
        } else {
            spawn
        };
        game.awaiting.remove(&player_id);
        let mut body = Body::new(PlayerState::spawned_at(home));
        body.spawn = spawn;
        body.home = home;
        game.bodies.insert(player_id, body);
        if let Some(connection) = self.connections.get_mut(&player_id) {
            connection.at = Whereabouts::Playing(match_id);
        }
    }

    /// A player who was going to be in a match is not, after all.
    fn withdraw(&mut self, player_id: PlayerId, match_id: MatchId) {
        if let Some(game) = self.matches.get_mut(&match_id) {
            game.awaiting.remove(&player_id);
            game.bodies.remove(&player_id);
        }
        if let Some(connection) = self.connections.get_mut(&player_id)
            && connection.at == Whereabouts::Playing(match_id)
        {
            connection.at = Whereabouts::Idle;
        }
    }

    /// Start a match that has finished collecting its entry fees, or dissolve
    /// it if too few paid.
    fn settle_formation(&mut self, match_id: MatchId) {
        let Some(game) = self.matches.get(&match_id) else {
            return;
        };
        let paid = game.bodies.len();

        if paid < self.floor {
            // Nobody has been shot at yet, so nobody has won anything: every
            // stake goes back whole rather than less the rake.
            let refunded: Vec<PlayerId> = game.bodies.keys().copied().collect();
            let stranded: Vec<PlayerId> = game.awaiting.iter().copied().collect();
            tracing::info!(match_id = %match_id, paid, "match dissolved; too few bought in");
            for player_id in refunded {
                self.settle_stake(match_id, player_id, |entry| {
                    crate::ledger::LedgerRequest::RefundEntry { entry }
                });
                self.withdraw(player_id, match_id);
            }
            for player_id in stranded {
                self.withdraw(player_id, match_id);
            }
            self.matches.remove(&match_id);
            self.broadcast_lobby();
            return;
        }

        let tick = self.tick;
        let Some(game) = self.matches.get_mut(&match_id) else {
            return;
        };
        game.started_tick = Some(tick);
        let stranded: Vec<PlayerId> = game.awaiting.drain().collect();
        let stakes = game.stakes;
        let bodies: Vec<PlayerId> = game.bodies.keys().copied().collect();
        tracing::info!(
            match_id = %match_id, players = paid, stake = %stakes.entry(), "match started"
        );

        for player_id in stranded {
            // Their money never landed in time, so they are not in this one.
            // If it lands later, `EntrySettled` hands it straight back.
            self.withdraw(player_id, match_id);
        }

        let Some(started) = self.match_started(match_id) else {
            return;
        };
        for player_id in bodies {
            if let Some(connection) = self.connections.get(&player_id) {
                connection.send(started.clone());
            }
        }
        self.broadcast_scoreboard(match_id);
        self.broadcast_lobby();
    }

    /// The match is over. Return what nobody won, and send everybody home.
    fn end_match(&mut self, match_id: MatchId) {
        let Some(game) = self.matches.get(&match_id) else {
            return;
        };
        let entries = self.score_entries(match_id);
        let players: Vec<PlayerId> = game.bodies.keys().copied().collect();
        let survivors: Vec<PlayerId> = game
            .bodies
            .iter()
            .filter(|(_, b)| b.state.is_alive() && b.staked)
            .map(|(id, _)| *id)
            .collect();
        tracing::info!(match_id = %match_id, survivors = survivors.len(), "match ended");

        // Anybody still standing kept their stake: nobody killed them, so
        // nobody won it. Every kill has already moved its own money.
        for player_id in survivors {
            self.settle_stake(match_id, player_id, |entry| {
                crate::ledger::LedgerRequest::RefundEntry { entry }
            });
        }

        for player_id in players {
            let winnings = self
                .matches
                .get(&match_id)
                .and_then(|m| m.bodies.get(&player_id))
                .map(|b| b.winnings_micro_usd)
                .unwrap_or(0);
            let Some(connection) = self.connections.get_mut(&player_id) else {
                continue;
            };
            // Only the people still in it. Somebody eliminated from this
            // match was told what they won at the time and may well be in
            // another one by now; a final board for a match they left would
            // arrive over the top of the one they are playing.
            if connection.at != Whereabouts::Playing(match_id) {
                continue;
            }
            connection.at = Whereabouts::Idle;
            connection.send(ServerMsg::MatchEnded {
                match_id,
                entries: entries.clone(),
                winnings_micro_usd: winnings,
            });
        }
        // The recording goes to be written. It is serialised there rather
        // than here, so the tick does not wait on a megabyte of JSON.
        if let Some(game) = self.matches.remove(&match_id)
            && let Some(records) = &self.records
        {
            let recorder = game.recorder.into_inner();
            if !recorder.is_empty() {
                let names = game
                    .bodies
                    .keys()
                    .map(|id| (*id, self.name_of(*id)))
                    .collect();
                records.send_replay(match_id, game.map.name, recorder, names);
            }
        }
        self.broadcast_lobby();
    }

    /// This player's match is over for them: killed, or fallen out of it.
    ///
    /// They are back in the lobby at once. There is no respawn and no reason
    /// to make them watch: they may queue again on the next tick, and with
    /// several matches running that is a new one within seconds.
    fn eliminate(&mut self, match_id: MatchId, player_id: PlayerId) {
        let winnings = self
            .matches
            .get(&match_id)
            .and_then(|m| m.bodies.get(&player_id))
            .map(|b| b.winnings_micro_usd)
            .unwrap_or(0);
        if let Some(connection) = self.connections.get_mut(&player_id) {
            if connection.at == Whereabouts::Playing(match_id) {
                connection.at = Whereabouts::Idle;
            }
            connection.send(ServerMsg::Eliminated {
                winnings_micro_usd: winnings,
            });
        }
        self.send_lobby(player_id);
    }
}

impl Lobby {
    fn handle(&mut self, command: GameCommand) {
        match command {
            GameCommand::Join {
                session_id,
                account,
                name,
                resume,
                outbound,
                reply,
            } => {
                // Who they are is settled: the connection layer signed them
                // in. What is left is whether they already have a place here
                // - a body in a match, a place in a line - and the resume
                // token and the account both say so. The token is honoured
                // only for the account it belongs to, so it cannot be used to
                // become somebody else.
                //
                // Either one wins whether or not the old connection has
                // noticed it is finished.
                //
                // Requiring the player to be marked away first looks safer
                // and is not: a socket can stay open for tens of seconds
                // after the far end has gone - a phone moving from wifi to
                // cellular is exactly this - so the owner reconnects, their
                // own token is refused because a dead socket still holds
                // their place, and they lose it. That is the failure this
                // whole mechanism exists to prevent.
                //
                // Two connections driving one player is prevented instead by
                // the session check on every command, which is where it
                // belongs: the old socket stops being able to move the body
                // the moment the new one takes it, rather than being trusted
                // to close first.
                let by_token = resume
                    .and_then(|token| {
                        self.connections
                            .iter()
                            .find(|(_, c)| c.resume_token == token)
                            .map(|(id, _)| *id)
                    })
                    .filter(|id| account.is_none_or(|a| a == *id));
                let by_account = account.filter(|id| self.connections.contains_key(id));
                let returning = by_token
                    .or(by_account)
                    .map(|id| (id, self.connections[&id].away_since.is_none()));

                if let Some((player_id, was_live)) = returning {
                    if was_live {
                        // Tell whoever is holding it why they are about to
                        // stop receiving anything.
                        if let Some(old) = self.connections.get(&player_id) {
                            old.send(ServerMsg::Rejected {
                                reason: TAKEN_OVER.to_string(),
                            });
                        }
                        tracing::info!(%player_id, "took over a live connection");
                    }
                    // Spent. A fresh one goes out with this welcome, so the
                    // token just used - which has been sitting in a browser,
                    // and may have been in a log or a screenshot - is dead.
                    let resume_token = ResumeToken::new();
                    let connection = self.connections.get_mut(&player_id).expect("just found");
                    connection.session_id = session_id;
                    connection.name = name;
                    connection.resume_token = resume_token;
                    connection.away_since = None;
                    connection.outbound = outbound;
                    tracing::info!(%player_id, %session_id, "player resumed");

                    // Their own input stream restarts from zero, so anything
                    // still queued from the old connection has to go or the
                    // sequence check would reject everything the new one
                    // sends.
                    if let Some(match_id) = self.match_of(player_id)
                        && let Some(body) = self
                            .matches
                            .get_mut(&match_id)
                            .and_then(|m| m.bodies.get_mut(&player_id))
                    {
                        body.pending.clear();
                        body.last_applied_seq = 0;
                        // The new connection starts from the next snapshot,
                        // with the body where the old one's commands left it.
                        body.end_guess();
                    }

                    let _ = reply.send(JoinOutcome {
                        player_id,
                        resume_token,
                        resumed: true,
                    });
                    // Back into the match they are in, if they are in one.
                    // After the reply, so it lands behind the `Welcome` the
                    // connection writes first.
                    if let Some(match_id) = self.match_of(player_id)
                        && let Some(started) = self.match_started(match_id)
                        && let Some(connection) = self.connections.get(&player_id)
                    {
                        connection.send(started);
                    }
                    // Asked again rather than repeated from memory. The new
                    // socket has been told nothing yet, the figure held here
                    // is only the last one this lobby saw, and a withdrawal
                    // in flight needs showing as well.
                    if let Some(ledger) = &self.ledger {
                        ledger.send(crate::ledger::LedgerRequest::ReadBalance { player_id });
                    }
                    self.send_lobby(player_id);
                    return;
                }

                let player_id = account.unwrap_or_default();
                let resume_token = ResumeToken::new();
                tracing::info!(%player_id, %session_id, %name, "player joined");
                self.connections.insert(
                    player_id,
                    Connection {
                        session_id,
                        resume_token,
                        away_since: None,
                        name,
                        at: Whereabouts::Idle,
                        balance_micro_usd: 0,
                        broke_until: f32::NEG_INFINITY,
                        withdraw_after: f32::NEG_INFINITY,
                        outbound,
                        rtt_ms: 0.0,
                    },
                );
                let _ = reply.send(JoinOutcome {
                    player_id,
                    resume_token,
                    resumed: false,
                });
                // Arriving puts nobody in a match and charges nobody. They
                // are in the lobby, looking at the tables, and it is their
                // decision which one to stand in line for.
                //
                // Their wallet is asked for, though: a menu that shows a dash
                // where the balance goes is a menu that cannot tell "you have
                // nothing" from "we have not looked".
                if let Some(ledger) = &self.ledger {
                    ledger.send(crate::ledger::LedgerRequest::ReadBalance { player_id });
                }
                self.send_lobby(player_id);
            }

            GameCommand::Leave {
                player_id,
                session_id,
            } => {
                // Marked away, not removed. A body in a match stays in the
                // world for `RESUME_WINDOW` - standing still, visible and
                // entirely shootable - so that closing the tab is not an
                // escape from a fight, and so that a player whose wifi
                // dropped gets their position and their record back.
                let now = self.game_time();
                let mut held = false;
                if let Some(connection) = self.connections.get_mut(&player_id)
                    && connection.session_id == session_id
                {
                    connection.away_since = Some(now);
                    held = true;
                }
                if !held {
                    return;
                }
                if let Some(match_id) = self.match_of(player_id)
                    && let Some(body) = self
                        .matches
                        .get_mut(&match_id)
                        .and_then(|m| m.bodies.get_mut(&player_id))
                {
                    // Whatever they were pressing, they are not pressing it
                    // now. `MAX_CARRY_FORWARD_TICKS` would stop them anyway a
                    // quarter of a second later; this stops them on the next
                    // tick, which is the difference between a body standing
                    // where it was and one that walked off a roof after its
                    // owner had gone - and a guess carrying them on since
                    // their last command is taken back for the same reason.
                    body.pending.clear();
                    body.end_guess();
                    body.last_input.forward = 0.0;
                    body.last_input.right = 0.0;
                    body.last_input.buttons = solatel_protocol::sim::Buttons::empty();
                }
                tracing::info!(%player_id, "player disconnected; place held");
                // Their stake is not settled here. They may still come back
                // and play the rest of it; it is settled when the window
                // closes, in the sweep in `step`.
                self.broadcast_lobby();
            }

            GameCommand::Inputs {
                player_id,
                session_id,
                commands,
            } => {
                let Some(connection) = self.connections.get(&player_id) else {
                    return;
                };
                if connection.session_id != session_id {
                    // A connection that no longer speaks for this player.
                    return;
                }
                let Whereabouts::Playing(match_id) = connection.at else {
                    // Input from somebody in the lobby. Not an error - a
                    // client keeps sending while it waits - and nothing to
                    // apply it to.
                    return;
                };
                let tick = self.tick;
                let Some(body) = self
                    .matches
                    .get_mut(&match_id)
                    .and_then(|m| m.bodies.get_mut(&player_id))
                else {
                    return;
                };

                for command in commands.into_iter().take(MAX_INPUTS_PER_MESSAGE) {
                    // Already consumed, or a duplicate from the client's
                    // resend window.
                    if command.seq <= body.last_applied_seq {
                        continue;
                    }
                    if body
                        .pending
                        .iter()
                        .any(|(queued, _)| queued.seq == command.seq)
                    {
                        continue;
                    }
                    body.pending.push_back((command.sanitized(), tick));
                }

                // Keep the queue ordered even if packets arrived out of order.
                body.pending.make_contiguous().sort_by_key(|(c, _)| c.seq);

                while body.pending.len() > MAX_QUEUED_INPUTS {
                    body.pending.pop_front();
                }
            }

            GameCommand::Queue {
                player_id,
                session_id,
                map,
                tier_dollars,
            } => {
                let now = self.game_time();
                // The name has to be one this build actually has, and the
                // `&'static str` is what gets stored: a queue keyed on a
                // string the client sent would be a queue keyed on whatever
                // the client felt like sending.
                let Some(ground) = map::MAPS.iter().find(|m| m.name == map) else {
                    return;
                };
                let Some(stakes) = self.tier(tier_dollars) else {
                    // A table this server does not run. Ignored rather than
                    // treated as an error: the client is choosing from a list
                    // the server gave it, and a stale list is not misconduct.
                    return;
                };
                let Some(connection) = self.connections.get_mut(&player_id) else {
                    return;
                };
                if connection.session_id != session_id {
                    return;
                }
                if matches!(connection.at, Whereabouts::Playing(_)) {
                    // One entry fee buys one life. Somebody already in a
                    // match - alive or dead - is not queueing for another
                    // until that one lets them go, which for the dead is
                    // immediately and for the living is the whistle.
                    return;
                }
                // Queueing again for the same table does not move them to
                // the back of their own line. A different map or a different
                // stake is a different line, and they join the end of it.
                let already = matches!(
                    connection.at,
                    Whereabouts::Queued { map: m, dollars, .. }
                        if dollars == tier_dollars && m == ground.name
                );
                if !already {
                    connection.at = Whereabouts::Queued {
                        map: ground.name,
                        dollars: tier_dollars,
                        since: now,
                    };
                    tracing::debug!(
                        %player_id, map = ground.name, stake = %stakes.entry(), "queued"
                    );
                }
                self.broadcast_lobby();
            }

            GameCommand::LeaveQueue {
                player_id,
                session_id,
            } => {
                if let Some(connection) = self.connections.get_mut(&player_id)
                    && connection.session_id == session_id
                    && matches!(connection.at, Whereabouts::Queued { .. })
                {
                    connection.at = Whereabouts::Idle;
                }
                self.broadcast_lobby();
            }

            GameCommand::Loaded {
                player_id,
                session_id,
                match_id,
            } => {
                // From the socket playing this match only: a late one from
                // the last match, or from a tab that has been taken over,
                // says nothing about this one.
                let current = self.connections.get(&player_id).is_some_and(|c| {
                    c.session_id == session_id && c.at == Whereabouts::Playing(match_id)
                });
                if current
                    && let Some(game) = self.matches.get_mut(&match_id)
                    && game.bodies.contains_key(&player_id)
                {
                    game.loaded.insert(player_id);
                }
            }

            GameCommand::Withdraw {
                player_id,
                session_id,
                amount_micro_usd,
                destination,
            } => {
                let now = self.game_time();
                let Some(connection) = self.connections.get_mut(&player_id) else {
                    return;
                };
                if connection.session_id != session_id {
                    return;
                }
                let refuse = |connection: &Connection, reason: String| {
                    connection.send(ServerMsg::WithdrawalRefused { reason });
                };
                let (Some(ledger), Some(terms)) = (&self.ledger, &self.wallet) else {
                    refuse(connection, "this server does not pay out".to_string());
                    return;
                };
                if now < connection.withdraw_after {
                    refuse(
                        connection,
                        "one withdrawal at a time - try again in a few seconds".to_string(),
                    );
                    return;
                }
                // Everything that does not need the database is decided
                // here, so the ledger only ever sees a request it has a
                // reason to process. The balance is the ledger's to check.
                match terms.quote(amount_micro_usd, &destination) {
                    Err(reason) => refuse(connection, reason),
                    Ok(quote) => {
                        connection.withdraw_after = now + WITHDRAW_COOLDOWN;
                        ledger.send(crate::ledger::LedgerRequest::Withdraw {
                            id: WithdrawalId::new(),
                            player_id,
                            quote,
                        });
                    }
                }
            }

            GameCommand::Tell { player_id, message } => {
                if let Some(connection) = self.connections.get(&player_id) {
                    connection.send(*message);
                }
            }

            GameCommand::MatchFunded {
                match_id,
                paid,
                balances,
            } => {
                // Everybody is told what they have, whether or not they got
                // in. A player who has just been charged and a player who has
                // just been refused both want to see their wallet.
                let now = self.game_time();
                for (player_id, balance_micro_usd) in balances {
                    if let Some(connection) = self.connections.get_mut(&player_id) {
                        connection.balance_micro_usd = balance_micro_usd;
                        let broke = !paid.contains(&player_id);
                        if broke {
                            connection.broke_until = now + BROKE_RETRY;
                        }
                        connection.send(ServerMsg::Funds {
                            balance_micro_usd,
                            insufficient: broke,
                        });
                    }
                }

                // Driven from who paid rather than from who the match is
                // still waiting for. The two are usually the same and are not
                // always: if the money took longer than `FORMING_TIMEOUT` the
                // match has already started without them, and walking
                // `awaiting` would then find nobody and quietly leave their
                // stakes sitting in escrow.
                let open = self
                    .matches
                    .get(&match_id)
                    .map(|m| !m.running())
                    .unwrap_or(false);

                for player_id in &paid {
                    let has_body = self
                        .matches
                        .get(&match_id)
                        .is_some_and(|m| m.bodies.contains_key(player_id));
                    if has_body {
                        continue;
                    }
                    if open {
                        self.admit(*player_id, match_id);
                    } else {
                        // Their money landed after the door closed, or the
                        // match is gone entirely. Either way they are not in
                        // it, and what they paid goes straight back - nobody
                        // won it.
                        tracing::info!(%player_id, %match_id, "entry landed too late; refunding");
                        if let Some(ledger) = &self.ledger {
                            ledger.send(crate::ledger::LedgerRequest::RefundEntry {
                                entry: crate::ledger::EntryId {
                                    match_id,
                                    player_id: *player_id,
                                },
                            });
                        }
                        self.withdraw(*player_id, match_id);
                        self.send_lobby(*player_id);
                    }
                }

                // And anybody who was asked about but did not pay is out of
                // this one and back in the lobby.
                let refused: Vec<PlayerId> = self
                    .matches
                    .get(&match_id)
                    .map(|m| {
                        m.awaiting
                            .iter()
                            .copied()
                            .filter(|id| !paid.contains(id))
                            .collect()
                    })
                    .unwrap_or_default();
                for player_id in refused {
                    tracing::info!(%player_id, "cannot afford this table; back to the lobby");
                    self.withdraw(player_id, match_id);
                    self.send_lobby(player_id);
                }
            }

            GameCommand::BalanceChanged {
                player_id,
                balance_micro_usd,
            } => {
                if let Some(connection) = self.connections.get_mut(&player_id) {
                    connection.balance_micro_usd = balance_micro_usd;
                    connection.send(ServerMsg::Funds {
                        balance_micro_usd,
                        insufficient: false,
                    });
                }
            }

            GameCommand::RttSample { player_id, rtt_ms } => {
                if let Some(connection) = self.connections.get_mut(&player_id) {
                    // Smoothed, so one delayed pong does not swing how far the
                    // next shot rewinds.
                    connection.rtt_ms = if connection.rtt_ms == 0.0 {
                        rtt_ms
                    } else {
                        connection.rtt_ms * 0.8 + rtt_ms * 0.2
                    };
                }
            }
        }
    }
}

impl Lobby {
    fn step(&mut self) {
        self.tick = self.tick.wrapping_add(1);
        let now = self.game_time();

        // 1. Every running match advances. Forming ones are waiting on money
        //    and have nobody to move yet.
        let running: Vec<MatchId> = self
            .matches
            .iter()
            .filter(|(_, m)| m.running())
            .map(|(id, _)| *id)
            .collect();
        for match_id in running {
            self.start_countdown_if_loaded(match_id);
            self.disperse_if_live(match_id);
            self.step_match(match_id, now);
        }

        // 2. Matches that have finished collecting their entry fees start, or
        //    dissolve. Checked every tick because it is a handful of matches
        //    and the answer is usually "still waiting".
        let deciding: Vec<MatchId> = self
            .matches
            .iter()
            .filter(|(_, m)| !m.running() && (m.awaiting.is_empty() || now >= m.forming_until))
            .map(|(id, _)| *id)
            .collect();
        for match_id in deciding {
            self.settle_formation(match_id);
        }

        // 3. Retire anybody whose window to come back has closed.
        //
        // Swept once a second rather than every tick: the cost of a place
        // being held for up to an extra second is nothing, and the cost of
        // walking the whole connection list sixty-four times a second to find
        // out that nobody has left is paid on every tick of every match.
        if self.tick.is_multiple_of(TICKS_PER_SCOREBOARD) {
            let gone: Vec<PlayerId> = self
                .connections
                .iter()
                .filter(|(_, c)| c.away_since.is_some_and(|at| now - at >= RESUME_WINDOW))
                .map(|(id, _)| *id)
                .collect();
            for player_id in gone {
                // Settled before the connection is dropped, because the
                // stake is keyed on their entry number and that goes with
                // them. A body still alive when the cable was pulled is a
                // stake nobody claimed. Anybody who shot it inside the window
                // claimed it properly and it settled as a kill; past the
                // window it comes back less the rake.
                if let Some(match_id) = self.match_of(player_id) {
                    self.settle_stake(match_id, player_id, |entry| {
                        crate::ledger::LedgerRequest::AbandonEntry { entry }
                    });
                    if let Some(body) = self
                        .matches
                        .get_mut(&match_id)
                        .and_then(|m| m.bodies.get_mut(&player_id))
                    {
                        body.state.health = 0;
                    }
                    self.broadcast_scoreboard(match_id);
                }
                self.connections.remove(&player_id);
                tracing::info!(player = %player_id, "resume window closed; player removed");
            }
            self.broadcast_lobby();
        }

        // 4. Form new matches out of the queues.
        if self.tick.is_multiple_of(MATCHMAKE_INTERVAL) {
            self.matchmake();
        }

        // 5. Broadcast.
        if self.tick.is_multiple_of(TICKS_PER_SNAPSHOT) {
            let live: Vec<MatchId> = self
                .matches
                .iter()
                .filter(|(_, m)| m.running())
                .map(|(id, _)| *id)
                .collect();
            for match_id in live {
                self.broadcast_snapshot(match_id);
            }
        }
        if self.tick.is_multiple_of(TICKS_PER_SCOREBOARD) {
            let live: Vec<MatchId> = self
                .matches
                .iter()
                .filter(|(_, m)| m.running())
                .map(|(id, _)| *id)
                .collect();
            for match_id in live {
                self.broadcast_scoreboard(match_id);
            }
        }
    }

    /// Starts a match's warm-up countdown once everybody in it has loaded
    /// the map, or the wait for them is over. See [`LOAD_WAIT`].
    fn start_countdown_if_loaded(&mut self, match_id: MatchId) {
        let tick = self.tick;
        let Some(game) = self.matches.get(&match_id) else {
            return;
        };
        if game.warm_from.is_some() {
            return;
        }
        let waiting = game.loading(&self.connections);
        let waited = game
            .started_tick
            .is_some_and(|start| tick.wrapping_sub(start) >= game.load_wait_ticks);
        if waiting > 0 && !waited {
            return;
        }
        if waiting > 0 {
            tracing::info!(%match_id, waiting, "warm-up started without everybody loaded");
        } else {
            tracing::debug!(%match_id, "everybody loaded; warm-up started");
        }
        if let Some(game) = self.matches.get_mut(&match_id) {
            game.warm_from = Some(tick);
        }
    }

    /// The countdown is over: everybody leaves the gathering for their own
    /// spawn, facing the way it faces, with nothing of the warm-up carried
    /// with them - no motion, no guess, no history for a shot to be rewound
    /// into.
    fn disperse_if_live(&mut self, match_id: MatchId) {
        let tick = self.tick;
        let Some(game) = self.matches.get_mut(&match_id) else {
            return;
        };
        if !game.gathered || game.warming_up(tick) {
            return;
        }
        game.gathered = false;
        for body in game.bodies.values_mut() {
            let health = body.state.health;
            body.state = PlayerState::spawned_at(body.spawn);
            body.state.health = health;
            body.home = body.spawn;
            body.guess = None;
            body.history.clear();
            body.last_input = idle_input(body.state);
        }
        tracing::debug!(%match_id, "live; everybody from the gathering to their spawn");
    }

    /// One tick of one match.
    fn step_match(&mut self, match_id: MatchId, now: f32) {
        let Some(game) = self.matches.get(&match_id) else {
            return;
        };
        // Read once, before anybody moves, so every player in this tick is
        // held to the same circle. Recomputing it per player would put the
        // wall in a slightly different place for whoever was stepped last.
        let zone = game.zone(self.tick);
        let burn = zone_damage_per_second(game.elapsed(self.tick));
        // Held on the spawn: the aim is theirs, nothing else is.
        let hold = if !game.warming_up(self.tick) {
            Hold::Free
        } else if game.gathered {
            Hold::Gathered
        } else {
            Hold::Still
        };
        let ground = game.map;
        let ids: Vec<PlayerId> = game.bodies.keys().copied().collect();
        let mut shots: Vec<Shot> = Vec::new();
        let mut fell: Vec<(PlayerId, DeathCause)> = Vec::new();
        let mut throws: Vec<(PlayerId, PlayerState)> = Vec::new();
        let tick = self.tick;

        {
            let Some(game) = self.matches.get_mut(&match_id) else {
                return;
            };
            for id in &ids {
                let Some(body) = game.bodies.get_mut(id) else {
                    continue;
                };
                if !body.state.is_alive() {
                    // Eliminated. Kept for the board, not stepped.
                    continue;
                }

                body.advance(*id, tick, hold, now, ground, &mut shots, &mut throws);

                if let Some(done) = body.reload_until
                    && now >= done
                {
                    body.ammo = MAGAZINE;
                    body.reload_until = None;
                }

                // The zone burns; out of it, health comes back on its own.
                if zone.excludes(body.state.position) {
                    body.regen_carry = 0.0;
                    body.zone_carry += burn * TICK_DT;
                    let whole = body.zone_carry.floor();
                    if whole >= 1.0 {
                        body.zone_carry -= whole;
                        body.state.health = body.state.health.saturating_sub(whole as i16);
                        body.last_hurt_at = now;
                        if !body.state.is_alive() {
                            body.state.health = 0;
                            body.stats.deaths = body.stats.deaths.saturating_add(1);
                            fell.push((*id, DeathCause::Zone));
                        }
                    }
                } else if body.state.health < MAX_HEALTH && now - body.last_hurt_at >= REGEN_DELAY {
                    body.regen_carry += f32::from(MAX_HEALTH) / REGEN_SECONDS * TICK_DT;
                    let whole = body.regen_carry.floor();
                    if whole >= 1.0 {
                        body.regen_carry -= whole;
                        body.state.health = (body.state.health + whole as i16).min(MAX_HEALTH);
                    }
                }

                // Falling out of the world is fatal, once the match is live.
                // Before it nothing is: a body that has found a way off the
                // gathering goes back to it.
                if hold != Hold::Free && body.state.position.y < -50.0 {
                    body.state = PlayerState::spawned_at(body.home);
                    body.guess = None;
                    body.history.clear();
                }
                // There is no killer to credit.
                if body.state.is_alive() && body.state.position.y < -50.0 {
                    body.state.health = 0;
                    body.stats.deaths = body.stats.deaths.saturating_add(1);
                    fell.push((*id, DeathCause::Fall));
                }

                body.history.push_back((tick, body.state));
                while body.history.len() > HISTORY_TICKS {
                    body.history.pop_front();
                }
            }
        }

        // A few times a second, everybody standing, for the recording.
        if crate::replay::Recorder::due(tick)
            && let Some(game) = self.matches.get(&match_id)
        {
            game.recorder.borrow_mut().sample(
                tick,
                game.bodies
                    .iter()
                    .filter(|(_, b)| b.state.is_alive())
                    .map(|(id, b)| crate::replay::Pose {
                        id: *id,
                        position: b.state.position,
                        yaw: b.state.yaw,
                        pitch: b.state.pitch,
                        health: b.state.health,
                    }),
            );
        }

        for (victim, cause) in fell {
            self.die_unshot(match_id, victim, cause, now);
        }
        for (thrower, from) in throws {
            self.throw(match_id, thrower, from, now);
        }
        self.step_grenades(match_id, now);

        // Shots are resolved after everyone has moved, so all players are at
        // the same point in time.
        for shot in shots {
            self.resolve_shot(match_id, shot, now);
        }

        // The clock, and the last player standing.
        //
        // A match runs its length unless it is already decided. With one life
        // each and no respawn, one player left alive has won: holding them on
        // an empty map for the rest of five minutes is not suspense, it is a
        // player waiting to be given their stake back. Matches that started
        // with one player - which only a test server does - have nothing to
        // decide and run their length.
        let over = self.matches.get(&match_id).is_some_and(|m| {
            let alive = m.bodies.values().filter(|b| b.state.is_alive()).count();
            m.elapsed(self.tick) >= MATCH_DURATION || (m.bodies.len() > 1 && alive <= 1)
        });
        if over {
            self.end_match(match_id);
        }
    }

    /// A death that was nobody's shot: the zone, a fall, their own grenade.
    ///
    /// Credited to whoever last hurt them if they did so within
    /// [`KILL_CREDIT_SECONDS`] - they get the kill and the stake, exactly as
    /// if the last shot had done it, so running into the zone or off a roof
    /// is no way out of a fight already lost. Otherwise nobody won the stake
    /// and it settles as a walk-away: the reward back, the rake to us.
    fn die_unshot(&mut self, match_id: MatchId, victim: PlayerId, cause: DeathCause, now: f32) {
        let credit = self
            .matches
            .get(&match_id)
            .and_then(|m| m.bodies.get(&victim))
            .and_then(|b| b.last_attacker)
            .filter(|(attacker, at)| *attacker != victim && now - at <= KILL_CREDIT_SECONDS)
            .map(|(attacker, _)| attacker);
        match credit {
            Some(killer) => self.credit_kill(match_id, killer, victim, cause),
            None => {
                let victim_name = self.name_of(victim);
                self.settle_stake(match_id, victim, |entry| {
                    crate::ledger::LedgerRequest::AbandonEntry { entry }
                });
                self.to_match(
                    match_id,
                    &ServerMsg::Killed {
                        victim,
                        victim_name,
                        killer: None,
                        killer_name: None,
                        headshot: false,
                        cause,
                    },
                );
                self.eliminate(match_id, victim);
                self.broadcast_scoreboard(match_id);
            }
        }
    }

    /// `killer` gets the kill: the count, the reward, and the victim's stake.
    /// The victim's health is already at zero.
    fn credit_kill(
        &mut self,
        match_id: MatchId,
        killer: PlayerId,
        victim: PlayerId,
        cause: DeathCause,
    ) {
        let reward = self
            .matches
            .get(&match_id)
            .map(|m| m.stakes.reward().micros())
            .unwrap_or(0);
        if let Some(body) = self
            .matches
            .get_mut(&match_id)
            .and_then(|m| m.bodies.get_mut(&killer))
        {
            body.stats.kills = body.stats.kills.saturating_add(1);
            body.winnings_micro_usd = body.winnings_micro_usd.saturating_add(reward);
        }
        tracing::info!(%killer, %victim, ?cause, "kill");
        self.settle_stake(match_id, victim, |entry| {
            crate::ledger::LedgerRequest::SettleKill { entry, killer }
        });
        let victim_name = self.name_of(victim);
        let killer_name = self.name_of(killer);
        self.to_match(
            match_id,
            &ServerMsg::Killed {
                victim,
                victim_name,
                killer: Some(killer),
                killer_name: Some(killer_name),
                headshot: false,
                cause,
            },
        );
        self.broadcast_scoreboard(match_id);
        self.eliminate(match_id, victim);
    }

    /// A grenade out of a player's hand, thrown from `from`: where the
    /// command that threw it left them.
    fn throw(&mut self, match_id: MatchId, thrower: PlayerId, from: PlayerState, now: f32) {
        let Some(game) = self.matches.get_mut(&match_id) else {
            return;
        };
        let Some(body) = game.bodies.get_mut(&thrower) else {
            return;
        };
        if !body.state.is_alive() || body.grenades == 0 {
            return;
        }
        body.grenades -= 1;
        let flight = grenade::Flight::thrown_by(&from);
        game.next_grenade = game.next_grenade.wrapping_add(1);
        let id = game.next_grenade;
        game.grenades.push(LiveGrenade {
            id,
            thrower,
            flight,
            goes_off_at: now + GRENADE_FUSE,
        });
    }

    /// Every grenade in a match, one tick on; any whose fuse has run, off.
    fn step_grenades(&mut self, match_id: MatchId, now: f32) {
        let Some(game) = self.matches.get_mut(&match_id) else {
            return;
        };
        let ground = game.map;
        let mut blasts = Vec::new();
        game.grenades.retain_mut(|live| {
            live.flight.step(ground, TICK_DT);
            if now >= live.goes_off_at {
                blasts.push((live.thrower, live.flight.position));
                false
            } else {
                true
            }
        });
        for (thrower, at) in blasts {
            self.explode(match_id, thrower, at, now);
        }
    }

    /// A blast: everybody in reach and in sight of it is hurt, and anybody
    /// it finishes is the thrower's kill - or, if it was their own grenade,
    /// a death credited to whoever last hurt them.
    fn explode(
        &mut self,
        match_id: MatchId,
        thrower: PlayerId,
        at: solatel_protocol::glam::Vec3,
        now: f32,
    ) {
        self.to_match(match_id, &ServerMsg::Exploded { at, thrower });
        let Some(game) = self.matches.get_mut(&match_id) else {
            return;
        };
        let ground = game.map;
        let mut hurt = Vec::new();
        for (id, body) in game.bodies.iter_mut() {
            let damage = grenade::blast_damage(at, &body.state, ground);
            if damage <= 0 {
                continue;
            }
            body.state.health = body.state.health.saturating_sub(damage).max(0);
            body.last_hurt_at = now;
            body.regen_carry = 0.0;
            if *id != thrower {
                body.last_attacker = Some((thrower, now));
            }
            let killed = !body.state.is_alive();
            if killed {
                body.stats.deaths = body.stats.deaths.saturating_add(1);
            }
            hurt.push((*id, damage, body.state.health, killed));
        }
        let mut dealt = 0u32;
        for (victim, damage, remaining, killed) in hurt {
            if victim != thrower {
                dealt = dealt.saturating_add(damage as u32);
                if let Some(connection) = self.connections.get(&victim) {
                    connection.send(ServerMsg::Damaged {
                        attacker: thrower,
                        amount: damage,
                        health_remaining: remaining,
                        region: HitRegion::Body,
                    });
                }
                if let Some(connection) = self.connections.get(&thrower) {
                    connection.send(ServerMsg::HitConfirmed {
                        victim,
                        amount: damage,
                        region: HitRegion::Body,
                        killed,
                    });
                }
            }
            if killed {
                if victim == thrower {
                    self.die_unshot(match_id, victim, DeathCause::Grenade, now);
                } else {
                    self.credit_kill(match_id, thrower, victim, DeathCause::Grenade);
                }
            }
        }
        if let Some(body) = self
            .matches
            .get_mut(&match_id)
            .and_then(|m| m.bodies.get_mut(&thrower))
        {
            body.stats.damage_dealt = body.stats.damage_dealt.saturating_add(dealt);
        }
    }

    fn resolve_shot(&mut self, match_id: MatchId, shot: Shot, now: f32) {
        let Shot {
            shooter: shooter_id,
            command,
            origin,
            waited,
        } = shot;
        let Some(game) = self.matches.get(&match_id) else {
            return;
        };
        let Some(shooter) = game.bodies.get(&shooter_id) else {
            return;
        };
        if !shooter.state.is_alive() {
            return;
        }

        // Rate limit. The client is free to send `fire` every tick; this is
        // what makes doing so no better than firing at the intended rate.
        if now - shooter.last_fire_at < WEAPON_FIRE_INTERVAL {
            return;
        }
        // Nothing to fire while a magazine is going in, and pulling the
        // trigger on an empty one starts putting one in.
        if shooter.reload_until.is_some() {
            return;
        }
        if shooter.ammo == 0 {
            if let Some(body) = self
                .matches
                .get_mut(&match_id)
                .and_then(|m| m.bodies.get_mut(&shooter_id))
            {
                body.reload_until = Some(now + RELOAD_SECONDS);
            }
            return;
        }

        // The look direction comes from the input command, not from the
        // shooter's stored state, so the shot matches the frame they fired on.
        let direction = solatel_protocol::sim::look_direction(command.yaw, command.pitch);
        // Was this the end of a flick: the aim a tenth of a second ago, from
        // the shooter's own history, against the aim of the shot. Counted
        // only if it hits, and only ever judged over many hits.
        let flicked = {
            let then = shooter.state_at(self.tick, crate::records::SNAP_WINDOW_SECONDS * 1000.0);
            let before = solatel_protocol::sim::look_direction(then.yaw, then.pitch);
            direction.dot(before).clamp(-1.0, 1.0).acos()
                > crate::records::SNAP_DEGREES.to_radians()
        };

        // Rewind everyone else to what this shooter could see when they
        // pulled the trigger. That is older than now by the whole round trip -
        // the snapshot they were looking at took half of it to reach them,
        // and the command took the other half to come back - plus however
        // long the command then waited here, plus the interpolation buffer
        // they render behind by. It used to be half the round trip and no
        // wait, which judged every shot against where its target was a few
        // tens of milliseconds after the shooter last saw it: a running
        // target a third of a metre on, and a shot at an edge a miss.
        let rtt_ms = self
            .connections
            .get(&shooter_id)
            .map(|c| c.rtt_ms)
            .unwrap_or(0.0);
        let rewind_ms = (rtt_ms + waited_ms(waited) + INTERPOLATION_DELAY_MS)
            .clamp(0.0, MAX_LAG_COMPENSATION_MS);

        let tick = self.tick;
        let rewound: Vec<(PlayerId, PlayerState)> = game
            .bodies
            .iter()
            .filter(|(id, _)| **id != shooter_id)
            .map(|(id, body)| (*id, body.state_at(tick, rewind_ms)))
            .collect();

        let hit = hitscan::trace(
            origin,
            direction,
            WEAPON_RANGE,
            game.map,
            rewound.iter().map(|(id, state)| (*id, state)),
        );

        let impact = hit
            .map(|h| h.point)
            .unwrap_or(origin + direction * WEAPON_RANGE);
        let victim = hit.and_then(|h| h.player);
        let region = hit.and_then(|h| h.region);
        // How long the target had been in this shooter's sight, judged on
        // the same rewound world the hit was. Only a hit is ever measured.
        let sighting = victim.and_then(|id| {
            let target = game.bodies.get(&id)?;
            exposure(shooter, target, tick, rewind_ms, game.map).map(|e| (id, e))
        });

        if let Some(shooter) = self
            .matches
            .get_mut(&match_id)
            .and_then(|m| m.bodies.get_mut(&shooter_id))
        {
            shooter.last_fire_at = now;
            shooter.ammo = shooter.ammo.saturating_sub(1);
            if shooter.ammo == 0 {
                shooter.reload_until = Some(now + RELOAD_SECONDS);
            }
            // Counted here, past the rate limit, so a client holding the
            // trigger down is not charged for the shots the weapon refused
            // to take. Accuracy should measure aim, not send rate.
            shooter.stats.shots_fired = shooter.stats.shots_fired.saturating_add(1);
        }

        // Tracer for everyone in this match, including the shooter.
        self.to_match(
            match_id,
            &ServerMsg::ShotFired {
                shooter: shooter_id,
                from: origin,
                to: impact,
                hit_player: victim.is_some(),
            },
        );

        let (Some(victim_id), Some(region)) = (victim, region) else {
            return;
        };

        let damage = region.damage();
        let reward = self
            .matches
            .get(&match_id)
            .map(|m| m.stakes.reward().micros())
            .unwrap_or(0);
        let mut killed = false;
        let mut landed = false;
        if let Some(victim) = self
            .matches
            .get_mut(&match_id)
            .and_then(|m| m.bodies.get_mut(&victim_id))
        {
            if !victim.state.is_alive() {
                return;
            }
            landed = true;
            victim.state.health = victim.state.health.saturating_sub(damage);
            victim.last_hurt_at = now;
            victim.regen_carry = 0.0;
            victim.last_attacker = Some((shooter_id, now));
            killed = !victim.state.is_alive();
            if killed {
                victim.stats.deaths = victim.stats.deaths.saturating_add(1);
            }
        }
        if landed && let Some(connection) = self.connections.get(&victim_id) {
            let health = self
                .matches
                .get(&match_id)
                .and_then(|m| m.bodies.get(&victim_id))
                .map(|b| b.state.health.max(0))
                .unwrap_or(0);
            connection.send(ServerMsg::Damaged {
                attacker: shooter_id,
                amount: damage,
                health_remaining: health,
                region,
            });
        }

        if !landed {
            return;
        }

        let victim_name = self.name_of(victim_id);
        let killer_name = self.name_of(shooter_id);

        if let Some(shooter) = self
            .matches
            .get_mut(&match_id)
            .and_then(|m| m.bodies.get_mut(&shooter_id))
        {
            shooter.stats.shots_hit = shooter.stats.shots_hit.saturating_add(1);
            shooter.stats.damage_dealt = shooter.stats.damage_dealt.saturating_add(damage as u32);
            if region == HitRegion::Head {
                shooter.stats.headshots = shooter.stats.headshots.saturating_add(1);
            }
            if flicked {
                shooter.stats.snap_hits = shooter.stats.snap_hits.saturating_add(1);
            }
            if let Some((target, Exposure { since_tick, ms })) = sighting {
                // One measurement an engagement: the first hit after the
                // target came into sight. The tick can wobble by one between
                // shots as the rewind rounds, which is still the same sighting.
                let measured = shooter
                    .last_reaction
                    .is_some_and(|(who, at)| who == target && at.abs_diff(since_tick) <= 2);
                if !measured {
                    shooter.last_reaction = Some((target, since_tick));
                    shooter.stats.reactions = shooter.stats.reactions.saturating_add(1);
                    if ms < crate::records::REACTION_QUICK_MS {
                        shooter.stats.quick_reactions =
                            shooter.stats.quick_reactions.saturating_add(1);
                    }
                }
            }
            if killed {
                shooter.stats.kills = shooter.stats.kills.saturating_add(1);
                // Theirs the moment it happens, and theirs to keep: the
                // ledger posts it now, so nobody can take it back off them
                // later by killing them.
                shooter.winnings_micro_usd = shooter.winnings_micro_usd.saturating_add(reward);
            }
        }
        // Only the shooter is told how much landed. Broadcasting it would
        // tell every other player in the match how hurt their opponents are,
        // which is information nobody earned.
        if let Some(connection) = self.connections.get(&shooter_id) {
            connection.send(ServerMsg::HitConfirmed {
                victim: victim_id,
                amount: damage,
                region,
                killed,
            });
        }

        if killed {
            tracing::info!(
                killer = %shooter_id, victim = %victim_id, ?region, "kill"
            );
            // The victim's *stake* leaves escrow here - the reward to the
            // killer and the rake to the platform - and nothing else does.
            // What the victim had already won is theirs, was posted to their
            // wallet as they won it, and is not on the table. Keyed on the
            // victim's entry, so a retry pays nobody twice.
            self.settle_stake(match_id, victim_id, |entry| {
                crate::ledger::LedgerRequest::SettleKill {
                    entry,
                    killer: shooter_id,
                }
            });
            self.to_match(
                match_id,
                &ServerMsg::Killed {
                    victim: victim_id,
                    victim_name,
                    killer: Some(shooter_id),
                    killer_name: Some(killer_name),
                    headshot: region == HitRegion::Head,
                    cause: DeathCause::Rifle,
                },
            );
            self.broadcast_scoreboard(match_id);
            self.eliminate(match_id, victim_id);
        }
    }
}

impl Lobby {
    // ---- talking to clients ---------------------------------------------

    fn tables(&self) -> Vec<TableStatus> {
        let now = self.game_time();
        let mut rows = Vec::new();
        for ground in map::MAPS {
            let seats = ground.max_players;
            for stakes in &self.tiers {
                let dollars = stakes.dollars();
                let waiting = self.queued_for(ground.name, dollars);
                let waited = waiting.first().map(|(_, since)| now - since).unwrap_or(0.0);
                rows.push(TableStatus {
                    map: ground.name.to_string(),
                    seats: seats as u32,
                    dollars,
                    waiting: waiting.len() as u32,
                    needed: self.floor as u32,
                    running: self
                        .matches
                        .values()
                        .filter(|m| {
                            m.running()
                                && m.stakes.dollars() == dollars
                                && m.map.name == ground.name
                        })
                        .count() as u32,
                    // A countdown only where one means something. A full
                    // table is not counting down, it is starting; and a line
                    // under the floor is not counting down to anything at
                    // all, so a clock on it would be a lie with a clock on
                    // it. The client says "waiting for more players" there.
                    forming_in_ms: if waiting.len() >= seats || waiting.len() < self.floor {
                        0
                    } else {
                        ((self.wait - waited).max(0.0) * 1000.0) as u32
                    },
                });
            }
        }
        rows
    }

    /// Where one player stands in the lobby, to that player.
    fn lobby_view(&self, player_id: PlayerId, tables: Vec<TableStatus>) -> Option<ServerMsg> {
        let connection = self.connections.get(&player_id)?;
        let (queued_map, queued_for, place) = match connection.at {
            Whereabouts::Queued { map, dollars, .. } => {
                let place = self
                    .queued_for(map, dollars)
                    .iter()
                    .position(|(id, _)| *id == player_id)
                    .map(|i| i as u32 + 1)
                    .unwrap_or(0);
                (Some(map.to_string()), Some(dollars), place)
            }
            _ => (None, None, 0),
        };
        Some(ServerMsg::Lobby {
            tables,
            queued_map,
            queued_for,
            place,
        })
    }

    /// What a player in a running match is told about it: which match, on
    /// which ground, at what stake.
    ///
    /// Sent when the match starts, and again to anybody who takes their
    /// player back while it is running. The second is not optional. A page
    /// that has just been reloaded knows nothing, not even the match or the
    /// map, and without this it discards every snapshot as a straggler from
    /// a match it is not in, and sits on the menu while its body stands in
    /// the match being shot at.
    fn match_started(&self, match_id: MatchId) -> Option<ServerMsg> {
        let game = self.matches.get(&match_id).filter(|m| m.running())?;
        Some(ServerMsg::MatchStarted {
            match_id,
            map_name: game.map.name.to_string(),
            tier: tier_of(game.stakes),
            duration_ms: (MATCH_DURATION * 1000.0) as u32,
            players: game.bodies.len() as u32,
            starts_in_ms: game.starts_in_ms(self.tick),
        })
    }

    fn send_lobby(&self, player_id: PlayerId) {
        let tables = self.tables();
        if let (Some(view), Some(connection)) = (
            self.lobby_view(player_id, tables),
            self.connections.get(&player_id),
        ) {
            connection.send(view);
        }
    }

    /// The lobby has changed for everybody who is looking at it.
    ///
    /// Players inside a match are skipped: they are not looking at the lobby,
    /// and a list of queues arriving twice a second behind their crosshair is
    /// bandwidth spent on a screen nobody has open.
    fn broadcast_lobby(&self) {
        let tables = self.tables();
        let watching: Vec<PlayerId> = self
            .connections
            .iter()
            .filter(|(_, c)| !matches!(c.at, Whereabouts::Playing(_)))
            .map(|(id, _)| *id)
            .collect();
        for player_id in watching {
            if let (Some(view), Some(connection)) = (
                self.lobby_view(player_id, tables.clone()),
                self.connections.get(&player_id),
            ) {
                connection.send(view);
            }
        }
    }

    fn name_of(&self, id: PlayerId) -> String {
        self.connections
            .get(&id)
            .map(|c| c.name.clone())
            .unwrap_or_else(|| "a ghost".to_string())
    }

    /// One match's board.
    ///
    /// Ordered by the server so every client shows the same thing in the same
    /// order: most kills first, then fewest deaths, then name. Leaving the
    /// sort to the client means two players watching one match disagree about
    /// who is winning whenever two of them are level.
    fn score_entries(&self, match_id: MatchId) -> Vec<ScoreEntry> {
        let Some(game) = self.matches.get(&match_id) else {
            return Vec::new();
        };
        let mut entries: Vec<ScoreEntry> = game
            .bodies
            .iter()
            .map(|(id, body)| ScoreEntry {
                id: *id,
                name: self.name_of(*id),
                kills: body.stats.kills,
                deaths: body.stats.deaths,
                shots_fired: body.stats.shots_fired,
                shots_hit: body.stats.shots_hit,
                headshots: body.stats.headshots,
                damage_dealt: body.stats.damage_dealt,
                alive: body.state.is_alive(),
                winnings_micro_usd: body.winnings_micro_usd,
            })
            .collect();
        entries.sort_by(|a, b| {
            b.kills
                .cmp(&a.kills)
                .then(a.deaths.cmp(&b.deaths))
                .then_with(|| a.name.cmp(&b.name))
        });
        entries
    }

    /// Send one message to everybody currently playing one match.
    fn to_match(&self, match_id: MatchId, msg: &ServerMsg) {
        let Some(game) = self.matches.get(&match_id) else {
            return;
        };
        // What the match is told is what the recording keeps.
        game.recorder.borrow_mut().heard(self.tick, msg);
        for id in game.bodies.keys() {
            if let Some(connection) = self.connections.get(id)
                && connection.at == Whereabouts::Playing(match_id)
            {
                connection.send(msg.clone());
            }
        }
    }

    fn broadcast_scoreboard(&self, match_id: MatchId) {
        let board = ServerMsg::Scoreboard {
            entries: self.score_entries(match_id),
        };
        self.to_match(match_id, &board);
    }

    fn broadcast_snapshot(&self, match_id: MatchId) {
        let Some(game) = self.matches.get(&match_id) else {
            return;
        };
        let zone = game.zone(self.tick);
        let remaining_ms = ((MATCH_DURATION - game.elapsed(self.tick)).max(0.0) * 1000.0) as u32;
        let starts_in_ms = game.starts_in_ms(self.tick);
        let loading = game.loading(&self.connections);
        let gathered = game.gathered;
        // Only the living are drawn. A body that has been eliminated is kept
        // for the board, not for the map: a corpse lying where somebody died
        // for the rest of the match is scenery nobody asked for.
        let players: Vec<PlayerSnapshot> = game
            .bodies
            .iter()
            .filter(|(_, body)| body.state.is_alive())
            .map(|(id, body)| PlayerSnapshot {
                id: *id,
                state: body.state,
                reloading: body.reload_until.is_some(),
                aiming: body.previous_buttons.aim(),
            })
            .collect();

        let server_time_ms = f64::from(self.tick) * f64::from(TICK_DT) * 1000.0;
        let pool = game.pot_micro_usd();
        let now = self.game_time();
        let live_grenades: Vec<GrenadeSnapshot> = game
            .grenades
            .iter()
            .map(|g| GrenadeSnapshot {
                id: g.id,
                position: g.flight.position,
            })
            .collect();

        for (id, body) in &game.bodies {
            let Some(connection) = self.connections.get(id) else {
                continue;
            };
            if connection.at != Whereabouts::Playing(match_id) {
                continue;
            }
            // Each client gets its own acknowledgement, so the payload differs
            // per recipient and cannot be a single shared broadcast. So does
            // their own entry while a guess stands in for their late commands:
            // everybody else sees the guess, and its owner where their own
            // commands left them.
            let mut players = players.clone();
            if body.guess.is_some()
                && let Some(mine) = players.iter_mut().find(|p| p.id == *id)
            {
                mine.state = body.reported_state();
            }
            connection.send(ServerMsg::Snapshot {
                match_id,
                tick: self.tick,
                ack_input_seq: body.last_applied_seq,
                server_time_ms,
                pool_micro_usd: pool,
                zone_radius: zone.radius,
                match_remaining_ms: remaining_ms,
                players,
                ammo: body.ammo,
                reload_ms: body
                    .reload_until
                    .map(|done| ((done - now).max(0.0) * 1000.0) as u32)
                    .unwrap_or(0),
                grenades: body.grenades,
                live_grenades: live_grenades.clone(),
                starts_in_ms,
                loading,
                gathered,
            });
        }
    }
}

/// The wire shape of one table.
fn tier_of(stakes: Stakes) -> Tier {
    Tier {
        dollars: stakes.dollars(),
        entry_fee_micro_usd: stakes.entry().micros(),
        kill_reward_micro_usd: stakes.reward().micros(),
    }
}

/// How long a command waited on the server, from how many ticks it was
/// there. It arrived somewhere in the tick before the first, half a tick
/// before it on average, and ran at the start of the last.
fn waited_ms(ticks: u32) -> f32 {
    (ticks as f32 - 0.5).max(0.0) * TICK_DT * 1000.0
}

fn idle_input(state: PlayerState) -> InputCommand {
    InputCommand {
        seq: 0,
        forward: 0.0,
        right: 0.0,
        yaw: state.yaw,
        pitch: state.pitch,
        buttons: solatel_protocol::sim::Buttons::empty(),
    }
}

/// The receiving half of the lobby's channel, before the lobby exists.
///
/// This is here because the ledger needs a [`GameHandle`] to answer on and the
/// lobby needs a `LedgerHandle` to ask with, so one of them has to be built
/// before the other. The handle is the half that can be: it is only a sender.
/// [`channel`] makes the pair, the ledger is built from the handle, and
/// [`spawn`] then starts the lobby with both.
pub struct GameCommands(mpsc::Receiver<GameCommand>);

/// Makes the lobby's channel without starting it.
pub fn channel() -> (GameHandle, GameCommands) {
    let (tx, rx) = mpsc::channel::<GameCommand>(1024);
    (GameHandle { commands: tx }, GameCommands(rx))
}

/// How matches are made on this server: the fewest a match starts with, how
/// long a short line waits, and how long a started match holds everybody on
/// their spawn. See [`MATCH_FLOOR`], [`QUEUE_WAIT`] and [`WARMUP`].
#[derive(Debug, Clone, Copy)]
pub struct Matchmaking {
    pub floor: usize,
    pub wait: f32,
    pub warmup: f32,
    pub load_wait: f32,
}

/// Starts the lobby.
///
/// `ledger` is `None` for free play: no charging, no payouts, and an empty
/// pot. Anything a player can lose money in has one.
pub fn spawn(
    commands: GameCommands,
    ledger: Option<crate::ledger::LedgerHandle>,
    records: Option<crate::records::RecordsHandle>,
    wallet: Option<crate::wallet::Terms>,
    tiers: Vec<Stakes>,
    rules: Matchmaking,
) {
    let GameCommands(mut rx) = commands;

    tokio::spawn(async move {
        let mut lobby = Lobby::new();
        lobby.ledger = ledger;
        lobby.records = records;
        lobby.wallet = wallet;
        lobby.tiers = tiers;
        lobby.floor = rules.floor.max(1);
        lobby.wait = rules.wait.max(0.0);
        lobby.warmup = rules.warmup.max(0.0);
        lobby.load_wait = rules.load_wait.max(0.0);
        let mut clock = TickClock::new(
            tokio::time::Instant::now(),
            std::time::Duration::from_secs_f32(TICK_DT),
        );

        loop {
            tokio::select! {
                // Commands are drained ahead of stepping so that inputs which
                // arrived during the last tick are available to this one.
                Some(command) = rx.recv() => {
                    lobby.handle(command);
                    while let Ok(next) = rx.try_recv() {
                        lobby.handle(next);
                    }
                }
                () = tokio::time::sleep_until(clock.due()) => {
                    lobby.step();
                    clock.advance(tokio::time::Instant::now());
                }
            }
        }
    });
}

/// How late a tick may be and still be made up, by running the next straight
/// after it.
///
/// Every client makes a command each tick of its own clock, which keeps the
/// wall's time, so a server whose ticks fall behind the wall takes commands
/// slower than they come: its queues grow, and every command dropped from one
/// is a correction on somebody's screen. tokio's `Delay` moved the whole
/// schedule on by every tick more than five milliseconds late, and on a busy
/// host that came to a third of a percent - a command every five seconds,
/// for every player. Made up, the ticks keep the wall's time. Lateness past
/// this - a paused container, a host that slept - is not made up: the clock
/// starts again from then, because running a stall's worth of ticks back to
/// back would fast-forward the match.
const MAX_CATCH_UP: std::time::Duration = std::time::Duration::from_millis(250);

/// When the next tick is due: one period after the last was due, not after
/// it ran, so lateness is made up - see [`MAX_CATCH_UP`].
struct TickClock {
    period: std::time::Duration,
    next: tokio::time::Instant,
}

impl TickClock {
    fn new(now: tokio::time::Instant, period: std::time::Duration) -> Self {
        Self {
            period,
            next: now + period,
        }
    }

    fn due(&self) -> tokio::time::Instant {
        self.next
    }

    /// The tick that was due has run, and it is now `now`.
    fn advance(&mut self, now: tokio::time::Instant) {
        self.next += self.period;
        if now > self.next + MAX_CATCH_UP {
            self.next = now + self.period;
        }
    }
}

// In its own file because it is long, and a child module because it reaches
// the lobby's private state directly - which is the point: these test the
// rules, not the transport.
#[cfg(test)]
#[path = "game_tests.rs"]
mod tests;

/// When a target came into a shooter's sight, as the shooter saw it.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Exposure {
    /// The first tick it was in sight.
    since_tick: u32,
    /// How long before the shot that was.
    ms: f32,
}

/// How long `target` had been in `shooter`'s line of sight at `tick`, or
/// `None` if it had been there for the whole window - a target held in view
/// is tracking, and how quickly somebody reacts to what they have been
/// watching for a second says nothing.
///
/// Walked back through both histories a tick at a time: the shooter's own eye
/// as it was, against the target as the shooter was seeing it then - rewound
/// by the same lag compensation the shot itself was, so the sighting and the
/// hit are measured in one frame of reference. Sight is a clear line from the
/// eye to the middle of the body or of the head; either is enough, because
/// either is something a player could react to. It is computed only when a
/// shot has already hit, so it costs a few dozen rays a hit, not a sweep of
/// every pair of players every tick.
fn exposure(
    shooter: &Body,
    target: &Body,
    tick: u32,
    rewind_ms: f32,
    map: &map::Map,
) -> Option<Exposure> {
    let step_ms = TICK_DT * 1000.0;
    let window = (crate::records::REACTION_WINDOW_MS / step_ms).round() as u32;
    for back in 1..=window.min(tick) {
        let ago = back as f32 * step_ms;
        let eye = shooter.state_at(tick, ago).eye_position();
        let seen = target.state_at(tick, rewind_ms + ago);
        if !in_sight(eye, &seen, map) {
            // In sight from the tick after this one. Counted as the whole
            // of this tick, which errs on the side of the slower reaction.
            return Some(Exposure {
                since_tick: tick - back + 1,
                ms: ago,
            });
        }
    }
    None
}

/// Whether anything solid stands between an eye and a body.
fn in_sight(eye: solatel_protocol::glam::Vec3, target: &PlayerState, map: &map::Map) -> bool {
    let (body_min, body_max) = hitscan::player_hitbox(target);
    let (head_min, head_max) = hitscan::player_headbox(target);
    [(body_min + body_max) * 0.5, (head_min + head_max) * 0.5]
        .into_iter()
        .any(|point| {
            let to = point - eye;
            let distance = to.length();
            distance < 1e-3
                || hitscan::trace_world(eye, to / distance, distance - 0.05, map).is_none()
        })
}
