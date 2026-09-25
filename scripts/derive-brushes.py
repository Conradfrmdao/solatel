#!/usr/bin/env python3
"""Derive the server's collision brushes from the arena art.

    python scripts/derive-brushes.py assets/maps/arena.glb --name arena --scale 4

Prints one map's brush and spawn tables for `solatel-protocol/src/sim/map.rs`.
Each map in the game is one run of this, and `scripts/build-maps.sh` runs them
all and assembles the file.

# Why this is generated

The rule this file exists to protect is in map.rs: the server collides and
traces shots against the map, so if the client draws something the server does
not believe in, players get shot through walls. When the arena was built out of
brushes and the client drew those brushes, that held by construction. Now the
client draws a model, and the two can drift apart - so the brushes are derived
from the same model rather than typed in beside it.

# Two kinds of geometry, handled differently

Most of the arena is props: crates, barrels, containers, pillars. Each is one
mesh that fills its own bounding box, so its collision *is* that box - exact,
one brush, nothing inflated and nothing lost.

The rest is structure: the perimeter walls, the building in the middle, the
staircases and ramps. None of those fill their bounding box - a staircase's box
is a solid three-metre wall, and the building's is a solid block - so they are
voxelised and turned into a height field instead.

`classify` decides which is which by measurement rather than by a list of names
that would rot: how much of its own box a mesh fills (crates score 1.00,
staircases 0.51), and whether the middle of that box is inside the mesh at all.
The second test is what separates a crate from an open container - both have a
lid, so both look full from above, but only one of them is something a player
can stand inside.

# Why it stopped being a height field everywhere

It was one, and three things were wrong with that. Voxels are quantised, so
every prop was up to a quarter of a metre bigger than it looked in each
direction, which made the arena feel cramped and hitboxes feel dishonest. A
height field holds one height per column, so a crate standing on a platform had
no collision at all - you fell through it. And a column of one-cell rectangles
at slightly different heights is a washboard that a player walking diagonally
catches on and gets deflected sideways by.

Exact boxes for props fix all three. The height field survives only where it is
actually needed, which is the handful of meshes that are not boxes.
"""
import heapq
import json
import struct
import sys
from collections import deque

import numpy as np

# Cell size of the voxel grid, in metres. Fine enough to keep doorways open,
# coarse enough that the table stays legible.
CELL = 0.25

# The map is authored small; this is what it is drawn and collided at.
#
# It went from 3.0 to 4.0 because the arena played cramped. Everything scales
# together, so crates go from 1.5 m to 2.0 m and are now taller than a player
# rather than chest high - more cover, and more of it worth using.
SCALE = 4.0

# How tall each slice of a prop is. A car is much the same shape from its
# sills to its roofline, so the height is worth far fewer slices than the
# footprint is worth cells: what a player walks into is the plan, not the
# elevation.
#
# It must stay under `MAX_STEP_UP`, and that is not a detail. A sliced prop
# is a stack of boxes, which is to say a staircase with a step this tall, and
# a step taller than a player can climb turns every sliced prop into a wall.
# At 0.6 it silently made all thirty-eight of the yard's sliced props
# unclimbable.
PROP_SLAB = 0.5

# And how finely each slice follows the shape sideways, to begin with. This
# is where the accuracy is, and also where the boxes are: a rectangle at
# forty degrees decomposes into one rectangle per row of cells it crosses.
PROP_CELL = 0.25

# Never more than this many slices, whatever the prop's height.
PROP_MAX_SLABS = 6

# A budget per prop. Over it, the prop is measured again at twice the cell
# size, and if it is still over, it keeps its bounding box: a hundred boxes
# for one car is not a good trade against a broadphase query, and something
# that irregular is usually scenery rather than cover.
PROP_MAX_BOXES = 60

# How much empty space a bounding box has to be holding before it is worth
# replacing with a stack.
#
# An absolute volume, not a fraction. A fraction sounds more principled and
# picks the wrong props: quantising a slice inflates it, so a small object
# always looks close to its own box however badly the box fits, while a car
# wasting thirty cubic metres of road can come in under the same percentage.
# What a player walks into is metres of empty air, so that is what this
# counts. The fraction stays as a floor so that very large props are not
# sliced for a saving that is trivial relative to them.
PROP_WASTED_SPACE = 0.8
PROP_WORTH_SLICING = 0.08

# Where climbing stops mattering. Below this a player can work their way up by
# stairs, crates and ramps, so the exact profile is gameplay; above it nothing
# is reachable on foot and only the silhouette matters. See `band`.
TALL_LIMIT = 2.75

# How far `harmonise` may move a cell to agree with its neighbours. Three
# bands: enough to pull a wall whose voxel height wanders by a step or two
# back into one run, and nowhere near enough to turn a staircase into a
# tower, which is what it did without a cap. See `harmonise`.
HARMONISE_REACH = 0.75

# How high to look for things that block a player. A little over the 1.8 m
# collision box, so that something a player can only just squeeze under is
# treated as blocking rather than as a doorway.
PLAYER_BAND = 2.0

# The tallest thing a walking player steps up without jumping, from
# `collide::MAX_STEP_UP`. What separates a staircase from a wall. Kept in
# step with that constant by hand; they are two halves of one number.
MAX_STEP_UP = 0.65

# Slicing a prop builds a staircase out of it, so its step has to be one a
# player can take. Stated rather than left to whoever edits the number: at
# 0.6 it silently turned all thirty-eight of the yard's sliced props into
# walls, and nothing about the output said so.
assert PROP_SLAB <= MAX_STEP_UP, (
    f'PROP_SLAB {PROP_SLAB} is taller than a player can step up '
    f'({MAX_STEP_UP}), which would make every sliced prop unclimbable'
)

# A mesh is its own collision box if it is no bigger than this and fills that
# box. Both tests matter; see `classify`.
PROP_MAX_VOLUME = 240.0
PROP_MIN_BOXINESS = 0.75

# Anything at all gets collision, down to a single cell.
#
# This started out as a filter - barrels and loose crates were left out to keep
# the table short, on the reasoning that walking through a barrel is a smaller
# problem than a barrel-shaped piece of invisible collision. That reasoning was
# wrong in practice: it left 27% of everything a player can see with nothing
# behind it, including the inner faces of the arena's own walls, which are one
# cell thick and were being dropped as too small to matter. Walking into a wall
# and sinking into it is the single worst thing a shooter can do.
#
# The cost is the table is five times longer. Nothing else about it changed.
MIN_OBSTACLE_AREA = 0.0

# The floor slab's thickness. Deep enough that nothing tunnels through it.
FLOOR_DEPTH = 1.5

# The stated perimeter. Taller than the art's own outer wall so nobody reaches
# the top of anything and hops out.
WALL_HEIGHT = 14.0
WALL_THICKNESS = 1.5

# Half a player, from `PLAYER_HALF_EXTENTS`, and their eye above their centre.
PLAYER_RADIUS = 0.35
EYE_OFFSET = 0.7

# A spawn's centre starts here, a little above the floor, and falls onto it.
SPAWN_HEIGHT = 1.2

# How far a spawn must see ahead of it. `spawns_face_open_ground` demands 9 m;
# this leaves margin so a small edit to the art does not break the test.
SPAWN_CLEARANCE = 10.0

# How far the sight test bothers to look.
#
# Generously past what is required, because this number is also how the eight
# directions are told apart. At fourteen metres most of them tie on open
# ground and the choice collapses to whichever the loop reached first.
SPAWN_SIGHT = 45.0

# Facing the middle of the map is the rule, and clear sight is the
# qualification for it.
#
# Weighing the two against each other does not work. Every direction on an
# open map has tens of metres of clear sight, so whichever happens to have
# the most wins - and "the most clear ground" is frequently a long empty run
# at a blank wall, which is what a player sees when they spawn. What they
# want to be looking at is where the other players are, which is the middle.
#
# So: of the directions with enough room to be worth facing at all, the one
# pointing most nearly inwards. Sight only separates directions that face
# equally inward, which is why it is divided down to a thousandth here - far
# smaller than the 0.29 that separates two of the eight compass points.
SIGHT_TIEBREAK = 0.001

# Above this a brush top is a roof rather than a floor, for the purpose of
# working out what is joined to what at ground level. Spawns are placed on
# the ground and settle onto it, so ground level is the only storey their
# connectivity has to be right about.
SPAWN_GROUND_CEILING = 2.5

# Keep spawns off the perimeter wall. Two metres was enough to stop a player
# standing inside it and not nearly enough to stop them staring at it: on the
# larger map the first thing you saw was the boundary filling the screen.
SPAWN_EDGE_MARGIN = 7.0

# How far around a spawn is examined for cover, and how much of that area has
# to have something in it.
#
# A map is not uniformly worth standing in. The yard is a built-up middle with
# wide empty margins, and a spawn out on the apron is technically valid - flat,
# clear, well away from the other spawns - and a bad place to start a life: no
# cover within a sprint, nothing to take, and a long walk to the game. Cover
# nearby is a cheap proxy for being where the map actually happens.
#
# The threshold is deliberately low. This is meant to exclude the car park, not
# to insist every spawn is in a doorway.
SPAWN_COVER_RADIUS = 14.0
SPAWN_COVER_SHARE = 0.04

# How many spawn points to place, and how many players a match on this map
# seats. Both are per map and both come in on the command line, because they
# are properties of the ground rather than of the game: the yard is 252 metres
# across and swallows thirty players, while thirty in the arena would be a
# scrum.
#
# There are deliberately more spawns than seats. A full match then still has
# spare points to be scattered across, so two matches running on the same map
# at the same time do not line everybody up identically - and one match does
# not use the same corner every time.
SPAWN_COUNT = 12
MAX_PLAYERS = 10

