//! Player-versus-world collision.
//!
//! The player is an axis-aligned box and the world is a set of axis-aligned
//! boxes, which makes this simple enough to be obviously correct - a quality
//! worth more here than sophistication, because the server re-runs exactly this
//! code to decide where a player really is.
//!
//! Movement is resolved one axis at a time. That is what lets a player slide
//! along a wall instead of sticking to it, and it keeps each resolution step to
//! a single comparison per brush.

use super::map::Map;
use glam::Vec3;

/// Small separation left between the player and a surface after resolving, so
/// that the next frame's overlap test does not immediately re-trigger.
const SKIN: f32 = 0.001;

/// Movement is split into steps no longer than this before being resolved.
/// Without it, a fast enough player could pass through a thin wall between two
/// frames.
const MAX_STEP: f32 = 0.2;

/// The tallest obstacle a walking player climbs without jumping.
///
/// A third of the player's height, where Unreal ships a quarter (45 cm
/// against a 1.92 m character) and Source about the same (46 cm against
/// 1.83 m). Being out of line with both is deliberate and has one reason:
/// they collide against the level's actual triangles and this collides
/// against a height field quantised to a quarter of a metre. A real 0.40 m
/// step is stored here as anything up to 0.65 m once it has been rounded to
/// a cell and banded, so the step height has to cover the art's step *plus*
/// what the representation adds to it.
///
/// Still far below the 1.13 m a jump clears, so chest-high cover is still
/// cover and a crate is still something to vault.
pub const MAX_STEP_UP: f32 = 0.65;

/// How far below the feet to look when deciding whether the player is standing
/// on something. Large enough to survive the skin gap, small enough that it
/// does not grab a surface the player has genuinely left.
const GROUND_PROBE: f32 = 0.05;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Axis {
    X,
    Y,
    Z,
}

fn get(v: Vec3, axis: Axis) -> f32 {
    match axis {
        Axis::X => v.x,
        Axis::Y => v.y,
        Axis::Z => v.z,
    }
}

fn set(v: &mut Vec3, axis: Axis, value: f32) {
    match axis {
        Axis::X => v.x = value,
        Axis::Y => v.y = value,
        Axis::Z => v.z = value,
    }
}

/// Do two axis-aligned boxes overlap? Touching exactly is not an overlap.
fn boxes_overlap(a_min: Vec3, a_max: Vec3, b_min: Vec3, b_max: Vec3) -> bool {
    a_min.x < b_max.x
        && a_max.x > b_min.x
        && a_min.y < b_max.y
        && a_max.y > b_min.y
        && a_min.z < b_max.z
        && a_max.z > b_min.z
}

/// Is a player box at `position` intersecting any solid geometry?
pub fn overlaps_any(position: Vec3, half_extents: Vec3, map: &Map) -> bool {
    let min = position - half_extents;
    let max = position + half_extents;
    let mut hit = false;
    map.near(min, max, |_, brush| {
        if boxes_overlap(min, max, brush.min, brush.max) {
            hit = true;
            false // found one; stop looking
        } else {
            true
        }
    });
    hit
}

/// Result of moving a player box through the world.
#[derive(Debug, Clone, Copy)]
pub struct MoveResult {
    pub position: Vec3,
    /// Axes on which movement was stopped by geometry. The caller zeroes the
    /// corresponding velocity components - otherwise a player pressed into a
    /// wall accumulates speed and launches when they step away from it.
    pub blocked_x: bool,
    pub blocked_y: bool,
    pub blocked_z: bool,
    pub on_ground: bool,
}

