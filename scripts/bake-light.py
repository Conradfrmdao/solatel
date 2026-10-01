#!/usr/bin/env python3
"""Bake each map's light: the light that reaches every point of it from the
sky and back off the map's own surfaces, and whether the sun does.

    pip install embreex numpy           # once: Intel's ray tracer
    python scripts/bake-light.py           # every map
    python scripts/bake-light.py arena     # just one

Writes `assets/light/<map>.bin`, which `light.js` uploads as two 3D textures
that the map's surfaces sample by world position. Run it after anything that
changes a map's geometry or colours, or a sky's numbers in `SKIES`
(`world.js`). The tracing is the slow part - minutes a map - and is kept in
`target/light/` for as long as the geometry, the colours and the sky's
photograph are unchanged, so trying another brightness of sun or sky costs
seconds.

**Why a volume.** The maps have no texture coordinates, so a lightmap would
first need an unwrap of every map; a grid of cells over the map needs
nothing but a position, which every pixel already has. Half a metre to a
metre a cell is too coarse for a contact shadow and exactly right for what
the scene was missing: a room is darker than the yard outside it, an alley
darker than the street, the foot of a wall darker than its top - and the
side of a building that faces a sunlit yard lit warm by it.

**A cell holds light, not shade**, in three.js's own units: the irradiance
a surface facing a given way receives, which is what the environment map's
diffuse light was. The shader puts it exactly where that went. It is

- the sky, from the map's own photograph with the sun taken out of it and
  some of its blue, exactly as `world.js` takes them out (`cut_sun`). The sun is the directional
  light, which casts shadows. Left in, the photograph's sun was blurred into
  the environment as a second sun that cast none - on the arena four times
  as bright as the directional light, lighting every room and every shadow.
- the light the map sends back, at each surface's own colour: the sun's off
  whatever it lands on, and the sky's off everything. Traced twice, the
  second pass reading the first back off every surface it hits, so light
  that has bounced once comes round again. That is how a room is lit through
  its door: the sun on the ground outside, then off the walls inside.

**A colour and the way it leans.** Light at a cell is first-order spherical
harmonics with one direction shared by the three colours: a surface facing
n receives E0 (1 + d.n), never less than nothing. Six numbers rather than
six per colour, and the eye reads colour where light comes from far less
than how much comes and from which side.

**The sun and the sky are traced apart** and added at the end with the
strengths `SKIES` gives them. Light is linear, so that is exact - and it is
why changing them needs no re-trace.

**And two numbers more**: whether the sun reaches the cell, for shadows past
the edge of the shadow map, which follows the player and stops thirty-odd
metres away (the direction is the brightest texel of the map's sky, found as
`world.js` finds it); and how much of the sky the cell sees at all, for
dimming reflections where there is nothing to reflect.

**Cells inside geometry are filled from their neighbours.** Inside is
whatever open air cannot reach through cells that see one another - a wall,
the ground, a sealed attic (`reachable`); left as it is, its darkness would
bleed into the surface beside it when the texture is filtered.

Format, little-endian: a 64-byte header - b'SLV2', the grid's size (three
u16 and a pad), its origin in metres (three f32), the size of a cell (f32),
the brightest light held (f32), the sun's strength, the sky's and the sun's
colour it was added up with (f32, f32, u32 0xRRGGBB), the least light
anywhere (three f32, `FLOOR`) and how bright open ground is lit from above
(f32, luminance) - then eight bytes a cell, as eight planes of a byte a cell,
x fastest, then y, then z, each row stored as differences along x (mod 256):

    the light's colour, sqrt(E0 / brightest) in r, g and b; the sun;
    the way it leans, d / 4 + 1/2 in x, y and z; how open, 0 to 1
"""
import hashlib
import importlib.util
import multiprocessing
import os
import re
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

# Drawn, but not in the way of light: glass, water, fences of wire.
SEE_THROUGH = {'glass', 'water', 'chainlink'}

