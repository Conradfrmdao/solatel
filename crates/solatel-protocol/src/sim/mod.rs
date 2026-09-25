//! The movement simulation, shared by client and server.
//!
//! This module is the single definition of how a player moves. The client runs
//! it to predict its own motion so that controls feel instant; the server runs
//! the very same code to decide what actually happened. Because both sides
//! execute this function over the same inputs, they agree - and where they
//! disagree, the server wins and the client corrects itself.
//!
//! Nothing here may branch on whether it is running on the client or the
//! server. The moment it does, the two simulations can diverge, and divergence
//! in a game that pays per kill means paying the wrong player.
//!
//! # Tuning
//!
//! The constants below decide how the game *feels*, which cannot be settled by
//! reasoning about it - it has to be played. They are gathered here, with the
//! effect of each one noted, so a tuning pass is a change to one screen of code
//! rather than a hunt through the movement logic.

pub mod broadphase;
pub mod collide;
pub mod hitscan;
pub mod map;

use glam::{Vec2, Vec3};
use serde::{Deserialize, Serialize};

use crate::net::TICK_DT;
use map::Map;

// --- Movement feel -------------------------------------------------------

/// Top speed under normal running, in metres per second.
pub const MAX_GROUND_SPEED: f32 = 8.0;

/// Top speed the air-acceleration step will add towards. Deliberately lower
/// than ground speed: it caps how much a player can steer mid-jump without
/// preventing them from keeping speed they already had.
pub const MAX_AIR_SPEED: f32 = 8.0;

/// How hard the player accelerates towards top speed on the ground. Higher
/// feels snappier and more arcade; lower feels heavier.
pub const GROUND_ACCEL: f32 = 90.0;

/// Air control. Higher lets players steer freely mid-air.
pub const AIR_ACCEL: f32 = 18.0;

/// How quickly a player sheds speed when not pushing a direction. Higher stops
/// dead; lower slides.
pub const FRICTION: f32 = 9.0;

/// Friction is computed against at least this speed, so that a nearly-stopped
/// player still stops in a fixed time instead of creeping asymptotically.
pub const STOP_SPEED: f32 = 1.5;

pub const GRAVITY: f32 = 23.0;

/// Upward speed applied on jump. With the gravity above this is roughly a
/// 1.1 m jump, which clears the chest-high cover in the test map.
pub const JUMP_SPEED: f32 = 7.2;

/// Half-extents of the player's collision box. The player is 1.8 m tall.
pub const PLAYER_HALF_EXTENTS: Vec3 = Vec3::new(0.35, 0.9, 0.35);

/// Eye height above the *centre* of the collision box.
///
/// 0.80 puts the eye at 1.70 m on a 1.8 m player, which is where a person's
/// eyes actually are - about 0.10 m below the crown. It was 0.70, an eye at
/// 1.60 m, which is a head's worth too low and is part of why the player
/// felt short next to this art.
///
/// It is not the whole of it. The yard has a cluster of openings with their
/// sills at 2.25 m, well over any human eye, and no eye height fixes those
/// - only drawing that map smaller would.
pub const EYE_OFFSET: f32 = 0.8;

/// Pitch is clamped just short of straight up and down; exactly vertical makes
/// the look direction degenerate.
pub const MAX_PITCH: f32 = std::f32::consts::FRAC_PI_2 - 0.01;

// --- Weapon --------------------------------------------------------------

pub const MAX_HEALTH: i16 = 100;

/// Four shots to kill with a body shot, which is the common case.
///
/// Every region divides into [`MAX_HEALTH`] exactly, so the shots-to-kill are
/// the numbers rather than something that falls out of rounding.
pub const WEAPON_DAMAGE: i16 = 25;

/// Where a shot landed, which is what decides how much it hurt.
///
/// A single box for the whole body makes every shot worth the same, so aim
/// stops mattering past "did the crosshair touch them" - which in a game
/// paying by the kill is the difference between a skill and a lottery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HitRegion {
    Head,
    Body,
    Legs,
}

impl HitRegion {
    /// Damage is stated per region rather than as a multiplier on a base.
    ///
    /// A multiplier means a rounding rule, and a rounding rule is one more
    /// thing that has to match between whatever computes the number and
    /// whatever checks it. These are the numbers, and the shots-to-kill they
    /// imply are the design: two to the head, four to the body, five to the
    /// legs, against [`MAX_HEALTH`].
    ///
    /// Longer than it was. A four-shot body kill leaves time to react to
    /// being shot at - to break line of sight, or to shoot back - which is
    /// what makes the difference between a duel and whoever clicked first.
    /// The head stays at two, so aiming up is worth twice as much as it is
    /// worth being quick.
    pub const fn damage(self) -> i16 {
        match self {
            // 2 shots. Deliberately not 100: a one-shot kill from any range
            // means whoever saw the other first wins outright, and there is
            // nothing to play for in the second between seeing and dying.
            HitRegion::Head => 50,
            // 4 shots, and the common case.
            HitRegion::Body => WEAPON_DAMAGE,
            // 5 shots. Worth landing, worth less than aiming higher.
            HitRegion::Legs => 20,
        }
    }
}

