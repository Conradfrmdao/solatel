// Hands fitted to the gun in hand, so no finger goes through it.
//
// The hands in first person are posed by the soldier's shouldered clip, and
// that clip was made holding the rifle the game started with. Every real gun
// since has its own grip - the AK's raked and thick, the M700's a stock's
// wrist, the MP5's slim - and its own handguard, and the old pose put fingers
// into the new guns and hands through their grips. Conrad saw it.
//
// So each hand is fitted to the gun it holds, once per gun:
//
//   - turned to the hold that gun takes (`HOLDS` in viewmodel.js): the right
//     hand along the grip's own rake, the left palm up under the handguard,
//     wherever the clip had them;
//   - brought in from outside the gun, along the way the palm faces, until
//     the palm rests on its surface - never set down inside it, which is
//     where the grip's measured centre line put it;
//   - and every finger closed, from open, until it touches the gun: the
//     curl the clip gives it is kept as the shape - how much each joint bends
//     against the others - and only how far is changed.
//
// The tests are the gun's own triangles near the hand, in a grid, against
// points along the palm and the fingers a hand's thickness out: a hand is a
// few thousand cheap tests rather than a few million.

import * as THREE from 'three';

/** How far a finger's surface is from its bones, in metres: a gloved finger. */
export const FINGER_RADIUS = 0.0095;

/** How far the palm's surface is from the bones across it, in metres. */
export const PALM_DEPTH = 0.016;

/** The fingers, as Mixamo names their bones: four a finger, the last the tip. */
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

/** How far a finger may be closed, as a share of the clip's curl, and the
 *  steps it is closed in: coarse, then halved where it first touches. */
const MOST = 1.7;
const STEP = 0.1;
const REFINE = 3;

/** Where along each bone of a finger it is tested, as fractions. */
const ALONG = [0.5, 1];

/** How the palm's middle is found: this far from the wrist to the middle
 *  knuckle, as `grip.js` has it. */
const PALM = 0.7;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _p = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _turned = new THREE.Quaternion();
const _triangle = new THREE.Triangle();

/**
 * Each finger of the hand bone `hand` as a chain: its bones, and each joint's
 * rotation at rest (the open hand the model was made with). Call with the
 * skeleton at rest, then `notePosed` once the clip has posed it.
 */
export function fingerChains(hand, side) {
  const chains = [];
  for (const finger of FINGERS) {
    const bones = [1, 2, 3, 4].map((i) => hand.getObjectByName(`mixamorig${side}Hand${finger}${i}`));
    if (bones.some((bone) => !bone)) continue;
    chains.push({
      finger,
      bones,
      rest: bones.slice(0, 3).map((bone) => bone.quaternion.clone()),
      posed: null,
      // From rest to posed, joint by joint, as an axis and an angle.
      axes: null,
      angles: null,
    });
  }
  return chains;
}

