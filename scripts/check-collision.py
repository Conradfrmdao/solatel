#!/usr/bin/env python3
"""Find art a player can walk through, and collision that is not there in the art.

    python scripts/check-collision.py yard

The brushes in `sim/map.rs` are generated from the models in `assets/maps`, but
the generation is lossy on purpose - it is a height field with prop boxes on
top, not a copy of the mesh. This measures how lossy, in the only terms that
matter to a player: how much of the wall in front of them is a wall.

Two failures, opposite in sign and both bad:

* **Art with no brush behind it.** A wall you walk through, or worse, one you
  can be shot through while believing you are in cover.
* **A brush with no art anywhere near it.** An invisible wall. Less dangerous
  and far more infuriating.

Only surfaces a standing player could run into are counted, and "could" is
taken from the generator's own reachability rather than guessed at. An earlier
version took the floor under a sample to be the top of whatever brush lay
beneath it, which on a map with fourteen-metre walls meant counting the outside
of a parapet nobody can reach. It reported seven per cent where the truth was
one, and sent a morning after the wrong bug.
"""
import importlib.util
import os
import re
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_RS = os.path.join(ROOT, 'crates', 'solatel-protocol', 'src', 'sim', 'map.rs')

# Anything steeper than this is a wall rather than a floor or a roof. A player
# runs into walls; they stand on the rest.
WALL_TILT = 0.5

# Where a standing player's body is, measured from the floor under them. Below
# the ankles and above the head is geometry they walk over or under.
BODY_LOW = 0.3
BODY_HIGH = 1.7

# How far apart the samples on a surface are.
SPACING = 0.35

# A sample sits exactly on the face of the brush that should contain it, so the
# test is inflated by enough to swallow that and the generator's rounding.
TOLERANCE = 0.30


