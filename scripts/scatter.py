#!/usr/bin/env python3
"""Where loose rubbish lies on each map: rubble, grit, litter and offcuts at
the foot of walls and in corners, where wind and feet push it.

    pip install embreex numpy           # once: Intel's ray tracer
    python scripts/scatter.py           # every map
    python scripts/scatter.py yard      # just one

Writes `assets/scatter/<map>.bin`, which `scatter.js` draws. Run it after
anything that changes a map's geometry.

**Placed from the drawn map, not the collision.** The collision has walls
nobody can see - the guardrail round the yard's edge, pits filled in so
nobody is trapped in them - and rubbish lined up along one would be lying
about where a wall is. So the floor is every face of the art that points up,
sampled by area, and a wall is whatever a ray along the floor runs into.

**Only by walls.** Rubbish collects where something stops it, so a point is
kept with a chance that falls off with its distance from the nearest wall,
and rises in a corner - two walls near, from two directions. Open ground is
left clean, which is also where players look for each other.

**Never a place to hide.** The tallest piece is about fifteen centimetres,
under a crouched player's ankle; it is decoration, collides with nothing and
is the same at every graphics level.

Format, little-endian: b'SCT1', a u32 count, then sixteen bytes a piece -
x, y and z in metres (three f32), then the way it is turned (u8, of 256),
its size (u8, 0.6 to 1.4), what it is (u8, `KINDS`), and which shape of it
(u8).
"""
import importlib.util
import os
import struct
import sys
import time

