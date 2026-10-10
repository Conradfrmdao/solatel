#!/usr/bin/env python3
"""Where the collision stops a shot that the drawn map lets through.

    python scripts/check-openings.py arena
    python scripts/check-openings.py yard --map-rs /tmp/old-map.rs

`check-passable.py` asks whether a player can walk where the art is open,
and `check-collision.py` whether the walls a player can see are solid. This
asks the third question, which on a map people are paid to shoot across is
not a small one: whether a round goes where the player can see it would.
Conrad could not shoot through a window in the arena's tower room, nor
through the openings under its high walkway, and both were the collision
filling air the art leaves open - every window over a player's head, filled
from the ground to the eaves (see `derive-brushes.obstacle_heights`).

How it decides:

* **From everywhere a player can stand**: the ground, and the top of every
  brush with a body's height of air over it. Rays at the heights a gun is
  held - crouched, at the shoulder, at the eye - in sixteen directions and
  three pitches, each traced by Embree twice: against everything drawn, and
  against the brush table.
* **A ray counts when the derived structure stops it in open air.** The
  drawn map must let it go on at least `GAP` metres - measured square to the
  face it struck, so a ray grazing a wall a cell off its art is not an
  opening - and nothing drawn may be within `AIR` of where it stopped, any
  of twenty-six ways round. A box a few centimetres past the end of a wall
  is quantisation, not an opening; checked along the axes alone it read as
  one, because the wall's end is diagonal from it.
* **Every ray is cast twice, a few millimetres apart**, and the nearer hit
  believed: the arena's faces meet on round coordinates, and a ray down a
  shared edge slips between the two triangles.
* **Only the derived structure is judged.** The stated perimeter and the
  sealed margin are meant to be invisible, a prop is its own boxes (a car's
  cabin is solid on purpose), and a sealed pocket is meant to be filled.

What it lists that is not an opening: the low space under the low end of a
sloped ramp - the ground pass fills anything under a surface in the
player's band from the floor up; the underside of a floor slab, given its
thickness downwards; trees on the facility, which the client draws from data
the model does not hold. Look at the large ones.
"""
import argparse
import importlib.util
import os
import re
import sys

import numpy as np
from embreex import rtcore_scene as rtcs
from embreex.mesh_construction import TriangleMesh
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_RS = os.path.join(ROOT, 'crates', 'solatel-protocol', 'src', 'sim', 'map.rs')