/// Moves a player box by `delta`, sliding along anything it runs into.
pub fn move_and_slide(position: Vec3, half_extents: Vec3, delta: Vec3, map: &Map) -> MoveResult {
    let mut result = MoveResult {
        position,
        blocked_x: false,
        blocked_y: false,
        blocked_z: false,
        on_ground: false,
    };

    let distance = delta.length();
    let steps = if distance > MAX_STEP {
        (distance / MAX_STEP).ceil() as u32
    } else {
        1
    };
    let step = delta / steps as f32;

    for _ in 0..steps {
        let before = result.position;
        let grounded_before = probe_ground(before, half_extents, map);

        // Horizontal first, then vertical. Doing vertical last means a player
        // who walks off a ledge is resolved as falling rather than as having
        // been pushed sideways out of the floor they just left.
        let (flat, mut blocked_x, mut blocked_z) = slide(before, half_extents, step, map);
        let mut chosen = flat;

        // If something stopped us while we were on the ground, try again from
        // slightly higher and settle back down. This is what lets a player walk
        // up stairs and over kerbs rather than having to jump every tread -
        // without it, a staircase is a series of walls.
        //
        // The two candidates are compared by progress *along the direction the
        // player asked for*, not by how far each one moved. That distinction is
        // the whole of a bug that made walking up a flight of stairs at an
        // angle shove the player off the side of it: sliding along a tread
        // covers more ground than climbing it, so measuring raw distance picked
        // the slide every time, and the slides accumulated into a curve.
        if (blocked_x || blocked_z)
            && grounded_before
            && let Some(stepped) = try_step_up(before, half_extents, step, map)
            && progress_towards(before, stepped, step) > progress_towards(before, flat, step) + 1e-4
        {
            chosen = stepped;
            blocked_x = false;
            blocked_z = false;
        }

        result.position = chosen;
        result.blocked_x |= blocked_x;
        result.blocked_z |= blocked_z;

        if move_axis(&mut result.position, half_extents, Axis::Y, step.y, map) {
            result.blocked_y = true;
            // Blocked while moving down means we landed on something.
            if step.y < 0.0 {
                result.on_ground = true;
            }
        }
    }

    // A player standing still has no downward movement to be blocked, so ground
    // contact is also tested directly.
    if !result.on_ground {
        result.on_ground = probe_ground(result.position, half_extents, map);
    }

    result
}

/// Moves horizontally, sliding along whatever is in the way, without favouring
/// either axis.
///
/// Both orderings are tried and whichever gets further in the direction the
/// player asked for wins. Resolving X and then always Z is order-dependent in
/// a way players feel: against a corner the first axis is pushed clear and the
/// second then slides along it, so every deflection leans the same way and
/// holding forward walks a curve.
///
/// Returns where it ended up and which axes were stopped.
fn slide(from: Vec3, half_extents: Vec3, step: Vec3, map: &Map) -> (Vec3, bool, bool) {
    let mut x_first = from;
    let x_first_x = move_axis(&mut x_first, half_extents, Axis::X, step.x, map);
    let x_first_z = move_axis(&mut x_first, half_extents, Axis::Z, step.z, map);

    let mut z_first = from;
    let z_first_z = move_axis(&mut z_first, half_extents, Axis::Z, step.z, map);
    let z_first_x = move_axis(&mut z_first, half_extents, Axis::X, step.x, map);

    if progress_towards(from, z_first, step) > progress_towards(from, x_first, step) {
        (z_first, z_first_x, z_first_z)
    } else {
        (x_first, x_first_x, x_first_z)
    }
}

/// Moves along one axis and pushes back out of anything entered.
///
/// Returns whether geometry stopped the movement.
fn move_axis(position: &mut Vec3, half_extents: Vec3, axis: Axis, amount: f32, map: &Map) -> bool {
    if amount == 0.0 {
        return false;
    }

    set(position, axis, get(*position, axis) + amount);

    let mut blocked = false;
    // Repeated because pushing out of one brush can push into another, which
    // happens in the inside corner where two brushes meet. Bounded so that a
    // player wedged into a crevice cannot spin here forever.
    for _ in 0..4 {
        let min = *position - half_extents;
        let max = *position + half_extents;

        let mut found: Option<(f32, f32)> = None;
        map.near(min, max, |_, brush| {
            if boxes_overlap(min, max, brush.min, brush.max) {
                found = Some((get(brush.min, axis), get(brush.max, axis)));
                false // one is enough; the loop repeats if it pushed into another
            } else {
                true
            }
        });
        let Some((brush_min, brush_max)) = found else {
            break;
        };

        blocked = true;
        let half = get(half_extents, axis);
        if amount > 0.0 {
            set(position, axis, brush_min - half - SKIN);
        } else {
            set(position, axis, brush_max + half + SKIN);
        }
    }

    blocked
}