# Rays a cell, spread over the whole sphere, and for the sun a few spread
# over its disc, so a shadow's edge is a gradient, not a step.
RAYS = 128
SUN_RAYS = 6
SUN_SPREAD = np.radians(1.2)
# Past this a ray has found the sky: the arena's far wall is under 100 m off.
REACH = 80.0
# Cells are as small as the budget allows: about this many, in all.
BUDGET = 4_500_000
CELLS = (0.5, 0.75, 1.0, 1.25)
# The grid runs from just under the ground to this high: nothing anybody
# stands on is higher, and a surface outside the grid reads its nearest
# layer - which for the tops of silos and the bed of the facility's river is
# light enough, and which cost a fifth of the facility's file.
FLOOR_DEPTH = -1.5
CEILING = 24.0
# How much of the sky a cell has to see to count as open air outright, from
# which the air a player can be in is flooded (`reachable`).
OPEN_AIR = 0.25
# Where a surface reads the light it is lit by, out along its normal, in
# cells, as the shader reads it (`lookup`): a cell out from a wall, so it
# reads the air in front of it, and half as far again from anything facing
# up.
# Bounces of the sun's light, and of the sky's one fewer.
PASSES = 2
# No surface sends back all of what lands on it.
ALBEDO_CAP = 0.85
# How many times each pass's light is smoothed over neighbouring cells that
# can see each other, to take out the noise of a finite number of rays.
SMOOTHING = 2
# The least light anywhere, as a share of what open ground gets from the sky:
# a person can see into a room with its door shut, by the light its walls
# pass round, and a player has to be able to see who is in it. Applied in the
# shader, softly, so what is brighter than it is barely changed.
FLOOR = 0.25
# What a pass works through at once, in cells.
BLOCK = 12_000
# Rec. 709 luminance, for the one direction the three colours share.
LUMINANCE = np.array([0.2126, 0.7152, 0.0722])

# The sun is cut out of the sky to this radius, down to the sky around it
# (`cutSun` in `world.js`: the two must agree).
SUN_CUT = np.radians(8.0)
SUN_RING = np.radians(12.0)
# How much of its colour the sky's light keeps (`SKY_SATURATION` in
# `world.js`): a clear sky is deep blue, and shade lit by all of it reads as
# night, where an eye in it sees grey.
SKY_SATURATION = 0.6


def srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def client_tables():
    """What the client paints and lights with: each surface's photograph and
    how far it is tinted towards the palette (`PHOTO` in `photo.js`), each
    photograph's average colour (`photo-sets.js`), and each map's sky
    (`SKIES` in `world.js`)."""
    def read(path):
        return open(os.path.join(ROOT, 'client', 'src', path), encoding='utf-8').read()
    photo = {name: (photo_set, float(tint)) for name, photo_set, tint in
             re.findall(r"^\s+(\w+): \['(\w+)', [\d.]+, ([\d.]+),", read('photo.js'), re.M)}
    averages = {name: srgb_to_linear(np.array([int(r), int(g), int(b)]) / 255.0) for name, r, g, b in
                re.findall(r"^\s+(\w+): \{ average: \[(\d+), (\d+), (\d+)\]", read('photo-sets.js'), re.M)}
    skies = {}
    for name, file, sun, colour, sky in re.findall(
            r"^\s+(\w+): \{ file: '(\w+)', sun: ([\d.]+), sunColour: 0x([0-9a-fA-F]{6}), sky: ([\d.]+)[^}]*\}",
            read('world.js'), re.M):
        skies[name] = {'file': file, 'sun': float(sun), 'colour': int(colour, 16), 'sky': float(sky)}
    if not photo or not averages or not skies:
        raise SystemExit('could not read PHOTO, PHOTO_SETS or SKIES from the client; has their shape changed?')
    return photo, averages, skies


def albedo_of(material, photo, averages):
    """The colour a material is drawn in, on average, linear: its palette
    colour, or its photograph's average tinted towards that as `photoUniforms`
    tints it."""
    base = np.array(material.get('pbrMetallicRoughness', {}).get('baseColorFactor', [0.8, 0.8, 0.8, 1])[:3])
    name = material.get('name', '')
    if name in photo and photo[name][0] in averages:
        average = averages[photo[name][0]]
        tint = np.clip(1 + (base / np.maximum(average, 1e-3) - 1) * photo[name][1], 0.25, 3)
        base = average * tint
    return np.clip(base, 0.0, ALBEDO_CAP)