def load_generator():
    spec = importlib.util.spec_from_file_location(
        'derive', os.path.join(ROOT, 'scripts', 'derive-brushes.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def brush_table(name):
    with open(MAP_RS, encoding='utf-8') as handle:
        source = handle.read()
    start = source.index(f'static {name.upper()}_BRUSHES: ')
    end = source.index('];', start)
    rows = [
        [float(p) for p in match.group(1).split(',')]
        for match in re.finditer(r'\bbrush\(([^)]*)\)', source[start:end])
    ]
    return np.asarray(rows, dtype=np.float32)


def inside_any(points, lows, highs, chunk=20000):
    """Is each point inside a brush, allowing for the sample sitting on a face?"""
    out = np.zeros(len(points), dtype=bool)
    for begin in range(0, len(points), chunk):
        block = points[begin:begin + chunk]
        hit = np.ones((len(block), len(lows)), dtype=bool)
        for axis in range(3):
            hit &= block[:, None, axis] >= lows[None, :, axis] - TOLERANCE
            hit &= block[:, None, axis] <= highs[None, :, axis] + TOLERANCE
        out[begin:begin + chunk] = hit.any(axis=1)
    return out


def reachable_floors(derive, name, scale):
    """Where a player can put their feet, from the generator's own reckoning.

    This re-does the voxelisation, which is slow on a large map and is the
    honest cost of asking the right question. The alternative - reading floor
    heights off the brush table - cannot tell a floor from the top of a wall,
    and that distinction is the whole of this measurement.
    """
    model = os.path.join(ROOT, 'assets', 'maps', f'{name}.glb')
    derive.SCALE = scale
    meshes = derive.mesh_nodes(model)
    _, structure = derive.classify(meshes)
    offset, verts, faces = 0, [], []
    for _, mesh_verts, mesh_faces in structure:
        verts.append(mesh_verts)
        faces.append(mesh_faces + offset)
        offset += len(mesh_verts)
    grid, origin = derive.voxelise(np.vstack(verts), np.vstack(faces))
    standing, reachable = derive.climb(derive.obstacle_heights(grid), grid)
    return standing, reachable, origin


def floor_beside_each(points, standing, reachable, origin, cell):
    """The highest floor within a metre of each sample that it stands above.

    A metre because a wall is beside the floor rather than on it: the sample
    is on the wall's face and the player is in the next column over.
    """
    nx, nz = reachable.shape
    ix = np.clip(((points[:, 0] - origin[0]) / cell).astype(int), 0, nx - 1)
    iz = np.clip(((points[:, 2] - origin[2]) / cell).astype(int), 0, nz - 1)

    reach = int(round(1.0 / cell))
    best = np.full(len(points), -np.inf, dtype=np.float32)
    for dx in range(-reach, reach + 1):
        for dz in range(-reach, reach + 1):
            sx = np.clip(ix + dx, 0, nx - 1)
            sz = np.clip(iz + dz, 0, nz - 1)
            here = np.where(reachable[sx, sz], standing[sx, sz], -np.inf)
            usable = (here <= points[:, 1] - BODY_LOW + 1e-3) & (
                here >= points[:, 1] - BODY_HIGH - 1e-3)
            best = np.where(usable & (here > best), here, best)
    return best


def main(name, scale):
    derive = load_generator()
    derive.SCALE = scale

    model = os.path.join(ROOT, 'assets', 'maps', f'{name}.glb')
    meshes = derive.mesh_nodes(model)
    verts = np.vstack([m[1] for m in meshes])
    offset, faces = 0, []
    for _, mesh_verts, mesh_faces in meshes:
        faces.append(mesh_faces + offset)
        offset += len(mesh_verts)
    faces = np.vstack(faces)

    tri = verts[faces]
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    normals = np.cross(b - a, c - a)
    lengths = np.linalg.norm(normals, axis=1)
    keep = lengths > 1e-9
    upright = np.zeros(len(faces), dtype=bool)
    upright[keep] = np.abs(normals[keep, 1] / lengths[keep]) < WALL_TILT

    walls = faces[upright]
    print(f'{name}: {len(faces):,} triangles, {len(walls):,} of them wall-facing')

    points = derive.sample_triangles(verts, walls, SPACING)
    brushes = brush_table(name)
    lows, highs = brushes[:, 0:3], brushes[:, 3:6]
    print(f'{name}: {len(points):,} surface samples against {len(brushes):,} brushes')

    standing, reachable, origin = reachable_floors(derive, name, scale)
    floors = floor_beside_each(points, standing, reachable, origin, derive.CELL)
    standable = np.isfinite(floors)
    body = points[standable]
    print(f'{name}: {len(body):,} of them beside somewhere a player can stand '
          f'({100.0 * len(body) / len(points):.1f}%)')

    covered = inside_any(body, lows, highs)
    missing = body[~covered]
    share = 100.0 * len(missing) / max(len(body), 1)
    print(f'\nreachable wall with no brush behind it: {share:.2f}% '
          f'({len(missing):,} samples)')

    if len(missing):
        under = floors[standable][~covered]
        print('\n  the floor a player would be standing on:')
        for low, high in ((-1, 1), (1, 3), (3, 6), (6, 10), (10, 100)):
            count = int(((under >= low) & (under < high)).sum())
            print(f'    {low:>3} to {high:<4} m  {count:>7,}  '
                  f'{100.0 * count / len(under):5.1f}%')

        # Cluster loosely by rounding to five metres, so the report names
        # places rather than listing thousands of neighbouring samples.
        cells = np.floor(missing[:, [0, 2]] / 5.0).astype(int)
        unique, counts = np.unique(cells, axis=0, return_counts=True)
        order = np.argsort(-counts)
        print('\n  worst places (x, z of a 5 m cell, samples, heights):')
        for index in order[:10]:
            cx, cz = unique[index] * 5.0 + 2.5
            here = missing[(cells == unique[index]).all(axis=1)]
            print(f'    {cx:8.1f} {cz:8.1f}   {counts[index]:>5}   '
                  f'y {here[:, 1].min():.1f} to {here[:, 1].max():.1f}')

    return share



def scale_of(name):
    """The scale this map is generated at, from the one place it is stated.

    Hardcoding it here once meant these audits voxelised the art at 4.0
    while the brushes had been generated at 4.6, and then reported that a
    third of the arena was unreachable - two different-sized worlds compared
    against each other. There is one list of maps and scales and it lives in
    `derive-maps.py`.
    """
    spec = importlib.util.spec_from_file_location(
        'derive_maps', os.path.join(ROOT, 'scripts', 'derive-maps.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for map_name, scale, *_ in module.MAPS:
        if map_name == name:
            return scale
    raise SystemExit(f'no map called {name!r} in derive-maps.py')

if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'yard'
    main(which, scale_of(which))