/** Takes each chain's posed rotations off its bones, as the clip has left them. */
export function notePosed(chains) {
  for (const chain of chains) {
    chain.posed = chain.bones.slice(0, 3).map((bone) => bone.quaternion.clone());
    chain.axes = [];
    chain.angles = [];
    for (let k = 0; k < 3; k += 1) {
      _q.copy(chain.rest[k]).invert().multiply(chain.posed[k]);
      if (_q.w < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
      const angle = 2 * Math.acos(Math.min(1, _q.w));
      const s = Math.sqrt(Math.max(0, 1 - _q.w * _q.w));
      chain.axes.push(s > 1e-6 ? new THREE.Vector3(_q.x / s, _q.y / s, _q.z / s) : new THREE.Vector3(1, 0, 0));
      chain.angles.push(angle);
    }
  }
}

/** Joint `k` of `chain` curled `t` of the way the clip curls it: 0 open, 1
 *  as posed, more is closed further. Into `out`. */
function curl(chain, k, t, out) {
  return out.copy(chain.rest[k]).multiply(_turned.setFromAxisAngle(chain.axes[k], chain.angles[k] * t));
}

/** Where `chain`'s joints and tip are, curled `t`, from a hand at `hand`. */
function joints(chain, t, hand) {
  _m.copy(hand);
  const out = [];
  for (let k = 0; k < 3; k += 1) {
    const bone = chain.bones[k];
    _local.compose(bone.position, curl(chain, k, t, _q), bone.scale);
    _m.multiply(_local);
    out.push(new THREE.Vector3().setFromMatrixPosition(_m));
  }
  out.push(chain.bones[3].position.clone().applyMatrix4(_m));
  return out;
}

/**
 * A hand's own frame, read off its bones as the clip poses them, in the
 * hand bone's space: `along` from the wrist to the middle knuckle, `across`
 * from the little finger's knuckle to the index's, `palm` the way the palm
 * faces (the side the clip curls the fingers to), and the points across
 * the palm - the wrist, the knuckles and the palm's middle - that must not
 * go into the gun.
 */
export function handFrame(chains) {
  const knuckle = (finger) => chains.find((c) => c.finger === finger)?.bones[0].position;
  const middle = knuckle('Middle');
  const index = knuckle('Index');
  const pinky = knuckle('Pinky');
  if (!middle || !index || !pinky) return null;
  const along = middle.clone().normalize();
  const across = index.clone().sub(pinky);
  across.addScaledVector(along, -across.dot(along)).normalize();
  const normal = new THREE.Vector3().crossVectors(along, across);
  // The fingers as the clip curls them lie on the palm's side.
  const identity = new THREE.Matrix4();
  const tips = new THREE.Vector3();
  const roots = new THREE.Vector3();
  let n = 0;
  for (const chain of chains) {
    if (chain.finger === 'Thumb') continue;
    tips.add(joints(chain, 1, identity)[3]);
    roots.add(chain.bones[0].position);
    n += 1;
  }
  const side = tips.sub(roots).dot(normal) >= 0 ? 1 : -1;
  const centre = middle.clone().multiplyScalar(PALM);
  const points = [new THREE.Vector3(), centre.clone(), middle.clone(), index.clone(), pinky.clone(),
    knuckle('Ring')?.clone() ?? middle.clone(), centre.clone().multiplyScalar(0.5)];
  return { along, across, palm: normal.multiplyScalar(side), side, centre, points };
}

/**
 * The gun's triangles near `centre` (in `model`'s own frame), within
 * `reach`, in a grid of cells `cell` across, padded by `pad` - so every
 * triangle within `pad` of a point is in the point's own cell.
 */
export function surfaceNear(model, centre, reach, cell, pad) {
  model.updateMatrixWorld(true);
  const toModel = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const triangles = [];
  model.traverse((node) => {
    if (!node.isMesh || node.material?.transparent) return;
    for (let n = node; n && n !== model; n = n.parent) if (!n.visible) return;
    _m.multiplyMatrices(toModel, node.matrixWorld);
    const position = node.geometry.getAttribute('position');
    const index = node.geometry.getIndex();
    const count = index ? index.count : position.count;
    for (let i = 0; i + 2 < count; i += 3) {
      _a.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(_m);
      _b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(_m);
      _c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(_m);
      _triangle.set(_a, _b, _c);
      _triangle.closestPointToPoint(centre, _closest);
      if (_closest.distanceTo(centre) > reach) continue;
      triangles.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z);
    }
  });
  const cells = new Map();
  const key = (i, j, k) => `${i},${j},${k}`;
  for (let t = 0; t < triangles.length; t += 9) {
    let x0 = Infinity; let y0 = Infinity; let z0 = Infinity;
    let x1 = -Infinity; let y1 = -Infinity; let z1 = -Infinity;
    for (let v = 0; v < 9; v += 3) {
      x0 = Math.min(x0, triangles[t + v]); x1 = Math.max(x1, triangles[t + v]);
      y0 = Math.min(y0, triangles[t + v + 1]); y1 = Math.max(y1, triangles[t + v + 1]);
      z0 = Math.min(z0, triangles[t + v + 2]); z1 = Math.max(z1, triangles[t + v + 2]);
    }
    for (let i = Math.floor((x0 - pad) / cell); i <= Math.floor((x1 + pad) / cell); i += 1) {
      for (let j = Math.floor((y0 - pad) / cell); j <= Math.floor((y1 + pad) / cell); j += 1) {
        for (let k = Math.floor((z0 - pad) / cell); k <= Math.floor((z1 + pad) / cell); k += 1) {
          const at = key(i, j, k);
          if (!cells.has(at)) cells.set(at, []);
          cells.get(at).push(t);
        }
      }
    }
  }
  return { triangles: new Float32Array(triangles), cells, cell, key };
}

/** Whether `point` is within `radius` of the surface (`radius` no more
 *  than the grid's padding). */
function touches(surface, point, radius) {
  const { cell, key } = surface;
  const list = surface.cells.get(key(Math.floor(point.x / cell), Math.floor(point.y / cell), Math.floor(point.z / cell)));
  if (!list) return false;
  const tri = surface.triangles;
  for (const t of list) {
    _triangle.a.set(tri[t], tri[t + 1], tri[t + 2]);
    _triangle.b.set(tri[t + 3], tri[t + 4], tri[t + 5]);
    _triangle.c.set(tri[t + 6], tri[t + 7], tri[t + 8]);
    _triangle.closestPointToPoint(point, _closest);
    if (_closest.distanceToSquared(point) < radius * radius) return true;
  }
  return false;
}

