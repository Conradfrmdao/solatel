"""Extract the existing working hand rig without publishing the retired soldier.

Run with the source soldier GLB produced by build-soldier.mjs. Only arm
triangles, their vertices, the skeleton and the gripping clip are retained.
"""
import copy
import importlib.util
import re
import struct
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('packing', Path(__file__).with_name('prepare-assets.py'))
packing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packing)
js, raw = packing.read_glb(sys.argv[1] if len(sys.argv) > 1 else 'assets/characters/soldier.glb')
blob = bytearray(raw)
formats = {5120: 'b', 5121: 'B', 5122: 'h', 5123: 'H', 5125: 'I', 5126: 'f'}
widths = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

def rows(index):
    a = js['accessors'][index]
    v = js['bufferViews'][a['bufferView']]
    fmt = '<' + formats[a['componentType']] * widths[a['type']]
    size = struct.calcsize(fmt)
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    return [bytes(blob[start + i * v.get('byteStride', size):start + i * v.get('byteStride', size) + size]) for i in range(a['count'])], fmt

def append_accessor(template, data, count):
    blob.extend(b'\0' * (-len(blob) % 4))
    view = len(js['bufferViews'])
    js['bufferViews'].append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data)})
    blob.extend(data)
    a = {k: v for k, v in template.items() if k in ('componentType', 'type', 'normalized')}
    a.update(bufferView=view, count=count)
    if a['type'] == 'VEC3' and a['componentType'] == 5126 and count:
        values = list(struct.iter_unpack('<fff', data))
        a['min'] = [min(v[axis] for v in values) for axis in range(3)]
        a['max'] = [max(v[axis] for v in values) for axis in range(3)]
    js['accessors'].append(a)
    return len(js['accessors']) - 1

for node in js['nodes']:
    if 'mesh' not in node:
        continue
    joints = js['skins'][node['skin']]['joints']
    arm = [bool(re.search(r'(Left|Right)(Arm|ForeArm|Hand)', js['nodes'][j].get('name', ''))) for j in joints]
    for p in js['meshes'][node['mesh']]['primitives']:
        joint_rows, jf = rows(p['attributes']['JOINTS_0'])
        weight_rows, wf = rows(p['attributes']['WEIGHTS_0'])
        on_arm = [sum(w for j, w in zip(struct.unpack(jf, jr), struct.unpack(wf, wr)) if arm[j]) >= .5 for jr, wr in zip(joint_rows, weight_rows)]
        ir, fmt = rows(p['indices'])
        indices = [struct.unpack(fmt, r)[0] for r in ir]
        kept = [v for i in range(0, len(indices), 3) if all(on_arm[v] for v in indices[i:i+3]) for v in indices[i:i+3]]
        used = sorted(set(kept))
        remap = {old: new for new, old in enumerate(used)}
        for attr, index in list(p['attributes'].items()):
            values, _ = rows(index)
            p['attributes'][attr] = append_accessor(js['accessors'][index], b''.join(values[i] for i in used), len(used))
        p['indices'] = append_accessor({'componentType': 5125, 'type': 'SCALAR'}, struct.pack('<' + 'I' * len(kept), *(remap[v] for v in kept)), len(kept))

js['animations'] = [a for a in js['animations'] if a['name'] == 'fire']
refs = []
for mesh in js['meshes']:
    for p in mesh['primitives']:
        refs.append((p, 'indices'))
        refs.extend((p['attributes'], k) for k in p['attributes'])
for skin in js['skins']:
    refs.append((skin, 'inverseBindMatrices'))
for animation in js['animations']:
    for sampler in animation['samplers']:
        refs.extend([(sampler, 'input'), (sampler, 'output')])
accessors = sorted({obj[key] for obj, key in refs})
mapping = {old: new for new, old in enumerate(accessors)}
for obj, key in refs:
    obj[key] = mapping[obj[key]]
js['accessors'] = [copy.deepcopy(js['accessors'][i]) for i in accessors]
views = sorted({a['bufferView'] for a in js['accessors']} | {im['bufferView'] for im in js.get('images', [])})
out = bytearray()
new_views = []
for i in views:
    view = dict(js['bufferViews'][i])
    out.extend(b'\0' * (-len(out) % 4))
    start = view.get('byteOffset', 0)
    view['byteOffset'] = len(out)
    out.extend(blob[start:start + view['byteLength']])
    new_views.append(view)
view_map = {old: new for new, old in enumerate(views)}
for obj in js['accessors'] + js.get('images', []):
    obj['bufferView'] = view_map[obj['bufferView']]
js['bufferViews'] = new_views
js['buffers'] = [{'byteLength': len(out)}]
js['asset']['extras'] = {'purpose': 'First person hands and sleeves only; retired soldier body removed.'}
packing.write_glb(js, out, 'assets/characters/firstperson-arms.glb')
