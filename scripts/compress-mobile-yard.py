"""Keep Yard artwork/geometry at source resolution, with GPU-compressed images.

Requires Pillow and the existing scripts/build-basisu.sh encoder in the local
QA tool container. Outputs are committed; deployment does not run this script.
Run: python scripts/compress-mobile-yard.py [tool-container]
"""
import importlib.util
import io
import json
import subprocess
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('packing', ROOT / 'scripts/prepare-assets.py')
packing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packing)
container = sys.argv[1] if len(sys.argv) > 1 else 'solatel-render-qa-tools'
scratch = ROOT / '.artifacts/mobile-textures'
scratch.mkdir(parents=True, exist_ok=True)
output = ROOT / 'assets/mobile/props'
output.mkdir(parents=True, exist_ok=True)

def encode(image, name, srgb):
    png = scratch / f'{name}.png'
    ktx = scratch / f'{name}.ktx2'
    image.save(png)
    flags = ['-mip_srgb'] if srgb else ['-linear', '-mip_linear']
    run = subprocess.run(['docker', 'exec', container, '/work/target/basisu/basisu',
        '-file', '/work/' + png.relative_to(ROOT).as_posix(), '-uastc', '-uastc_level', '2',
        '-ktx2', '-mipmap', *flags, '-output_file', '/work/' + ktx.relative_to(ROOT).as_posix()],
        capture_output=True, text=True)
    if run.returncode:
        raise RuntimeError(run.stdout[-1000:] + run.stderr[-1000:])
    return ktx.read_bytes()

for path in sorted((ROOT / 'assets/props').glob('*.glb')):
    doc, raw = packing.read_glb(path)
    srgb_images = set()
    for material in doc.get('materials', []):
        for tex in [material.get('pbrMetallicRoughness', {}).get('baseColorTexture'), material.get('emissiveTexture')]:
            if tex:
                srgb_images.add(doc['textures'][tex['index']]['source'])
    replacements = {}
    for index, entry in enumerate(doc.get('images', [])):
        view = doc['bufferViews'][entry['bufferView']]
        start = view.get('byteOffset', 0)
        image = Image.open(io.BytesIO(raw[start:start + view['byteLength']])).convert('RGBA')
        if path.stem == 'smooth_concrete_floor' and index in srgb_images:
            pixels = list(image.resize((64, 64), Image.Resampling.BOX).getdata())
            def linear(value):
                value /= 255
                return value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4
            mean = [sum(linear(p[c]) for p in pixels) / len(pixels) for c in range(3)]
            doc['materials'][0].setdefault('extras', {})['solatelFloorTint'] = [target / max(value, .001) for target, value in zip([.255, .264, .23], mean)]
        replacements[entry['bufferView']] = encode(image, f'{path.stem}-{index}', index in srgb_images)
        entry['mimeType'] = 'image/ktx2'
    packed = bytearray()
    for i, view in enumerate(doc['bufferViews']):
        start = view.get('byteOffset', 0)
        content = replacements.get(i, raw[start:start + view['byteLength']])
        packed.extend(b'\0' * (-len(packed) % 4))
        view['byteOffset'] = len(packed)
        view['byteLength'] = len(content)
        packed.extend(content)
    for texture in doc.get('textures', []):
        texture.setdefault('extensions', {})['KHR_texture_basisu'] = {'source': texture.pop('source')}
    for key in ['extensionsUsed', 'extensionsRequired']:
        doc[key] = sorted(set(doc.get(key, [])) | {'KHR_texture_basisu'})
    doc['buffers'] = [{'byteLength': len(packed)}]
    packing.write_glb(doc, packed, output / path.name)
    print(path.name, 'compressed; source dimensions and geometry retained', flush=True)