/**
 * A hand at `start` (a matrix into the gun's frame) turned so that its palm
 * faces `palm` and its knuckles run, little finger to index, along `across`
 * - both unit vectors in the gun's frame - and then brought in along `palm`
 * from `from` (in the gun's units) outside its place until the palm would
 * touch the surface, `depth` short of it. `frame` is the hand's own
 * (`handFrame`). Returns the new matrix, or `start` itself turned if the
 * palm met nothing.
 */
export function placeHand(start, frame, palm, across, surface, depth, from) {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  start.decompose(position, quaternion, scale);
  palm = palm.clone().normalize();
  across = across.clone().addScaledVector(palm, -across.dot(palm)).normalize();
  // The hand's own axes, onto the ones wanted.
  const handBasis = new THREE.Matrix4().makeBasis(frame.along, frame.across, frame.palm.clone().multiplyScalar(frame.side));
  const along = new THREE.Vector3().crossVectors(across, palm.clone().multiplyScalar(frame.side));
  const gunBasis = new THREE.Matrix4().makeBasis(along, across, palm.clone().multiplyScalar(frame.side));
  quaternion.setFromRotationMatrix(gunBasis.multiply(handBasis.transpose()));
  const placed = new THREE.Matrix4().compose(position, quaternion, scale);
  // Where the palm's middle was is where it is wanted; then out along the
  // palm's facing, and in again until it lands.
  const centre = frame.centre.clone().applyMatrix4(start);
  const turnedCentre = frame.centre.clone().applyMatrix4(placed);
  placed.setPosition(position.add(centre.sub(turnedCentre)));
  const at = new THREE.Vector3();
  const origin = new THREE.Vector3().setFromMatrixPosition(placed);
  const out = placed.clone();
  // Whether the palm touches with the hand moved `d` along its facing.
  const hits = (d) => {
    out.setPosition(at.copy(origin).addScaledVector(palm, d));
    return frame.points.some((p) => touches(surface, at.copy(p).applyMatrix4(out), depth));
  };
  // In coarse steps from outside, then halving the step where it first
  // touches.
  const step = from / 10;
  for (let d = -from; d <= from + 1e-9; d += step) {
    if (!hits(d)) continue;
    let free = d - step;
    let touching = d;
    for (let i = 0; i < 4; i += 1) {
      const mid = (free + touching) / 2;
      if (hits(mid)) touching = mid;
      else free = mid;
    }
    out.setPosition(at.copy(origin).addScaledVector(palm, free));
    return out;
  }
  return placed;
}

/** Whether `chain`, curled `t` from a hand at `hand`, touches the surface
 *  anywhere past its knuckle. */
function fingerTouches(chain, t, hand, surface, radius) {
  const points = joints(chain, t, hand);
  for (let k = 0; k < 3; k += 1) {
    for (const f of ALONG) {
      _p.lerpVectors(points[k], points[k + 1], f);
      if (touches(surface, _p, radius)) return true;
    }
  }
  return false;
}

/**
 * How far to curl each of `chains` - fingers of a hand at `hand`, a matrix
 * into the gun's frame - so that it rests on the surface: closed from open
 * until it would touch, as a hand closes on what it holds. Each as `{ curl,
 * touched }`: a finger that meets nothing, closed as far as a finger goes,
 * keeps the clip's curl; one already touching when open stays open.
 * `radius` is a finger's thickness in the gun's units.
 */
export function closeOn(chains, hand, surface, radius) {
  return chains.map((chain) => {
    if (fingerTouches(chain, 0, hand, surface, radius)) return { finger: chain.finger, curl: 0, touched: true };
    for (let t = STEP; t <= MOST + 1e-6; t += STEP) {
      if (!fingerTouches(chain, t, hand, surface, radius)) continue;
      let free = t - STEP;
      let touching = t;
      for (let i = 0; i < REFINE; i += 1) {
        const mid = (free + touching) / 2;
        if (fingerTouches(chain, mid, hand, surface, radius)) touching = mid;
        else free = mid;
      }
      return { finger: chain.finger, curl: free, touched: true };
    }
    return { finger: chain.finger, curl: 1, touched: false };
  });
}

/**
 * How well `closed` (from `closeOn`) holds a grip: the three fingers that
 * hold it - middle, ring, little - each closed onto it, round it rather than
 * stopped short, and the index on something too, the trigger or the guard.
 */
export function gripScore(closed) {
  let score = 0;
  for (const { finger, curl, touched } of closed) {
    if (!touched) continue;
    if (finger === 'Middle' || finger === 'Ring' || finger === 'Pinky') score += 1 + Math.min(curl, 1.2) * 0.5;
    if (finger === 'Index') score += 0.5;
  }
  return score;
}

/** Puts each of `chains` at its curl in `curls`. */
export function applyCurls(chains, curls) {
  chains.forEach((chain, i) => {
    for (let k = 0; k < 3; k += 1) curl(chain, k, curls[i], chain.bones[k].quaternion);
  });
}