def drawn_triangles(name, photo, averages):
    """Every drawn, solid triangle of a map in world metres, its facing and
    the colour it is drawn in."""
    path = os.path.join(ROOT, 'assets', 'maps', f'{name}.glb')
    scale = MAPS[name]
    js, blob = BRUSHES.read_glb(path)
    nodes = js['nodes']
    world, hidden = {}, set()

    def walk(index, parent, hide):
        node = nodes[index]
        world[index] = parent @ BRUSHES.node_matrix(node)
        # Collided with and never drawn - the trunks `nature.js` grows - and
        # everything under it is hidden with it, as the client hides it.
        hide = hide or bool(node.get('extras', {}).get('collision_only'))
        if hide:
            hidden.add(index)
        for child in node.get('children', []):
            walk(child, world[index], hide)

    for root in js['scenes'][js.get('scene', 0)]['nodes']:
        walk(root, np.eye(4), False)

    triangles, colours = [], []
    for index, node in enumerate(nodes):
        if 'mesh' not in node or index in hidden:
            continue
        for prim in js['meshes'][node['mesh']]['primitives']:
            if prim.get('mode', 4) != 4:
                continue
            material = js['materials'][prim['material']] if 'material' in prim else {}
            if material.get('name', '') in SEE_THROUGH:
                continue
            points = BRUSHES.accessor(js, blob, prim['attributes']['POSITION'])
            homogeneous = np.hstack([points, np.ones((len(points), 1))])
            placed = (world[index] @ homogeneous.T).T[:, :3] * scale
            if 'indices' in prim:
                faces = BRUSHES.accessor(js, blob, prim['indices']).astype(np.int64).reshape(-1, 3)
            else:
                faces = np.arange(len(points)).reshape(-1, 3)
            triangles.append(placed[faces])
            colours.append(np.tile(albedo_of(material, photo, averages), (len(faces), 1)))
    triangles = np.concatenate(triangles).astype(np.float32)
    colours = np.concatenate(colours).astype(np.float32)

    # Facing by glTF's winding: anticlockwise is the front.
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    length = np.linalg.norm(normals, axis=1)
    keep = length > 1e-9
    return triangles[keep], (normals[keep] / length[keep, None]).astype(np.float32), colours[keep]


def read_hdr(path):
    """A Radiance .hdr as float RGB, rows from the top: the run-length
    encoded kind Poly Haven writes, and nothing else."""
    with open(path, 'rb') as handle:
        raw = handle.read()
    header_end = raw.index(b'\n\n') + 2
    line_end = raw.index(b'\n', header_end)
    size = raw[header_end:line_end].decode().split()
    height, width = int(size[1]), int(size[3])
    data = np.frombuffer(raw, dtype=np.uint8, offset=line_end + 1)
    out = np.zeros((height, width, 4), dtype=np.uint8)
    at = 0
    for row in range(height):
        if data[at] != 2 or data[at + 1] != 2:
            raise SystemExit(f'{path}: not a run-length encoded HDR')
        at += 4
        for channel in range(4):
            x = 0
            while x < width:
                count = int(data[at])
                at += 1
                if count > 128:
                    count -= 128
                    out[row, x:x + count, channel] = data[at]
                    at += 1
                else:
                    out[row, x:x + count, channel] = data[at:at + count]
                    at += count
                x += count
    exponent = out[..., 3].astype(np.float64)
    scale = np.where(out[..., 3] > 0, np.ldexp(1.0, (exponent - 136).astype(np.int32)), 0.0)
    return out[..., :3] * scale[..., None], width, height


def panorama_directions(width, height):
    """The direction each texel of an equirectangular sky looks, as three.js
    maps one (`equirectUv`), and the solid angle it covers."""
    elevation = (0.5 - (np.arange(height) + 0.5) / height) * np.pi
    azimuth = ((np.arange(width) + 0.5) / width - 0.5) * 2 * np.pi
    el, az = np.meshgrid(elevation, azimuth, indexing='ij')
    directions = np.stack([np.cos(az) * np.cos(el), np.sin(el), np.sin(az) * np.cos(el)], axis=-1)
    solid = np.cos(el) * (np.pi / height) * (2 * np.pi / width)
    return directions, solid


def sky_of(name, skies):
    """A map's sky: the photograph's radiance with its sun cut out, and the
    direction to the sun - its brightest texel, by the same weights and
    mapping as `_loadSky` in `world.js`."""
    spec = skies.get(name, skies.get('facility'))
    data, width, height = read_hdr(os.path.join(ROOT, 'assets', 'sky', f"{spec['file']}_1k.hdr"))
    lum = data[..., 0] * 0.3 + data[..., 1] * 0.59 + data[..., 2] * 0.11
    at = int(np.argmax(lum))
    directions, solid = panorama_directions(width, height)
    sun = directions.reshape(-1, 3)[at].copy()
    sun[1] = abs(sun[1])
    data = cut_sun(data, directions, directions.reshape(-1, 3)[at])
    grey = (data @ LUMINANCE)[..., None]
    data = grey + (data - grey) * SKY_SATURATION
    return data, directions, solid, sun / np.linalg.norm(sun)