# How far up a player can get without help. `MAX_STEP_UP` is what they walk
# up; a jump from a standstill clears about this, and they step up out of the
# top of it. Anything higher is a wall as far as escaping is concerned.
JUMP_REACH = 1.10

# Pockets larger than this are left alone. Something this big that nobody can
# reach is far more likely to be a mistake in the model above than a pen, and
# filling a mistake this size would be worse than the trap.
TRAP_MAX_AREA = 240.0

# How far `outside_the_art` erodes before flooding, and dilates after, in
# cells. Two is enough to close the lattice the voxeliser leaves across a
# large ground plane - stripes one and two cells wide - and far less than
# the metres of width the real margin has. See `outside_the_art`.
MARGIN_OPENING = 2

# How far in from the void the outer apron of bare ground is made solid, in
# metres. This is the guardrail: it stops a player walking out past the
# edge of what is actually played on. Measured rather than flooded, so it
# can never take more than this band. See `edge_apron`.
EDGE_APRON = 6.0

# How many places are considered before a dozen are picked.
#
# Candidates are taken off a grid whose spacing widens until there are no more
# than this, because every one of them is traced against every brush on the
# map. One candidate per square metre is right for a thirty-metre arena and
# absurd for a two-hundred-and-fifty-metre one - and a dozen spawns spread by
# farthest-point sampling are not better placed for having been chosen from a
# hundred times as many. Small maps never reach this and are unaffected.
MAX_SPAWN_CANDIDATES = 2000


def stage(what, started=[None]):
    """Print how long the last stage took, and announce the next.

    This script runs for minutes on the larger map, and almost all of that is
    between two of the prints below. Without this there is no way to tell a slow
    stage from a wedged one.
    """
    import time
    now = time.time()
    if started[0] is not None:
        print(f" ({now - started[0]:.1f}s)", file=sys.stderr)
    started[0] = None if what is None else now
    if what is not None:
        print(f"  {what}...", end="", flush=True, file=sys.stderr)


# --- reading the model ----------------------------------------------------

COMPONENT = {5120: '<i1', 5121: '<u1', 5122: '<i2',
             5123: '<u2', 5125: '<u4', 5126: '<f4'}
COUNT = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    with open(path, 'rb') as handle:
        data = handle.read()
    offset, js, blob = 12, None, b''
    while offset < len(data):
        length, kind = struct.unpack_from('<II', data, offset)
        offset += 8
        if kind == 0x4E4F534A:
            js = json.loads(data[offset:offset + length].decode('utf-8'))
        elif kind == 0x004E4942:
            blob = data[offset:offset + length]
        offset += length
    return js, blob


def accessor(js, blob, index):
    spec = js['accessors'][index]
    view = js['bufferViews'][spec['bufferView']]
    dtype = COMPONENT[spec['componentType']]
    width = COUNT[spec['type']]
    size = np.dtype(dtype).itemsize
    start = view.get('byteOffset', 0) + spec.get('byteOffset', 0)
    stride = view.get('byteStride') or size * width
    if stride == size * width:
        flat = np.frombuffer(blob, dtype=dtype,
                             count=spec['count'] * width, offset=start)
        return flat.reshape(spec['count'], width).astype(np.float64)
    out = np.zeros((spec['count'], width))
    for i in range(spec['count']):
        out[i] = np.frombuffer(blob, dtype=dtype, count=width,
                               offset=start + i * stride)
    return out


def node_matrix(node):
    if 'matrix' in node:
        return np.array(node['matrix']).reshape(4, 4).T
    t = node.get('translation', [0, 0, 0])
    x, y, z, w = node.get('rotation', [0, 0, 0, 1])
    s = node.get('scale', [1, 1, 1])
    rotation = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])
    matrix = np.eye(4)
    matrix[:3, :3] = rotation * np.array(s)
    matrix[:3, 3] = t
    return matrix


def triangles(path):
    """Every triangle in the file, in world space, scaled to play size."""
    js, blob = read_glb(path)
    nodes = js['nodes']
    world = {}

    def walk(index, parent):
        world[index] = parent @ node_matrix(nodes[index])
        for child in nodes[index].get('children', []):
            walk(child, world[index])

    for root in js['scenes'][js.get('scene', 0)]['nodes']:
        walk(root, np.eye(4))

    verts, faces, base = [], [], 0
    for index, node in enumerate(nodes):
        if 'mesh' not in node:
            continue
        for prim in js['meshes'][node['mesh']]['primitives']:
            points = accessor(js, blob, prim['attributes']['POSITION'])
            homogeneous = np.hstack([points, np.ones((len(points), 1))])
            verts.append((world[index] @ homogeneous.T).T[:, :3] * SCALE)
            if 'indices' in prim:
                face = accessor(js, blob, prim['indices']).astype(int).reshape(-1, 3)
            else:
                face = np.arange(len(points)).reshape(-1, 3)
            faces.append(face + base)
            base += len(points)
    return np.vstack(verts), np.vstack(faces)


# --- voxelising -----------------------------------------------------------

def voxelise(verts, faces):
    """Mark every cell any surface passes through.

    Surfaces, not volumes: a wall is a shell and marking the shell is what a
    collision box wants anyway. The one thing that has to be right is that
    nothing is missed, so triangles are sampled at well under a cell's spacing.
    """
    # The model's ground plane sits at y = -1e-16 rather than 0 - Blender
    # exported a negative zero and the root rotation kept the sign. Flooring
    # that lands a cell below the grid and silently drops half the floor, so
    # coordinates within a hair of zero are snapped to it first.
    verts = np.where(np.abs(verts) < 1e-6, 0.0, verts)

    low, high = verts.min(0), verts.max(0)
    origin = np.array([low[0], 0.0, low[2]])
    shape = (
        int(np.ceil((high[0] - low[0]) / CELL)) + 2,
        int(np.ceil(max(high[1], 0.0) / CELL)) + 2,
        int(np.ceil((high[2] - low[2]) / CELL)) + 2,
    )
    grid = np.zeros(shape, dtype=bool)

    tri = verts[faces]
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    steps = np.clip(np.ceil(np.sqrt(area) / (CELL * 0.30)).astype(int), 1, 600)

    total = 0
    for step in np.unique(steps):
        picked = steps == step
        u, v = [], []
        for i in range(step + 1):
            for j in range(step + 1 - i):
                u.append(i / step)
                v.append(j / step)
        u = np.array(u)[None, :, None]
        v = np.array(v)[None, :, None]
        A, B, C = (x[picked][:, None, :] for x in (a, b, c))
        points = (A + (B - A) * u + (C - A) * v).reshape(-1, 3)
        total += len(points)
        # Biased floor, so a surface lying exactly on a cell boundary - which
        # every axis-aligned face in this model does - resolves the same way
        # every time instead of according to its last floating point bit.
        index = np.floor((points - origin) / CELL + 1e-6).astype(int)
        inside = np.ones(len(index), bool)
        for axis in range(3):
            inside &= (index[:, axis] >= 0) & (index[:, axis] < shape[axis])
        index = index[inside]
        grid[index[:, 0], index[:, 1], index[:, 2]] = True

    print(f"  voxelised {len(faces):,} triangles into {grid.sum():,} cells "
          f"of {CELL} m ({total:,} samples)", file=sys.stderr)
    return grid, origin


def obstacle_heights(grid):
    """How tall an obstacle stands in each column, or zero if none does.

    What counts as an obstacle is decided only from the band a player's body
    occupies, and the height is then read off the geometry as a whole. Both
    halves of that matter:

    * Deciding from the band is what keeps the building in the middle of the
      map enterable. Inside it there is floor underfoot and roof far overhead
      but nothing at chest height, so the column reads as open. Were the roof
      allowed to vote, the building would be a solid block.
    * Reading the height from the whole column is what stops every wall coming
      out the same height as a player. A wall that reaches the top of the band
      is not 2 m tall, it is however tall it is, and a shot has to be stopped by
      the whole of it.

    Surfaces are voxelised, not volumes, so a crate is a shell: the columns
    through its sides are solid all the way up and the column through its
    middle is solid only where its lid is. Taking the highest surface rather
    than a run of solid cells is what makes those agree - both give the height
    of the lid.
    """
    nx, ny, nz = grid.shape
    ground = 1  # row 0 is the ground plane itself.
    ceiling = min(int(np.ceil(PLAYER_BAND / CELL)), ny)

    # A surface is recorded at the bottom of the cell holding it, not the
    # top. `voxelise` resolves a sample sitting exactly on a boundary
    # upwards, and almost every horizontal face in these models sits exactly
    # on one, so the cell's bottom *is* the surface and its top is a quarter
    # of a metre of invention.
    band = np.zeros((nx, nz))
    for y in range(ground, ceiling):
        band[grid[:, y, :]] = y * CELL

    whole = np.zeros((nx, nz))
    for y in range(ground, ny):
        whole[grid[:, y, :]] = y * CELL

    # Anything that fills the band is taller than a player and takes its real
    # height; anything shorter is cover and takes the height it actually is.
    tall = band >= (ceiling - 1) * CELL - 1e-6
    return np.where(band <= 0.0, 0.0, np.where(tall, whole, band))


# --- reading the model, mesh by mesh ---------------------------------------

