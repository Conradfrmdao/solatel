//! Bounded, shared ledge climbing. Every point along the body route must fit.
use super::{PLAYER_HALF_EXTENTS as HALF, PlayerState, collide, map::Map};
use glam::Vec3;

fn clear(from: Vec3, to: Vec3, map: &Map) -> bool {
    let steps = ((to - from).length() / 0.04).ceil().max(1.0) as usize;
    (0..=steps).all(|i| !collide::overlaps_any(from.lerp(to, i as f32 / steps as f32), HALF, map))
}

pub fn find_target(state: &PlayerState, map: &Map) -> Option<Vec3> {
    let forward = Vec3::new(-state.yaw.sin(), 0.0, -state.yaw.cos());
    let ahead = state.position + forward * 1.05;
    let feet = state.position.y - HALF.y;
    let mut heights = Vec::new();
    map.near(
        ahead - Vec3::new(0.36, 1.0, 0.36),
        ahead + Vec3::new(0.36, 1.8, 0.36),
        |_, b| {
            let rise = b.max.y - feet;
            if (0.7..=1.8).contains(&rise)
                && ahead.x > b.min.x
                && ahead.x < b.max.x
                && ahead.z > b.min.z
                && ahead.z < b.max.z
            {
                heights.push(b.max.y);
            }
            true
        },
    );
    heights.sort_by(f32::total_cmp);
    for height in heights {
        let target = Vec3::new(ahead.x, height + HALF.y + 0.005, ahead.z);
        let lifted = Vec3::new(state.position.x, target.y, state.position.z);
        // Do not pull through a ceiling, overhang, wall or another ledge.
        if clear(state.position, lifted, map)
            && clear(lifted, target, map)
            && collide::overlaps_any(target - Vec3::Y * 0.03, HALF, map)
        {
            return Some(target);
        }
    }
    None
}

pub fn advance(state: &mut PlayerState, map: &Map, dt: f32) -> bool {
    let Some(target) = state.mantle_target else {
        return false;
    };
    let waypoint = if state.position.y < target.y - 0.001 {
        Vec3::new(state.position.x, target.y, state.position.z)
    } else {
        target
    };
    let delta = waypoint - state.position;
    let next = state.position + delta.clamp_length_max(3.8 * dt);
    if !clear(state.position, next, map) {
        state.mantle_target = None;
        return false;
    }
    state.velocity = (next - state.position) / dt;
    state.position = next;
    state.on_ground = false;
    if state.position.distance_squared(target) < 0.000001 {
        state.mantle_target = None;
        state.velocity = Vec3::ZERO;
        state.on_ground = true;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{
        Buttons, InputCommand,
        map::{Brush, Spawn},
        step,
    };
    const FLOOR: Brush = Brush::new(Vec3::new(-5.0, -1.0, -5.0), Vec3::new(5.0, 0.0, 5.0));
    const CRATE: Brush = Brush::new(Vec3::new(-1.0, 0.0, -2.0), Vec3::new(1.0, 1.4, -0.6));
    static OPEN: Map = Map::fixture(&[FLOOR, CRATE], &[]);
    static LOW: Map = Map::fixture(
        &[
            FLOOR,
            CRATE,
            Brush::new(Vec3::new(-2.0, 2.5, -3.0), Vec3::new(2.0, 3.0, 1.0)),
        ],
        &[],
    );
    static TALL: Map = Map::fixture(
        &[
            FLOOR,
            Brush::new(Vec3::new(-1.0, 0.0, -2.0), Vec3::new(1.0, 2.2, -0.6)),
        ],
        &[],
    );
    fn player() -> PlayerState {
        let mut p = PlayerState::spawned_at(Spawn {
            position: Vec3::new(0.0, 0.901, 0.0),
            yaw: 0.0,
        });
        p.on_ground = true;
        p
    }
    fn input() -> InputCommand {
        InputCommand {
            seq: 0,
            forward: 0.0,
            right: 0.0,
            yaw: 0.0,
            pitch: 0.0,
            buttons: Buttons(1),
        }
    }
    #[test]
    fn jump_climbs_a_reachable_crate_without_intersecting_it() {
        let mut p = player();
        for _ in 0..90 {
            step(&mut p, &input(), &OPEN, 1.0 / 60.0);
            assert!(!collide::overlaps_any(p.position, HALF, &OPEN));
        }
        assert!(p.on_ground && p.mantle_target.is_none());
        assert!((p.position.y - 2.3).abs() < 0.02);
        assert!(p.position.z < -0.9);
        // Held jump cannot immediately launch another jump at completion.
        assert_eq!(p.velocity.y, 0.0);
    }
    #[test]
    fn ceiling_and_out_of_reach_ledges_refuse_climbing() {
        assert!(find_target(&player(), &LOW).is_none());
        assert!(find_target(&player(), &TALL).is_none());
        let mut p = player();
        step(&mut p, &input(), &TALL, 1.0 / 60.0);
        assert!(p.mantle_target.is_none() && p.velocity.y > 0.0);
    }
    #[test]
    fn death_cancels_a_climb_and_reconciliation_preserves_it() {
        let mut p = player();
        step(&mut p, &input(), &OPEN, 1.0 / 60.0);
        assert!(p.mantle_target.is_some());
        let mut restored: PlayerState =
            serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        for _ in 0..10 {
            step(&mut p, &input(), &OPEN, 1.0 / 60.0);
            step(&mut restored, &input(), &OPEN, 1.0 / 60.0);
            assert_eq!(p, restored);
        }
        p.health = 0;
        step(&mut p, &input(), &OPEN, 1.0 / 60.0);
        assert!(p.mantle_target.is_none());
    }
}
