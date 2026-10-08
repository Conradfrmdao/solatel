//! The shared movement simulation, exposed to the JavaScript client.
//!
//! # Why this crate exists
//!
//! `solatel-protocol::sim` is compiled into the server, and the client has to
//! run *the same code* over the same input or prediction cannot settle. When
//! the client was Rust that was free. Now it is JavaScript, and there are only
//! three ways to keep the property:
//!
//! * translate the simulation into JavaScript and hope the two stay in step,
//! * give up prediction and put the player's whole ping into every keypress,
//! * or compile the one definition to wasm and call it from JavaScript.
//!
//! This is the third. It is a few hundred kilobytes rather than the eighty
//! megabytes the whole engine cost, and it keeps the rule this codebase is
//! built on: there is exactly one description of how a player moves, and both
//! sides execute it rather than agreeing to behave similarly.
//!
//! # Shape of the interface
//!
//! Flat `f32` arguments and getters, not structs marshalled through serde. This
//! is called sixty-four times a second, and again for every unacknowledged
//! command each time a snapshot lands - a few hundred calls a second in normal
//! play. Numbers crossing the boundary as plain scalars cost nothing; JSON
//! would not.
//!
//! The map goes the other way. `brushes()` and `spawns()` hand JavaScript the
//! collision geometry the server is actually using, so the client cannot
//! predict against a map that no longer exists. Drawing the arena model is a
//! separate matter - that is art, and this is truth.

use solatel_protocol::{
    net::{INTERPOLATION_DELAY_MS, PROTOCOL_VERSION, SNAPSHOT_HZ, TICK_DT, TICK_HZ},
    sim::{
        Buttons, CROUCH_DROP, EYE_OFFSET, GRENADE_FUSE, GRENADE_RADIUS, GRENADES_PER_LIFE,
        InputCommand, MAX_HEALTH, MAX_PITCH, PLAYER_HALF_EXTENTS, PlayerState, REGEN_DELAY,
        REGEN_SECONDS, ZONE_FINAL_RADIUS,
        hitscan,
        map::{self, MAP_VERSION},
        step_tick,
        weapon::{BULLET_GRAVITY, Optic, Round, Weapon},
    },
};
use wasm_bindgen::prelude::*;

/// One player's predicted state, advanced a tick at a time.
///
/// Held on this side of the boundary rather than passed in and out, so a replay
/// of eight commands is eight scalar calls rather than eight round trips
/// through a serialiser.
#[wasm_bindgen]
pub struct Predictor {
    state: PlayerState,
}

#[wasm_bindgen]
impl Predictor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            state: PlayerState::spawned_at(map::active().spawn(0)),
        }
    }

    /// Adopts the server's answer, wholesale.
    ///
    /// This is the reconciliation step: whatever the client believed, the
    /// server's state replaces it, and the commands it has not yet seen are
    /// then re-applied on top with `step`.
    #[allow(clippy::too_many_arguments)]
    pub fn adopt(
        &mut self,
        x: f32,
        y: f32,
        z: f32,
        vx: f32,
        vy: f32,
        vz: f32,
        yaw: f32,
        pitch: f32,
        on_ground: bool,
        health: i16,
        crouched: bool,
    ) {
        self.state.position = glam_vec(x, y, z);
        self.state.velocity = glam_vec(vx, vy, vz);
        self.state.yaw = yaw;
        self.state.pitch = pitch;
        self.state.on_ground = on_ground;
        self.state.health = health;
        self.state.crouched = crouched;
    }

    /// Advances one tick over one command.
    ///
    /// `buttons` is the same bitfield the wire carries: bit 0 jump, bit 1 fire.
    /// The command is sanitised exactly as the server sanitises it, so a bug in
    /// the JavaScript that produced it diverges here rather than silently
    /// predicting something the server will never agree to.
    /// The match circle is not an argument: it no longer moves anybody. It
    /// burns whoever is outside it, and that is the server's to decide.
    pub fn step(&mut self, forward: f32, right: f32, yaw: f32, pitch: f32, buttons: u8) {
        let command = InputCommand {
            seq: 0,
            forward,
            right,
            yaw,
            pitch,
            buttons: Buttons(buttons),
        }
        .sanitized();
        step_tick(&mut self.state, &command, map::active());
    }

    #[wasm_bindgen(getter)]
    pub fn x(&self) -> f32 {
        self.state.position.x
    }
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> f32 {
        self.state.position.y
    }
    #[wasm_bindgen(getter)]
    pub fn z(&self) -> f32 {
        self.state.position.z
    }
    #[wasm_bindgen(getter)]
    pub fn vx(&self) -> f32 {
        self.state.velocity.x
    }
    #[wasm_bindgen(getter)]
    pub fn vy(&self) -> f32 {
        self.state.velocity.y
    }
    #[wasm_bindgen(getter)]
    pub fn vz(&self) -> f32 {
        self.state.velocity.z
    }
    #[wasm_bindgen(getter)]
    pub fn on_ground(&self) -> bool {
        self.state.on_ground
    }
    #[wasm_bindgen(getter)]
    pub fn crouched(&self) -> bool {
        self.state.crouched
    }

    /// Eye height above the body's centre, lower when crouched.
    #[wasm_bindgen(getter)]
    pub fn eye_offset(&self) -> f32 {
        self.state.eye_offset()
    }

    #[wasm_bindgen(getter)]
    pub fn health(&self) -> i16 {
        self.state.health
    }

    /// Horizontal speed, which is what picks a walk or a run animation.
    #[wasm_bindgen(getter)]
    pub fn speed(&self) -> f32 {
        let v = self.state.velocity;
        (v.x * v.x + v.z * v.z).sqrt()
    }
}

