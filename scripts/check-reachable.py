#!/usr/bin/env python3
"""Find standing room a player cannot get to on foot.

    python scripts/check-reachable.py yard

`check-passable.py` asks whether the open space is open. This asks the other
half: whether the places a player can *stand* can be walked to. A staircase
whose treads come out a hair too tall, a roof whose only ramp was quantised
into a wall, a gantry reachable in the art and not in the table - none of
those close a doorway, so none of them show up there. They just quietly
remove a third of a map from play.

The model is a graph over (column, height), not over columns. A column under
a gantry has two floors and they are not the same place; collapsing them
would join a rooftop to the yard beneath it and declare the rooftop
reachable.

Edges are what a walking player can do: a step up of `MAX_STEP_UP`, or any
drop. Jumping is deliberately excluded - a map that can only be played by
bunny-hopping onto its own staircases is a map with a broken staircase.
"""
import importlib.util
import os
import re
import sys
from collections import deque

import numpy as np
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_RS = os.path.join(ROOT, 'crates', 'solatel-protocol', 'src', 'sim', 'map.rs')

# How much room over a surface a player needs to stand on it.
HEADROOM = 1.85

# Two surfaces within this of each other are the same surface as far as
# standing on them goes.
SAME_SURFACE = 0.12


def load_generator():
    spec = importlib.util.spec_from_file_location(
        'derive', os.path.join(ROOT, 'scripts', 'derive-brushes.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def table(name, kind):
    with open(MAP_RS, encoding='utf-8') as handle:
        source = handle.read()
    start = source.index(f'static {name.upper()}_{kind}: ')
    end = source.index('];', start)
    call = 'brush' if kind == 'BRUSHES' else 'spawn'
    rows = []
    for match in re.finditer(rf'\b{call}\(([^)]*)\)', source[start:end]):
        parts = [p.strip() for p in match.group(1).split(',')]
        rows.append([0.0 if p.startswith('EIGHTH') else float(p) for p in parts])
    return rows


def standing_surfaces(brushes, origin, shape, cell, radius):
    """Every height a player could stand at, per column.

    Built from the brush tops, then thinned twice: a surface needs headroom,
    and it needs the player's width clear at that height. The second is what
    stops a ledge one cell wide counting as somewhere to walk.
    """
    nx, nz = shape
    tops = [[[] for _ in range(nz)] for _ in range(nx)]
    spans = [[[] for _ in range(nz)] for _ in range(nx)]

    for bx0, by0, bz0, bx1, by1, bz1 in brushes:
        i0 = max(int(np.floor((bx0 - origin[0]) / cell)), 0)
        i1 = min(int(np.ceil((bx1 - origin[0]) / cell)), nx)
        j0 = max(int(np.floor((bz0 - origin[2]) / cell)), 0)
        j1 = min(int(np.ceil((bz1 - origin[2]) / cell)), nz)
        for i in range(i0, i1):
            row_t, row_s = tops[i], spans[i]
            for j in range(j0, j1):
                row_t[j].append(by1)
                row_s[j].append((by0, by1))

    surfaces = [[[] for _ in range(nz)] for _ in range(nx)]
    for i in range(nx):
        for j in range(nz):
            if not tops[i][j]:
                continue
            here = spans[i][j]
            kept = []
            for top in sorted(set(tops[i][j])):
                if any(lo < top + HEADROOM - 1e-3 and hi > top + 1e-3
                       for lo, hi in here):
                    continue  # something in the way of their head
                if kept and top - kept[-1] < SAME_SURFACE:
                    continue
                kept.append(top)
            surfaces[i][j] = kept
    return surfaces


def main(name, scale):
    derive = load_generator()
    derive.SCALE = scale
    cell = derive.CELL
    step_up = derive.MAX_STEP_UP

    brushes = table(name, 'BRUSHES')
    lows = np.asarray([b[0:3] for b in brushes])
    highs = np.asarray([b[3:6] for b in brushes])
    origin = np.array([lows[:, 0].min(), 0.0, lows[:, 2].min()])
    nx = int(np.ceil((highs[:, 0].max() - origin[0]) / cell)) + 1
    nz = int(np.ceil((highs[:, 2].max() - origin[2]) / cell)) + 1
    # Rounded, not rounded up. The player is 0.7 m across and the cells are
    # 0.25 m, so one cell either way is 0.75 m and the closest honest match;
    # two is 1.25 m and declares every corridor in the map too narrow to
    # stand in, which disconnects the map from itself. Calibrated against
    # `height_report`, which walks the same maps with the real resolver.
    radius = int(round(derive.PLAYER_RADIUS / cell))
    print(f'{name}: {len(brushes):,} brushes over {nx} by {nz} cells')

    surfaces = standing_surfaces(brushes, origin, (nx, nz), cell, radius)

    # A surface is only standing room if the player's width fits on it, which
    # means every neighbouring column has a surface at about the same height.
    def supported(i, j, h):
        for di in range(-radius, radius + 1):
            for dj in range(-radius, radius + 1):
                a, b = i + di, j + dj
                if not (0 <= a < nx and 0 <= b < nz):
                    return False
                if not any(abs(other - h) <= step_up for other in surfaces[a][b]):
                    return False
        return True

    nodes = {}
    for i in range(nx):
        for j in range(nz):
            for h in surfaces[i][j]:
                if supported(i, j, h):
                    nodes[(i, j, round(h / cell))] = h
    print(f'{name}: {len(nodes):,} places a player could stand '
          f'({len(nodes) * cell * cell:,.0f} m2 of standing room)')

    spawns = table(name, 'SPAWNS')
    seeds = []
    for x, _y, z, _yaw in spawns:
        i = int((x - origin[0]) / cell)
        j = int((z - origin[2]) / cell)
        best = None
        for (a, b, k), h in nodes.items():
            if abs(a - i) <= 3 and abs(b - j) <= 3 and (best is None or h < best[1]):
                best = ((a, b, k), h)
        if best:
            seeds.append(best[0])
    print(f'{name}: {len(seeds)} of {len(spawns)} spawns land on standing room')

    seen = set(seeds)
    queue = deque(seeds)
    while queue:
        i, j, k = queue.popleft()
        here = nodes[(i, j, k)]
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            a, b = i + di, j + dj
            if not (0 <= a < nx and 0 <= b < nz):
                continue
            for h in surfaces[a][b]:
                key = (a, b, round(h / cell))
                if key in seen or key not in nodes:
                    continue
                # Up by a step, or down by anything: falling is free.
                if h - here <= step_up + 1e-6:
                    seen.add(key)
                    queue.append(key)

    area = cell * cell
    stranded = [k for k in nodes if k not in seen]
    print(f'\n{name}: {len(seen) * area:,.0f} m2 can be walked to, '
          f'{len(stranded) * area:,.0f} m2 cannot '
          f'({100.0 * len(stranded) / max(len(nodes), 1):.1f}%)')

    if stranded:
        grid = np.zeros((nx, nz), dtype=bool)
        heights = {}
        for i, j, k in stranded:
            grid[i, j] = True
            heights.setdefault((i, j), []).append(nodes[(i, j, k)])
        labels, count = ndimage.label(grid)
        sizes = ndimage.sum_labels(grid, labels, range(1, count + 1))
        order = np.argsort(-sizes)
        print(f'\n  {count} separate patches. The largest:')
        for rank in order[:12]:
            if sizes[rank] * area < 1.0:
                break
            xs, zs = np.nonzero(labels == rank + 1)
            hs = [h for i, j in zip(xs, zs) for h in heights[(i, j)]]
            print(f'    {sizes[rank] * area:7,.0f} m2 around '
                  f'({origin[0] + xs.mean() * cell:7.1f}, '
                  f'{origin[2] + zs.mean() * cell:7.1f})  '
                  f'at {np.min(hs):5.2f} to {np.max(hs):5.2f} m')



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
    for map_name, scale in module.MAPS:
        if map_name == name:
            return scale
    raise SystemExit(f'no map called {name!r} in derive-maps.py')

if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'arena'
    main(which, scale_of(which))
