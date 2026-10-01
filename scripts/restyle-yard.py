#!/usr/bin/env python3
"""Repaint the yard: from ten shouting flat colours to a combat palette.

    python scripts/restyle-yard.py

The yard as downloaded paints everything from ten colours - pure red, pure
yellow, a hard blue, orange - shared by every kind of thing in it, so a
container, a barrel and a building wall are all the same red. That reads as
a toy, and on a map built for shooting it hides nobody: every silhouette is
a primary colour against grey.

This gives each *kind* of thing its own surface, by the name of the node it
belongs to and the colour it had, from the same list of surfaces the arena
and the facility use. That list is the contract with the client: `world.js`
weathers by the name, and `photo.js` lays a photograph on it, so the yard
gets scanned concrete, steel and timber like the other two. Where one kind
comes in several colours - containers, cars, barrels - the colour is picked
per object from a muted set, so a stack of containers is not one block.

Only materials change: no vertex moves, so the collision is untouched -
`python scripts/derive-maps.py yard` leaves `map.rs` as it was. It is
idempotent: the first run records each primitive's original colour in the
primitive's `extras`, and every later run starts from that.
"""
import hashlib
import importlib.util
import json
import os
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.path.join(ROOT, 'assets', 'maps', 'yard.glb')


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, 'scripts', filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


arena = load('extend_arena', 'extend-arena.py')

# The facility's own additions, which the yard shares.
EXTRA = {
    'rubber':          ('#232324', 0.92),
    'container_blue':  ('#44505a', 0.85),
    'container_grey':  ('#676b69', 0.85),
    'container_olive': ('#525a3e', 0.85),
    'car_olive':       ('#4d5336', 0.6),
    'car_white':       ('#9c9a93', 0.6),
    'stripe_red':      ('#6e3a32', 0.85),
    'warning':         ('#8c7640', 0.85),
    'asphalt':         ('#4a4a48', 0.95),
    'concrete':        ('#8a877f', 0.92),
    'concrete_light':  ('#a3a098', 0.9),
    # The yard's walls: cool, so the warm photograph laid on them comes out
    # grey, as concrete is under an overcast sky (`concrete_grey` in
    # `photo.js` is tinted three quarters of the way to this).
    'concrete_grey':   ('#6f757a', 0.92),
    'brick':           ('#6d4a3d', 0.92),
    'roof_metal':      ('#4a4c4e', 0.75),
    'plaster_sand':    ('#9a8f78', 0.95),
    'wood':            ('#6f5b42', 0.9),
    'wood_pallet':     ('#7a6548', 0.9),
    'tank_white':      ('#9e9b92', 0.7),
    'sandbag':         ('#7d7158', 0.95),
}
PALETTE = dict(arena.PALETTE, **EXTRA)

# The yard's colours by index: 0 plane, 1 yellow, 2 white, 3 dark, 4 blue,
# 5 red, 6 wood, 7 dark, 8 orange, 9 mid grey.
CONTAINER_BODY = ('container_rust', 'container_olive', 'container_grey', 'container_blue',
                  'container_olive', 'container_rust')
CAR_BODY = ('car_olive', 'car_white', 'car_blue', 'container_grey', 'car_olive')
BARREL_BODY = ('barrel_rust', 'barrel_olive', 'barrel_blue', 'barrel_olive', 'barrel_rust')

