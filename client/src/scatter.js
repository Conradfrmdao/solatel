// Loose rubbish: rubble, grit, broken brick, offcuts, litter and cans at the
// foot of walls and in corners, and twigs and stones on the facility's grass.
//
// Where each piece lies is worked out offline from the drawn map
// (`scripts/scatter.py`, `assets/scatter/<map>.bin`); what each one looks
// like is built here, a few shapes of each kind, and drawn instanced - a draw
// call a shape. The textures are photo sets every map loads already, so the
// whole of it costs a map about a hundred kilobytes.
//
// It is decoration and nothing else: nothing collides with it, nothing is
// taller than a crouched player's ankle, and it is the same at every
// graphics level, so it can neither hide anybody nor be turned off to see
// past.

import * as THREE from 'three';
import { asset } from './assets.js';
import { lightMaterial } from './light.js';
import { photoSet } from './photo.js';

/** What each piece is, by the number the file stores (`KINDS` in
 *  `scatter.py`). */
const KINDS = ['rubble', 'grit', 'brick', 'offcut', 'paper', 'can', 'twig', 'stone'];

/** Shapes made of each kind; a piece picks one by its own number. */
const SHAPES = 3;

/** A small deterministic generator, so every client builds the same shapes. */
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Texture coordinates projected from the side each face points, in metres
 *  times `scale`, so a photograph lies on a chunk at its own size. */