def cut_sun(data, directions, peak):
    """The sky with its sun taken out: every texel within `SUN_CUT` of the
    brightest one brought down to the sky round it - no brighter than the
    average of the ring out to `SUN_RING` - keeping its own colour. The
    directional light is the sun; this is what is left. (`cutSun` in
    `world.js`.)"""
    angle = np.arccos(np.clip(directions @ peak, -1, 1))
    ring = (angle >= SUN_CUT) & (angle < SUN_RING)
    lum = data @ LUMINANCE
    ceiling = (data[ring] @ LUMINANCE).mean()
    over = (angle < SUN_CUT) & (lum > ceiling)
    out = data.copy()
    out[over] *= (ceiling / lum[over])[:, None]
    return out


def directions(count, seed):
    """`count` directions spread evenly over the sphere (a Fibonacci
    spiral), turned by a rotation of their own so neighbouring cells do not
    share the same blind spots."""
    i = np.arange(count) + 0.5
    phi = np.arccos(1 - 2 * i / count)
    theta = np.pi * (1 + 5 ** 0.5) * i
    spiral = np.stack([np.cos(theta) * np.sin(phi), np.cos(phi), np.sin(theta) * np.sin(phi)], axis=1)
    q, r = np.linalg.qr(np.random.default_rng(seed).normal(size=(3, 3)))
    return spiral @ (q * np.sign(np.diag(r)))


def sky_radiance(data, panorama, solid, rays):
    """The sky's radiance along each ray: the photograph averaged over the
    cone round the ray that is its share of the sphere, since each ray
    stands for that much of the sky."""
    # A quarter of the resolution first: a share is ten degrees across.
    h, w = data.shape[0] // 4, data.shape[1] // 4
    weight = solid[:h * 4, :w * 4].reshape(h, 4, w, 4)
    small = (data[:h * 4, :w * 4].reshape(h, 4, w, 4, 3) * weight[..., None]).sum(axis=(1, 3))
    small_weight = weight.sum(axis=(1, 3))
    small_dirs = (panorama[:h * 4, :w * 4].reshape(h, 4, w, 4, 3) * weight[..., None]).sum(axis=(1, 3))
    small_dirs /= np.linalg.norm(small_dirs, axis=-1, keepdims=True)
    flat_dirs = small_dirs.reshape(-1, 3)
    near = (rays.reshape(-1, 3) @ flat_dirs.T) > 1 - 2 / RAYS
    radiance = (near @ small.reshape(-1, 3)) / (near @ small_weight.reshape(-1))[:, None]
    return radiance.reshape(rays.shape).astype(np.float32)


# ---- tracing -----------------------------------------------------------------
#
# The passes run in worker processes, one block of cells at a time. The
# arrays they read are module globals set before the workers fork, so each
# worker sees them without a copy; each builds its own copy of the scene.

G = {}


def _scene():
    if 'scene' not in G:
        G['scene'] = rtcs.EmbreeScene()
        TriangleMesh(G['scene'], G['triangles'])
    return G['scene']