RULES = {
    # kind: {colour index: surface, or a tuple to pick from per object}
    'PLANE': {0: 'asphalt'},
    'Cube': {1: 'concrete_grey', 2: 'concrete_light', 3: 'steel', 5: 'crate_rust', 6: 'wood',
             7: 'steel', 8: 'brick', 9: 'concrete_grey', None: 'concrete_grey'},
    'Cylinder': {2: 'steel', 3: 'rubber', 7: 'rubber', 4: BARREL_BODY, 5: BARREL_BODY,
                 8: BARREL_BODY},
    'barricade': {9: 'concrete_grey', 5: 'steel'},
    'TrafficBarrier_01_Cube': {5: 'stripe_red', 2: 'concrete_light', 3: 'steel'},
    'Wood': {5: BARREL_BODY, 2: 'steel'},
    'Big_Container_Long': {3: 'steel', 4: CONTAINER_BODY, 5: CONTAINER_BODY, 8: CONTAINER_BODY},
    'Container_Long': {3: 'steel', 4: CONTAINER_BODY},
    'Container_Small': {3: 'steel', 5: CONTAINER_BODY},
    'Big_Container_Small': {3: 'steel', 4: CONTAINER_BODY},
    'CAR': {5: CAR_BODY},
    'Wall_FirstAge': {5: 'brick', 2: 'concrete_light'},
    'Concrete_Barrier_Cube': {2: 'concrete_light'},
    'Pallet': {8: 'wood_pallet', 3: 'steel', 7: 'steel'},
    'Pallet_Broken': {8: 'wood_pallet'},
    'Room': {1: 'plaster_sand', 2: 'concrete_light'},
    'table': {6: 'wood'},
    'tower': {5: 'tank_white', 2: 'steel'},
    'Node': {2: 'concrete_light'},
    'Houses_FirstAge_1_Level2': {5: 'brick', 3: 'roof_metal'},
    'tent': {6: 'sandbag'},
    'wood': {6: 'wood'},
}
FALLBACK = {0: 'asphalt', 1: 'concrete_grey', 2: 'concrete_light', 3: 'steel', 4: 'container_blue',
            5: 'container_rust', 6: 'wood', 7: 'steel', 8: 'wood_dark', 9: 'concrete_grey'}


def pick(choice, name):
    if isinstance(choice, str):
        return choice
    h = int(hashlib.md5(name.encode()).hexdigest()[:8], 16)
    return choice[h % len(choice)]


def main():
    data = open(MODEL, 'rb').read()
    magic, version, _length = struct.unpack('<III', data[:12])
    assert magic == 0x46546C67
    json_length, _json_type = struct.unpack('<II', data[12:20])
    js = json.loads(data[20:20 + json_length])
    blob_header = 20 + json_length
    blob_length, _blob_type = struct.unpack('<II', data[blob_header:blob_header + 8])
    blob = data[blob_header + 8:blob_header + 8 + blob_length]

    surfaces = {}
    materials = []

    def material(surface):
        if surface not in surfaces:
            colour, roughness = PALETTE[surface]
            materials.append({
                'name': surface,
                'pbrMetallicRoughness': {
                    'baseColorFactor': arena.linear(colour) + [1.0],
                    'metallicFactor': 0.0,
                    'roughnessFactor': roughness,
                },
                'doubleSided': True,
            })
            surfaces[surface] = len(materials) - 1
        return surfaces[surface]

    counts = {}
    for node in js['nodes']:
        if 'mesh' not in node:
            continue
        name = node.get('name', '')
        kind = name.split('.')[0]
        rules = RULES.get(kind, {})
        for prim in js['meshes'][node['mesh']]['primitives']:
            extras = prim.setdefault('extras', {})
            if 'yard_colour' not in extras:
                extras['yard_colour'] = prim.get('material')
            original = extras['yard_colour']
            choice = rules.get(original, FALLBACK.get(original, 'concrete_grey'))
            surface = pick(choice, name)
            prim['material'] = material(surface)
            counts[surface] = counts.get(surface, 0) + 1
    js['materials'] = materials

    # The sea sits just under the slab, as before; say so, and in a colour
    # that belongs with the rest.
    scene = js['scenes'][js.get('scene', 0)]
    scene.setdefault('extras', {}).update({'water_colour': '#34474f'})

    size = arena.write_glb(js, bytes(blob), MODEL)
    print(f'yard: {len(materials)} surfaces over {sum(counts.values())} primitives, '
          f'{size / 1024 / 1024:.2f} MB')
    for surface, count in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f'  {surface:18s} {count}')


if __name__ == '__main__':
    main()