/// How high up the player box the legs stop, measured from their centre.
///
/// The collision box is 1.8 m tall with its centre at 0.9 m, so this puts the
/// waist at 0.55 m off the ground.
pub const LEGS_TOP: f32 = -0.35;

/// How far down from the top of the box the head reaches, and how wide it is.
///
/// The eye is at `EYE_OFFSET` (0.80) above the centre, which falls inside
/// this - so the head a player aims at is the head they hit. Narrower than
/// the shoulders because a head is, and because a head-sized target that is
/// shoulder-width is not a head, it is a bonus for hitting the body.
pub const HEAD_BOTTOM: f32 = 0.62;
pub const HEAD_HALF_WIDTH: f32 = 0.22;

// The regions have to describe a body, and these are the relationships that
// make them one. Checked at compile time rather than in a test because they
// are relationships between constants: a build with the eye outside the head
// box should not exist, rather than exist and fail its tests.
const _: () = {
    // A player aims at the head they can see, which is drawn around the
    // camera. An eye outside the head box means aiming at somebody's face is
    // a body shot, and nobody would ever work out why.
    assert!(EYE_OFFSET > HEAD_BOTTOM);
    assert!(EYE_OFFSET < PLAYER_HALF_EXTENTS.y);
    // Legs below the waist, waist below the head, head inside the box.
    assert!(LEGS_TOP > -PLAYER_HALF_EXTENTS.y);
    assert!(LEGS_TOP < HEAD_BOTTOM);
    assert!(HEAD_HALF_WIDTH < PLAYER_HALF_EXTENTS.x);
};

/// Longest display name the server will keep.
///
/// Short on purpose. A name has to fit a killfeed line and a scoreboard
/// column next to somebody else's, and the alternative to a limit here is
/// truncation somewhere in the client where it is a layout bug rather than a
/// rule.
pub const MAX_NAME_LEN: usize = 16;

/// Reduce a name a client asked for to one the server is willing to show.
///
/// Cosmetic, and treated as hostile input anyway. The rules, and why:
///
/// * Runs of whitespace collapse to one space, and the ends are trimmed. A
///   name of forty spaces is a blank row in the scoreboard that still takes a
///   slot, and one with a leading space sorts above everybody. Whitespace is
///   tested *before* control characters and that order matters: a tab and a
///   newline are both, and dropping them outright turns "big\tred" into
///   "bigred" rather than into the two words somebody typed.
/// * Every other control character goes. They are not display, they are a way
///   to forge a second killfeed line or break a log.
/// * Length is counted in `char`s and cut on a `char` boundary, not in bytes.
///   Cutting UTF-8 mid-sequence produces a string Rust will not build and
///   serde will not send.
/// * Anything left empty becomes a stable fallback rather than an error. A
///   player who sends a blank name wants to play, not to be rejected.
///
/// It lives in the shared crate so the client can apply the same rules to the
/// name box before sending, and show the player what the server is going to
/// make of it rather than surprising them afterwards.
pub fn sanitise_name(requested: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(MAX_NAME_LEN);
    let mut pending_space = false;
    for ch in requested.chars() {
        if ch.is_whitespace() {
            // Only ever recorded when something real follows it, which trims
            // both ends and collapses the middle in one pass.
            pending_space = !out.is_empty();
            continue;
        }
        if ch.is_control() {
            continue;
        }
        if pending_space {
            if out.chars().count() + 1 >= MAX_NAME_LEN {
                break;
            }
            out.push(' ');
            pending_space = false;
        }
        if out.chars().count() >= MAX_NAME_LEN {
            break;
        }
        out.push(ch);
    }
    if out.is_empty() {
        fallback.to_string()
    } else {
        out
    }
}

// --- The match, and the circle it is played in --------------------------

/// How long one match runs before it is over and paid out.
pub const MATCH_DURATION: f32 = 300.0;

/// How often the circle takes a step inward.
pub const ZONE_STEP: f32 = 60.0;

/// How long each of those steps takes to travel.
///
/// Not instant. An instant step would put whoever was standing there outside
/// the boundary with no warning, and - because the zone is a wall rather than
/// damage - would shove them several metres in one tick. Twenty seconds of
/// closing at a walking pace is something a player can see coming and move
/// out of the way of, which is the whole point of it.
pub const ZONE_SHRINK_TIME: f32 = 20.0;

