// Builds assets/guns/*.glb from two CC0 weapon packs.
//
//   node scripts/build-guns.mjs <raw-dir> <texture-dir> <out-dir>
//
// Run by scripts/build-guns.sh, which converts the packs' FBX files to binary
// glTF (<raw-dir>, by FBX2glTF) and their textures to KTX2 (<texture-dir>,
// by scripts/gun-textures.py and basisu) first. The packs are CC0 and are
// credited in ATTRIBUTION.md; they are not in the repository, only this.
//
// A file per model, holding its texture set once and a scene for each gun
// drawn with it (`FILES`). Each gun is in metres, muzzle down -Z, +Y up, +X
// to the gun's right, with the origin where the right palm closes on the
// grip, and is made of:
//
//   body       everything that does not move, one mesh per material
//   magazine   the magazine and the rounds in it, about where it seats
//   bolt       what runs back when the gun fires: the AK's carrier and
//              handle, the MP5's cocking handle, the M700's bolt, the
//              pistol's slide - each about its own joint
//   trigger    the trigger, about its pin
//   hammer     the pistol's hammer, about its pin
//   rail       the optic rail or mount, drawn only when an optic is on it
//
// and empty nodes saying where things are: `muzzle`, `port` (where the cases
// leave), `sight_front` and `sight_rear` (the iron sights' line), `rail_top`
// (where an optic's mount sits), `support` (where the left palm closes) and
// `magazine_grip` (where a hand takes the magazine).
//
// The packs come rigged for Unreal: every vertex is skinned to exactly one
// bone, so each bone's triangles are cut out as a part of their own and the
// skin is dropped. Nothing is skinned at run time.
//
// The machine gun is made here from the AK-47, the way the real one was: an
// RPK is an AK with a longer, heavier barrel, a bipod and a drum. The barrel
// is stretched between the gas block and the front sight, and the drum and
// the folded bipod are turned in code and textured from the AK's own sheet,
// from patches of its stamped steel (`PATCH`).
//
// The optics file holds the 3DModelsCC0 scope, cut out of its rifle, with its
// rings' feet at y 0 and its tube along -Z.

import { Document, NodeIO } from '@gltf-transform/core';
import { KHRTextureBasisu } from '@gltf-transform/extensions';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const [, , RAW, TEXTURES, OUT] = process.argv;
if (!OUT) {
  console.error('usage: node build-guns.mjs <raw-dir> <texture-dir> <out-dir>');
  process.exit(2);
}

const STEIN = {
  author: 'Stein Games',
  license: 'CC0 1.0 Universal (public domain dedication)',
  source: 'https://stein-indie.itch.io/classic-weapons-pack',
};

/**
 * Each gun, measured off the download in its own frame - muzzle along +Z,
 * +Y up, the gun's right towards -X, metres - as [y, z] on the centre line.
 * `grip` is where the right palm's middle closes on the pistol grip;
 * `support` where the left palm's closes under the handguard, about 0.26 m
 * ahead of it, which is where the soldier's own clip puts that hand.
 * `roles` names the bones that move; everything else is body.
 */
const GUNS = {
  rifle: {
    title: 'AK-47',
    file: 'AK47',
    textures: 'ak47',
    grip: [-0.01, 0.0],
    support: [0.075, 0.25],
    sights: { front: [0.144, 0.672], rear: [0.142, 0.28] },
    roles: { MAGAZINE: 'magazine', BULLET: 'magazine', SLIDE: 'bolt', TRIGGER: 'trigger' },
  },
  lmg: {
    title: 'RPK, made from the AK-47',
    file: 'AK47',
    textures: 'ak47',
    grip: [-0.01, 0.0],
    support: [0.075, 0.25],
    sights: { front: [0.144, 0.672], rear: [0.142, 0.28] },
    roles: { MAGAZINE: 'magazine', BULLET: 'magazine', SLIDE: 'bolt', TRIGGER: 'trigger' },
    rpk: true,
  },
  smg: {
    title: 'MP5',
    file: 'MP5',
    textures: 'mp5',
    grip: [0.005, 0.01],
    support: [0.1, 0.25],
    sights: { front: [0.176, 0.368], rear: [0.175, 0.0] },
    roles: { MAGASINE: 'magazine', BULLET: 'magazine', BOLT: 'bolt', TRIGGER: 'trigger' },
  },
  sniper: {
    title: 'M700',
    file: 'M700',
    textures: 'm700',
    grip: [-0.035, -0.04],
    support: [0.0, 0.215],
    sights: { front: [0.054, 0.717], rear: [0.054, 0.14] },
    roles: { MAGAZINE: 'magazine', BULLET_01: 'magazine', BULLET_02: 'magazine', BOLT: 'bolt', TRIGGER: 'trigger' },
  },
  pistol: {
    title: 'M1911',
    file: '1911',
    textures: '1911',
    grip: [0.004, -0.01],
    // Cupped under the right hand rather than on the gun: the client says
    // where (`PISTOL_SUPPORT` in guns.js).
    support: null,
    sights: { front: [0.087, 0.171], rear: [0.087, -0.005] },
    roles: { MAGAZINE: 'magazine', BULLET: 'magazine', SLIDE: 'bolt', TRIGGER: 'trigger', HAMMER: 'hammer' },
  },
};