impl Default for Predictor {
    fn default() -> Self {
        Self::new()
    }
}

fn glam_vec(x: f32, y: f32, z: f32) -> glam::Vec3 {
    glam::Vec3::new(x, y, z)
}

/// Points this client at the map its next match is played on.
///
/// Returns false if the build has no such map, which means the client is
/// older or newer than the server and should say so rather than quietly
/// predicting against the wrong arena.
///
/// Called **between matches**, not during one. Several matches run at once on
/// the server and they are not all on the same map, so a client goes wherever
/// the match it has just been put into is - and it has no world state to
/// carry across, because a match is a fresh start. Changing this while a
/// match was running would be a player walking through a wall the server
/// still believes in, which is the failure the whole design exists to
/// prevent, and it is the caller's job not to do that.
#[wasm_bindgen]
pub fn select_map(name: &str) -> bool {
    map::switch(name)
}

/// The name of the map actually in use, after selection.
#[wasm_bindgen]
pub fn map_name() -> String {
    map::active().name.to_string()
}

/// The active map's collision geometry, flattened.
///
/// Six floats per brush: minimum corner then maximum corner. The client
/// predicts against these, so they are read from the same table the server
/// collides against rather than derived a second time from the model.
#[wasm_bindgen]
pub fn brushes() -> Vec<f32> {
    let active = map::active();
    let mut out = Vec::with_capacity(active.brushes.len() * 6);
    for brush in active.brushes {
        out.extend_from_slice(&[
            brush.min.x,
            brush.min.y,
            brush.min.z,
            brush.max.x,
            brush.max.y,
            brush.max.z,
        ]);
    }
    out
}

/// Spawn points, flattened: x, y, z, yaw.
#[wasm_bindgen]
pub fn spawns() -> Vec<f32> {
    let active = map::active();
    let mut out = Vec::with_capacity(active.spawns.len() * 4);
    for spawn in active.spawns {
        out.extend_from_slice(&[
            spawn.position.x,
            spawn.position.y,
            spawn.position.z,
            spawn.yaw,
        ]);
    }
    out
}

/// Every number the client needs to agree with the server about, flattened in
/// a fixed order. `constant_names()` documents that order.
#[wasm_bindgen]
pub fn constants() -> Vec<f32> {
    vec![
        PROTOCOL_VERSION as f32,
        MAP_VERSION as f32,
        TICK_HZ as f32,
        TICK_DT,
        SNAPSHOT_HZ as f32,
        INTERPOLATION_DELAY_MS,
        PLAYER_HALF_EXTENTS.x,
        PLAYER_HALF_EXTENTS.y,
        PLAYER_HALF_EXTENTS.z,
        EYE_OFFSET,
        MAX_PITCH,
        MAX_HEALTH as f32,
        CROUCH_DROP,
        GRENADES_PER_LIFE as f32,
        GRENADE_FUSE,
        GRENADE_RADIUS,
        REGEN_DELAY,
        REGEN_SECONDS,
        map::active().scale,
        map::active().half_x,
        map::active().half_z,
        ZONE_FINAL_RADIUS,
        BULLET_GRAVITY,
    ]
}