/// How many times it closes. The last one finishes with a minute to go, so
/// the end of a match is a fight in a small circle rather than a scramble.
pub const ZONE_STAGES: f32 = 4.0;

/// Where it stops. Big enough for a fight, small enough that nobody hides.
pub const ZONE_FINAL_RADIUS: f32 = 12.0;

/// How fast a player outside the circle is pushed back towards it.
///
/// Half of running speed. Firm enough that standing still and ignoring it is
/// not an option, gentle enough that being caught by the edge is a nudge
/// rather than being fired out of a cannon.
pub const ZONE_PUSH_SPEED: f32 = 4.0;

/// The circle players are kept inside, centred on the map's origin.
///
/// It does no damage. Conrad's call, and a good one: a zone that kills is a
/// second way to die that nobody is paid for, and in a game where a kill is
/// somebody's win, a death that pays nobody is money leaving the table. This
/// one only ever pushes, so every death in a match is still a kill with a
/// name on it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Zone {
    /// Metres from the origin. Infinite for no limit at all.
    pub radius: f32,
}

impl Zone {
    /// No limit. What a caller that is not about the zone passes.
    pub const OPEN: Zone = Zone {
        radius: f32::INFINITY,
    };
}

/// The circle, this many seconds into a match.
///
/// Pure, and shared, so that the server deciding where the wall is and the
/// client predicting against it are the same sentence rather than two
/// implementations that have to be kept in step.
///
/// `full` is the radius that covers the whole map - taken from the map's own
/// half-extents - so that the first minute is played with no limit at all and
/// the constraint only ever arrives as something that changes.
pub fn zone_at(full: f32, elapsed: f32) -> Zone {
    let minute = (elapsed / ZONE_STEP).floor();
    if minute < 1.0 {
        return Zone { radius: full };
    }
    // How many closings have finished or are under way, as a fraction. The
    // first closing begins one minute in, which is why this counts from
    // `minute - 1`.
    let started = (minute - 1.0).min(ZONE_STAGES - 1.0);
    let into = elapsed - minute * ZONE_STEP;
    let travelling = if minute > ZONE_STAGES {
        1.0
    } else {
        (into / ZONE_SHRINK_TIME).clamp(0.0, 1.0)
    };
    let progress = ((started + travelling) / ZONE_STAGES).clamp(0.0, 1.0);
    // Never past the map it is drawn on. On a map already smaller than the
    // final circle - a test fixture, or a very small arena - interpolating
    // towards `ZONE_FINAL_RADIUS` would make the circle *grow*, which is
    // harmless and absurd. It simply never closes there instead.
    let target = ZONE_FINAL_RADIUS.min(full);
    Zone {
        radius: full + (target - full) * progress,
    }
}

/// Minimum seconds between shots.
pub const WEAPON_FIRE_INTERVAL: f32 = 0.12;

/// Beyond this, shots do not register at all.
pub const WEAPON_RANGE: f32 = 120.0;

// --- State and input -----------------------------------------------------

/// Everything the simulation needs to know about one player.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PlayerState {
    pub position: Vec3,
    pub velocity: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub on_ground: bool,
    pub health: i16,
}

impl PlayerState {
    pub fn spawned_at(spawn: map::Spawn) -> Self {
        Self {
            position: spawn.position,
            velocity: Vec3::ZERO,
            yaw: spawn.yaw,
            pitch: 0.0,
            on_ground: false,
            health: MAX_HEALTH,
        }
    }

    pub fn is_alive(&self) -> bool {
        self.health > 0
    }

    /// Where this player's eyes are. Shots originate here.
    pub fn eye_position(&self) -> Vec3 {
        self.position + Vec3::new(0.0, EYE_OFFSET, 0.0)
    }

    /// Unit vector the player is looking along.
    pub fn look_direction(&self) -> Vec3 {
        look_direction(self.yaw, self.pitch)
    }
}

/// Buttons held during one input command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Buttons(pub u8);

impl Buttons {
    pub const JUMP: u8 = 1 << 0;
    pub const FIRE: u8 = 1 << 1;

    pub const fn empty() -> Self {
        Self(0)
    }

    pub const fn contains(self, bit: u8) -> bool {
        self.0 & bit != 0
    }

    pub fn set(&mut self, bit: u8, held: bool) {
        if held {
            self.0 |= bit;
        } else {
            self.0 &= !bit;
        }
    }

    pub const fn jump(self) -> bool {
        self.contains(Self::JUMP)
    }

    pub const fn fire(self) -> bool {
        self.contains(Self::FIRE)
    }
}