/**
 * The files, by model: each holds one texture set and every gun drawn with
 * it, a scene apiece, so the AK's sheet is downloaded once for the rifle and
 * the machine gun made from it.
 */
const FILES = {
  ak47: ['rifle', 'lmg'],
  mp5: ['smg'],
  m700: ['sniper'],
  m1911: ['pistol'],
};

// ---- small matrix arithmetic, column-major as glTF stores it ---------------

const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const point = (m, v) => [0, 1, 2].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]);
const direction = (m, v) => {
  const d = [0, 1, 2].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2]);
  const l = Math.hypot(...d) || 1;
  return d.map((x) => x / l);
};
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// ---- reading a rigged gun --------------------------------------------------

/**
 * The gun in `file` as loose triangles in its own frame, each tagged with the
 * bone it moves with and the material it is drawn in, and every bone's
 * position.
 */
async function readRig(file) {
  const doc = await new NodeIO().read(file);
  const root = doc.getRoot();
  const joints = new Map();
  for (const node of root.listNodes()) {
    const m = node.getWorldMatrix();
    joints.set(node.getName(), [m[12], m[13], m[14]]);
  }
  const tris = [];
  for (const node of root.listNodes()) {
    const skin = node.getSkin();
    const mesh = node.getMesh();
    if (!skin || !mesh) continue;
    const bones = skin.listJoints();
    const ibm = skin.getInverseBindMatrices();
    const toWorld = bones.map((bone, i) => mul(bone.getWorldMatrix(), Array.from(ibm.getElement(i, []))));
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const nor = prim.getAttribute('NORMAL');
      const uv = prim.getAttribute('TEXCOORD_0');
      const jo = prim.getAttribute('JOINTS_0');
      const we = prim.getAttribute('WEIGHTS_0');
      const idx = prim.getIndices();
      const material = prim.getMaterial()?.getName() ?? '';
      const bone = (i) => {
        const w = we.getElement(i, []);
        // Weights that are not numbers mark the optic rail, which the
        // download hangs off the gun's root and shows only with an optic.
        if (w.some(Number.isNaN)) return -1;
        const j = jo.getElement(i, []);
        let best = 0;
        for (let k = 1; k < 4; k++) if (w[k] > w[best]) best = k;
        return j[best];
      };
      for (let t = 0; t < idx.getCount(); t += 3) {
        const corners = [idx.getScalar(t), idx.getScalar(t + 1), idx.getScalar(t + 2)];
        const b = bone(corners[0]);
        const m = toWorld[Math.max(0, b)];
        tris.push({
          bone: b < 0 ? 'RAIL' : bones[b].getName(),
          material,
          p: corners.map((i) => point(m, pos.getElement(i, []))),
          n: corners.map((i) => direction(m, nor.getElement(i, []))),
          uv: corners.map((i) => uv.getElement(i, [])),
        });
      }
    }
  }
  return { tris, joints };
}

// ---- turning shapes in code, for the RPK ------------------------------------

/**
 * A surface of revolution about the X axis through `centre`: `profile` is
 * [r, x] pairs from one end to the other, swept through `segments` steps.
 * Its texture coordinates are laid on the sheet's patches [u0, v0, u1, v1]:
 * flat faces on `faces` by where they are, bands on `band` by how far round
 * and along.
 */