fn probe_ground(position: Vec3, half_extents: Vec3, map: &Map) -> bool {
    let probe = position - Vec3::new(0.0, GROUND_PROBE, 0.0);
    overlaps_any(probe, half_extents, map)
}

/// Tries to climb a small obstacle: rise, move across, settle back down.
///
/// Returns the new position, or `None` if there was nothing to climb - no
/// headroom to rise into, no ground to come back down onto, or the attempt
/// would have left the player inside geometry or lower than they started.
fn try_step_up(start: Vec3, half_extents: Vec3, step: Vec3, map: &Map) -> Option<Vec3> {
    let mut position = start;

    // Rise. Blocked here means a low ceiling, so there is no step to take.
    if move_axis(&mut position, half_extents, Axis::Y, MAX_STEP_UP, map) {
        return None;
    }

    // The same unbiased slide the flat move uses. This used to resolve X and
    // then always Z - the ordering the flat path was deliberately changed
    // away from - and there is no good reason for the two to disagree about
    // something as basic as how sliding works. Whether the difference was
    // ever visible is unproven: no fixture written for it has managed to make
    // the two orderings disagree by a measurable amount, so this is
    // consistency rather than a fix for anything observed.
    let (slid, _, _) = slide(position, half_extents, step, map);
    position = slid;

    // Settle back onto whatever we climbed onto. If nothing is there, the
    // player is left slightly airborne and gravity resolves it next tick.
    move_axis(&mut position, half_extents, Axis::Y, -MAX_STEP_UP, map);

    // A step must never end inside geometry, and must never end *lower* than
    // it began - that would be a fall dressed up as a climb.
    if overlaps_any(position, half_extents, map) || position.y < start.y - 1e-3 {
        return None;
    }

    Some(position)
}