/// One tick of player intent.
///
/// This is a *request*, not a report. The server decides what it produces. In
/// particular the server never takes a position from the client - only which
/// direction they were pushing and where they were looking.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct InputCommand {
    /// Increments by one per command, per connection. The server acknowledges
    /// the last one it consumed so the client knows what to re-predict from.
    pub seq: u32,
    /// Forward/back intent, -1..=1.
    pub forward: f32,
    /// Strafe intent, -1..=1.
    pub right: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub buttons: Buttons,
}

impl InputCommand {
    /// Clamps a command into the range the simulation is defined over.
    ///
    /// The server calls this on everything it receives. A client is free to
    /// send `forward: 1e30` or a NaN yaw; this is what makes that pointless
    /// rather than dangerous.
    pub fn sanitized(mut self) -> Self {
        self.forward = clamp_finite(self.forward, -1.0, 1.0);
        self.right = clamp_finite(self.right, -1.0, 1.0);
        self.yaw = if self.yaw.is_finite() {
            wrap_angle(self.yaw)
        } else {
            0.0
        };
        self.pitch = clamp_finite(self.pitch, -MAX_PITCH, MAX_PITCH);
        self
    }
}

fn clamp_finite(value: f32, min: f32, max: f32) -> f32 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        0.0
    }
}

/// Wraps an angle into -PI..=PI.
pub fn wrap_angle(angle: f32) -> f32 {
    use std::f32::consts::{PI, TAU};
    let wrapped = angle.rem_euclid(TAU);
    if wrapped > PI { wrapped - TAU } else { wrapped }
}

/// Unit look vector for a yaw/pitch pair.
///
/// Bevy's convention: -Z is forward, +Y is up, +X is right.
pub fn look_direction(yaw: f32, pitch: f32) -> Vec3 {
    let (sin_yaw, cos_yaw) = yaw.sin_cos();
    let (sin_pitch, cos_pitch) = pitch.sin_cos();
    Vec3::new(-sin_yaw * cos_pitch, sin_pitch, -cos_yaw * cos_pitch)
}

// --- The simulation ------------------------------------------------------

/// Advances one player by one tick.
///
/// `dt` is a parameter rather than a constant only so tests can explore other
/// step sizes; in production both sides pass [`TICK_DT`].
pub fn step(state: &mut PlayerState, input: &InputCommand, map: &Map, zone: Zone, dt: f32) {
    state.yaw = input.yaw;
    state.pitch = input.pitch;

    if !state.is_alive() {
        // The dead do not move, but they still fall, so a body does not hang in
        // the air where it died.
        state.velocity.x = 0.0;
        state.velocity.z = 0.0;
        apply_gravity(state, dt);
        integrate(state, map, dt);
        return;
    }

    let wish_direction = wish_direction(input);

    if state.on_ground {
        apply_friction(state, dt);
        accelerate(state, wish_direction, MAX_GROUND_SPEED, GROUND_ACCEL, dt);

        if input.buttons.jump() {
            state.velocity.y = JUMP_SPEED;
            state.on_ground = false;
        }
    } else {
        accelerate(state, wish_direction, MAX_AIR_SPEED, AIR_ACCEL, dt);
    }

    if !state.on_ground {
        apply_gravity(state, dt);
    }

    // Before the move, not after. Constraining the velocity here means the
    // player never crosses the boundary in the first place; doing it
    // afterwards would let them step through by a tick's worth of travel and
    // then be dragged back, which reads as the wall stuttering.
    apply_zone(state, zone);

    integrate(state, map, dt);
}

/// Keeps a player inside the match's circle.
///
/// Two behaviours, and they are different situations rather than two halves
/// of one rule. A player pressing against the edge simply loses the outward
/// part of their movement - the zone is a wall, and walking into a wall stops
/// you rather than shoving you. A player who is *outside* it, because the
/// circle shrank past them while they were standing still, is pushed back in
/// at a fixed speed until they are not.
///
/// It never touches `y`. Falling is not something the zone has an opinion on,
/// and a push that fought gravity would hold a player up in mid-air at the
/// boundary.
fn apply_zone(state: &mut PlayerState, zone: Zone) {
    if !zone.radius.is_finite() {
        return;
    }
    let here = Vec2::new(state.position.x, state.position.z);
    let distance = here.length();
    // Dead centre. There is no outward direction to speak of, and nothing
    // that needs one.
    if distance < 1e-3 {
        return;
    }
    let outward = here / distance;
    let radial = Vec2::new(state.velocity.x, state.velocity.z).dot(outward);

    if distance > zone.radius {
        // Outside, and the circle is not coming back. Overrides whatever
        // they were doing, including running further out.
        if radial > -ZONE_PUSH_SPEED {
            let correction = -ZONE_PUSH_SPEED - radial;
            state.velocity.x += outward.x * correction;
            state.velocity.z += outward.y * correction;
        }
    } else if radial > 0.0 && distance > zone.radius - PLAYER_HALF_EXTENTS.x {
        // At the edge and pushing outward. That component goes; anything
        // along the boundary is left alone, so a player can still run around
        // the inside of it rather than sticking.
        state.velocity.x -= outward.x * radial;
        state.velocity.z -= outward.y * radial;
    }
}