# How far past the face that stopped it the drawn map must let a ray go.
GAP = 1.5
# The same, square to that face.
SQUARE = 0.6
# How clear of anything drawn the point where it stopped must be.
AIR = 0.4
# Where a gun is held above the feet: crouched, shoulder, eye.
HELD = (1.05, 1.40, 1.72)
PITCHES = (-12.0, 0.0, 12.0)
# Rays further than this are not judged: past it a round has usually
# landed on something else anyway, and the far ends of a map are mostly the
# stated perimeter.
REACH = 40.0


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'),
                                                  os.path.join(ROOT, 'scripts', f'{name}.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def table(path, name):
    """The map's scale, its brushes, and where its derived structure is."""
    with open(path, encoding='utf-8') as handle:
        text = handle.read()
    scale = float(re.search(
        rf'pub static {name.upper()}: Map = Map::new\(\s*"{name}",\s*([0-9.]+)', text).group(1))
    head, block = text.split(f'static {name.upper()}_BRUSHES: &[Brush] = &[')
    block = block.split('];')[0]
    # The generator's own count of each kind, in the comment over the table.
    counts = re.findall(r'// [0-9]+ brushes: ([0-9]+) stated perimeter, ([0-9]+) derived structure',
                        head)[-1]
    brushes = np.array([[float(v) for v in m.groups()] for m in re.finditer(
        r'brush\((-?[0-9.]+), (-?[0-9.]+), (-?[0-9.]+), (-?[0-9.]+), (-?[0-9.]+), (-?[0-9.]+)\)',
        block)])
    frame, structure = int(counts[0]), int(counts[1])
    return scale, brushes, (frame, frame + structure)


def drawn(derive, path):
    """Every triangle a player sees: each mesh but the collision-only ones."""
    js, blob = derive.read_glb(path)
    nodes = js['nodes']
    world, hidden = {}, set()

    def walk(index, parent, hide):
        world[index] = parent @ derive.node_matrix(nodes[index])
        hide = hide or bool(nodes[index].get('extras', {}).get('collision_only'))
        if hide:
            hidden.add(index)
        for child in nodes[index].get('children', []):
            walk(child, world[index], hide)

    for root in js['scenes'][js.get('scene', 0)]['nodes']:
        walk(root, np.eye(4), False)
    out = []
    for index, node in enumerate(nodes):
        if 'mesh' not in node or index in hidden or index not in world:
            continue
        for prim in js['meshes'][node['mesh']]['primitives']:
            points = derive.accessor(js, blob, prim['attributes']['POSITION'])
            homogeneous = np.hstack([points, np.ones((len(points), 1))])
            verts = (world[index] @ homogeneous.T).T[:, :3] * derive.SCALE
            if 'indices' in prim:
                face = derive.accessor(js, blob, prim['indices']).astype(int).reshape(-1, 3)
            else:
                face = np.arange(len(points)).reshape(-1, 3)
            out.append(verts[face])
    return np.ascontiguousarray(np.vstack(out).astype(np.float32))


def boxes(b):
    """Twelve triangles a brush."""
    lo, hi = b[:, None, :3], b[:, None, 3:]
    corner = np.array([[x, y, z] for x in (0, 1) for y in (0, 1) for z in (0, 1)], float)
    corners = lo + (hi - lo) * corner[None]
    faces = np.array([[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
                      [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]])
    return np.ascontiguousarray(corners[:, faces].reshape(-1, 3, 3).astype(np.float32))


def scene(triangles):
    made = rtcs.EmbreeScene()
    TriangleMesh(made, triangles)
    return made


def cast(where, origins, directions, far):
    """Distance, primitive and normal of the first hit, in batches."""
    t = np.full(len(origins), np.inf)
    prim = np.full(len(origins), -1)
    normal = np.zeros((len(origins), 3))
    for i in range(0, len(origins), 200_000):
        o = np.ascontiguousarray(origins[i:i + 200_000], np.float32)
        d = np.ascontiguousarray(directions[i:i + 200_000], np.float32)
        hit = where.run(o, d, dists=np.full(len(o), far, np.float32), output=1)
        found = hit['primID'] >= 0
        t[i:i + 200_000] = np.where(found, hit['tfar'], np.inf)
        prim[i:i + 200_000] = hit['primID']
        normal[i:i + 200_000] = hit['Ng']
    return t, prim, normal


def nearest(where, origins, directions, far=60.0):
    """Cast twice a few millimetres apart and believe the nearer hit."""
    best, prim, normal = cast(where, origins, directions, far)
    again = cast(where, origins + np.array([0.0031, 0.0047, -0.0023], np.float32), directions, far)
    closer = again[0] < best
    return (np.where(closer, again[0], best), np.where(closer, again[1], prim),
            np.where(closer[:, None], again[2], normal))


def stands(brushes, step):
    """The ground and every brush top with a body's height of air over it,
    on a grid kept off round numbers."""
    lo, hi = brushes[:, :3].min(0), brushes[:, 3:].max(0)
    bucket = 8.0
    buckets = {}
    for k, b in enumerate(brushes):
        for i in range(int((b[0] - lo[0]) // bucket), int((b[3] - lo[0]) // bucket) + 1):
            for j in range(int((b[2] - lo[2]) // bucket), int((b[5] - lo[2]) // bucket) + 1):
                buckets.setdefault((i, j), []).append(k)
    out = []
    for x in np.arange(lo[0] + 1.0137, hi[0] - 1, step):
        for z in np.arange(lo[2] + 1.0291, hi[2] - 1, step):
            near = brushes[buckets.get((int((x - lo[0]) // bucket), int((z - lo[2]) // bucket)), [])]
            over = near[(near[:, 0] <= x) & (near[:, 3] >= x) & (near[:, 2] <= z) & (near[:, 5] >= z)]
            for top in np.unique(np.round(np.concatenate([[0.0], over[:, 4]]), 3)):
                if not ((over[:, 1] < top + 1.8) & (over[:, 4] > top + 0.01)).any():
                    out.append((x, top, z))
    return np.array(out)


def main(name, path, step, listed):
    derive = load('derive-brushes')
    scale, brushes, (first, last) = table(path, name)
    derive.SCALE = scale
    art = scene(drawn(derive, os.path.join(ROOT, 'assets', 'maps', f'{name}.glb')))
    collision = scene(boxes(brushes))

    places = stands(brushes, step)
    turn = np.radians(np.arange(16) * 22.5 + 0.7)
    tilt = np.radians(np.array(PITCHES) + 0.4)
    ways = np.array([[np.sin(a) * np.cos(p), np.sin(p), -np.cos(a) * np.cos(p)]
                     for a in turn for p in tilt])
    round_ = np.array([(a, b, c) for a in (-1, 0, 1) for b in (-1, 0, 1) for c in (-1, 0, 1)
                       if (a, b, c) != (0, 0, 0)], float)
    round_ /= np.linalg.norm(round_, axis=1, keepdims=True)
    print(f'{name}: {len(places):,} places to stand, {len(places) * len(ways) * len(HELD):,} rays',
          file=sys.stderr)

    stopped = []
    for held in HELD:
        o = np.repeat(places + np.array([0.0, held, 0.0]), len(ways), axis=0).astype(np.float32)
        d = np.tile(ways, (len(places), 1)).astype(np.float32)
        art_t, _, _ = nearest(art, o, d)
        box_t, prim, normal = nearest(collision, o, d)
        which = prim // 12
        unit = normal / np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-9)
        square = np.abs((unit * d).sum(1))
        with np.errstate(invalid='ignore'):
            beyond = np.where(np.isfinite(art_t), (art_t - box_t) * square, np.inf)
            short = np.isfinite(box_t) & (box_t < REACH) & (art_t - box_t > GAP)
        candidates = np.flatnonzero(short & (beyond > SQUARE) & (square > 0.35)
                                    & (which >= first) & (which < last))
        p = o[candidates] + d[candidates] * box_t[candidates, None]
        clear = np.ones(len(candidates), bool)
        for way in round_:
            t, _, _ = cast(art, (p - way * 0.02).astype(np.float32),
                           np.tile(way, (len(p), 1)).astype(np.float32), AIR + 0.02)
            clear &= ~np.isfinite(t)
        stopped.append(np.column_stack([p[clear], which[candidates][clear]]))
    stopped = np.vstack(stopped)

    print(f'{name}: {len(stopped):,} rays stopped by the structure where nothing is drawn')
    if not len(stopped):
        return
    cells = np.floor(stopped[:, :3] / 0.5).astype(int)
    lo = cells.min(0)
    occupied = np.zeros(tuple(cells.max(0) - lo + 1), bool)
    occupied[tuple((cells - lo).T)] = True
    labels, count = ndimage.label(occupied, structure=np.ones((3, 3, 3)))
    label = labels[tuple((cells - lo).T)]
    sizes = np.bincount(label)
    print(f'  in {count} places. The largest:')
    for k in np.argsort(-sizes)[:listed]:
        if k == 0 or sizes[k] == 0:
            continue
        here = stopped[label == k]
        a, b = here[:, :3].min(0), here[:, :3].max(0)
        print(f'  {sizes[k]:6d} rays  x {a[0]:7.2f}..{b[0]:7.2f}  y {a[1]:5.2f}..{b[1]:5.2f}  '
              f'z {a[2]:7.2f}..{b[2]:7.2f}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('name', nargs='?', default='arena')
    parser.add_argument('--map-rs', default=MAP_RS, help='a brush table other than the current one')
    parser.add_argument('--step', type=float, default=None,
                        help='metres between places sampled (1.0 on the arena, 1.5 elsewhere)')
    parser.add_argument('--list', type=int, default=25)
    args = parser.parse_args()
    main(args.name, args.map_rs, args.step or (1.0 if args.name == 'arena' else 1.5), args.list)