function lathe(profile, centre, segments, band, faces) {
  const out = [];
  const [cx, cy, cz] = centre;
  const R = Math.max(...profile.map(([r]) => r));
  for (let i = 0; i + 1 < profile.length; i++) {
    const [r0, x0] = profile[i];
    const [r1, x1] = profile[i + 1];
    const flat = Math.abs(x1 - x0) < 1e-6;
    const dr = r1 - r0;
    const dx = x1 - x0;
    // The outward normal of this ring of the profile, in (r, x).
    const len = Math.hypot(dr, dx) || 1;
    const nr = dx / len;
    const nx = -dr / len;
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * Math.PI * 2;
      const a1 = ((s + 1) / segments) * Math.PI * 2;
      const at = (r, x, a) => [cx + x, cy + r * Math.cos(a), cz + r * Math.sin(a)];
      const nAt = (a) => [nx, nr * Math.cos(a), nr * Math.sin(a)];
      const uvAt = (r, x, a, end) => {
        if (flat && faces) {
          const fu = 0.5 + (r * Math.cos(a)) / (2 * R);
          const fv = 0.5 + (r * Math.sin(a)) / (2 * R);
          return [faces[0] + fu * (faces[2] - faces[0]), faces[1] + fv * (faces[3] - faces[1])];
        }
        const fu = a / (Math.PI * 2);
        const fv = (i + end) / (profile.length - 1);
        return [band[0] + fu * (band[2] - band[0]), band[1] + fv * (band[3] - band[1])];
      };
      const q = [
        [r0, x0, a0, 0],
        [r1, x1, a0, 1],
        [r1, x1, a1, 1],
        [r0, x0, a1, 0],
      ];
      // Wound so the front face is the outside.
      for (const tri of [[0, 2, 1], [0, 3, 2]]) {
        const corners = tri.map((k) => q[k]);
        // Skip triangles that collapse on the axis.
        if (corners.filter(([r]) => r < 1e-7).length > 1) continue;
        out.push({
          p: corners.map(([r, x, a]) => at(r, x, a)),
          n: corners.map(([, , a]) => nAt(a)),
          uv: corners.map(([r, x, a, end]) => uvAt(r, x, a, end)),
        });
      }
    }
  }
  return out;
}

/** A capped rod from `a` to `b` of radius `radius`, as triangles. */
function rod(a, b, radius, segments, patch) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const length = Math.hypot(...d);
  const w = d.map((v) => v / length);
  // Two directions across it.
  const helper = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = [w[1] * helper[2] - w[2] * helper[1], w[2] * helper[0] - w[0] * helper[2], w[0] * helper[1] - w[1] * helper[0]];
  const ul = Math.hypot(...u);
  for (let k = 0; k < 3; k++) u[k] /= ul;
  const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const out = [];
  const ring = (c, a) => [0, 1, 2].map((k) => c[k] + radius * (Math.cos(a) * u[k] + Math.sin(a) * v[k]));
  const normal = (a) => [0, 1, 2].map((k) => Math.cos(a) * u[k] + Math.sin(a) * v[k]);
  for (let s = 0; s < segments; s++) {
    const a0 = (s / segments) * Math.PI * 2;
    const a1 = ((s + 1) / segments) * Math.PI * 2;
    const uvs = [
      [patch[0] + (s / segments) * (patch[2] - patch[0]), patch[1]],
      [patch[0] + (s / segments) * (patch[2] - patch[0]), patch[3]],
      [patch[0] + ((s + 1) / segments) * (patch[2] - patch[0]), patch[3]],
      [patch[0] + ((s + 1) / segments) * (patch[2] - patch[0]), patch[1]],
    ];
    const q = [ring(a, a0), ring(b, a0), ring(b, a1), ring(a, a1)];
    const n = [normal(a0), normal(a0), normal(a1), normal(a1)];
    // Wound so the front face is the outside.
    out.push({ p: [q[0], q[2], q[1]], n: [n[0], n[2], n[1]], uv: [uvs[0], uvs[2], uvs[1]] });
    out.push({ p: [q[0], q[3], q[2]], n: [n[0], n[3], n[2]], uv: [uvs[0], uvs[3], uvs[2]] });
  }
  // Caps, so a rod's end is not a hole.
  for (const [c, sign] of [[a, -1], [b, 1]]) {
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * Math.PI * 2;
      const a1 = ((s + 1) / segments) * Math.PI * 2;
      const nn = w.map((x) => x * sign);
      const tri = sign > 0 ? [c, ring(c, a0), ring(c, a1)] : [c, ring(c, a1), ring(c, a0)];
      const uv = [patch[0], patch[1]];
      out.push({ p: tri, n: [nn, nn, nn], uv: [uv, uv, uv] });
    }
  }
  return out;
}