/// The direction the player is asking to move, in world space, on the XZ plane.
fn wish_direction(input: &InputCommand) -> Vec3 {
    let (sin_yaw, cos_yaw) = input.yaw.sin_cos();
    // Forward on the ground plane, ignoring pitch: looking at the sky should
    // not slow you down.
    let forward = Vec3::new(-sin_yaw, 0.0, -cos_yaw);
    let right = Vec3::new(cos_yaw, 0.0, -sin_yaw);

    let wish = forward * input.forward + right * input.right;
    // Normalising means diagonal movement is not faster than straight movement.
    wish.normalize_or_zero()
}

fn apply_friction(state: &mut PlayerState, dt: f32) {
    let horizontal = Vec2::new(state.velocity.x, state.velocity.z);
    let speed = horizontal.length();
    if speed <= 0.0 {
        return;
    }

    let control = speed.max(STOP_SPEED);
    let drop = control * FRICTION * dt;
    let new_speed = (speed - drop).max(0.0);

    let scale = new_speed / speed;
    state.velocity.x *= scale;
    state.velocity.z *= scale;
}

/// Quake-style acceleration.
///
/// Speed is only added up to `max_speed` *along the wish direction*, which is
/// what lets a player keep speed they already have while turning, instead of
/// being clamped to a hard speed cap every tick.
fn accelerate(state: &mut PlayerState, wish_direction: Vec3, max_speed: f32, accel: f32, dt: f32) {
    if wish_direction == Vec3::ZERO {
        return;
    }

    let current_speed = state.velocity.x * wish_direction.x + state.velocity.z * wish_direction.z;
    let add_speed = max_speed - current_speed;
    if add_speed <= 0.0 {
        return;
    }

    let accel_speed = (accel * max_speed * dt).min(add_speed);
    state.velocity.x += wish_direction.x * accel_speed;
    state.velocity.z += wish_direction.z * accel_speed;
}

fn apply_gravity(state: &mut PlayerState, dt: f32) {
    state.velocity.y -= GRAVITY * dt;
}

fn integrate(state: &mut PlayerState, map: &Map, dt: f32) {
    let result = collide::move_and_slide(
        state.position,
        PLAYER_HALF_EXTENTS,
        state.velocity * dt,
        map,
    );

    state.position = result.position;
    state.on_ground = result.on_ground;

    // Velocity into a surface has to be discarded, or it accumulates while the
    // player is pressed against a wall and fires them off when they step clear.
    if result.blocked_x {
        state.velocity.x = 0.0;
    }
    if result.blocked_y {
        state.velocity.y = 0.0;
    }
    if result.blocked_z {
        state.velocity.z = 0.0;
    }
}

/// Convenience for callers stepping at the canonical rate.
pub fn step_tick(state: &mut PlayerState, input: &InputCommand, map: &Map, zone: Zone) {
    step(state, input, map, zone, TICK_DT);
}

#[cfg(test)]
mod tests {
    use super::*;
    use map::{Brush, Spawn, TEST_MAP};

    // Movement feel is tested on open ground, not on the real map. Running a
    // speed test next to a wall measures the wall, not the movement - which is
    // exactly the mistake the first version of these tests made.
    static FLAT_BRUSHES: &[Brush] = &[Brush::new(
        Vec3::new(-500.0, -1.0, -500.0),
        Vec3::new(500.0, 0.0, 500.0),
    )];
    static FLAT_SPAWNS: &[Spawn] = &[Spawn {
        position: Vec3::new(0.0, 2.0, 0.0),
        yaw: 0.0,
    }];
    static FLAT_MAP: Map = Map::fixture(FLAT_BRUSHES, FLAT_SPAWNS);

    fn grounded_player() -> PlayerState {
        let mut state = PlayerState::spawned_at(FLAT_MAP.spawn(0));
        // Let them fall onto the floor first.
        for _ in 0..120 {
            step_tick(&mut state, &idle(), &FLAT_MAP, Zone::OPEN);
        }
        assert!(state.on_ground, "test setup: player should have landed");
        state
    }

    fn idle() -> InputCommand {
        InputCommand {
            seq: 0,
            forward: 0.0,
            right: 0.0,
            yaw: 0.0,
            pitch: 0.0,
            buttons: Buttons::empty(),
        }
    }

