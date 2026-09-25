#!/usr/bin/env python3
"""Turn the raw model downloads into the files under assets/.

The outputs are committed, so this script is documentation more than build
step: it records exactly what was done to each download, which CC-BY-4.0
requires us to state, and makes it repeatable if an asset is ever re-fetched.

    python scripts/prepare-assets.py "C:/Users/DELL/Downloads/assests"

Five things happen here rather than at runtime:

* The TDM map ships as .gltf + .bin. Packing it into one .glb halves the number
  of requests the browser makes and removes a class of failure where the .gltf
  loads and its buffer 404s. The larger yard map already ships as one .glb and
  is only copied, with the same near-black pass applied.
* Two meshes are removed from the soldier. `holster_soldier_0` is broken in the
  source file - its geometry is authored about 6.5 m below the body and weighted
  to the right thigh, so in game it is a slab swinging around under the player's
  feet. `hand_knife_soldier_0` is a knife in the hand, which fights the rifle
  viewmodel.
* Near-black materials are lifted so they take light. Both the rifle and the
  arena's ground plane ship at a base colour of about 0.02, which draws as a
  silhouette with no form in it rather than as a surface.
* Normals and texture coordinates are stripped from the maps. Neither is
  ever read - there are no textures in either file, and the client flat-shades
  every map material - and between them they are more than half the larger
  map's bytes. Every player downloads these.
* Nothing is rescaled. The soldier is already 1.83 m with its feet at the
  origin, and the map is scaled at load time instead, so that the numbers in
  map.rs and the numbers in the art stay legible next to each other.

Geometry is never touched, which is what lets `derive-brushes.py` keep trusting
this file: the collision brushes are generated from the same arena.glb, so a
change here that moved a vertex would move a wall the server believes in.
"""
import base64
import json
import os
import shutil
import struct
import sys

# Meshes dropped from the soldier, and why. Matched on mesh name, which is
# descriptive, rather than node name, which is "Object_54".
SOLDIER_DROP = {
    'holster_soldier_0': 'broken bind pose - floats ~6.5 m below the body',
    'hand_knife_soldier_0': 'knife in hand, clashes with the rifle viewmodel',
}


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
    json_chunk = json.dumps(js, separators=(',', ':')).encode('utf-8')
    json_chunk += b' ' * ((4 - len(json_chunk) % 4) % 4)
    bin_chunk = blob + b'\0' * ((4 - len(blob) % 4) % 4)
    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'wb') as handle:
        handle.write(b'glTF' + struct.pack('<II', 2, total))
        handle.write(struct.pack('<II', len(json_chunk), 0x4E4F534A) + json_chunk)
        handle.write(struct.pack('<II', len(bin_chunk), 0x004E4942) + bin_chunk)
    print(f'    -> {out_path}  ({total / 1024 / 1024:.2f} MB)')


