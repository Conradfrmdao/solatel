#!/usr/bin/env python3
"""Build the facility: Solatel's third map, and the first made from nothing.

    python scripts/build-facility.py
    python scripts/derive-maps.py facility

The arena and the yard are downloads, passed through with a vertex moved only
where `extend-arena.py` had to. This one is authored here, in game metres,
and everything about it that is not in this file is not in the map.

# What it is

A walled industrial works in the middle of open country, after the reference
Conrad sent: silos and tanks at the centre, hangars and warehouses round
them, a village and a wooded ridge to the north with a road tunnel through
the hill, and a river along the south that is crossed at three places - a
road bridge, a dam and a footbridge high over the water. Thirty players, on
320 metres square. Ranges from rooms across a corridor, through yards and
compounds, to the length of the river.

# What it is built from

Two sources, and the difference between them matters to the generator.

* **The structure is boxes**, from the same `Parts` kit `extend-arena.py`
  builds with - walls with doorways, blocks with roofs, flights of stairs -
  plus the pieces a works needs that the arena did not: cylinders for silos
  and tanks, ramps for earth, terraces for hills, trees. All of it goes into
  one mesh, so `derive-brushes.classify` sends it down the structure path and
  voxelises it. Boxes are what the collision is made of anyway, so what a
  player sees is what they climb.
* **The dressing is the yard's**: trucks, cars, shipping containers, barrels,
  crates, sandbags, barriers, a water tower, pallets - picked out of
  `yard.glb` by name, repainted in the palette, and placed as instances.
  Each placement is a node of its own, so the generator judges each one as a
  prop and gives it its own exact box, the way it does in the yard.

# Rules the layout keeps, and why

* **The playable ground is at y = 0.** The generator measures everything a
  player stands among from the floor up (`obstacle_heights` looks for what is
  in the way between 0 and 2 m). Raise the ground and every building on it
  reads as solid from the floor. So hills are terraces standing on the
  ground, not ground that has been lifted.
* **Nothing below y = 0 has collision.** The voxel grid starts at the floor,
  so geometry under it is drawn and never collided with. That is what the
  river is: a cut whose walls are drawn down to the water, which the client
  draws at this map's own water level. The floor over the cut is still there
  - invisible - which is only safe because nobody can reach it: see below.
* **The river cannot be entered.** Flood walls along both banks stand
  `FLOOD_WALL` high, over the 1.13 m a jump clears, and nothing a player could
  climb stands against them. Bridges carry parapets as tall. A player who got
  down into the cut would be standing on the water, and worse, `seal_traps`
  would call the cut a pit and fill it in, turning the river into a walkway.
* **Climbable roofs keep clear of the river.** A roof near the flood wall is a
  diving board over it. `RIVER_CLEAR` is how far away one has to be.
* **Stairs rise under `MAX_RISE`.** From the kit, for the same reason: every
  surface is quantised to a quarter metre and a riser that sits at the limit
  stops being one.
* **Spawns stay out of the compound.** The map's extras carry a rectangle the
  spawn picker leaves alone, so a life starts outside the walls and the fight
  converges on the middle rather than starting in it.
"""
import importlib.util
import json
import math
import os
import random
import re
import struct

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.path.join(ROOT, 'assets', 'maps', 'facility.glb')
YARD = os.path.join(ROOT, 'assets', 'maps', 'yard.glb')