    fn running_forward() -> InputCommand {
        InputCommand {
            forward: 1.0,
            ..idle()
        }
    }

    #[test]
    fn a_player_falls_and_lands() {
        let state = grounded_player();
        assert!(state.on_ground);
        assert!(
            state.velocity.y.abs() < 0.001,
            "should be at rest vertically"
        );
    }

    #[test]
    fn running_reaches_top_speed_but_not_beyond() {
        let mut state = grounded_player();
        for _ in 0..200 {
            step_tick(&mut state, &running_forward(), &FLAT_MAP, Zone::OPEN);
        }
        let speed = Vec2::new(state.velocity.x, state.velocity.z).length();
        assert!(
            (speed - MAX_GROUND_SPEED).abs() < 0.5,
            "expected about {MAX_GROUND_SPEED} m/s, got {speed}"
        );
    }

    #[test]
    fn diagonal_movement_is_not_faster_than_straight() {
        let mut straight = grounded_player();
        let mut diagonal = grounded_player();
        for _ in 0..200 {
            step_tick(&mut straight, &running_forward(), &FLAT_MAP, Zone::OPEN);
            step_tick(
                &mut diagonal,
                &InputCommand {
                    forward: 1.0,
                    right: 1.0,
                    ..idle()
                },
                &FLAT_MAP,
                Zone::OPEN,
            );
        }
        let straight_speed = Vec2::new(straight.velocity.x, straight.velocity.z).length();
        let diagonal_speed = Vec2::new(diagonal.velocity.x, diagonal.velocity.z).length();
        assert!(
            diagonal_speed <= straight_speed + 0.01,
            "diagonal {diagonal_speed} outran straight {straight_speed}"
        );
    }

    #[test]
    fn releasing_the_controls_brings_a_player_to_a_stop() {
        let mut state = grounded_player();
        for _ in 0..100 {
            step_tick(&mut state, &running_forward(), &FLAT_MAP, Zone::OPEN);
        }
        for _ in 0..200 {
            step_tick(&mut state, &idle(), &FLAT_MAP, Zone::OPEN);
        }
        let speed = Vec2::new(state.velocity.x, state.velocity.z).length();
        assert!(speed < 0.05, "player kept sliding at {speed} m/s");
    }

    #[test]
    fn jumping_leaves_the_ground_and_returns_to_it() {
        let mut state = grounded_player();
        let jump = InputCommand {
            buttons: Buttons(Buttons::JUMP),
            ..idle()
        };
        step_tick(&mut state, &jump, &FLAT_MAP, Zone::OPEN);
        assert!(!state.on_ground, "should be airborne right after jumping");

        let peak_start = state.position.y;
        let mut peak = peak_start;
        for _ in 0..200 {
            step_tick(&mut state, &idle(), &FLAT_MAP, Zone::OPEN);
            peak = peak.max(state.position.y);
        }
        assert!(state.on_ground, "should have landed again");
        assert!(
            peak - peak_start > 0.8,
            "jump only cleared {:.2} m",
            peak - peak_start
        );
    }

    #[test]
    fn the_simulation_is_reproducible() {
        // The same inputs from the same state must produce the same state, or
        // client prediction and server authority can never agree.
        let inputs: Vec<InputCommand> = (0..120)
            .map(|i| InputCommand {
                seq: i,
                forward: 1.0,
                right: if i % 3 == 0 { 1.0 } else { -1.0 },
                yaw: i as f32 * 0.03,
                pitch: 0.1,
                buttons: if i % 17 == 0 {
                    Buttons(Buttons::JUMP)
                } else {
                    Buttons::empty()
                },
            })
            .collect();

        let run = || {
            let mut state = grounded_player();
            for input in &inputs {
                step_tick(&mut state, input, &FLAT_MAP, Zone::OPEN);
            }
            state
        };

        assert_eq!(run(), run(), "identical inputs produced different states");
    }

    #[test]
    fn a_player_never_ends_a_tick_inside_geometry() {
        // This one deliberately uses the real map: the point is the geometry.
        let mut state = PlayerState::spawned_at(TEST_MAP.spawn(0));
        for _ in 0..120 {
            step_tick(&mut state, &idle(), &TEST_MAP, Zone::OPEN);
        }
        for i in 0..600 {
            let input = InputCommand {
                seq: i,
                forward: 1.0,
                right: ((i / 30) % 3) as f32 - 1.0,
                yaw: i as f32 * 0.05,
                pitch: 0.0,
                buttons: if i % 23 == 0 {
                    Buttons(Buttons::JUMP)
                } else {
                    Buttons::empty()
                },
            };
            step_tick(&mut state, &input, &TEST_MAP, Zone::OPEN);
            assert!(
                !collide::overlaps_any(state.position, PLAYER_HALF_EXTENTS, &TEST_MAP),
                "tick {i}: player ended inside geometry at {:?}",
                state.position
            );
        }
    }