/**
 * Patches of the AK's sheet, as [u0, v0, u1, v1] with v down the image: the
 * dust cover's stamped steel for the drum's faces and band, the barrel's
 * blued tube for the bipod.
 */
const PATCH = {
  drumFace: [0.15, 0.51, 0.285, 0.645],
  drumBand: [0.1, 0.555, 0.7, 0.6],
  bipod: [0.02, 0.19, 0.42, 0.203],
};

/**
 * The AK made an RPK, in the AK's own frame: the barrel stretched between
 * the gas block and the front sight by `RPK.longer`, the magazine cut down to
 * its throat and a 75-round drum under it, and a bipod folded along the
 * barrel.
 */
const RPK = {
  /** The bare barrel between the gas block and the front sight's base. */
  from: 0.565,
  to: 0.645,
  longer: 0.17,
  /** The bore's height, and the barrel's radius there. */
  bore: 0.096,
  barrel: 0.0115,
  /** Where the magazine is cut to a throat for the drum. */
  throat: -0.01,
  drum: { radius: 0.075, thickness: 0.062 },
};

function stretch(z) {
  if (z <= RPK.from) return z;
  if (z >= RPK.to) return z + RPK.longer;
  return RPK.from + ((z - RPK.from) * (RPK.to - RPK.from + RPK.longer)) / (RPK.to - RPK.from);
}

function makeRpk(rig) {
  for (const tri of rig.tris) for (const p of tri.p) p[2] = stretch(p[2]);
  for (const [name, p] of rig.joints) rig.joints.set(name, [p[0], p[1], stretch(p[2])]);

  // The magazine cut to its throat: everything below the cut is folded up
  // into a sliver inside the drum, where it is never seen.
  const mag = rig.tris.filter((t) => t.bone === 'MAGAZINE');
  const nearCut = mag.flatMap((t) => t.p).filter((p) => Math.abs(p[1] - RPK.throat) < 0.006);
  const cutZ = nearCut.reduce((s, p) => s + p[2], 0) / Math.max(1, nearCut.length);
  for (const tri of mag) {
    for (const p of tri.p) {
      if (p[1] >= RPK.throat) continue;
      p[1] = RPK.throat - (RPK.throat - p[1]) * 0.04;
      p[2] = cutZ + (p[2] - cutZ) * 0.04;
    }
  }

  // The drum, its feed throat's foot inside it: a flat pancake turned about
  // the gun's cross axis, with a lip round each face, two stamped rings and
  // the winding key's boss on one side.
  const { radius: R, thickness: T } = RPK.drum;
  const centre = [0, RPK.throat - R + 0.016, cutZ + 0.012];
  const h = T / 2;
  const e = 0.006;
  const shell = [
    [0, -h], [0.025, -h], [0.027, -h - 0.002], [0.05, -h - 0.002], [0.052, -h],
    [R - e, -h], [R - e * 0.3, -h + e * 0.3], [R, -h + e],
    [R, -0.004], [R + 0.002, -0.002], [R + 0.002, 0.002], [R, 0.004],
    [R, h - e], [R - e * 0.3, h - e * 0.3], [R - e, h],
    [0.052, h], [0.05, h + 0.002], [0.027, h + 0.002], [0.025, h], [0, h],
  ];
  const drum = lathe(shell, centre, 40, PATCH.drumBand, PATCH.drumFace);
  const key = lathe([[0, h + 0.012], [0.012, h + 0.012], [0.014, h + 0.009], [0.014, h], [0.0001, h]], centre, 20, PATCH.drumBand, PATCH.drumFace);
  for (const t of [...drum, ...key]) rig.tris.push({ bone: 'MAGAZINE', material: 'WPN_AKC.001', ...t });

  // The bipod, folded: a clamp round the barrel just ahead of the gas block,
  // and two legs along the barrel's lower flanks with their feet towards the
  // muzzle.
  const clampZ = RPK.from + 0.035;
  const b = RPK.bore;
  const clamp = lathe(
    [[RPK.barrel, -0.012], [RPK.barrel + 0.006, -0.012], [RPK.barrel + 0.007, -0.01], [RPK.barrel + 0.007, 0.01], [RPK.barrel + 0.006, 0.012], [RPK.barrel, 0.012]],
    [0, 0, 0],
    24,
    PATCH.bipod,
    null,
  ).map((t) => ({
    // Turned about X; laid round the bore, which runs along Z. (x, y, z) to
    // (y, z, x) is a rotation, so the winding holds.
    p: t.p.map(([x, y, z]) => [y, b + z, clampZ + x]),
    n: t.n.map(([x, y, z]) => [y, z, x]),
    uv: t.uv,
  }));
  const legs = [];
  for (const side of [-1, 1]) {
    const hinge = [side * 0.012, b - 0.016, clampZ + 0.004];
    const foot = [side * 0.017, b - 0.024, clampZ + 0.25];
    legs.push(...rod(hinge, foot, 0.0045, 10, PATCH.bipod));
    // A foot: a short spike.
    legs.push(...rod(foot, [foot[0] + side * 0.002, foot[1] - 0.004, foot[2] + 0.022], 0.0065, 10, PATCH.bipod));
    // The hinge's yoke from the clamp down to the leg.
    legs.push(...rod([side * 0.008, b - 0.014, clampZ], hinge, 0.004, 8, PATCH.bipod));
  }
  for (const t of [...clamp, ...legs]) rig.tris.push({ bone: 'ANCHOR', material: 'WPN_AKC.001', ...t });
}

