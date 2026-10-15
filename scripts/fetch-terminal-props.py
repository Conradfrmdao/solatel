#!/usr/bin/env python3
"""Download selected CC0 Poly Haven props at 1K (floor scan at 2K) and pack self-contained GLBs.

No service is contacted at runtime. Sources/credits: assets/props/TERMINAL.md.
The downloader preserves authored geometry, normals, UVs and PBR textures.
"""
import concurrent.futures
import json
import struct
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'assets/props'
NAMES = ['metal_tool_chest', 'old_military_crate', 'fern_02', 'industrial_wall_lamp', 'potted_plant_02', 'smooth_concrete_floor']


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Solatel-asset-build/1.0 (offline game asset packaging)'})
    with urllib.request.urlopen(req, timeout=120) as response:
        return response.read()


def pack(name):
    target = DEST / f'{name}.glb'
    if target.exists():
        print(f'{name}: already packed', flush=True)
        return
    files = json.loads(get(f'https://api.polyhaven.com/files/{name}'))
    resolution = '2k' if name == 'smooth_concrete_floor' else '1k'
    entry = files['gltf'][resolution]['gltf']
    js = json.loads(get(entry['url']))
    if name == 'smooth_concrete_floor':
        # The material download includes a displaced preview mesh. The game
        # uses its own floor: package only the PBR textures and material.
        js.update(meshes=[], nodes=[], accessors=[], scenes=[{'nodes':[]}], buffers=[], bufferViews=[])
        js.pop('animations', None)
    includes = entry['include']
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        loaded = dict(zip(includes, pool.map(lambda p: get(includes[p]['url']), includes)))
    blob = bytearray()
    offsets = []
    for buffer in js['buffers']:
        blob.extend(b'\0' * (-len(blob) % 4))
        offsets.append(len(blob))
        blob.extend(loaded[buffer['uri']])
    for view in js.get('bufferViews', []):
        view['byteOffset'] = view.get('byteOffset', 0) + offsets[view.get('buffer', 0)]
        view['buffer'] = 0
    for image in js.get('images', []):
        uri = image.pop('uri')
        blob.extend(b'\0' * (-len(blob) % 4))
        image['bufferView'] = len(js['bufferViews'])
        image['mimeType'] = 'image/png' if uri.lower().endswith('.png') else 'image/jpeg'
        js['bufferViews'].append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(loaded[uri])})
        blob.extend(loaded[uri])
    js['buffers'] = [{'byteLength': len(blob)}]
    js['asset']['extras'] = {'source': f'https://polyhaven.com/a/{name}', 'license': 'CC0-1.0', 'resolution': resolution.upper()}
    encoded = json.dumps(js, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    blob.extend(b'\0' * (-len(blob) % 4))
    out = struct.pack('<III', 0x46546c67, 2, 28 + len(encoded) + len(blob))
    out += struct.pack('<II', len(encoded), 0x4e4f534a) + encoded
    out += struct.pack('<II', len(blob), 0x004e4942) + blob
    target.write_bytes(out)
    tris = sum(js['accessors'][p['indices']]['count'] // 3 for mesh in js['meshes'] for p in mesh['primitives'])
    print(f'{name}: {len(out)/1048576:.2f} MB, {tris:,} triangles', flush=True)


if __name__ == '__main__':
    DEST.mkdir(parents=True, exist_ok=True)
    for name in NAMES:
        pack(name)
