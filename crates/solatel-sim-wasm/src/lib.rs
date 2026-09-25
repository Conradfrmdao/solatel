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
        Buttons, EYE_OFFSET, InputCommand, MAX_HEALTH, MAX_PITCH, PLAYER_HALF_EXTENTS, PlayerState,
        WEAPON_FIRE_INTERVAL, Zone,
        map::{self, MAP_VERSION},
        step_tick,
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
    ) {
        self.state.position = glam_vec(x, y, z);
        self.state.velocity = glam_vec(vx, vy, vz);
        self.state.yaw = yaw;
        self.state.pitch = pitch;
        self.state.on_ground = on_ground;
        self.state.health = health;
    }

    /// Advances one tick over one command.
    ///
    /// `buttons` is the same bitfield the wire carries: bit 0 jump, bit 1 fire.
    /// The command is sanitised exactly as the server sanitises it, so a bug in
    /// the JavaScript that produced it diverges here rather than silently
    /// predicting something the server will never agree to.
    /// `zone_radius` is the match circle the server last reported, in metres,
    /// or a non-finite value for no limit. Passed in rather than worked out
    /// here: the circle closes on the server's clock, and a client computing
    /// its own schedule would predict against a wall in a slightly different
    /// place from the one it is being held behind.
    pub fn step(
        &mut self,
        forward: f32,
        right: f32,
        yaw: f32,
        pitch: f32,
        buttons: u8,
        zone_radius: f32,
    ) {
        let command = InputCommand {
            seq: 0,
            forward,
            right,
            yaw,
            pitch,
            buttons: Buttons(buttons),
        }
        .sanitized();
        step_tick(
            &mut self.state,
            &command,
            map::active(),
            Zone {
                radius: zone_radius,
            },
        );
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
        WEAPON_FIRE_INTERVAL,
        map::active().scale,
        map::active().half_x,
        map::active().half_z,
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
        "weaponFireInterval",
        "arenaScale",
        "arenaHalfX",
        "arenaHalfZ",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}
