#!/usr/bin/env python3
"""Find every place the art lets a player through and the collision does not.

    python scripts/check-passable.py yard

`check-collision.py` asks whether the walls a player can see are solid. This
asks the opposite and more important question: whether the space a player can
see is open. A wall that is missing is a bug; a doorway that is closed is a
map they cannot play.

How it decides, and why this way:

* **Passable is decided by flood fill, not by looking at one cell.** Whether a
  cell is open is not a local question - the inside of a solid block has no
  surfaces in it and looks exactly like an empty room from the inside. What
  separates them is whether you can get there from outside, so that is what is
  measured, for the art and for the brushes alike.

* **The player is a box, not a point.** Free space is eroded by their width
  before the fill, so a gap narrower than their shoulders is not a way
  through, in either model.

* **The two models are built the same way** and differ only in what fills the
  space: triangles for one, brushes for the other. Anything the comparison
  shows is therefore a real difference between the art and the collision
  rather than an artefact of measuring them differently - which is the
  mistake that made an earlier audit report seven per cent when the truth was
  one.
"""
import importlib.util
import os
import re
import sys

import numpy as np
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_RS = os.path.join(ROOT, 'crates', 'solatel-protocol', 'src', 'sim', 'map.rs')

# The slice of the world a standing player's body occupies, measured from the
# floor. Ankles to just under the crown: geometry below is stepped over and
# geometry above is walked under.
BODY_LOW = 0.30
BODY_HIGH = 1.80


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


def where_a_player_fits(blocked, radius):
    """Erode the free space by the player's half-width.

    A square rather than a disc, because the player is a box and because a
    disc leaves the diagonals - and a diagonal is where a one-cell gap that
    nothing can pass through survives an erosion meant to remove it.
    """
    free = ~blocked
    kernel = np.ones((2 * radius + 1, 2 * radius + 1), dtype=bool)
    return ndimage.binary_erosion(free, structure=kernel, border_value=1)


def spawn_cells(name, origin, shape, cell):
    """Where the generated spawns are, in grid cells."""
    with open(MAP_RS, encoding='utf-8') as handle:
        source = handle.read()
    start = source.index(f'static {name.upper()}_SPAWNS: ')
    end = source.index('];', start)
    out = []
    for match in re.finditer(r'spawn\(([^)]*)\)', source[start:end]):
        parts = [p.strip() for p in match.group(1).split(',')]
        x, z = float(parts[0]), float(parts[2])
        ix = int((x - origin[0]) / cell)
        iz = int((z - origin[2]) / cell)
        if 0 <= ix < shape[0] and 0 <= iz < shape[1]:
            out.append((ix, iz))
    return out


def reachable_from(fits, seeds):
    """Everywhere connected to one of `seeds`.

    Both models are flooded from the same world positions, and the spawns are
    used because they are the one set of places the game itself guarantees a
    player can stand. Starting from "the edge of the grid" instead looks
    reasonable and is not: a map sealed by its own perimeter has no open
    edge, so the two models fall back to different regions - one picks the
    strip outside the wall and the other the whole map inside it, and the
    comparison then reports that every square metre disagrees.
    """
    labels, _ = ndimage.label(fits)
    found = set()
    for ix, iz in seeds:
        # The spawn may sit a cell inside a wall in one of the two models;
        # look in a small window rather than demanding an exact hit.
        window = labels[max(ix - 3, 0):ix + 4, max(iz - 3, 0):iz + 4]
        found.update(int(v) for v in np.unique(window) if v)
    if not found:
        counts = np.bincount(labels.ravel())
        counts[0] = 0
        found = {int(counts.argmax())}
    return np.isin(labels, list(found))


def column_blocked_by_art(derive, grid, low_row, high_row):
    blocked = np.zeros((grid.shape[0], grid.shape[2]), dtype=bool)
    for y in range(low_row, high_row):
        blocked |= grid[:, y, :]
    return blocked


