//! The client/server wire protocol.
//!
//! The Axum server compiles against these types, and the browser client speaks
//! the JSON they serialise to. Every message is tagged with `t`, and the tag
//! names are the wire contract - `tag_is_stable` pins them, because renaming a
//! variant without bumping `PROTOCOL_VERSION` would break deployed clients
//! silently.
//!
//! # What the client may and may not say
//!
//! The client sends *intent*: which direction it is pushing, where it is
//! looking, whether the trigger is down. It never sends a position, a hit, or a
//! kill. Those are conclusions, and conclusions are the server's alone. This
//! split is what makes cheating a matter of lying about intent - which the
//! server can bound - rather than about outcomes, which it could not.
//!
//! # Wire format
//!
//! JSON text frames, because they are readable in browser devtools and server
//! logs, which is worth more during tuning than bytes on the wire - and because
//! a JavaScript client parses them for free.
//! Encoding is funnelled through [`encode`] / [`decode`] so that moving to a
//! compact binary format is a change to this module alone. Snapshots are the
//! bulk of the traffic and will be the reason to do it.

use crate::ids::{MatchId, PlayerId, ResumeToken, SessionId, WithdrawalId};
use crate::sim::weapon::{Loadout, Optic, Weapon};
use crate::sim::{HitRegion, InputCommand, PlayerState};
use glam::Vec3;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

/// Bumped on any breaking change to [`ClientMsg`] or [`ServerMsg`]. The server
/// rejects a handshake that does not match, so an old cached wasm bundle fails
/// loudly instead of misbehaving subtly.
pub const PROTOCOL_VERSION: u16 = 19;

/// Server simulation rate. The server is authoritative, so this is the real
/// clock of the game; the client renders between ticks.
pub const TICK_HZ: u32 = 64;

/// Length of one server tick, in seconds.
pub const TICK_DT: f32 = 1.0 / TICK_HZ as f32;

/// How often the server broadcasts world state. Lower than the tick rate
/// because bandwidth, not simulation accuracy, is the constraint here; the
/// client interpolates between snapshots.
pub const SNAPSHOT_HZ: u32 = 20;

/// How far behind the newest snapshot the client renders other players.
///
/// Rendering in the past is what makes other players' motion smooth instead of
/// a series of jumps. Two snapshot intervals means one lost snapshot still has
/// a successor to interpolate towards.
pub const INTERPOLATION_DELAY_MS: f32 = 2.0 * (1000.0 / SNAPSHOT_HZ as f32);

/// Upper bound on how far the server will rewind other players when validating
/// a shot. Beyond this, a player with a very bad - or deliberately inflated -
/// ping would be shooting at history nobody else can see.
pub const MAX_LAG_COMPENSATION_MS: f32 = 300.0;

