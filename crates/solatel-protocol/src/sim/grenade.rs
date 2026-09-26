//! A thrown grenade: its flight, and what its blast reaches.
//!
//! Shared rather than server-only so there is one description of how a
//! grenade moves, for the tests here and for any client that one day wants
//! to predict its own throw. Today the server steps them and sends their
//! positions in the snapshot; the client only draws what it is sent.

use super::{
    GRAVITY, GRENADE_DAMAGE, GRENADE_INNER_RADIUS, GRENADE_LIFT, GRENADE_RADIUS,
    GRENADE_THROW_SPEED, PlayerState, collide, hitscan, look_direction, map::Map,
};
use glam::Vec3;

/// Half the size of the box a grenade collides as. Small, so it goes through
/// doorways and windows a player can see through.
pub const HALF: Vec3 = Vec3::splat(0.07);

/// Of its speed into a surface, how much a grenade keeps bouncing off it.
const BOUNCE: f32 = 0.35;

/// Of its speed along a surface, how much it keeps sliding on it each hit.
const SCRUB: f32 = 0.7;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Flight {
    pub position: Vec3,
    pub velocity: Vec3,
}

impl Flight {
    /// Thrown from a player: out of their eyes, along their aim, with a
    /// little lift and whatever velocity they already had.
    pub fn thrown_by(state: &PlayerState) -> Self {
        let aim = look_direction(state.yaw, state.pitch);
        Self {
            position: state.eye_position() + aim * 0.4,
            velocity: aim * GRENADE_THROW_SPEED + Vec3::Y * GRENADE_LIFT + state.velocity,
        }
    }

    /// One step of flight. Each axis is moved on its own, and one that runs
    /// into something bounces back off it with a fraction of its speed and
    /// takes some off the other two, which is enough to make a grenade roll
    /// to a stop rather than skating across the floor forever.
    pub fn step(&mut self, map: &Map, dt: f32) {
        self.velocity.y -= GRAVITY * dt;
        let delta = self.velocity * dt;
        for axis in 0..3 {
            let mut moved = self.position;
            moved[axis] += delta[axis];
            if collide::overlaps_any(moved, HALF, map) {
                self.velocity[axis] = -self.velocity[axis] * BOUNCE;
                for other in 0..3 {
                    if other != axis {
                        self.velocity[other] *= SCRUB;
                    }
                }
            } else {
                self.position = moved;
            }
        }
    }
}

/// How much a blast at `at` hurts a player standing in `state`: all of
/// [`GRENADE_DAMAGE`] within the inner radius, falling off to nothing at the
/// outer one, and nothing at all if the map is in the way.
///
/// Line of sight is judged to the middle of the body and to the head, and
/// either is enough: a player crouched behind a low wall with their head
/// above it is exposed, and one with only a foot round a corner is not.
pub fn blast_damage(at: Vec3, state: &PlayerState, map: &Map) -> i16 {
    if !state.is_alive() {
        return 0;
    }
    let centre = state.position;
    let head = state.eye_position();
    let distance = (centre - at).length().min((head - at).length());
    if distance >= GRENADE_RADIUS {
        return 0;
    }
    let exposed = [centre, head].into_iter().any(|point| {
        let offset = point - at;
        let length = offset.length();
        length < 1e-3
            || hitscan::trace_world(at, offset / length, length, map)
                .is_none_or(|wall| wall >= length - 0.05)
    });
    if !exposed {
        return 0;
    }
    let share = if distance <= GRENADE_INNER_RADIUS {
        1.0
    } else {
        1.0 - (distance - GRENADE_INNER_RADIUS) / (GRENADE_RADIUS - GRENADE_INNER_RADIUS)
    };
    (GRENADE_DAMAGE as f32 * share).round() as i16
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{
        MAX_HEALTH, TICK_DT,
        map::{Brush, Map, Spawn},
    };

    static FLOOR: &[Brush] = &[
        Brush::new(Vec3::new(-100.0, -1.0, -100.0), Vec3::new(100.0, 0.0, 100.0)),
        // A wall at x 5..6, three metres tall.
        Brush::new(Vec3::new(5.0, 0.0, -10.0), Vec3::new(6.0, 3.0, 10.0)),
    ];
    static SPAWNS: &[Spawn] = &[Spawn {
        position: Vec3::new(0.0, 1.0, 0.0),
        yaw: 0.0,
    }];

    static MAP: Map = Map::fixture(FLOOR, SPAWNS);
    fn map() -> &'static Map {
        &MAP
    }

    fn standing(x: f32) -> PlayerState {
        let mut state = PlayerState::spawned_at(SPAWNS[0]);
        state.position = Vec3::new(x, 0.9, 0.0);
        state.health = MAX_HEALTH;
        state
    }

    #[test]
    fn a_grenade_lands_and_comes_to_rest_on_the_floor() {
        let map = map();
        let mut thrower = standing(0.0);
        thrower.yaw = std::f32::consts::FRAC_PI_2; // facing -X, away from the wall
        let mut flight = Flight::thrown_by(&thrower);
        for _ in 0..(64 * 4) {
            flight.step(map, TICK_DT);
        }
        assert!(flight.position.y > 0.0 && flight.position.y < 0.2, "at {:?}", flight.position);
        assert!(flight.velocity.length() < 1.0, "still moving at {:?}", flight.velocity);
        assert!(flight.position.x < -5.0, "it should have gone where it was thrown");
    }

    #[test]
    fn a_grenade_bounces_off_a_wall_rather_than_through_it() {
        let map = map();
        let mut thrower = standing(0.0);
        thrower.yaw = -std::f32::consts::FRAC_PI_2; // facing +X, at the wall
        let mut flight = Flight::thrown_by(&thrower);
        for _ in 0..(64 * 3) {
            flight.step(map, TICK_DT);
            assert!(flight.position.x < 5.0, "went into the wall at {:?}", flight.position);
        }
    }

    #[test]
    fn the_blast_falls_off_with_distance_and_stops_at_walls() {
        let map = map();
        let at = Vec3::new(0.0, 0.1, 0.0);
        assert_eq!(blast_damage(at, &standing(1.0), map), GRENADE_DAMAGE);
        let near = blast_damage(at, &standing(3.0), map);
        let far = blast_damage(at, &standing(4.5), map);
        assert!(near > far && far > 0, "{near} then {far}");
        assert_eq!(blast_damage(at, &standing(8.0), map), 0, "past the radius");
        // Behind the wall, well within range of a grenade just in front of it.
        let by_the_wall = Vec3::new(4.5, 0.1, 0.0);
        assert!(blast_damage(by_the_wall, &standing(3.0), map) > 0);
        assert_eq!(blast_damage(by_the_wall, &standing(7.0), map), 0, "through a wall");
    }
}