def pack_gltf(gltf_path, out_path):
    """Fold an external .bin and any external images into a single .glb."""
    base = os.path.dirname(os.path.abspath(gltf_path))
    js = json.load(open(gltf_path, encoding='utf-8'))

    blob, offsets = bytearray(), []
    for buffer in js['buffers']:
        uri = buffer['uri']
        if uri.startswith('data:'):
            data = base64.b64decode(uri.split(',', 1)[1])
        else:
            data = open(os.path.join(base, uri), 'rb').read()
        while len(blob) % 4:
            blob.append(0)
        offsets.append(len(blob))
        blob.extend(data)

    for view in js.get('bufferViews', []):
        view['byteOffset'] = view.get('byteOffset', 0) + offsets[view.get('buffer', 0)]
        view['buffer'] = 0

    for image in js.get('images', []):
        uri = image.pop('uri', None)
        if uri is None:
            continue
        if uri.startswith('data:'):
            head, encoded = uri.split(',', 1)
            data, mime = base64.b64decode(encoded), head[5:].split(';')[0]
        else:
            data = open(os.path.join(base, uri), 'rb').read()
            mime = {'.png': 'image/png', '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg'}[os.path.splitext(uri)[1].lower()]
        while len(blob) % 4:
            blob.append(0)
        js.setdefault('bufferViews', []).append(
            {'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data)})
        blob.extend(data)
        image['mimeType'] = mime
        image['bufferView'] = len(js['bufferViews']) - 1

    js['buffers'] = [{'byteLength': len(blob)}]
    write_glb(js, bytes(blob), out_path)


def drop_meshes(js, names):
    """Unhook named meshes from the nodes that draw them.

    The node itself stays, so every index in the file remains valid - removing
    a node would renumber the skin's joint list and the animation targets along
    with it. An unreferenced mesh is a few hundred wasted bytes; a renumbered
    skeleton is a silently broken character.
    """
    dropped = []
    for node in js.get('nodes', []):
        index = node.get('mesh')
        if index is None:
            continue
        name = js['meshes'][index].get('name', '')
        if name in names:
            del node['mesh']
            dropped.append(name)
    missing = set(names) - set(dropped)
    if missing:
        raise SystemExit(f'expected meshes not found, asset changed?: {sorted(missing)}')
    return dropped


# Any material darker than this reads as a hole rather than a surface, and is
# lifted to `DARK_FLOOR_TARGET` keeping its hue.
DARK_LIMIT = 0.05
DARK_FLOOR_TARGET = 0.10


def lift_black_materials(js):
    """Raise anything in the arena that is effectively pure black.

    The ground plane ships at a base colour of 0.021, which under any lighting
    is a hole in the screen. That matters more here than it sounds: the arena
    this replaced went out of its way to put a one-metre grid on the floor,
    because a surface with no variation in it gives the eye nothing to judge
    distance or speed against, and both are things a player is aiming with.
    A floor that takes light at least has its own shading and the shadows of
    what is standing on it.

    Only near-black is touched. The map's dark reds, oranges and greys are the
    artist's palette and are left exactly as they are.
    """
    changed = []
    for material in js.get('materials', []):
        pbr = material.setdefault('pbrMetallicRoughness', {})
        colour = pbr.get('baseColorFactor', [1, 1, 1, 1])
        peak = max(colour[:3])
        if peak >= DARK_LIMIT:
            continue
        scale = DARK_FLOOR_TARGET / peak if peak > 1e-6 else 0.0
        pbr['baseColorFactor'] = [
            min(channel * scale, 1.0) if peak > 1e-6 else DARK_FLOOR_TARGET
            for channel in colour[:3]
        ] + [colour[3] if len(colour) > 3 else 1]
        changed.append(material.get('name', '<unnamed>'))
    return changed


def brighten_materials(js):
    """Make the rifle legible as a held object rather than a silhouette.

    It arrives from an OBJ conversion with a base colour of 0.014 - all but
    pure black - and no metallic response at all. Held up close against a dark
    arena that reads as a hole in the screen with a sharp outline and no form
    inside it. Lifting the base colour and giving it the metallic response a
    gun actually has is what made the placeholder weapon legible under this
    scene's lighting, and these are the placeholder's values.

    Done here rather than at runtime so the client has no material-patching
    code, and so what the file contains is what gets drawn.
    """
    changed = []
    for material in js.get('materials', []):
        pbr = material.setdefault('pbrMetallicRoughness', {})
        colour = pbr.get('baseColorFactor', [1, 1, 1, 1])
        pbr['baseColorFactor'] = [
            min(max(channel * 3.0, 0.05), 1.0) for channel in colour[:3]
        ] + [colour[3] if len(colour) > 3 else 1]
        pbr['metallicFactor'] = 0.8
        pbr['roughnessFactor'] = 0.42
        changed.append(material.get('name', '<unnamed>'))
    return changed


def strip_unused_attributes(js):
    """Drop vertex attributes nothing in this game ever reads.

    The maps arrive with normals and texture coordinates, and between them
    those are fifteen of the yard's twenty-six megabytes - more than half the
    file, for data that is discarded before it reaches the screen:

    * There are no textures. Ten materials, all flat colour, not one image in
      the file. Texture coordinates address a picture that does not exist.
    * The client flat-shades every map material, which makes the renderer
      compute a normal per face and ignore whatever the file supplied.

    Assets are downloaded by every player, so their size is a gameplay number
    rather than a housekeeping one - and this costs nothing at all, because the
    bytes removed were never going to be looked at. Geometry is untouched:
    positions and indices are exactly as they were, which is what lets
    `derive-brushes.py` keep generating collision from this same file.

    Removing an attribute leaves its accessor and buffer view behind as dead
    weight, so the buffer is rebuilt from only what is still referenced.
    """
    dropped = set()
    for mesh in js.get('meshes', []):
        for prim in mesh['primitives']:
            for name in ('NORMAL', 'TEXCOORD_0', 'TEXCOORD_1', 'TANGENT'):
                if prim['attributes'].pop(name, None) is not None:
                    dropped.add(name)
    return sorted(dropped)


def compact_buffer(js, blob):
    """Rebuild the file around only the data something still points at.

    glTF indexes everything by position, so dropping anything means renumbering
    every reference to it. Two passes: accessors nothing reads any more go
    first, then the buffer views left with no accessor or image pointing at
    them, and the binary chunk is rebuilt from what survives.

    Both passes are needed. Removing an attribute from a primitive leaves its
    accessor behind, and an accessor is a live reference to a buffer view - so
    pruning views alone removes nothing at all, and the file comes back the
    size it went in.
    """
    # Everything that can name an accessor. Maps have none of the last three,
    # but the soldier does, and a helper that quietly breaks a rig the day it is
    # pointed at one is worse than no helper.
    live_accessors = set()
    for mesh in js.get('meshes', []):
        for prim in mesh['primitives']:
            live_accessors.update(prim['attributes'].values())
            if 'indices' in prim:
                live_accessors.add(prim['indices'])
            for target in prim.get('targets', []):
                live_accessors.update(target.values())
    for skin in js.get('skins', []):
        if 'inverseBindMatrices' in skin:
            live_accessors.add(skin['inverseBindMatrices'])
    for animation in js.get('animations', []):
        for sampler in animation['samplers']:
            live_accessors.add(sampler['input'])
            live_accessors.add(sampler['output'])

    accessors, renumber_accessor = [], {}
    for index, accessor in enumerate(js.get('accessors', [])):
        if index not in live_accessors:
            continue
        renumber_accessor[index] = len(accessors)
        accessors.append(accessor)

    for mesh in js.get('meshes', []):
        for prim in mesh['primitives']:
            prim['attributes'] = {
                name: renumber_accessor[value]
                for name, value in prim['attributes'].items()
            }
            if 'indices' in prim:
                prim['indices'] = renumber_accessor[prim['indices']]
            for target in prim.get('targets', []):
                for name in list(target):
                    target[name] = renumber_accessor[target[name]]
    for skin in js.get('skins', []):
        if 'inverseBindMatrices' in skin:
            skin['inverseBindMatrices'] = renumber_accessor[skin['inverseBindMatrices']]
    for animation in js.get('animations', []):
        for sampler in animation['samplers']:
            sampler['input'] = renumber_accessor[sampler['input']]
            sampler['output'] = renumber_accessor[sampler['output']]
    js['accessors'] = accessors

    used = set()
    for accessor in accessors:
        if 'bufferView' in accessor:
            used.add(accessor['bufferView'])
        sparse = accessor.get('sparse')
        if sparse:
            used.add(sparse['indices']['bufferView'])
            used.add(sparse['values']['bufferView'])
    for image in js.get('images', []):
        if 'bufferView' in image:
            used.add(image['bufferView'])

    out = bytearray()
    views, renumber_view = [], {}
    for index, view in enumerate(js.get('bufferViews', [])):
        if index not in used:
            continue
        start = view.get('byteOffset', 0)
        chunk = blob[start:start + view['byteLength']]
        while len(out) % 4:
            out.append(0)
        fresh = dict(view)
        fresh['byteOffset'] = len(out)
        fresh['buffer'] = 0
        renumber_view[index] = len(views)
        views.append(fresh)
        out.extend(chunk)

    for accessor in accessors:
        if 'bufferView' in accessor:
            accessor['bufferView'] = renumber_view[accessor['bufferView']]
        sparse = accessor.get('sparse')
        if sparse:
            sparse['indices']['bufferView'] = renumber_view[sparse['indices']['bufferView']]
            sparse['values']['bufferView'] = renumber_view[sparse['values']['bufferView']]
    for image in js.get('images', []):
        if 'bufferView' in image:
            image['bufferView'] = renumber_view[image['bufferView']]

    js['bufferViews'] = views
    js['buffers'] = [{'byteLength': len(out)}]
    return bytes(out)


def main(source):
    if not os.path.isdir(source):
        raise SystemExit(f'no such directory: {source}')

    print('soldier')
    js, blob = read_glb(os.path.join(source, 'low_poly_soldier_-free.glb'))
    for name in drop_meshes(js, SOLDIER_DROP):
        print(f'    dropped {name}: {SOLDIER_DROP[name]}')
    write_glb(js, blob, 'assets/characters/soldier.glb')

    print('arena')
    gltf = os.path.join(source, 'tdm', 'scene.gltf')
    if not os.path.isfile(gltf):
        raise SystemExit(
            'expected the TDM map unzipped to <source>/tdm/scene.gltf\n'
            '  unzip "lowpoly__fps__tdm__game__map_by_resoforge.zip" -d <source>/tdm')
    pack_gltf(gltf, 'assets/maps/arena.glb')
    js, blob = read_glb('assets/maps/arena.glb')
    for name in lift_black_materials(js):
        print(f'    lifted {name} out of near-black')
    for name in strip_unused_attributes(js):
        print(f'    dropped {name}: nothing reads it')
    write_glb(js, compact_buffer(js, blob), 'assets/maps/arena.glb')

    print('yard')
    yard = os.path.join(source, 'rp', 'source', 'RP_MAP_1.glb')
    if not os.path.isfile(yard):
        raise SystemExit(
            'expected the big map unzipped to <source>/rp/source/RP_MAP_1.glb\n'
            '  unzip "lowpoly-map-asset-by-resoforge.zip" -d <source>/rp')
    js, blob = read_glb(yard)
    for name in lift_black_materials(js):
        print(f'    lifted {name} out of near-black')
    for name in strip_unused_attributes(js):
        print(f'    dropped {name}: nothing reads it')
    write_glb(js, compact_buffer(js, blob), 'assets/maps/yard.glb')

    print('rifle')
    js, blob = read_glb(os.path.join(source, 'Assault Rifle by Zsky - MdbcTe6hH3.glb'))
    for name in brighten_materials(js):
        print(f'    lifted {name} out of near-black')
    write_glb(js, blob, 'assets/weapons/rifle.glb')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(__doc__)
        raise SystemExit(2)
    main(sys.argv[1])
