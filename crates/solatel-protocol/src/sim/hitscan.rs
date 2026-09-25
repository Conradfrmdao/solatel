//! Hitscan tracing.
//!
//! Shared so that the client can draw a tracer where it *thinks* the shot went
//! while the server decides where it *actually* went. Only the server's answer
//! moves money; the client's copy exists purely so the visual effect appears
//! without waiting a round trip.
//!
//! The server is responsible for choosing *which* positions to trace against -
//! see the lag compensation in `solatel-server` - because a fair answer depends
//! on rewinding other players to where the shooter saw them.

use super::map::Map;
use super::{HEAD_BOTTOM, HEAD_HALF_WIDTH, HitRegion, LEGS_TOP, PLAYER_HALF_EXTENTS, PlayerState};
use crate::ids::PlayerId;
use glam::Vec3;

/// What a shot ran into.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TraceHit {
    pub distance: f32,
    pub point: Vec3,
    /// `None` means the shot hit the world.
    pub player: Option<PlayerId>,
    /// Where on them it landed. `None` whenever `player` is.
    pub region: Option<HitRegion>,
}

/// Distance along `direction` at which a ray enters an axis-aligned box, if it
/// does at all.
///
/// `direction` must be unit length for the result to be a distance in metres.
pub fn ray_vs_aabb(origin: Vec3, direction: Vec3, min: Vec3, max: Vec3) -> Option<f32> {
    // Slab method. Components of `direction` that are zero produce infinities
    // here rather than divisions by zero, and `f32::min`/`max` discard the
    // resulting NaNs in favour of the real bound, which is exactly what we want
    // for a ray running parallel to a face.
    let inverse = Vec3::ONE / direction;
    let t_to_min = (min - origin) * inverse;
    let t_to_max = (max - origin) * inverse;

    let entries = t_to_min.min(t_to_max);
    let exits = t_to_min.max(t_to_max);

    let entry = entries.max_element();
    let exit = exits.min_element();

    // `exit < 0` means the box is entirely behind the ray.
    if exit < 0.0 || entry > exit {
        return None;
    }

    Some(entry.max(0.0))
}

/// Nearest point at which a ray meets solid world geometry.
pub fn trace_world(origin: Vec3, direction: Vec3, max_distance: f32, map: &Map) -> Option<f32> {
    // Narrowed by the box the ray sweeps through rather than the ray itself.
    // A shot crosses the whole arena, so this is a looser filter than the one
    // movement gets - but a diagonal shot still skips most of the map, and
    // every brush it does return is intersected exactly as before.
    let end = origin + direction * max_distance;
    let min = origin.min(end);
    let max = origin.max(end);

    let mut nearest: Option<f32> = None;
    map.near(min, max, |_, brush| {
        if let Some(distance) = ray_vs_aabb(origin, direction, brush.min, brush.max)
            && distance <= max_distance
            && nearest.is_none_or(|best| distance < best)
        {
            nearest = Some(distance);
        }
        true
    });
    nearest
}

/// The box a player can be shot in.
pub fn player_hitbox(state: &PlayerState) -> (Vec3, Vec3) {
    (
        state.position - PLAYER_HALF_EXTENTS,
        state.position + PLAYER_HALF_EXTENTS,
    )
}

/// The smaller box on top of that one that counts as a head.
pub fn player_headbox(state: &PlayerState) -> (Vec3, Vec3) {
    let half = Vec3::new(HEAD_HALF_WIDTH, 0.0, HEAD_HALF_WIDTH);
    (
        state.position + Vec3::new(-half.x, HEAD_BOTTOM, -half.z),
        state.position + Vec3::new(half.x, PLAYER_HALF_EXTENTS.y, half.z),
    )
}

/// Which part of a player a shot that has already hit their box landed on.
///
/// The head is tested as a box of its own *in addition to* the full body box,
/// never instead of it. Carving the body into three boxes that tile the
/// silhouette sounds tidier and is worse: the head is narrower than the
/// shoulders, so the corners above the shoulders would belong to no box at
/// all, and a shot through them would report a clean miss on a player it
/// visibly went through. A shot that hit before still hits; the head box only
/// decides whether it hit harder.
fn region_of(state: &PlayerState, origin: Vec3, direction: Vec3, body: f32) -> HitRegion {
    let (head_min, head_max) = player_headbox(state);
    if let Some(head) = ray_vs_aabb(origin, direction, head_min, head_max)
        && head.is_finite()
    {
        return HitRegion::Head;
    }
    let height = (origin + direction * body).y - state.position.y;
    if height < LEGS_TOP {
        HitRegion::Legs
    } else {
        HitRegion::Body
    }
}

