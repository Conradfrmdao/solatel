#!/usr/bin/env python3
"""Where the soldier's cloth is, for the skins (`client/src/skins.js`).

    python3 scripts/build-skins.py

Reads `assets/characters/soldier.glb` - the file the game ships, not any
download - and writes `assets/characters/soldier-cloth.webp`: a mask over the
uniform's texture, white where it is cloth (shirt, sleeves, trousers) and
black where it is gear (plate carrier, helmet, pads, straps, boots). A skin
draws its own pattern on the white and tints the black, so it needs to know
which is which; the soldier's own digital camouflage is what gives the cloth
away - mid-grey, colourless and busy at the scale of its blocks - and the
pads, which are as grey but smooth, are left out by how busy they are.

It also prints how bright the cloth is on average, in linear light, which
`skins.js` keeps as `CLOTH_MEAN`: each skin's folds are the soldier's own,
scaled about that.

Always UTF-8 and LF: see CLAUDE.md on what Windows defaults did here.
"""
import io
import json
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SOLDIER = ROOT / 'assets' / 'characters' / 'soldier.glb'
OUT = ROOT / 'assets' / 'characters' / 'soldier-cloth.webp'
SIZE = 512


def uniform_texture(glb):
    """The base colour image of the soldier's first material (`Ch15_body`)."""
    data = glb.read_bytes()
    length = struct.unpack('<I', data[12:16])[0]
    gltf = json.loads(data[20 : 20 + length])
    body = 20 + length + 8
    material = gltf['materials'][0]
    texture = gltf['textures'][material['pbrMetallicRoughness']['baseColorTexture']['index']]
    # WebP is named by an extension, not by the plain `source`.
    source = texture.get('source', texture.get('extensions', {}).get('EXT_texture_webp', {}).get('source'))
    image = gltf['images'][source]
    view = gltf['bufferViews'][image['bufferView']]
    start = body + view.get('byteOffset', 0)
    return Image.open(io.BytesIO(data[start : start + view['byteLength']])).convert('RGB')


def main():
    rgb = np.asarray(uniform_texture(SOLDIER)).astype(np.float64) / 255
    luma = rgb @ np.array([0.299, 0.587, 0.114])
    saturation = rgb.max(axis=2) - rgb.min(axis=2)
    mean = ndimage.uniform_filter(luma, 9)
    busy = np.sqrt(np.maximum(ndimage.uniform_filter(luma**2, 9) - mean**2, 0))

    cloth = (mean > 0.2) & (mean < 0.72) & (busy > 0.07) & (saturation < 0.12)
    cloth = ndimage.binary_opening(cloth, iterations=2)
    cloth = ndimage.binary_closing(cloth, iterations=14)
    cloth = ndimage.binary_fill_holes(cloth)
    labels, count = ndimage.label(cloth)
    index = range(1, count + 1)
    sizes = ndimage.sum(cloth, labels, index)
    busyness = ndimage.mean(busy, labels, index)
    cloth = np.isin(labels, 1 + np.nonzero((sizes > 1500) & (busyness > 0.072))[0])

    soft = ndimage.gaussian_filter(cloth.astype(np.float64), 1.5)
    mask = Image.fromarray((soft * 255).astype(np.uint8)).resize((SIZE, SIZE), Image.LANCZOS)
    mask.save(OUT, 'WEBP', lossless=True)

    linear = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    mean_linear = (linear @ np.array([0.2126, 0.7152, 0.0722]))[cloth].mean()
    print(f'>> {OUT.relative_to(ROOT)}: {OUT.stat().st_size / 1024:.1f} KB, '
          f'cloth {cloth.mean():.0%} of the texture, mean linear luminance {mean_linear:.4f}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