def load(name, filename):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(ROOT, 'scripts', filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The arena's authoring kit and palette. Imported rather than copied, so a
# fix to how a flight of stairs is built reaches both maps.
arena = load('extend_arena', 'extend-arena.py')
derive = load('derive_brushes', 'derive-brushes.py')

SKIN = arena.SKIN
DECK = arena.DECK
MAX_RISE = arena.MAX_RISE

# Half the map, in metres. 320 square: the yard is 116 by 252 and seats the
# same thirty, but its middle is one long yard; this has country round a
# works, and country is where a match of thirty spreads out before the circle
# brings it in.
HALF = 160.0

# How high the flood walls stand, and the parapets of everything that crosses
# the river. Over a standing jump (1.13 m) by a margin the quantiser cannot
# eat - it records a surface at the bottom of its cell, so a wall must sit on
# a cell boundary to keep its full height, and 1.4 came out as 1.25 - and
# under the 1.6 m a standing player's eyes are at, so a bank is cover a player
# can shoot over and cannot climb.
FLOOD_WALL = 1.5

# The river: the cut between the flood walls, as z from and to.
RIVER = (106.0, 130.0)

# How far a climbable roof must be from a flood wall. A player running off a
# roof five metres up travels about five metres before landing.
RIVER_CLEAR = 12.0

# Where the client draws the water. Below the ground so the river reads as a
# cut with depth, and the same sea surrounds the map.
WATER_LEVEL = -1.6

# No spawn inside the compound. See the docstring.
COMPOUND = (-56.0, -56.0, 56.0, 52.0)

# The surfaces this map adds to the arena's. Named for what the thing is made
# of, like the arena's, because `world.js` keys its weathering on the name.
# Muted on purpose: warning colours are for small accents only.
NATURE = {
    'grass':          ('#5a6146', 0.96),
    'grass_dry':      ('#6c6a4d', 0.96),
    'dirt':           ('#6a5d4b', 0.97),
    'gravel':         ('#78746c', 0.96),
    'rock':           ('#6c6a64', 0.93),
    'rock_dark':      ('#57554f', 0.93),
    'foliage':        ('#3d4833', 0.92),
    'foliage_dark':   ('#313b2b', 0.92),
    'bark':           ('#4b3f33', 0.92),
    'water':          ('#3b4a50', 0.4),
    'rubber':         ('#2b2b2c', 0.9),
    'container_blue': ('#3e4a55', 0.85),
    'container_grey': ('#666a68', 0.85),
    'container_olive': ('#525a3e', 0.85),
    'car_olive':      ('#4d5336', 0.6),
    'car_white':      ('#a3a199', 0.6),
    'stripe_red':     ('#7a3b33', 0.85),
    'warning':        ('#a4873d', 0.85),
    'solar':          ('#2c3237', 0.55),
    'meadow':         ('#56603f', 0.97),
    'glass':          ('#27323a', 0.06),
    'frame':          ('#c9c5bb', 0.6),
    'frame_dark':     ('#34373a', 0.5),
    'roof_tiles':     ('#7d4c3b', 0.85),
    'cladding':       ('#6f766b', 0.6),
    'cladding_cream': ('#a8a391', 0.6),
    'cladding_blue':  ('#5d6b76', 0.55),
    'steel_stair':    ('#7d7b74', 0.8),
    'shore':          ('#6d6250', 0.97),
}
PALETTE = dict(arena.PALETTE, **NATURE)

# The trees `nature.js` knows how to grow, by the number the file carries.
TREE_KINDS = ('pine', 'spruce', 'broadleaf', 'pine_far', 'spruce_far', 'broadleaf_far')

# How far the country round the map runs, in metres from the middle. Past
# about 470 m the fog has it all, so there is nothing to gain beyond.
COUNTRY = 440.0


def tree_kind(x, z, broadleaf):
    """Which kind of tree stands here, from where it stands.

    A hash of the position rather than a draw from the layout's random
    stream: every draw from that stream moves everything placed after it,
    and a change to which trees are oaks should not move a crate.
    """
    h = math.sin(x * 12.9898 + z * 78.233) * 43758.5453
    u = h - math.floor(h)
    if u < broadleaf:
        return 2
    return 0 if (u * 7.0) % 1.0 < 0.3 else 1


# --- writing the file --------------------------------------------------------

class Glb:
    """A glTF binary built up mesh by mesh.

    Indices are 16-bit wherever a primitive has fewer than 65,536 vertices,
    which is nearly always: they are a third of what the file weighs and every
    player downloads it.
    """

    def __init__(self):
        self.js = {
            'asset': {'version': '2.0', 'generator': 'scripts/build-facility.py'},
            'scene': 0,
            'scenes': [{'name': 'facility', 'nodes': []}],
            'nodes': [], 'meshes': [], 'materials': [], 'accessors': [],
            'bufferViews': [], 'buffers': [{'byteLength': 0}],
        }
        self.blob = bytearray()
        self.surfaces = {}

    def material(self, surface):
        if surface not in self.surfaces:
            colour, roughness = PALETTE[surface]
            self.js['materials'].append({
                'name': surface,
                'pbrMetallicRoughness': {
                    'baseColorFactor': arena.linear(colour) + [1.0],
                    'metallicFactor': 0.0,
                    'roughnessFactor': roughness,
                },
                'doubleSided': True,
            })
            self.surfaces[surface] = len(self.js['materials']) - 1
        return self.surfaces[surface]

    def _view(self, data, target):
        while len(self.blob) % 4:
            self.blob.append(0)
        self.js['bufferViews'].append({
            'buffer': 0, 'byteOffset': len(self.blob),
            'byteLength': int(data.nbytes), 'target': target,
        })
        self.blob.extend(data.tobytes())
        return len(self.js['bufferViews']) - 1

    def _primitive(self, surface, verts, faces):
        verts = np.ascontiguousarray(verts, dtype=np.float32)
        self.js['accessors'].append({
            'bufferView': self._view(verts, 34962), 'componentType': 5126,
            'count': len(verts), 'type': 'VEC3',
            'min': verts.min(0).tolist(), 'max': verts.max(0).tolist(),
        })
        position = len(self.js['accessors']) - 1
        wide = len(verts) > 65535
        flat = np.ascontiguousarray(
            faces.reshape(-1), dtype=np.uint32 if wide else np.uint16)
        self.js['accessors'].append({
            'bufferView': self._view(flat, 34963),
            'componentType': 5125 if wide else 5123,
            'count': len(flat), 'type': 'SCALAR',
        })
        return {'attributes': {'POSITION': position},
                'indices': len(self.js['accessors']) - 1,
                'material': self.material(surface)}

    def mesh(self, name, pieces):
        """One mesh from `(surface, verts, faces)` pieces, split into
        primitives small enough for 16-bit indices."""
        primitives = []
        for surface, verts, faces in pieces:
            verts = np.asarray(verts, dtype=np.float32)
            faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
            if len(verts) <= 65535:
                primitives.append(self._primitive(surface, verts, faces))
                continue
            # Too many for one primitive: cut it into runs of whole
            # triangles, each carrying only the vertices it uses.
            start = 0
            while start < len(faces):
                end = start
                used = {}
                while end < len(faces) and len(used) + 3 <= 65535:
                    for v in faces[end]:
                        used.setdefault(int(v), len(used))
                    end += 1
                order = np.fromiter(used.keys(), dtype=np.int64)
                remap = np.full(len(verts), -1, dtype=np.int64)
                remap[order] = np.arange(len(order))
                primitives.append(self._primitive(
                    surface, verts[order], remap[faces[start:end]]))
                start = end
        self.js['meshes'].append({'name': name, 'primitives': primitives})
        return len(self.js['meshes']) - 1

    def node(self, name, mesh, translation=None, yaw=0.0, scale=None,
             extras=None):
        node = {'name': name, 'mesh': mesh}
        if translation is not None:
            node['translation'] = [round(float(v), 4) for v in translation]
        if yaw:
            node['rotation'] = [0.0, round(math.sin(yaw / 2.0), 6), 0.0,
                                round(math.cos(yaw / 2.0), 6)]
        if scale is not None:
            node['scale'] = [round(float(v), 4) for v in scale]
        if extras:
            node['extras'] = extras
        self.js['nodes'].append(node)
        self.js['scenes'][0]['nodes'].append(len(self.js['nodes']) - 1)
        return len(self.js['nodes']) - 1

    def write(self, path):
        self.js['buffers'][0]['byteLength'] = len(self.blob)
        return arena.write_glb(self.js, bytes(self.blob), path)


# --- the kit, extended --------------------------------------------------------

# The longest a face may be against its other side before it is cut up. See
# `Kit.box`.
FACE_ASPECT = 3.0


class Kit(arena.Parts):
    """The arena's `Parts`, with what open country and a works need."""

    def __init__(self):
        super().__init__()
        # What stands on the ground, as (x0, z0, x1, z1, bottom, top), and
        # every flat face by surface, as (x0, z0, x1, z1, y): together they
        # are how `ground_map` knows where grass grows.
        self.footprints = []
        self.flats = []
        # Trees are data, not boxes: the client draws them. See `tree`.
        self.trees = []
        self.hidden = None

    def box(self, x0, y0, z0, x1, y1, z1, material=arena.STAIR):
        """A box, cut into pieces so no face of it is long and thin.

        This is not about how it looks. `voxelise` samples a triangle a
        number of times set by its *area*, so a long thin face - the side
        of a 320 m flood wall, 1.4 m high - gets its samples spread along
        its length a metre and a half apart, and comes out of the voxel grid
        as a comb. The first build of this map had flood walls with 146
        gaps a player could walk through into the river, and a pipe-rack
        walkway with holes in it.

        So every face whose two sides are both more than half a metre is
        kept to `FACE_ASPECT`: a box is cut along an axis until the faces
        running along it are no more than three times as long as they are
        wide. Faces thinner than that are left alone, because the big faces
        beside them already mark every cell they would.
        """
        self.footprints.append((x0, z0, x1, z1, y0, y1))
        dims = [x1 - x0, y1 - y0, z1 - z0]
        cuts = [1, 1, 1]
        for i, j in ((0, 1), (2, 1), (0, 2), (1, 0), (1, 2)):
            a, b = dims[i], dims[j]
            if min(a, b) < 0.5:
                continue
            if a > FACE_ASPECT * b:
                cuts[i] = max(cuts[i], int(math.ceil(a / (FACE_ASPECT * b))))
        xs = np.linspace(x0, x1, cuts[0] + 1)
        ys = np.linspace(y0, y1, cuts[1] + 1)
        zs = np.linspace(z0, z1, cuts[2] + 1)
        for a, b in zip(xs, xs[1:]):
            for c, d in zip(ys, ys[1:]):
                for e, f in zip(zs, zs[1:]):
                    super().box(a, c, e, b, d, f, material)
        return self

    def flight(self, axis, start, end, cross0, cross1, y_from, y_to,
               material=arena.STAIR, rail=False):
        """The kit's flight of stairs, each tread built as slices.

        The same treads as `Parts.flight` - the same count, rise and depth,
        solid from below the ground to the tread - but each one is made of
        slices a cell deep along the run. A tread half a metre deep is about
        two cells, and the cell wholly inside it has no face in it but the
        tread's top. Above chest height that column reads to the generator
        as open floor with a slab hovering over it; its flood settles there
        at ground level and cannot climb out, so everything above is cut
        off, and the wall-smoothing then pulls the stranded treads into a
        metre-high step. A face in every cell is what keeps the stair a
        stair. Treads are never cut the other way: a face across a tread is
        a second surface in the one column, which is its own trouble.
        """
        run = abs(end - start)
        rise = y_to - y_from
        count = max(int(round(run / arena.STEP_RUN)), 1)
        each = rise / count
        if each > MAX_RISE:
            raise ValueError(
                f'{run:.2f} m of run for {rise:.2f} m of rise needs steps of '
                f'{each:.2f} m, over the {MAX_RISE:.2f} m a player climbs')
        sign = 1.0 if end > start else -1.0
        tread = run / count
        base = y_from - DECK
        for i in range(count):
            near = start + sign * i * tread
            far = start + sign * (i + 1) * tread
            lo, hi = (near, far) if sign > 0 else (far, near)
            self._sliced(axis, lo, hi, cross0, cross1, base, y_from + each * (i + 1), material)
        self.log.append(
            f'    {count} steps of {each:.2f} m rise and {tread:.2f} m tread, '
            f'{y_from:.2f} to {y_to:.2f} m over {run:.2f} m')
        return self

    def _sliced(self, axis, lo, hi, cross0, cross1, bottom, top, material):
        """One tread or step, as slices at most a cell deep along `axis`."""
        pieces = max(int(math.ceil((hi - lo) / 0.25 - 1e-6)), 1)
        edges = np.linspace(lo, hi, pieces + 1)
        if axis == 'x':
            self.footprints.append((lo, cross0, hi, cross1, bottom, top))
        else:
            self.footprints.append((cross0, lo, cross1, hi, bottom, top))
        for a, b in zip(edges, edges[1:]):
            if axis == 'x':
                arena.Parts.box(self, a, bottom, cross0, b, top, cross1, material)
            else:
                arena.Parts.box(self, cross0, bottom, a, cross1, top, b, material)

    def quad(self, x0, z0, x1, z1, y, material):
        """A flat face looking up: ground, paint, a pad."""
        self.flats.append((material, min(x0, x1), min(z0, z1), max(x0, x1), max(z0, z1), y))
        verts, faces = self.groups.setdefault(material, ([], []))
        base = len(verts)
        verts.extend([(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)])
        faces.extend([(base, base + 2, base + 1), (base, base + 3, base + 2)])
        return self

    def poly(self, points, material):
        """A flat polygon, fanned from its first corner: roof planes, gables."""
        verts, faces = self.groups.setdefault(material, ([], []))
        base = len(verts)
        verts.extend(tuple(float(v) for v in p) for p in points)
        for i in range(1, len(points) - 1):
            faces.append((base, base + i, base + i + 1))
        return self

    def ground(self, x0, z0, x1, z1, y, material, tile=16.0):
        """A large flat face, cut into tiles.

        Not as a single quad. `voxelise` samples a triangle at most 600 times
        a side, so one quad across a whole map is sampled every half metre
        against cells of a quarter, and comes out as a lattice with holes in
        it - which `outside_the_art` then reads as the edge of the world.
        """
        xs = np.arange(x0, x1, tile).tolist() + [x1]
        zs = np.arange(z0, z1, tile).tolist() + [z1]
        for a, b in zip(xs, xs[1:]):
            for c, d in zip(zs, zs[1:]):
                if b - a > 1e-3 and d - c > 1e-3:
                    self.quad(a, c, b, d, y, material)
        return self

    def cylinder(self, cx, cz, radius, y0, y1, material, segments=20,
                 top=True, top_material=None):
        self.footprints.append((cx - radius, cz - radius, cx + radius, cz + radius, y0, y1))
        verts, faces = self.groups.setdefault(material, ([], []))
        # In rings, for the same reason `box` cuts long faces: a side panel
        # eighteen metres tall and a metre and a half wide would be sampled
        # a few times up its height and come out as a ladder of slabs.
        width = 2.0 * math.pi * radius / segments
        rings = max(int(math.ceil((y1 - y0) / (FACE_ASPECT * width))), 1)
        heights = np.linspace(y0, y1, rings + 1)
        for lo, hi in zip(heights, heights[1:]):
            base = len(verts)
            for i in range(segments):
                angle = 2.0 * math.pi * i / segments
                x = cx + radius * math.cos(angle)
                z = cz + radius * math.sin(angle)
                verts.extend([(x, lo, z), (x, hi, z)])
            for i in range(segments):
                j = (i + 1) % segments
                a, b = base + 2 * i, base + 2 * j
                faces.extend([(a, b, b + 1), (a, b + 1, a + 1)])
        if top:
            # A fan from the middle is triangles as long as the radius and a
            # side wide - thin, so sampled sparsely. Concentric rings keep
            # each piece closer to square.
            tv, tf = self.groups.setdefault(top_material or material, ([], []))
            bands = max(int(math.ceil(radius / (FACE_ASPECT * width) * 2.0)), 1)
            radii = np.linspace(0.0, radius, bands + 1)
            centre = len(tv)
            tv.append((cx, y1, cz))
            previous = None
            for r in radii[1:]:
                ring = len(tv)
                for i in range(segments):
                    angle = 2.0 * math.pi * i / segments
                    tv.append((cx + r * math.cos(angle), y1, cz + r * math.sin(angle)))
                for i in range(segments):
                    j = (i + 1) % segments
                    if previous is None:
                        tf.append((centre, ring + j, ring + i))
                    else:
                        tf.append((previous + i, ring + j, ring + i))
                        tf.append((previous + i, previous + j, ring + j))
                previous = ring
        return self

    def ramp(self, axis, start, end, cross0, cross1, y_from, y_to,
             material='dirt', rise=0.25):
        """Earth or concrete rising from one level to another in low steps.

        The collision has no slopes - it is boxes - so a ramp is a flight
        whose risers are small enough to walk up without noticing: a
        quarter of a metre, which is one cell of the grid and so cannot be
        rounded into anything taller. Each step is solid from the ground,
        which is what an embankment is.
        """
        run = abs(end - start)
        count = max(int(math.ceil((y_to - y_from) / rise - 1e-6)), 1)
        each = (y_to - y_from) / count
        tread = run / count
        sign = 1.0 if end > start else -1.0
        for i in range(count):
            near = start + sign * i * tread
            far = start + sign * (i + 1) * tread
            lo, hi = (near, far) if sign > 0 else (far, near)
            top = y_from + each * (i + 1)
            self._sliced(axis, lo, hi, cross0, cross1, 0.0, top, material)
        return self

    def mesa(self, x0, z0, x1, z1, top, side='rock', cap='grass', bottom=0.0):
        """A block of ground standing proud: rock sides, a grassed top."""
        self.box(x0, bottom, z0, x1, top, z1, side)
        self.quad(x0, z0, x1, z1, top + SKIN, cap)
        return self

    def tree(self, x, z, y=0.0, height=7.5, kind=0):
        """A tree: a trunk to collide with, and the rest for the client.

        A tree built of boxes looks like one built of boxes, whatever is done
        to the boxes. So the file carries where each tree stands, how tall it
        is and what kind (`TREE_KINDS`), and `nature.js` grows it - a tapered
        trunk, branches, leaves that move in the wind.

        What collides is the trunk alone, as a box in the hidden collision
        node: solid up to where the branches start, so it stops a player and
        a bullet the way a trunk does. The canopy does not collide. Leaves
        stop sight and not bullets, as they do in every shooter, and nobody
        can stand in a tree.
        """
        self.trees.append((x, y, z, height, kind))
        self.footprints.append((x - 0.3, z - 0.3, x + 0.3, z + 0.3, y, y + height))
        half = 0.2 if kind == 2 else 0.17
        self.hidden.box(x - half, y, z - half, x + half, y + height * 0.55, z + half, 'bark')
        return self

    def guarded_flight(self, axis, start, end, cross0, cross1, y_from, y_to,
                       material='concrete_dark', wall='concrete', t=0.3):
        """A flight with a wall either side, stepped up with it.

        For stairs near the river. Every point of an open flight is a place
        to jump from, and from four metres up a running jump clears a flood
        wall a dozen metres away. The walls stand `FLOOD_WALL` over each
        tread, so nobody climbs them from the stair or from the ground.
        """
        self.flight(axis, start, end, cross0, cross1, y_from, y_to, material)
        run = abs(end - start)
        count = max(int(round(run / arena.STEP_RUN)), 1)
        each = (y_to - y_from) / count
        tread = run / count
        sign = 1.0 if end > start else -1.0
        for i in range(count):
            near = start + sign * i * tread
            far = start + sign * (i + 1) * tread
            lo, hi = (near, far) if sign > 0 else (far, near)
            top = y_from + each * (i + 1) + FLOOD_WALL
            for c0, c1 in ((cross0 - t, cross0), (cross1, cross1 + t)):
                self._sliced(axis, lo, hi, c0, c1, 0.0, top, wall)
        return self

    def rocks(self, x, z, size, rng):
        """An outcrop: a few boxes of rock of different heights, overlapping.

        Natural cover for open ground, and none of it climbable: the lowest
        block is over a standing jump, so an outcrop is something to get
        behind rather than something to stand on.
        """
        for _ in range(3):
            w = rng.uniform(0.5, 1.0) * size
            d = rng.uniform(0.5, 1.0) * size
            h = rng.uniform(1.4, 2.6) * (0.6 + size / 8.0)
            ox = rng.uniform(-0.4, 0.4) * size
            oz = rng.uniform(-0.4, 0.4) * size
            self.box(x + ox - w / 2, 0.0, z + oz - d / 2, x + ox + w / 2, h, z + oz + d / 2,
                     rng.choice(('rock', 'rock_dark')))
        return self


# --- the yard's props ------------------------------------------------------

class YardProps:
    """Pieces of the yard, repainted and ready to place.

    Each is taken from one named node of `yard.glb`, in world space, moved so
    its footprint is centred on the origin and it stands on y = 0, and turned
    so its longest side runs along x. Placing it is then a position and a
    heading, and every placement shares the one copy of its triangles.
    """

    def __init__(self, glb):
        self.glb = glb
        self.js, self.blob = derive.read_glb(YARD)
        nodes = self.js['nodes']
        self.world = {}

        def walk(index, parent):
            self.world[index] = parent @ derive.node_matrix(nodes[index])
            for child in nodes[index].get('children', []):
                walk(child, self.world[index])

        for root in self.js['scenes'][self.js.get('scene', 0)]['nodes']:
            walk(root, np.eye(4))
        self.by_name = {n.get('name'): i for i, n in enumerate(nodes)}
        self.meshes = {}
        self.raw = {}
        self.scales = {}
        self.placed = 0
        self.footprints = []

    # The yard's ten flat colours: 0 plane, 1 yellow, 2 white, 3 dark,
    # 4 blue, 5 red, 6 wood, 7 dark, 8 orange, 9 mid grey.
    def define(self, key, node_name, paint, align=True, scale=(1.0, 1.0, 1.0)):
        """Take one node of the yard as a prop, painted by `paint`.

        `paint` maps the yard's material index to one of this map's surfaces.
        Every index the node uses must be named: a colour carried over from
        the yard by default is exactly how a bright red truck ends up in a
        map that was meant to be muted.
        """
        index = self.by_name[node_name]
        node = self.js['nodes'][index]
        pieces = []
        for prim in self.js['meshes'][node['mesh']]['primitives']:
            points = derive.accessor(self.js, self.blob, prim['attributes']['POSITION'])
            homogeneous = np.hstack([points, np.ones((len(points), 1))])
            verts = (self.world[index] @ homogeneous.T).T[:, :3]
            faces = derive.accessor(self.js, self.blob, prim['indices']).astype(np.int64)
            material = prim.get('material', 0)
            if material not in paint:
                raise SystemExit(f'{node_name}: no surface for yard material {material}')
            pieces.append([paint[material], verts, faces.reshape(-1, 3)])

        every = np.vstack([p[1] for p in pieces])
        if align:
            # The longest horizontal direction onto +x, from the spread of the
            # vertices rather than the box, which is rotated with the prop.
            flat = every[:, [0, 2]] - every[:, [0, 2]].mean(0)
            _, vectors = np.linalg.eigh(flat.T @ flat)
            major = vectors[:, -1]
            angle = math.atan2(major[1], major[0])
            c, s = math.cos(-angle), math.sin(-angle)
            turn = np.array([[c, 0.0, -s], [0.0, 1.0, 0.0], [s, 0.0, c]])
            for piece in pieces:
                piece[1] = piece[1] @ turn.T
            every = np.vstack([p[1] for p in pieces])
        low, high = every.min(0), every.max(0)
        centre = np.array([(low[0] + high[0]) / 2.0, low[1], (low[2] + high[2]) / 2.0])
        for piece in pieces:
            piece[1] = piece[1] - centre
        self.raw[key] = high - low
        self.scales[key] = np.asarray(scale, dtype=float)
        self.meshes[key] = self.glb.mesh(f'yard_{key}', [tuple(p) for p in pieces])
        return self.size(key)

    def alias(self, key, like, scale):
        """The same triangles as `like`, placed at another size."""
        self.raw[key] = self.raw[like]
        self.meshes[key] = self.meshes[like]
        self.scales[key] = np.asarray(scale, dtype=float)

    def size(self, key):
        """How big a placement of `key` is, in metres."""
        return self.raw[key] * self.scales[key]

    def place(self, key, x, z, yaw=0.0, y=0.0):
        self.placed += 1
        scale = self.scales[key]
        sx, sy, sz = self.size(key)
        reach = 0.5 * (abs(sx * math.cos(yaw)) + abs(sz * math.sin(yaw)))
        across = 0.5 * (abs(sx * math.sin(yaw)) + abs(sz * math.cos(yaw)))
        self.footprints.append((x - reach, z - across, x + reach, z + across, y, y + sy))
        return self.glb.node(f'{key}.{self.placed:03d}', self.meshes[key],
                             translation=(x, y, z), yaw=yaw,
                             scale=None if np.allclose(scale, 1.0) else scale)


def paint_all(surface):
    return {i: surface for i in range(10)}


def define_props(props):
    """The yard's pieces this map uses, what each is painted, and how big.

    The yard's props are drawn chunky - its car is nine metres long, its
    crates two metres a side - which reads as toys next to a player 1.8 m
    tall. Each is scaled here to the size of the real thing, and the scale
    goes on the placement, so the collision is taken from the same size.
    """
    rust_truck = {5: 'container_rust', 2: 'car_white', 3: 'rubber', 7: 'rubber',
                  9: 'steel', 6: 'wood', 1: 'warning', 4: 'car_blue', 8: 'car_olive',
                  0: 'rubber'}
    olive_truck = {**rust_truck, 5: 'car_olive'}
    grey_truck = {**rust_truck, 5: 'container_grey'}
    truck = (0.72, 0.78, 0.6)                       # about 7.8 x 3.4 x 2.7 m
    props.define('truck', 'Cube.036', rust_truck, scale=truck)
    props.define('truck_olive', 'Cube.036', olive_truck, scale=truck)
    props.define('truck_grey', 'Cube.051', grey_truck, scale=truck)
    car = (0.5, 0.56, 0.44)                         # about 4.6 x 1.5 x 1.9 m
    for key, colour in (('car', 'car_red'), ('car_blue', 'car_blue'),
                        ('car_olive', 'car_olive')):
        props.define(key, 'CAR.002', paint_all(colour) | {3: 'rubber', 7: 'rubber'},
                     scale=car)
    # Twenty and forty foot boxes from the one container.
    twenty = (0.69, 0.61, 0.58)                     # 6.0 x 2.6 x 2.45 m
    forty = (1.39, 0.61, 0.58)                      # 12.1 x 2.6 x 2.45 m
    for key, colour in (('container', 'container_rust'),
                        ('container_blue', 'container_blue'),
                        ('container_olive', 'container_olive'),
                        ('container_grey', 'container_grey')):
        props.define(key, 'Big_Container_Long.002',
                     {4: colour, 3: 'steel', 5: colour, 8: colour}, scale=twenty)
        props.alias(key.replace('container', 'long'), key, forty)
    props.define('barrel', 'Wood.001', {2: 'barrel_olive', 5: 'barrel_rust'}, scale=(0.45,) * 3)
    props.define('barrel_blue', 'Wood.001', {2: 'steel', 5: 'barrel_blue'}, scale=(0.45,) * 3)
    props.define('crate', 'Cube.005', paint_all('wood'), align=False, scale=(0.6,) * 3)
    props.define('crate_dark', 'Cube.184', paint_all('crate_olive'), align=False, scale=(0.6,) * 3)
    props.define('sandbags', 'Cube.369', paint_all('sandbag'), scale=(0.8, 0.58, 0.8))
    props.define('sandbags_short', 'Cube.211', paint_all('sandbag'), scale=(0.9, 0.48, 0.8))
    props.define('barrier', 'Concrete_Barrier_Cube.002', paint_all('concrete_light'),
                 scale=(1.0, 0.56, 0.55))
    props.define('roadblock', 'TrafficBarrier_01_Cube.001',
                 {2: 'concrete_light', 3: 'steel', 5: 'stripe_red'}, scale=(1.0, 0.62, 0.5))
    props.define('pallet', 'Pallet.001', {3: 'steel', 7: 'steel', 8: 'wood_pallet'},
                 scale=(0.5,) * 3)
    props.define('sawhorse', 'tent.001', paint_all('wood'), scale=(0.33,) * 3)
    props.define('water_tower', 'tower.001', {2: 'steel', 5: 'tank_white'}, align=False,
                 scale=(0.85,) * 3)


# --- the map ---------------------------------------------------------------

class Layout:
    """Everything that decides where things go, and the rules they obey."""

    def __init__(self, kit, props, seed=7):
        self.kit = kit
        self.props = props
        self.unit = {}
        self.random = random.Random(seed)
        # Places trees and scattered dressing must stay out of: roads,
        # ramps, doorways, the river. (x0, z0, x1, z1), padded when tested.
        self.clear = []
        self.roofs = []  # climbable roof rectangles, for the river check
        # Trim drawn and never collided with: windows, frames, cladding,
        # vents. Everything in it is flush with a wall or out of reach.
        self.detail = Kit()
        # Where smoke rises, for the client to draw.
        self.smoke = []
        # The share of broadleaf trees in the next forest: villages and
        # fields have oaks, the hills are pine and spruce.
        self.broadleaf = 0.35

    def keep_clear(self, x0, z0, x1, z1):
        self.clear.append((min(x0, x1), min(z0, z1), max(x0, x1), max(z0, z1)))

    def is_clear(self, x, z, pad=0.0):
        for x0, z0, x1, z1 in self.clear:
            if x0 - pad <= x <= x1 + pad and z0 - pad <= z <= z1 + pad:
                return False
        return True

    def solid(self, x0, y0, z0, x1, y1, z1, material):
        """A box that is its own node, so the generator gives it its own box.

        For anything that stands on the floor *under a roof* and reaches
        above chest height: racks, machinery. As part of the structure mesh
        such a thing is solid from the floor to the highest surface over it
        - `obstacle_heights` extends anything that fills a player's height
        up to the top of its column, and under a roof the top is the roof -
        so a shelf becomes an invisible wall to the ceiling that bullets
        cannot pass over. A node of its own is judged as a prop instead and
        collides as exactly the box it is.

        One unit cube per surface, placed with a scale, so a hundred racks
        are a hundred nodes and one set of triangles.
        """
        if material not in self.unit:
            cube = arena.Parts()
            cube.box(0.0, 0.0, 0.0, 1.0, 1.0, 1.0, material)
            verts, faces = cube.groups[material]
            self.unit[material] = self.props.glb.mesh(
                f'unit_{material}', [(material, verts, faces)])
        self.props.placed += 1
        self.props.footprints.append((x0, z0, x1, z1, y0, y1))
        self.props.glb.node(f'{material}.{self.props.placed:03d}', self.unit[material],
                            translation=(x0, y0, z0),
                            scale=(x1 - x0, y1 - y0, z1 - z0))

    def roof(self, x0, z0, x1, z1, top, holes=(), material='roof_metal'):
        """A roof deck, with openings left where stairs rise beneath it.

        A stair under a roof has the same trouble as a shelf: each tread
        above chest height is extended to the roof and the flight becomes a
        wall. A stairwell open to the sky is what keeps it a stair.
        """
        xs = sorted({x0, x1} | {v for h in holes for v in (h[0], h[2])})
        zs = sorted({z0, z1} | {v for h in holes for v in (h[1], h[3])})
        for a, b in zip(xs, xs[1:]):
            for c, d in zip(zs, zs[1:]):
                mx, mz = (a + b) / 2, (c + d) / 2
                if any(h[0] <= mx <= h[2] and h[1] <= mz <= h[3] for h in holes):
                    continue
                self.kit.deck(a, c, b, d, top, material=material)

    # -- building blocks with the map's rules attached ------------------------

    def road(self, x0, z0, x1, z1, material='asphalt'):
        # Each road a centimetre above the last, so two that cross are never
        # two faces at one depth. All of them well inside the bottom row of
        # the grid, where nothing is collided with.
        self.roads = getattr(self, 'roads', 0) + 1
        y = 0.03 + 0.01 * (self.roads % 16)
        self.kit.quad(min(x0, x1), min(z0, z1), max(x0, x1), max(z0, z1), y, material)
        self.keep_clear(x0, z0, x1, z1)

    def pad(self, x0, z0, x1, z1, material='concrete_dark', y=0.05):
        self.kit.quad(x0, z0, x1, z1, y, material)
        self.keep_clear(x0, z0, x1, z1)

    # -- what makes a box a building ---------------------------------------

    def _on_wall(self, side, x0, z0, x1, z1, t, a, b, y0, y1, out0, out1, material,
                 faces=(0, 1)):
        """A box on the faces of a wall: `a..b` along it, `out0..out1` metres
        out from the face, on the outside (0) and the inside (1)."""
        d = self.detail
        for face in faces:
            if side == 'z0':
                lo, hi = (z0 - out1, z0 - out0) if face == 0 else (z0 + t + out0, z0 + t + out1)
                d.box(a, y0, lo, b, y1, hi, material)
            elif side == 'z1':
                lo, hi = (z1 + out0, z1 + out1) if face == 0 else (z1 - t - out1, z1 - t - out0)
                d.box(a, y0, lo, b, y1, hi, material)
            elif side == 'x0':
                lo, hi = (x0 - out1, x0 - out0) if face == 0 else (x0 + t + out0, x0 + t + out1)
                d.box(lo, y0, a, hi, y1, b, material)
            else:
                lo, hi = (x1 + out0, x1 + out1) if face == 0 else (x1 - t - out1, x1 - t - out0)
                d.box(lo, y0, a, hi, y1, b, material)

    def window(self, side, x0, z0, x1, z1, t, centre, sill, width, height, frame='frame'):
        """A window, outside and in: glass, a frame round it, a sill."""
        a, b = centre - width / 2.0, centre + width / 2.0
        w = self._on_wall
        w(side, x0, z0, x1, z1, t, a, b, sill, sill + height, 0.004, 0.018, 'glass')
        for fa, fb in ((a - 0.07, a), (b, b + 0.07)):
            w(side, x0, z0, x1, z1, t, fa, fb, sill - 0.07, sill + height + 0.07, 0.0, 0.05, frame)
        w(side, x0, z0, x1, z1, t, a, b, sill + height, sill + height + 0.07, 0.0, 0.05, frame)
        w(side, x0, z0, x1, z1, t, a - 0.1, b + 0.1, sill - 0.09, sill, 0.0, 0.13, 'concrete_light')
        # A glazing bar across the middle.
        w(side, x0, z0, x1, z1, t, (a + b) / 2 - 0.025, (a + b) / 2 + 0.025, sill, sill + height,
          0.0, 0.03, frame)

    def windows(self, x0, z0, x1, z1, t, doors, rows, spacing=3.2, width=1.2, height=1.3,
                frame='frame', sides=('z0', 'z1', 'x0', 'x1')):
        """Windows along every wall, clear of the doors and the corners."""
        d = dict(doors)
        for side in sides:
            lo, hi = (x0, x1) if side in ('z0', 'z1') else (z0, z1)
            length = hi - lo
            count = int((length - 1.6) // spacing)
            if count < 1:
                continue
            start = lo + (length - (count - 1) * spacing) / 2.0
            for k in range(count):
                c = start + k * spacing
                if any(ga - 0.9 < c + width / 2 and c - width / 2 < gb + 0.9
                       for ga, gb in d.get(side, ())):
                    continue
                for sill in rows:
                    self.window(side, x0, z0, x1, z1, t, c, sill, width, height, frame)

    def door_frames(self, x0, z0, x1, z1, t, doors, head=2.6, material='frame_dark'):
        for side, gaps in dict(doors).items():
            for a, b in gaps:
                w = self._on_wall
                for fa, fb in ((a - 0.12, a), (b, b + 0.12)):
                    w(side, x0, z0, x1, z1, t, fa, fb, 0.0, head + 0.12, 0.0, 0.06, material)
                w(side, x0, z0, x1, z1, t, a - 0.12, b + 0.12, head, head + 0.12, 0.0, 0.06, material)

    def pitched_roof(self, x0, z0, x1, z1, eave, pitch, material, gable, overhang=0.45,
                     solid=True, chimney=False):
        """A gable roof over a rectangle, ridge along its long side.

        In the collision (`solid`) wherever it can be: a roof stops a bullet.
        It stands on the flat deck the block already has, so nothing under it
        changes, and its eaves are out of anybody's reach.
        """
        k = self.kit if solid else self.detail
        along_x = (x1 - x0) >= (z1 - z0)
        if along_x:
            half = (z1 - z0) / 2.0
            mid = (z0 + z1) / 2.0
            ridge = eave + (half + overhang) * math.tan(math.radians(pitch))
            ex0, ex1 = x0 - overhang, x1 + overhang
            k.poly([(ex0, eave, z0 - overhang), (ex1, eave, z0 - overhang), (ex1, ridge, mid), (ex0, ridge, mid)], material)
            k.poly([(ex0, eave, z1 + overhang), (ex0, ridge, mid), (ex1, ridge, mid), (ex1, eave, z1 + overhang)], material)
            gable_top = eave + half * math.tan(math.radians(pitch))
            for x in (x0, x1):
                k.poly([(x, eave, z0), (x, gable_top + (ridge - gable_top) * 0.0, mid), (x, eave, z1)], gable)
            self.detail.box(ex0, ridge - 0.05, mid - 0.14, ex1, ridge + 0.1, mid + 0.14, 'frame_dark')
            if chimney:
                cx = x0 + (x1 - x0) * 0.28
                k.box(cx - 0.35, eave, mid + 0.6, cx + 0.35, ridge + 0.9, mid + 1.3, 'brick')
        else:
            half = (x1 - x0) / 2.0
            mid = (x0 + x1) / 2.0
            ridge = eave + (half + overhang) * math.tan(math.radians(pitch))
            ez0, ez1 = z0 - overhang, z1 + overhang
            k.poly([(x0 - overhang, eave, ez0), (mid, ridge, ez0), (mid, ridge, ez1), (x0 - overhang, eave, ez1)], material)
            k.poly([(x1 + overhang, eave, ez0), (x1 + overhang, eave, ez1), (mid, ridge, ez1), (mid, ridge, ez0)], material)
            gable_top = eave + half * math.tan(math.radians(pitch))
            for z in (z0, z1):
                k.poly([(x0, eave, z), (mid, gable_top, z), (x1, eave, z)], gable)
            self.detail.box(mid - 0.14, ridge - 0.05, ez0, mid + 0.14, ridge + 0.1, ez1, 'frame_dark')
            if chimney:
                cz = z0 + (z1 - z0) * 0.28
                k.box(mid + 0.6, eave, cz - 0.35, mid + 1.3, ridge + 0.9, cz + 0.35, 'brick')

    def house(self, x0, z0, x1, z1, roof, walls, doors, stair=None):
        """A building: walls, doorways, a roof, a floor, and a way up."""
        self.kit.block(x0, z0, x1, z1, roof, doors=doors, material=walls)
        self.kit.quad(x0, z0, x1, z1, 0.06, 'concrete_dark')
        self.keep_clear(x0 - 2.0, z0 - 2.0, x1 + 2.0, z1 + 2.0)
        t = 0.4
        rows = (1.0,) if roof < 5.0 else (1.0, roof - 2.6)
        self.windows(x0, z0, x1, z1, t, doors, rows)
        self.door_frames(x0, z0, x1, z1, t, doors)
        # A darker plinth round the foot of the walls, as every building has.
        for side, (a, b) in (('z0', (x0, x1)), ('z1', (x0, x1)), ('x0', (z0, z1)), ('x1', (z0, z1))):
            gaps = sorted(dict(doors).get(side, ()))
            edges = [a] + [v for g in gaps for v in g] + [b]
            for i in range(0, len(edges) - 1, 2):
                if edges[i + 1] - edges[i] > 0.05:
                    self._on_wall(side, x0, z0, x1, z1, t, edges[i], edges[i + 1], 0.0, 0.45,
                                  0.0, 0.03, 'concrete_dark')
        if not stair:
            timber = walls.startswith('wood')
            industrial = walls.startswith('concrete')
            self.pitched_roof(x0, z0, x1, z1, roof - 0.02, 18.0 if industrial else 32.0,
                              'roof_metal' if industrial or timber else 'roof_tiles', walls,
                              chimney=not industrial and not timber and (x1 - x0) * (z1 - z0) > 90)
        else:
            # A flat roof people walk on: a coping round its edge, drawn.
            for bx0, bz0, bx1, bz1 in ((x0 - 0.06, z0 - 0.06, x1 + 0.06, z0 + 0.25),
                                       (x0 - 0.06, z1 - 0.25, x1 + 0.06, z1 + 0.06),
                                       (x0 - 0.06, z0, x0 + 0.25, z1),
                                       (x1 - 0.25, z0, x1 + 0.06, z1)):
                self.detail.box(bx0, roof - 0.3, bz0, bx1, roof + 0.02, bz1, 'concrete_light')
        if stair:
            self.kit.roof_stair(stair, x0, z0, x1, z1, roof)
            run = roof * 1.2 + 1.0
            if stair == 'x0':
                self.keep_clear(x0 - run, (z0 + z1) / 2 - 2, x0, (z0 + z1) / 2 + 2)
            elif stair == 'x1':
                self.keep_clear(x1, (z0 + z1) / 2 - 2, x1 + run, (z0 + z1) / 2 + 2)
            elif stair == 'z0':
                self.keep_clear((x0 + x1) / 2 - 2, z0 - run, (x0 + x1) / 2 + 2, z0)
            else:
                self.keep_clear((x0 + x1) / 2 - 2, z1, (x0 + x1) / 2 + 2, z1 + run)
            self.roofs.append((x0, z0, x1, z1, roof))

    def warehouse(self, x0, z0, x1, z1, height, doors, walls='concrete',
                  racks=True, mezzanine=None):
        """A big shed: tall walls, wide doors, racks inside for close fights."""
        k = self.kit
        t = 0.5
        head = height - DECK * 0.5
        d = dict(doors)
        k.wall(x0, z0, x1, z0 + t, 0.0, head, d.get('z0', ()), walls, head=5.0)
        k.wall(x0, z1 - t, x1, z1, 0.0, head, d.get('z1', ()), walls, head=5.0)
        k.wall(x0, z0 + t, x0 + t, z1 - t, 0.0, head, d.get('x0', ()), walls, head=5.0)
        k.wall(x1 - t, z0 + t, x1, z1 - t, 0.0, head, d.get('x1', ()), walls, head=5.0)
        holes = []
        if mezzanine:
            side, width = mezzanine
            lane_z = (z0 + t + width, z0 + t + width + 2.2) if side == 'z0' else \
                     (z1 - t - width - 2.2, z1 - t - width)
            holes.append((x0 + 2.5, lane_z[0] - 0.4, x0 + 11.5, lane_z[1] + 0.4))
        self.roof(x0, z0, x1, z1, height, holes)
        k.quad(x0 + t, z0 + t, x1 - t, z1 - t, 0.06, 'concrete_dark')
        self.keep_clear(x0 - 1.5, z0 - 1.5, x1 + 1.5, z1 + 1.5)
        self.shed_detail(x0, z0, x1, z1, height, t, d, walls, open_roof=bool(holes))
        if racks:
            # Rows of shelving across the short side, with aisles between
            # and a clear lane down the middle: corridors a few metres wide,
            # which is what a warehouse fight is.
            long_x = (x1 - x0) >= (z1 - z0)
            if long_x:
                mid = (z0 + z1) / 2.0
                for x in np.arange(x0 + 5.0, x1 - 5.0, 5.0):
                    for a, b in ((z0 + 2.5, mid - 2.0), (mid + 2.0, z1 - 2.5)):
                        if b - a > 2.0 and not (mezzanine and x < x0 + 13.0):
                            self.solid(x, 0.0, a, x + 1.2, 3.6, b, 'steel')
            else:
                mid = (x0 + x1) / 2.0
                for z in np.arange(z0 + 5.0, z1 - 5.0, 5.0):
                    for a, b in ((x0 + 2.5, mid - 2.0), (mid + 2.0, x1 - 2.5)):
                        if b - a > 2.0:
                            self.solid(a, 0.0, z, b, 3.6, z + 1.2, 'steel')
        if mezzanine:
            # A gallery along one wall at 4 m, with a flight up to it.
            side, width = mezzanine
            top = 4.0
            if side == 'z0':
                k.deck(x0 + t, z0 + t, x1 - t, z0 + t + width, top, 'steel')
                k.flight('x', x0 + 3.0, x0 + 3.0 + top * 2.0, z0 + t + width,
                         z0 + t + width + 2.2, 0.0, top - SKIN)
            else:
                k.deck(x0 + t, z1 - t - width, x1 - t, z1 - t, top, 'steel')
                k.flight('x', x0 + 3.0, x0 + 3.0 + top * 2.0, z1 - t - width - 2.2,
                         z1 - t - width, 0.0, top - SKIN)

    def shed_detail(self, x0, z0, x1, z1, height, t, doors, walls, open_roof=False):
        """What makes a big box a warehouse.

        Corrugated cladding over a concrete base, a strip of high windows
        down the long sides, a housing over every door for the shutter it
        rolls up into, a shallow pitched roof with vents on it, downpipes at
        the corners. All drawn only: flush with the walls or out of reach.
        """
        head = height - DECK * 0.5
        base = 1.6
        cladding = {'concrete': 'cladding_cream', 'concrete_dark': 'cladding_blue',
                    'plaster_olive': 'cladding', 'plaster_sand': 'cladding_cream'}.get(walls, 'cladding')
        for side, (a, b) in (('z0', (x0, x1)), ('z1', (x0, x1)), ('x0', (z0, z1)), ('x1', (z0, z1))):
            gaps = sorted(doors.get(side, ()))
            edges = [a] + [v for g in gaps for v in g] + [b]
            for i in range(0, len(edges) - 1, 2):
                if edges[i + 1] - edges[i] > 0.05:
                    self._on_wall(side, x0, z0, x1, z1, t, edges[i], edges[i + 1], base, head,
                                  0.0, 0.035, cladding,
                                  faces=(0,))
                    self._on_wall(side, x0, z0, x1, z1, t, edges[i], edges[i + 1], base - 0.08,
                                  base, 0.0, 0.07, 'frame_dark', faces=(0,))
            for ga, gb in gaps:
                # The shutter housing over the door, and its guides.
                self._on_wall(side, x0, z0, x1, z1, t, ga - 0.15, gb + 0.15, 5.0, 5.7, 0.0, 0.45,
                              'frame_dark', faces=(0,))
                for fa, fb in ((ga - 0.15, ga), (gb, gb + 0.15)):
                    self._on_wall(side, x0, z0, x1, z1, t, fa, fb, 0.0, 5.0, 0.0, 0.12,
                                  'frame_dark', faces=(0,))
        long_sides = ('z0', 'z1') if (x1 - x0) >= (z1 - z0) else ('x0', 'x1')
        self.windows(x0, z0, x1, z1, t, doors, (head - 2.0,), spacing=4.5, width=2.6,
                     height=1.1, frame='frame_dark', sides=long_sides)
        for cx, cz in ((x0, z0), (x1, z0), (x0, z1), (x1, z1)):
            sx = 0.05 if cx == x0 else -0.2
            sz = -0.2 if cz == z0 else 0.05
            self.detail.box(cx + sx - (0.15 if cx == x0 else -0.15), 0.0, cz + sz - (0.15 if cz == z0 else -0.15),
                            cx + sx + 0.15 - (0.15 if cx == x0 else -0.15), head, cz + sz + 0.15 - (0.15 if cz == z0 else -0.15),
                            'frame_dark')
        if not open_roof:
            self.pitched_roof(x0, z0, x1, z1, height, 9.0, 'roof_metal', cladding,
                              overhang=0.35, solid=False)
        rng = random.Random(int(x0 * 7 + z0 * 13))
        for _ in range(3):
            vx = rng.uniform(x0 + 3.0, x1 - 3.0)
            vz = rng.uniform(z0 + 3.0, z1 - 3.0)
            self.detail.cylinder(vx, vz, 0.45, height, height + 1.9 + (0 if open_roof else 1.2), 'steel', segments=10)

    def forest(self, x0, z0, x1, z1, spacing, y=0.0, pad=1.5):
        """Trees across a rectangle, jittered off a grid, clear of roads."""
        count = 0
        for gx in np.arange(x0 + spacing / 2, x1, spacing):
            for gz in np.arange(z0 + spacing / 2, z1, spacing):
                x = gx + self.random.uniform(-0.35, 0.35) * spacing
                z = gz + self.random.uniform(-0.35, 0.35) * spacing
                if not (x0 + 2.5 <= x <= x1 - 2.5 and z0 + 2.5 <= z <= z1 - 2.5):
                    continue
                if not self.is_clear(x, z, pad=pad):
                    continue
                self.kit.tree(x, z, y, height=self.random.uniform(7.0, 13.0),
                              kind=tree_kind(x, z, self.broadleaf))
                self.keep_clear(x - 0.8, z - 0.8, x + 0.8, z + 0.8)
                count += 1
        return count

    def scatter(self, keys, x0, z0, x1, z1, count, pad=2.0):
        """Dressing strewn across a yard: barrels, pallets, crates."""
        placed = 0
        tries = 0
        while placed < count and tries < count * 30:
            tries += 1
            x = self.random.uniform(x0, x1)
            z = self.random.uniform(z0, z1)
            if not self.is_clear(x, z, pad=pad):
                continue
            key = self.random.choice(keys)
            self.props.place(key, x, z, self.random.uniform(0, math.pi))
            self.keep_clear(x - 1.2, z - 1.2, x + 1.2, z + 1.2)
            placed += 1
        return placed


# --- the regions ------------------------------------------------------------
#
# The map is laid out on +x east and +z south, which is how `map.rs` and the
# client already read the other two: -z is north, and a spawn's yaw of zero
# faces it.

def base(layout):
    """Grass everywhere, the river cut out of it, and the edge of the world."""
    k = layout.kit
    north, south = RIVER
    bridge = (8.0, 24.0)
    # Ground in two pieces, leaving the river open: water is drawn by the
    # client under the ground, and a hole in the ground is how it shows.
    k.ground(-HALF, -HALF, HALF, north - 0.6, 0.0, 'grass')
    k.ground(-HALF, south + 0.6, HALF, HALF, 0.0, 'grass')

    # The cut: flood walls on both banks, broken only where the road bridge
    # carries the bank across, and concrete faces from their feet down past
    # the water, so looking over a wall shows a river in a channel rather
    # than a hole in the world.
    for z0, z1 in ((north - 0.6, north), (south, south + 0.6)):
        for x0, x1 in ((-HALF, bridge[0]), (bridge[1], HALF)):
            k.box(x0, 0.0, z0, x1, FLOOD_WALL, z1, 'concrete')
        k.box(-HALF, WATER_LEVEL - 2.0, z0, HALF, -SKIN, z1, 'concrete_dark')
    # Nothing that could be climbed within six metres of a bank: a crate
    # that close is a step to jump over the wall from.
    layout.keep_clear(-HALF, north - 6.6, HALF, south + 6.6)

    # Both ends of the cut are closed - rock in the west, a culvert under
    # the shore in the east. Open, the empty channel would reach the edge of
    # the grid, and `outside_the_art` would take it for the void past the
    # map and wall it off fourteen metres high.
    k.box(-HALF, 0.0, north - 0.6, -HALF + 10.0, 6.0, south + 0.6, 'rock_dark')
    k.box(-HALF, WATER_LEVEL - 2.0, north, -HALF + 10.0, -SKIN, south, 'rock_dark')
    k.box(HALF - 14.0, 0.0, north - 0.6, HALF, 2.2, south + 0.6, 'concrete')
    k.box(HALF - 14.0, WATER_LEVEL - 2.0, north, HALF, -SKIN, south, 'concrete_dark')

    # The edges. A skirt of rock under the ground's rim, down past the sea,
    # so the edge of the map is a cliff into the water rather than a sheet
    # of paper floating over it. Inside the footprint, so the map stays the
    # size it says it is.
    for x0, z0, x1, z1 in ((-HALF, -HALF, HALF, -HALF + 0.5),
                           (-HALF, HALF - 0.5, HALF, HALF),
                           (-HALF, -HALF, -HALF + 0.5, HALF),
                           (HALF - 0.5, -HALF, HALF, HALF)):
        k.box(x0, WATER_LEVEL - 3.0, z0, x1, -SKIN, z1, 'rock_dark')

    # Rock along the north and west edges, taller than anything a player
    # reaches, so the boundary is a mountainside rather than a line.
    k.box(-HALF, 0.0, -HALF, HALF - 20.0, 13.0, -HALF + 6.0, 'rock_dark')
    k.box(-HALF, 0.0, -HALF + 6.0, -HALF + 6.0, 11.0, north - 0.6, 'rock_dark')
    # South: a low rock face at the very edge of the wooded bank.
    k.box(-HALF, 0.0, HALF - 5.0, HALF, 6.0, HALF, 'rock')
    k.box(-HALF, 0.0, south + 0.6, -HALF + 5.0, 6.0, HALF - 5.0, 'rock')
    # East: the shore, gravel down to the water, rocks along the waterline.
    for z in np.arange(-HALF + 20.0, HALF - 5.0, 9.0):
        if north - 8.0 < z < south + 8.0:
            continue
        w = layout.random.uniform(3.0, 6.0)
        k.box(HALF - 4.0, 0.0, z, HALF - 0.5, layout.random.uniform(1.6, 2.6), z + w, 'rock')
    k.quad(HALF - 14.0, -HALF + 6.0, HALF - 0.5, north - 0.6, 0.02, 'gravel')
    k.quad(HALF - 14.0, south + 0.6, HALF - 0.5, HALF - 5.0, 0.02, 'gravel')
    layout.keep_clear(HALF - 16.0, -HALF, HALF, HALF)
    layout.keep_clear(-HALF, -HALF, HALF, -HALF + 8.0)
    layout.keep_clear(-HALF, -HALF, -HALF + 8.0, HALF)
    layout.keep_clear(-HALF, HALF - 7.0, HALF, HALF)


def north_ridge(layout):
    """The wooded ridge in the north-west, with the outpost on top."""
    layout.broadleaf = 0.08
    k = layout.kit
    # Three tiers, each a step of 2.5 m, as boxes that meet rather than
    # overlap, so no grassed top is buried inside another tier.
    tier1, tier2, tier3 = 2.5, 5.0, 7.5
    k.mesa(-154.0, -154.0, -90.0, -142.0, tier3)          # the summit strip
    k.mesa(-154.0, -142.0, -90.0, -132.0, tier2)
    k.mesa(-90.0, -154.0, -66.0, -132.0, tier2)
    k.mesa(-154.0, -132.0, -66.0, -118.0, tier1)
    k.mesa(-154.0, -118.0, -110.0, -104.0, tier1)

    # Two ways onto every tier, far apart, so taking the hill is never one
    # choke point.
    ramps = [
        ('z', -110.0, -117.5, -96.0, -91.5, 0.0, tier1),    # from the village road
        ('x', -105.0, -109.5, -113.0, -108.5, 0.0, tier1),  # from the west yard
        ('x', -58.0, -65.5, -127.0, -122.5, 0.0, tier1),    # from the valley
        ('z', -124.0, -131.5, -80.0, -75.5, tier1, tier2),
        ('z', -124.0, -131.5, -135.0, -130.5, tier1, tier2),
        ('z', -134.0, -141.5, -104.0, -99.5, tier2, tier3),
        ('x', -80.0, -89.5, -150.0, -145.5, tier2, tier3),
    ]
    for axis, a, b, c0, c1, y0, y1 in ramps:
        k.ramp(axis, a, b, c0, c1, y0, y1)
        if axis == 'x':
            layout.keep_clear(min(a, b) - 1.5, c0 - 1.0, max(a, b) + 1.5, c1 + 1.0)
        else:
            layout.keep_clear(c0 - 1.0, min(a, b) - 1.5, c1 + 1.0, max(a, b) + 1.5)

    # The outpost: a bunker and a radio mast on the summit.
    y = tier3
    k.box(-125.0, y, -152.0, -113.0, y + 3.2, -151.6, 'concrete')
    for x0, x1 in ((-125.0, -124.6), (-113.4, -113.0)):
        k.box(x0, y, -151.6, x1, y + 3.2, -145.4, 'concrete')
    k.box(-125.0, y, -145.4, -121.0, y + 3.2, -145.0, 'concrete')
    k.box(-117.0, y, -145.4, -113.0, y + 3.2, -145.0, 'concrete')
    k.deck(-125.2, -152.2, -112.8, -144.8, y + 3.45, 'concrete_dark')
    for dx in (0.0, 2.2):
        for dz in (0.0, 2.2):
            k.box(-102.0 + dx, y, -151.0 + dz, -101.8 + dx, y + 15.0, -150.8 + dz, 'steel')
    for h in np.arange(1.5, 15.0, 3.0):
        k.box(-102.0, y + h, -151.0, -99.6, y + h + 0.15, -148.6, 'steel')
    for x, z in ((-121.0, -143.0), (-117.0, -143.0)):
        layout.props.place('sandbags_short', x, z, 0.0, y=tier3)
    layout.keep_clear(-127.0, -154.0, -111.0, -141.0)
    layout.keep_clear(-104.0, -153.0, -98.0, -147.0)

    # Trees on every tier.
    layout.forest(-152.0, -141.0, -92.0, -133.0, 7.0, y=tier2)
    layout.forest(-88.0, -152.0, -68.0, -134.0, 7.0, y=tier2)
    layout.forest(-152.0, -131.0, -68.0, -119.0, 6.5, y=tier1)
    layout.forest(-152.0, -117.0, -112.0, -105.0, 6.5, y=tier1)
    layout.forest(-152.0, -152.0, -130.0, -143.0, 8.0, y=tier3)


def mountain_and_tunnel(layout):
    """The hill in the north middle, with a road tunnel through it.

    The tunnel is the way from the village side to the east that does not
    cross the compound: sixty metres of close quarters with a portal at each
    end. The rock over it is not reachable - it is a mountain, not a lookout.
    """
    layout.broadleaf = 0.15
    k = layout.kit
    x0, x1 = -20.0, 44.0
    top = 11.0
    tz0, tz1 = -128.0, -121.0          # the bore
    clear_height = 4.6
    k.box(x0, 0.0, -154.0, x1, top, tz0, 'rock_dark')
    k.box(x0, 0.0, tz1, x1, top, -110.0, 'rock')
    k.box(x0, clear_height, tz0, x1, top, tz1, 'rock')
    k.quad(x0, tz0, x1, tz1, 0.04, 'asphalt')
    # Portals: a concrete frame at each end.
    for x in (x0 - 0.8, x1):
        k.box(x, 0.0, tz0 - 1.2, x + 0.8, clear_height + 1.2, tz0, 'concrete')
        k.box(x, 0.0, tz1, x + 0.8, clear_height + 1.2, tz1 + 1.2, 'concrete')
        k.box(x, clear_height, tz0, x + 0.8, clear_height + 1.2, tz1, 'concrete')
    layout.keep_clear(x0 - 2.0, -154.0, x1 + 2.0, -108.0)
    # The valley west of it, and the roads through it and the tunnel.
    layout.road(-62.0, tz0, x0 - 0.8, tz1)
    layout.road(x1 + 0.8, tz0, 78.0, tz1)
    layout.road(-62.0, -121.0, -56.0, -76.0, 'dirt')      # the valley road south
    layout.road(-62.0, -110.0, 0.0, -104.0)               # along the foot of the hill
    layout.forest(-54.0, -152.0, -24.0, -131.0, 7.0)
    layout.forest(-52.0, -118.0, -24.0, -112.0, 7.0)


def village(layout):
    """North-west: houses, a barn, yards and a water tower."""
    layout.broadleaf = 0.8
    k = layout.kit
    p = layout.props
    layout.road(-150.0, -80.0, -56.0, -72.0, 'dirt')
    layout.road(-97.0, -104.0, -91.0, -80.0, 'dirt')

    homes = [
        # x0, z0, x1, z1, roof, walls, doors, stair
        (-142.0, -100.0, -130.0, -90.0, 3.4, 'plaster_tan',
         {'z1': ((-138.0, -136.0),), 'x1': ((-96.5, -94.5),)}, None),
        (-124.0, -102.0, -110.0, -90.0, 6.4, 'plaster_sand',
         {'z1': ((-119.0, -117.0),), 'x0': ((-97.0, -95.0),)}, 'x1'),
        (-86.0, -101.0, -74.0, -90.0, 3.4, 'plaster_olive',
         {'z1': ((-81.0, -79.0),), 'x0': ((-96.0, -94.0),)}, None),
        (-142.0, -66.0, -128.0, -52.0, 6.4, 'plaster_maroon',
         {'z0': ((-137.0, -135.0),), 'x1': ((-60.0, -58.0),)}, 'x0'),
        (-116.0, -64.0, -104.0, -54.0, 3.4, 'plaster_tan',
         {'z0': ((-111.0, -109.0),), 'z1': ((-111.0, -109.0),)}, None),
        (-84.0, -66.0, -70.0, -50.0, 6.4, 'plaster_sand',
         {'z0': ((-79.0, -77.0),), 'x1': ((-59.0, -57.0),)}, 'z1'),
    ]
    for x0, z0, x1, z1, roof, walls, doors, stair in homes:
        layout.house(x0, z0, x1, z1, roof, walls, doors, stair)

    # The barn: big, dark red, a door at each end.
    layout.house(-72.0, -104.0, -60.0, -86.0, 5.2, 'plaster_maroon',
                 {'z1': ((-69.0, -63.0),), 'z0': ((-69.0, -63.0),)}, None)

    # Yard walls: chest high, which is cover and not a barrier.
    for x0, z0, x1, z1 in ((-146.0, -103.0, -126.0, -102.6),
                           (-146.0, -86.0, -128.0, -85.6),
                           (-146.0, -48.0, -120.0, -47.6),
                           (-146.0, -103.0, -145.6, -86.0)):
        k.box(x0, 0.0, z0, x1, 1.1, z1, 'brick')

    p.place('water_tower', -98.0, -60.0)
    layout.keep_clear(-106.0, -68.0, -90.0, -52.0)

    for x, z, yaw, key in ((-132.0, -76.0, 0.1, 'car'), (-104.0, -84.0, 0.0, 'truck_olive'),
                           (-76.0, -76.5, 3.1, 'car_blue'), (-122.0, -44.0, 0.0, 'car_olive')):
        p.place(key, x, z, yaw)
        layout.keep_clear(x - 5.0, z - 3.0, x + 5.0, z + 3.0)
    layout.scatter(['crate', 'barrel', 'pallet', 'sawhorse'], -146.0, -104.0, -58.0, -46.0, 26)
    layout.forest(-152.0, -46.0, -122.0, -38.0, 7.5)


def compound(layout):
    """The walled works in the middle: the landmark and the final fight."""
    k = layout.kit
    p = layout.props
    x0, z0, x1, z1 = COMPOUND
    wall_h = 3.6
    t = 0.6
    # Gates, two a side and none in line with another, so no road through
    # the works is a sightline straight across it.
    k.wall(x0, z0, x1, z0 + t, 0.0, wall_h, ((-10.0, 0.0), (28.0, 34.0)), 'concrete', head=wall_h)
    k.wall(x0, z1 - t, x1, z1, 0.0, wall_h, ((10.0, 22.0), (-34.0, -28.0)), 'concrete', head=wall_h)
    k.wall(x0, z0 + t, x0 + t, z1 - t, 0.0, wall_h, ((-12.0, -4.0), (24.0, 30.0)), 'concrete', head=wall_h)
    k.wall(x1 - t, z0 + t, x1, z1 - t, 0.0, wall_h, ((-24.0, -16.0), (16.0, 22.0)), 'concrete', head=wall_h)
    # Watchtowers on the corners: a cabin at six metres, a stair up to it.
    for cx, cz, sx, sz in ((x0, z0, 1, 1), (x1, z0, -1, 1), (x0, z1, 1, -1), (x1, z1, -1, -1)):
        tx0, tx1 = sorted((cx, cx + sx * 5.0))
        tz0, tz1 = sorted((cz, cz + sz * 5.0))
        for ax in (tx0, tx1 - 0.4):
            for az in (tz0, tz1 - 0.4):
                k.box(ax, 0.0, az, ax + 0.4, 6.0, az + 0.4, 'steel')
        k.deck(tx0, tz0, tx1, tz1, 6.0, 'wood_dark')
        # The stair lands on a porch outside the cabin, open to the sky: a
        # tread under the cabin's roof would be extended up to it and the
        # top of the flight would be a wall. The rail is open where the
        # porch meets the cabin.
        lane = (tx0 + 1.5, tx0 + 3.9) if sx > 0 else (tx1 - 3.9, tx1 - 1.5)
        inward = tz1 if sz > 0 else tz0
        porch = (inward, inward + 1.6) if sz > 0 else (inward - 1.6, inward)
        k.deck(lane[0] - 0.2, porch[0], lane[1] + 0.2, porch[1], 6.0, 'wood_dark')
        near_rail, far_rail = ((tz1 - 0.2, tz1), (tz0, tz0 + 0.2)) if sz > 0 else \
                              ((tz0, tz0 + 0.2), (tz1 - 0.2, tz1))
        k.wall(tx0, near_rail[0], tx1, near_rail[1], 6.0, 7.1, ((lane[0], lane[1]),), 'wood', head=7.1)
        k.box(tx0, 6.0, far_rail[0], tx1, 7.1, far_rail[1], 'wood')
        k.box(tx0, 6.0, tz0 + 0.2, tx0 + 0.2, 7.1, tz1 - 0.2, 'wood')
        k.box(tx1 - 0.2, 6.0, tz0 + 0.2, tx1, 7.1, tz1 - 0.2, 'wood')
        k.box(tx0 - 0.3, 9.0, tz0 - 0.3, tx1 + 0.3, 9.25, tz1 + 0.3, 'roof_metal')
        for ax in (tx0, tx1 - 0.2):
            for az in (tz0, tz1 - 0.2):
                k.box(ax, 7.1, az, ax + 0.2, 9.0, az + 0.2, 'wood')
        if sz > 0:
            k.flight('z', porch[1] + 8.0, porch[1] - 0.5, lane[0], lane[1], 0.0, 6.0 - SKIN)
            layout.keep_clear(tx0, tz1, tx1, porch[1] + 9.0)
        else:
            k.flight('z', porch[0] - 8.0, porch[0] + 0.5, lane[0], lane[1], 0.0, 6.0 - SKIN)
            layout.keep_clear(tx0, porch[0] - 9.0, tx1, tz0)
        layout.keep_clear(tx0 - 1.0, tz0 - 1.0, tx1 + 1.0, tz1 + 1.0)

    # Hardstanding over the whole works, and the roads out of its gates.
    k.quad(x0 + t, z0 + t, x1 - t, z1 - t, 0.02, 'concrete_dark')
    layout.road(-10.0, -104.0, 0.0, z0)                  # north gate, to the hill road
    layout.road(10.0, z1, 22.0, RIVER[0] - 0.6)          # south gate, to the bridge
    layout.road(-120.0, -12.0, x0, -4.0)                 # west gate
    layout.road(x1, -24.0, HALF - 14.0, -16.0)           # east gate
    layout.road(x1, 16.0, 98.0, 22.0)                    # the second east gate

    # The silos: three tall ones and the banded stack, north-west of the
    # middle. A stair tower beside them climbs to a platform at nine metres
    # among them - the highest ground in the works, and a long way up.
    for cx, cz, r, h in ((-40.0, -40.0, 4.5, 18.0), (-28.5, -42.0, 4.5, 18.0),
                         (-38.0, -28.0, 4.5, 18.0)):
        k.cylinder(cx, cz, r, 0.0, h, 'silo', segments=22, top_material='roof_metal')
    k.cylinder(-22.0, -26.0, 5.5, 0.0, 14.0, 'tank_white', segments=24,
               top_material='roof_metal')
    for band in (4.0, 9.0):
        k.cylinder(-22.0, -26.0, 5.56, band, band + 1.8, 'stripe_red', segments=24, top=False)
    layout.keep_clear(-46.0, -48.0, -15.0, -19.0)
    # One straight flight, open to the sky all the way up - a stair that
    # doubles back under its own upper flights is a stair the generator
    # fills solid - then a gantry east and north in among the silos.
    k.flight('x', -54.5, -44.0, -21.6, -19.2, 0.0, 9.0 - SKIN)
    k.deck(-44.5, -22.0, -30.0, -19.2, 9.0, 'steel')                # east
    k.deck(-32.0, -31.0, -30.0, -22.0, 9.0, 'steel')                # north to the silos
    k.deck(-37.0, -37.0, -30.0, -31.0, 9.0, 'steel')                # among them
    layout.keep_clear(-55.5, -23.0, -42.0, -17.5)

    # Two wide tanks north-east of the middle, a stair onto the first and a
    # catwalk across to the second.
    for cx in (24.0, 40.0):
        k.cylinder(cx, -34.0, 7.0, 0.0, 7.5, 'tank_white', segments=26, top_material='steel')
    k.flight('x', 8.0, 17.5, -35.2, -32.8, 0.0, 7.5 - SKIN)
    k.deck(29.0, -35.0, 35.0, -33.0, 7.5, 'steel')
    layout.keep_clear(7.0, -42.0, 48.0, -26.0)

    # The pipe rack across the middle at five metres, a walkway on it and a
    # stair at each end: a route over the yard, and an exposed one.
    for x in np.arange(-44.0, 46.0, 9.0):
        k.box(x, 0.0, -9.0, x + 0.5, 4.75, -8.5, 'steel')
        k.box(x, 0.0, -4.5, x + 0.5, 4.75, -4.0, 'steel')
    k.deck(-44.5, -9.0, 44.5, -4.0, 5.0, 'steel_stair')
    # The pipes run under the walkway, between the legs.
    for zc in (-7.8, -6.5, -5.2):
        k.box(-41.5, 4.0, zc - 0.3, 41.5, 4.55, zc + 0.3, 'steel')
    k.flight('z', 3.5, -4.0 - 0.5, -44.5, -42.0, 0.0, 5.0 - SKIN)
    k.flight('z', 3.5, -4.0 - 0.5, 42.0, 44.5, 0.0, 5.0 - SKIN)
    layout.keep_clear(-45.0, -10.0, 45.0, 4.0)

    # The factory, south of the middle: one big room with a gallery, doors
    # on every side, and a stair to its roof.
    layout.warehouse(-44.0, 16.0, -4.0, 40.0, 8.0,
                     {'z0': ((-30.0, -24.0), (-14.0, -10.0)),
                      'z1': ((-36.0, -30.0),),
                      'x0': ((24.0, 30.0),), 'x1': ((20.0, 26.0),)},
                     walls='plaster_olive', racks=False, mezzanine=('z1', 3.0))
    for x, z in ((-36.0, 24.0), (-26.0, 28.0), (-16.0, 24.0), (-10.0, 30.0)):
        layout.solid(x, 0.0, z, x + 4.0, 2.2, z + 2.5, 'steel')   # machinery
    k.roof_stair('x1', -44.0, 16.0, -4.0, 40.0, 8.0)
    layout.roofs.append((-44.0, 16.0, -4.0, 40.0, 8.0))
    layout.keep_clear(-4.0, 24.0, 7.0, 32.0)

    # Offices, two floors, south-east: the upper floor half the depth of the
    # building, looking down into the lower.
    ox0, oz0, ox1, oz1, roof = 14.0, 18.0, 34.0, 34.0, 7.0
    doors = {'z0': ((18.0, 21.0),), 'x0': ((28.0, 31.0),), 'x1': ((29.0, 32.0),)}
    head = roof - DECK * 0.5
    for side, (a, b, c, d) in (('z0', (ox0, oz0, ox1, oz0 + 0.4)), ('z1', (ox0, oz1 - 0.4, ox1, oz1)),
                               ('x0', (ox0, oz0 + 0.4, ox0 + 0.4, oz1 - 0.4)),
                               ('x1', (ox1 - 0.4, oz0 + 0.4, ox1, oz1 - 0.4))):
        k.wall(a, b, c, d, 0.0, head, doors.get(side, ()), 'plaster_tan')
    layout.roof(ox0, oz0, ox1, oz1, roof, [(21.5, 24.6, 30.5, 27.8)])
    k.quad(ox0, oz0, ox1, oz1, 0.06, 'concrete_dark')
    k.roof_stair('z1', ox0, oz0, ox1, oz1, roof)
    layout.roofs.append((ox0, oz0, ox1, oz1, roof))
    layout.keep_clear(ox0 - 2.0, oz0 - 2.0, ox1 + 2.0, oz1 + 10.0)
    k.deck(14.4, 18.4, 33.6, 25.0, 3.5, 'concrete_dark')          # upper floor
    k.flight('x', 30.0, 22.0, 25.0, 27.4, 0.0, 3.5 - SKIN, 'concrete_dark')

    # Sheds along the east side.
    layout.house(38.0, 4.0, 50.0, 12.0, 3.6, 'concrete',
                 {'x0': ((6.0, 10.0),), 'z0': ((42.0, 45.0),)}, None)
    layout.house(38.0, 28.0, 50.0, 40.0, 3.6, 'plaster_sand',
                 {'x0': ((31.0, 35.0),), 'z1': ((42.0, 45.0),)}, None)

    # The chimney: forty metres of it, banded at the top, in the lane behind
    # the factory. The one thing on the map you can see from everywhere,
    # and the smoke off it says which way the wind is blowing.
    cx, cz = -14.0, 46.0
    k.cylinder(cx, cz, 2.2, 0.0, 26.0, 'concrete', segments=20, top=False)
    k.cylinder(cx, cz, 1.8, 26.0, 40.0, 'concrete', segments=20, top_material='concrete_dark')
    for y0, colour in ((31.0, 'stripe_red'), (33.5, 'tank_white'), (36.0, 'stripe_red')):
        k.cylinder(cx, cz, 1.86, y0, y0 + 2.5, colour, segments=20, top=False)
    layout.detail.cylinder(cx, cz, 2.0, 38.6, 39.0, 'frame_dark', segments=20)
    layout.keep_clear(cx - 3.5, cz - 3.5, cx + 3.5, cz + 3.5)
    layout.smoke.append([cx, 40.5, cz])

    # The middle: a yard of containers and trucks, cover and nothing taller,
    # so the last circle has somewhere to fight.
    for x, z, yaw, key in ((-8.0, -1.0, 0.0, 'container'), (8.0, 8.0, 1.57, 'container_blue'),
                           (14.0, -1.0, 0.0, 'container_olive'), (-16.0, 10.0, 1.57, 'container_grey'),
                           (2.0, 13.0, 0.0, 'truck'), (-4.0, -15.0, 3.14, 'truck_grey')):
        p.place(key, x, z, yaw)
        layout.keep_clear(x - 6.0, z - 3.0, x + 6.0, z + 3.0)
    for x, z in ((-22.0, 2.0), (20.0, 8.0), (-6.0, 6.0)):
        k.cover(x, z)
        layout.keep_clear(x - 1.0, z - 1.0, x + 3.5, z + 2.0)
    layout.scatter(['barrel', 'barrel_blue', 'pallet', 'crate'], -50.0, -50.0, 50.0, 46.0, 34, pad=1.5)


def north_east(layout):
    """Hangars and a loading yard, north-east of the works."""
    layout.broadleaf = 0.2
    k = layout.kit
    p = layout.props
    layout.road(70.0, -121.0, 78.0, -16.0)
    layout.road(52.0, -76.0, HALF - 14.0, -68.0)
    layout.warehouse(84.0, -114.0, 124.0, -90.0, 10.0,
                     {'z1': ((94.0, 104.0),), 'x0': ((-106.0, -98.0),),
                      'x1': ((-106.0, -98.0),)},
                     walls='concrete', racks=True, mezzanine=('z0', 3.0))
    layout.warehouse(88.0, -62.0, 132.0, -40.0, 9.0,
                     {'z0': ((98.0, 108.0),), 'x0': ((-54.0, -48.0),),
                      'z1': ((114.0, 120.0),)},
                     walls='plaster_olive', racks=True)
    # Solar panels on its roof, as in the reference.
    for x in np.arange(90.0, 130.0, 4.5):
        k.box(x, 9.25, -60.0, x + 3.6, 9.55, -42.0, 'solar')
    for x, z, key in ((60.0, -58.0, 'container'), (60.0, -52.0, 'container_blue'),
                      (60.0, -46.0, 'container_olive'), (140.0, -86.0, 'container_grey'),
                      (140.0, -80.0, 'container')):
        p.place(key, x, z, 0.0)
        layout.keep_clear(x - 6.0, z - 3.0, x + 6.0, z + 3.0)
    p.place('container', 60.0, -52.0, 0.0, y=p.size('container')[1])
    for x, z, yaw, key in ((96.0, -84.0, 0.0, 'truck'), (112.0, -84.0, 0.0, 'truck_olive'),
                           (84.0, -66.0, 1.57, 'car_olive')):
        p.place(key, x, z, yaw)
        layout.keep_clear(x - 6.0, z - 3.0, x + 6.0, z + 3.0)
    # The hill along the north edge east of the mountain: one tier, wooded.
    k.mesa(48.0, -154.0, HALF - 20.0, -134.0, 3.0)
    for a, b, c0, c1 in ((-126.0, -133.5, 100.0, 104.5), (-126.0, -133.5, 126.0, 130.5)):
        k.ramp('z', a, b, c0, c1, 0.0, 3.0)
        layout.keep_clear(c0 - 1.0, b - 1.5, c1 + 1.0, a + 1.5)
    layout.forest(50.0, -152.0, 138.0, -136.0, 7.0, y=3.0)
    layout.scatter(['barrel', 'pallet', 'crate', 'crate_dark'], 50.0, -118.0, 146.0, -34.0, 24)


def west(layout):
    """West of the works: an arched hangar, a helipad, barracks, fuel."""
    layout.broadleaf = 0.45
    k = layout.kit
    p = layout.props
    # The hangar: long, with a door at each end. The arch is a stepped roof
    # of boxes, which is what the collision would make of a curve anyway.
    x0, z0, x1, z1 = -138.0, -34.0, -106.0, -14.0
    k.wall(x0, z0, x1, z0 + 0.5, 0.0, 6.0, (), 'roof_metal')
    k.wall(x0, z1 - 0.5, x1, z1, 0.0, 6.0, (), 'roof_metal')
    k.wall(x0, z0 + 0.5, x0 + 0.5, z1 - 0.5, 0.0, 8.8, ((-30.0, -18.0),), 'concrete', head=6.0)
    k.wall(x1 - 0.5, z0 + 0.5, x1, z1 - 0.5, 0.0, 8.8, ((-30.0, -18.0),), 'concrete', head=6.0)
    for inset, y, thick in ((0.0, 6.0, 1.9), (2.5, 7.6, 1.5), (5.5, 8.8, 0.5)):
        k.box(x0, y, z0 + inset, x1, y + thick, z1 - inset, 'roof_metal')
    k.quad(x0 + 0.5, z0 + 0.5, x1 - 0.5, z1 - 0.5, 0.06, 'concrete_dark')
    p.place('truck_olive', -124.0, -24.0, 0.0)
    for x in (-132.0, -114.0):
        k.cover(x, -31.0)
    layout.keep_clear(x0 - 2.0, z0 - 2.0, x1 + 2.0, z1 + 2.0)
    layout.road(-150.0, -12.0, -120.0, -4.0)

    # The helipad.
    k.box(-98.0, 0.0, 6.0, -76.0, 0.3, 28.0, 'concrete_light')
    k.quad(-90.0, 14.5, -84.0, 19.5, 0.32, 'warning')
    layout.keep_clear(-99.0, 5.0, -75.0, 29.0)

    # Barracks: long huts in a row, and a two-storey block.
    for i, z in enumerate((34.0, 44.0)):
        layout.house(-146.0, z, -120.0, z + 7.0, 3.4, ('plaster_olive', 'plaster_sand')[i % 2],
                     {'z0': ((-140.0, -138.0), (-128.0, -126.0)), 'x1': ((z + 2.5, z + 4.5),)}, None)
    layout.house(-110.0, 34.0, -90.0, 44.0, 6.0, 'plaster_tan',
                 {'z0': ((-104.0, -102.0),), 'x0': ((38.0, 40.0),), 'z1': ((-96.0, -94.0),)}, 'x1')

    # Fuel: small white tanks behind a low wall.
    for x in np.arange(-148.0, -120.0, 7.0):
        k.cylinder(x, 10.0, 2.4, 0.0, 4.2, 'tank_white', segments=16, top_material='steel')
    k.box(-151.0, 0.0, 15.0, -118.0, 1.0, 15.5, 'concrete')
    layout.keep_clear(-152.0, 6.0, -117.0, 16.0)
    for x, z, key in ((-66.0, 30.0, 'container_grey'), (-66.0, 36.0, 'container'),
                      (-72.0, -40.0, 'container_blue')):
        p.place(key, x, z, 1.57)
        layout.keep_clear(x - 3.0, z - 6.0, x + 3.0, z + 6.0)
    layout.scatter(['barrel', 'crate', 'pallet', 'sawhorse', 'barrier'], -150.0, -44.0, -60.0, 56.0, 28)
    layout.forest(-150.0, 64.0, -104.0, 98.0, 8.0)


def east(layout):
    """East of the works: warehouses in a row and the truck yard by the shore."""
    k = layout.kit
    p = layout.props
    layout.road(98.0, -16.0, 104.0, 60.0)
    layout.warehouse(62.0, -12.0, 92.0, 10.0, 9.0,
                     {'x0': ((-6.0, 0.0),), 'x1': ((-4.0, 2.0),), 'z0': ((70.0, 76.0),)},
                     walls='concrete_dark', racks=True)
    layout.warehouse(106.0, -12.0, 140.0, 12.0, 9.5,
                     {'x0': ((-6.0, 2.0),), 'z0': ((116.0, 122.0),), 'z1': ((126.0, 132.0),)},
                     walls='plaster_sand', racks=True, mezzanine=('z1', 3.0))
    layout.warehouse(66.0, 24.0, 96.0, 46.0, 8.5,
                     {'z0': ((74.0, 80.0),), 'x1': ((30.0, 36.0),), 'x0': ((32.0, 38.0),)},
                     walls='concrete', racks=True)
    # The truck yard.
    for i, (x, z) in enumerate(((118.0, 22.0), (118.0, 30.0), (132.0, 22.0), (132.0, 38.0))):
        p.place(('truck', 'truck_grey', 'truck_olive', 'truck')[i], x, z, 0.0)
        layout.keep_clear(x - 6.0, z - 3.0, x + 6.0, z + 3.0)
    for x, z, key in ((118.0, 46.0, 'container'), (118.0, 52.0, 'container_olive'),
                      (134.0, 50.0, 'container_blue')):
        p.place(key, x, z, 0.0)
        layout.keep_clear(x - 6.0, z - 3.0, x + 6.0, z + 3.0)
    p.place('container_grey', 118.0, 46.0, 0.0, y=p.size('container')[1])
    layout.scatter(['barrel', 'barrel_blue', 'pallet', 'crate', 'roadblock'], 58.0, -34.0, 144.0, 56.0, 30)


def south(layout):
    """South of the works: rail sidings, container stacks, warehouses, fuel."""
    k = layout.kit
    p = layout.props
    # Two sidings along x, on a gravel bed, with wagons standing on them.
    for z in (60.0, 67.0):
        k.quad(-150.0, z - 1.8, 144.0, z + 1.8, 0.02, 'gravel')
        for dz in (-0.8, 0.7):
            k.box(-150.0, 0.02, z + dz, 144.0, 0.18, z + dz + 0.1, 'steel')
    for x0, z, colour in ((-120.0, 60.0, 'container_rust'), (-96.0, 60.0, 'container_olive'),
                          (-40.0, 67.0, 'container_grey'), (36.0, 60.0, 'container_rust'),
                          (60.0, 67.0, 'container_blue'), (104.0, 60.0, 'container_olive')):
        k.box(x0, 0.6, z - 1.5, x0 + 15.0, 3.8, z + 1.5, colour)
        k.box(x0 + 1.0, 0.0, z - 1.2, x0 + 2.5, 0.6, z + 1.2, 'steel')
        k.box(x0 + 12.5, 0.0, z - 1.2, x0 + 14.0, 0.6, z + 1.2, 'steel')
    layout.keep_clear(-150.0, 57.0, 146.0, 70.0)

    # Container stacks in rows: a maze of lanes, one and two high.
    for row, z in enumerate((78.0, 84.0, 92.0)):
        for i, x in enumerate(np.arange(-138.0 + 5.0 * (row % 2), -44.0, 14.5)):
            if (row + i) % 4 == 3:
                continue
            key = ('long', 'long_blue', 'long_olive', 'long_grey')[(row + i) % 4]
            p.place(key, x, z, 0.0)
            if (row * 3 + i) % 5 == 0:
                p.place(('long_grey', 'long')[i % 2], x, z, 0.0, y=p.size('long')[1])
    layout.keep_clear(-146.0, 74.0, -34.0, 96.0)
    # A yard office and a garage by the road south.
    layout.house(-26.0, 80.0, -10.0, 94.0, 4.0, 'concrete',
                 {'z0': ((-22.0, -16.0),), 'x1': ((85.0, 89.0),)}, None)
    layout.house(-4.0, 82.0, 4.0, 90.0, 3.2, 'plaster_sand',
                 {'x1': ((85.0, 87.0),), 'z0': ((-1.0, 1.0),)}, None)

    layout.warehouse(30.0, 74.0, 62.0, 96.0, 9.0,
                     {'x0': ((80.0, 88.0),), 'z0': ((40.0, 48.0),), 'x1': ((78.0, 84.0),)},
                     walls='concrete', racks=True)
    layout.warehouse(74.0, 76.0, 104.0, 94.0, 8.0,
                     {'x0': ((82.0, 88.0),), 'z0': ((84.0, 90.0),)},
                     walls='plaster_olive', racks=True)
    # A fuel depot in the south-east, behind the warehouses.
    for x in (118.0, 126.0, 134.0):
        k.cylinder(x, 84.0, 3.0, 0.0, 5.0, 'tank_white', segments=18, top_material='steel')
    layout.keep_clear(113.0, 79.0, 139.0, 89.0)
    layout.road(-34.0, 71.0, 144.0, 73.5)
    layout.scatter(['barrel', 'pallet', 'crate', 'crate_dark', 'barrier'], -30.0, 44.0, 144.0, 99.0, 34)


def fields(layout):
    """The open ground between the regions, broken up.

    Without this the country between the village, the hill and the works is
    lawn: a player crossing it can be seen from half the map, and the fight
    for the middle is decided by whoever reaches the edge of a field first.
    Outcrops, copses and the odd shed give every crossing somewhere to stop.
    """
    layout.broadleaf = 0.6
    k = layout.kit
    rng = layout.random
    outcrops = [
        (-40.0, -92.0, 6.0), (-26.0, -70.0, 5.0), (-46.0, -62.0, 4.0),
        (20.0, -84.0, 7.0), (36.0, -98.0, 5.0), (8.0, -66.0, 4.5), (52.0, -86.0, 5.0),
        (-40.0, -30.0, 4.0), (-64.0, -6.0, 4.5), (-70.0, 14.0, 4.0),
        (-8.0, 70.0, 3.0), (-60.0, 104.0 - 12.0, 4.0),
        (60.0, 100.0 - 6.0, 3.5), (-120.0, 120.0 + 22.0, 3.0),
    ]
    for x, z, size in outcrops:
        if not layout.is_clear(x, z, pad=size * 0.6):
            continue
        k.rocks(x, z, size, rng)
        layout.keep_clear(x - size, z - size, x + size, z + size)
    # A depot on the road from the village to the works.
    layout.house(-46.0, -100.0, -34.0, -90.0, 3.6, 'concrete',
                 {'x1': ((-97.0, -93.0),), 'z1': ((-42.0, -39.0),)}, None)
    layout.house(-30.0, -100.0, -22.0, -94.0, 3.0, 'plaster_olive',
                 {'z1': ((-27.0, -25.0),)}, None)
    layout.props.place('truck_grey', -38.0, -84.0, 0.0)
    layout.keep_clear(-44.0, -87.0, -32.0, -81.0)
    # A shed and stacked boxes by the north-east road.
    layout.house(50.0, -104.0, 62.0, -96.0, 3.4, 'plaster_sand',
                 {'x1': ((-101.0, -99.0),)}, None)
    for x, z in ((54.0, -90.0), (60.0, -90.0)):
        layout.props.place('container_olive', x, z, 1.57)
        layout.keep_clear(x - 2.0, z - 4.0, x + 2.0, z + 4.0)
    # Copses in the gaps.
    layout.forest(-54.0, -100.0, -12.0, -60.0, 11.0)
    layout.forest(0.0, -100.0, 64.0, -60.0, 12.0)
    layout.forest(-102.0, -54.0, -60.0, 56.0, 13.0)
    layout.forest(-60.0, 56.0, 30.0, 100.0, 13.0)


def river(layout):
    """Three crossings: the road bridge, the dam, and a footbridge."""
    k = layout.kit
    p = layout.props
    north, south = RIVER

    # The road bridge. At the level of the road, sixteen metres wide, with
    # parapets a player can shoot over and not climb, meeting the flood
    # walls at both banks so neither bank has a way down to the water.
    bx0, bx1 = 8.0, 24.0
    k.box(bx0, 0.0, north - 0.6, bx1, 0.3, south + 0.6, 'concrete_dark')
    k.quad(bx0 + 1.5, north - 0.6, bx1 - 1.5, south + 0.6, 0.32, 'asphalt')
    for x0, x1 in ((bx0, bx0 + 0.5), (bx1 - 0.5, bx1)):
        k.box(x0, 0.3, north - 0.6, x1, 0.3 + FLOOD_WALL, south + 0.6, 'concrete')
    for z in (north + 7.0, north + 17.0):
        k.box(bx0 + 2.0, WATER_LEVEL - 2.0, z, bx1 - 2.0, -SKIN, z + 2.0, 'concrete')
    p.place('roadblock', 11.5, north - 9.0, 0.0)
    p.place('roadblock', 20.5, south + 9.0, 0.0)

    # The dam in the west: a wall across the river with a walkway on top at
    # four and a half metres, a stair up from each bank inside walls, and
    # parapets round the rest. High ground over the whole river, nowhere to
    # hide on it, and no way off it but the stairs.
    dx0, dx1 = -112.0, -102.0
    top = 4.5
    k.box(dx0, WATER_LEVEL - 2.0, north - 0.6, dx1, top, south + 0.6, 'concrete')
    for x0, x1 in ((dx0, dx0 + 0.5), (dx1 - 0.5, dx1)):
        k.box(x0, top, north - 0.6, x1, top + FLOOD_WALL, south + 0.6, 'concrete')
    north_lane = (dx0 + 1.0, dx0 + 3.6)
    south_lane = (dx1 - 3.6, dx1 - 1.0)
    # End walls, open only where each stair arrives.
    k.box(dx0 + 0.5, top, north - 0.6, north_lane[0] - 0.3, top + FLOOD_WALL, north - 0.2, 'concrete')
    k.box(north_lane[1] + 0.3, top, north - 0.6, dx1 - 0.5, top + FLOOD_WALL, north - 0.2, 'concrete')
    k.box(dx0 + 0.5, top, south + 0.2, south_lane[0] - 0.3, top + FLOOD_WALL, south + 0.6, 'concrete')
    k.box(south_lane[1] + 0.3, top, south + 0.2, dx1 - 0.5, top + FLOOD_WALL, south + 0.6, 'concrete')
    k.guarded_flight('z', north - 12.0, north - 0.6 + 0.5, north_lane[0], north_lane[1], 0.0, top - SKIN)
    k.guarded_flight('z', south + 12.0, south + 0.6 - 0.5, south_lane[0], south_lane[1], 0.0, top - SKIN)
    # Water over the spillway on the downstream face.
    k.box(dx1, WATER_LEVEL, north + 3.0, dx1 + 0.4, top - 0.6, south - 3.0, 'water')
    layout.keep_clear(dx0 - 3.0, north - 14.0, dx1 + 3.0, south + 14.0)

    # The footbridge in the east: a steel walkway at five metres, narrow
    # and exposed, a walled stair up at each end.
    fx0, fx1 = 108.0, 111.0
    fy = 5.0
    k.deck(fx0, north - 1.0, fx1, south + 1.0, fy, 'steel')
    for x0, x1 in ((fx0 - 0.3, fx0), (fx1, fx1 + 0.3)):
        k.box(x0, fy - DECK, north - 1.0, x1, fy + FLOOD_WALL, south + 1.0, 'steel')
    k.guarded_flight('z', north - 15.0, north - 1.0 + 0.5, fx0, fx1, 0.0, fy - SKIN,
                     material='steel_stair', wall='steel')
    k.guarded_flight('z', south + 15.0, south + 1.0 - 0.5, fx0, fx1, 0.0, fy - SKIN,
                     material='steel_stair', wall='steel')
    k.box(fx0 + 0.5, WATER_LEVEL - 2.0, (north + south) / 2 - 1.0, fx1 - 0.5,
          fy - DECK, (north + south) / 2 + 1.0, 'steel')
    layout.keep_clear(fx0 - 3.0, north - 17.0, fx1 + 3.0, south + 17.0)


def south_bank(layout):
    """Across the river: a checkpoint, cabins, a watchtower, woods."""
    layout.broadleaf = 0.4
    k = layout.kit
    p = layout.props
    south = RIVER[1] + 0.6
    layout.road(10.0, south, 22.0, HALF - 5.0)
    layout.road(-150.0, 138.0, 146.0, 144.0, 'dirt')
    # The checkpoint at the foot of the bridge.
    layout.house(26.0, 145.0, 32.0, 151.0, 3.0, 'concrete_light', {'x0': ((146.5, 148.5),)}, None)
    for x, z in ((2.0, 147.0), (28.0, 153.0)):
        p.place('sandbags', x, z, 0.0)
        layout.keep_clear(x - 4.0, z - 1.0, x + 4.0, z + 1.0)
    p.place('roadblock', 16.0, 146.0, 0.0)
    # Cabins.
    for i, x0 in enumerate((40.0, 56.0, -60.0, -80.0)):
        layout.house(x0, 146.0, x0 + 10.0, 153.0, 3.2, ('wood', 'wood_dark')[i % 2],
                     {'z0': ((x0 + 4.0, x0 + 6.0),)}, None)
    # A watchtower over the bank, far enough back from the river that
    # jumping off it lands on this side of the flood wall.
    tx, tz = 76.0, 146.0
    for ax in (tx, tx + 3.6):
        for az in (tz, tz + 3.6):
            k.box(ax, 0.0, az, ax + 0.4, 6.0, az + 0.4, 'wood_dark')
    k.deck(tx, tz, tx + 4.0, tz + 4.0, 6.0, 'wood')
    k.flight('x', tx + 12.5, tx + 3.5, tz + 0.8, tz + 3.2, 0.0, 6.0 - SKIN, 'wood')
    layout.roofs.append((tx, tz, tx + 4.0, tz + 4.0, 6.0))
    layout.keep_clear(tx - 1.0, tz - 1.0, tx + 13.0, tz + 5.0)
    # Woods on the bank, either side.
    layout.forest(-150.0, 145.0, -90.0, 154.0, 6.5)
    layout.forest(-40.0, 145.0, 2.0, 154.0, 6.5)
    layout.forest(98.0, 145.0, 144.0, 154.0, 6.5)
    layout.scatter(['crate', 'barrel', 'pallet', 'sawhorse'], -140.0, 131.0, 140.0, 154.0, 14)


def ground_map(kit, props):
    """Where grass grows, and at what height, a metre at a time.

    The client plants tufts of grass round the player from this. A cell is
    grass when the highest thing drawn over it is a grass face - the fields,
    or the top of a tier on the ridge - and nothing stands on it: a road, a
    pad, a wall, a crate. Encoded as one byte a cell, 0 for none and
    otherwise one more than the height in quarter metres, then run-length
    coded, because most of the map is long runs of the same thing.
    """
    code = grass_code(grass_heights(kit, props))
    flat = code.reshape(-1)
    out = bytearray()
    start = 0
    while start < len(flat):
        value = flat[start]
        end = start
        while end < len(flat) and flat[end] == value and end - start < 255:
            end += 1
        out += bytes((int(value), end - start))
        start = end
    import base64
    n = code.shape[0]
    print(f'  grass on {int((code > 0).sum()):,} of {n * n:,} m2; '
          f'{len(out) / 1024:.1f} KB run-length coded')
    return {'origin': [-HALF, -HALF], 'cell': 1.0, 'size': [n, n],
            'rle': base64.b64encode(bytes(out)).decode('ascii')}


def grass_code(height):
    return np.where(height < 0, 0, np.clip(np.round(height / 0.25) + 1, 1, 255)).astype(np.uint8)


def grass_heights(kit, props):
    """The height of the grass in each square metre, or -1 for none."""
    n = int(2 * HALF)
    height = np.full((n, n), -1.0)

    def span(x0, z0, x1, z1):
        i0 = int(max(math.floor(x0 + HALF), 0))
        i1 = int(min(math.ceil(x1 + HALF), n))
        j0 = int(max(math.floor(z0 + HALF), 0))
        j1 = int(min(math.ceil(z1 + HALF), n))
        return slice(j0, j1), slice(i0, i1)

    def inner(x0, z0, x1, z1):
        # A cell is grass only if the grass face covers all of it.
        i0 = int(max(math.ceil(x0 + HALF), 0))
        i1 = int(min(math.floor(x1 + HALF), n))
        j0 = int(max(math.ceil(z0 + HALF), 0))
        j1 = int(min(math.floor(z1 + HALF), n))
        return slice(j0, j1), slice(i0, i1)

    for material, x0, z0, x1, z1, y in kit.flats:
        if material in ('grass', 'grass_dry'):
            rows, cols = inner(x0, z0, x1, z1)
            height[rows, cols] = np.maximum(height[rows, cols], y)
    for material, x0, z0, x1, z1, y in kit.flats:
        if material not in ('grass', 'grass_dry'):
            rows, cols = span(x0, z0, x1, z1)
            cut = height[rows, cols] <= y + 0.05
            height[rows, cols][cut] = -1.0
    for x0, z0, x1, z1, bottom, top in kit.footprints + props.footprints:
        rows, cols = span(x0, z0, x1, z1)
        here = height[rows, cols]
        cut = (bottom <= here + 0.3) & (top > here + 0.02)
        here[cut] = -1.0
    return height


def woodland(layout):
    """Trees wherever the country would grow them.

    The named forests are where the layout wants woods. This is the rest:
    stands and single trees across every field, thick where a slow noise
    says woodland and thin where it says pasture, so open ground is broken
    up the way real country is rather than being lawn with a copse on it.
    Only on grass, only where nothing else wants the ground.
    """
    rng = random.Random(11)
    height = grass_heights(layout.kit, layout.props)

    def noise(x, z):
        v = (math.sin(x * 0.045 + 1.3) * math.cos(z * 0.052 - 0.7)
             + 0.6 * math.sin(x * 0.11 + z * 0.083 + 2.1)
             + 0.35 * math.cos(x * 0.21 - z * 0.17))
        return v / 1.95 * 0.5 + 0.5

    placed = 0
    step = 4.2
    for gx in np.arange(-HALF + 6.0, HALF - 6.0, step):
        for gz in np.arange(-HALF + 6.0, HALF - 6.0, step):
            x = gx + rng.uniform(-0.45, 0.45) * step
            z = gz + rng.uniform(-0.45, 0.45) * step
            dense = noise(x, z)
            chance = 0.85 if dense > 0.66 else (0.12 if dense > 0.45 else 0.02)
            if rng.random() > chance:
                continue
            i, j = int(x + HALF), int(z + HALF)
            y = height[j - 1:j + 2, i - 1:i + 2]
            if y.size < 9 or y.min() < 0 or y.max() - y.min() > 0.01:
                continue
            if not layout.is_clear(x, z, pad=1.6):
                continue
            layout.kit.tree(x, z, float(y[1, 1]), height=rng.uniform(7.0, 13.5),
                            kind=tree_kind(x, z, 0.35 + 0.4 * (1.0 - dense)))
            layout.keep_clear(x - 0.8, z - 0.8, x + 0.8, z + 0.8)
            placed += 1
    print(f'  woodland: {placed} trees across the fields')


def country_height(x, z):
    """The height of the country outside the map, at a point outside it.

    It meets the map's own edge at the top of whatever stands there - the
    rock along the north and west, the low face along the south - so the
    boundary reads as the foot of a hillside rather than as a wall with sky
    behind it. East is the sea the river runs into, and west is the valley
    it comes down.
    """
    cx = min(max(x, -HALF), HALF)
    cz = min(max(z, -HALF), HALF)
    d = math.hypot(x - cx, z - cz)
    north, south = RIVER
    # The height at the nearest point of the map's edge.
    if cz <= -HALF + 1e-6 and cx < HALF - 20.0:
        edge = 13.6
    elif cx <= -HALF + 1e-6 and cz < north:
        edge = 11.6
    else:
        edge = 6.6
    # Hills: rising away from the edge, rolling along it.
    roll = (math.sin(x * 0.021 + 0.4) * math.cos(z * 0.017 - 1.1) * 14.0
            + math.sin(x * 0.047 - z * 0.039) * 6.0
            + math.sin(x * 0.11 + z * 0.093) * 2.2)
    rise = 46.0 * (1.0 - math.exp(-d / 85.0))
    h = edge + rise + roll * min(d / 40.0, 1.0)
    # Cliffs where the ground rises steepest, just past the edge.
    h += 6.0 * math.exp(-((d - 14.0) / 10.0) ** 2) * (0.5 + 0.5 * math.sin(x * 0.07 + z * 0.05))
    # The valley the river comes down, west of the map.
    middle = (north + south) / 2.0
    if x < -HALF + 12.0:
        width = 16.0 + max(-HALF - x, 0.0) * 0.22
        valley = math.exp(-((z - middle - math.sin(x * 0.02) * 12.0 * min(d / 60.0, 1.0)) / width) ** 2)
        h = h + (-3.2 - h) * valley
    # The sea: everything east, and the shore curling round the corners.
    sea = min(max((cx - (HALF - 45.0)) / 40.0, 0.0), 1.0)
    shore = -0.4 - 9.0 * (1.0 - math.exp(-d / 25.0))
    return h + (shore - h) * sea


def country(glb, kit):
    """The hills, cliffs, sea and forest outside the map. Drawn, never walked.

    A heightfield from the map's edge out to `COUNTRY`, coloured by slope and
    height a triangle at a time, as scenery: the generator skips it, so it
    neither collides nor changes the map's size. The perimeter brushes stop
    a player at the edge long before any of it.
    """
    step = 5.0
    count = int(round(2 * COUNTRY / step)) + 1
    xs = np.linspace(-COUNTRY, COUNTRY, count)
    height = np.zeros((count, count))
    for j, z in enumerate(xs):
        for i, x in enumerate(xs):
            if abs(x) < HALF - 1e-6 and abs(z) < HALF - 1e-6:
                continue
            height[j, i] = country_height(x, z)
    pieces = {}
    triangles = {}
    for j in range(count - 1):
        for i in range(count - 1):
            x0, x1, z0, z1 = xs[i], xs[i + 1], xs[j], xs[j + 1]
            if max(abs(x0), abs(x1)) <= HALF + 1e-6 and max(abs(z0), abs(z1)) <= HALF + 1e-6:
                continue
            corners = [(x0, height[j, i], z0), (x1, height[j, i + 1], z0),
                       (x1, height[j + 1, i + 1], z1), (x0, height[j + 1, i], z1)]
            for tri in ((0, 2, 1), (0, 3, 2)):
                a, b, c = (np.array(corners[t]) for t in tri)
                normal = np.cross(b - a, c - a)
                normal /= np.linalg.norm(normal)
                top = max(a[1], b[1], c[1])
                if top < 0.6:
                    surface = 'shore'
                elif abs(normal[1]) < 0.62:
                    surface = 'rock'
                elif top > 44.0:
                    surface = 'grass_dry'
                else:
                    surface = 'meadow'
                verts, faces = pieces.setdefault(surface, ([], {}))
                ids = []
                for v in (a, b, c):
                    key = (round(float(v[0]), 3), round(float(v[1]), 3), round(float(v[2]), 3))
                    if key not in faces:
                        faces[key] = len(verts)
                        verts.append(key)
                    ids.append(faces[key])
                triangles.setdefault(surface, []).append(tuple(ids))
    mesh = glb.mesh('facility_country', [(m, v, triangles[m]) for m, (v, _ids) in sorted(pieces.items())])
    glb.node('facility_country', mesh, extras={'scenery': True})

    # Forest on the hills, thick in the folds and thin on the tops.
    rng = random.Random(23)
    planted = 0
    for gz in np.arange(-COUNTRY + 4.0, COUNTRY - 4.0, 8.0):
        for gx in np.arange(-COUNTRY + 4.0, COUNTRY - 4.0, 8.0):
            x = gx + rng.uniform(-3.5, 3.5)
            z = gz + rng.uniform(-3.5, 3.5)
            if abs(x) < HALF + 3.0 and abs(z) < HALF + 3.0:
                continue
            h = country_height(x, z)
            if h < 1.5:
                continue
            slope = max(abs(country_height(x + 2.0, z) - h), abs(country_height(x, z + 2.0) - h)) / 2.0
            if slope > 0.9:
                continue
            woods = (math.sin(x * 0.019 + 2.0) * math.cos(z * 0.023) + 0.5 * math.sin(x * 0.05 - z * 0.04))
            if rng.random() > (0.9 if woods > 0.1 else 0.18):
                continue
            kind = 3 + tree_kind(x, z, 0.3 if h < 25.0 else 0.08)
            kit.trees.append((round(x, 2), round(h - 0.4, 2), round(z, 2),
                              round(rng.uniform(9.0, 16.0), 2), kind))
            planted += 1
    print(f'  country: {sum(len(f) for f in triangles.values()):,} triangles, {planted} trees')


def check_river(layout):
    """No climbable roof close enough to the river to jump into it from."""
    north, south = RIVER
    for x0, z0, x1, z1, roof in layout.roofs:
        gap = min(abs(north - z1), abs(z0 - south))
        if (z1 > north - RIVER_CLEAR and z0 < south + RIVER_CLEAR):
            raise SystemExit(
                f'a climbable roof at ({x0}, {z0})..({x1}, {z1}) is {gap:.1f} m '
                f'from the river, inside the {RIVER_CLEAR} m it must keep')


def build():
    glb = Glb()
    kit = Kit()
    kit.hidden = Kit()
    props = YardProps(glb)
    define_props(props)
    layout = Layout(kit, props)

    base(layout)
    river(layout)
    compound(layout)
    north_ridge(layout)
    mountain_and_tunnel(layout)
    village(layout)
    north_east(layout)
    west(layout)
    east(layout)
    south(layout)
    south_bank(layout)
    fields(layout)
    woodland(layout)
    check_river(layout)

    country(glb, kit)
    pieces = [(m, v, f) for m, (v, f) in sorted(kit.groups.items())]
    structure = glb.mesh('facility_structure', pieces)
    glb.node('facility_structure', structure)
    detail = [(m, v, f) for m, (v, f) in sorted(layout.detail.groups.items())]
    glb.node('facility_detail', glb.mesh('facility_detail', detail), extras={'scenery': True})
    # Collided with and never drawn: the trunks of the trees the client
    # grows. The generator reads it like any other structure.
    hidden = [(m, v, f) for m, (v, f) in sorted(kit.hidden.groups.items())]
    glb.node('facility_collision', glb.mesh('facility_collision', hidden),
             extras={'collision_only': True})
    # Put the structure first in the scene so it is the first thing a reader
    # of the file meets; the props follow it.
    roots = glb.js['scenes'][0]['nodes']
    first = next(i for i in roots if glb.js['nodes'][i]['name'] == 'facility_structure')
    roots.remove(first)
    roots.insert(0, first)

    glb.js['scenes'][0]['extras'] = {
        # Where the client draws the sea and the river. The map carries it
        # because it is a property of the ground: the arena and the yard sit
        # just above the water, this one stands well clear of it.
        'water_level': WATER_LEVEL,
        'water_colour': '#3a4f58',
        # Rectangles, in metres, the spawn picker leaves alone.
        'spawn_exclude': [list(COMPOUND)],
        # What the client grows: trees as x, y, z, height, kind in turn,
        # and where grass is.
        'smoke': layout.smoke,
        'tree_kinds': list(TREE_KINDS),
        'trees': [round(float(v), 2) for t in kit.trees for v in t],
        'ground': ground_map(kit, props),
    }
    glb.js['asset']['extras'] = {
        'title': 'Solatel facility',
        'author': 'Solatel',
        'license': 'Solatel original geometry; the dressing is repainted pieces '
                   'of the yard model, used with its owner\'s permission - see '
                   'ATTRIBUTION.md',
        'source': 'scripts/build-facility.py',
    }
    size = glb.write(MODEL)
    triangles = kit.triangles()
    print(f'facility: {triangles:,} structure triangles in {len(kit.groups)} surfaces, '
          f'{len(kit.trees)} trees, {props.placed} props from the yard, '
          f'{os.path.relpath(MODEL, ROOT)} is {size / 1024 / 1024:.2f} MB')
    return kit


def verify():
    """Read the file back as the generator will, and say what it sees."""
    derive.SCALE = 1.0
    meshes = derive.mesh_nodes(MODEL)
    every = np.vstack([m[1] for m in meshes])
    low, high = every.min(0), every.max(0)
    print(f'  reads back as {len(meshes)} meshes over x {low[0]:.1f}..{high[0]:.1f}, '
          f'y {low[1]:.1f}..{high[1]:.1f}, z {low[2]:.1f}..{high[2]:.1f}')
    if abs(low[0] + HALF) > 0.6 or abs(high[0] - HALF) > 0.6 \
            or abs(low[2] + HALF) > 0.6 or abs(high[2] - HALF) > 0.6:
        raise SystemExit('  the map is not the size it was built to be')


if __name__ == '__main__':
    build()
    verify()
    print('  now run: python scripts/derive-maps.py facility')