def mesh_nodes(path):
    """Every drawn mesh in the file, as its own triangles in world space."""
    js, blob = read_glb(path)
    nodes = js['nodes']
    world = {}

    def walk(index, parent):
        world[index] = parent @ node_matrix(nodes[index])
        for child in nodes[index].get('children', []):
            walk(child, world[index])

    for root in js['scenes'][js.get('scene', 0)]['nodes']:
        walk(root, np.eye(4))

    out = []
    for index, node in enumerate(nodes):
        if 'mesh' not in node:
            continue
        verts, faces, base = [], [], 0
        for prim in js['meshes'][node['mesh']]['primitives']:
            points = accessor(js, blob, prim['attributes']['POSITION'])
            homogeneous = np.hstack([points, np.ones((len(points), 1))])
            verts.append((world[index] @ homogeneous.T).T[:, :3] * SCALE)
            if 'indices' in prim:
                face = accessor(js, blob, prim['indices']).astype(int).reshape(-1, 3)
            else:
                face = np.arange(len(points)).reshape(-1, 3)
            faces.append(face + base)
            base += len(points)
        out.append((
            js['meshes'][node['mesh']].get('name', f'mesh{index}'),
            np.vstack(verts),
            np.vstack(faces),
        ))
    return out


def sample_triangles(verts, faces, spacing):
    """Points scattered over every triangle, no further apart than `spacing`."""
    tri = verts[faces]
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    steps = np.clip(np.ceil(np.sqrt(area) / spacing).astype(int), 1, 600)

    chunks = []
    for step in np.unique(steps):
        picked = steps == step
        u, v = [], []
        for i in range(step + 1):
            for j in range(step + 1 - i):
                u.append(i / step)
                v.append(j / step)
        u = np.array(u)[None, :, None]
        v = np.array(v)[None, :, None]
        A, B, C = (x[picked][:, None, :] for x in (a, b, c))
        chunks.append((A + (B - A) * u + (C - A) * v).reshape(-1, 3))
    return np.vstack(chunks)


def boxiness(verts, faces):
    """How much of its own bounding box a mesh fills, from 0 to 1.

    Measured as the mean height of the mesh's own top surface over its
    footprint, as a fraction of its box's height. A crate tops out at its lid
    everywhere and scores 1.0; a staircase ramps from floor to ceiling and
    scores about 0.5; a hollow room scores about the same, because half its
    footprint is the hole in the middle.

    That single number is what decides whether a mesh can be its own collision
    box, and it is measured rather than listed, so adding a crate to the model
    does not mean adding a name to a table here.
    """
    low, high = verts.min(0), verts.max(0)
    height = high[1] - low[1]
    if height < 1e-6:
        return 1.0

    nx = max(int(np.ceil((high[0] - low[0]) / CELL)), 1)
    nz = max(int(np.ceil((high[2] - low[2]) / CELL)), 1)
    if nx * nz > 400_000:
        return 0.0  # far too big to be a prop whatever its shape

    points = sample_triangles(verts, faces, CELL * 0.4)
    top = np.full((nx, nz), -np.inf)
    ix = np.clip(((points[:, 0] - low[0]) / CELL).astype(int), 0, nx - 1)
    iz = np.clip(((points[:, 2] - low[2]) / CELL).astype(int), 0, nz - 1)
    np.maximum.at(top, (ix, iz), points[:, 1])

    seen = np.isfinite(top)
    if not seen.any():
        return 1.0
    return float(((top[seen] - low[1]) / height).mean())


def is_solid(verts, faces, samples=9):
    """Is this mesh a closed solid, or a shell with space inside it?

    A crate you cannot walk into and a container you can walk into look almost
    identical from outside, and `boxiness` cannot tell them apart at all - both
    have a lid, so both fill their box as far as a top-down measurement can
    see. Treating the second as solid puts an invisible block where a player can
    plainly see a room.

    So this asks the only question that actually distinguishes them: is the
    middle of the box *inside* the mesh? Rays are cast outward from the centre
    and their crossings counted. An odd count means the ray started inside a
    closed surface; an even one means it started in open air and left through a
    hole. Several directions are tried and the majority wins, because low-poly
    props are frequently missing their underside, and a single ray downward out
    of an otherwise solid crate would say "hollow".
    """
    low, high = verts.min(0), verts.max(0)
    centre = (low + high) * 0.5
    tri = verts[faces]
    a = tri[:, 0]
    edge1 = tri[:, 1] - a
    edge2 = tri[:, 2] - a
    tvec = centre - a
    qvec = np.cross(tvec, edge1)

    inside = 0
    for index in range(samples):
        # A deterministic spread of directions - a spiral on the sphere - so
        # the answer never changes between runs.
        y = 1.0 - 2.0 * (index + 0.5) / samples
        r = np.sqrt(max(0.0, 1.0 - y * y))
        theta = np.pi * (1.0 + 5.0 ** 0.5) * index
        direction = np.array([np.cos(theta) * r, y, np.sin(theta) * r])

        # Moller-Trumbore, over every triangle at once.
        pvec = np.cross(direction, edge2)
        det = np.einsum('ij,ij->i', edge1, pvec)
        parallel = np.abs(det) < 1e-12
        safe = np.where(parallel, 1.0, det)
        u = np.einsum('ij,ij->i', tvec, pvec) / safe
        v = (qvec @ direction) / safe
        t = np.einsum('ij,ij->i', edge2, qvec) / safe
        hit = ~parallel & (u >= 0) & (u <= 1) & (v >= 0) & (u + v <= 1) & (t > 1e-6)
        if int(hit.sum()) % 2 == 1:
            inside += 1

    return inside * 2 > samples


def classify(meshes):
    """Splits the model into props that are their own box, and structure.

    All three tests have to pass. Size alone is not enough - a staircase is
    small and is not a box. Boxiness alone is not enough - the perimeter walls
    are one mesh whose columns all top out at the wall height, so they score 1.0
    and would become one box filling the arena. And neither notices the
    difference between a crate and an open container, which is what `is_solid`
    is for: anything a player can get inside goes down the structure path, where
    a height field leaves its interior open.
    """
    props, structure = [], []
    for name, verts, faces in meshes:
        low, high = verts.min(0), verts.max(0)
        volume = float(np.prod(np.maximum(high - low, 1e-6)))
        if (
            volume <= PROP_MAX_VOLUME
            and boxiness(verts, faces) >= PROP_MIN_BOXINESS
            and is_solid(verts, faces)
        ):
            props.append((name, verts, faces, low, high))
        else:
            structure.append((name, verts, faces))
    return props, structure


# --- shaping the structure into a height field -----------------------------

def surface_tops(grid):
    """Every height in each column where a solid run ends and air begins.

    These are the ledges a player could conceivably stand on. Most are never
    reachable - the top of a six metre wall is a surface too - which is what
    `climb` is for.
    """
    nx, ny, nz = grid.shape
    tops = [[[] for _ in range(nz)] for _ in range(nx)]
    for y in range(1, ny):
        above = grid[:, y + 1, :] if y + 1 < ny else np.zeros((nx, nz), bool)
        ends = grid[:, y, :] & ~above
        for x, z in zip(*np.nonzero(ends)):
            tops[x][z].append(y * CELL)
    return tops


def climb(height, grid):
    """Extends the height field onto ledges a player could step up onto.

    The seed rule only notices geometry that is in the way of a standing body,
    which is right for walls and crates and wrong for the top half of every
    staircase: a tread at 2.25 m has nothing at chest height, so it reads as
    open floor and the staircase stops halfway up with a two metre drop.

    Raising the seed rule's ceiling instead would be worse. Measured on the
    arena it turns 4,710 columns solid that a player currently walks *under* -
    every roof and catwalk at head height becomes a wall from the floor up.

    So the field is grown instead of widened, by flooding out from the floor one
    step at a time. A ledge joins only when a neighbour a player can already
    stand on is within `MAX_STEP_UP` of it, which is exactly what a staircase is
    and exactly what the top of a wall is not. Nothing unreachable can pull
    itself up by its own bootstraps: the wall beside a doorway is a six metre
    surface too, and it stays out because nobody can get to it.
    
    Hands back which columns ended up reachable as well as the field itself.
    That set is the map's floors - everywhere a player can put their feet - and
    it is what `upper_obstacles` measures a wall on a roof against.
    """
    nx, nz = height.shape
    tops = surface_tops(grid)

    reachable = height <= MAX_STEP_UP + 1e-6
    # Lowest surface first, rather than in the order cells happen to be
    # found. This is the difference between a flood and a correct answer,
    # and it is not a refinement - a plain queue gets the map wrong.
    #
    # The loop writes into `height` as it goes: a column joined by way of a
    # ledge is recorded as standing at that ledge. With a queue, whichever
    # neighbour reaches a column first decides that, and a neighbour up on a
    # roof can claim a column at a ledge four metres up before the flood
    # coming along the floor arrives - at which point the floor's step to it
    # is too big and the climb stops dead. Adding a bridge in one corner of
    # the arena did exactly that to a staircase three metres away: 529
    # columns *lost* reachability because new geometry appeared nearby, the
    # staircase was reclassified as wall, and the rooftops it served were
    # cut off. Geometry that is added should never subtract.
    #
    # Settling columns in increasing order of height fixes that outright. A
    # column is popped only once its lowest reachable surface is known, so
    # the answer no longer depends on visit order, and a surface added above
    # can never displace a lower one that was already there.
    heap = [(float(height[x, z]), int(x), int(z))
            for x, z in zip(*np.nonzero(reachable))]
    heapq.heapify(heap)
    settled = np.zeros((nx, nz), dtype=bool)

    while heap:
        standing, x, z = heapq.heappop(heap)
        if settled[x, z]:
            continue
        settled[x, z] = True
        height[x, z] = standing
        for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx_, nz_ = x + dx, z + dz
            if not (0 <= nx_ < nx and 0 <= nz_ < nz):
                continue
            if settled[nx_, nz_]:
                continue

            if abs(height[nx_, nz_] - standing) <= MAX_STEP_UP + 1e-6:
                reachable[nx_, nz_] = True
                heapq.heappush(heap, (float(height[nx_, nz_]), nx_, nz_))
                continue

            # Too big a step as it stands - but there may be a ledge in that
            # column, above whatever the seed rule found, that is within reach.
            candidates = [
                top
                for top in tops[nx_][nz_]
                if top > height[nx_, nz_] and abs(top - standing) <= MAX_STEP_UP + 1e-6
            ]
            if candidates:
                reachable[nx_, nz_] = True
                heapq.heappush(heap, (float(min(candidates)), nx_, nz_))

    return height, reachable


