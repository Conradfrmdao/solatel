// The soldier everybody else sees, built here rather than downloaded.
//
// # Why it is generated
//
// The model this game shipped with was a man in a leather suit holding a
// knife, and nothing about him said "soldier". What was worth keeping was
// under the skin: a rig of 41 bones, and idle, walk, run and jump clips that
// already move him correctly. So the skin is replaced and the rig is not.
//
// The new one is kit, built from boxes, capsules and spheres placed on the
// rig's bind pose: a helmet with rails, a headset and night-vision goggles
// flipped up, a balaclava and goggles over the face, a plate carrier with
// magazine pouches and a radio, a camouflage uniform, gloves, knee pads and
// boots. Every piece is assigned to the bone it moves with, and the lot is
// merged into one skinned mesh bound to the rig's own skeleton - so the
// clips, the IK that puts the hands on the rifle and the aim lean all carry
// on working unchanged, and a player costs one draw call however much kit
// they wear.
//
// # How a piece is placed
//
// In the model's own space at bind pose: +Y up, +Z the way he faces, -X to
// his right, metres. Positions are given relative to a joint, read off the
// rig at load, so the kit follows the skeleton's proportions rather than a
// copy of them written down here.
//
// Limbs are capsules from one joint to the next, and the last quarter of
// each is weighted halfway onto the next bone, so an elbow or a knee bends
// the sleeve rather than splitting it.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** The kit's colours: black and olive, a night-raid palette. */
const COLOUR = {
  gear: '#262620',
  pouch: '#2e2d25',
  plate: '#1f1f1a',
  black: '#121212',
  boot: '#17150f',
  helmet: '#2b2e28',
  lens: '#16241d',
  mask: '#1d1d1c',
  metal: '#3a3b3a',
  strap: '#33322a',
};

/** Where the camouflage texture is plain white, for pieces that are one
 *  flat colour: their UVs all point here, and the vertex colour does the rest. */
const PLAIN_UV = 0.985;

/**
 * A woodland pattern in blacks and olives, drawn once.
 *
 * Deterministic - a fixed seed - so every player's uniform is the same
 * cloth. Blobs of four tones over a base, three passes from large to small,
 * which is how printed camouflage is layered.
 */
function camoTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#343829';
  g.fillRect(0, 0, size, size);

  let seed = 1337;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const tones = ['#1d2017', '#4a4e3b', '#5c5a44', '#272a1f'];
  for (const [count, scale] of [[26, 30], [60, 16], [110, 8]]) {
    for (let i = 0; i < count; i += 1) {
      g.fillStyle = tones[Math.floor(random() * tones.length)];
      const x = random() * size;
      const y = random() * size;
      g.beginPath();
      // A blob is a few overlapping ellipses, drawn wrapped so the texture
      // tiles without a seam.
      for (let k = 0; k < 3; k += 1) {
        const rx = scale * (0.6 + random());
        const ry = scale * (0.4 + random() * 0.8);
        const ox = (random() - 0.5) * scale;
        const oy = (random() - 0.5) * scale;
        for (const dx of [-size, 0, size]) {
          for (const dy of [-size, 0, size]) {
            g.moveTo(x + ox + dx + rx, y + oy + dy);
            g.ellipse(x + ox + dx, y + oy + dy, rx, ry, random() * Math.PI, 0, Math.PI * 2);
          }
        }
      }
      g.fill();
    }
  }
  // The plain corner, top right: UV (1, 1) once the texture is flipped.
  g.fillStyle = '#ffffff';
  g.fillRect(size - 8, 0, 8, 8);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * Replaces the template's meshes with the generated kit, bound to the same
 * skeleton. Call once on the loaded template, before it is cloned.
 */