/// How far `b` got from `a` in the direction the player was actually pushing.
///
/// Sideways displacement counts for nothing here, which is the point: a slide
/// along a wall and a step over it are only comparable by how much closer each
/// one got to where the player was trying to go.
fn progress_towards(a: Vec3, b: Vec3, wish: Vec3) -> f32 {
    let length = (wish.x * wish.x + wish.z * wish.z).sqrt();
    if length <= f32::EPSILON {
        return 0.0;
    }
    let delta = b - a;
    (delta.x * wish.x + delta.z * wish.z) / length
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::PLAYER_HALF_EXTENTS;
    use crate::sim::map::{Brush, Spawn};

    // A fixture, not the real arena. Collision behaviour is what is under test
    // here; running these against the live map only measures the level layout,
    // and breaks every time it changes.
    const FLOOR_Y: f32 = 0.0;
    const WALL_X: f32 = 10.0;

    static FIXTURE_BRUSHES: &[Brush] = &[
        // Floor.
        Brush::new(
            Vec3::new(-50.0, -1.0, -50.0),
            Vec3::new(50.0, FLOOR_Y, 50.0),
        ),
        // A single thin wall at x = 10, to run into and slide along.
        Brush::new(
            Vec3::new(WALL_X, 0.0, -50.0),
            Vec3::new(WALL_X + 0.5, 6.0, 50.0),
        ),
    ];
    static FIXTURE_SPAWNS: &[Spawn] = &[Spawn {
        position: Vec3::new(0.0, 2.0, 0.0),
        yaw: 0.0,
    }];
    static FIXTURE: Map = Map::fixture(FIXTURE_BRUSHES, FIXTURE_SPAWNS);

    fn resting() -> Vec3 {
        Vec3::new(0.0, PLAYER_HALF_EXTENTS.y, 0.0)
    }

    #[test]
    fn a_player_standing_on_the_floor_is_grounded() {
        let result = move_and_slide(resting(), PLAYER_HALF_EXTENTS, Vec3::ZERO, &FIXTURE);
        assert!(result.on_ground, "player on the floor should be grounded");
    }

    #[test]
    fn falling_lands_on_the_floor_rather_than_through_it() {
        let start = Vec3::new(0.0, 5.0, 0.0);
        let result = move_and_slide(
            start,
            PLAYER_HALF_EXTENTS,
            Vec3::new(0.0, -10.0, 0.0),
            &FIXTURE,
        );
        assert!(result.on_ground);
        assert!(
            (result.position.y - PLAYER_HALF_EXTENTS.y).abs() < 0.05,
            "should rest on the floor, got y={}",
            result.position.y
        );
    }

    #[test]
    fn a_wall_stops_horizontal_movement() {
        let start = Vec3::new(WALL_X - 2.0, PLAYER_HALF_EXTENTS.y, 0.0);
        let result = move_and_slide(
            start,
            PLAYER_HALF_EXTENTS,
            Vec3::new(10.0, 0.0, 0.0),
            &FIXTURE,
        );
        assert!(result.blocked_x);
        assert!(
            result.position.x < WALL_X,
            "player passed through the wall to x={}",
            result.position.x
        );
    }

    #[test]
    fn movement_into_a_wall_still_slides_along_it() {
        let start = Vec3::new(WALL_X - 1.0, PLAYER_HALF_EXTENTS.y, 0.0);
        let result = move_and_slide(
            start,
            PLAYER_HALF_EXTENTS,
            Vec3::new(5.0, 0.0, 2.0),
            &FIXTURE,
        );
        assert!(result.blocked_x);
        assert!(!result.blocked_z);
        assert!(result.position.z > 1.0, "should have slid along the wall");
    }

    #[test]
    fn a_fast_player_cannot_tunnel_through_a_thin_wall() {
        // Far more than MAX_STEP in one go, aimed at a half-metre wall.
        let start = Vec3::new(WALL_X - 3.0, PLAYER_HALF_EXTENTS.y, 0.0);
        let result = move_and_slide(
            start,
            PLAYER_HALF_EXTENTS,
            Vec3::new(60.0, 0.0, 0.0),
            &FIXTURE,
        );
        assert!(
            result.position.x < WALL_X,
            "tunnelled through the wall to x={}",
            result.position.x
        );
    }

    #[test]
    fn a_walking_player_climbs_stairs_without_jumping() {
        // Three treads, each a step high, laid edge to edge like a real
        // staircase. Walking into them should carry the player up.
        static STAIR_BRUSHES: &[Brush] = &[
            Brush::new(Vec3::new(-20.0, -1.0, -20.0), Vec3::new(20.0, 0.0, 20.0)),
            Brush::new(Vec3::new(2.0, 0.0, -5.0), Vec3::new(3.0, 0.45, 5.0)),
            Brush::new(Vec3::new(3.0, 0.0, -5.0), Vec3::new(4.0, 0.90, 5.0)),
            Brush::new(Vec3::new(4.0, 0.0, -5.0), Vec3::new(5.0, 1.35, 5.0)),
            // A landing at the top, so the player has somewhere to arrive.
            // Without it they climb the stairs and walk straight off the end,
            // which is what the first version of this test actually measured.
            Brush::new(Vec3::new(5.0, 0.0, -5.0), Vec3::new(14.0, 1.35, 5.0)),
        ];
        static STAIRS: Map = Map::fixture(STAIR_BRUSHES, FIXTURE_SPAWNS);

        let mut position = Vec3::new(0.0, PLAYER_HALF_EXTENTS.y, 0.0);
        // Walk east at about running speed for a second, with gravity.
        for _ in 0..64 {
            let result = move_and_slide(
                position,
                PLAYER_HALF_EXTENTS,
                Vec3::new(8.0 / 64.0, -0.15, 0.0),
                &STAIRS,
            );
            position = result.position;
        }

        assert!(
            position.x > 5.0,
            "player did not get up the stairs; stopped at x={}",
            position.x
        );
        assert!(
            position.y > 1.35,
            "player is not standing on top of the stairs; y={}",
            position.y
        );
    }

    #[test]
    fn climbing_at_an_angle_does_not_favour_one_side() {
        // A staircase wider than anything can reach across, so the treads are
        // the only thing the player can touch. Any sideways movement here is
        // the resolver's doing, not a wall's.
        //
        // The treads are a quarter of a metre, which is what the brush
        // generator emits for climbable geometry: the collision table for a
        // ramp is not a ramp, it is a washboard of small boxes at slightly
        // different heights, and crossing one diagonally catches on every
        // seam.
        //
        // The measurement is the trick. Approaching at plus and minus the
        // same angle gives two mirror-image runs, so whatever sideways travel
        // is honest must be equal and opposite and cancels in the sum. What
        // is left is bias, and nothing else.
        //
        // This has not yet failed, including against the resolver as it was
        // before `try_step_up` was made to slide the same way as everything
        // else - so it is a guard rather than a regression test, and nobody
        // should read it as evidence that a bias here was ever measured.
        // Not a clean flight of full-width treads. Those cannot show the bug
        // at all: moving along z never touches anything, so the z axis is
        // never blocked, so the order the two are resolved in cannot matter.
        // What the generator actually emits for a ramp is a patchwork - the
        // rectangles it decomposes into end at different places in z, because
        // the voxel height wanders by a cell here and there - so climbing one
        // diagonally catches on seams running both ways. That is the shape
        // reproduced here: every tread is split in z, with the halves a cell
        // apart in height.
        #[rustfmt::skip]
        static STEPS: &[Brush] = &[
            Brush::new(Vec3::new(-60.0, -1.0, -60.0), Vec3::new(60.0, 0.00, 60.0)),
            Brush::new(Vec3::new(  2.0,  0.0, -60.0), Vec3::new(60.0, 0.25,  0.0)),
            Brush::new(Vec3::new(  2.0,  0.0,   0.0), Vec3::new(60.0, 0.50, 60.0)),
            Brush::new(Vec3::new(  3.0,  0.0, -60.0), Vec3::new(60.0, 0.50,  0.0)),
            Brush::new(Vec3::new(  3.0,  0.0,   0.0), Vec3::new(60.0, 0.75, 60.0)),
            Brush::new(Vec3::new(  4.0,  0.0, -60.0), Vec3::new(60.0, 0.75,  0.0)),
            Brush::new(Vec3::new(  4.0,  0.0,   0.0), Vec3::new(60.0, 1.00, 60.0)),
            Brush::new(Vec3::new(  5.0,  0.0, -60.0), Vec3::new(60.0, 1.00,  0.0)),
            Brush::new(Vec3::new(  5.0,  0.0,   0.0), Vec3::new(60.0, 1.25, 60.0)),
            Brush::new(Vec3::new(  6.0,  0.0, -60.0), Vec3::new(60.0, 1.25,  0.0)),
            Brush::new(Vec3::new(  6.0,  0.0,   0.0), Vec3::new(60.0, 1.50, 60.0)),
            Brush::new(Vec3::new(  7.0,  0.0, -60.0), Vec3::new(60.0, 1.50,  0.0)),
            Brush::new(Vec3::new(  7.0,  0.0,   0.0), Vec3::new(60.0, 1.75, 60.0)),
            Brush::new(Vec3::new(  8.0,  0.0, -60.0), Vec3::new(60.0, 1.75,  0.0)),
            Brush::new(Vec3::new(  8.0,  0.0,   0.0), Vec3::new(60.0, 2.00, 60.0)),
            Brush::new(Vec3::new(  9.0,  0.0, -60.0), Vec3::new(60.0, 2.00,  0.0)),
            Brush::new(Vec3::new(  9.0,  0.0,   0.0), Vec3::new(60.0, 2.25, 60.0)),
            Brush::new(Vec3::new( 10.0,  0.0, -60.0), Vec3::new(60.0, 2.25,  0.0)),
            Brush::new(Vec3::new( 10.0,  0.0,   0.0), Vec3::new(60.0, 2.50, 60.0)),
            Brush::new(Vec3::new( 11.0,  0.0, -60.0), Vec3::new(60.0, 2.50,  0.0)),
            Brush::new(Vec3::new( 11.0,  0.0,   0.0), Vec3::new(60.0, 2.75, 60.0)),
        ];
        static FLIGHT: Map = Map::fixture(STEPS, FIXTURE_SPAWNS);

        const SPEED: f32 = 8.0;
        const TICKS: usize = 64 * 3;
        const SKEW: f32 = 0.105; // about six degrees, the error of not aiming

        let climb = |skew: f32| {
            let mut position = Vec3::new(0.0, PLAYER_HALF_EXTENTS.y, 0.0);
            let wish = Vec3::new(skew.cos(), 0.0, skew.sin()) * (SPEED / 64.0);
            for _ in 0..TICKS {
                position = move_and_slide(
                    position,
                    PLAYER_HALF_EXTENTS,
                    wish + Vec3::new(0.0, -0.15, 0.0),
                    &FLIGHT,
                )
                .position;
            }
            position
        };

        let left = climb(-SKEW);
        let right = climb(SKEW);

        // Both have to actually get up the flight, or the test is measuring
        // two players standing at the bottom of it.
        for (name, end) in [("left", left), ("right", right)] {
            assert!(
                end.y > 2.0,
                "climbing {name} only reached {:.2} m; the flight tops out at 2.5",
                end.y
            );
        }

        // Equal and opposite, so the honest part cancels and only bias is
        // left. Half a metre over twenty-four metres of run is generous - the
        // unfixed resolver drifted several times that.
        let bias = (left.z + right.z).abs();
        assert!(
            bias < 0.5,
            "climbing at +/-6 degrees drifted {bias:.2} m to one side \
             (left ended at z {:.2}, right at z {:.2}); the two should cancel",
            left.z,
            right.z
        );
    }

    #[test]
    fn step_up_does_not_climb_chest_high_cover() {
        // The same mechanism must not let someone walk onto cover they are
        // supposed to have to jump or shoot over.
        static COVER_BRUSHES: &[Brush] = &[
            Brush::new(Vec3::new(-20.0, -1.0, -20.0), Vec3::new(20.0, 0.0, 20.0)),
            Brush::new(Vec3::new(2.0, 0.0, -5.0), Vec3::new(3.0, 1.3, 5.0)),
        ];
        static COVER: Map = Map::fixture(COVER_BRUSHES, FIXTURE_SPAWNS);

        let mut position = Vec3::new(0.0, PLAYER_HALF_EXTENTS.y, 0.0);
        for _ in 0..64 {
            position = move_and_slide(
                position,
                PLAYER_HALF_EXTENTS,
                Vec3::new(8.0 / 64.0, -0.15, 0.0),
                &COVER,
            )
            .position;
        }

        assert!(
            position.x < 2.0,
            "walked straight onto chest-high cover, reaching x={}",
            position.x
        );
    }

    #[test]
    fn a_resolved_position_is_never_inside_geometry() {
        for (dx, dz) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (1.0, 1.0), (1.0, -1.0)] {
            let start = Vec3::new(0.0, PLAYER_HALF_EXTENTS.y, 0.0);
            let result = move_and_slide(
                start,
                PLAYER_HALF_EXTENTS,
                Vec3::new(dx * 20.0, -2.0, dz * 20.0),
                &FIXTURE,
            );
            assert!(
                !overlaps_any(result.position, PLAYER_HALF_EXTENTS, &FIXTURE),
                "ended inside geometry at {:?} moving ({dx},{dz})",
                result.position
            );
        }
    }
}