/// Most input commands accepted in one message. The client repeats recent
/// unacknowledged commands so that a dropped packet does not cost a tick of
/// movement; this bounds what that repetition can be turned into.
pub const MAX_INPUTS_PER_MESSAGE: usize = 16;

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("failed to encode message: {0}")]
    Encode(#[source] serde_json::Error),
    #[error("failed to decode message: {0}")]
    Decode(#[source] serde_json::Error),
}

/// Messages the client sends to the server. None of it is trusted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    /// First message on every connection. The server replies with
    /// [`ServerMsg::Welcome`] or [`ServerMsg::Rejected`].
    Hello {
        protocol_version: u16,
        /// Free-form build identifier, for correlating bug reports with a build.
        client_build: String,
        /// What this player would like to be called.
        ///
        /// A request, not a fact, and cosmetic only. The server trims it,
        /// bounds it and may replace it entirely - see
        /// [`crate::sim::sanitise_name`]. Nothing is ever keyed on it: a name
        /// is what other players read, and [`PlayerId`] is who somebody is.
        /// Anything that moved money by name would be paying whoever typed
        /// the name.
        name: String,
        /// A token from a previous `Welcome`, to take that player's body
        /// back rather than spawning a new one.
        ///
        /// Absent on a first connection, and ignored if it is stale, wrong,
        /// or belongs to somebody still connected. A client cannot lose
        /// anything by sending a token the server does not recognise - it
        /// simply joins as new - which is what makes it safe for the client
        /// to always send whatever it has.
        resume: Option<ResumeToken>,
        /// The account key this browser was given, if it has one.
        ///
        /// Who somebody *is*, as against [`ClientMsg::Hello::resume`], which
        /// is which body they were driving. A player's balance hangs off
        /// their [`PlayerId`], and before there were accounts that id lasted
        /// exactly as long as the tab did - fine while money was a
        /// development grant, and money lost the first time somebody closed
        /// a tab after depositing.
        ///
        /// A key the server does not recognise costs nothing: it is a new
        /// account, and the `Welcome` carries the key for it.
        account: Option<String>,
        /// The invite code this browser arrived with (`?ref=` in the link),
        /// if any. Only ever acted on when this connection makes a new
        /// account - an existing player cannot be re-attributed to somebody
        /// else's invite - and an unknown code is ignored.
        #[serde(default)]
        referral: Option<String>,
    },
    /// Round-trip probe. `client_time_ms` is echoed back untouched so the
    /// client can measure RTT without the server needing clock sync. The server
    /// also uses the resulting RTT to decide how far to rewind for this
    /// client's shots.
    Ping { seq: u32, client_time_ms: f64 },
    /// Recent input commands, oldest first. Includes commands the server has
    /// already acknowledged; the server ignores those.
    Inputs { commands: Vec<InputCommand> },
    /// Ask to be put in line for a table.
    ///
    /// This is a request to be *matched*, not to join any particular match:
    /// the client names a stake and the server decides which match it forms
    /// and when. A client that could pick its own match could pick the one
    /// full of people it can beat.
    ///
    /// No money moves here. The entry fee is charged when a match actually
    /// forms around the player, so a queue that never fills costs nothing.
    ///
    /// Sending it again while already queued simply changes which table -
    /// there is one place in one line per player. It is refused outright
    /// from somebody already in a match, alive or dead: one entry fee buys
    /// one life, and the way back is the next match.
    Queue {
        /// Which map. One of the ones the server named in its `Welcome`.
        ///
        /// A table is a map *and* a stake: the arena seats twenty and the
        /// yard thirty, and somebody who asked for one is not served by being
        /// put in the other.
        map: String,
        /// Which stake, in whole dollars. One the server named; anything else
        /// is ignored.
        tier_dollars: i64,
        /// The gun and optic to play the life with. Chosen with the stake,
        /// because it is part of what the stake buys; asking again while in
        /// line changes it. Anything the game does not allow is made into
        /// something it does - see [`Loadout::sanitized`] - and the match
        /// says what was settled on when it starts.
        #[serde(default)]
        loadout: Loadout,
    },
    /// Give up the place in line. No money has moved, so nothing is returned.
    LeaveQueue,
    /// This client has the match's map loaded and drawn - shaders compiled,
    /// the first frame ready - and is ready for the countdown. The match's
    /// warm-up does not start counting until everybody in it has said so,
    /// or until the server has waited long enough. Naming the match means
    /// one sent late for the last match counts for nothing in this one.
    Loaded { match_id: MatchId },
    /// Take money out of the wallet, to a Solana address.
    ///
    /// An amount in micro-USD, because that is what the wallet holds. The
    /// server decides how much SOL that is, at a rate it states in the
    /// `Welcome`, and says so in the [`ServerMsg::Withdrawal`] that accepts
    /// it - a client that did its own conversion could disagree about how
    /// much it was about to be sent.
    Withdraw {
        amount_micro_usd: i64,
        /// A base58 Solana address. Checked on the server, not trusted.
        destination: String,
    },
    /// Asks for something to sign with a Solana wallet, to prove it is this
    /// player's. Answered with [`ServerMsg::WalletChallenge`].
    WalletChallenge,
    /// The challenge, signed. `public_key` and `signature` are base58, as
    /// wallets give them. The server checks the signature itself; nothing
    /// here is taken on trust.
    WalletProof {
        public_key: String,
        signature: String,
    },
    /// Diagnostic round-trip check. Retained from Phase 1.
    Echo { payload: String },
}

/// One player as the server sees them.
/// What ended a life. A shot is named by the gun that fired it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeathCause {
    /// The assault rifle.
    #[default]
    Rifle,
    Grenade,
    /// Outside the circle for too long.
    Zone,
    /// Out of the world, or the resume window closing.
    Fall,
    Pistol,
    Smg,
    Lmg,
    Sniper,
}

impl From<Weapon> for DeathCause {
    fn from(weapon: Weapon) -> Self {
        match weapon {
            Weapon::Pistol => DeathCause::Pistol,
            Weapon::Smg => DeathCause::Smg,
            Weapon::Rifle => DeathCause::Rifle,
            Weapon::Lmg => DeathCause::Lmg,
            Weapon::Sniper => DeathCause::Sniper,
        }
    }
}

/// Where a round came down, and on what.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Landing {
    pub at: Vec3,
    /// It hit a player, so the shooter gets a hit marker and the impact is a
    /// mist rather than dust.
    pub hit_player: bool,
    /// It hit something at all. A round that ran out of range in the open
    /// came down nowhere in particular and raises nothing.
    pub struck: bool,
}