def window_counts(mask, radius):
    """How many true cells lie within `radius` of each cell. O(cells).

    A summed-area table, because the obvious nested loop over a window is
    O(cells x window) and the larger map has half a million of them.
    """
    nx, nz = mask.shape
    padded = np.zeros((nx + 1, nz + 1), dtype=np.int32)
    padded[1:, 1:] = np.cumsum(np.cumsum(mask.astype(np.int32), axis=0), axis=1)

    xs = np.arange(nx)
    zs = np.arange(nz)
    x0 = np.clip(xs - radius, 0, nx)[:, None]
    x1 = np.clip(xs + radius + 1, 0, nx)[:, None]
    z0 = np.clip(zs - radius, 0, nz)[None, :]
    z1 = np.clip(zs + radius + 1, 0, nz)[None, :]
    return padded[x1, z1] - padded[x0, z1] - padded[x1, z0] + padded[x0, z0]


def harmonise(levels, solid, radius=2):
    """Give every solid cell the level most common among its solid neighbours.

    Without this the arena has no walls. A wall is one cell thick and fifty
    metres long, and the voxel height along it wanders by a step here and there
    - so banding alone scatters it across three or four levels, each of which
    decomposes into dozens of fragments. Agreeing on a level with its neighbours
    turns it back into one run.

    Only solid cells vote and only solid cells are written, which is what makes
    this safe to run on geometry one cell wide. A plain majority filter would
    see six empty neighbours around every wall cell and erase the wall.

    A cell may only be moved `HARMONISE_REACH`, and that cap is load-bearing.
    Agreement is for a wall whose height wanders by a step along its length.
    It is not for making a cell agree with something metres away, and the
    window is wide enough to contain the nine metre perimeter wall: the
    arena's north-west staircase was voted from 2.75 m to 9.00 m - not
    fragmented, not nudged, replaced by a tower, with the rooftops it served
    stranded behind it. Which cells are offered here at all is decided from
    `climb`, and `climb` is a flood whose result moves a little whenever
    geometry is added anywhere near it, so that cliff was reachable by
    accident. Capping the distance means the worst a misclassified tread can
    suffer is a step, instead of eight metres.
    """
    # The levels actually present, rather than a fixed ladder. There are a few
    # dozen on a large map and each one costs a pair of prefix sums, which is
    # cheap enough not to think about.
    present = np.unique(levels[solid])
    best = np.zeros_like(levels)
    best_votes = np.full(levels.shape, -1, dtype=np.int32)
    for value in present:
        votes = window_counts(solid & (levels == value), radius)
        better = votes > best_votes
        best = np.where(better, value, best)
        best_votes = np.where(better, votes, best_votes)
    return np.where(solid & (np.abs(best - levels) <= HARMONISE_REACH),
                    best, levels)


def band(height):
    """Quantise obstacle heights to the grid's own resolution.

    A quarter of a metre everywhere, because everywhere is climbable by
    somebody. The difference between a staircase and a wall is entirely in
    whether each tread is under the 0.55 m a walking player steps up, and the
    top of a shipping container is a floor to whoever got onto it.

    This used to snap anything above `TALL_LIMIT` to one of three heights -
    3, 6 or 12 metres - on the grounds that tall geometry is not climbable so
    precision bought nothing. Both halves of that were wrong. Plenty of tall
    geometry is standable, by stairs or by stacking; and the three heights were
    the arena's, so on a map built at other heights two thirds of the surfaces
    a player could stand on ended up somewhere other than where they are drawn,
    floating a metre or two above the roof or buried inside it.

    What the ladder was really for - stopping a fifty-metre wall fragmenting
    across three levels because its voxel height wanders by a step - is
    `harmonise`'s job, and it does it by agreement between neighbours rather
    than by a table fixed in advance.
    """
    return np.round(height / CELL) * CELL


def fill_silhouette(mask):
    """Close the inside of a slice.

    Triangles are sampled, so a slice through a solid object marks only where
    its surface crosses that height - the sides of a crate, not its middle.
    Left like that, a shot through the centre of a crate would pass through
    it. Each row is filled between its first and last marked cell and then
    each column of the result likewise, which is exact for the convex shapes
    almost every prop is, and errs towards solid for the rest.
    """
    between = lambda m, axis: (
        np.maximum.accumulate(m, axis=axis)
        & np.flip(np.maximum.accumulate(np.flip(m, axis=axis), axis=axis), axis=axis)
    )
    return between(between(mask, 1), 0)


def prop_boxes(verts, faces, low, high):
    """A prop as a stack of boxes that follows its shape, or one if that is it.

    Tried at increasing coarseness until it fits the budget, because the cost
    of following a shape is entirely in how finely it is followed, and a
    rough outline of a car is far closer to the truth than the box around it.
    """
    span = np.maximum(high - low, 1e-6)
    whole = [(low[0], low[1], low[2], high[0], high[1], high[2])]
    if span[1] < PROP_SLAB * 1.5:
        return whole  # too short to have a top and a bottom worth telling apart

    for coarseness in (1, 2, 4):
        boxes = _prop_slices(verts, faces, low, high, span, PROP_CELL * coarseness)
        if boxes is None:
            return whole
        if len(boxes) <= PROP_MAX_BOXES:
            return boxes
    return whole


def _prop_slices(verts, faces, low, high, span, cell):
    """One attempt at slicing, at a given horizontal resolution.

    Returns None when the stack is no smaller than the box around it, which
    is the case for a crate and means the box is both exact and cheaper.
    """
    slabs = int(min(max(round(span[1] / PROP_SLAB), 2), PROP_MAX_SLABS))
    nx = int(min(max(np.ceil(span[0] / cell), 1), 400))
    nz = int(min(max(np.ceil(span[2] / cell), 1), 400))
    step_x, step_z = span[0] / nx, span[2] / nz

    points = sample_triangles(verts, faces, min(step_x, step_z) * 0.5)
    ix = np.clip(((points[:, 0] - low[0]) / step_x).astype(int), 0, nx - 1)
    iz = np.clip(((points[:, 2] - low[2]) / step_z).astype(int), 0, nz - 1)
    layer = np.clip(((points[:, 1] - low[1]) / (span[1] / slabs)).astype(int),
                    0, slabs - 1)

    boxes, filled = [], 0.0
    for slab in range(slabs):
        here = layer == slab
        if not here.any():
            continue
        mask = np.zeros((nx, nz), dtype=bool)
        mask[ix[here], iz[here]] = True
        mask = fill_silhouette(mask)

        y0 = low[1] + span[1] * slab / slabs
        y1 = low[1] + span[1] * (slab + 1) / slabs
        for x0, x1, z0, z1 in rectangles(mask):
            boxes.append((
                low[0] + x0 * step_x, y0, low[2] + z0 * step_z,
                low[0] + x1 * step_x, y1, low[2] + z1 * step_z,
            ))
            filled += (x1 - x0) * step_x * (z1 - z0) * step_z * (y1 - y0)

    if not boxes:
        return None
    # Only worth the extra boxes if the shape is genuinely smaller than the
    # box around it.
    volume = float(span[0] * span[1] * span[2])
    wasted = volume - filled
    if wasted < max(PROP_WASTED_SPACE, volume * PROP_WORTH_SLICING):
        return None
    return boxes


def surface_runs(grid):
    """Every contiguous vertical run of solid cells, as (bottom, top) rows.

    Returns `(starts, end_row)`: where each run begins, and for every solid
    cell the row its run ends at. Together those give every run in the model
    without a Python loop over the half million columns.

    This is what the geometry actually is, as opposed to the height field,
    which is what the geometry would be if everything rested on the ground.
    """
    ny = grid.shape[1]
    above = np.empty_like(grid)
    above[:, :-1, :] = grid[:, 1:, :]
    above[:, -1, :] = False
    below = np.empty_like(grid)
    below[:, 1:, :] = grid[:, :-1, :]
    below[:, 0, :] = False

    starts = grid & ~below
    ends = grid & ~above

    # Sweep downwards carrying "the row this run ends at". Cheap, and the
    # alternative - marching up from each start - is quadratic in the height
    # of the map.
    end_row = np.full(grid.shape, -1, dtype=np.int16)
    carried = np.full((grid.shape[0], grid.shape[2]), -1, dtype=np.int16)
    for y in range(ny - 1, -1, -1):
        carried = np.where(grid[:, y, :],
                           np.where(ends[:, y, :], np.int16(y), carried),
                           np.int16(-1))
        end_row[:, y, :] = carried
    return starts, end_row