function boxUvs(geometry, scale) {
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i += 1) {
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const nz = Math.abs(normal.getZ(i));
    const x = position.getX(i) * scale;
    const y = position.getY(i) * scale;
    const z = position.getZ(i) * scale;
    const [u, v] = ny >= nx && ny >= nz ? [x, z] : nx >= nz ? [z, y] : [x, y];
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/** Stands a shape on the floor, sunk a centimetre so it never floats. */
function grounded(geometry) {
  geometry.computeBoundingBox();
  geometry.translate(0, -geometry.boundingBox.min.y - 0.01, 0);
  return geometry;
}

/** A lump: a sphere with its corners knocked about, flat-faced. */
function lump(radius, squash, roughness, detail, seed) {
  const next = random(seed);
  const geometry = new THREE.IcosahedronGeometry(radius, detail);
  const position = geometry.attributes.position;
  // Corners shared by several faces move together, or the lump tears.
  const moved = new Map();
  for (let i = 0; i < position.count; i += 1) {
    const key = `${position.getX(i).toFixed(4)},${position.getY(i).toFixed(4)},${position.getZ(i).toFixed(4)}`;
    if (!moved.has(key)) moved.set(key, 1 + (next() - 0.5) * 2 * roughness);
    const k = moved.get(key);
    position.setXYZ(i, position.getX(i) * k, position.getY(i) * k * squash, position.getZ(i) * k);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Several small lumps in a loose patch, as one shape. */
function patch(count, spread, radius, seed) {
  const next = random(seed);
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    const r = radius * (0.5 + next());
    const piece = lump(r, 0.7, 0.3, 0, seed * 31 + i);
    const a = next() * Math.PI * 2;
    const d = Math.sqrt(next()) * spread;
    piece.translate(Math.cos(a) * d, r * 0.4, Math.sin(a) * d);
    parts.push(piece);
  }
  return merged(parts);
}

/** Geometries joined into one, each with its own normals kept. */
function merged(parts) {
  const out = new THREE.BufferGeometry();
  const positions = [];
  const normals = [];
  for (const part of parts) {
    const geometry = part.index ? part.toNonIndexed() : part;
    positions.push(...geometry.attributes.position.array);
    normals.push(...geometry.attributes.normal.array);
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return out;
}

/** A box with its edges a little worn: a brick end, a plank's offcut. */
function chunk(width, height, depth, seed) {
  const next = random(seed);
  const geometry = new THREE.BoxGeometry(width, height, depth, 2, 1, 2).toNonIndexed();
  const position = geometry.attributes.position;
  // Corners shared by several faces move together, or the chunk tears.
  const moved = new Map();
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const key = `${x.toFixed(4)},${position.getY(i).toFixed(4)},${z.toFixed(4)}`;
    // The far end broken off at an angle.
    if (!moved.has(key)) moved.set(key, [x > 0 ? 0.7 + next() * 0.3 : 1, 0.92 + next() * 0.08]);
    const [kx, kz] = moved.get(key);
    position.setX(i, x * kx);
    position.setZ(i, z * kz);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** A sheet of paper: crumpled into a ball, or lying flat with a curl. */
function paper(shape, seed) {
  if (shape === 0) return lump(0.045, 0.8, 0.35, 1, seed);
  const next = random(seed);
  const geometry = new THREE.PlaneGeometry(0.21, 0.297, 4, 4);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    position.setY(i, 0.004 + Math.max(0, x) ** 2 * (1.5 + next()) + Math.abs(z) * 0.03 * next());
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** A drinks can on its side, dented. */
function can(seed) {
  const next = random(seed);
  const geometry = new THREE.CylinderGeometry(0.033, 0.033, 0.115, 12, 2);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    if (Math.abs(position.getY(i)) < 0.01) {
      const k = 0.8 + next() * 0.2;
      position.setX(i, position.getX(i) * k);
    }
  }
  geometry.rotateZ(Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

/** A dead stick, with a kink. */
function twig(seed) {
  const next = random(seed);
  const a = new THREE.CylinderGeometry(0.006, 0.009, 0.18 + next() * 0.1, 5);
  a.rotateZ(Math.PI / 2 + (next() - 0.5) * 0.2);
  const b = new THREE.CylinderGeometry(0.004, 0.006, 0.08 + next() * 0.06, 5);
  b.rotateZ(Math.PI / 2 - 0.6);
  b.translate(0.1, 0.01, 0.02);
  return merged([a, b]);
}

/** Every shape of every kind, standing on the floor with coordinates for
 *  its photograph: at the photograph's own size (metres per repeat, as
 *  `PHOTO` has them), so a chip of brick is a piece of one brick and not a
 *  little patch of wall. */
function shapes() {
  const out = {};
  for (let s = 0; s < SHAPES; s += 1) {
    out[`rubble${s}`] = boxUvs(grounded(lump(0.07, 0.75, 0.35, 0, 11 + s)), 1 / 3.0);
    out[`grit${s}`] = boxUvs(grounded(patch(9, 0.16, 0.012, 21 + s)), 1 / 3.0);
    out[`brick${s}`] = boxUvs(grounded(chunk(0.11, 0.065, 0.1, 31 + s)), 1 / 2.4);
    out[`offcut${s}`] = boxUvs(grounded(chunk(0.38 + s * 0.08, 0.022, 0.075, 41 + s)), 1 / 2.0);
    out[`paper${s}`] = boxUvs(grounded(paper(s === 2 ? 0 : s, 51 + s)), 4);
    out[`can${s}`] = boxUvs(grounded(can(61 + s)), 1 / 1.2);
    out[`twig${s}`] = boxUvs(grounded(twig(71 + s)), 6);
    out[`stone${s}`] = boxUvs(grounded(lump(0.05, 0.7, 0.18, 1, 81 + s)), 1 / 3.0);
  }
  return out;
}

/** The materials, each lit by the map's light as the map is. */
async function materials() {
  const sets = Object.fromEntries(
    await Promise.all(
      ['concrete_wall', 'brick', 'planks', 'painted_metal'].map(async (name) => [
        name,
        await photoSet(name).catch(() => null),
      ]),
    ),
  );
  const photo = (name, options) => {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.9, ...options });
    const set = sets[name];
    if (set) {
      material.map = set.albedo;
      material.normalMap = set.normal;
      material.normalScale = new THREE.Vector2(0.8, 0.8);
    }
    return lightMaterial(material);
  };
  const plain = (options) => lightMaterial(new THREE.MeshStandardMaterial({ roughness: 0.9, ...options }));
  return {
    // The concrete photograph is warm; broken concrete is grey.
    rubble: photo('concrete_wall', { color: 0xdce2ea }),
    grit: photo('concrete_wall', { color: 0x8c9096 }),
    brick: photo('brick', {}),
    offcut: photo('planks', { color: 0xc8b8a0 }),
    paper: plain({ color: 0xa9a397, roughness: 0.95, side: THREE.DoubleSide }),
    can: photo('painted_metal', { metalness: 0.5, roughness: 0.45 }),
    twig: plain({ color: 0x4a3c2c, roughness: 0.95 }),
    stone: photo('concrete_wall', { color: 0x9c907e }),
  };
}

/** The file a map's rubbish is read from, if it has one. */
export function scatterFiles(mapName) {
  try {
    return [asset(`assets/scatter/${mapName}.bin`)];
  } catch {
    return [];
  }
}

/**
 * Lay a map's rubbish down, as a child of `map` (which is drawn at the map's
 * own scale; the pieces are in world metres). Resolves to how many pieces;
 * none if the map has no file, or it could not be read.
 */
export async function scatterRubbish(mapName, map) {
  const [url] = scatterFiles(mapName);
  if (!url) return 0;
  let bytes;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status}`);
    bytes = await response.arrayBuffer();
  } catch (err) {
    console.warn(`rubbish for ${mapName} unavailable:`, err);
    return 0;
  }
  const view = new DataView(bytes);
  if (String.fromCharCode(...new Uint8Array(bytes, 0, 4)) !== 'SCT1') return 0;
  const count = view.getUint32(4, true);
  if (bytes.byteLength !== 8 + count * 16) return 0;

  const [geometries, mats] = [shapes(), await materials()];
  // Sort the pieces by shape, then make one instanced mesh a shape.
  const byShape = new Map();
  for (let i = 0; i < count; i += 1) {
    const at = 8 + i * 16;
    const kind = KINDS[view.getUint8(at + 14)];
    if (!kind) continue;
    const key = `${kind}${view.getUint8(at + 15) % SHAPES}`;
    if (!byShape.has(key)) byShape.set(key, { kind, list: [] });
    byShape.get(key).list.push(at);
  }

  const group = new THREE.Group();
  group.name = 'rubbish';
  group.userData.scenery = true;
  // The map is drawn at its own scale; the pieces were placed in metres.
  group.scale.setScalar(1 / map.scale.x);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const turn = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  for (const [key, { kind, list }] of byShape) {
    const mesh = new THREE.InstancedMesh(geometries[key], mats[kind], list.length);
    list.forEach((at, i) => {
      p.set(view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true));
      const yaw = (view.getUint8(at + 12) / 256) * Math.PI * 2;
      const size = 0.6 + (view.getUint8(at + 13) / 255) * 0.8;
      // Lumps lie any way up; flat things lie flat.
      const tumble = kind === 'rubble' || kind === 'stone' ? (size - 1) * 0.6 : 0;
      q.setFromEuler(turn.set(tumble, yaw, tumble * 0.5, 'YXZ'));
      s.setScalar(size);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      // Each piece a shade of its own; paper and cans more than most.
      const shade = ((at * 2654435761) >>> 0) / 4294967296;
      if (kind === 'can') c.setHSL(shade, 0.55, 0.42);
      else c.setScalar(0.78 + shade * 0.32);
      mesh.setColorAt(i, c);
    });
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  map.add(group);
  return count;
}
