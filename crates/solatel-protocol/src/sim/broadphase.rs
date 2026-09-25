//! A spatial index over the map's brushes.
//!
//! # Why
//!
//! Everything that touches the world - resolving a step of movement, probing
//! for ground, tracing a shot - used to compare against *every* brush in the
//! map. That was fine when a map was a hundred hand-written boxes. It is not
//! fine now that collision is derived from the art: the arena is about a
//! thousand brushes and a larger map is several thousand, and the work is done
//! several times per axis per sub-step, sixty-four times a second, for every
//! player on the server and again on every client predicting itself.
//!
//! This turns that linear scan into a lookup. The map is divided into cells,
//! each holding the brushes that overlap it, and a query visits only the cells
//! the query box touches.
//!
//! # The one thing that must not change
//!
//! The answer. The client predicts with this code and the server decides with
//! it, and if an index ever hid a brush from one of them, a player would walk
//! through a wall on one side and into it on the other - which in a game that
//! pays per kill means paying the wrong person. So the index is only ever
//! allowed to *narrow* the candidates, never to decide: every brush it returns
//! is still tested exactly as before, and `matches_brute_force` asserts that
//! what it returns is what a full scan would have found.

use super::map::Brush;
use glam::Vec3;

/// Edge length of one cell, in metres.
///
/// A little larger than the player's box and most props, so a typical query
/// touches one to four cells. Smaller cells mean more of them to walk; larger
/// ones mean each holds more brushes and the index buys less.
const CELL: f32 = 4.0;

/// Above this many brushes the index pays for itself. Below it, building and
/// walking cells costs more than the scan it replaces - a test fixture with
/// four brushes should not be paying for a hash grid.
const WORTH_INDEXING: usize = 64;

pub struct Broadphase {
    /// `None` when the map is small enough that a full scan is cheaper.
    grid: Option<Grid>,
}

struct Grid {
    origin: Vec3,
    /// Cell counts along x, y and z.
    dims: [usize; 3],
    /// Start of each cell's slice in `entries`, with one extra at the end.
    starts: Vec<u32>,
    /// Brush indices, grouped by cell.
    entries: Vec<u32>,
}

impl Broadphase {
    pub fn build(brushes: &[Brush]) -> Self {
        if brushes.len() < WORTH_INDEXING {
            return Self { grid: None };
        }

        let mut low = Vec3::splat(f32::INFINITY);
        let mut high = Vec3::splat(f32::NEG_INFINITY);
        for brush in brushes {
            low = low.min(brush.min);
            high = high.max(brush.max);
        }

        let span = high - low;
        let dims = [
            ((span.x / CELL).ceil() as usize).max(1),
            ((span.y / CELL).ceil() as usize).max(1),
            ((span.z / CELL).ceil() as usize).max(1),
        ];
        let cells = dims[0] * dims[1] * dims[2];

        // Counting sort: tally how many brushes land in each cell, turn that
        // into offsets, then fill. One pass more than a vector of vectors, and
        // one allocation instead of thousands.
        let mut counts = vec![0u32; cells + 1];
        for brush in brushes {
            for cell in cells_touched(low, dims, brush.min, brush.max) {
                counts[cell] += 1;
            }
        }
        let mut starts = counts;
        let mut running = 0u32;
        for slot in starts.iter_mut() {
            let count = *slot;
            *slot = running;
            running += count;
        }

        let mut cursor = starts.clone();
        let mut entries = vec![0u32; running as usize];
        for (index, brush) in brushes.iter().enumerate() {
            for cell in cells_touched(low, dims, brush.min, brush.max) {
                entries[cursor[cell] as usize] = index as u32;
                cursor[cell] += 1;
            }
        }

        Self {
            grid: Some(Grid {
                origin: low,
                dims,
                starts,
                entries,
            }),
        }
    }

    /// Calls `visit` for every brush that *might* overlap the given box.
    ///
    /// May pass the same brush more than once when it spans several cells, and
    /// may pass brushes that turn out not to overlap. Both are fine: callers
    /// test properly anyway, and the point is only to skip the thousands that
    /// are nowhere near.
    pub fn for_each_near<F>(&self, brushes: &[Brush], min: Vec3, max: Vec3, mut visit: F)
    where
        F: FnMut(usize, &Brush) -> bool,
    {
        let Some(grid) = &self.grid else {
            for (index, brush) in brushes.iter().enumerate() {
                if !visit(index, brush) {
                    return;
                }
            }
            return;
        };

        for cell in cells_touched(grid.origin, grid.dims, min, max) {
            let from = grid.starts[cell] as usize;
            let to = grid.starts[cell + 1] as usize;
            for &index in &grid.entries[from..to] {
                if !visit(index as usize, &brushes[index as usize]) {
                    return;
                }
            }
        }
    }
}