/// Names for `constants()`, in the same order, so the client can build a named
/// object and a mismatch shows up as a missing key rather than a wrong number.
#[wasm_bindgen]
pub fn constant_names() -> Vec<String> {
    [
        "protocolVersion",
        "mapVersion",
        "tickHz",
        "tickDt",
        "snapshotHz",
        "interpolationDelayMs",
        "halfExtentX",
        "halfExtentY",
        "halfExtentZ",
        "eyeOffset",
        "maxPitch",
        "maxHealth",
        "crouchDrop",
        "grenadesPerLife",
        "grenadeFuse",
        "grenadeRadius",
        "regenDelay",
        "regenSeconds",
        "arenaScale",
        "arenaHalfX",
        "arenaHalfZ",
        "zoneFinalRadius",
        "bulletGravity",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

/// Most range bands any gun has; `weapons()` pads every row to this many.
const BANDS: usize = 3;

/// Every gun, in the order of `weapon_ids()`, one row of `weapon_fields()`
/// each: the client predicts its own fire, reload and change of weapon from
/// these, and shows them in the menu, so it reads them from the table the
/// server enforces rather than keeping a copy.
#[wasm_bindgen]
pub fn weapons() -> Vec<f32> {
    let mut out = Vec::new();
    for weapon in Weapon::ALL {
        let s = weapon.stats();
        let tick = TICK_DT;
        out.extend_from_slice(&[
            if s.automatic { 1.0 } else { 0.0 },
            s.fire_ticks as f32,
            s.magazine as f32,
            s.reload_ticks as f32 * tick,
            s.draw_ticks as f32 * tick,
            s.muzzle_velocity,
            s.drag,
            s.zero,
            s.range,
            weapon.zero_angle(),
            s.bands.len() as f32,
        ]);
        for i in 0..BANDS {
            match s.bands.get(i) {
                Some(b) => out.extend_from_slice(&[
                    f32::from(b.from),
                    f32::from(b.head),
                    f32::from(b.body),
                    f32::from(b.legs),
                ]),
                None => out.extend_from_slice(&[0.0; 4]),
            }
        }
    }
    out
}

/// The columns of `weapons()`, in order.
#[wasm_bindgen]
pub fn weapon_fields() -> Vec<String> {
    let mut names: Vec<String> = [
        "automatic",
        "fireTicks",
        "magazine",
        "reloadSeconds",
        "drawSeconds",
        "muzzleVelocity",
        "drag",
        "zero",
        "range",
        "zeroAngle",
        "bandCount",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
    for i in 0..BANDS {
        for field in ["From", "Head", "Body", "Legs"] {
            names.push(format!("band{i}{field}"));
        }
    }
    names
}

/// The guns' names on the wire, in the order of `weapons()`.
#[wasm_bindgen]
pub fn weapon_ids() -> Vec<String> {
    Weapon::ALL.iter().map(|w| w.id().to_string()).collect()
}

/// What the menu and the killfeed call each gun, in the same order.
#[wasm_bindgen]
pub fn weapon_names() -> Vec<String> {
    Weapon::ALL
        .iter()
        .map(|w| w.stats().name.to_string())
        .collect()
}

/// The optics a gun can carry, by their names on the wire, its default
/// first.
#[wasm_bindgen]
pub fn weapon_optics(weapon: u8) -> Vec<String> {
    let Some(weapon) = Weapon::ALL.get(usize::from(weapon)) else {
        return Vec::new();
    };
    weapon.optics().iter().map(|o| o.id().to_string()).collect()
}

/// Every optic's name on the wire, and how much each magnifies.
#[wasm_bindgen]
pub fn optic_ids() -> Vec<String> {
    Optic::ALL.iter().map(|o| o.id().to_string()).collect()
}

#[wasm_bindgen]
pub fn optic_magnifications() -> Vec<f32> {
    Optic::ALL.iter().map(|o| o.magnification()).collect()
}

/// A round's flight from where and how it left, a position per tick for
/// up to `seconds`: x, y, z in threes, ending where it first meets the active
/// map, if it does, or where it is spent. For drawing tracers, and the marks
/// on a scope's reticle, along the flight the server judges and against the
/// walls it collides with - never for deciding anything: players are not in
/// it, and where a round lands is the server's to say.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn round_path(weapon: u8, x: f32, y: f32, z: f32, vx: f32, vy: f32, vz: f32, seconds: f32) -> Vec<f32> {
    let Some(weapon) = Weapon::ALL.get(usize::from(weapon)) else {
        return Vec::new();
    };
    let stats = weapon.stats();
    let mut round = Round {
        position: glam_vec(x, y, z),
        velocity: glam_vec(vx, vy, vz),
    };
    let ground = map::active();
    let steps = (seconds.clamp(0.0, 4.0) / TICK_DT).ceil() as usize;
    let mut out = Vec::with_capacity((steps + 1) * 3);
    out.extend_from_slice(&[x, y, z]);
    let mut travelled = 0.0;
    for _ in 0..steps {
        let from = round.position;
        round.step(stats.drag, TICK_DT);
        let delta = round.position - from;
        let length = delta.length();
        if length <= f32::EPSILON {
            break;
        }
        let direction = delta / length;
        let reach = length.min((stats.range - travelled).max(0.0));
        if let Some(hit) = hitscan::trace_world(from, direction, reach, ground) {
            let at = from + direction * hit;
            out.extend_from_slice(&[at.x, at.y, at.z]);
            break;
        }
        travelled += reach;
        let at = from + direction * reach;
        out.extend_from_slice(&[at.x, at.y, at.z]);
        if travelled >= stats.range {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_table_has_a_name_for_every_column() {
        assert_eq!(constants().len(), constant_names().len());
        assert_eq!(weapons().len(), weapon_fields().len() * weapon_ids().len());
        assert_eq!(weapon_ids().len(), Weapon::ALL.len());
        assert_eq!(optic_ids().len(), optic_magnifications().len());
        assert!(Weapon::ALL.iter().all(|w| w.stats().bands.len() <= BANDS));
    }
}