// ---- writing a gun ---------------------------------------------------------

async function texture(doc, file) {
  return doc
    .createTexture(path.basename(file, '.ktx2'))
    .setImage(new Uint8Array(await readFile(file)))
    .setMimeType('image/ktx2');
}

/** The frame a gun file is in, from the download's. */
function toGun(spec) {
  const [gy, gz] = spec.grip;
  return {
    p: ([x, y, z]) => [-x, y - gy, -(z - gz)],
    n: ([x, y, z]) => [-x, y, -z],
  };
}

function addMesh(doc, buffer, name, tris, material, pivot) {
  // Weld identical corners back together: a vertex is shared by every
  // triangle that names it exactly.
  const key = new Map();
  const P = [];
  const N = [];
  const U = [];
  const I = [];
  for (const tri of tris) {
    for (let k = 0; k < 3; k++) {
      const p = [tri.p[k][0] - pivot[0], tri.p[k][1] - pivot[1], tri.p[k][2] - pivot[2]];
      const id = [...p.map((v) => v.toFixed(6)), ...tri.n[k].map((v) => v.toFixed(3)), ...tri.uv[k].map((v) => v.toFixed(5))].join(',');
      let at = key.get(id);
      if (at === undefined) {
        at = P.length / 3;
        key.set(id, at);
        P.push(...p);
        N.push(...tri.n[k]);
        U.push(...tri.uv[k]);
      }
      I.push(at);
    }
  }
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(P)).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(N)).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(U)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(P.length / 3 > 65535 ? new Uint32Array(I) : new Uint16Array(I)).setBuffer(buffer))
    .setMaterial(material);
  return doc.createMesh(name).addPrimitive(prim);
}

function bounds(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[k]);
    max[k] = Math.max(max[k], p[k]);
  }
  return { min, max, centre: min.map((v, k) => (v + max[k]) / 2) };
}

/** The materials of one texture set, made once per file. */
async function materials(doc, set) {
  const ktx = (kind) => path.join(TEXTURES, `${set}-${kind}.ktx2`);
  const orm = await texture(doc, ktx('orm'));
  const gun = doc
    .createMaterial('gun')
    .setBaseColorTexture(await texture(doc, ktx('color')))
    .setNormalTexture(await texture(doc, ktx('normal')))
    .setMetallicRoughnessTexture(orm)
    .setOcclusionTexture(orm)
    .setMetallicFactor(1)
    .setRoughnessFactor(1);
  const brass = doc.createMaterial('brass').setBaseColorFactor([0.62, 0.45, 0.22, 1]).setMetallicFactor(1).setRoughnessFactor(0.32);
  const glow = doc.createMaterial('tritium').setBaseColorFactor([0.2, 0.9, 0.3, 1]).setEmissiveFactor([0.3, 1, 0.4]).setRoughnessFactor(0.4);
  return (name) => (/BULLET/i.test(name) ? brass : /Glow/i.test(name) ? glow : gun);
}