def standing_runs(grid, ground_height):
    """Runs that sit above whatever the ground pass already made solid.

    A roof, a gantry, a stair tread, the wall of an upstairs room: anything
    whose feet are not on the floor. Each one is emitted where it is instead
    of being dragged down to the ground, which is the whole point - a room
    under a roof keeps its air.

    Each run does reach down to whatever is under it when the gap is no more
    than a player could step up. Under a stair tread that is the tread below,
    and the flight comes out solid; without it a tread is a slab with a hole
    behind it and walking up a staircase is a series of small falls. Under a
    gantry there is nothing within a step, so the space below stays open.

    Returns `(bottom, top, mask)` groups ready to be covered with rectangles.
    """
    nx, ny, nz = grid.shape
    starts, end_row = surface_runs(grid)

    # The highest solid row strictly below each row, carried up as we go so
    # that the whole array never has to exist at once.
    below = np.full((nx, nz), -1, dtype=np.int16)
    reach = int(round(MAX_STEP_UP / CELL))

    groups = []
    for low in range(1, ny):
        beginning = starts[:, low, :]
        here_solid = grid[:, low, :]

        if beginning.any():
            # Only what the ground pass has not already covered. A wall
            # standing on the floor is one run from the floor up and belongs
            # to that pass.
            beginning = beginning & (low * CELL > ground_height + 1e-6)

        if beginning.any():
            # Where the run's feet end up: down to whatever is within a step
            # below it, or its own bottom if there is nothing that close.
            gap = low - below - 1
            foot = np.where((gap <= reach) & (below >= 0), below + 1, low)
            # Nothing at all below and low enough to be a kerb: take it to
            # the ground, so a doorstep is a step rather than a ledge.
            foot = np.where((below < 0) & (low <= reach), 0, foot)

            finishes = np.where(beginning, end_row[:, low, :], np.int16(-1))
            for high in np.unique(finishes[beginning]):
                at_top = beginning & (finishes == high)
                for start_row in np.unique(foot[at_top]):
                    mask = at_top & (foot == start_row)
                    if not mask.any():
                        continue
                    # Bottom and top are both the surfaces themselves. A run
                    # one cell deep would then have no thickness at all, so
                    # it is given a cell of it downwards - a tread has to be
                    # something to stand on, not a plane.
                    bottom = float(int(start_row) * CELL)
                    top = float(int(high) * CELL)
                    if top - bottom < CELL:
                        bottom = max(top - CELL, 0.0)
                    if top <= bottom:
                        continue
                    groups.append((bottom, top, mask))

        below = np.where(here_solid, np.int16(low), below)
    return groups


# --- turning columns into boxes -------------------------------------------

def rectangles(mask):
    """Covers a mask with disjoint rectangles, greedily.

    Walks the grid once. At each unclaimed cell it runs as far as it can along
    z, then grows that run along x for as long as whole rows match, claims the
    block and moves on. This is the "greedy meshing" every voxel renderer uses,
    and it is O(cells).

    It replaced a version that repeatedly searched for the single largest
    rectangle remaining. That produces slightly fewer, tidier boxes and is
    O(cells) *per box*, which is fine on a thirty-metre arena and does not
    terminate in useful time on a two-hundred-and-fifty-metre one: a few
    thousand rectangles over half a million cells is billions of operations.
    Slightly more boxes costs nothing now that the map is spatially indexed.
    """
    nx, nz = mask.shape
    remaining = mask.copy()
    found = []

    for x in range(nx):
        row = remaining[x]
        z = 0
        while z < nz:
            if not row[z]:
                z += 1
                continue

            # How far this run reaches along z.
            end = z + 1
            while end < nz and row[end]:
                end += 1

            # How many whole rows below match it exactly.
            height = 1
            while x + height < nx and remaining[x + height, z:end].all():
                height += 1

            remaining[x:x + height, z:end] = False
            found.append((x, x + height, z, end))
            z = end

    return found


def box(origin, low, high, x0, x1, z0, z1, bottom, top):
    """One brush from a rectangle of cells, clipped to the model's footprint.

    The grid carries a couple of cells of slack past the model so nothing falls
    off its edge. Brushes must not: past the footprint is where the perimeter
    wall lives, and a brush that reaches into it is an interpenetrating pair.
    Returns None for anything that clipping has made too thin to matter.
    """
    a = (max(origin[0] + x0 * CELL, low[0]), float(bottom),
         max(origin[2] + z0 * CELL, low[2]))
    b = (min(origin[0] + x1 * CELL, high[0]), float(top),
         min(origin[2] + z1 * CELL, high[2]))
    if b[0] - a[0] < CELL or b[2] - a[2] < CELL:
        return None
    return a + b


def build_brushes(grid, origin, low, high):
    stage("measuring obstacle heights")
    # Deliberately *not* `climb`ed. `climb` answers "how high is the surface a
    # player stands on here", which for a column under a roof is the roof -
    # and spending that as "how high is the obstacle here" fills the room
    # below it solid from the floor up. Everything above the ground is a run
    # of real geometry instead; see `standing_runs`.
    height = obstacle_heights(grid)
    stage("banding")
    solid = height > 0.0
    levels = np.where(solid, band(height), 0.0)
    # Smoothing is for walls and only for walls. It exists to stop a fifty
    # metre run of wall fragmenting into dozens of boxes because its voxel
    # height wanders by a step, and it does that by making each cell agree
    # with its neighbours - which is exactly the wrong thing to do to a
    # surface somebody is standing on. A roof beside a tower gets voted up to
    # the tower and the player ends up in mid-air above it; a roof beside a
    # stairwell gets voted down and they end up buried in it. Measured on the
    # yard that was one standable surface in thirteen, out by up to ten metres.
    #
    # So: tall, and not anywhere a player can put their feet. Running it over
    # the stairs would be worse still - it would average each tread with the
    # two above and below and hand back a ramp-shaped wall.
    # Which of the solid columns are walls rather than floors, for smoothing.
    # A column whose obstacle reaches most of the way up it is a wall; one
    # that a player could stand on top of is not, and must not be moved.
    _, reachable = climb(height.copy(), grid)
    walls = solid & (height >= TALL_LIMIT) & ~reachable
    levels = np.where(walls, harmonise(levels, walls), levels)

    stage("covering each level with rectangles")
    brushes = []
    for level in sorted(set(levels[solid].flatten())):
        for x0, x1, z0, z1 in rectangles(levels == level):
            if (x1 - x0) * (z1 - z0) * CELL * CELL < MIN_OBSTACLE_AREA:
                continue
            made = box(origin, low, high, x0, x1, z0, z1, 0.0, level)
            if made:
                brushes.append(made)
    ground = len(brushes)

    # Everything that does not rest on the ground: roofs, gantries, the treads
    # of a staircase above the first, the walls of an upstairs room. Emitted
    # at the height it is, so that what is underneath stays air.
    stage("finding geometry above the ground")
    for bottom, top, mask in standing_runs(grid, height):
        for x0, x1, z0, z1 in rectangles(mask):
            if (x1 - x0) * (z1 - z0) * CELL * CELL < MIN_OBSTACLE_AREA:
                continue
            made = box(origin, low, high, x0, x1, z0, z1, bottom, top)
            if made:
                brushes.append(made)
    print(f"  {ground:,} resting on the ground, {len(brushes) - ground:,} above it",
          file=sys.stderr)

    stage(None)
    return brushes


def art_masks(grid, props, origin, shape):
    """Which columns the art occupies at all, and which above the ground."""
    covered = grid.any(axis=1)
    above = grid[:, 1:, :].any(axis=1)
    for bx0, _by0, bz0, bx1, _by1, bz1 in props:
        i0 = max(int(np.floor((bx0 - origin[0]) / CELL)), 0)
        i1 = min(int(np.ceil((bx1 - origin[0]) / CELL)), shape[0])
        j0 = max(int(np.floor((bz0 - origin[2]) / CELL)), 0)
        j1 = min(int(np.ceil((bz1 - origin[2]) / CELL)), shape[1])
        covered[i0:i1, j0:j1] = True
        above[i0:i1, j0:j1] = True
    return covered, above


def edge_apron(grid, props, origin, shape, margin):
    """The last few metres of bare ground before the void, made solid.

    Sealing the void stops a player standing on nothing. It does not stop
    them walking out to the edge of it and being knocked over, and on the
    yard the buildings stop several metres short of where the ground does
    - so there is an apron of drawn, empty ground round the outside of the
    map with open water past it and nothing on it. A player who falls off
    a roof onto that apron is behind the map for the rest of the round.

    Conrad asked for guardrails, visible if possible and invisible if not.
    This is the invisible half, and it is in the collision rather than in
    the art because the yard's art is not ours to add to. The outer band of
    the apron goes solid, so a player is stopped at the edge of the ground
    that is actually played on rather than wandering past it.

    Distance-limited, not flooded, and that is the whole safety of it. A
    flood through open ground finds the first gateway and swallows the map
    - measured at 70% of the yard. A band measured out from the void
    cannot do that: the worst it can reach is `EDGE_APRON` metres, it only
    ever takes ground with nothing standing on it, and on a map with no
    void at all - the arena - it does nothing whatsoever.
    """
    from scipy import ndimage

    if not margin.any():
        return np.zeros(shape, dtype=bool)
    covered, above = art_masks(grid, props, origin, shape)
    bare = covered & ~above
    reach = ndimage.distance_transform_edt(~margin) * CELL
    return bare & (reach <= EDGE_APRON)