/// A grenade that has not gone off yet.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GrenadeSnapshot {
    pub id: u32,
    pub position: Vec3,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PlayerSnapshot {
    pub id: PlayerId,
    pub state: PlayerState,
    /// Changing magazines right now. Sent to everybody, because a reload is
    /// done in plain view and heard: it is what a player standing there
    /// would see. How many rounds anybody has left is not sent to anybody
    /// but them.
    #[serde(default)]
    pub reloading: bool,
    /// Holding the rifle up to aim. Sent to everybody for the same reason: a
    /// rifle at the shoulder is seen, and a body that always looked aimed
    /// told nobody anything. It is the aim button the server last ran, and
    /// it changes nothing the server decides.
    #[serde(default)]
    pub aiming: bool,
    /// The gun in their hands - which is in plain view - and the optic on
    /// their primary. Left off the wire when they are the rifle and the red
    /// dot, which most of them are, because this goes out twenty times a
    /// second for every player.
    #[serde(default, skip_serializing_if = "is_rifle")]
    pub weapon: Weapon,
    #[serde(default, skip_serializing_if = "is_red_dot")]
    pub optic: Optic,
}

fn is_rifle(weapon: &Weapon) -> bool {
    *weapon == Weapon::Rifle
}

fn is_red_dot(optic: &Optic) -> bool {
    *optic == Optic::RedDot
}

/// One player's match record, as counted by the server.
///
/// Every number here is a tally the server kept while resolving shots. None
/// of it is reported by a client, and none of it can be: a client that could
/// say how many shots it hit could say it hit all of them, and accuracy is
/// a thing players are judged - and paid - on.
///
/// Accuracy itself is deliberately absent. It is `shots_hit / shots_fired`,
/// and sending the ratio as well as its two terms is sending the same fact
/// twice, with a rounding rule for the client to disagree about. The client
/// renders the percentage, the way it renders the pot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScoreEntry {
    pub id: PlayerId,
    pub name: String,
    pub kills: u32,
    pub deaths: u32,
    pub shots_fired: u32,
    pub shots_hit: u32,
    pub headshots: u32,
    pub damage_dealt: u32,
    pub alive: bool,
    /// What this player has won in this match so far, in micro-USD.
    ///
    /// Counted by the server from the kills it resolved, not by the client
    /// from the kills it saw: a client that worked out its own winnings
    /// could be wrong about money, and this is the number a player watches
    /// all match.
    ///
    /// It is already in their balance - every kill settles as it happens -
    /// so this is a statement of where the balance came from rather than a
    /// promise of something still to be paid.
    pub winnings_micro_usd: i64,
}

/// One map this server runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MapInfo {
    pub name: String,
    /// How many players one match on it seats.
    pub seats: u32,
}

/// One table: a stake, and what a kill is worth at it.
///
/// The arithmetic is the server's. The client renders these numbers and
/// never derives one from another - the rake is a policy, not a formula the
/// client is entitled to assume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tier {
    /// The stake in whole dollars, which is also the table's name.
    pub dollars: i64,
    pub entry_fee_micro_usd: i64,
    /// What one kill pays whoever gets it. The rest of the victim's stake is
    /// the platform's.
    pub kill_reward_micro_usd: i64,
}

/// How one table looks to somebody deciding whether to join its queue.
///
/// One row per map per stake, because that is what a line is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableStatus {
    pub map: String,
    /// How many this map seats. Twenty on the arena, thirty on the yard.
    pub seats: u32,
    pub dollars: i64,
    /// How many people are in line for this table right now.
    pub waiting: u32,
    /// How many are needed before a match will form.
    pub needed: u32,
    /// Matches currently being played at this stake.
    pub running: u32,
    /// Milliseconds until a match forms whether or not the queue has filled,
    /// or zero when nothing is pending. A queue that is short of `needed`
    /// still starts eventually rather than waiting forever, which is the
    /// difference between a quiet server and a broken one.
    pub forming_in_ms: u32,
}

/// How money gets in and out, as this server offers it.
///
/// Absent from the `Welcome` when the server has no chain configured, which
/// the client says in so many words rather than showing buttons that do
/// nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WalletTerms {
    /// Which Solana cluster. `devnet` until somebody decides otherwise, and
    /// shown to the player so nobody mistakes test money for the real thing.
    pub network: String,
    /// Where to send SOL. One address for everybody; the memo says whose it
    /// is.
    pub deposit_address: String,
    /// What the memo must say for a deposit to reach this player.
    pub deposit_memo: String,
    /// What one SOL is worth here, in micro-USD. Fixed by configuration
    /// rather than read from a market.
    pub micro_usd_per_sol: i64,
    pub min_withdrawal_micro_usd: i64,
    /// False when this server will not pay out - see `SOLATEL_DEV_GRANT`.
    pub withdrawals_open: bool,
    /// The USDC mint this server takes, and the treasury's account for it.
    /// A USDC deposit goes to that account with the same memo.
    #[serde(default)]
    pub usdc_mint: Option<String>,
    #[serde(default)]
    pub usdc_address: Option<String>,
}

/// Where a withdrawal has got to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WithdrawalStatus {
    /// Taken out of the wallet and waiting to go on chain.
    Requested,
    /// Signed and sent. Not yet final.
    Sent,
    /// Final on chain. The money is at the destination.
    Settled,
    /// It never landed, and the money is back in the wallet.
    Returned,
}