export function dressSoldier(template) {
  template.updateMatrixWorld(true);

  let body = null;
  template.traverse((node) => {
    if (!body && node.isSkinnedMesh && node.skeleton.getBoneByName('hips_01')) body = node;
  });
  if (!body) {
    console.warn('no rigged body to dress; keeping the original model');
    return;
  }
  const skeleton = body.skeleton;
  // Names as the file spells them; three.js drops the dots when it loads
  // them ("fingers_L.001" arrives as "fingers_L001"), so both are accepted.
  const plain = (name) => name.replace(/\./g, '');
  const boneIndex = new Map(skeleton.bones.map((bone, i) => [plain(bone.name), i]));
  const joint = (name) => {
    const index = boneIndex.get(plain(name));
    if (index === undefined) throw new Error(`the rig has no ${name}`);
    return new THREE.Vector3().setFromMatrixPosition(skeleton.bones[index].matrixWorld);
  };

  const parts = [];
  const tint = new THREE.Color();

  /**
   * Adds a piece. `geometry` is in model space already; `bone` is what it
   * moves with, and `blend`, if given, is a second bone the far end of a
   * limb eases onto.
   */
  const add = (geometry, bone, colour, { camo = false, blend = null, from = null, to = null } = {}) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const count = g.attributes.position.count;
    const colours = new Float32Array(count * 3);
    tint.set(camo ? '#ffffff' : colour);
    for (let i = 0; i < count; i += 1) colours.set([tint.r, tint.g, tint.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colours, 3));

    if (!camo) {
      const uv = g.attributes.uv;
      for (let i = 0; i < count; i += 1) uv.setXY(i, PLAIN_UV, PLAIN_UV);
    }

    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    const main = boneIndex.get(plain(bone));
    const next = blend ? boneIndex.get(plain(blend)) : undefined;
    const position = g.attributes.position;
    const along = new THREE.Vector3();
    const span = from && to ? to.clone().sub(from) : null;
    const spanLength = span ? span.lengthSq() : 0;
    for (let i = 0; i < count; i += 1) {
      skinIndex[i * 4] = main;
      skinWeight[i * 4] = 1;
      if (next !== undefined && span && spanLength > 0) {
        along.fromBufferAttribute(position, i).sub(from);
        const t = along.dot(span) / spanLength;
        const w = Math.min(0.5, Math.max(0, (t - 0.72) / 0.28) * 0.5);
        if (w > 0) {
          skinIndex[i * 4 + 1] = next;
          skinWeight[i * 4] = 1 - w;
          skinWeight[i * 4 + 1] = w;
        }
      }
    }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    parts.push(g);
  };

  // ---- shapes, in model space -------------------------------------------
  const up = new THREE.Vector3(0, 1, 0);
  const box = (center, size, radius = 0.015, rotation = null) => {
    const g = new RoundedBoxGeometry(size[0], size[1], size[2], 2, Math.min(radius, Math.min(...size) / 2 - 1e-4));
    if (rotation) g.applyQuaternion(rotation);
    g.translate(center.x, center.y, center.z);
    return g;
  };
  const capsule = (a, b, radius, radial = 10) => {
    const direction = b.clone().sub(a);
    const length = Math.max(1e-3, direction.length());
    const g = new THREE.CapsuleGeometry(radius, length, 4, radial);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, direction.normalize()));
    const middle = a.clone().add(b).multiplyScalar(0.5);
    g.translate(middle.x, middle.y, middle.z);
    return g;
  };
  const ellipsoid = (center, radius, scale, segments = 14) => {
    const g = new THREE.SphereGeometry(radius, segments, Math.round(segments * 0.75));
    g.scale(scale[0], scale[1], scale[2]);
    g.translate(center.x, center.y, center.z);
    return g;
  };
  const cylinder = (center, radius, height, axis, segments = 12) => {
    const g = new THREE.CylinderGeometry(radius, radius, height, segments);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, axis.clone().normalize()));
    g.translate(center.x, center.y, center.z);
    return g;
  };
  const at = (base, x, y, z) => base.clone().add(new THREE.Vector3(x, y, z));
  const facing = (x, z) => new THREE.Quaternion().setFromAxisAngle(up, Math.atan2(x, z));

  // ---- legs ---------------------------------------------------------------
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;
    const names = side === 'L'
      ? { thigh: 'thigh_L_032', leg: 'leg_L_033', foot: 'foot_L_034', toes: 'toes_L_035' }
      : { thigh: 'thigh_R_036', leg: 'leg_R_037', foot: 'foot_R_038', toes: 'toes_R_039' };
    const hip = joint(names.thigh);
    const knee = joint(names.leg);
    const ankle = joint(names.foot);
    const toe = joint(names.toes);

    add(capsule(hip, knee, 0.088), names.thigh, null, { camo: true, blend: names.leg, from: hip, to: knee });
    add(capsule(knee, ankle, 0.066), names.leg, null, { camo: true, blend: names.foot, from: knee, to: ankle });
    // Knee pad, on the front of the knee.
    add(box(at(knee, 0, -0.03, 0.075), [0.105, 0.13, 0.05], 0.02), names.leg, COLOUR.black);
    // Drop pouch on the right thigh, holster strap on the left.
    const thighMiddle = hip.clone().lerp(knee, 0.45);
    if (s < 0) add(box(at(thighMiddle, -0.085, 0, 0.0), [0.05, 0.17, 0.12], 0.015), names.thigh, COLOUR.pouch);
    add(box(at(thighMiddle, 0, -0.04, 0), [0.19, 0.035, 0.19], 0.01), names.thigh, COLOUR.strap);

    // Boot: along the foot, sat on the ground.
    const heading = new THREE.Vector3(toe.x - ankle.x, 0, toe.z - ankle.z);
    const turn = facing(heading.x, heading.z);
    const bootCentre = ankle.clone().lerp(toe, 0.45);
    bootCentre.y = 0.06;
    add(box(bootCentre, [0.115, 0.12, Math.max(0.26, heading.length() + 0.13)], 0.03, turn), names.foot, COLOUR.boot);
    add(cylinder(at(ankle, 0, -0.02, 0), 0.07, 0.12, up), names.foot, COLOUR.boot);
  }

  // ---- hips and torso -----------------------------------------------------
  const hips = joint('hips_01');
  const spine = joint('spine_02');
  const chest = joint('chest_03');
  const neck = joint('neck_04');
  const head = joint('head_05');

  add(box(at(hips, 0, 0.02, 0), [0.35, 0.21, 0.24], 0.06), 'hips_01', null, { camo: true });
  add(box(at(hips, 0, 0.11, 0), [0.37, 0.06, 0.26], 0.02), 'hips_01', COLOUR.gear);
  add(box(at(hips, 0.0, 0.11, 0.135), [0.07, 0.05, 0.02], 0.008), 'hips_01', COLOUR.metal);
  add(box(at(spine, 0, 0.12, 0), [0.33, 0.3, 0.22], 0.07), 'spine_02', null, { camo: true });
  add(box(at(chest, 0, 0.08, 0.005), [0.39, 0.28, 0.25], 0.08), 'chest_03', null, { camo: true });

  // Plate carrier: plates front and back, a cummerbund round the middle,
  // straps over the shoulders.
  add(box(at(chest, 0, 0.03, 0.14), [0.31, 0.31, 0.05], 0.02), 'chest_03', COLOUR.gear);
  add(box(at(chest, 0, 0.06, -0.145), [0.31, 0.33, 0.05], 0.02), 'chest_03', COLOUR.gear);
  add(box(at(chest, 0, -0.1, 0), [0.37, 0.13, 0.3], 0.03), 'chest_03', COLOUR.plate);
  for (const x of [-0.115, 0.115]) {
    add(box(at(chest, x, 0.18, -0.005), [0.075, 0.035, 0.28], 0.012), 'chest_03', COLOUR.gear);
  }
  // Three rifle magazines in pouches across the front, their tops showing.
  for (const x of [-0.085, 0, 0.085]) {
    add(box(at(chest, x, -0.04, 0.185), [0.075, 0.14, 0.05], 0.012), 'chest_03', COLOUR.pouch);
    add(box(at(chest, x, 0.04, 0.183), [0.05, 0.035, 0.03], 0.006), 'chest_03', COLOUR.black);
  }
  // Admin pouch high on the chest, radio on the left side with its antenna.
  add(box(at(chest, 0, 0.14, 0.17), [0.16, 0.06, 0.03], 0.01), 'chest_03', COLOUR.pouch);
  add(box(at(chest, 0.2, -0.02, -0.02), [0.05, 0.15, 0.08], 0.012), 'chest_03', COLOUR.black);
  add(cylinder(at(chest, 0.205, 0.15, -0.04), 0.006, 0.22, up, 6), 'chest_03', COLOUR.black);

  // ---- head ----------------------------------------------------------------
  add(capsule(neck, at(head, 0, 0.03, 0), 0.055), 'neck_04', COLOUR.black);
  // Balaclava over the whole head: no face to get wrong.
  add(ellipsoid(at(head, 0, 0.09, 0.012), 0.1, [0.92, 1.1, 1.02]), 'head_05', COLOUR.mask);
  // Goggles: a frame across the eyes, two lenses in it, a strap round.
  add(box(at(head, 0, 0.1, 0.088), [0.18, 0.055, 0.04], 0.018), 'head_05', COLOUR.black);
  for (const x of [-0.042, 0.042]) {
    add(box(at(head, x, 0.1, 0.106), [0.07, 0.042, 0.012], 0.012), 'head_05', COLOUR.lens);
  }
  add(box(at(head, 0, 0.1, 0.02), [0.205, 0.022, 0.15], 0.008), 'head_05', COLOUR.strap);
  // Helmet: the crown of a sphere, cut above the ears, with rails either
  // side and a night-vision mount on the front.
  const helmet = new THREE.SphereGeometry(0.128, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52);
  helmet.scale(1.0, 0.92, 1.08);
  helmet.translate(head.x, head.y + 0.1, head.z - 0.005);
  add(helmet, 'head_05', COLOUR.helmet);
  for (const x of [-0.125, 0.125]) {
    add(box(at(head, x, 0.105, -0.005), [0.02, 0.03, 0.13], 0.006), 'head_05', COLOUR.black);
    // Ear cups of the headset.
    add(cylinder(at(head, x * 0.95, 0.075, 0.0), 0.045, 0.035, new THREE.Vector3(1, 0, 0)), 'head_05', COLOUR.black);
  }
  add(box(at(head, 0, 0.175, 0.118), [0.05, 0.04, 0.03], 0.008), 'head_05', COLOUR.black);
  // Night vision, flipped up against the front of the helmet: a body and
  // two short tubes lying back along the shell.
  add(box(at(head, 0, 0.2, 0.125), [0.095, 0.042, 0.05], 0.012), 'head_05', COLOUR.black);
  for (const x of [-0.028, 0.028]) {
    add(cylinder(at(head, x, 0.222, 0.1), 0.016, 0.05, new THREE.Vector3(0, 1, -0.9), 10), 'head_05', COLOUR.metal);
  }
  // Mic boom from the left cup round to the mouth.
  add(capsule(at(head, 0.11, 0.06, 0.03), at(head, 0.04, 0.035, 0.105), 0.006, 6), 'head_05', COLOUR.black);

  // ---- arms ----------------------------------------------------------------
  for (const side of ['L', 'R']) {
    const names = side === 'L'
      ? { upper: 'up_arm_L_08', lower: 'low_arm_L_09', hand: 'hand_L_010', fingers: 'fingers_L.001_00', thumb: 'thumb_L.001_017' }
      : { upper: 'up_arm_R_020', lower: 'low_arm_R_021', hand: 'hand_R_022', fingers: 'fingers_R.001_027', thumb: 'thumb_R.001_030' };
    const shoulder = joint(names.upper);
    const elbow = joint(names.lower);
    const wrist = joint(names.hand);
    const fingers = joint(names.fingers);
    const thumb = joint(names.thumb);

    add(ellipsoid(shoulder, 0.072, [1, 1, 1], 10), names.upper, null, { camo: true });
    add(capsule(shoulder, elbow, 0.058), names.upper, null, { camo: true, blend: names.lower, from: shoulder, to: elbow });
    add(capsule(elbow, wrist, 0.049), names.lower, null, { camo: true, blend: names.hand, from: elbow, to: wrist });
    // Rolled cuff and a glove: a palm to the knuckles, and a thumb.
    add(cylinder(elbow.clone().lerp(wrist, 0.82), 0.052, 0.05, wrist.clone().sub(elbow)), names.lower, COLOUR.gear);
    add(capsule(wrist, fingers, 0.04, 8), names.hand, COLOUR.black);
    add(capsule(wrist, thumb, 0.019, 6), names.hand, COLOUR.black);
  }

  // ---- merge and bind ----------------------------------------------------
  // The geometry was built in model space; the skinned mesh stores its
  // vertices in its own bind space, which is model space seen through the
  // inverse of its bind matrix.
  const merged = mergeGeometries(parts, false);
  merged.applyMatrix4(body.bindMatrix.clone().invert());
  merged.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    map: camoTexture(),
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.05,
  });
  const kit = new THREE.SkinnedMesh(merged, material);
  kit.name = 'soldier_kit';
  kit.castShadow = true;
  kit.receiveShadow = true;
  kit.frustumCulled = false;
  body.parent.add(kit);
  kit.position.copy(body.position);
  kit.quaternion.copy(body.quaternion);
  kit.scale.copy(body.scale);
  kit.bind(skeleton, body.bindMatrix);

  // The old skin, and the knife and holster that came with it, go.
  const old = [];
  template.traverse((node) => {
    if ((node.isMesh || node.isSkinnedMesh) && node !== kit) old.push(node);
  });
  for (const node of old) node.parent.remove(node);
}