    #[test]
    fn hostile_input_cannot_break_the_simulation() {
        let mut state = grounded_player();
        let hostile = InputCommand {
            seq: 0,
            forward: 1e30,
            right: f32::NAN,
            yaw: f32::INFINITY,
            pitch: -1e9,
            buttons: Buttons(0xFF),
        }
        .sanitized();

        for _ in 0..200 {
            step_tick(&mut state, &hostile, &FLAT_MAP, Zone::OPEN);
            assert!(
                state.position.is_finite(),
                "position became {:?}",
                state.position
            );
            assert!(state.velocity.is_finite());
        }
        assert!(
            !collide::overlaps_any(state.position, PLAYER_HALF_EXTENTS, &FLAT_MAP),
            "hostile input pushed the player into geometry"
        );
    }

    #[test]
    fn a_name_is_trimmed_bounded_and_never_empty() {
        assert_eq!(sanitise_name("  Conrad  ", "fallback"), "Conrad");
        assert_eq!(sanitise_name("a\t\t\tb", "fallback"), "a b");
        // Nothing but whitespace is not a name, however much of it there is.
        assert_eq!(sanitise_name("        ", "fallback"), "fallback");
        assert_eq!(sanitise_name("", "fallback"), "fallback");
        // A newline would be a second line in the killfeed, and a null would
        // be a surprise for whatever reads the log. The newline is whitespace
        // as well as a control character, so it becomes the space it looks
        // like rather than vanishing and welding the two words together.
        assert_eq!(sanitise_name("evil\nname", "fallback"), "evil name");
        assert_eq!(sanitise_name("tab\u{0}here", "fallback"), "tabhere");
        // Bounded, and counted in characters.
        let long = sanitise_name(&"x".repeat(200), "fallback");
        assert_eq!(long.chars().count(), MAX_NAME_LEN);
    }

    #[test]
    fn a_name_is_cut_on_a_character_boundary() {
        // Cutting UTF-8 by bytes produces a string that will not build. Every
        // one of these is multi-byte, so a byte-wise limit would land inside
        // a sequence for at least one of them.
        for text in [
            "ありがとうありがとうありがとう",
            "ééééééééééééééééééé",
            "🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂",
        ] {
            let cut = sanitise_name(text, "fallback");
            assert!(cut.chars().count() <= MAX_NAME_LEN, "{cut:?}");
            // Round-tripping proves the bytes are still valid UTF-8.
            assert_eq!(cut, String::from_utf8(cut.clone().into_bytes()).unwrap());
        }
    }

    #[test]
    fn the_regions_give_the_shots_to_kill_they_claim() {
        // These are the design, and the numbers are meant to be read off
        // here rather than worked out: two to the head, three to the body,
        // four to the legs.
        for (region, expected) in [
            (HitRegion::Head, 2),
            (HitRegion::Body, 4),
            (HitRegion::Legs, 5),
        ] {
            let mut health = MAX_HEALTH;
            let mut shots = 0;
            while health > 0 {
                health -= region.damage();
                shots += 1;
                assert!(shots < 20, "{region:?} never kills");
            }
            assert_eq!(shots, expected, "{region:?} took {shots} shots");
        }
    }

    #[test]
    fn a_headshot_is_worth_more_than_a_body_shot_but_is_not_a_kill() {
        assert!(HitRegion::Head.damage() > HitRegion::Body.damage());
        assert!(HitRegion::Body.damage() > HitRegion::Legs.damage());
        // A one-shot kill would mean whoever saw the other first wins
        // outright, with nothing to play for in between.
        assert!(
            HitRegion::Head.damage() < MAX_HEALTH,
            "a headshot should not end a life on its own"
        );
    }

    #[test]
    fn the_first_minute_is_played_on_the_whole_map() {
        // The circle is meant to arrive as something that changes, not as a
        // wall that was there from the start. A map's own full radius covers
        // its corners, so at this size it constrains nothing.
        let full = 100.0;
        for t in [0.0, 1.0, 30.0, 59.9] {
            assert_eq!(zone_at(full, t).radius, full, "constrained at {t}s");
        }
    }

