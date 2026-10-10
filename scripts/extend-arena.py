#!/usr/bin/env python3
"""Add Solatel's own geometry to the arena model.

    python scripts/extend-arena.py

Everything else under `assets/` is somebody else's art, passed through
`prepare-assets.py` without a vertex moved - deliberately, because the
server's collision is derived from the same file and moving a vertex moves a
wall. This script is the one exception, and that is why it is a separate file
with a separate name: what it adds is ours, it is recorded in ATTRIBUTION.md
as ours, and it goes in under a node of its own so it can always be told
apart from the download and taken out again.

It exists because the arena has rooftops with no way up. That is not a fault
in the generator - `check-reachable.py` walks the table with the real step
rules and the routes genuinely are not there - so no amount of tuning the
voxeliser will produce them. They have to be built.

It also repaints the whole map - see `PALETTE` - which changes which
material each primitive of the original uses and nothing else. No vertex and
no index moves, so the collision cannot, and `derive-maps.py arena` producing
a byte-identical `map.rs` is the proof of that to ask for after any change to
the palette. A colour change alone needs no `MAP_VERSION` bump.

Idempotent. Everything added goes on the end of each glTF array, and the
lengths from before are recorded in `asset.extras`, so a second run truncates
the first run's work away and rebuilds it rather than stacking a second
bridge on top of the first. The same goes for the palette: the original's
materials are kept, and each repainted primitive's own is recorded.

Authoring is in game metres, the units of `map.rs` and of every measurement
in the audit scripts, and divided by the map's scale on the way out. The
alternative - authoring in the model's own quarter-size units - means every
number here has to be read against a conversion, and the one thing this file
cannot afford is a staircase whose risers are secretly 1.6 m.
"""
import importlib.util
import json
import os
import re
import struct

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.path.join(ROOT, 'assets', 'maps', 'arena.glb')
MARKER = 'solatel_extension'

# What each kind of thing we build is made of. These are surface names from
# `PALETTE` below, not material indices: the materials are appended to the
# file when it is painted, so their indices are only known at that point and
# `attach` looks them up then. Treads are light against the dark roofs on
# purpose - a way up should be visible from across the map.
STAIR = 'steel_stair'
WALL = 'concrete'
RAIL = 'steel'
ROOF = 'roof_metal'
GROUND = 'asphalt'

# Walls cycle through these, one per building, so a district reads as a
# place rather than as the same asset stamped six times.
BLOCK_WALLS = ('plaster_tan', 'plaster_olive', 'plaster_maroon', 'plaster_sand')

# A player is 1.8 m tall and steps up 0.65 m. Every piece here is built from
# these, and the rise is well under the limit on purpose: a tread at exactly
# the maximum is a tread that stops working the moment anything is quantised.
STEP_RISE = 0.30
STEP_RUN = 0.50
DECK = 0.25     # how thick a walkable slab is
RAIL_H = 0.35   # low enough to step over, high enough to read as an edge

# The tallest riser this file will emit, against `MAX_STEP_UP` of 0.65 in
# the simulation. The margin is for quantisation: the generator rounds every
# surface to the nearest 0.25 m, so a riser authored at 0.64 can come back
# as 0.75 and turn the flight into a wall.
MAX_RISE = 0.50

# Ramps, which are what a way up is in the arena now (see `Parts.ramp`). The
# slope is light like the treads were, so a way up still reads from across
# the map, and its side walls are the plain concrete of the arena's own.
RAMP = 'concrete_light'
RAMP_WALL = 'concrete'
RAMP_WIDTH = 3.0
# How far a ramp's side walls stand over it: under the 1.13 m a jump
# clears, so leaving over one is a choice, and well over the 0.65 m a
# player steps up, so nobody walks off the side by accident.
PARAPET = 1.0
# How high the slope gets before its walls are at their full height. Below
# it they rise from nothing, so the low end can be stepped onto from the
# side as well as walked onto from the foot.
PARAPET_FROM = 0.75

# The generator's grid: cells a quarter of a metre on a side, starting at
# the lowest x and z of the structure - which is the outer walls this file
# builds, so it is known here. A hidden collision column has to sit inside
# one cell to be exactly one cell; see `Parts.ramp`.
CELL = 0.25


def grid_origin(axis):
    return -NEW_EDGE - 1.0 if axis == 'x' else -ENDS


# How far our geometry is held off the original's, wherever the two would
# otherwise share a plane. Two faces at exactly the same depth z-fight: the
# renderer has no way to choose between them and the surface flickers in
# stripes as the camera moves. Every number below that looks like it is two
# centimetres short of a round figure is short of it for this reason - the
# ground slab under the old floor, our boundary wall under the arena's lid,
# a flight's last tread under the roof it lands on. Two centimetres is far
# below the 0.25 m the collision quantises to, so none of it moves a
# surface a player stands on.
SKIN = 0.02


def read_glb(path):
    with open(path, 'rb') as handle:
        data = handle.read()
    if data[:4] != b'glTF':
        raise ValueError(f'{path} is not a binary glTF')
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


def write_glb(js, blob, out_path):
    chunk = json.dumps(js, separators=(',', ':')).encode('utf-8')
    chunk += b' ' * ((4 - len(chunk) % 4) % 4)
    binary = blob + b'\0' * ((4 - len(blob) % 4) % 4)
    total = 12 + 8 + len(chunk) + 8 + len(binary)
    with open(out_path, 'wb') as handle:
        handle.write(b'glTF' + struct.pack('<II', 2, total))
        handle.write(struct.pack('<II', len(chunk), 0x4E4F534A) + chunk)
        handle.write(struct.pack('<II', len(binary), 0x004E4942) + binary)
    return total