/// Every cell index a box touches, clamped to the grid.
fn cells_touched(
    origin: Vec3,
    dims: [usize; 3],
    min: Vec3,
    max: Vec3,
) -> impl Iterator<Item = usize> + use<> {
    let lo = cell_of(origin, dims, min);
    let hi = cell_of(origin, dims, max);
    let stride_y = dims[0];
    let stride_z = dims[0] * dims[1];

    (lo[2]..=hi[2]).flat_map(move |z| {
        (lo[1]..=hi[1])
            .flat_map(move |y| (lo[0]..=hi[0]).map(move |x| x + y * stride_y + z * stride_z))
    })
}

fn cell_of(origin: Vec3, dims: [usize; 3], point: Vec3) -> [usize; 3] {
    let local = (point - origin) / CELL;
    [
        (local.x.floor().max(0.0) as usize).min(dims[0] - 1),
        (local.y.floor().max(0.0) as usize).min(dims[1] - 1),
        (local.z.floor().max(0.0) as usize).min(dims[2] - 1),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::map::TEST_MAP;

    fn brute_force(brushes: &[Brush], min: Vec3, max: Vec3) -> Vec<usize> {
        brushes
            .iter()
            .enumerate()
            .filter(|(_, b)| {
                min.x < b.max.x
                    && max.x > b.min.x
                    && min.y < b.max.y
                    && max.y > b.min.y
                    && min.z < b.max.z
                    && max.z > b.min.z
            })
            .map(|(i, _)| i)
            .collect()
    }

    #[test]
    fn matches_brute_force() {
        // The index exists to be faster, and is worth nothing if it is ever
        // also different. This is the assertion the whole thing rests on: over
        // boxes scattered across the arena, at player size and at prop size,
        // the set of brushes it finds is exactly the set a full scan finds.
        let brushes = TEST_MAP.brushes;
        let index = Broadphase::build(brushes);

        let mut checked = 0;
        for step in 0..4000 {
            // A deterministic sweep, so a failure is reproducible.
            let t = step as f32;
            let centre = Vec3::new(
                (t * 0.7).sin() * 18.0,
                (t * 0.31).sin() * 6.0 + 4.0,
                (t * 0.13).cos() * 34.0,
            );
            let half = Vec3::splat(0.35 + ((t * 0.05).sin().abs() * 1.5));

            let expected = brute_force(brushes, centre - half, centre + half);

            let mut found = Vec::new();
            index.for_each_near(brushes, centre - half, centre + half, |i, b| {
                let min = centre - half;
                let max = centre + half;
                if min.x < b.max.x
                    && max.x > b.min.x
                    && min.y < b.max.y
                    && max.y > b.min.y
                    && min.z < b.max.z
                    && max.z > b.min.z
                {
                    found.push(i);
                }
                true
            });
            found.sort_unstable();
            found.dedup();

            assert_eq!(found, expected, "at {centre:?} half {half:?}");
            checked += 1;
        }
        assert!(checked > 0);
    }

    #[test]
    fn a_small_map_is_not_indexed() {
        // Below the threshold there is no grid at all, and the fallback still
        // has to visit everything.
        let few = &TEST_MAP.brushes[..8];
        let index = Broadphase::build(few);
        let mut seen = 0;
        index.for_each_near(few, Vec3::splat(-1e6), Vec3::splat(1e6), |_, _| {
            seen += 1;
            true
        });
        assert_eq!(seen, few.len());
    }

    #[test]
    fn visiting_stops_when_asked() {
        let brushes = TEST_MAP.brushes;
        let index = Broadphase::build(brushes);
        let mut seen = 0;
        index.for_each_near(brushes, Vec3::splat(-1e6), Vec3::splat(1e6), |_, _| {
            seen += 1;
            false
        });
        assert_eq!(seen, 1, "returning false should stop the walk immediately");
    }
}