/** Adds the gun `id` to `doc` as a scene of its own, named `id`. */
async function addGun(doc, buffer, materialFor, id, spec) {
  const rig = await readRig(path.join(RAW, `${spec.file}.glb`));
  if (spec.rpk) makeRpk(rig);
  const frame = toGun(spec);
  const tris = rig.tris.map((t) => ({ ...t, p: t.p.map(frame.p), n: t.n.map(frame.n) }));
  const joint = (name) => frame.p(rig.joints.get(name));

  const scene = doc.createScene(id);
  const root = doc.createNode(id);
  scene.addChild(root);

  // Which part each triangle moves with.
  const roleOf = (bone) => (bone === 'RAIL' ? 'rail' : spec.roles[bone] ?? 'body');
  const parts = new Map();
  for (const t of tris) {
    const role = roleOf(t.bone);
    if (!parts.has(role)) parts.set(role, []);
    parts.get(role).push(t);
  }
  const summary = [];
  for (const [role, list] of parts) {
    // A moving part turns about its own bone - the first named for it; the
    // rounds ride the magazine.
    const bone = Object.keys(spec.roles).find((b) => spec.roles[b] === role);
    const pivot = role === 'body' || role === 'rail' ? [0, 0, 0] : joint(bone);
    const node = doc.createNode(role).setTranslation(pivot);
    const byMaterial = new Map();
    for (const t of list) {
      const m = materialFor(t.material);
      if (!byMaterial.has(m)) byMaterial.set(m, []);
      byMaterial.get(m).push(t);
    }
    let i = 0;
    for (const [material, group] of byMaterial) {
      const mesh = addMesh(doc, buffer, `${id}_${role}_${material.getName()}`, group, material, pivot);
      if (i === 0) node.setMesh(mesh);
      else node.addChild(doc.createNode(`${role}_${material.getName()}`).setMesh(mesh));
      i += 1;
    }
    root.addChild(node);
    summary.push(`${role} ${list.length}`);
  }

  // Where things are.
  const sockets = {};
  const at = (name, p) => {
    sockets[name] = p.map((v) => +v.toFixed(4));
    root.addChild(doc.createNode(name).setTranslation(p));
  };
  at('muzzle', joint('FX_FIRE'));
  at('port', joint('FX_CASING'));
  const [fy, fz] = spec.sights.front;
  const [ry, rz] = spec.sights.rear;
  at('sight_front', frame.p([0, fy, spec.rpk ? stretch(fz) : fz]));
  at('sight_rear', frame.p([0, ry, rz]));
  if (spec.support) at('support', frame.p([0, ...spec.support]));
  const magazine = bounds((parts.get('magazine') ?? []).flatMap((t) => t.p));
  at('magazine_grip', magazine.centre);
  if (parts.has('rail')) {
    const rail = bounds(parts.get('rail').flatMap((t) => t.p));
    const scope = joint('ATTACH_SCOPE');
    at('rail_top', [0, rail.max[1], scope[2]]);
    root.setExtras({ rail: { top: +rail.max[1].toFixed(4), back: +rail.max[2].toFixed(4), front: +rail.min[2].toFixed(4) } });
  }
  console.log(`   ${id.padEnd(7)} ${summary.join(', ')} triangles; ${JSON.stringify(sockets)}`);
}

async function buildFile(name, ids) {
  const doc = new Document();
  doc.createExtension(KHRTextureBasisu).setRequired(true);
  const buffer = doc.createBuffer();
  const materialFor = await materials(doc, GUNS[ids[0]].textures);
  for (const id of ids) await addGun(doc, buffer, materialFor, id, GUNS[id]);
  doc.getRoot().getAsset().extras = {
    title: ids.map((id) => `${GUNS[id].title} (${id})`).join(', '),
    author: ids.some((id) => GUNS[id].rpk) ? `${STEIN.author}; the RPK's barrel, drum and bipod by Solatel` : STEIN.author,
    license: STEIN.license,
    source: STEIN.source,
  };
  await new NodeIO().registerExtensions([KHRTextureBasisu]).write(path.join(OUT, `${name}.glb`), doc);
}