def column_blocked_by_brushes(brushes, origin, shape, cell, floor=0.0):
    nx, nz = shape
    blocked = np.zeros((nx, nz), dtype=bool)
    owner = np.full((nx, nz), -1, dtype=np.int32)
    for index, (bx0, by0, bz0, bx1, by1, bz1) in enumerate(brushes):
        if by1 <= floor + BODY_LOW or by0 >= floor + BODY_HIGH:
            continue
        i0 = max(int(np.floor((bx0 - origin[0]) / cell)), 0)
        i1 = min(int(np.ceil((bx1 - origin[0]) / cell)), nx)
        j0 = max(int(np.floor((bz0 - origin[2]) / cell)), 0)
        j1 = min(int(np.ceil((bz1 - origin[2]) / cell)), nz)
        if i1 <= i0 or j1 <= j0:
            continue
        blocked[i0:i1, j0:j1] = True
        owner[i0:i1, j0:j1] = index
    return blocked, owner


def main(name, scale):
    derive = load_generator()
    derive.SCALE = scale
    cell = derive.CELL

    model = os.path.join(ROOT, 'assets', 'maps', f'{name}.glb')
    meshes = derive.mesh_nodes(model)
    props, _ = derive.classify(meshes)
    prop_names = [p[0] for p in props]

    # Everything, props included: what a player can see is the whole model.
    offset, verts, faces = 0, [], []
    for mesh_name, mesh_verts, mesh_faces in meshes:
        verts.append(mesh_verts)
        faces.append(mesh_faces + offset)
        offset += len(mesh_verts)
    grid, origin = derive.voxelise(np.vstack(verts), np.vstack(faces))
    nx, _, nz = grid.shape

    radius = int(np.ceil(derive.PLAYER_RADIUS / cell))
    low_row = max(int(BODY_LOW / cell), 1)
    high_row = min(int(BODY_HIGH / cell) + 1, grid.shape[1])

    seeds = spawn_cells(name, origin, (nx, nz), cell)

    art_blocked = column_blocked_by_art(derive, grid, low_row, high_row)
    art_fits = where_a_player_fits(art_blocked, radius)
    art_open = reachable_from(art_fits, seeds)

    brushes = brush_table(name)
    brush_blocked, owner = column_blocked_by_brushes(
        brushes, origin, (nx, nz), cell)
    brush_fits = where_a_player_fits(brush_blocked, radius)
    brush_open = reachable_from(brush_fits, seeds)

    area = cell * cell
    print(f'\n{name}: {int(art_open.sum()) * area:,.0f} m2 open in the art, '
          f'{int(brush_open.sum()) * area:,.0f} m2 open in the collision')

    shut = art_open & ~brush_open
    opened = brush_open & ~art_open
    print(f'  {int(shut.sum()) * area:,.0f} m2 a player should reach and cannot '
          f'({100.0 * shut.sum() / max(art_open.sum(), 1):.1f}% of the map)')
    print(f'  {int(opened.sum()) * area:,.0f} m2 the collision opens that the '
          f'art does not')

    if shut.any():
        labels, count = ndimage.label(shut)
        sizes = ndimage.sum_labels(shut, labels, range(1, count + 1))
        order = np.argsort(-sizes)
        print(f'\n  {count} separate places are shut off. The largest:')
        for rank in order[:12]:
            region = labels == (rank + 1)
            xs, zs = np.nonzero(region)
            # What is standing in the way: the brushes covering the cells just
            # inside the shut region's boundary.
            edge = region & ndimage.binary_dilation(brush_blocked)
            culprits = owner[edge & brush_blocked] if (edge & brush_blocked).any() else []
            if len(culprits) == 0:
                grown = ndimage.binary_dilation(region, iterations=radius + 1)
                culprits = owner[grown & brush_blocked]
            blame = ''
            if len(culprits):
                ids, counts = np.unique(culprits[culprits >= 0], return_counts=True)
                if len(ids):
                    top = ids[np.argmax(counts)]
                    kind = ('perimeter' if top < 5
                            else 'prop' if top >= len(brushes) - len(prop_names)
                            else 'structure')
                    blame = f'  blocked mostly by brush {top} ({kind})'
            print(f'    {sizes[rank] * area:8,.0f} m2 around '
                  f'({origin[0] + xs.mean() * cell:7.1f}, '
                  f'{origin[2] + zs.mean() * cell:7.1f}){blame}')

    return float(shut.sum() * area)



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
    which = sys.argv[1] if len(sys.argv) > 1 else 'yard'
    main(which, scale_of(which))