def scale_of(name):
    """The scale the map is generated at, from `derive-maps.py`, never here."""
    spec = importlib.util.spec_from_file_location(
        'derive_maps', os.path.join(ROOT, 'scripts', 'derive-maps.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for map_name, scale, *_ in module.MAPS:
        if map_name == name:
            return scale
    raise SystemExit(f'no map called {name!r} in derive-maps.py')


class Parts:
    """Boxes in game metres, grouped by material.

    Boxes, with one exception: a ramp (`ramp`), whose slope is drawn as the
    plane it is while its collision is built separately as the steps the
    generator would have made of it anyway. The collision is a table of
    axis-aligned boxes, so what collides is always boxes; a staircase built
    of them looked like one, and Conrad wanted ways up that read as one
    plane and could be walked up off line.
    """

    def __init__(self):
        self.groups = {}
        self.log = []
        # Geometry that is drawn and never collided with, and geometry that
        # is collided with and never drawn - each a `Parts` of its own when
        # something here needs one (`main` gives them), written to a node of
        # its own by `attach`.
        self.drawn = None
        self.hidden = None
        # Boxes the generator must take exactly as they are: each is written
        # as a node of its own (`attach`), which it judges as a prop and
        # collides with as precisely its box - never voxelised, never
        # smoothed. See `ramp` for why a ramp's walls need that.
        self.exact = []

    def face(self, points, material, outward):
        """A flat convex polygon, wound to face `outward`.

        The winding is not cosmetic. The light bake takes the back of a face
        for the inside of something solid, so a face wound the wrong way
        darkens the air in front of it.
        """
        verts, faces = self.groups.setdefault(material, ([], []))
        p = np.asarray(points, dtype=np.float64)
        normal = np.cross(p[1] - p[0], p[2] - p[0])
        if np.dot(normal, outward) < 0:
            p = p[::-1]
        base = len(verts)
        verts.extend(tuple(float(v) for v in q) for q in p)
        for i in range(1, len(p) - 1):
            faces.append((base, base + i, base + i + 1))
        return self

    def column(self, axis, at, cross0, cross1, top):
        """One cell of the generator's grid along `axis`, from `at`, solid
        from the ground to `top` across `cross0`..`cross1`.

        Held a centimetre inside the cell on every side. A face lying on a
        cell boundary is counted in the cell above it, so a box exactly a
        cell deep marks two, and a ramp built of those is a step deeper
        than it was drawn everywhere.
        """
        a, b = at + 0.01, at + CELL - 0.01
        c, d = cross0 + 0.01, cross1 - 0.01
        if axis == 'x':
            return self.box(a, 0.0, c, b, top + 0.01, d, material=RAMP)
        return self.box(c, 0.0, a, d, top + 0.01, b, material=RAMP)

    def ramp(self, axis, foot, edge, cross0, y_to, into=0.5, walls=(True, True),
             width=RAMP_WIDTH):
        """A straight slope from the ground at `foot` to `y_to` at `edge`.

        What replaced the flights of stairs, at Conrad's asking: a staircase
        seen from the side is a zigzag, and walked up a few degrees off its
        line it put players off its open side. A ramp is one plane, wider,
        with a wall down each side.

        What is drawn and what collides are different things here, on
        purpose. The collision is boxes and cannot slope, so the slope is
        drawn (`self.drawn`, never collided with) and the collision is a
        column of the generator's own grid for every cell along the run
        (`self.hidden`, never drawn), each solid from the ground to the
        quarter metre nearest the drawn slope over its middle. A player
        walking up climbs quarter-metre steps a cell apart - well under
        `MAX_STEP_UP`, and smoothed out of the view by the eye's own filter
        - with their feet never more than an eighth of a metre and a bit off
        the slope they see. Solid from the ground, because a slope with air
        under it is a place to hide under.

        The walls collide as exact boxes, a cell long each, their tops on the
        drawn wall's (`self.hidden.exact`). Voxelised with everything else
        they were taken for walls by the generator's smoothing, which votes a
        cell to the level most common round it - and along a sloped wall
        every level is different, so each was voted down to the lowest in
        reach, and near the top the wall stood half a metre over the slope:
        a step, onto it and off the outside.

        `cross0` is where the slope's own width starts on the cross axis,
        and is snapped to the grid; the walls stand a cell either side of
        it. The collision carries on `into` past `edge` at full height, so
        the top overlaps whatever it lands on - a seam at the top of a way
        up is the whole way up wasted. `walls` says, per side, whether it
        has one: True to the edge, a run coordinate to stop it sooner, or
        False for none.
        """
        if self.drawn is None or self.hidden is None:
            raise ValueError('a ramp needs parts.drawn and parts.hidden')
        sign = 1.0 if edge > foot else -1.0
        run = abs(edge - foot)
        cells = width / CELL
        if abs(cells - round(cells)) > 1e-6:
            raise ValueError(f'a ramp {width} m wide is not a whole number of cells')
        cross_axis = 'z' if axis == 'x' else 'x'
        c_origin = grid_origin(cross_axis)
        c0 = c_origin + round((cross0 - c_origin) / CELL) * CELL
        c1 = c0 + width

        def surface(r):
            t = (r - foot) / (edge - foot)
            return y_to * min(max(t, 0.0), 1.0)

        def wall_top(r):
            v = surface(r)
            return v + PARAPET * min(1.0, v / PARAPET_FROM)

        def at(r, y, c):
            return (r, y, c) if axis == 'x' else (c, y, r)

        stops = []
        for side in walls:
            if side is False:
                stops.append(None)
            elif side is True:
                stops.append(edge)
            else:
                stops.append(float(side))

        # The collision: a column a cell along the run, for every cell whose
        # middle the ramp covers.
        origin = grid_origin(axis)
        lo, hi = sorted((foot, edge + sign * into))
        first = int(np.floor((lo - origin) / CELL))
        last = int(np.ceil((hi - origin) / CELL))
        for k in range(first, last):
            start = origin + k * CELL
            middle = start + CELL / 2.0
            if not lo <= middle <= hi:
                continue
            height = round(surface(middle) / CELL) * CELL
            if height > 0:
                self.hidden.column(axis, start, c0, c1, height)
            for stop, (w0, w1) in zip(stops, ((c0 - CELL, c0), (c1, c1 + CELL))):
                if stop is None:
                    continue
                a, b = max(start, min(foot, stop)), min(start + CELL, max(foot, stop))
                if b - a < 0.01:
                    continue
                top = wall_top(middle)
                if axis == 'x':
                    self.hidden.exact.append((a, 0.0, w0, b, top, w1))
                else:
                    self.hidden.exact.append((w0, 0.0, a, w1, top, b))

        # What is drawn: the slope, carried a few centimetres into the walls
        # either side so that no face of it shares a plane with one. Its back
        # and its underside are never seen - against a wall, on the ground -
        # and would share planes with both, so they are left out.
        d = self.drawn
        e0, e1 = c0 - 0.05, c1 + 0.05
        up = np.array(at(0.0, 1.0, 0.0))
        across = np.array(at(0.0, 0.0, 1.0))
        d.face([at(foot, 0.0, e0), at(foot, 0.0, e1),
                at(edge, y_to, e1), at(edge, y_to, e0)], RAMP, up)
        d.face([at(foot, 0.0, e0), at(edge, y_to, e0), at(edge, 0.0, e0)],
               RAMP, -across)
        d.face([at(foot, 0.0, e1), at(edge, 0.0, e1), at(edge, y_to, e1)],
               RAMP, across)

        # The walls: their top follows the slope a parapet's height over it,
        # rising from nothing at the foot until the slope is `PARAPET_FROM`
        # up. Each is drawn as its two long faces and its top; its end is
        # drawn only where it stops short of the edge, since otherwise it is
        # against a wall.
        rise = foot + sign * min(PARAPET_FROM / y_to, 1.0) * run
        for stop, (w0, w1), out in zip(stops, ((c0 - CELL, c0), (c1, c1 + CELL)),
                                       (-across, across)):
            if stop is None:
                continue
            profile = [foot]
            if (rise - foot) * sign < (stop - foot) * sign:
                profile.append(rise)
            profile.append(stop)
            for c, facing in ((w0, -across), (w1, across)):
                points = [at(foot, 0.0, c), at(stop, 0.0, c)]
                points += [at(r, wall_top(r), c) for r in reversed(profile[1:])]
                d.face(points, RAMP_WALL, facing)
            for r0, r1 in zip(profile, profile[1:]):
                d.face([at(r0, wall_top(r0), w0), at(r1, wall_top(r1), w0),
                        at(r1, wall_top(r1), w1), at(r0, wall_top(r0), w1)],
                       RAMP_WALL, up)
            if stop != edge:
                d.face([at(stop, 0.0, w0), at(stop, 0.0, w1),
                        at(stop, wall_top(stop), w1), at(stop, wall_top(stop), w0)],
                       RAMP_WALL, np.array(at(sign, 0.0, 0.0)))
        self.log.append(
            f'    a ramp {width:.1f} m wide, 0 to {y_to:.2f} m over {run:.2f} m '
            f'({np.degrees(np.arctan2(y_to, run)):.0f} degrees)')
        return self

    def solid(self, x0, z0, x1, z1, top, material=RAMP, walls=()):
        """A block standing on the ground - a landing - drawn whole and
        collided with as a column of the grid in every cell it covers.

        Built as its own box it would be a shell to the generator, which
        marks surfaces and not volumes: a lid over hollow columns. `walls`
        are sides (`'x0'`, `'x1'`, `'z0'`, `'z1'`) to put a parapet along,
        a cell outside it, colliding exactly as a ramp's walls do.
        """
        self.drawn.box(x0, 0.0, z0, x1, top, z1, material)
        ox = grid_origin('x')
        for i in range(int(np.floor((x0 - ox) / CELL)), int(np.ceil((x1 - ox) / CELL))):
            start = ox + i * CELL
            if x0 <= start + CELL / 2.0 <= x1:
                self.hidden.column('x', start, z0, z1, round(top / CELL) * CELL)
        for side in walls:
            if side in ('z0', 'z1'):
                z = z0 - CELL if side == 'z0' else z1
                wall = (x0, 0.0, z, x1, top + PARAPET, z + CELL)
            else:
                # Along x, and round the corner of any wall along z, so the
                # two meet rather than leaving a notch between them.
                x = x0 - CELL if side == 'x0' else x1
                a = z0 - (CELL if 'z0' in walls else 0.0)
                b = z1 + (CELL if 'z1' in walls else 0.0)
                wall = (x, 0.0, a, x + CELL, top + PARAPET, b)
            self.drawn.box(*wall, RAMP_WALL)
            self.hidden.exact.append(wall)
        return self

    def box(self, x0, y0, z0, x1, y1, z1, material=STAIR):
        if x1 <= x0 or y1 <= y0 or z1 <= z0:
            raise ValueError(f'inside-out box ({x0},{y0},{z0})..({x1},{y1},{z1})')
        verts, faces = self.groups.setdefault(material, ([], []))
        base = len(verts)
        verts.extend([
            (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
            (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
        ])
        for a, b, c in ((0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
                        (0, 4, 7), (0, 7, 3), (1, 2, 6), (1, 6, 5),
                        (0, 1, 5), (0, 5, 4), (3, 7, 6), (3, 6, 2)):
            faces.append((base + a, base + b, base + c))
        return self

    def deck(self, x0, z0, x1, z1, top, material=STAIR, thickness=DECK):
        """A walkable slab, given the height of the surface walked on."""
        return self.box(x0, top - thickness, z0, x1, top, z1, material)

    def rails(self, x0, z0, x1, z1, top, along, material=RAIL, width=0.15):
        """Edging down the two long sides of a deck. Costly; see below.

        Nothing uses this at present, and anything that wants to must give
        the deck the width to pay for it. A railing is thinner than a cell,
        and brushes are cut on cell boundaries, so a 0.15 m rail is rounded
        out to a 0.25 m brush that lands on the walkway beside it - and
        because it stands 0.35 m proud of the deck, it is then inside the
        head height of the surface it is standing on, so that surface stops
        counting as somewhere to stand at all. Two rails on a 1.2 m landing
        left 0.2 m of walkable deck and stranded the roof they served.

        So: a rail costs a cell of deck either side, plus the cell the audit
        will not stand in next to it. Budget a metre of width for the pair
        before adding any.
        """
        if along == 'z':
            self.box(x0, top, z0, x0 + width, top + RAIL_H, z1, material)
            self.box(x1 - width, top, z0, x1, top + RAIL_H, z1, material)
        else:
            self.box(x0, top, z0, x1, top + RAIL_H, z0 + width, material)
            self.box(x0, top, z1 - width, x1, top + RAIL_H, z1, material)
        return self

    def flight(self, axis, start, end, cross0, cross1, y_from, y_to,
               material=STAIR, rail=False):
        """A straight run of steps from `start` to `end` along `axis`.

        Each tread is its own box, spanning only its own depth and solid from
        the ground up to its surface. That last part is not cosmetic. The
        first version built the flight as nested boxes each running to the
        far end, which is the same solid - and `voxelise` marks the cells a
        *surface* passes through, not the cells inside a volume. So every
        column along the flight was stamped with the top face of every tread
        above it, and the stair came back as a stack of floating slabs with
        quarter-metre gaps between them and a 0.75 m lift onto the last one.
        One box per tread means one surface per column, which is what a
        staircase is.

        The step count comes from the run available, not from the rise, and
        is then checked against what a player can actually step up. Sizing it
        from the rise instead gives a stair with the right risers and treads
        too shallow to stand on.
        """
        run = abs(end - start)
        rise = y_to - y_from
        count = max(int(round(run / STEP_RUN)), 1)
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
            top = y_from + each * (i + 1)
            if axis == 'x':
                self.box(lo, base, cross0, hi, top, cross1, material)
                if rail:
                    self.box(lo, top, cross0, hi, top + RAIL_H,
                             cross0 + 0.15, RAIL)
                    self.box(lo, top, cross1 - 0.15, hi, top + RAIL_H,
                             cross1, RAIL)
            else:
                self.box(cross0, base, lo, cross1, top, hi, material)
                if rail:
                    self.box(cross0, top, lo, cross0 + 0.15, top + RAIL_H,
                             hi, RAIL)
                    self.box(cross1 - 0.15, top, lo, cross1, top + RAIL_H,
                             hi, RAIL)
        self.log.append(
            f'    {count} steps of {each:.2f} m rise and {tread:.2f} m tread, '
            f'{y_from:.2f} to {y_to:.2f} m over {run:.2f} m')
        return self

    def wall(self, x0, z0, x1, z1, y0, y1, gaps=(), material=WALL, head=2.6):
        """A wall, with doorways left in it.

        `gaps` are (start, end) pairs along the wall's long axis. The wall
        carries on above each one rather than being cut to the roof, which
        is both what a doorway looks like and free: `obstacle_heights`
        decides a column is blocked only from what stands in the player's
        own band, up to 2.0 m, so a lintel at 2.6 m leaves the opening open.
        """
        along_x = (x1 - x0) >= (z1 - z0)
        lo, hi = (x0, x1) if along_x else (z0, z1)
        edges = [lo]
        for a, b in sorted(gaps):
            edges += [min(max(a, lo), hi), min(max(b, lo), hi)]
        edges.append(hi)
        for i in range(0, len(edges) - 1, 2):
            a, b = edges[i], edges[i + 1]
            if b - a < 0.05:
                continue
            if along_x:
                self.box(a, y0, z0, b, y1, z1, material)
            else:
                self.box(x0, y0, a, x1, y1, b, material)
        for a, b in gaps:
            a, b = min(max(a, lo), hi), min(max(b, lo), hi)
            if b - a < 0.05 or y1 <= head:
                continue
            if along_x:
                self.box(a, head, z0, b, y1, z1, material)
            else:
                self.box(x0, head, a, x1, y1, b, material)
        return self

    def block(self, x0, z0, x1, z1, roof, doors=(), thickness=0.4,
              material=WALL):
        """A building: four walls with doorways, and a roof over them."""
        t = thickness
        d = dict(doors)
        # Up to inside the roof slab, not up to the roof. A wall whose top
        # face is level with the roof's shares a plane with it all the way
        # round the building; ending under it puts that face inside solid,
        # where it is never drawn.
        head = roof - DECK * 0.5
        self.wall(x0, z0, x1, z0 + t, 0.0, head, d.get('z0', ()), material)
        self.wall(x0, z1 - t, x1, z1, 0.0, head, d.get('z1', ()), material)
        self.wall(x0, z0 + t, x0 + t, z1 - t, 0.0, head, d.get('x0', ()),
                  material)
        self.wall(x1 - t, z0 + t, x1, z1 - t, 0.0, head, d.get('x1', ()),
                  material)
        self.deck(x0, z0, x1, z1, roof, material=ROOF)
        return self

    def roof_stair(self, side, x0, z0, x1, z1, roof, width=2.4):
        """A flight up the outside of a block, landing on its roof.

        It ends half a metre *inside* the footprint so the top tread and the
        roof slab overlap. A flight that merely reaches the edge leaves the
        voxeliser a seam, and a seam at the top of a staircase is the whole
        staircase wasted.
        """
        run = roof * 1.2
        if side in ('x0', 'x1'):
            middle = (z0 + z1) / 2.0
            near, into = (x0, x0 + 0.5) if side == 'x0' else (x1, x1 - 0.5)
            start = near - run if side == 'x0' else near + run
            self.flight('x', start, into, middle - width / 2.0,
                        middle + width / 2.0, 0.0, roof - SKIN)
        else:
            middle = (x0 + x1) / 2.0
            near, into = (z0, z0 + 0.5) if side == 'z0' else (z1, z1 - 0.5)
            start = near - run if side == 'z0' else near + run
            self.flight('z', start, into, middle - width / 2.0,
                        middle + width / 2.0, 0.0, roof - SKIN)
        return self

    def roof_ramp(self, side, x0, z0, x1, z1, roof, run, corner):
        """A ramp up the outside of a block onto its roof (see `ramp`).

        It goes beside the block's door on that side, at the `corner`
        ('-' or '+' along the cross axis) - the flights it replaced stood in
        front of the doors and shut them. The walls stay inside the block's
        width, so a ramp is no wider than the building it climbs.
        """
        if side not in ('z0', 'z1'):
            raise ValueError('roof ramps run along z: the lanes are that way')
        edge = z1 if side == 'z1' else z0
        foot = edge + run if side == 'z1' else edge - run
        cross0 = x0 + CELL if corner == '-' else x1 - CELL - RAMP_WIDTH
        return self.ramp('z', foot, edge, cross0, roof - SKIN)

    def cover(self, x, z, low=0.55, high=1.05, size=1.2):
        """A pair of crates: one to walk onto, one to climb from it.

        Nothing here is taller than a step from the thing beside it. A lone
        1.2 m crate is cover a player can jump onto and `check-reachable`
        will call its top stranded, correctly - it is not reachable *on
        foot*, and a map whose high ground needs bunny-hopping is the thing
        these audits exist to catch.
        """
        self.box(x, 0.0, z, x + size, low, z + size, 'wood')
        self.box(x + size, 0.0, z, x + 2 * size, high, z + size, 'crate_olive')
        return self

    def arrays(self, scale):
        for material, (verts, faces) in sorted(self.groups.items()):
            yield (material,
                   np.asarray(verts, dtype=np.float32) / scale,
                   np.asarray(faces, dtype=np.uint32))

    def triangles(self):
        return sum(len(faces) for _verts, faces in self.groups.values())

    def bounds(self):
        every = [v for verts, _f in self.groups.values() for v in verts]
        low = np.asarray(every, dtype=np.float64).min(0)
        high = np.asarray(every, dtype=np.float64).max(0)
        return list(zip(low, high))


def strip_previous(js, blob):
    """Undo an earlier run, so this one starts from the original download."""
    extras = js.setdefault('asset', {}).setdefault('extras', {})
    mark = extras.pop(MARKER, None)
    if not mark:
        return blob
    # Put back any primitive whose indices were swapped for a shortened
    # copy. The original accessor is still there - nothing is ever deleted,
    # only pointed away from - so this is exact.
    for mesh, prim, accessor in mark.get('repointed', []):
        js['meshes'][mesh]['primitives'][prim]['indices'] = accessor
    # And every primitive that was repainted, back onto the material it
    # came with. The download's own materials are still in the file, ahead
    # of the ones `paint` appends, so this too is exact.
    for mesh, prim, material in mark.get('repainted', []):
        js['meshes'][mesh]['primitives'][prim]['material'] = material
    if 'materials' in mark:
        del js['materials'][mark['materials']:]
    scene = js['scenes'][js.get('scene', 0)]
    before = len(scene['nodes'])
    scene['nodes'] = [n for n in scene['nodes'] if n < mark['nodes']]
    for key in ('nodes', 'meshes', 'accessors', 'bufferViews'):
        del js[key][mark[key]:]
    print(f'  removed the previous extension '
          f'({before - len(scene["nodes"])} root node, '
          f'{len(mark.get("repointed", []))} restored primitive, '
          f'{len(mark.get("repainted", []))} repainted primitive, '
          f'{len(blob) - mark["bytes"]:,} bytes)')
    return blob[:mark['bytes']]


def world_matrix(js, mesh_index):
    """The transform the generator will apply to this mesh, as it applies it."""
    spec = importlib.util.spec_from_file_location(
        'derive', os.path.join(ROOT, 'scripts', 'derive-brushes.py'))
    derive = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(derive)
    nodes = js['nodes']
    found = {}

    def walk(index, parent):
        here = parent @ derive.node_matrix(nodes[index])
        if nodes[index].get('mesh') == mesh_index:
            found['m'] = here
        for child in nodes[index].get('children', []):
            walk(child, here)

    for root in js['scenes'][js.get('scene', 0)]['nodes']:
        walk(root, np.eye(4))
    return found.get('m')


def retire_triangles(js, blob, mesh_name, doomed, scale):
    """Point a mesh's primitive at a copy of its indices with some left out.

    Used to take down the arena's own outer wall where the map now carries
    on past it. There is no way to do that by adding geometry - a wall is
    removed or it is not - and the wall and the ground plane are the same
    64 triangle mesh, so dropping the mesh outright would drop the floor of
    the map with it.

    Nothing is deleted. The original index accessor stays exactly where it
    is and the primitive is pointed at a new one; `strip_previous` points it
    back. That is what keeps this script safe to run on a file it has
    already run on, with no pristine copy anywhere to fall back to.

    `doomed` is given each triangle's centre in game metres and says which
    to leave out.
    """
    spec = importlib.util.spec_from_file_location(
        'derive', os.path.join(ROOT, 'scripts', 'derive-brushes.py'))
    derive = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(derive)

    index = next((i for i, m in enumerate(js['meshes'])
                  if m.get('name') == mesh_name), None)
    if index is None:
        raise SystemExit(f'no mesh called {mesh_name!r} to cut')
    matrix = world_matrix(js, index)
    if matrix is None:
        raise SystemExit(f'{mesh_name} is in no scene; cannot place it')

    buffer = bytearray(blob)
    repointed = []
    removed = 0
    for slot, prim in enumerate(js['meshes'][index]['primitives']):
        points = derive.accessor(js, blob, prim['attributes']['POSITION'])
        homogeneous = np.hstack([points, np.ones((len(points), 1))])
        world = (matrix @ homogeneous.T).T[:, :3] * scale
        if 'indices' in prim:
            faces = derive.accessor(
                js, blob, prim['indices']).astype(np.uint32).reshape(-1, 3)
        else:
            faces = np.arange(len(points), dtype=np.uint32).reshape(-1, 3)
        centres = world[faces].mean(axis=1)
        keep = ~doomed(centres)
        if keep.all():
            continue
        removed += int((~keep).sum())

        kept = faces[keep].reshape(-1)
        while len(buffer) % 4:
            buffer.append(0)
        js['bufferViews'].append({
            'buffer': 0, 'byteOffset': len(buffer),
            'byteLength': int(kept.nbytes), 'target': 34963, 'name': MARKER,
        })
        buffer.extend(kept.tobytes())
        js['accessors'].append({
            'bufferView': len(js['bufferViews']) - 1, 'componentType': 5125,
            'count': len(kept), 'type': 'SCALAR',
        })
        repointed.append((index, slot, prim.get('indices')))
        prim['indices'] = len(js['accessors']) - 1

    return bytes(buffer), repointed, removed


def attach(js, blob, parts, scale, before, repointed, repainted, surfaces):
    """Append the geometry as one mesh under one node of its own.

    One mesh, not one per piece, and that matters: `derive-brushes.classify`
    gives a small solid box its own bounding box as a prop, which is right
    for a crate and would be catastrophic for a building - the interior would
    fill in. A single large mesh full of air fails both the volume and the
    solidity test, so it goes down the structure path and is voxelised.
    """
    extras = js.setdefault('asset', {}).setdefault('extras', {})
    extras[MARKER] = dict(
        before,
        repointed=repointed,
        repainted=repainted,
        what='Geometry authored for Solatel, not part of the original model, '
             'and the whole map repainted in a palette of our own.',
    )

    buffer = bytearray(blob)

    def add(data, target):
        while len(buffer) % 4:
            buffer.append(0)
        js['bufferViews'].append({
            'buffer': 0, 'byteOffset': len(buffer),
            'byteLength': int(data.nbytes), 'target': target, 'name': MARKER,
        })
        buffer.extend(data.tobytes())
        return len(js['bufferViews']) - 1

    def node(name, layer, extras):
        primitives = []
        for material, verts, faces in layer.arrays(scale):
            js['accessors'].append({
                'bufferView': add(verts, 34962), 'componentType': 5126,
                'count': len(verts), 'type': 'VEC3',
                'min': verts.min(0).tolist(), 'max': verts.max(0).tolist(),
            })
            position = len(js['accessors']) - 1
            flat = faces.reshape(-1)
            js['accessors'].append({
                'bufferView': add(flat, 34963), 'componentType': 5125,
                'count': len(flat), 'type': 'SCALAR',
            })
            primitives.append({
                'attributes': {'POSITION': position},
                'indices': len(js['accessors']) - 1,
                'material': surfaces[material],
            })
        if not primitives:
            return
        js['meshes'].append({'name': name, 'primitives': primitives})
        js['nodes'].append({'name': name, 'mesh': len(js['meshes']) - 1})
        if extras:
            js['nodes'][-1]['extras'] = extras
        # A scene root of its own, with no transform. The download's root
        # carries a Z-up to Y-up rotation; sitting outside it means these
        # coordinates are the world's, which is the whole point of authoring
        # in metres.
        js['scenes'][js.get('scene', 0)]['nodes'].append(len(js['nodes']) - 1)

    def exact(boxes):
        """Boxes the generator takes as they are: one unit cube, placed by
        a node per box under one hidden parent, as `build-facility.py`
        places its racks."""
        if not boxes:
            return
        cube = Parts()
        cube.box(0.0, 0.0, 0.0, 1.0, 1.0, 1.0, RAMP_WALL)
        verts, faces = cube.groups[RAMP_WALL]
        verts = np.asarray(verts, dtype=np.float32)
        flat = np.asarray(faces, dtype=np.uint32).reshape(-1)
        js['accessors'].append({
            'bufferView': add(verts, 34962), 'componentType': 5126,
            'count': len(verts), 'type': 'VEC3',
            'min': verts.min(0).tolist(), 'max': verts.max(0).tolist(),
        })
        js['accessors'].append({
            'bufferView': add(flat, 34963), 'componentType': 5125,
            'count': len(flat), 'type': 'SCALAR',
        })
        js['meshes'].append({'name': MARKER + '_exact', 'primitives': [{
            'attributes': {'POSITION': len(js['accessors']) - 2},
            'indices': len(js['accessors']) - 1,
            'material': surfaces[RAMP_WALL],
        }]})
        mesh = len(js['meshes']) - 1
        children = []
        for i, (x0, y0, z0, x1, y1, z1) in enumerate(boxes):
            js['nodes'].append({
                'name': f'{MARKER}_exact.{i:03d}', 'mesh': mesh,
                'translation': [x0 / scale, y0 / scale, z0 / scale],
                'scale': [(x1 - x0) / scale, (y1 - y0) / scale, (z1 - z0) / scale],
            })
            children.append(len(js['nodes']) - 1)
        js['nodes'].append({'name': MARKER + '_exact', 'children': children,
                            'extras': {'collision_only': True}})
        js['scenes'][js.get('scene', 0)]['nodes'].append(len(js['nodes']) - 1)

    node(MARKER, parts, None)
    # The ramps: drawn and never collided with, and their collision, never
    # drawn. Two nodes because those are properties of a node - the
    # generator skips `scenery`, and the client, the light bake and the
    # scatter all skip `collision_only`.
    if parts.drawn is not None:
        node(MARKER + '_drawn', parts.drawn, {'scenery': True})
    if parts.hidden is not None:
        node(MARKER + '_collision', parts.hidden, {'collision_only': True})
        exact(parts.hidden.exact)
    return bytes(buffer)


def verify(scale, expected):
    """Read the file back the way the generator will, and check it landed.

    Worth the seconds it costs. Everything here is authored blind against a
    frame with a rotation and a scale in it, and the failure mode of getting
    either wrong is not an error - it is a staircase built correctly
    somewhere nobody will ever stand.
    """
    spec = importlib.util.spec_from_file_location(
        'derive', os.path.join(ROOT, 'scripts', 'derive-brushes.py'))
    derive = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(derive)
    derive.SCALE = scale
    for name, verts, _faces in derive.mesh_nodes(MODEL):
        if name != MARKER:
            continue
        low, high = verts.min(0), verts.max(0)
        print(f'  reads back at x {low[0]:.2f}..{high[0]:.2f}, '
              f'y {low[1]:.2f}..{high[1]:.2f}, z {low[2]:.2f}..{high[2]:.2f} '
              f'(metres, as the server will see it)')
        for axis, i in (('x', 0), ('y', 1), ('z', 2)):
            want_lo, want_hi = expected[i]
            if abs(low[i] - want_lo) > 0.02 or abs(high[i] - want_hi) > 0.02:
                raise SystemExit(
                    f'  {axis} came back {low[i]:.2f}..{high[i]:.2f}, wanted '
                    f'{want_lo:.2f}..{want_hi:.2f} - the frame is wrong')
        print('  bounds match what was asked for')
        return
    raise SystemExit(f'  no {MARKER} node in the file after writing it')


# Where the arena stops today and where it stops once this has run. The
# download is a closed box 39 by 75 m: floor, a lid at 9.2 m, and double
# walls at x +/-19.55 and z +/-37.72. Carrying on east means taking the east
# wall down, which is what `retire_triangles` is for.
OLD_EDGE = 19.55

# Where `Plane_0`, the grey ground quad that is now the arena's only floor,
# actually stops. The enclosing box reaches 19.55 but that plane does not,
# so the new ground has to start here or there is a 23 cm slot of nothing
# at each gateway.
PLANE_EDGE = 19.32
NEW_EDGE = 50.0
WALL_TOP = 9.20 - SKIN
ENDS = 37.72


def redundant_original(centres):
    """Triangles of `floors_0` that have to go, and nothing else.

    Two groups, for two different reasons.

    The east and west walls: vertical and out past x 18, so the map can
    carry on past where they stood. The y test keeps the floor at 0 and the
    lid at 9.2 out of it, and the north and south walls are safe because
    their quads are wide enough that the centres sit near x 0 however they
    are split.

    And the floor. `floors_0` carries a full-map ground quad in
    'material_9', a red-orange, at y 0 - and `Plane_0` carries another one
    in 'plane', the dark grey, at y 0 as well. Two ground planes at exactly
    the same depth over the whole arena, so the renderer has no way to
    choose between them and the floor flickers grey and orange in bands as
    the camera moves. The grey one is the ground the map is meant to have;
    this drops the orange one under it.
    """
    walls = ((np.abs(centres[:, 0]) > 18.0)
             & (centres[:, 1] > 0.5) & (centres[:, 1] < 9.0))
    floor = np.abs(centres[:, 1]) < 0.05
    return walls | floor


def room_floor(centres):
    """`room_0`'s faces at ground level, and nothing else of it.

    The building in the middle of the arena carries its own floor at y 0,
    64 m2 of it in 'material_6', the orange. It faces down, which would hide
    it from above if faces were culled - but the client draws every map
    material double-sided, so from inside the building it is drawn at
    exactly the depth of the grey ground under it, and the floor flickers
    orange and grey there the same way the whole arena used to. Nothing of
    `room_0` above the ground is touched: its upper floor is at 4.6 m.
    """
    return np.abs(centres[:, 1]) < 0.05


def east_district(parts):
    """A second half to the arena, east of the wall that used to end it.

    The arena is a small map - 2,950 m2 of floor against the yard's 29,000 -
    and it plays smaller than that, because a third of it is the one
    compound in the middle. This adds 30 by 75 m of new ground on the far
    side of the east wall, with buildings that have insides, doors, roofs
    and a way onto every roof.

    Everything here is laid out to satisfy the two rules this file has
    learnt the hard way. Nothing is built over anything that reaches head
    height, because the generator used to weld those together (it now joins
    them only within a step - see `build`): the blocks are solid from the
    floor and the only things above the ground are their own roofs. And
    every roof gets a flight, sited in the open lanes between blocks where
    there is room for its run, because a roof without one is exactly the
    56 m2 of unreachable corner this whole exercise started from.
    """
    # The old east wall goes back up, with gates in it, on the line it stood
    # on. Taking it away and leaving the side open was wrong twice over: the
    # arena stops reading as a compound, and the wall was doing work. The
    # staircase at x 16.3 to 18.6 runs right along it, and a player climbing
    # that flight six degrees off straight used to be kept on it by the
    # wall. Without it they walk off the east side three quarters of the way
    # up - which `climbing_a_staircase_does_not_shove_the_player_sideways`
    # caught, having been written for a different cause entirely.
    #
    # Three gates rather than one, sited between the two staircases and
    # clear of both, so crossing between the halves is not a single
    # chokepoint everyone camps.
    # The gates are cut to full height rather than arched. A lintel would
    # look better and would shut them: `choose_spawns` counts a column as
    # ground only when everything in it tops out under 2.5 m, so a beam
    # across the opening - whose top is the 9.2 m wall - makes the gateway
    # read as solid. The map stayed connected for a walking player and split
    # into four regions for the spawn chooser, which then put every spawn in
    # the largest and left two thirds of the map with nobody starting in it.
    parts.wall(18.50, -ENDS, 19.55, ENDS, 0.0, WALL_TOP,
               gaps=((-25.0, -20.0), (-2.5, 2.5), (20.0, 25.0)),
               head=WALL_TOP)

    # Ground, starting just inside the old wall line so the two halves meet
    # with no seam, and out to the new edge. Not further in than that: the
    # staircase's foot is at x 18.58 and a slab through it is a slab through
    # its bottom tread.
    # Butted up against the old floor's edge at 19.55 rather than lapping
    # over it, and at y 0 exactly. Both matter. Two slabs overlapping in the
    # same plane z-fight; and a slab dropped below zero to dodge that falls
    # out of row 0 of the voxel grid, which is where `outside_the_art` looks
    # to decide whether the art reaches a column - it sealed off both new
    # districts as "outside the map" and took the arena from 7,423 m2
    # walkable to 2,431.
    parts.deck(PLANE_EDGE, -ENDS, NEW_EDGE + 1.0, ENDS, 0.0, material=GROUND)

    # The new outer wall, and the north and south walls of the new strip.
    # The generated perimeter in `derive-brushes.perimeter` will sit just
    # outside these; they are here so the edge of the map is something a
    # player can see rather than an invisible stop.
    parts.box(NEW_EDGE, 0.0, -ENDS, NEW_EDGE + 1.0, WALL_TOP, ENDS, WALL)
    parts.box(19.00, 0.0, -ENDS + SKIN, NEW_EDGE, WALL_TOP, -ENDS + 1.0, WALL)
    parts.box(19.00, 0.0, ENDS - 1.0, NEW_EDGE, WALL_TOP, ENDS - SKIN, WALL)

    # Two rows of blocks with a lane down the middle and lanes to either
    # side. Roofs alternate between one and two storeys so the rooflines
    # give something to fight over rather than one flat plane.
    #
    # (x0, z0, x1, z1, roof, the side its ramp goes on, its run, and which
    # corner of that side). About thirty degrees where the lane has the room,
    # which is most of them. Two ramps that face each other across a lane
    # are put at opposite corners, so both get their length; the one in
    # front of a block three metres off is shorter and steeper, because a
    # ramp that ends nose to a wall is a ramp nobody walks down.
    blocks = [
        (23.0, -32.0, 33.0, -22.0, 3.60, 'z1', 6.2, '+'),
        (37.0, -30.0, 47.0, -20.0, 6.00, 'z1', 10.3, '+'),
        (22.0, -12.0, 32.0, -2.0, 6.00, 'z1', 10.3, '+'),
        (36.0, -6.0, 46.0, 6.0, 3.60, 'z0', 6.2, '-'),
        (23.0, 12.0, 33.0, 22.0, 3.60, 'z0', 6.2, '-'),
        (37.0, 18.0, 47.0, 30.0, 6.00, 'z0', 9.0, '+'),
    ]
    for i, (x0, z0, x1, z1, roof, side, run, corner) in enumerate(blocks):
        middle_x = (x0 + x1) / 2.0
        middle_z = (z0 + z1) / 2.0
        parts.block(x0, z0, x1, z1, roof, material=BLOCK_WALLS[i % len(BLOCK_WALLS)], doors=(
            ('x0', ((middle_z - 1.3, middle_z + 1.3),)),
            ('x1', ((middle_z - 1.3, middle_z + 1.3),)),
            ('z0', ((middle_x - 1.3, middle_x + 1.3),)),
            ('z1', ((middle_x - 1.3, middle_x + 1.3),)),
        ))
        parts.roof_ramp(side, x0, z0, x1, z1, roof, run, corner)
    parts.log.append(f'  east district: {len(blocks)} blocks with ramps, '
                     f'ground and walls out to x {NEW_EDGE:.0f}')

    # Cover in the lanes, so crossing them is not a walk down a bowling
    # alley. Paired, low then high, so both tops can be walked onto.
    for x, z in ((34.0, -34.0), (34.0, -16.0), (34.0, 8.0), (34.0, 26.0),
                 (20.5, -26.0), (20.5, 4.0), (20.5, 28.0),
                 (48.0, -12.0), (48.0, 12.0)):
        parts.cover(x, z)


def west_district(parts):
    """The same again on the other side, and not a mirror of it.

    Building both halves rather than one keeps the map centred on the
    origin, which matters for more than tidiness: `Map::half_x` is a radius
    from the origin, so a map that runs from -19 to +50 has to claim a
    half-width of 50 and the bounds check goes slack over the whole west
    side. Two districts and it is honest again.

    The blocks are offset along z rather than mirrored, so the two halves
    do not play identically, and the gates are placed around what is
    already against the west wall - the staircase up to the north-west
    roof at z 21 to 28, and the tall fragments around z -6 to 2.
    """
    parts.wall(-19.55, -ENDS, -18.50, ENDS, 0.0, WALL_TOP,
               gaps=((-25.0, -20.0), (-11.0, -6.0), (14.0, 19.0)),
               head=WALL_TOP)
    parts.deck(-NEW_EDGE - 1.0, -ENDS, -PLANE_EDGE, ENDS, 0.0, material=GROUND)
    parts.box(-NEW_EDGE - 1.0, 0.0, -ENDS, -NEW_EDGE, WALL_TOP, ENDS, WALL)
    parts.box(-NEW_EDGE, 0.0, -ENDS + SKIN, -19.00, WALL_TOP, -ENDS + 1.0, WALL)
    parts.box(-NEW_EDGE, 0.0, ENDS - 1.0, -19.00, WALL_TOP, ENDS - SKIN, WALL)

    # As in the east. The first is short because the block in front of it
    # is ten metres off; the fourth goes at the outer corner, clear of the
    # cover beside its inner one.
    blocks = [
        (-33.0, -30.0, -23.0, -20.0, 6.00, 'z1', 7.5, '-'),
        (-47.0, -34.0, -37.0, -24.0, 3.60, 'z1', 6.2, '-'),
        (-32.0, -10.0, -22.0, 0.0, 3.60, 'z1', 6.2, '-'),
        (-46.0, -4.0, -36.0, 8.0, 6.00, 'z0', 10.3, '-'),
        (-33.0, 14.0, -23.0, 24.0, 6.00, 'z0', 10.3, '+'),
        (-47.0, 20.0, -37.0, 32.0, 3.60, 'z0', 6.2, '+'),
    ]
    for i, (x0, z0, x1, z1, roof, side, run, corner) in enumerate(blocks):
        middle_x = (x0 + x1) / 2.0
        middle_z = (z0 + z1) / 2.0
        parts.block(x0, z0, x1, z1, roof, material=BLOCK_WALLS[i % len(BLOCK_WALLS)], doors=(
            ('x0', ((middle_z - 1.3, middle_z + 1.3),)),
            ('x1', ((middle_z - 1.3, middle_z + 1.3),)),
            ('z0', ((middle_x - 1.3, middle_x + 1.3),)),
            ('z1', ((middle_x - 1.3, middle_x + 1.3),)),
        ))
        parts.roof_ramp(side, x0, z0, x1, z1, roof, run, corner)
    parts.log.append(f'  west district: {len(blocks)} blocks with ramps, '
                     f'ground and walls out to x -{NEW_EDGE:.0f}')

    for x, z in ((-36.2, -34.0), (-36.2, -14.0), (-36.2, 10.0), (-36.2, 28.0),
                 (-22.5, -26.0), (-22.5, 6.0), (-22.5, 30.0),
                 (-49.0, -14.0), (-49.0, 12.0)):
        parts.cover(x, z)


def build(parts):
    """Every piece added to the arena, and the reason it is there.

    One rule governs where any of this may go, and it is not obvious from
    the geometry: **anything with air under it needs more than a step of
    it.** `derive-brushes.standing_runs` joins a run to whatever is within a
    step under it, so a deck lower than that over an obstacle is read as one
    more tread and the air between fills in solid. It was far worse when
    this was written: `obstacle_heights` gave any column whose obstacle
    reached 1.75 m the height of the highest surface anywhere in it, so a
    walkway at any height over a ramp that reached head height welded down
    to it. The first attempt here was a bridge over exactly such a ramp, and
    it sealed the corner it was meant to open. `scripts/check-buildable.py`
    takes a deck's height and marks the columns it would be joined to; run
    it before adding any piece with air under it. Anything ground-resting - a
    staircase, a block - is safe anywhere, which is why both districts are
    built out of those.
    """

    # The north-west corner. A two storey building - ground floor at 0.00,
    # first floor at 2.50, roof at 4.85 - whose roof is 56 m2 of standing
    # room `check-reachable.py` cannot walk to. The staircase beside it does
    # climb, 2.75 to 4.75, but it lands on the *neighbouring* structure at z
    # 28 and beyond; from there the building's own roof is a 2.10 m wall, and
    # from the first floor below it is 2.35 m up. Both are past a jump, which
    # is what the recording shows: repeated attempts and a drop back down.
    #
    # South of the building is open yard - ground at 0.00, nothing overhead,
    # clear from x -13.6 east past -5 - so the way up is a straight external
    # flight along the building's south face, climbing west onto the roof.
    # Ground-resting, so the rule above does not apply to it: a staircase is
    # its own obstacle and has nothing above it to be welded to.
    #
    # It is a ramp now, the whole width of that strip of yard: from the
    # ground at x -3 up to a landing at x -11.5, about thirty degrees - the
    # slope of the art's own ramp along the west wall, which is what Conrad
    # pointed at when he asked for these. The strip is 4 m between the
    # building and the block south of it; the ramp takes 3 and a wall a cell
    # thick either side, and the half metre left against the block is too
    # narrow to walk into. The wall on the building's side stops where the
    # building's own wall starts.
    parts.log.append('  north-west corner: a ramp to the 4.85 m roof')
    parts.ramp('x', -3.00, -11.50, 24.28, 4.85 - SKIN, into=0.0,
               walls=(-10.50, True))
    # The landing, solid from the ground, walled on its two open sides. It
    # tops out beside the roof - the roof's south edge is at z 24.0 - and
    # meets it cell to cell in the collision; the drawn sliver under the
    # roof's edge only closes the 3 cm between the two.
    parts.solid(-13.00, 24.03, -11.50, 27.28, 4.85 - SKIN, walls=('z1', 'x0'))
    parts.drawn.box(-13.00, 4.85 - SKIN - DECK, 23.99, -11.50, 4.85 - SKIN,
                    24.03, RAMP)
    east_district(parts)
    west_district(parts)


# The arena's own colours were a toy's: flat orange walls, red-orange, amber
# and a blue car, every one at full saturation. This is the same map in the
# colours of a real one - weathered concrete, asphalt, painted plaster, rusty
# steel, timber - chosen against a reference picture of the map repainted,
# and applied without moving a vertex.
#
# Each entry is a *surface*, named for what the thing is made of. The name is
# what goes into the file, and it is what the client keys its shading on:
# `world.js` gives concrete its stains, asphalt its grit and roofs their
# corrugation by looking the material's name up. So a name here is a promise
# about how the surface will be drawn, not just a colour.
#
# Colours are sRGB, as a person would pick them; glTF stores linear, and
# `paint` converts. Roughness is how dull the surface is - nothing here is
# glossy, and a metalness above zero reads as black without an environment
# map to reflect, so none is used.
PALETTE = {
    # Structure.
    'concrete':       ('#857f73', 0.92),  # perimeter and dividing walls
    'concrete_dark':  ('#6f6b63', 0.92),  # decks, slabs, the end compounds
    'concrete_light': ('#a39e92', 0.9),   # barriers
    'asphalt':        ('#4f4d49', 0.96),  # the ground
    'silo':           ('#978c78', 0.9),   # the two towers: stained concrete
    # Buildings.
    'plaster_tan':    ('#a8966c', 0.9),
    'plaster_olive':  ('#646a4c', 0.9),
    'plaster_maroon': ('#6e3029', 0.9),
    'plaster_sand':   ('#978f7d', 0.9),
    'roof_metal':     ('#4a4c4e', 0.75),
    # Steel.
    'steel':          ('#5b5d5e', 0.7),   # frames, rims, beams
    'steel_stair':    ('#a48f5d', 0.8),   # every staircase: worn safety paint
    'container_rust': ('#713628', 0.85),
    'tank_white':     ('#b1afa6', 0.8),
    'car_red':        ('#5e2825', 0.6),
    'car_blue':       ('#2f3b4a', 0.6),
    'barrel_rust':    ('#7b3b28', 0.75),
    'barrel_olive':   ('#535b3c', 0.75),
    'barrel_blue':    ('#3d4b59', 0.75),
    # Timber and stores.
    'wood':           ('#8d7450', 0.88),
    'wood_dark':      ('#6c573e', 0.88),
    'wood_pallet':    ('#9b8461', 0.9),
    'crate_olive':    ('#4f5838', 0.85),
    'crate_rust':     ('#6d3b2b', 0.85),
    'brick':          ('#7b4a38', 0.92),
    'sandbag':        ('#8a7f5f', 0.95),
}

# The download's props by name, where the name alone is not enough to say
# what the thing is. `Cube` is its author's name for everything from a car to
# a staircase, so these are looked up by number.
CUBES = {
    '': 'concrete',                                  # a free-standing wall
    '001': 'steel_stair', '002': 'steel_stair',
    '003': 'concrete_dark', '008': 'concrete_dark', '009': 'concrete_dark',
    '004': 'concrete_dark', '016': 'concrete_dark',  # the two end compounds
    '006': 'car_red', '007': 'car_red', '035': 'car_blue',
    '010': 'concrete', '013': 'concrete',            # pillars
    '011': 'tank_white', '017': 'tank_white',
    '014': 'steel', '015': 'steel',                  # beams
    '019': 'concrete',
    '020': 'wood_pallet', '021': 'wood_pallet', '024': 'wood_pallet',
    '034': 'wood_pallet', '026': 'wood_pallet', '027': 'wood_pallet',
    '028': 'wood_pallet',                            # planks
    '022': 'concrete', '023': 'concrete', '025': 'concrete',
    '030': 'concrete', '031': 'concrete', '032': 'concrete',
    '029': 'concrete_light', '033': 'concrete_light', '036': 'concrete_light',
}


# Paint on the ground, in world metres, as (x0, z0, x1, z1, width, dash
# period, colour). The client draws them on the asphalt; they are carried on
# that material's `extras` so the map describes its own markings and the
# client stays a renderer. A dash period of 0 is a solid line. Laid out
# around what `east_district` and `west_district` build, so a lane line runs
# down the middle of a lane and an edge line stops short of a wall.
YELLOW, WHITE = 0, 1
MARKINGS = [
    # Down the lane between the two rows of blocks, each side.
    (34.5, -36.0, 34.5, 36.0, 0.15, 6.0, YELLOW),
    (-34.6, -36.0, -34.6, 36.0, 0.15, 6.0, YELLOW),
    # A kerb line a metre inside the outer walls of both districts.
    (48.9, -35.6, 48.9, 35.6, 0.12, 0.0, YELLOW),
    (-48.9, -35.6, -48.9, 35.6, 0.12, 0.0, YELLOW),
    (20.6, 35.6, 48.9, 35.6, 0.12, 0.0, YELLOW),
    (20.6, -35.6, 48.9, -35.6, 0.12, 0.0, YELLOW),
    (-48.9, 35.6, -20.6, 35.6, 0.12, 0.0, YELLOW),
    (-48.9, -35.6, -20.6, -35.6, 0.12, 0.0, YELLOW),
] + [
    # A stop line either side of every gate in the dividing walls.
    (x, lo, x, hi, 0.3, 0.0, WHITE)
    for gates, sides in (
        (((-25.0, -20.0), (-2.5, 2.5), (20.0, 25.0)), (17.6, 20.5)),
        (((-25.0, -20.0), (-11.0, -6.0), (14.0, 19.0)), (-17.6, -20.5)),
    )
    for lo, hi in gates
    for x in sides
]


def surface_of(name, material, triangles):
    """What one of the download's primitives is made of.

    By the name its author gave the node, and where that is ambiguous by
    what else is known about it. Anything this does not recognise is an
    error rather than a default: a new prop silently painted as concrete is
    exactly the kind of thing nobody notices until it is in a screenshot.
    """
    base, _, part = name.rpartition('_')
    family, _, number = base.partition('.')
    n = int(number) if number.isdigit() else 0
    if family == 'Plane':
        return 'asphalt'
    if family == 'floors':
        return 'concrete'
    if family == 'room':
        return 'plaster_olive' if part == '0' else 'concrete_dark'
    if family == 'up2':
        return 'concrete_dark'
    if family in ('Barrel', 'BarrelB'):
        if part == '1':
            return 'steel'
        return {7: 'barrel_blue', 9: 'barrel_olive'}.get(material, 'barrel_rust')
    if family == 'BigBox':
        return 'steel' if part == '1' else ('crate_olive', 'crate_rust')[n % 2]
    if family == 'Box':
        if triangles <= 12:
            return 'crate_rust'
        if part == '1':
            return 'steel'
        return ('wood', 'wood', 'wood_dark')[n % 3]
    if family == 'miniBox':
        return ('wood', 'wood_dark')[n % 2]
    if family == 'Cube':
        if base == 'Cube.005':
            return 'steel' if part == '1' else 'container_rust'
        if number in CUBES:
            return CUBES[number]
    if family == 'obj':
        if number in ('048', '049'):
            return 'silo'
        if triangles <= 12:
            return 'concrete'
        if triangles <= 196:
            return 'wood_pallet' if material == 0 else 'wood_dark'
        # Stacks of small blocks, in four colours in the original. Bricks
        # and sandbags, alternately, so a row of them is not one colour.
        return ('brick', 'sandbag')[n % 2]
    raise SystemExit(f'  no surface for {name!r} (material {material}, '
                     f'{triangles} triangles) - add it to surface_of')


def linear(hex_colour):
    """sRGB '#rrggbb' to the linear floats glTF stores."""
    out = []
    for i in (1, 3, 5):
        c = int(hex_colour[i:i + 2], 16) / 255.0
        out.append(round(c / 12.92 if c <= 0.04045
                         else ((c + 0.055) / 1.055) ** 2.4, 5))
    return out


def paint(js):
    """Give every primitive in the download a surface from `PALETTE`.

    Only the `material` of each primitive changes - not a vertex, not an
    index - so the collision, which is derived from geometry alone, cannot
    move. The download's own materials stay in the file, unused, and the
    palette goes on the end, so `strip_previous` can put every primitive
    back exactly as it was.

    Returns the surface name to material index table, for the geometry this
    file adds, and the list of what was changed.
    """
    surfaces = {}
    for name, (colour, roughness) in PALETTE.items():
        js['materials'].append({
            'name': name,
            'pbrMetallicRoughness': {
                'baseColorFactor': linear(colour) + [1.0],
                'metallicFactor': 0.0,
                'roughnessFactor': roughness,
            },
            'doubleSided': True,
        })
        surfaces[name] = len(js['materials']) - 1
    js['materials'][surfaces['asphalt']]['extras'] = {
        'markings': [list(m) for m in MARKINGS]}

    names = {}
    for node in js['nodes']:
        if 'mesh' in node:
            names.setdefault(node['mesh'], set()).add(node.get('name', ''))

    repainted, counts = [], {}
    for index, mesh in enumerate(js['meshes']):
        for slot, prim in enumerate(mesh['primitives']):
            triangles = js['accessors'][prim['indices']]['count'] // 3
            found = {surface_of(name, prim.get('material'), triangles)
                     for name in names.get(index, ())}
            if len(found) != 1:
                raise SystemExit(f'  mesh {index} is drawn as {found or "nothing"}')
            surface = found.pop()
            repainted.append((index, slot, prim.get('material')))
            prim['material'] = surfaces[surface]
            counts[surface] = counts.get(surface, 0) + 1
    print(f'  painted {len(repainted)} primitives in {len(counts)} surfaces: '
          + ', '.join(f'{k} {v}' for k, v in sorted(counts.items())))
    return surfaces, repainted


def main():
    scale = scale_of('arena')
    print(f'arena, authored in metres at {scale}x')
    js, blob = read_glb(MODEL)
    blob = strip_previous(js, blob)

    # Everything that follows appends, so these are the lengths to truncate
    # back to next time. Taken before the wall comes down, because that
    # appends too.
    before = {
        'nodes': len(js['nodes']), 'meshes': len(js['meshes']),
        'accessors': len(js['accessors']),
        'bufferViews': len(js['bufferViews']), 'bytes': len(blob),
        'materials': len(js['materials']),
    }
    surfaces, repainted = paint(js)
    blob, repointed, removed = retire_triangles(
        js, blob, 'floors_0', redundant_original, scale)
    print(f'  took down {removed} triangles of the original: its east and '
          f'west walls, and the red-orange floor that was z-fighting with '
          f'the grey one over the whole arena')
    blob, room, removed = retire_triangles(js, blob, 'room_0', room_floor, scale)
    repointed += room
    print(f'  took down {removed} triangles of room_0: its own floor, '
          f'z-fighting with the ground inside the building')

    parts = Parts()
    parts.drawn = Parts()
    parts.hidden = Parts()
    build(parts)
    for line in parts.log:
        print(line)

    expected = parts.bounds()
    blob = attach(js, blob, parts, scale, before, repointed, repainted,
                  surfaces)
    size = write_glb(js, blob, MODEL)
    print(f'  {parts.triangles()} triangles added, '
          f'{os.path.relpath(MODEL, ROOT)} is now {size / 1024 / 1024:.2f} MB')
    verify(scale, expected)
    print('  now run: python scripts/derive-maps.py arena')


if __name__ == '__main__':
    main()