/// Traces a shot against the world and a set of candidate targets.
///
/// `targets` should already be the positions the shooter plausibly saw, and
/// should exclude the shooter. Dead players are skipped: a corpse does not
/// block a bullet, and cannot be killed twice for a second payout.
pub fn trace<'a, I>(
    origin: Vec3,
    direction: Vec3,
    max_distance: f32,
    map: &Map,
    targets: I,
) -> Option<TraceHit>
where
    I: IntoIterator<Item = (PlayerId, &'a PlayerState)>,
{
    // A shot cannot travel further than the first wall it meets, so the world
    // hit sets the budget for player hits. Without this, players are shot
    // through walls.
    let wall_distance = trace_world(origin, direction, max_distance, map);
    let budget = wall_distance.unwrap_or(max_distance);

    let nearest_player = targets
        .into_iter()
        .filter(|(_, state)| state.is_alive())
        .filter_map(|(id, state)| {
            let (min, max) = player_hitbox(state);
            ray_vs_aabb(origin, direction, min, max).map(|distance| (id, state, distance))
        })
        .filter(|(_, _, distance)| *distance <= budget)
        .min_by(|a, b| a.2.total_cmp(&b.2));

    match nearest_player {
        Some((id, state, distance)) => Some(TraceHit {
            distance,
            point: origin + direction * distance,
            player: Some(id),
            region: Some(region_of(state, origin, direction, distance)),
        }),
        None => wall_distance.map(|distance| TraceHit {
            distance,
            point: origin + direction * distance,
            player: None,
            region: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::map::{Brush, Map, Spawn, TEST_MAP};

    const RANGE: f32 = 120.0;

    // Tracing is tested on open ground, not on the real arena. A test that
    // fires across the map measures the map layout, and breaks every time the
    // level changes - which is exactly what happened the first time round.
    static OPEN_BRUSHES: &[Brush] = &[Brush::new(
        Vec3::new(-200.0, -1.0, -200.0),
        Vec3::new(200.0, 0.0, 200.0),
    )];
    static OPEN_SPAWNS: &[Spawn] = &[Spawn {
        position: Vec3::new(0.0, 1.0, 0.0),
        yaw: 0.0,
    }];
    static OPEN_MAP: Map = Map::fixture(OPEN_BRUSHES, OPEN_SPAWNS);

    fn player_at(x: f32, z: f32) -> PlayerState {
        let mut state = PlayerState::spawned_at(OPEN_MAP.spawn(0));
        state.position = Vec3::new(x, PLAYER_HALF_EXTENTS.y, z);
        state.velocity = Vec3::ZERO;
        state
    }

    #[test]
    fn a_ray_hits_a_box_in_front_of_it() {
        let hit = ray_vs_aabb(
            Vec3::ZERO,
            Vec3::NEG_Z,
            Vec3::new(-1.0, -1.0, -10.0),
            Vec3::new(1.0, 1.0, -8.0),
        );
        assert_eq!(hit, Some(8.0));
    }

    #[test]
    fn a_ray_misses_a_box_beside_it() {
        let hit = ray_vs_aabb(
            Vec3::ZERO,
            Vec3::NEG_Z,
            Vec3::new(5.0, -1.0, -10.0),
            Vec3::new(7.0, 1.0, -8.0),
        );
        assert_eq!(hit, None);
    }

    #[test]
    fn a_ray_ignores_a_box_behind_it() {
        let hit = ray_vs_aabb(
            Vec3::ZERO,
            Vec3::NEG_Z,
            Vec3::new(-1.0, -1.0, 8.0),
            Vec3::new(1.0, 1.0, 10.0),
        );
        assert_eq!(hit, None);
    }

    #[test]
    fn a_ray_parallel_to_a_face_does_not_produce_a_phantom_hit() {
        let hit = ray_vs_aabb(
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::NEG_Z,
            Vec3::new(-1.0, -1.0, -10.0),
            Vec3::new(1.0, 1.0, -8.0),
        );
        if let Some(distance) = hit {
            assert!((8.0..=10.0).contains(&distance), "got {distance}");
        }
    }

    #[test]
    fn a_clear_shot_hits_the_target() {
        let target_id = PlayerId::new();
        let target = player_at(4.0, 0.0);
        let hit = trace(
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::X,
            RANGE,
            &OPEN_MAP,
            [(target_id, &target)],
        )
        .expect("should hit something");
        assert_eq!(hit.player, Some(target_id));
    }

    /// Fires level, from `height` above the ground, at a player four metres
    /// away, and reports where it landed on them.
    fn shoot_at_height(height: f32) -> Option<HitRegion> {
        let target_id = PlayerId::new();
        let target = player_at(4.0, 0.0);
        trace(
            Vec3::new(0.0, height, 0.0),
            Vec3::X,
            RANGE,
            &OPEN_MAP,
            [(target_id, &target)],
        )
        .and_then(|hit| hit.region)
    }

    #[test]
    fn a_shot_is_attributed_to_the_part_it_hits() {
        // The target stands with their centre at 0.90, so their feet are at
        // 0.00 and the top of their head at 1.80.
        let centre = PLAYER_HALF_EXTENTS.y;
        assert_eq!(shoot_at_height(centre + 0.75), Some(HitRegion::Head));
        assert_eq!(shoot_at_height(centre), Some(HitRegion::Body));
        assert_eq!(
            shoot_at_height(centre + LEGS_TOP - 0.2),
            Some(HitRegion::Legs)
        );
    }

    #[test]
    fn the_head_box_never_turns_a_hit_into_a_miss() {
        // The head is narrower than the shoulders, so a silhouette carved
        // into three tiling boxes has empty corners above the shoulders - and
        // a shot through one of them would report a clean miss on a player it
        // visibly passed through. The head box is layered over the full body
        // box instead, and this is what says so: every height from the feet
        // to the crown, across the full width, still hits.
        let target_id = PlayerId::new();
        let target = player_at(4.0, 0.0);
        // Started a little above the soles and stopped a little below the
        // crown. Not to dodge an awkward case: the test map's ground is a
        // brush whose top is exactly the height of the target's feet, so a
        // ray fired along y = 0 hits the floor at zero distance and every
        // player hit is correctly outside its budget. That is the wall test
        // working, not the head box failing.
        let low = target.position.y - PLAYER_HALF_EXTENTS.y + 0.05;
        let high = target.position.y + PLAYER_HALF_EXTENTS.y - 0.02;

        for step in 0..=40 {
            let height = low + (high - low) * (step as f32 / 40.0);
            // Inset a hair so the very edge of the box is not a coin flip.
            for offset in [
                -PLAYER_HALF_EXTENTS.z + 0.02,
                0.0,
                PLAYER_HALF_EXTENTS.z - 0.02,
            ] {
                let mut aside = target;
                aside.position.z = 0.0;
                let hit = trace(
                    Vec3::new(0.0, height, offset),
                    Vec3::X,
                    RANGE,
                    &OPEN_MAP,
                    [(target_id, &aside)],
                );
                assert_eq!(
                    hit.and_then(|h| h.player),
                    Some(target_id),
                    "a shot at height {height:.2}, offset {offset:.2} missed a player it went through"
                );
            }
        }
    }

    #[test]
    fn a_shot_over_the_shoulder_but_beside_the_head_is_a_body_shot() {
        // Above the head box's bottom, but further out than it is wide. The
        // full body box catches it, and it is worth body damage rather than
        // being either a miss or a free headshot.
        let target_id = PlayerId::new();
        let mut target = player_at(4.0, 0.0);
        target.position.z = 0.0;
        let height = target.position.y + HEAD_BOTTOM + 0.1;
        let offset = (HEAD_HALF_WIDTH + PLAYER_HALF_EXTENTS.z) * 0.5;

        let hit = trace(
            Vec3::new(0.0, height, offset),
            Vec3::X,
            RANGE,
            &OPEN_MAP,
            [(target_id, &target)],
        )
        .expect("the body box should have caught this");
        assert_eq!(hit.player, Some(target_id));
        assert_eq!(hit.region, Some(HitRegion::Body));
    }

    #[test]
    fn the_nearer_of_two_targets_is_hit() {
        let near_id = PlayerId::new();
        let far_id = PlayerId::new();
        let near = player_at(3.0, 0.0);
        let far = player_at(9.0, 0.0);

        let hit = trace(
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::X,
            RANGE,
            &OPEN_MAP,
            [(far_id, &far), (near_id, &near)],
        )
        .expect("should hit someone");
        assert_eq!(
            hit.player,
            Some(near_id),
            "shot hit through the nearer player"
        );
    }

    #[test]
    fn a_dead_player_cannot_be_hit() {
        let target_id = PlayerId::new();
        let mut target = player_at(4.0, 0.0);
        target.health = 0;

        let hit = trace(
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::X,
            RANGE,
            &OPEN_MAP,
            [(target_id, &target)],
        );
        assert!(
            hit.is_none_or(|h| h.player.is_none()),
            "a corpse absorbed a shot"
        );
    }

    #[test]
    fn a_wall_stops_a_shot_short_of_the_target() {
        // On the real arena this time, because the point is the geometry: fire
        // through the central building at someone standing behind it.
        let target_id = PlayerId::new();
        let mut target = PlayerState::spawned_at(TEST_MAP.spawn(0));
        target.position = Vec3::new(12.0, PLAYER_HALF_EXTENTS.y, 0.0);

        let hit = trace(
            Vec3::new(-12.0, 1.0, 0.0),
            Vec3::X,
            RANGE,
            &TEST_MAP,
            [(target_id, &target)],
        )
        .expect("should hit the building");

        assert_eq!(hit.player, None, "shot passed through the central building");
    }

    #[test]
    fn a_shot_into_the_floor_hits_the_world() {
        let hit = trace(
            Vec3::new(0.0, 1.6, 0.0),
            Vec3::NEG_Y,
            RANGE,
            &OPEN_MAP,
            std::iter::empty(),
        )
        .expect("the floor is solid");
        assert_eq!(hit.player, None);
        assert!(
            hit.distance > 0.0 && hit.distance < 2.0,
            "got {}",
            hit.distance
        );
    }
}