def outside_the_art(grid, props, origin, shape):
    """Columns inside the bounding box that the art never reaches at all.

    The perimeter is a box around the model's bounding box. The art inside
    it is not a box, and what is left between the two is a margin of bare
    slab running round the edge of the map - 3,273 m2 of it on the yard -
    with nothing drawn on it, nothing in it, and open water past its edge.
    A player out there is standing on a surface that exists only because
    the floor was stated as a rectangle.

    Getting there does not even need a jump. The yard's own boundary wall
    drops to 6.75 m around z 37 and there is a ten metre roof nine metres
    inside it: walk off the roof, clear the wall on the way down, and you
    are out of the map.

    Both halves of the model have to be counted and each alone is wrong in
    an opposite way. The voxel grid alone misses the props - 723 of the
    yard's meshes are props, platforms among them - so every column
    standing on one reads as empty, and judging on the grid alone walled
    off 12,000 m2 that players walk around on. The finished brushes alone
    miss the floor, because the art's ground plane is row 0 of the grid and
    deliberately produces no brush, so judged on brushes the whole open
    yard reads as outside its own map.

    The test is "nothing whatsoever in this column", not "nothing to stand
    on". The looser version reads every flat stretch of open ground as
    outside, leaks through the first gateway it finds, and claims 70% of
    the yard and 56% of the arena. Measured, not guessed.

    **The grid is porous and the flood has to be opened against it.** A
    ground plane is one enormous pair of triangles, and `sample_triangles`
    caps a triangle at 600 steps a side however big it is - which over the
    yard's 252 m is a sample every 0.42 m against cells of 0.25 m. So the
    open ground voxelises as a lattice: whole stripes of cells that the
    floor passes over and nothing marks. 204 of 576 cells in one patch of
    plain yard. Flooding through those carried this straight into the
    middle of the map and left a comb of invisible fourteen-metre walls
    across open ground, which is exactly as bad as it sounds - and it
    inflated the margin from its true 1,081 m2 to 3,279.

    Eroding before the flood and dilating after is what fixes it: a lattice
    hole one or two cells wide has no interior to flood through, while the
    margin is metres across and survives untouched. The dilation is masked
    back to `covered` so it can never grow onto the art itself.
    """
    from scipy import ndimage

    covered, _above = art_masks(grid, props, origin, shape)
    core = ~grow_square(covered, MARGIN_OPENING)
    label, count = ndimage.label(core)
    if count == 0:
        return np.zeros(shape, dtype=bool)
    rim = set(label[0, :]) | set(label[-1, :])
    rim |= set(label[:, 0]) | set(label[:, -1])
    rim.discard(0)
    if not rim:
        return np.zeros(shape, dtype=bool)
    return grow_square(np.isin(label, sorted(rim)), MARGIN_OPENING) & ~covered


def perimeter(low, high):
    """The floor slab and the four walls that close the arena.

    These are stated rather than derived, and they are the one part of the
    table that is allowed to exist where the art does not. The art's own outer
    wall is a shell one cell thick with a gap wherever the voxel grid clipped a
    corner, and a gap in a perimeter is a player outside the map falling
    forever. Sitting entirely outside the floor, they cannot overlap anything
    derived, and no player can reach the side of them that has no art.
    """
    x0, z0, x1, z1 = low[0], low[2], high[0], high[2]
    t, h = WALL_THICKNESS, WALL_HEIGHT
    return [
        # The floor, and enough rock under it that nothing tunnels through.
        (x0 - t, -FLOOR_DEPTH, z0 - t, x1 + t, 0.0, z1 + t),
        # North and south run the full width; east and west stop at the floor's
        # edge, so the corners meet without one solid entering another.
        (x0 - t, 0.0, z0 - t, x1 + t, h, z0),
        (x0 - t, 0.0, z1, x1 + t, h, z1 + t),
        (x0 - t, 0.0, z0, x0, h, z1),
        (x1, 0.0, z0, x1 + t, h, z1),
    ]


def spread(mask, reach):
    """`mask` grown by `reach` cells in each direction."""
    out = mask.copy()
    for shift in range(1, reach + 1):
        for axis in (0, 1):
            out |= np.roll(mask, shift, axis=axis)
            out |= np.roll(mask, -shift, axis=axis)
    return out


def grow_square(mask, reach):
    """`mask` grown by `reach` cells in every direction, corners included.

    Separable: along one axis, then along the other. `spread` grows in a
    cross, which leaves the diagonals untouched - and a diagonal is exactly
    where a one-cell link between two areas that do not really join survives
    an erosion meant to remove it.
    """
    out = mask.copy()
    for axis in (0, 1):
        grown = out.copy()
        for shift in range(1, reach + 1):
            grown |= np.roll(out, shift, axis=axis)
            grown |= np.roll(out, -shift, axis=axis)
        out = grown
    return out


def walkable_regions(standable_here, standing):
    """Label the connected pieces of walkable floor, largest first.

    Two cells are connected when a player could walk between them: both have
    room to stand, they are side by side, and the step between them is one a
    walking player takes. That last condition is what makes this a map of
    where a player can *get* rather than of where they would fit if dropped
    there by helicopter.

    Diagonals are deliberately not connected. Squeezing through the corner
    where two obstacles touch is not something the collision resolver will
    actually let a player do, and counting it joins regions that are not
    joined.

    Asked of where a player can *stand*, never of where a spawn may go. The
    spawn mask grows every obstacle by the player's width, which turns each
    stair tread into a wall and cuts the upstairs off from the downstairs:
    labelled on that, half the arena came out as unreachable from the other
    half, which is true of nobody.
    """
    nx, nz = standable_here.shape
    label = np.zeros((nx, nz), dtype=np.int32)
    sizes = [0]

    for start_x, start_z in zip(*np.nonzero(standable_here)):
        if label[start_x, start_z]:
            continue
        current = len(sizes)
        label[start_x, start_z] = current
        queue = deque([(int(start_x), int(start_z))])
        count = 0
        while queue:
            x, z = queue.popleft()
            count += 1
            here = standing[x, z]
            for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ax, az = x + dx, z + dz
                if not (0 <= ax < nx and 0 <= az < nz):
                    continue
                if label[ax, az] or not standable_here[ax, az]:
                    continue
                if abs(standing[ax, az] - here) > MAX_STEP_UP + 1e-6:
                    continue
                label[ax, az] = current
                queue.append((ax, az))
        sizes.append(count)

    return label, sizes


def standable(brushes, low, high, origin, shape):
    """Cells a player could stand in, and the geometry they would stand among.

    Returns `(free, blocked)`: where a player fits, and where the map's
    obstacles are. The second is not the complement of the first - obstacles
    are grown by the player's width and the map's margin before the free mask
    is taken - and it is wanted separately because how much geometry is nearby
    is what tells a good spawn from an empty corner.
    """
    nx, nz = shape
    blocked = np.zeros((nx, nz), bool)
    for bx0, _, bz0, bx1, by1, bz1 in brushes:
        if by1 <= 0.0:
            continue  # the floor slab
        i0 = max(int(np.floor((bx0 - origin[0]) / CELL)), 0)
        i1 = min(int(np.ceil((bx1 - origin[0]) / CELL)), nx)
        j0 = max(int(np.floor((bz0 - origin[2]) / CELL)), 0)
        j1 = min(int(np.ceil((bz1 - origin[2]) / CELL)), nz)
        blocked[i0:i1, j0:j1] = True

    # Grow every obstacle by half a player, plus a cell of slack, so a spawn is
    # never chosen with its shoulder inside a crate.
    pad = int(np.ceil(PLAYER_RADIUS / CELL)) + 1
    grown = blocked.copy()
    for dx in range(-pad, pad + 1):
        for dz in range(-pad, pad + 1):
            grown |= np.roll(np.roll(blocked, dx, axis=0), dz, axis=1)

    free = ~grown
    edge = int(np.ceil(SPAWN_EDGE_MARGIN / CELL))
    free[:edge, :] = free[-edge:, :] = False
    free[:, :edge] = free[:, -edge:] = False
    # `blocked` goes back too, ungrown: it is the map's geometry, which is what
    # says whether a place has anything in it worth spawning next to.
    return free, blocked


def clearance(point, yaws, lows, highs, limit=14.0):
    """How far a spawn can see along each of `yaws` before geometry stops it.

    An exact ray-box intersection, not a march along the ray. Sampling every
    quarter metre and asking "am I inside anything" looks equivalent and is not:
    a diagonal ray can enter and leave a thin brush between two samples and be
    reported as clear. That is not hypothetical - it put a spawn facing a wall
    three metres away while this function claimed fourteen, and the engine's own
    trace, which does the real thing, failed the map.

    Every ray is tested against every brush in one pass. The arena has a
    thousand brushes and the yard several thousand, and this is called for every
    square metre of open floor on the map, so a Python loop over brushes here is
    the difference between a minute and an afternoon.
    """
    yaws = np.atleast_1d(np.asarray(yaws, dtype=float))
    rays = np.stack([-np.sin(yaws), np.zeros_like(yaws), -np.cos(yaws)], axis=1)
    eye = np.asarray(point, dtype=float) + np.array([0.0, EYE_OFFSET, 0.0])

    # Distances at which the ray crosses each pair of faces. `safe` only keeps
    # the division finite; the parallel axes are overwritten immediately below.
    parallel = np.abs(rays) < 1e-9
    safe = np.where(parallel, 1.0, rays)[:, None, :]
    first = (lows[None, :, :] - eye) / safe
    second = (highs[None, :, :] - eye) / safe
    near = np.minimum(first, second)
    far = np.maximum(first, second)

    # An axis the ray is parallel to cannot bound it. Either the eye is already
    # between that pair of faces, in which case the axis says nothing, or it is
    # not and the brush cannot be hit at all.
    between = (lows[None, :, :] <= eye) & (eye <= highs[None, :, :])
    axis_parallel = parallel[:, None, :]
    near = np.where(axis_parallel, -np.inf, near)
    far = np.where(axis_parallel, np.where(between, np.inf, -np.inf), far)

    # The ray is inside the box between the last entry and the first exit.
    enter = np.maximum(near.max(axis=2), 0.0)
    leave = far.min(axis=2)
    reached = np.where(enter <= leave, enter, np.inf).min(axis=1)
    return np.minimum(reached, limit)