// ---- the optics ------------------------------------------------------------

/** The scope's island on the sniper's sheet; must match gun-textures.py. */
const SCOPE_CROP = [0.06, 0.26, 0.56, 0.7];

async function buildOptics() {
  const source = await new NodeIO().read(path.join(RAW, 'cc0-Sniper.glb'));
  const node = source.getRoot().listNodes().find((n) => n.getName() === 'Scope');
  const prim = node.getMesh().listPrimitives()[0];
  const pos = prim.getAttribute('POSITION');
  const nor = prim.getAttribute('NORMAL');
  const uv = prim.getAttribute('TEXCOORD_0');
  const idx = prim.getIndices();
  // In the scope's own frame, before its rifle's tilt: the tube along Z with
  // the objective towards -Z, the rings' feet underneath.
  const vertices = [];
  for (let i = 0; i < pos.getCount(); i++) vertices.push(pos.getElement(i, []));
  const box = bounds(vertices);
  const foot = box.min[1];
  const middle = box.centre[2];
  const [u0, v0, u1, v1] = SCOPE_CROP;
  // A plain patch of the tube for the few specks outside the crop.
  const plain = [0.5, 0.5];
  const tris = [];
  for (let t = 0; t < idx.getCount(); t += 3) {
    const corners = [idx.getScalar(t), idx.getScalar(t + 1), idx.getScalar(t + 2)];
    const uvs = corners.map((i) => uv.getElement(i, []));
    const inside = uvs.every(([u, v]) => u >= u0 && u <= u1 && v >= v0 && v <= v1);
    tris.push({
      p: corners.map((i) => {
        const [x, y, z] = pos.getElement(i, []);
        return [x - box.centre[0], y - foot, z - middle];
      }),
      n: corners.map((i) => direction(IDENTITY, nor.getElement(i, []))),
      uv: uvs.map(([u, v]) => (inside ? [(u - u0) / (u1 - u0), (v - v0) / (v1 - v0)] : plain)),
    });
  }
  // The tube's axis: the middle of the objective's rim.
  const front = bounds(tris.flatMap((t) => t.p).filter((p) => p[2] < box.min[2] - middle + 0.01));
  const axis = front.centre[1];

  const doc = new Document();
  doc.createExtension(KHRTextureBasisu).setRequired(true);
  const buffer = doc.createBuffer();
  const ktx = (kind) => path.join(TEXTURES, `scope-${kind}.ktx2`);
  const orm = await texture(doc, ktx('orm'));
  const material = doc
    .createMaterial('scope')
    .setBaseColorTexture(await texture(doc, ktx('color')))
    .setNormalTexture(await texture(doc, ktx('normal')))
    .setMetallicRoughnessTexture(orm)
    .setOcclusionTexture(orm);
  const scene = doc.createScene('optics');
  const scope = doc.createNode('scope').setMesh(addMesh(doc, buffer, 'scope', tris, material, [0, 0, 0]));
  scope.setExtras({ axis: +axis.toFixed(4), front: +(box.min[2] - middle).toFixed(4), back: +(box.max[2] - middle).toFixed(4) });
  scene.addChild(scope);
  doc.getRoot().getAsset().extras = {
    title: 'Rifle scope, from the sniper rifle in the Guns & Explosives pack',
    author: '3DModelsCC0',
    license: 'CC0 1.0 Universal (public domain dedication)',
    source: 'https://3dmodelscc0.itch.io/free-cc0-guns-explosives-pack',
  };
  await new NodeIO().registerExtensions([KHRTextureBasisu]).write(path.join(OUT, 'optics.glb'), doc);
  console.log(`   optics  scope ${tris.length} triangles, axis ${axis.toFixed(4)} above its feet, ${(box.max[2] - box.min[2]).toFixed(3)} m long`);
}

await mkdir(OUT, { recursive: true });
console.log('>> guns');
for (const [name, ids] of Object.entries(FILES)) await buildFile(name, ids);
await buildOptics();