/// Messages the server sends to the client. This is the authoritative side.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    /// Handshake accepted.
    Welcome {
        session_id: SessionId,
        /// Which player in the snapshots is this client.
        player_id: PlayerId,
        /// The name the server settled on, which may not be the one asked
        /// for. The client displays this rather than what it sent, so the
        /// two never disagree about what everyone else is seeing.
        name: String,
        /// Present this on the next connection to take this body back.
        ///
        /// A fresh one every time, including on a resume, because the token
        /// that was just spent must not work twice.
        resume_token: ResumeToken,
        /// Whether this connection took over an existing player, or made a
        /// new one. The client uses it to decide whether to keep its aim and
        /// its reconciliation state or start clean.
        resumed: bool,
        tick_hz: u32,
        snapshot_hz: u32,
        /// Every map this server runs, with how many each seats.
        ///
        /// The client offers these in the menu and names one when it queues.
        /// There is no server-wide map any more: a match carries its own, and
        /// several on different maps run at once.
        maps: Vec<MapInfo>,
        /// Geometry the server is colliding against. A client with a different
        /// map must reload rather than play against invisible walls.
        map_version: u32,
        /// Server uptime in milliseconds. Not wall-clock time: the client only
        /// needs a monotonic reference to estimate offset and jitter.
        server_time_ms: f64,
        /// The tables this server runs, cheapest first.
        ///
        /// Sent rather than compiled into the client, because the client must
        /// not be the one that knows the price. A client that knew the stakes
        /// for itself could be wrong about what it is being charged.
        tiers: Vec<Tier>,
        /// A new account key, when this connection made a new account.
        ///
        /// The only time it is ever sent: the server keeps a hash, not the
        /// key, and a browser that already holds one is not handed it again.
        /// It is a bearer credential for the balance, so the client keeps it
        /// and the player should too.
        account_key: Option<String>,
        /// Deposits and withdrawals, if this server takes them. Boxed
        /// because it is most of the variant's size and sent once a
        /// connection; serde reads and writes it exactly as unboxed.
        wallet: Option<Box<WalletTerms>>,
        /// The Solana wallet this account is signed in with, if it has one.
        #[serde(default)]
        solana_pubkey: Option<String>,
        /// This player's invite code, for the link they can hand out.
        #[serde(default)]
        invite_code: Option<String>,
    },
    Pong {
        seq: u32,
        client_time_ms: f64,
        server_time_ms: f64,
    },
    /// The authoritative world. Everything the client draws derives from this.
    Snapshot {
        /// Which match this describes.
        ///
        /// Several run at once, and a client that had just been eliminated
        /// from one could otherwise render a straggling snapshot of it over
        /// the lobby. The client discards anything that is not its own match.
        match_id: MatchId,
        tick: u32,
        /// Everything staked on this match so far, in micro-USD.
        ///
        /// Sent with the snapshot rather than on its own so it cannot drift
        /// out of step with the player list it is derived from, and as an
        /// integer because it is money. The client displays it and never
        /// computes it: a client that worked out the pot for itself would be
        /// a client that could be wrong about it.
        pool_micro_usd: i64,
        /// The newest input from this client that the server has consumed.
        /// The client re-predicts from here.
        ack_input_seq: u32,
        /// How far from the map's centre the match's circle currently
        /// reaches, in metres.
        ///
        /// Sent rather than derived, even though the schedule is in the
        /// shared simulation and the client could work it out. The circle
        /// closes on the server's clock, and a client running its own copy
        /// of that clock would predict against a wall a little away from the
        /// one it is actually being held behind - which is a correction
        /// every tick for anybody standing near the edge.
        zone_radius: f32,
        /// Milliseconds left in this match.
        match_remaining_ms: u32,
        server_time_ms: f64,
        players: Vec<PlayerSnapshot>,
        /// The receiving player's own weapons: which is in hand, rounds in
        /// its magazine and in the other's, milliseconds of reload left (0
        /// when not reloading), milliseconds until the gun in hand is ready
        /// after a change of weapon, and grenades left. Only ever about the
        /// player it is sent to - what is in somebody else's magazine is not
        /// theirs to know.
        #[serde(default)]
        weapon: Weapon,
        #[serde(default)]
        ammo: u32,
        #[serde(default)]
        spare_ammo: u32,
        #[serde(default)]
        reload_ms: u32,
        #[serde(default)]
        switch_ms: u32,
        #[serde(default)]
        grenades: u32,
        /// Grenades in the air or on the ground, still to go off.
        #[serde(default)]
        live_grenades: Vec<GrenadeSnapshot>,
        /// Milliseconds of warm-up left before the match goes live: everybody
        /// on their spawn, looking round, unable to move, shoot or be hurt.
        /// Zero once it is live. The match clock and the circle start when
        /// this reaches zero, not when the players were placed.
        #[serde(default)]
        starts_in_ms: u32,
        /// How many players in this match are still loading its map. While
        /// any are, the warm-up has not begun: `starts_in_ms` is the whole of
        /// it and does not count down. The server waits for the last of them
        /// or for its `LOAD_WAIT`, whichever comes first.
        #[serde(default)]
        loading: u32,
        /// Whether this match's players are waiting together on its
        /// gathering ground rather than on their own spawns: free to walk
        /// and jump until the countdown ends, when each is put on their
        /// spawn. While it is false a warm-up holds everybody still.
        #[serde(default)]
        gathered: bool,
    },
    /// A shot was fired, for the flash, the sound and the tracer. Purely
    /// cosmetic: the damage it did, if any, arrives as
    /// [`ServerMsg::Damaged`].
    ///
    /// A round flies, so where it lands may not be known yet. It is when the
    /// flight is shorter than the shooter's lag - the server judges that
    /// part at once, against the world as the shooter saw it - which is most
    /// shots; otherwise a [`ServerMsg::ShotLanded`] with the same `shot`
    /// follows when it comes down.
    ShotFired {
        shooter: PlayerId,
        /// This match's number for the shot, to pair it with its landing.
        shot: u32,
        weapon: Weapon,
        from: Vec3,
        /// How the round left: its direction and speed, in metres per
        /// second. The client flies a tracer along it with the shared
        /// flight.
        velocity: Vec3,
        landed: Option<Landing>,
    },
    /// A round fired earlier came down.
    ShotLanded {
        shooter: PlayerId,
        shot: u32,
        landing: Landing,
    },
    /// This client took damage.
    Damaged {
        attacker: PlayerId,
        amount: i16,
        health_remaining: i16,
        /// Where it landed, so the shot that took two thirds of your health
        /// is distinguishable from the one that took a third.
        region: HitRegion,
    },
    /// The shooter's own confirmation that a shot connected.
    ///
    /// Separate from [`ServerMsg::ShotFired`], which everyone gets and which
    /// only says *whether* a player was hit. This says how much and where, to
    /// the one client entitled to know - telling the room would tell every
    /// other player how hurt their opponents are.
    HitConfirmed {
        victim: PlayerId,
        amount: i16,
        region: HitRegion,
        /// Whether that shot finished them.
        killed: bool,
    },
    /// Someone died. `killer` is `None` for falls and disconnects.
    ///
    /// Names travel with the event rather than being looked up in the
    /// scoreboard, because the most interesting kill in a match is frequently
    /// the one where somebody then leaves, and a feed that says "‹unknown›
    /// killed you" is a feed nobody trusts.
    Killed {
        victim: PlayerId,
        victim_name: String,
        killer: Option<PlayerId>,
        killer_name: Option<String>,
        headshot: bool,
        /// What did it, for the killfeed.
        #[serde(default)]
        cause: DeathCause,
    },
    /// A grenade went off, for the flash, the smoke and the bang. The damage
    /// it did arrives the usual way.
    Exploded {
        at: Vec3,
        thrower: PlayerId,
    },
    /// This player is out of the match: killed, and not coming back.
    ///
    /// Sent to the player it happened to, on top of the [`ServerMsg::Killed`]
    /// everybody gets. There is no respawn to count down to, and no reason to
    /// sit and watch: they are back in the lobby the moment this arrives and
    /// may queue again immediately.
    Eliminated {
        /// What they won in the match they have just left, in micro-USD.
        /// Already in their wallet - this is the statement, not the payment.
        winnings_micro_usd: i64,
    },
    /// The state of the lobby: what tables exist and what this player is
    /// waiting for.
    ///
    /// Sent on joining and whenever it changes, which is a few times a
    /// minute rather than a few times a second. This is the screen a player
    /// is looking at when they are not in a match.
    Lobby {
        tables: Vec<TableStatus>,
        /// The map this player is queued for, if any.
        queued_map: Option<String>,
        /// The stake this player is queued for, if any.
        queued_for: Option<i64>,
        /// Their place in that line, counting from one. Zero when not queued.
        place: u32,
    },
    /// A line has become a match with this player in it, and the entry fees
    /// are being taken. Nothing has been charged yet by the time this
    /// arrives; `MatchStarted` follows once it has, or the player is back in
    /// the lobby if the match did not get enough stakes.
    ///
    /// The "match found" moment every matchmaker has. Without it the queue
    /// goes quiet for the seconds the buy-in takes and then a map appears.
    MatchFound {
        match_id: MatchId,
        map_name: String,
        tier: Tier,
        /// How many are in it.
        players: u32,
    },
    /// A match has formed around this player and they are in it. Their entry
    /// fee has been taken by the time this arrives.
    MatchStarted {
        /// Which match. Every snapshot carries this, so a client can tell a
        /// message about the match it is in from a straggler about the one it
        /// has just left.
        match_id: MatchId,
        /// The ground it is played on. The client loads this model and
        /// predicts against these brushes; several matches run at once and
        /// they are not all on the same map.
        map_name: String,
        /// The stake this match is played for.
        tier: Tier,
        /// Milliseconds it will run for.
        duration_ms: u32,
        /// How many bought into it.
        players: u32,
        /// Milliseconds of warm-up left: see `Snapshot::starts_in_ms`.
        #[serde(default)]
        starts_in_ms: u32,
        /// What this player is carrying, as the server settled it.
        #[serde(default)]
        loadout: Loadout,
    },
    /// The match is over. The board is final, and a new one starts now.
    ///
    /// Carries its own copy of the board rather than leaving the client to
    /// use the last `Scoreboard` it happened to receive: the records are
    /// wiped for the new match on the same tick, so a client that had missed
    /// a broadcast would show a final table that never existed.
    MatchEnded {
        match_id: MatchId,
        entries: Vec<ScoreEntry>,
        /// What this player won in it, in micro-USD. Already in their wallet.
        winnings_micro_usd: i64,
    },
    /// Everyone in the match and how they are doing.
    ///
    /// Sent on its own rather than folded into the snapshot. Snapshots are
    /// twenty a second and are already the bulk of the traffic; scores change
    /// a few times a minute, and putting a name and six counters per player
    /// into every one of them would have been most of a kilobyte a second per
    /// client to say nothing had changed.
    Scoreboard {
        entries: Vec<ScoreEntry>,
    },
    /// What this player can spend, and whether the last life they asked for
    /// was refused for want of it.
    ///
    /// Sent only to the player it concerns - a balance is nobody else's
    /// business - and only when it changes, which is when a life is bought
    /// and when a kill pays out. It is the server's figure in micro-USD; the
    /// client formats it and never adds to it.
    Funds {
        balance_micro_usd: i64,
        /// True when a life was just refused. The client says so rather than
        /// leaving the player dead with no explanation.
        insufficient: bool,
    },
    /// Money arrived on chain for this player and is in their wallet.
    ///
    /// Sent once the transaction is final: a deposit that the chain could
    /// still take back is not money anybody can play with.
    Deposited {
        amount_micro_usd: i64,
        lamports: u64,
        /// USDC it brought, in base units - a micro-USD each.
        #[serde(default)]
        usdc_units: u64,
        signature: String,
    },
    /// A withdrawal was accepted, or has moved on.
    ///
    /// Sent at every step, and again for the recent ones when a player
    /// arrives, so a withdrawal in flight across a reload is not a balance
    /// that simply went down.
    Withdrawal {
        id: WithdrawalId,
        status: WithdrawalStatus,
        amount_micro_usd: i64,
        /// What the server is sending, or sent. Its figure, not a
        /// conversion the client did.
        lamports: u64,
        destination: String,
        /// The chain's name for the transfer, once there is one.
        signature: Option<String>,
        /// Why it came back, when it did.
        reason: Option<String>,
    },
    /// A withdrawal was not accepted. Nothing moved.
    WithdrawalRefused {
        reason: String,
    },
    /// Text for the player's wallet to sign, to prove the wallet is theirs.
    /// Good once, and only for a few minutes.
    WalletChallenge {
        message: String,
    },
    /// The wallet's signature checked out. Either this account now carries
    /// the wallet (`account_key` is `None`), or the wallet belongs to
    /// another account, which this browser is now signed in as: keep
    /// `account_key` and connect again with it.
    WalletSignedIn {
        public_key: String,
        player_id: PlayerId,
        account_key: Option<String>,
    },
    /// Signing in with a wallet did not happen, and why.
    WalletRefused {
        reason: String,
    },
    Echo {
        payload: String,
    },
    /// Handshake or request refused. The connection closes after this.
    Rejected {
        reason: String,
    },
}

