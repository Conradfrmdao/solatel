#!/usr/bin/env python3
"""Where new geometry may be built without the generator welding it down.

    python scripts/check-buildable.py arena -20 -9 21 31

Run this before adding anything to a map that has air under it - a walkway,
a bridge, a gantry, an upper floor. It prints the obstacle height the
generator will measure in each column, and marks the ones nothing may be
built over.

The rule it is checking is in `derive-brushes.obstacle_heights`, and it is
not visible in the geometry. A column whose own obstacle fills the player's
band is treated as a wall, and a wall's height is read from the *highest
surface anywhere in that column* - so a deck thrown over a ramp that reaches
head height is not read as spanning it. The two become one obstacle and
everything between them fills in solid.

That is not hypothetical. The first attempt at joining the arena's
north-west corner was a bridge over exactly such a ramp, four metres of
clear air beneath it, and it sealed the corner it was built to open: 275 m2
of roof went from reachable to stranded. A staircase in the open yard beside
it worked, because a staircase rests on the ground and has nothing above it
to be welded to.

So: anything ground-resting is safe anywhere. Anything with air under it
needs every column beneath it to come back clear here.
"""
import importlib.util
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(map_name, x0, x1, z0, z1, step=2):
    derive = load('derive', os.path.join(ROOT, 'scripts', 'derive-brushes.py'))
    check = load('check', os.path.join(ROOT, 'scripts', 'check-reachable.py'))
    derive.SCALE = check.scale_of(map_name)

    model = os.path.join(ROOT, 'assets', 'maps', f'{map_name}.glb')
    meshes = derive.mesh_nodes(model)
    _props, structure = derive.classify(meshes)
    offset, verts, faces = 0, [], []
    for _name, mesh_verts, mesh_faces in structure:
        verts.append(mesh_verts)
        faces.append(mesh_faces + offset)
        offset += len(mesh_verts)
    grid, origin = derive.voxelise(np.vstack(verts), np.vstack(faces))
    height = derive.obstacle_heights(grid)

    cell = derive.CELL
    ceiling = min(int(np.ceil(derive.PLAYER_BAND / cell)), grid.shape[1])
    blocked = (ceiling - 1) * cell

    print(f'{map_name}: obstacle height per column, in metres.')
    print(f'"#" marks {blocked:.2f} m or more, which fills the player band. '
          f'Nothing may be\nbuilt over those columns - the generator welds '
          f'them to whatever is overhead.\n')

    i0 = max(int((x0 - origin[0]) / cell), 0)
    i1 = min(int((x1 - origin[0]) / cell), height.shape[0] - 1)
    j0 = max(int((z0 - origin[2]) / cell), 0)
    j1 = min(int((z1 - origin[2]) / cell), height.shape[1] - 1)
    if i1 <= i0 or j1 <= j0:
        raise SystemExit('that rectangle is outside the map')

    print('        ' + ''.join(
        f'{origin[2] + j * cell:6.1f}' for j in range(j0, j1 + 1, step)))
    clear = total = 0
    for i in range(i0, i1 + 1, step):
        row = []
        for j in range(j0, j1 + 1, step):
            total += 1
            here = height[i, j]
            if here >= blocked - 1e-6:
                row.append(f'{here:5.2f}#')
            elif here > 0:
                row.append(f'{here:6.2f}')
                clear += 1
            else:
                row.append('     .')
                clear += 1
        print(f'  {origin[0] + i * cell:6.1f}' + ''.join(row))
    print(f'\n{clear} of {total} sampled columns are clear to build over.')


if __name__ == '__main__':
    if len(sys.argv) != 6:
        print(__doc__)
        raise SystemExit(2)
    main(sys.argv[1], *(float(v) for v in sys.argv[2:6]))