def choose_spawns(brushes, low, high, origin, shape, standing, reachable,
                  wanted=SPAWN_COUNT):
    """Pick well separated spawns that face into open ground.

    Every rule here is one of the assertions in map.rs, applied while choosing
    rather than checked afterwards: inside the arena, clear of geometry,
    standing on the floor, and looking at something further away than the end
    of its own nose. Spawning into a wall is disorienting anywhere; in a game
    where the first second of a life costs a dollar it is also unfair.
    """
    free, blocked = standable(brushes, low, high, origin, shape)

    # Everywhere a player can walk to from everywhere else. Anything outside
    # the largest such region is somewhere they would spend the match alone.
    #
    # Eroded by the player's half-width first, so a gap narrower than their
    # shoulders does not count as a way through. Without that, a fenced side
    # strip reads as joined to the yard because the two touch at one cell,
    # and five of the twelve yard spawns ended up behind a fence.
    # Rounded up and then some: a player needs 0.7 m to pass, and asking for
    # rather more than that before calling somewhere connected only costs a
    # few spawn options in narrow places. Calling somewhere connected that is
    # not costs a player their whole match.
    # Measured on the brushes, not on the voxel grid.
    #
    # `reachable` comes from `climb`, which reasons about the art. The game
    # collides against this table, and the two are not the same thing - the
    # table is quantised, banded, smoothed and has prop boxes on top. Asking
    # the art whether two places are joined got the answer wrong twice, both
    # times caught by the Rust `every_spawn_can_reach_every_other`, which
    # walks the map with the real resolver. So ask the table.
    #
    # Connectivity is asked of a mask grown by one cell, not of `free`.
    # `free` is grown by the player's width *plus slack* because a spawn
    # wants elbow room; asking that mask whether two places are joined
    # demands a 1.75 m corridor between them and splits the arena in half,
    # which is why every spawn ended up in the same end of it. One cell is
    # 0.75 m against a 0.70 m player: the honest question.
    # And asked of geometry that is actually in the way, which is not the
    # same as geometry that exists. `blocked` is a footprint of everything
    # with a top above the floor, roofs and gantries and lids included, and
    # a column is marked from it however far overhead the thing is. Used for
    # connectivity that says a roofed street cannot be walked down.
    #
    # The arena's own lid - one slab nine metres up over the whole original
    # compound - put the two halves of the map in different regions, so
    # every spawn went to one side of gateways a player strolls through.
    # The yard reported a hundred and twenty two regions for the same
    # reason. Anything whose underside is clear of a standing player on the
    # highest floor a spawn may sit on is not an obstacle, it is a ceiling.
    overhead = SPAWN_GROUND_CEILING + PLAYER_BAND
    obstructing = np.zeros(shape, bool)
    for bx0, by0, bz0, bx1, by1, bz1 in brushes:
        if by1 <= 0.0 or by0 >= overhead:
            continue
        i0 = max(int(np.floor((bx0 - origin[0]) / CELL)), 0)
        i1 = min(int(np.ceil((bx1 - origin[0]) / CELL)), shape[0])
        j0 = max(int(np.floor((bz0 - origin[2]) / CELL)), 0)
        j1 = min(int(np.ceil((bz1 - origin[2]) / CELL)), shape[1])
        obstructing[i0:i1, j0:j1] = True

    passable = ~grow_square(obstructing, 1)
    edge = int(np.ceil(SPAWN_EDGE_MARGIN / CELL))
    passable[:edge, :] = passable[-edge:, :] = False
    passable[:, :edge] = passable[:, -edge:] = False

    ground_top = np.zeros(shape)
    for bx0, _by0, bz0, bx1, by1, bz1 in brushes:
        if by1 <= 0.0 or by1 > SPAWN_GROUND_CEILING:
            continue  # the floor slab, or a roof rather than a floor
        i0 = max(int(np.floor((bx0 - origin[0]) / CELL)), 0)
        i1 = min(int(np.ceil((bx1 - origin[0]) / CELL)), shape[0])
        j0 = max(int(np.floor((bz0 - origin[2]) / CELL)), 0)
        j1 = min(int(np.ceil((bz1 - origin[2]) / CELL)), shape[1])
        if i1 > i0 and j1 > j0:
            np.maximum(ground_top[i0:i1, j0:j1], by1,
                       out=ground_top[i0:i1, j0:j1])
    label, sizes = walkable_regions(passable, ground_top)
    main = int(np.argmax(sizes))
    share = 100.0 * sizes[main] / max(int(passable.sum()), 1)
    lost = int((free & (label != main)).sum())
    print(f"  the walkable floor is {len(sizes) - 1} separate regions; the "
          f"largest holds {share:.0f}% of it, and ruling out the rest drops "
          f"{lost:,} otherwise usable spawn cells", file=sys.stderr)
    free = free & (label == main)

    yaws = np.arange(8) * (np.pi / 4)

    # The middle of the part of the map that is actually played, which is not
    # the middle of its bounding box: the yard's walkable ground is off to one
    # side of the rectangle the model occupies.
    playable = np.nonzero(free)
    centre_x = origin[0] + (playable[0].mean() + 0.5) * CELL
    centre_z = origin[2] + (playable[1].mean() + 0.5) * CELL
    print(f"  the playable middle is at ({centre_x:.1f}, {centre_z:.1f})",
          file=sys.stderr)

    # How much geometry is within `SPAWN_COVER_RADIUS` of each cell, as a share
    # of the area looked at. Cheap: one summed-area table over the whole map.
    reach = int(round(SPAWN_COVER_RADIUS / CELL))
    window = float((2 * reach + 1) ** 2)
    cover = window_counts(blocked, reach) / window

    corners = np.asarray(brushes, dtype=float)
    lows, highs = corners[:, 0:3], corners[:, 3:6]

    # A candidate every `step` cells, which is at least one per metre and
    # coarser on a map with enough open ground to need it.
    per_metre = max(int(round(1.0 / CELL)), 1)
    open_metres = int(free[::per_metre, ::per_metre].sum())
    step = per_metre * max(int(np.ceil(np.sqrt(open_metres / MAX_SPAWN_CANDIDATES))), 1)

    candidates = []
    for ix in range(0, free.shape[0], step):
        for iz in range(0, free.shape[1], step):
            if not free[ix, iz]:
                continue
            x = origin[0] + (ix + 0.5) * CELL
            z = origin[2] + (iz + 0.5) * CELL
            if cover[ix, iz] < SPAWN_COVER_SHARE:
                continue  # out on the apron with nothing around
            seen = clearance((x, SPAWN_HEIGHT, z), yaws, lows, highs,
                             limit=SPAWN_SIGHT)
            # Of the directions that can see far enough, the one that looks
            # most nearly towards the middle of the map.
            towards = np.hypot(centre_x - x, centre_z - z)
            if towards > 1e-3:
                # -Z is forward, matching `sim::look_direction`.
                inwards = ((-np.sin(yaws)) * (centre_x - x)
                           + (-np.cos(yaws)) * (centre_z - z)) / towards
            else:
                inwards = np.zeros_like(yaws)
            score = np.where(seen >= SPAWN_CLEARANCE,
                             inwards + seen * SIGHT_TIEBREAK, -np.inf)
            pick = int(score.argmax())
            if np.isfinite(score[pick]):
                candidates.append((x, z, float(yaws[pick]), float(seen[pick]),
                                   float(cover[ix, iz])))

    if len(candidates) < wanted:
        raise SystemExit(f"only {len(candidates)} usable spawns, wanted {wanted}")

    # Farthest-point sampling, so the spawns end up spread out rather than
    # clustered wherever the map is most open.
    #
    # Seeded from the best-covered candidate rather than from the two extremes
    # of z. Seeding from the extremes guaranteed that two of the twelve were
    # the far ends of the map by construction, which on a map this long is two
    # players starting in the wrong postcode. Growing outwards from the middle
    # of the built-up part spreads just as well and starts somewhere worth
    # being.
    chosen = [max(candidates, key=lambda c: c[4])]
    candidates.remove(chosen[0])
    while len(chosen) < wanted and candidates:
        best, far = None, -1.0
        for c in candidates:
            d = min((c[0] - s[0]) ** 2 + (c[1] - s[1]) ** 2 for s in chosen)
            if d > far:
                best, far = c, d
        chosen.append(best)
        candidates.remove(best)
    return chosen


def escapable_regions(fits, standing, labels, count, home):
    """Which walkable regions can get back to `home`, given a jump.

    Region adjacency first - every boundary between two regions where the
    step up is one a player could make - then the transitive closure of it.
    Two hops matter: a pen with a crate in it is escapable if the crate is a
    step from the floor and the wall is a step from the crate.
    """
    links = {}
    for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        here = labels
        there = np.roll(np.roll(labels, -dx, axis=0), -dz, axis=1)
        rise = np.roll(np.roll(standing, -dx, axis=0), -dz, axis=1) - standing
        border = (here > 0) & (there > 0) & (here != there) & (rise <= JUMP_REACH)
        for a, b in zip(here[border], there[border]):
            links.setdefault(int(a), set()).add(int(b))

    good = {home}
    spreading = True
    while spreading:
        spreading = False
        for region, reaches in links.items():
            if region not in good and reaches & good:
                good.add(region)
                spreading = True
    return good


