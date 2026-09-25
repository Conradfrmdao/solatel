// How a soldier holds the rifle.
//
// Shared by the soldiers other players see (`remotes.js`) and the arms a
// player sees of themselves (`viewmodel.js`). Both pose the same model with
// the same clip and put the rifle in its hands with the same arithmetic, so
// what you see yourself holding is what everybody else sees you holding - by
// construction, not by two sets of numbers tuned to look alike.

import * as THREE from 'three';

/** Where the right palm closes on the rifle, in the rifle model's units:
 *  the pistol grip, a little behind the magazine. */
export const GRIP = new THREE.Vector3(0, -0.3, 0.62);

/** How far from wrist to knuckles the palm's centre is, as a fraction. The
 *  hand closes round the rifle there, not at the wrist bone. */
export const PALM = 0.7;

/** The bones the hands are read from, as three.js names them. */
export const HAND = {
  handR: 'mixamorigRightHand',
  palmR: 'mixamorigRightHandMiddle1',
  handL: 'mixamorigLeftHand',
  palmL: 'mixamorigLeftHandMiddle1',
};

const _knuckle = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _grip = new THREE.Vector3();

/** Where the palms are, in world space, into `right` and `left`. `bones`
 *  holds the bones of `HAND` under the same keys. */
export function palms(bones, right, left) {
  bones.handR.getWorldPosition(right);
  if (bones.palmR) right.lerp(bones.palmR.getWorldPosition(_knuckle), PALM);
  bones.handL.getWorldPosition(left);
  if (bones.palmL) left.lerp(bones.palmL.getWorldPosition(_knuckle), PALM);
}

/**
 * The rifle's matrix with its grip in the right palm, its muzzle along
 * `forward`, upright against `up`, drawn at `scale` metres per model unit.
 *
 * The model's muzzle is down its -Z, so +Z is back along `forward`.
 */
export function holdMatrix(right, forward, up, scale, out) {
  _z.copy(forward).negate().normalize();
  _y.copy(up).addScaledVector(_z, -up.dot(_z)).normalize();
  _x.crossVectors(_y, _z);
  out.makeBasis(_x, _y, _z);
  out.scale(_grip.setScalar(scale));
  _grip.copy(GRIP).applyMatrix4(out);
  return out.setPosition(_grip.subVectors(right, _grip));
}