def _cell_centres(ids):
    dims = G['dims']
    x = ids % dims[0]
    y = (ids // dims[0]) % dims[1]
    z = ids // (dims[0] * dims[1])
    return G['origin'] + (np.stack([x, y, z], axis=1) + 0.5) * G['cell']


def _cell_of(points):
    """The index of the cell holding each point, clamped to the grid."""
    dims = G['dims']
    at = np.floor((points - G['origin']) / G['cell']).astype(np.int64)
    at = np.clip(at, 0, dims - 1)
    return at[:, 0] + dims[0] * (at[:, 1] + dims[1] * at[:, 2])


def lookup(normals):
    """How far out along its normal a surface reads the grid, in metres:
    `reach` in `light.js`'s shader, which this must match."""
    t = np.clip((normals[:, 1] - 0.3) / 0.5, 0, 1)
    return G['cell'] * (1.0 + 0.5 * t * t * (3 - 2 * t))


def _light_at(volume, cells, normals):
    """A pass's light, from its L1 terms, at cells for surfaces facing
    `normals`: E = A + B n, never less than nothing, per colour."""
    a, b = volume
    return np.maximum(0.0, a[cells] + np.einsum('kca,ka->kc', b[cells], normals))


def _trace(block):
    """One block of cells for one pass: the sun's light and the sky's that
    arrive at each, as L1 terms, and in the first pass whether the sun gets
    there, how open it is and whether it is inside geometry."""
    start, stop, first = block
    scene = _scene()
    ids = np.arange(start, stop)
    n = len(ids)
    centres = _cell_centres(ids)
    which = ids % 16
    rays = G['sets'][which]  # cell, ray, xyz
    origins = np.repeat(centres, RAYS, axis=0).astype(np.float32)
    dirs = rays.reshape(-1, 3)
    hit = scene.run(origins, dirs, dists=np.full(len(dirs), REACH, dtype=np.float32), output=1)
    prim = hit['primID']
    landed = prim >= 0

    # Escaped: the sky. Landed: what that surface sends back.
    sun = np.zeros((len(dirs), 3), dtype=np.float32)
    sky = np.zeros((len(dirs), 3), dtype=np.float32)
    sky[~landed] = G['sky'][which].reshape(-1, 3)[~landed]
    if landed.any():
        tri = prim[landed]
        facing = G['normals'][tri]
        behind = np.einsum('kc,kc->k', dirs[landed], facing) > 0
        # Drawn from both sides, so a face seen from behind faces the ray.
        facing = np.where(behind[:, None], -facing, facing)
        where = origins[landed] + dirs[landed] * hit['tfar'][landed, None]
        colour = G['albedo'][tri] / np.pi
        # The sun on that surface, if it gets there.
        towards = facing @ G['sun']
        lit = towards > 0
        reached = np.zeros(len(tri), dtype=bool)
        if lit.any():
            off = (where[lit] + facing[lit] * 0.01).astype(np.float32)
            rays_out = np.tile(G['sun'].astype(np.float32), (len(off), 1))
            reached[lit] = scene.run(off, rays_out, dists=np.full(len(off), 400.0, dtype=np.float32),
                                     query='OCCLUDED') < 0
        sun_in = np.where(reached, towards, 0.0)[:, None] * np.ones(3)
        sky_in = np.zeros((len(tri), 3))
        if not first:
            cells = _cell_of(where + facing * lookup(facing)[:, None])
            sun_in = sun_in + _light_at(G['prev_sun'], cells, facing)
            sky_in = _light_at(G['prev_sky'], cells, facing)
        sun[landed] = colour * sun_in
        sky[landed] = colour * sky_in

    # L1: A = pi/N sum L, B = 2 pi/N sum L w, per colour.
    w = dirs.reshape(n, RAYS, 3)
    out = {}
    for key, radiance in (('sun', sun), ('sky', sky)):
        radiance = radiance.reshape(n, RAYS, 3)
        out[key] = (radiance.sum(axis=1) * (np.pi / RAYS),
                    np.einsum('nrc,nra->nca', radiance, w) * (2 * np.pi / RAYS))
    if first:
        out['open'] = (~landed).reshape(n, RAYS).mean(axis=1)
        sun_origins = np.repeat(centres, SUN_RAYS, axis=0).astype(np.float32)
        sun_dirs = np.tile(G['sun_rays'], (n, 1))
        blocked = scene.run(sun_origins, sun_dirs, dists=np.full(len(sun_dirs), 400.0, dtype=np.float32),
                            query='OCCLUDED') >= 0
        out['sunlit'] = 1.0 - blocked.reshape(n, SUN_RAYS).mean(axis=1)
        # Whether each cell sees the next one along x, y and z: what the
        # smoothing may blend across.
        step = np.repeat(np.eye(3, dtype=np.float32)[None], n, axis=0).reshape(-1, 3)
        from_centres = np.repeat(centres, 3, axis=0).astype(np.float32)
        out['links'] = (scene.run(from_centres, step, dists=np.full(len(step), G['cell'], dtype=np.float32),
                                  query='OCCLUDED') < 0).reshape(n, 3)
    return start, stop, out


def reachable(links, opened, dims):
    """Which cells are air a player could be in: those above the ground and
    joined to open sky through cells that see one another. Everything else
    is inside something - a wall, the ground, the sealed attic under a
    pitched roof - and is filled from its neighbours rather than lit.

    Not judged by which way faces point, as it first was: a cell whose rays
    mostly met the backs of faces was taken to be inside a wall, and the
    facility's shed roofs are wound inside out - drawn from both sides, so it
    never showed - which put the air over every one of them inside a wall,
    and the roofs came out black."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    count = int(np.prod(dims))
    ids = np.arange(count)
    x = ids % dims[0]
    y = (ids // dims[0]) % dims[1]
    z = ids // (dims[0] * dims[1])
    rows, cols = [], []
    for axis, (coordinate, size, stride) in enumerate(((x, dims[0], 1), (y, dims[1], dims[0]),
                                                        (z, dims[2], dims[0] * dims[1]))):
        joined = links[:, axis] & (coordinate < size - 1)
        rows.append(ids[joined])
        cols.append(ids[joined] + stride)
    rows, cols = np.concatenate(rows), np.concatenate(cols)
    # Under the ground is never air, however it is reached: the ground stops
    # at the edge of the map, and open air would flood under it from there.
    underground = G['origin'][1] + (y + 0.5) * G['cell'] < 0
    keep = ~underground[rows] & ~underground[cols]
    rows, cols = rows[keep], cols[keep]
    graph = coo_matrix((np.ones(len(rows), dtype=np.int8), (rows, cols)), shape=(count, count))
    _, label = connected_components(graph, directed=False)
    open_labels = np.unique(label[(opened > OPEN_AIR) & ~underground])
    return np.isin(label, open_labels) & ~underground


def fill_inside(fields, inside, dims):
    """Cells inside geometry take the average of their known neighbours,
    outward, so filtering never reads the inside of a wall."""
    shape = (dims[2], dims[1], dims[0])
    grid = np.concatenate([f.reshape(len(f), -1) for f in fields], axis=1).reshape(*shape, -1)
    known = (~inside).reshape(shape)
    for _ in range(12):
        if known.all():
            break
        total = np.zeros_like(grid)
        number = np.zeros(shape, dtype=np.float32)
        for axis in range(3):
            for step in (-1, 1):
                shifted = np.roll(known, step, axis=axis)
                # No wrapping round the edges of the grid.
                edge = [slice(None)] * 3
                edge[axis] = 0 if step == 1 else -1
                shifted[tuple(edge)] = False
                total += np.roll(grid, step, axis=axis) * shifted[..., None]
                number += shifted
        fill = ~known & (number > 0)
        grid[fill] = total[fill] / number[fill][:, None]
        known |= fill
    # Anything never reached keeps what it traced.
    flat = grid.reshape(len(inside), -1)
    out, at = [], 0
    for f in fields:
        width = int(np.prod(f.shape[1:]))
        out.append(flat[:, at:at + width].reshape(f.shape).astype(np.float32))
        at += width
    return out


def smooth(fields, links, inside, dims):
    """Each cell blended with the neighbours it can see, `SMOOTHING` times.
    Blending only across clear air is what keeps a room's light in the room:
    the cell on the far side of a wall a quarter of a metre thick is a
    neighbour, and a blur that did not ask would light the room through it."""
    shape = (dims[2], dims[1], dims[0])
    grid = np.concatenate([f.reshape(len(f), -1) for f in fields], axis=1).reshape(*shape, -1)
    outside = (~inside).reshape(shape)
    joins = []
    for axis_index, axis in enumerate((2, 1, 0)):
        join = links[:, axis_index].reshape(shape) & outside & np.roll(outside, -1, axis=axis)
        # No wrapping round the edges of the grid.
        edge = [slice(None)] * 3
        edge[axis] = -1
        join[tuple(edge)] = False
        joins.append((axis, join))
    for _ in range(SMOOTHING):
        total = grid.copy()
        number = np.ones(shape, dtype=np.float32)
        for axis, join in joins:
            total += np.roll(grid, -1, axis=axis) * join[..., None]
            number += join
            back = np.roll(join, 1, axis=axis)
            total += np.roll(grid, 1, axis=axis) * back[..., None]
            number += back
        grid = np.where(outside[..., None], total / number[..., None], grid)
    flat = grid.reshape(len(inside), -1)
    out, at = [], 0
    for f in fields:
        width = int(np.prod(f.shape[1:]))
        out.append(flat[:, at:at + width].reshape(f.shape).astype(np.float32))
        at += width
    return out


def trace(name, triangles, normals, albedo, sky_rays, sun, sun_rays, dims, origin, cell, sets):
    """Every pass over every cell: the sun's light and the sky's, as L1
    terms, and the sun, openness and insideness of each cell."""
    count = int(np.prod(dims))
    G.clear()
    G.update(triangles=triangles, normals=normals, albedo=albedo, sky=sky_rays, sun=sun,
             sun_rays=sun_rays, dims=dims, origin=origin, cell=cell, sets=sets)
    blocks = [(s, min(s + BLOCK, count)) for s in range(0, count, BLOCK)]
    result = {}
    for p in range(PASSES):
        started = time.time()
        first = p == 0
        a_sun = np.zeros((count, 3), np.float32)
        b_sun = np.zeros((count, 3, 3), np.float32)
        a_sky = np.zeros((count, 3), np.float32)
        b_sky = np.zeros((count, 3, 3), np.float32)
        if first:
            opened = np.zeros(count, np.float32)
            sunlit = np.zeros(count, np.float32)
            links = np.zeros((count, 3), bool)
        # Forked after the globals are set, so every worker reads them as
        # they are now - the last pass's light included.
        with multiprocessing.get_context('fork').Pool(os.cpu_count()) as pool:
            for done, (start, stop, out) in enumerate(pool.imap_unordered(
                    _trace, [(s, e, first) for s, e in blocks], chunksize=1)):
                a_sun[start:stop], b_sun[start:stop] = out['sun']
                a_sky[start:stop], b_sky[start:stop] = out['sky']
                if first:
                    opened[start:stop] = out['open']
                    sunlit[start:stop] = out['sunlit']
                    links[start:stop] = out['links']
                if done % 40 == 0:
                    print(f'   pass {p + 1}: {done / len(blocks) * 100:.0f}%', file=sys.stderr, end='\r')
        if first:
            inside = ~reachable(links, opened, dims)
            print(f'   {inside.mean() * 100:.1f}% of cells inside geometry', file=sys.stderr)
        a_sun, b_sun, a_sky, b_sky, *rest = fill_inside(
            [a_sun, b_sun, a_sky, b_sky] + ([opened, sunlit] if first else []), inside, dims)
        if first:
            opened, sunlit = rest
        a_sun, b_sun, a_sky, b_sky = smooth([a_sun, b_sun, a_sky, b_sky], links, inside, dims)
        G['prev_sun'] = (a_sun, b_sun)
        G['prev_sky'] = (a_sky, b_sky)
        print(f'   pass {p + 1} of {PASSES} in {time.time() - started:.0f} s', file=sys.stderr)
    result.update(a_sun=a_sun, b_sun=b_sun, a_sky=a_sky, b_sky=b_sky, open=opened, sunlit=sunlit)
    return result


# ---- the whole bake ------------------------------------------------------------

def bake(name, photo, averages, skies):
    started = time.time()
    triangles, normals, albedo = drawn_triangles(name, photo, averages)
    sky_data, panorama, solid, sun = sky_of(name, skies)
    low = triangles.reshape(-1, 3).min(axis=0)
    high = triangles.reshape(-1, 3).max(axis=0)
    low[1] = max(low[1], FLOOR_DEPTH)
    high[1] = min(high[1], CEILING)
    span = high - low + 2.0
    cell = next((c for c in CELLS if np.prod(np.ceil(span / c)) <= BUDGET), CELLS[-1])
    origin = (low - 1.0).astype(np.float64)
    # The ground on a boundary between layers, never through the middle of
    # one: a cell half under the ground is half dark, and one centred on it
    # sends half its rays out from inside the ground plane.
    origin[1] = (np.floor(low[1] / cell) - 1) * cell
    dims = np.ceil((high + 1.0 - origin) / cell).astype(np.int64)
    print(f'{name}: {len(triangles):,} triangles, cells of {cell} m, '
          f'{dims[0]} x {dims[1]} x {dims[2]} = {np.prod(dims):,}', file=sys.stderr)

    # Sixteen turned copies of the ray directions, dealt out over the cells.
    sets = np.stack([directions(RAYS, seed) for seed in range(16)]).astype(np.float32)
    sun_offsets = directions(SUN_RAYS, 99)
    tilt = np.cross(sun, [0.0, 1.0, 0.0])
    tilt /= max(np.linalg.norm(tilt), 1e-9)
    side = np.cross(sun, tilt)
    sun_rays = np.array([np.cos(SUN_SPREAD * s[1]) * sun + np.sin(SUN_SPREAD * s[1]) * (s[0] * tilt + s[2] * side)
                         for s in sun_offsets], dtype=np.float32)
    sun_rays /= np.linalg.norm(sun_rays, axis=1, keepdims=True)
    sky_rays = sky_radiance(sky_data, panorama, solid, sets)

    # The trace depends on these and nothing else; keep it while they hold.
    key = hashlib.sha256()
    for part in (triangles, normals, albedo, sky_rays, sun.astype(np.float32), sets, dims, origin,
                 np.array([RAYS, SUN_RAYS, SUN_SPREAD, REACH, cell, OPEN_AIR, 3, PASSES, SMOOTHING],
                          np.float64)):
        key.update(np.ascontiguousarray(part).tobytes())
    key = key.hexdigest()
    cache = os.path.join(ROOT, 'target', 'light', f'{name}.npz')
    traced = None
    if os.path.exists(cache):
        held = np.load(cache)
        if str(held['key']) == key:
            traced = {k: held[k].astype(np.float32) for k in held.files if k != 'key'}
            print('   traced before; adding up only', file=sys.stderr)
    if traced is None:
        traced = trace(name, triangles, normals, albedo, sky_rays, sun.astype(np.float32), sun_rays,
                       dims, origin, cell, sets)
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        # Half precision: three significant figures is more than a byte holds.
        np.savez(cache, key=key, **{k: v.astype(np.float16) for k, v in traced.items()})

    # Added up at the strengths the client lights with.
    spec = skies.get(name, skies.get('facility'))
    colour = srgb_to_linear(np.array([(spec['colour'] >> 16) & 255, (spec['colour'] >> 8) & 255,
                                      spec['colour'] & 255]) / 255.0)
    sun_scale = spec['sun'] * colour
    a = traced['a_sun'] * sun_scale + traced['a_sky'] * spec['sky']
    b = traced['b_sun'] * sun_scale[:, None] + traced['b_sky'] * spec['sky']
    a_lum = a @ LUMINANCE
    lean = np.einsum('c,kca->ka', LUMINANCE, b) / np.maximum(a_lum, 1e-6)[:, None]
    # Never more than a light from one direction leans: 2.
    size = np.linalg.norm(lean, axis=1)
    lean *= np.minimum(1.0, 2.0 / np.maximum(size, 1e-6))[:, None]
    brightest = float(a.max())
    # What open ground gets from the sky: the cells near the ground that see
    # most of it, and what they get facing up.
    up = a + b[:, :, 1]
    near_ground = np.zeros(len(a), dtype=bool)
    ys = (np.arange(len(a)) // dims[0]) % dims[1]
    near_ground[(origin[1] + (ys + 0.5) * cell > 0.5) & (origin[1] + (ys + 0.5) * cell < 2.5)] = True
    open_ground = near_ground & (traced['open'] > 0.45)
    floor = FLOOR * np.median(up[open_ground] if open_ground.any() else up, axis=0)

    count = len(a)

    def coarse(x):
        """A byte that takes only thirty-three values: a 32nd is finer than
        the eye reads in which way light leans or how open a place is, once
        the texture is filtered, and a field of fewer values packs a third
        smaller. Half and the ends are among them."""
        return np.round(np.round(np.clip(x, 0, 1) * 32) / 32 * 255)

    block_a = np.zeros((count, 4), dtype=np.uint8)
    block_a[:, :3] = np.round(np.sqrt(np.clip(a / brightest, 0, 1)) * 255)
    block_a[:, 3] = coarse(traced['sunlit'])
    block_b = np.zeros((count, 4), dtype=np.uint8)
    block_b[:, :3] = coarse(lean / 4 + 0.5)
    # Half the sphere is ground almost everywhere, so twice the open fraction.
    block_b[:, 3] = coarse(traced['open'] * 2)

    header = struct.pack('<4s3HH3fffffI3ff', b'SLV2', *(int(d) for d in dims), 0, *origin.astype(float),
                         float(cell), brightest, spec['sun'], spec['sky'], spec['colour'], *floor.astype(float),
                         float(floor @ LUMINANCE / FLOOR))
    header += b'\0' * (64 - len(header))
    # Each of the eight bytes a cell as a plane of its own, and each row of
    # a plane as the difference from the cell before: light changes slowly
    # across a map, so most of it is small numbers, which brotli shrinks to
    # three quarters of what the cells side by side came to.
    planes = np.concatenate([block_a, block_b], axis=1).T.reshape(8, dims[2], dims[1], dims[0])
    deltas = planes.copy()
    deltas[..., 1:] = planes[..., 1:] - planes[..., :-1]
    out = os.path.join(ROOT, 'assets', 'light', f'{name}.bin')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'wb') as handle:
        handle.write(header + deltas.astype(np.uint8).tobytes())
    print(f'   -> {os.path.relpath(out, ROOT)}, {os.path.getsize(out) / 1048576:.1f} MB, '
          f'brightest {brightest:.2f}, floor {floor.round(3)}, {time.time() - started:.0f} s', file=sys.stderr)


if __name__ == '__main__':
    tables = client_tables()
    for map_name in (sys.argv[1:] or list(MAPS)):
        if map_name not in MAPS:
            raise SystemExit(f'no map called {map_name}')
        bake(map_name, *tables)