def seal_traps(brushes, grid, standing, reachable, origin, low, high):
    """Brushes that fill every pocket a player could fall into and not leave.

    Each is filled to the height of what encloses it, so landing there puts a
    player on top of the wall rather than behind it.
    """
    from scipy import ndimage

    room = int(np.ceil(PLAYER_RADIUS / CELL))
    fits = ~grow_square(~reachable, room)
    labels, count = ndimage.label(fits)
    if count == 0:
        return []

    sizes = ndimage.sum_labels(fits, labels, range(1, count + 1))
    home = int(np.argmax(sizes)) + 1
    good = escapable_regions(fits, standing, labels, count, home)

    # Regions that reach the edge of the grid are exempt from the area cap.
    #
    # The cap is there because a huge pocket nobody can reach is more likely
    # a mistake in the model than a pen, and filling a mistake that size
    # would be worse than the trap. That reasoning is about the inside of a
    # map. At its edge, something large that a player can drop into and not
    # climb out of is the outside of the world, which is exactly what wants
    # filling however big it is.
    #
    # This is a generalisation rather than a fix for anything currently in
    # either map: the yard's out-of-bounds margin is not caught here,
    # because it joins the playable area somewhere and so is escapable.
    # `outside_the_art` is what deals with that one.
    rim = set(labels[0, :]) | set(labels[-1, :])
    rim |= set(labels[:, 0]) | set(labels[:, -1])
    rim.discard(0)

    filled, sealed_area, left_alone = [], 0.0, 0.0
    for region in range(1, count + 1):
        if region in good:
            continue
        area = float(sizes[region - 1]) * CELL * CELL
        too_big = area > TRAP_MAX_AREA and region not in rim
        if area < CELL * CELL or too_big:
            left_alone += area
            continue
        pocket = labels == region
        # How high the wall around it is. The pocket is eroded by the
        # player's width, so its true edge is a little outside; look that far
        # out for the geometry doing the enclosing.
        around = grow_square(pocket, room + 2) & ~pocket
        walls = standing[around]
        walls = walls[walls > standing[pocket].mean() + MAX_STEP_UP]
        if not walls.size:
            left_alone += area
            continue
        sealed_area += area
        lid = float(np.median(walls))

        # Fill the pocket *and* the ring the erosion took off it, or the
        # player lands in the gap between the fill and the wall.
        solid = grow_square(pocket, room)
        for x0, x1, z0, z1 in rectangles(solid):
            made = box(origin, low, high, x0, x1, z0, z1, 0.0, lid)
            if made:
                filled.append(made)

    print(f"  {sealed_area:,.0f} m2 of inescapable pocket filled in, "
          f"{left_alone:,.0f} m2 left as it was", file=sys.stderr)
    return filled


def check(brushes):
    """The same invariant map.rs asserts, caught here instead of in a test."""
    bad = []
    for i, a in enumerate(brushes):
        for j, b in enumerate(brushes[i + 1:], i + 1):
            depth = [min(a[3 + k], b[3 + k]) - max(a[k], b[k]) for k in range(3)]
            if all(d > 1e-4 for d in depth):
                bad.append((i, j, depth))
    return bad


def main(path, name, scale):
    global SCALE
    SCALE = scale

    stage("reading the model")
    meshes = mesh_nodes(path)
    stage("classifying meshes as props or structure")
    props, structure = classify(meshes)
    stage(None)
    print(f"  {name}: {len(meshes)} meshes, {len(props)} props take their own "
          f"box, {len(structure)} are structure", file=sys.stderr)

    verts = np.vstack([m[1] for m in meshes])
    low, high = verts.min(0), verts.max(0)
    print(f"  {name}: {high[0] - low[0]:.0f} x {high[2] - low[2]:.0f} m, "
          f"{high[1]:.0f} m tall, at {SCALE}x", file=sys.stderr)

    offset = 0
    sverts, sfaces = [], []
    for _, mv, mf in structure:
        sverts.append(mv)
        sfaces.append(mf + offset)
        offset += len(mv)
    grid, origin = voxelise(np.vstack(sverts), np.vstack(sfaces))
    shaped = build_brushes(grid, origin, low, high)

    stage("boxing the props")
    boxes = []
    for _, pverts, pfaces, plow, phigh in props:
        # A prop thinner than a centimetre in some axis is a decal or a shadow
        # plane, not an object; giving it collision would put an invisible pane
        # of glass in the arena.
        if np.min(phigh - plow) < 0.01:
            continue
        boxes.extend(prop_boxes(pverts, pfaces, plow, phigh))
    stage(None)

    stage("sealing the margin outside the art")
    footprint = (grid.shape[0], grid.shape[2])
    margin = outside_the_art(grid, boxes, origin, footprint)
    apron = edge_apron(grid, boxes, origin, footprint, margin)
    edge = []
    for x0, x1, z0, z1 in rectangles(margin | apron):
        made = box(origin, low, high, x0, x1, z0, z1, 0.0, WALL_HEIGHT)
        if made:
            edge.append(made)
    stage(None)
    print(f"  {margin.sum() * CELL * CELL:,.0f} m2 of bare slab outside the "
          f"art sealed off, plus {apron.sum() * CELL * CELL:,.0f} m2 of apron "
          f"walled at the edge, in {len(edge)} brushes", file=sys.stderr)

    frame = perimeter(low, high) + edge
    brushes = frame + shaped + boxes

    stage("sealing pockets a player could not climb out of")
    standing, reachable = climb(obstacle_heights(grid), grid)
    plugs = seal_traps(brushes, grid, standing, reachable, origin, low, high)
    brushes = brushes + plugs
    stage(None)

    stage("choosing spawns")
    height = obstacle_heights(grid)
    spawns = choose_spawns(brushes, low, high, origin, height.shape,
                           standing, reachable, wanted=SPAWN_COUNT)
    stage(None)
    print(f"  {name}: {len(frame)} perimeter + {len(shaped)} structure + "
          f"{len(boxes)} boxes for {len(props)} props + {len(plugs)} sealing "
          f"traps = {len(brushes)} brushes, {len(spawns)} spawns",
          file=sys.stderr)

    upper = name.upper()
    print(f"// --- {name} " + "-" * (66 - len(name)))
    print(f"// {len(brushes)} brushes: {len(frame)} stated perimeter, "
          f"{len(shaped)} derived structure, {len(boxes)} prop boxes.")
    print("#[rustfmt::skip]")
    # Coordinates are coordinates. Some of them land near 3.14 or 1.57 and
    # clippy helpfully points out that these are approximately pi and pi/2.
    print("#[allow(clippy::approx_constant)]")
    print(f"static {upper}_BRUSHES: &[Brush] = &[")
    print("    // min x, y, z then max x, y, z.")
    for k, (x0, y0, z0, x1, y1, z1) in enumerate(brushes):
        if k == len(frame):
            print("    // Derived structure: walls, buildings, stairs, ramps.")
        if k == len(frame) + len(shaped):
            print("    // Props, each its own exact bounding box.")
        print(f"    brush({x0:.2f}, {y0:.2f}, {z0:.2f}, "
              f"{x1:.2f}, {y1:.2f}, {z1:.2f}),")
    print("];")
    print()
    print("#[rustfmt::skip]")
    print("#[allow(clippy::approx_constant)]")
    print(f"static {upper}_SPAWNS: &[Spawn] = &[")
    print("    // x, y, z then facing in radians.")
    for x, z, yaw, seen, _ in spawns:
        eighths = int(round(yaw / (np.pi / 4))) % 8
        facing = "0.0" if eighths == 0 else f"EIGHTH * {eighths}.0"
        print(f"    spawn({x:.2f}, {SPAWN_HEIGHT:.2f}, {z:.2f}, {facing}),"
              f" // {seen:.0f} m of clear ground ahead")
    print("];")
    print()
    print(f"/// {name}: {high[0] - low[0]:.0f} by {high[2] - low[2]:.0f} metres.")
    # The furthest a player can get from the origin along each axis, which is
    # not `high` unless the model happens to be centred on it. The arena is;
    # the yard is half a metre off, and taking `high` there would have called
    # part of the floor "outside the map".
    #
    # One line, because that is what rustfmt does with it and `./x check`
    # runs rustfmt over generated code like any other. Emitting the argument
    # per line reads better here and fails the build.
    args = ', '.join([
        f'"{name}"', f'{SCALE}',
        f'{max(abs(low[0]), abs(high[0])):.2f}',
        f'{max(abs(low[2]), abs(high[2])):.2f}',
        f'{upper}_BRUSHES', f'{upper}_SPAWNS', f'{MAX_PLAYERS}',
    ])
    print(f"pub static {upper}: Map = Map::new({args});")


if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        raise SystemExit(2)

    def option(flag, fallback):
        return args[args.index(flag) + 1] if flag in args else fallback

    # Assigned at module scope, which is where they already live, so these
    # rebind the globals that `main` and `choose_spawns` read.

    SPAWN_COUNT = int(option('--spawns', SPAWN_COUNT))
    MAX_PLAYERS = int(option('--max-players', MAX_PLAYERS))
    if SPAWN_COUNT <= MAX_PLAYERS:
        raise SystemExit(
            f'--spawns {SPAWN_COUNT} must exceed --max-players {MAX_PLAYERS}: '
            'a full match needs spare points to be scattered across, or every '
            'match lines everybody up in the same places'
        )
    main(args[0], option('--name', 'arena'), float(option('--scale', SCALE)))
