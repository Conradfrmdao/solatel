#!/usr/bin/env python3
"""Where new geometry may be built without the generator joining it down.

    python scripts/check-buildable.py arena -20 -9 21 31 [deck height]

Run this before adding anything to a map that has air under it - a walkway,
a bridge, a gantry, an upper floor. It prints the obstacle height the
generator will measure in each column and, given the height of the deck,
marks the columns it would be joined to.

The rule it is checking is in `derive-brushes.standing_runs`, and it is not
visible in the geometry. Anything off the ground reaches down to whatever is
under it when it is within a step of it - that is what makes a staircase of
separate treads solid - so a deck less than a step over an obstacle is read
as one more tread and the air between them fills in solid.

It used to be far worse. A column whose obstacle filled the player's band
was read as a wall up to the *highest surface anywhere in it*, so a deck at
any height over a ramp that reached head height welded down to it: the first
attempt at joining the arena's north-west corner was a bridge over exactly
such a ramp, four metres of clear air beneath it, and it sealed 275 m2 of
roof it was built to open. The same rule filled every window over a
player's head and the air under every walkway. A wall is now followed up
only as far as it goes (`obstacle_heights`), and a step is the whole of it.

So: anything ground-resting is safe anywhere, and anything with air under
it needs more than a step of it.
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


def main(map_name, x0, x1, z0, z1, deck=None, step=2):
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
    reach = derive.MAX_STEP_UP

    print(f'{map_name}: obstacle height per column, in metres.')
    if deck is None:
        print('Give a deck height to see which columns it would be joined to.\n')
    else:
        print(f'"#" marks where a deck at {deck:.2f} m would be within a step '
              f'({reach:.2f} m) of the\nobstacle under it, and be joined down '
              f'to it.\n')

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
            if deck is not None and here > 0 and deck - here <= reach + 1e-6:
                row.append(f'{here:5.2f}#')
            elif here > 0:
                row.append(f'{here:6.2f}')
                clear += 1
            else:
                row.append('     .')
                clear += 1
        print(f'  {origin[0] + i * cell:6.1f}' + ''.join(row))
    if deck is not None:
        print(f'\n{clear} of {total} sampled columns are clear to build over.')


if __name__ == '__main__':
    if len(sys.argv) not in (6, 7):
        print(__doc__)
        raise SystemExit(2)
    main(sys.argv[1], *(float(v) for v in sys.argv[2:]))