    #[test]
    fn the_circle_closes_once_a_minute_and_then_stops() {
        let full = 100.0;
        // Each closing takes ZONE_SHRINK_TIME and then holds until the next
        // minute, so a player has most of every minute to settle.
        let after_first = zone_at(full, ZONE_STEP + ZONE_SHRINK_TIME).radius;
        let held = zone_at(full, ZONE_STEP + ZONE_SHRINK_TIME + 10.0).radius;
        assert!(
            after_first < full,
            "the first minute did not close anything"
        );
        assert_eq!(after_first, held, "the circle kept closing through a hold");

        // Monotonic the whole way down, and never past the final radius.
        let mut previous = full;
        let mut t = 0.0;
        while t <= MATCH_DURATION {
            let radius = zone_at(full, t).radius;
            assert!(radius <= previous + 1e-3, "the circle grew at {t}s");
            assert!(radius >= ZONE_FINAL_RADIUS - 1e-3, "overshot at {t}s");
            previous = radius;
            t += 0.5;
        }

        // Fully closed before the end, so the last stretch is a fight rather
        // than a scramble.
        let closed_at = ZONE_STAGES * ZONE_STEP + ZONE_SHRINK_TIME;
        assert!(closed_at < MATCH_DURATION);
        assert!((zone_at(full, closed_at).radius - ZONE_FINAL_RADIUS).abs() < 1e-3);
        assert!((zone_at(full, MATCH_DURATION).radius - ZONE_FINAL_RADIUS).abs() < 1e-3);
    }

    #[test]
    fn a_map_smaller_than_the_final_circle_is_never_constrained() {
        // A fixture map, or a very small one. The circle should not close in
        // past the map and pin everybody into a point.
        let tiny = ZONE_FINAL_RADIUS / 2.0;
        for t in [0.0, 120.0, MATCH_DURATION] {
            // Neither squeezed nor, absurdly, grown past the map it is on.
            assert_eq!(
                zone_at(tiny, t).radius,
                tiny,
                "a map smaller than the final circle was resized at {t}s"
            );
        }
    }

    #[test]
    fn the_zone_stops_a_player_walking_out_of_it() {
        // Running flat out at the boundary, for long enough that anything
        // leaky would show. The wall holds rather than the player drifting
        // through it a tick at a time.
        let zone = Zone { radius: 6.0 };
        let mut state = grounded_player();
        let mut running = running_forward();
        // Face +X so "forward" is straight at the wall.
        running.yaw = -std::f32::consts::FRAC_PI_2;
        for _ in 0..400 {
            step_tick(&mut state, &running, &FLAT_MAP, zone);
        }
        let out = Vec2::new(state.position.x, state.position.z).length();
        assert!(
            out <= zone.radius + 0.05,
            "a player ran {out:.2} m out of a {} m circle",
            zone.radius
        );
    }

    #[test]
    fn the_zone_pushes_back_a_player_it_closed_past() {
        // Standing still, well outside, as though the circle had shrunk over
        // them. It does not kill them and it does not teleport them: it
        // walks them back in.
        let zone = Zone { radius: 5.0 };
        let mut state = grounded_player();
        state.position.x = 30.0;
        let start = state.position.x;

        step_tick(&mut state, &idle(), &FLAT_MAP, zone);
        assert!(
            state.position.x < start,
            "a player outside the circle was not moved towards it"
        );
        assert!(
            state.health > 0,
            "the circle killed somebody, which it must never do"
        );

        for _ in 0..600 {
            step_tick(&mut state, &idle(), &FLAT_MAP, zone);
        }
        let out = Vec2::new(state.position.x, state.position.z).length();
        assert!(
            out <= zone.radius + 0.5,
            "a player left {out:.2} m outside a {} m circle",
            zone.radius
        );
    }

    #[test]
    fn the_zone_leaves_movement_along_it_alone() {
        // Pressed against the edge and running around it rather than at it.
        // Removing the whole velocity would make the boundary sticky; only
        // the part pointing out of it goes.
        let zone = Zone { radius: 6.0 };
        let mut state = grounded_player();
        state.position.x = 5.9;
        let mut sideways = running_forward();
        // Facing -Z, which at x = 5.9 is a tangent to the circle.
        sideways.yaw = 0.0;

        for _ in 0..64 {
            step_tick(&mut state, &sideways, &FLAT_MAP, zone);
        }
        assert!(
            state.position.z.abs() > 2.0,
            "a player hugging the boundary could not move along it"
        );
    }

    #[test]
    fn look_direction_matches_bevy_conventions() {
        // Yaw 0, pitch 0 looks down -Z.
        let forward = look_direction(0.0, 0.0);
        assert!((forward - Vec3::NEG_Z).length() < 1e-5, "got {forward:?}");

        // Pitching up gives +Y.
        assert!(look_direction(0.0, 1.0).y > 0.0);

        // All look directions are unit length.
        for i in 0..50 {
            let dir = look_direction(i as f32 * 0.3, (i as f32 * 0.1).sin());
            assert!((dir.length() - 1.0).abs() < 1e-5);
        }
    }
}