import numpy as np
from embreex import rtcore_scene as rtcs
from embreex.mesh_construction import TriangleMesh

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def script(name):
    """Another script in this folder, as a module: they have hyphens."""
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'),
                                                  os.path.join(ROOT, 'scripts', f'{name}.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BRUSHES = script('derive-brushes')
MAPS = {name: scale for name, scale, *_ in script('derive-maps').MAPS}

# What the client knows how to draw, by number (`KINDS` in `scatter.js`).
KINDS = ['rubble', 'grit', 'brick', 'offcut', 'paper', 'can', 'twig', 'stone']

# Rubbish lies in heaps, not sprinkled: a heap is one of these, as weights
# over `KINDS`, and what a floor is made of decides which heaps it gets.
HEAPS = {
    'rubble': [5, 4, 2, 0.3, 0.2, 0.1, 0, 0],
    'litter': [0.3, 1, 0, 0.6, 4, 2, 0, 0],
    'timber': [0.5, 1.5, 0, 5, 0.5, 0.2, 0, 0],
    'brush': [0, 0, 0, 0, 0.2, 0.1, 5, 2],
    'stones': [0.5, 2, 0, 0, 0, 0, 0.5, 5],
}
HARD = {'rubble': 6, 'litter': 1.2, 'timber': 1}
FLOORS = {
    'grass': {'brush': 4, 'stones': 1},
    'grass_dry': {'brush': 4, 'stones': 1},
    'meadow': {'brush': 4, 'stones': 1},
    'dirt': {'stones': 3, 'brush': 2, 'rubble': 1},
    'gravel': {'stones': 3, 'rubble': 1},
    'shore': {'stones': 4},
    'wood': {'timber': 3, 'litter': 1},
    'wood_dark': {'timber': 3, 'litter': 1},
}
# Never on these: nothing gathers on water, glass, or the top of a crate.
NONE = {'water', 'glass', 'chainlink', 'lamp', 'crate_olive', 'crate_rust', 'wood_pallet',
        'barrel_rust', 'barrel_olive', 'barrel_blue', 'car_red', 'car_blue', 'car_olive', 'car_white',
        'container_rust', 'container_blue', 'container_grey', 'container_olive', 'tank_white',
        'rubber', 'foliage', 'foliage_dark', 'sandbag'}

# Candidate points per square metre of floor, before most are dropped.
DENSITY = 5.0
# How far from a wall rubbish still gathers.
REACH = 0.9
# The share of candidates right against a wall that start a heap.
KEEP = 0.05
# Heaps on the ground are what a player walks past; one on a roof or a
# stair tread is worth this much of one.
RAISED = 0.3
# Pieces in a heap, and how far they spread from its middle, in metres.
HEAP = (3, 14)
SPREAD = 0.35
# Room the rubbish needs above it: under a shelf or a step is not floor.
HEADROOM = 0.3
# The most a map gets, so the facility's miles of wall cost what the arena's do.
LIMIT = 16000


def drawn_floor(name):
    """Every drawn, solid triangle of a map in world metres, which material
    each is, and the material names."""
    path = os.path.join(ROOT, 'assets', 'maps', f'{name}.glb')
    scale = MAPS[name]
    js, blob = BRUSHES.read_glb(path)
    nodes = js['nodes']
    world, hidden = {}, set()

    def walk(index, parent, hide):
        node = nodes[index]
        world[index] = parent @ BRUSHES.node_matrix(node)
        hide = hide or bool(node.get('extras', {}).get('collision_only'))
        if hide:
            hidden.add(index)
        for child in node.get('children', []):
            walk(child, world[index], hide)

    for root in js['scenes'][js.get('scene', 0)]['nodes']:
        walk(root, np.eye(4), False)

    names = [m.get('name', '') for m in js.get('materials', [])]
    triangles, which = [], []
    for index, node in enumerate(nodes):
        if 'mesh' not in node or index in hidden:
            continue
        for prim in js['meshes'][node['mesh']]['primitives']:
            if prim.get('mode', 4) != 4:
                continue
            material = prim.get('material', -1)
            if material >= 0 and names[material] in ('glass', 'chainlink'):
                continue
            points = BRUSHES.accessor(js, blob, prim['attributes']['POSITION'])
            homogeneous = np.hstack([points, np.ones((len(points), 1))])
            placed = (world[index] @ homogeneous.T).T[:, :3] * scale
            if 'indices' in prim:
                faces = BRUSHES.accessor(js, blob, prim['indices']).astype(np.int64).reshape(-1, 3)
            else:
                faces = np.arange(len(points)).reshape(-1, 3)
            triangles.append(placed[faces])
            which.append(np.full(len(faces), material))
    return np.concatenate(triangles).astype(np.float32), np.concatenate(which), names


def walls(scene, points):
    """For each point: which of eight directions along the floor meet a wall
    within `REACH`, the distance to the nearest, and whether it is in a
    corner - two walls near, a quarter turn apart."""
    angles = np.arange(8) * np.pi / 4
    ring = np.stack([np.cos(angles), np.zeros(8), np.sin(angles)], axis=1).astype(np.float32)
    origins = np.repeat((points + [0, 0.08, 0]).astype(np.float32), 8, axis=0)
    dirs = np.tile(ring, (len(points), 1))
    hit = scene.run(origins, dirs, dists=np.full(len(dirs), REACH * 1.5, np.float32), output=1)
    distance = np.where(hit['primID'] >= 0, hit['tfar'], np.inf).reshape(-1, 8)
    near = distance < REACH
    corner = (near & np.roll(near, 2, axis=1)).any(axis=1)
    return near, distance.min(axis=1), corner


def scatter(name):
    started = time.time()
    triangles, which, names = drawn_floor(name)
    scene = rtcs.EmbreeScene()
    TriangleMesh(scene, triangles)
    rng = np.random.default_rng(sum(map(ord, name)))

    # The floor: faces pointing up, either way round - the art is drawn from
    # both sides and not every face is wound the same way.
    normal = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    area = np.linalg.norm(normal, axis=1) / 2
    level = np.abs(normal[:, 1]) > 0.95 * np.maximum(np.linalg.norm(normal, axis=1), 1e-12)
    named = np.array([names[m] if m >= 0 else '' for m in which])
    floor = level & (area > 0.01) & ~np.isin(named, list(NONE))
    count = rng.poisson(area[floor] * DENSITY)
    tri = np.repeat(np.flatnonzero(floor), count)
    u, v = rng.random(len(tri)), rng.random(len(tri))
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    t = triangles[tri]
    points = t[:, 0] + (t[:, 1] - t[:, 0]) * u[:, None] + (t[:, 2] - t[:, 0]) * v[:, None]
    print(f'{name}: {len(points):,} points on {area[floor].sum():,.0f} m2 of floor', file=sys.stderr)

    # The top of the floor, not the underside of a floor above it: a ray
    # straight down from just above must land on this face.
    start = (points + [0, 0.05, 0]).astype(np.float32)
    down = np.tile(np.array([[0, -1, 0]], np.float32), (len(points), 1))
    hit = scene.run(start, down, dists=np.full(len(points), 0.2, np.float32), output=1)
    on_top = hit['primID'] == tri
    # And room above it.
    up = -down
    clear = scene.run(start, up, dists=np.full(len(points), HEADROOM, np.float32), query='OCCLUDED') < 0
    keep = on_top & clear
    points, tri = points[keep], tri[keep]

    # The nearest wall in eight directions along the floor, just above it.
    near, nearest, corner = walls(scene, points)
    chance = KEEP * np.clip(1 - nearest / REACH, 0, 1) ** 1.6 * np.where(corner, 2.5, 1.0)
    chance *= np.where(points[:, 1] < 1.0, 1.0, RAISED)
    keep = rng.random(len(points)) < chance
    centres, centre_tri = points[keep], tri[keep]

    # Each heap: some pieces round its middle, each kept only if it lands
    # on floor of its own and can be seen from the middle along the floor -
    # not through a wall, or inside one.
    pieces, kinds, middles = [], [], []
    for centre, face in zip(centres, centre_tri):
        floor_name = named[face]
        heaps = FLOORS.get(floor_name, HARD)
        heap = rng.choice(list(heaps), p=np.array(list(heaps.values())) / sum(heaps.values()))
        weights = np.array(HEAPS[heap], dtype=float)
        count = rng.integers(*HEAP)
        offset = rng.normal(0, SPREAD, (count, 3)) * [1, 0, 1]
        spots = centre + offset
        pieces.append(spots)
        middles.append(np.repeat(centre[None], count, axis=0))
        kinds.append(rng.choice(len(KINDS), size=count, p=weights / weights.sum()))
    if not pieces:
        raise SystemExit(f'{name}: no rubbish placed')
    points = np.concatenate(pieces)
    middles = np.concatenate(middles)
    kinds = np.concatenate(kinds).astype(np.uint8)
    along = points - middles
    reach = np.linalg.norm(along, axis=1)
    seen = scene.run((middles + [0, 0.05, 0]).astype(np.float32),
                     (along / np.maximum(reach, 1e-6)[:, None]).astype(np.float32),
                     dists=np.maximum(reach, 1e-3).astype(np.float32), query='OCCLUDED') < 0
    points, kinds = points[seen], kinds[seen]

    # Each on a floor within a step of where its heap is, with room above
    # it and not inside anything.
    start = (points + [0, 0.25, 0]).astype(np.float32)
    down = np.tile(np.array([[0, -1, 0]], np.float32), (len(points), 1))
    hit = scene.run(start, down, dists=np.full(len(points), 0.45, np.float32), output=1)
    landed = hit['primID'] >= 0
    floor_y = start[:, 1] - hit['tfar']
    level_hit = landed & level[np.maximum(hit['primID'], 0)] & ~np.isin(named[np.maximum(hit['primID'], 0)], list(NONE))
    points[:, 1] = np.where(landed, floor_y, points[:, 1])
    room = scene.run((points + [0, 0.02, 0]).astype(np.float32), -down,
                     dists=np.full(len(points), HEADROOM, np.float32), query='OCCLUDED') < 0
    keep = level_hit & room
    points, kinds = points[keep], kinds[keep]
    if len(points) > LIMIT:
        pick = rng.choice(len(points), LIMIT, replace=False)
        points, kinds = points[pick], kinds[pick]
    turn = rng.integers(0, 256, len(points), dtype=np.uint8)
    size = rng.integers(0, 256, len(points), dtype=np.uint8)
    shape = rng.integers(0, 256, len(points), dtype=np.uint8)

    out = os.path.join(ROOT, 'assets', 'scatter', f'{name}.bin')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    record = np.zeros(len(points), dtype=[('x', '<f4'), ('y', '<f4'), ('z', '<f4'),
                                          ('turn', 'u1'), ('size', 'u1'), ('kind', 'u1'), ('shape', 'u1')])
    record['x'], record['y'], record['z'] = points[:, 0], points[:, 1], points[:, 2]
    record['turn'], record['size'], record['kind'], record['shape'] = turn, size, kinds, shape
    with open(out, 'wb') as handle:
        handle.write(b'SCT1' + struct.pack('<I', len(points)) + record.tobytes())
    tally = ', '.join(f'{KINDS[k]} {int((kinds == k).sum())}' for k in range(len(KINDS)) if (kinds == k).any())
    print(f'   {len(points):,} pieces ({tally}) -> {os.path.relpath(out, ROOT)}, '
          f'{os.path.getsize(out) / 1024:.0f} KB, {time.time() - started:.0f} s', file=sys.stderr)


if __name__ == '__main__':
    for map_name in (sys.argv[1:] or list(MAPS)):
        if map_name not in MAPS:
            raise SystemExit(f'no map called {map_name}')
        scatter(map_name)