pub fn encode<T: Serialize>(msg: &T) -> Result<String, ProtocolError> {
    serde_json::to_string(msg).map_err(ProtocolError::Encode)
}

pub fn decode<T: DeserializeOwned>(raw: &str) -> Result<T, ProtocolError> {
    serde_json::from_str(raw).map_err(ProtocolError::Decode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{Buttons, map::TEST_MAP};

    #[test]
    fn client_messages_round_trip() {
        let msg = ClientMsg::Ping {
            seq: 7,
            client_time_ms: 1234.5,
        };
        let wire = encode(&msg).unwrap();
        let back: ClientMsg = decode(&wire).unwrap();
        assert!(matches!(back, ClientMsg::Ping { seq: 7, .. }));
    }

    #[test]
    fn inputs_round_trip_exactly() {
        // Movement depends on these values surviving the wire unchanged; a
        // lossy round trip here would show up as unexplained prediction error.
        let commands = vec![InputCommand {
            seq: 42,
            forward: -1.0,
            right: 0.5,
            yaw: 1.25,
            pitch: -0.75,
            buttons: Buttons(Buttons::JUMP | Buttons::FIRE),
        }];
        let wire = encode(&ClientMsg::Inputs {
            commands: commands.clone(),
        })
        .unwrap();
        let ClientMsg::Inputs { commands: back } = decode(&wire).unwrap() else {
            panic!("decoded as the wrong variant");
        };
        assert_eq!(commands, back);
    }

    #[test]
    fn snapshots_round_trip() {
        let snapshot = ServerMsg::Snapshot {
            match_id: MatchId::new(),
            tick: 900,
            ack_input_seq: 41,
            zone_radius: 64.0,
            match_remaining_ms: 120_000,
            server_time_ms: 12.5,
            pool_micro_usd: crate::economy::Stakes::DEFAULT.entry().micros() * 7,
            players: vec![PlayerSnapshot {
                id: PlayerId::new(),
                state: PlayerState::spawned_at(TEST_MAP.spawn(0)),
                reloading: true,
                aiming: true,
                weapon: Weapon::Sniper,
                optic: Optic::X3,
            }],
            weapon: Weapon::Pistol,
            ammo: 30,
            spare_ammo: 5,
            reload_ms: 0,
            switch_ms: 120,
            grenades: 2,
            live_grenades: vec![GrenadeSnapshot {
                id: 1,
                position: Vec3::new(1.0, 0.1, 2.0),
            }],
            starts_in_ms: 15_000,
            loading: 3,
            gathered: true,
        };
        let wire = encode(&snapshot).unwrap();
        assert!(matches!(
            decode::<ServerMsg>(&wire),
            Ok(ServerMsg::Snapshot { .. })
        ));
    }

    #[test]
    fn unknown_message_is_an_error_not_a_panic() {
        assert!(decode::<ClientMsg>(r#"{"t":"nonsense"}"#).is_err());
        assert!(decode::<ClientMsg>("not json at all").is_err());
    }

    #[test]
    fn tag_is_stable() {
        // The tag names are the wire contract. Renaming a variant without
        // bumping PROTOCOL_VERSION would silently break deployed clients.
        let wire = encode(&ClientMsg::Echo {
            payload: "hi".into(),
        })
        .unwrap();
        assert_eq!(wire, r#"{"t":"echo","payload":"hi"}"#);
    }

    #[test]
    fn the_scoreboard_field_names_are_the_wire_contract() {
        // The HUD reads these off the JSON by name. Renaming a field here
        // would compile, serialise, deserialise, and silently draw a
        // scoreboard of blanks - which is the kind of break that reaches a
        // player rather than a build.
        let wire = encode(&ServerMsg::Scoreboard {
            entries: vec![ScoreEntry {
                id: PlayerId::new(),
                name: "Conrad".into(),
                kills: 3,
                deaths: 1,
                shots_fired: 20,
                shots_hit: 9,
                headshots: 2,
                damage_dealt: 340,
                alive: false,
                winnings_micro_usd: 2_700_000,
            }],
        })
        .unwrap();

        for field in [
            "\"t\":\"scoreboard\"",
            "\"name\":\"Conrad\"",
            "\"kills\":3",
            "\"deaths\":1",
            "\"shots_fired\":20",
            "\"shots_hit\":9",
            "\"headshots\":2",
            "\"damage_dealt\":340",
            "\"alive\":false",
            "\"winnings_micro_usd\":2700000",
        ] {
            assert!(wire.contains(field), "{field} missing from {wire}");
        }
    }

    #[test]
    fn a_kill_carries_both_names_and_the_region_on_the_wire() {
        let wire = encode(&ServerMsg::Killed {
            victim: PlayerId::new(),
            victim_name: "Victim".into(),
            killer: None,
            killer_name: None,
            headshot: true,
            cause: DeathCause::Fall,
        })
        .unwrap();
        assert!(wire.contains("\"victim_name\":\"Victim\""), "{wire}");
        // A fall has no killer, and the feed has to be able to tell.
        assert!(wire.contains("\"killer_name\":null"), "{wire}");
        assert!(wire.contains("\"headshot\":true"), "{wire}");

        let hit = encode(&ServerMsg::Damaged {
            attacker: PlayerId::new(),
            amount: 68,
            health_remaining: 32,
            region: HitRegion::Head,
        })
        .unwrap();
        assert!(hit.contains("\"region\":\"head\""), "{hit}");
    }

    #[test]
    fn a_hello_without_a_name_is_refused() {
        // Not because the name matters - the server would have replaced an
        // empty one anyway - but because a client that does not send the
        // field is an old client, and this is the handshake that is supposed
        // to catch those before they play against geometry they disagree on.
        let old = r#"{"t":"hello","protocol_version":5,"client_build":"x"}"#;
        assert!(decode::<ClientMsg>(old).is_err());

        // A hello with a name but no resume token is a first connection and
        // must be accepted: `resume` is optional precisely so that the very
        // first hello a browser ever sends does not need one.
        let first = r#"{"t":"hello","protocol_version":5,"client_build":"x","name":"a"}"#;
        assert!(decode::<ClientMsg>(first).is_ok());
    }

    #[test]
    fn the_wallet_messages_are_the_wire_contract() {
        // The menu reads these by name, and one of them is a request to move
        // money. A renamed field would decode as missing and be refused,
        // which is safe, but it is a withdrawal button that silently does
        // nothing - so it is pinned.
        let asked = r#"{"t":"withdraw","amount_micro_usd":5000000,"destination":"abc"}"#;
        let Ok(ClientMsg::Withdraw {
            amount_micro_usd,
            destination,
        }) = decode::<ClientMsg>(asked)
        else {
            panic!("a withdrawal request did not decode");
        };
        assert_eq!(amount_micro_usd, 5_000_000);
        assert_eq!(destination, "abc");

        let told = encode(&ServerMsg::Withdrawal {
            id: WithdrawalId::new(),
            status: WithdrawalStatus::Returned,
            amount_micro_usd: 5_000_000,
            lamports: 35_714_285,
            destination: "abc".into(),
            signature: None,
            reason: Some("it expired".into()),
        })
        .unwrap();
        for field in [
            "\"t\":\"withdrawal\"",
            "\"status\":\"returned\"",
            "\"lamports\":35714285",
            "\"signature\":null",
        ] {
            assert!(told.contains(field), "{field} missing from {told}");
        }

        // A hello from before accounts is still a hello: `account` is
        // optional, and a missing one means "make me an account".
        let old = r#"{"t":"hello","protocol_version":10,"client_build":"x","name":"a"}"#;
        assert!(matches!(
            decode::<ClientMsg>(old),
            Ok(ClientMsg::Hello { account: None, .. })
        ));
    }

    #[test]
    fn a_rifle_with_a_red_dot_costs_nothing_on_the_wire() {
        // Twenty times a second for every player: the common case is left
        // off, and read back as itself.
        let plain = PlayerSnapshot {
            id: PlayerId::new(),
            state: PlayerState::spawned_at(TEST_MAP.spawn(0)),
            reloading: false,
            aiming: false,
            weapon: Weapon::Rifle,
            optic: Optic::RedDot,
        };
        let wire = encode(&plain).unwrap();
        assert!(!wire.contains("weapon") && !wire.contains("optic"), "{wire}");
        assert_eq!(decode::<PlayerSnapshot>(&wire).unwrap(), plain);

        let scoped = PlayerSnapshot {
            weapon: Weapon::Sniper,
            optic: Optic::X4,
            ..plain
        };
        let wire = encode(&scoped).unwrap();
        assert!(wire.contains("\"weapon\":\"sniper\""), "{wire}");
        assert!(wire.contains("\"optic\":\"x4\""), "{wire}");
        assert_eq!(decode::<PlayerSnapshot>(&wire).unwrap(), scoped);
    }

    #[test]
    fn a_queue_names_its_loadout_and_an_old_one_gets_the_rifle() {
        let asked = r#"{"t":"queue","map":"yard","tier_dollars":1,"loadout":{"primary":"lmg","optic":"x3"}}"#;
        let Ok(ClientMsg::Queue { loadout, .. }) = decode::<ClientMsg>(asked) else {
            panic!("a queue with a loadout did not decode");
        };
        assert_eq!(
            loadout,
            Loadout {
                primary: Weapon::Lmg,
                optic: Optic::X3
            }
        );
        let bare = r#"{"t":"queue","map":"yard","tier_dollars":1}"#;
        let Ok(ClientMsg::Queue { loadout, .. }) = decode::<ClientMsg>(bare) else {
            panic!("a queue without a loadout did not decode");
        };
        assert_eq!(loadout, Loadout::default());
    }

    #[test]
    fn a_shot_says_where_it_landed_when_it_knows() {
        let fired = encode(&ServerMsg::ShotFired {
            shooter: PlayerId::new(),
            shot: 7,
            weapon: Weapon::Smg,
            from: Vec3::new(1.0, 2.0, 3.0),
            velocity: Vec3::new(0.0, 0.0, -735.0),
            landed: Some(Landing {
                at: Vec3::new(1.0, 2.0, -20.0),
                hit_player: true,
                struck: true,
            }),
        })
        .unwrap();
        for field in [
            "\"t\":\"shot_fired\"",
            "\"shot\":7",
            "\"weapon\":\"smg\"",
            "\"hit_player\":true",
        ] {
            assert!(fired.contains(field), "{field} missing from {fired}");
        }
        let later = encode(&ServerMsg::ShotLanded {
            shooter: PlayerId::new(),
            shot: 8,
            landing: Landing {
                at: Vec3::ZERO,
                hit_player: false,
                struck: false,
            },
        })
        .unwrap();
        assert!(later.contains("\"t\":\"shot_landed\""), "{later}");
        assert!(later.contains("\"struck\":false"), "{later}");
        assert_eq!(
            encode(&DeathCause::from(Weapon::Sniper)).unwrap(),
            "\"sniper\""
        );
    }

    #[test]
    fn interpolation_delay_covers_a_dropped_snapshot() {
        let interval_ms = 1000.0 / SNAPSHOT_HZ as f32;
        assert!(
            INTERPOLATION_DELAY_MS >= interval_ms * 2.0,
            "one lost snapshot would leave nothing to interpolate towards"
        );
    }
}
