// The gun in your hands.
//
// # Why it has its own scene
//
// A weapon held a few centimetres from the eye shares a depth buffer with a
// wall a few centimetres in front of it, and the wall wins. Every first-person
// game solves this the same way: the viewmodel lives in its own scene with its
// own camera and is drawn afterwards over a cleared depth buffer. Nothing in
// the world can then clip through it, whatever the player backs into.
//
// # Why it moves
//
// The rest of this is feel, and feel is the product. A weapon that kicks when
// it fires and lags when you turn gives shooting a physicality a crosshair
// cannot. None of it is simulation - the server neither knows nor cares where
// this model is - so all of it can be tuned freely, and the numbers live in
// `weapons.js` rather than here.
//
// # How a frame's pose is built
//
// Layers, added together in this order:
//
//   hip <-> sights   the base pose, blended by how far into ADS the player is
//   sway             the weapon lagging a turn of the view, then settling
//   idle breath      standing still only
//   bob              moving on the ground, paced by distance covered
//   air and landing  a lift while airborne, a dip when coming down
//   recoil           kick back, up and sideways per shot, recovering
//
// Everything but the base pose is scaled down with the sights up, so aiming
// steadies the weapon. Every layer approaches its target with an exponential
// that takes `dt`, which is what keeps the feel the same at any frame rate.
//
// # What a shot leaves behind
//
// A flash, a spent case and a puff of smoke. The flash is part of the weapon
// and moves with it. The case and the smoke are not: once they have left the
// rifle they belong to the world, so they are kept in world coordinates and
// carried into this scene's space each frame - turn away and they are left
// hanging where they were, which is most of what makes them read as real.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { HAND, holdMatrix, palms } from './grip.js';
import { SIM, wrapAngle } from './sim.js';
import { RIFLE } from './weapons.js';

/** Frame-rate independent approach: the same curve at 30 fps as at 240. */
function damp(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Eases a 0..1 progress so a transition starts and lands gently. */
function smooth(t) {
  return t * t * (3 - 2 * t);
}

function clamp(value, limit) {
  return Math.max(-limit, Math.min(limit, value));
}

function between([low, high]) {
  return low + Math.random() * (high - low);
}

/** Cases and puffs that can be in the air at once. Past that the oldest is
 *  reused, which at this fire rate is one that has already landed. */
const CASING_POOL = 16;
const SMOKE_POOL = 12;

const GRAVITY = 9.81;

// Scratch objects, reused so a burst allocates nothing.
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _spin = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _basisFrom = new THREE.Matrix4();
const _basisTo = new THREE.Matrix4();
const _parentTurn = new THREE.Quaternion();
const _inverse = new THREE.Matrix4();
const _target = new THREE.Matrix4();
const _wrist = new THREE.Vector3();
const _grip = new THREE.Quaternion();
const _shoulder = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _reach = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _upper = new THREE.Vector3();
const _lower = new THREE.Vector3();
const _hinge = new THREE.Vector3();
const _armTurn = new THREE.Quaternion();
const _foreTurn = new THREE.Quaternion();
const _roll = new THREE.Quaternion();
const _scaleOut = new THREE.Vector3();

/**
 * A soft grey puff, drawn into a canvas once.
 *
 * A handful of overlapping soft discs rather than one, so it has a lumpy
 * edge; a single radial gradient reads as a lens smudge, not as smoke.
 */
function smokeTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  const middle = size / 2;
  for (let i = 0; i < 7; i += 1) {
    const angle = (i / 7) * Math.PI * 2;
    const reach = i === 0 ? 0 : middle * 0.3;
    const x = middle + Math.cos(angle) * reach;
    const y = middle + Math.sin(angle) * reach;
    const radius = middle * (i === 0 ? 0.75 : 0.5);
    const puff = context.createRadialGradient(x, y, 0, x, y, radius);
    puff.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
    puff.addColorStop(0.5, 'rgba(255, 255, 255, 0.25)');
    puff.addColorStop(1, 'rgba(255, 255, 255, 0)');
    context.fillStyle = puff;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * The muzzle flash, drawn into a canvas once.
 *
 * A hot white core, falling through yellow and orange to nothing well inside
 * the edge of the quad, with a handful of spikes out of it. The falloff is
 * the important part: with a flat colour the plane's own edges are what the
 * eye sees, and additive blending makes that a brighter square rather than a
 * softer one.
 *
 * Sixty-four pixels is plenty. It is on screen for two frames at a time and
 * it is a blur when it is.
 */
export function flashTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  const middle = size / 2;

  // The spikes first, so the core burns over the top of them.
  context.save();
  context.translate(middle, middle);
  context.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2 + 0.4;
    const reach = middle * (i % 2 === 0 ? 0.95 : 0.6);
    const spike = context.createLinearGradient(0, 0, Math.cos(angle) * reach,
      Math.sin(angle) * reach);
    spike.addColorStop(0, 'rgba(255, 236, 190, 0.85)');
    spike.addColorStop(1, 'rgba(255, 150, 40, 0)');
    context.fillStyle = spike;
    context.beginPath();
    context.moveTo(Math.cos(angle) * reach, Math.sin(angle) * reach);
    context.lineTo(Math.cos(angle + 0.22) * middle * 0.22,
      Math.sin(angle + 0.22) * middle * 0.22);
    context.lineTo(Math.cos(angle - 0.22) * middle * 0.22,
      Math.sin(angle - 0.22) * middle * 0.22);
    context.closePath();
    context.fill();
  }
  context.restore();

  const core = context.createRadialGradient(middle, middle, 0, middle, middle,
    middle * 0.92);
  core.addColorStop(0.0, 'rgba(255, 255, 250, 1)');
  core.addColorStop(0.18, 'rgba(255, 240, 190, 0.95)');
  core.addColorStop(0.42, 'rgba(255, 176, 70, 0.55)');
  core.addColorStop(0.72, 'rgba(226, 104, 24, 0.16)');
  core.addColorStop(1.0, 'rgba(180, 70, 10, 0)');
  context.globalCompositeOperation = 'lighter';
  context.fillStyle = core;
  context.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** The bones whose skin is kept for the arms: upper arm, forearm, hand and
 *  fingers, each side. Not the shoulder - that is the torso's. */
const ARM = /(Left|Right)(Arm|ForeArm|Hand)/;

/**
 * The same geometry, drawing only the arms, and moved by nothing else.
 *
 * A triangle is kept when all three of its corners are skinned mostly to an
 * arm bone. Each kept corner's weights are then given wholly to the arm
 * bones it was already weighted to: the torso is never drawn and is not
 * where the arms hang from in first person, and a corner still partly
 * weighted to it would be dragged back towards it - which is what turned the
 * straps at the top of each sleeve into hooks. Positions, normals and
 * texture coordinates are shared with the original; only the index and the
 * weights are new.
 */
function armsOnly(geometry, skeleton) {
  const arm = skeleton.bones.map((bone) => ARM.test(bone.name));
  const joints = geometry.getAttribute('skinIndex');
  const weights = geometry.getAttribute('skinWeight');
  const onArm = new Uint8Array(joints.count);
  const armWeights = new Float32Array(joints.count * 4);
  for (let v = 0; v < joints.count; v += 1) {
    let total = 0;
    for (let k = 0; k < 4; k += 1) {
      if (arm[joints.getComponent(v, k)]) total += weights.getComponent(v, k);
    }
    onArm[v] = total >= 0.5 ? 1 : 0;
    for (let k = 0; k < 4; k += 1) {
      const w = arm[joints.getComponent(v, k)] ? weights.getComponent(v, k) : 0;
      armWeights[v * 4 + k] = total > 0 ? w / total : weights.getComponent(v, k);
    }
  }
  const index = geometry.getIndex();
  const kept = [];
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    if (onArm[a] && onArm[b] && onArm[c]) kept.push(a, b, c);
  }
  const out = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    out.setAttribute(name, attribute);
  }
  out.setAttribute('skinWeight', new THREE.BufferAttribute(armWeights, 4));
  out.setIndex(kept);
  return out;
}

/** The rotation that carries one frame - a direction and a normal to it -
 *  onto another. Both pairs must be at right angles. */
function alignFrames(u0, n0, u1, n1, out) {
  _basisFrom.makeBasis(u0, n0, _w.crossVectors(u0, n0));
  _basisTo.makeBasis(u1, n1, _v.crossVectors(u1, n1));
  _basisTo.multiply(_basisFrom.transpose());
  return out.setFromRotationMatrix(_basisTo);
}

/** Sets a bone's rotation so its rotation in the world is `world`. */
function setWorldRotation(bone, world) {
  bone.parent.getWorldQuaternion(_parentTurn);
  bone.quaternion.copy(_parentTurn.invert().multiply(world));
  bone.updateMatrixWorld(true);
}

/** How much of the hand's roll the forearm takes, turning about its own
 *  length. A real forearm turns the wrist that way; a rig without one
 *  wrings the wrist into a twisted rope instead. */
const FOREARM_ROLL = 0.5;

/**
 * A tube red-dot sight, in the rifle model's own units.
 *
 * The housing is a lathed ring: open at both ends, thick-walled, with a
 * lip at each end so the rims read as rims. The glass is a faint blue-green
 * disc at the front, and the dot sits just behind it, unlit so it glows at
 * any exposure. A mount runs down from the tube to the carry handle.
 */
function redDot(optic) {
  const { height, front, rear, radius, bore, base, dotRadius } = optic;
  const group = new THREE.Group();
  group.name = 'red_dot';
  const housing = new THREE.MeshStandardMaterial({
    color: 0x1b1c1e,
    roughness: 0.45,
    metalness: 0.35,
  });

  // The tube, turned from a profile: out along the outside, back along the
  // bore. LatheGeometry spins about +Y, so it is laid along -Z afterwards.
  const length = rear - front;
  const lip = radius * 1.08;
  const profile = [
    new THREE.Vector2(bore, 0),
    new THREE.Vector2(lip, 0),
    new THREE.Vector2(lip, length * 0.08),
    new THREE.Vector2(radius, length * 0.12),
    new THREE.Vector2(radius, length * 0.88),
    new THREE.Vector2(lip, length * 0.92),
    new THREE.Vector2(lip, length),
    new THREE.Vector2(bore, length),
    new THREE.Vector2(bore, 0),
  ];
  const tube = new THREE.Mesh(new THREE.LatheGeometry(profile, 32), housing);
  tube.rotation.x = Math.PI / 2; // +Y onto +Z
  tube.position.set(0, height, front);
  group.add(tube);

  // Turrets on the top and the right, for elevation and windage.
  const turret = new THREE.CylinderGeometry(radius * 0.32, radius * 0.32, radius * 0.5, 16);
  const top = new THREE.Mesh(turret, housing);
  top.position.set(0, height + radius * 1.1, front + length * 0.5);
  group.add(top);
  const side = new THREE.Mesh(turret, housing);
  side.rotation.z = Math.PI / 2;
  side.position.set(-radius * 1.1, height, front + length * 0.5);
  group.add(side);

  // The mount, from the carry handle up to the tube.
  const mountHeight = height - radius * 0.8 - base;
  const mount = new THREE.Mesh(
    new THREE.BoxGeometry(radius * 1.2, mountHeight, length * 0.7),
    housing,
  );
  mount.position.set(0, base + mountHeight / 2, front + length * 0.5);
  group.add(mount);

  // Glass: just tinted, so the world is seen through it.
  const glass = new THREE.Mesh(
    new THREE.CircleGeometry(bore, 32),
    new THREE.MeshBasicMaterial({
      color: 0x7fb8c8,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  glass.position.set(0, height, front + length * 0.04);
  group.add(glass);

  // The dot, and a soft glow round it.
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(dotRadius, 20),
    new THREE.MeshBasicMaterial({ color: 0xff2a20, side: THREE.DoubleSide }),
  );
  dot.position.set(0, height, front + length * 0.05);
  group.add(dot);
  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(dotRadius * 1.9, 20),
    new THREE.MeshBasicMaterial({
      color: 0xff3a2a,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  halo.position.set(0, height, front + length * 0.051);
  group.add(halo);

  return group;
}

export class Viewmodel {
  constructor(config = RIFLE) {
    this.config = config;
    this.scene = new THREE.Scene();
    // Angle and aspect are set from the world camera's hip angle, so the
    // weapon sits in the same perspective as everything else. With the
    // sights up it narrows by its own factor, `ads.weaponZoom`: the sights
    // are on the view axis, so magnifying about the middle of the screen
    // enlarges them without moving them.
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    const [ox, oy, oz] = config.modelOffset;
    this.modelOffset = new THREE.Vector3(ox, oy, oz);
    this.hipPosition = new THREE.Vector3(...config.hip.position);
    this.hipRotation = new THREE.Vector3(...config.hip.rotation);
    this.adsRotation = new THREE.Vector3();
    this.adsPosition = new THREE.Vector3();
    this._solveSights();

    /** Whether the player is asking for the sights. */
    this.aiming = false;
    /** Linear progress hip (0) to sights (1), and its eased form. */
    this.aimProgress = 0;
    this.aim = 0;

    this.time = 0;
    this.previousYaw = null;
    this.previousPitch = null;
    this.sway = { x: 0, y: 0, pitch: 0, yaw: 0 };
    this.bobPhase = 0;
    this.bobWeight = 0;
    this.airLift = 0;
    this.landDip = 0;
    this.recoil = { back: 0, rise: 0, yaw: 0, roll: 0 };
    this.shotIndex = 0;
    this.lastShotAt = -Infinity;
    /** Roll for the world camera, from recoil. Around the view axis only, so
     *  the middle of the screen - where shots go - does not move. */
    this.cameraRoll = 0;

    this.flash = 0;
    /** Size of the current flash, picked when it was fired. */
    this.flashSize = 1;

    /** Where the eye is and which way it looks, in the world, as of the
     *  last frame - what cases and smoke are carried into this scene by. */
    this.eye = new THREE.Vector3();
    this.view = new THREE.Quaternion();
    this.eyeVelocity = new THREE.Vector3();
    this.hasEye = false;
    /** The floor under the player, last time they were standing on one. */
    this.floor = -Infinity;

    this._buildLighting();
    this._buildFlash();
    this._buildCasings();
    this._buildSmoke();
    this._apply(this.hipPosition, this.hipRotation);
  }

  /**
   * The pose that puts the sights on the middle of the screen.
   *
   * Derived rather than tuned. The sight line runs from the rear notch to the
   * top of the front post; the rig is pitched until that line is level, then
   * moved so the front post sits on the view axis and the rear sight is
   * `eyeRelief` in front of the eye. Both points are in the model's own
   * units and go through the same scale and offset the model is drawn with,
   * so changing either of those cannot knock the sights off centre.
   */
  _solveSights() {
    const { scale } = this.config;
    const { frontSight, rearSight, eyeRelief } = this.config.ads;
    const [frontY, frontZ] = frontSight;
    const [rearY, rearZ] = rearSight;
    // Nose-up by the angle the line falls from rear to front.
    const pitch = Math.atan2(rearY - frontY, rearZ - frontZ);
    this.adsRotation.set(pitch, 0, 0);

    const turn = new THREE.Euler(pitch, 0, 0, 'YXZ');
    const inRig = (y, z) =>
      new THREE.Vector3(0, y * scale, z * scale).add(this.modelOffset).applyEuler(turn);
    const front = inRig(frontY, frontZ);
    const rear = inRig(rearY, rearZ);
    this.adsPosition.set(-front.x, -front.y, -eyeRelief - rear.z);
  }

  _buildLighting() {
    // Its own scene means its own light. Keyed from the upper left so the
    // weapon's top and left faces catch it and it reads as a solid object
    // rather than a silhouette.
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-0.6, 1.0, 0.4);
    this.scene.add(key);
    // Enough fill that dark camouflage and black gloves still read as cloth
    // and leather rather than as holes in the picture.
    this.scene.add(new THREE.HemisphereLight(0xb4c8e6, 0x3a3228, 1.7));
  }

  _buildFlash() {
    const { scale, boreHeight, muzzleFace } = this.config;
    const muzzle = new THREE.Vector3(
      this.modelOffset.x,
      this.modelOffset.y + boreHeight * scale,
      this.modelOffset.z + muzzleFace * scale,
    );

    // A pair of crossed billboards rather than one, so the flash has some
    // shape from every angle the weapon swings through.
    //
    // The texture is the whole difference between fire and a white box. A
    // flat colour on a square plane is a square, and additive blending only
    // makes it a brighter square; what reads as a muzzle flash is a hot core
    // falling off to nothing well inside the quad's edge, with a few spikes
    // out of it. Drawn here rather than downloaded - it is a gradient.
    const material = new THREE.MeshBasicMaterial({
      map: flashTexture(),
      color: 0xfff0c0,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.flashGroup = new THREE.Group();
    this.flashGroup.position.copy(muzzle);
    for (const roll of [0, Math.PI / 2]) {
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), material);
      quad.rotation.z = roll;
      this.flashGroup.add(quad);
    }
    this.flashGroup.visible = false;
    this.root.add(this.flashGroup);

    const glow = new THREE.PointLight(0xffc766, 0, 3.5, 2);
    glow.position.copy(muzzle);
    this.root.add(glow);
    this.flashLight = glow;
  }

  _buildCasings() {
    const { casings, scale } = this.config;
    // Lying along x, which is how it leaves the port: sideways.
    const geometry = new THREE.CylinderGeometry(casings.radius, casings.radius, casings.length, 8);
    geometry.rotateZ(Math.PI / 2);
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a04c, metalness: 0.35, roughness: 0.32 });
    this.casings = [];
    this.nextCasing = 0;
    for (let i = 0; i < CASING_POOL; i += 1) {
      const mesh = new THREE.Mesh(geometry, brass);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.casings.push({
        mesh,
        age: Infinity,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        turn: new THREE.Quaternion(),
      });
    }
    const [px, py, pz] = casings.port;
    this.port = new THREE.Vector3(px, py, pz).multiplyScalar(scale).add(this.modelOffset);
  }

  _buildSmoke() {
    const map = smokeTexture();
    this.puffs = [];
    this.nextPuff = 0;
    for (let i = 0; i < SMOKE_POOL; i += 1) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map,
        color: 0xd2cec6,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      }));
      sprite.visible = false;
      sprite.frustumCulled = false;
      // After the weapon, so the rifle is seen through the smoke rather
      // than the smoke being cut off by the barrel.
      sprite.renderOrder = 2;
      this.scene.add(sprite);
      this.puffs.push({
        sprite,
        age: Infinity,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        opacity: 0,
        roll: 0,
      });
    }
  }

  /** A point in this scene's space, into the world. */
  _toWorld(point, out) {
    return out.copy(point).applyQuaternion(this.view).add(this.eye);
  }

  /** A spent case out of the port. */
  _eject() {
    if (!this.hasEye) return;
    const c = this.config.casings;
    const casing = this.casings[this.nextCasing];
    this.nextCasing = (this.nextCasing + 1) % this.casings.length;

    this.root.updateMatrix();
    this._toWorld(_v.copy(this.port).applyMatrix4(this.root.matrix), casing.position);
    // Out to the weapon's right and up, in the weapon's own frame, so it
    // leaves the port the same way whatever the weapon is doing - and with
    // the player's own velocity, which it had while it was in the rifle.
    casing.velocity.set(between(c.speed), between(c.lift), c.back)
      .applyQuaternion(this.root.quaternion)
      .applyQuaternion(this.view)
      .add(this.eyeVelocity);
    casing.turn.copy(this.view).multiply(this.root.quaternion);
    casing.spin.set(
      (Math.random() - 0.5) * 2 * c.spin,
      (Math.random() - 0.5) * 2 * c.spin,
      (Math.random() - 0.5) * 2 * c.spin,
    );
    casing.age = 0;
  }

  /** A puff at the muzzle. */
  _puff() {
    if (!this.hasEye) return;
    const s = this.config.smoke;
    const puff = this.puffs[this.nextPuff];
    this.nextPuff = (this.nextPuff + 1) % this.puffs.length;

    this.root.updateMatrix();
    this._toWorld(_v.copy(this.flashGroup.position).applyMatrix4(this.root.matrix), puff.position);
    // Down the barrel. Smoke is left in the air it was fired into, so it
    // takes only a little of the player's own movement with it.
    puff.velocity.set(0, 0, -s.drift)
      .applyQuaternion(this.root.quaternion)
      .applyQuaternion(this.view)
      .addScaledVector(this.eyeVelocity, 0.3);
    puff.opacity = s.opacity + (s.adsOpacity - s.opacity) * this.aim;
    puff.roll = Math.random() * Math.PI * 2;
    puff.age = 0;
  }

  /** Cases and smoke, moved on by `dt` and carried into this scene. */
  _updateDebris(dt) {
    _q.copy(this.view).invert();
    const c = this.config.casings;
    for (const casing of this.casings) {
      if (casing.age >= c.seconds) {
        casing.mesh.visible = false;
        continue;
      }
      casing.age += dt;
      casing.velocity.y -= GRAVITY * dt;
      casing.position.addScaledVector(casing.velocity, dt);
      if (casing.position.y < this.floor && casing.velocity.y < 0) {
        casing.position.y = this.floor;
        casing.velocity.multiplyScalar(c.bounce);
        casing.velocity.y = -casing.velocity.y;
        casing.spin.multiplyScalar(c.bounce);
      }
      _euler.set(casing.spin.x * dt, casing.spin.y * dt, casing.spin.z * dt);
      casing.turn.multiply(_spin.setFromEuler(_euler));
      casing.mesh.position.copy(casing.position).sub(this.eye).applyQuaternion(_q);
      casing.mesh.quaternion.copy(_q).multiply(casing.turn);
      casing.mesh.visible = true;
    }

    const s = this.config.smoke;
    for (const puff of this.puffs) {
      if (puff.age >= s.seconds) {
        puff.sprite.visible = false;
        continue;
      }
      puff.age += dt;
      const t = Math.min(1, puff.age / s.seconds);
      puff.velocity.multiplyScalar(Math.exp(-s.drag * dt));
      puff.position.addScaledVector(puff.velocity, dt);
      puff.position.y += s.rise * dt;
      // Spreads fast and then slows, the way a puff does; thins throughout.
      const spread = 1 - (1 - t) * (1 - t);
      puff.sprite.scale.setScalar(s.size[0] + (s.size[1] - s.size[0]) * spread);
      puff.sprite.material.opacity = puff.opacity * (1 - t) * (1 - t);
      puff.sprite.material.rotation = puff.roll + t * 0.6;
      puff.sprite.position.copy(puff.position).sub(this.eye).applyQuaternion(_q);
      puff.sprite.visible = true;
    }
  }

  async load(url) {
    const gltf = await new GLTFLoader().loadAsync(url);
    const rifle = gltf.scene;
    // The optic goes on the model itself, so every copy of the rifle -
    // everyone else's, in `remotes.js` - carries it too.
    if (this.config.optic) rifle.add(redDot(this.config.optic));
    rifle.position.copy(this.modelOffset);
    rifle.scale.setScalar(this.config.scale);
    this.root.add(rifle);
    this.rifle = rifle;
    return rifle;
  }

  /**
   * Arms and gloves, holding the rifle: the soldier everybody else sees,
   * cut down to the arms.
   *
   * `template` is the loaded soldier and `pose` the clip its upper body is
   * posed with to shoulder a rifle - the same clip, and the same model, the
   * other players' view of this one is drawn from. The pose supplies the
   * hands: how each one closes on the rifle, fingers and all, measured
   * against the rifle it would be holding (`holdMatrix`, as `remotes.js`
   * does). Where the arms come from does not come from the pose, because a
   * third-person body bolted to a first-person rifle puts its shoulders in
   * front of the camera and its sleeves up through the bottom of the screen.
   * Each arm instead hangs from a point just below the frame and is solved
   * every frame to reach its hand - `_poseArms` - which is how a shooter's
   * arms are drawn: forearms coming up into view onto the weapon, and
   * nothing of the shoulders ever seen.
   */
  setArms(template, pose) {
    const body = cloneSkinned(template);
    const bones = {};
    body.traverse((node) => {
      if (node.isBone) bones[node.name] = node;
    });
    const hands = {};
    for (const [key, name] of Object.entries(HAND)) hands[key] = bones[name];
    if (!hands.handR || !hands.handL || !this.rifle) return;

    const mixer = new THREE.AnimationMixer(body);
    mixer.clipAction(pose).play();
    mixer.update(0);
    body.updateMatrixWorld(true);

    // The rifle the posed soldier would be holding, in the soldier's space.
    const right = new THREE.Vector3();
    const left = new THREE.Vector3();
    palms(hands, right, left);
    const forward = left.clone().sub(right).normalize();
    const held = holdMatrix(right, forward, new THREE.Vector3(0, 1, 0),
      this.config.scale, new THREE.Matrix4());
    const unheld = held.clone().invert();

    const { arms } = this.config;
    this.arms = [];
    for (const [side, prefix] of [['right', 'Right'], ['left', 'Left']]) {
      const arm = bones[`mixamorig${prefix}Arm`];
      const fore = bones[`mixamorig${prefix}ForeArm`];
      const hand = bones[`mixamorig${prefix}Hand`];
      if (!arm || !fore || !hand) return;
      const a = arm.getWorldPosition(new THREE.Vector3());
      const b = fore.getWorldPosition(new THREE.Vector3());
      const c = hand.getWorldPosition(new THREE.Vector3());
      // The hand against the rifle: this is the grip, and it is kept.
      const grip = unheld.clone().multiply(hand.matrixWorld);
      if (side === 'left') {
        // Moved back along the rifle onto the handguard. The pose holds it
        // out by the front sight, which a first-person arm cannot reach
        // without the shoulder coming into view; how it holds is unchanged.
        const palm = left.clone().applyMatrix4(unheld);
        const [x, y, z] = arms.leftPalm;
        grip.premultiply(new THREE.Matrix4().makeTranslation(x - palm.x, y - palm.y, z - palm.z));
      }
      const upper = b.clone().sub(a);
      const lower = c.clone().sub(b);
      const hinge = upper.clone().cross(lower).normalize();
      this.arms.push({
        arm,
        fore,
        hand,
        grip,
        upperLength: upper.length(),
        lowerLength: lower.length(),
        upper: upper.normalize(),
        lower: lower.normalize(),
        hinge,
        armTurn: arm.getWorldQuaternion(new THREE.Quaternion()),
        foreTurn: fore.getWorldQuaternion(new THREE.Quaternion()),
        // Which way the forearm runs, in its own space: along the hand.
        foreAxis: hand.position.clone().normalize(),
        shoulder: new THREE.Vector3(...arms[side].shoulder),
        elbow: new THREE.Vector3(...arms[side].elbow).normalize(),
      });
    }

    body.traverse((node) => {
      if (!node.isSkinnedMesh) return;
      node.geometry = armsOnly(node.geometry, node.skeleton);
      // Posed away from where its bind-pose bounds say it is.
      node.frustumCulled = false;
      node.castShadow = false;
      node.receiveShadow = false;
    });
    // In the camera's space, not on the weapon: the arms hang from the
    // player, and it is the solve that carries the hands along with the
    // weapon's sway and kick.
    this.scene.add(body);
    this.body = body;
    this._poseArms();
  }

  /**
   * Both arms, onto the rifle where it is this frame.
   *
   * A two-bone solve from the shoulder to the wrist, with the elbow bent
   * towards `elbow`. The upper arm and forearm are turned as whole frames -
   * direction and the plane they bend in - from how the pose held them, so
   * the elbow hinges the way it did in the clip rather than whichever way
   * the shortest rotation happens to leave it. The hand is then set to how
   * the pose held the rifle, and half its roll is handed back to the
   * forearm.
   */
  _poseArms() {
    if (!this.arms || !this.rifle) return;
    this.root.updateMatrixWorld(true);
    const rifle = this.rifle.matrixWorld;
    for (const limb of this.arms) {
      _target.multiplyMatrices(rifle, limb.grip);
      _target.decompose(_wrist, _grip, _scaleOut);

      const reach = limb.upperLength + limb.lowerLength;
      _shoulder.copy(limb.shoulder);
      _reach.subVectors(_wrist, _shoulder);
      let distance = _reach.length();
      // Out of reach: the shoulder comes forward rather than the hand
      // leaving the rifle.
      if (distance > reach * 0.995) {
        _shoulder.addScaledVector(_reach, 1 - (reach * 0.995) / distance);
        _reach.subVectors(_wrist, _shoulder);
        distance = _reach.length();
      }
      _reach.divideScalar(distance);
      const l1 = limb.upperLength;
      const l2 = limb.lowerLength;
      const cos = Math.max(-1, Math.min(1, (l1 * l1 + distance * distance - l2 * l2) / (2 * l1 * distance)));
      const sin = Math.sqrt(1 - cos * cos);
      _bend.copy(limb.elbow).addScaledVector(_reach, -limb.elbow.dot(_reach)).normalize();
      _elbow.copy(_shoulder).addScaledVector(_reach, l1 * cos).addScaledVector(_bend, l1 * sin);

      _upper.subVectors(_elbow, _shoulder).normalize();
      _lower.subVectors(_wrist, _elbow).normalize();
      _hinge.crossVectors(_upper, _lower);
      if (_hinge.lengthSq() < 1e-8) _hinge.crossVectors(_upper, _bend);
      _hinge.normalize();

      alignFrames(limb.upper, limb.hinge, _upper, _hinge, _armTurn).multiply(limb.armTurn);
      alignFrames(limb.lower, limb.hinge, _lower, _hinge, _foreTurn).multiply(limb.foreTurn);
      // Half the hand's roll about the forearm goes to the forearm.
      _roll.copy(_foreTurn).invert().multiply(_grip);
      const along = _roll.x * limb.foreAxis.x + _roll.y * limb.foreAxis.y + _roll.z * limb.foreAxis.z;
      const twist = 2 * Math.atan2(along, _roll.w);
      _foreTurn.multiply(_roll.setFromAxisAngle(limb.foreAxis, twist * FOREARM_ROLL));

      const { arm, fore, hand } = limb;
      arm.parent.updateWorldMatrix(true, false);
      arm.position.copy(_shoulder).applyMatrix4(_inverse.copy(arm.parent.matrixWorld).invert());
      setWorldRotation(arm, _armTurn);
      setWorldRotation(fore, _foreTurn);
      setWorldRotation(hand, _grip);
    }
  }

  /** The player is holding the aim button, or has let go. */
  setAiming(on) {
    this.aiming = on;
  }

  /**
   * A shot left the weapon.
   *
   * Called the moment the client fires, not when the server echoes it: the
   * kick is this player's own hands and waits for nobody. Whether it hit is
   * still the server's answer, and arrives on its own.
   */
  onShotFired() {
    const { recoil } = this.config;
    if (this.time - this.lastShotAt > recoil.patternReset) this.shotIndex = 0;
    this.lastShotAt = this.time;
    const step = recoil.pattern[Math.min(this.shotIndex, recoil.pattern.length - 1)];
    this.shotIndex += 1;

    const scale = 1 - this.aim * (1 - this.config.ads.recoilScale);
    this.recoil.back += recoil.back * scale;
    this.recoil.rise = Math.min(recoil.maxRise, this.recoil.rise + recoil.rise * scale);
    this.recoil.yaw += recoil.sideways * step * scale;
    // Alternating roll reads as the weapon bucking rather than tipping over.
    const side = this.shotIndex % 2 === 0 ? 1 : -1;
    this.recoil.roll += recoil.roll * side * scale;
    this.cameraRoll += recoil.cameraRoll * side * scale;

    this.flash = this.config.flashSeconds;
    // A different size and roll each time. Three identical frames in a burst
    // read as a decal being switched on and off; a little variation reads as
    // combustion, which is what it is.
    this.flashGroup.rotation.z = Math.random() * Math.PI;
    this.flashSize = 0.82 + Math.random() * 0.36;

    this._eject();
    this._puff();
  }

  /** The player came down at `speed` metres per second. */
  onLanded(speed) {
    const { land } = this.config;
    this.landDip = Math.min(land.maxDip, this.landDip + speed * land.dipPerMetrePerSecond);
  }

  /**
   * Places the weapon for this frame.
   *
   * `yaw` and `pitch` are the camera's, and `eye` where it is in the world.
   * The weapon is positioned in the viewmodel camera's fixed space, so the
   * rig stays glued to the view without ever trailing it by a frame; sway is
   * an offset on top, not lag. The eye is only for what a shot leaves
   * behind, which lives in the world.
   */
  update(dt, yaw, pitch, speed, onGround, eye) {
    const c = this.config;
    this.time += dt;

    if (eye) {
      if (this.hasEye && dt > 0) {
        // Smoothed: the eye is itself smoothed over steps, and a case thrown
        // on the frame of a step should not be thrown up the stairs with it.
        _w.subVectors(eye, this.eye).divideScalar(dt);
        this.eyeVelocity.lerp(_w, 1 - Math.exp(-12 * dt));
      }
      this.eye.copy(eye);
      this.hasEye = true;
      if (onGround) this.floor = eye.y - SIM.eyeOffset - SIM.halfExtentY;
    }
    this.view.setFromEuler(_euler.set(pitch, yaw, 0, 'YXZ'));

    // Hip to sights at a fixed rate, eased, so the time it takes is the same
    // every time and a player can learn it.
    const step = dt / c.ads.duration;
    this.aimProgress = Math.max(0, Math.min(1,
      this.aimProgress + (this.aiming ? step : -step)));
    this.aim = smooth(this.aimProgress);
    const steady = (scale) => 1 - this.aim * (1 - scale);

    // Sway: the weapon lags a turn, then settles.
    const turnYaw = this.previousYaw === null ? 0 : wrapAngle(yaw - this.previousYaw);
    const turnPitch = this.previousPitch === null ? 0 : pitch - this.previousPitch;
    this.previousYaw = yaw;
    this.previousPitch = pitch;
    const sway = this.sway;
    sway.x = clamp(sway.x + turnYaw * c.sway.position, c.sway.maxPosition);
    sway.y = clamp(sway.y - turnPitch * c.sway.position, c.sway.maxPosition);
    sway.yaw = clamp(sway.yaw + turnYaw * c.sway.rotation, c.sway.maxRotation);
    sway.pitch = clamp(sway.pitch + turnPitch * c.sway.rotation, c.sway.maxRotation);
    for (const key of ['x', 'y', 'yaw', 'pitch']) {
      sway[key] = damp(sway[key], 0, c.sway.recovery, dt);
    }
    const swayScale = steady(c.ads.swayScale);

    // Bob, paced by distance so it quickens with speed.
    const moving = onGround && speed > 0.5;
    this.bobWeight = damp(this.bobWeight, moving ? Math.min(1, speed / 8) : 0, c.bob.fade, dt);
    this.bobPhase += speed * dt * c.bob.cyclesPerMetre * Math.PI * 2;
    const bob = c.bob.amount * this.bobWeight * steady(c.ads.bobScale);
    const bobX = Math.sin(this.bobPhase) * bob;
    const bobY = Math.sin(this.bobPhase * 2) * bob * 0.5 - bob * 0.3;
    const bobRoll = Math.sin(this.bobPhase) * c.bob.roll * this.bobWeight * steady(c.ads.bobScale);

    // Breath, fading out as the bob fades in.
    const breath = (1 - this.bobWeight) * steady(c.ads.swayScale);
    const t = this.time * c.idle.rate * Math.PI * 2;
    const breathX = Math.sin(t) * c.idle.position * breath;
    const breathY = Math.sin(t * 2) * c.idle.position * breath;
    const breathPitch = Math.sin(t) * c.idle.rotation * breath;

    this.airLift = damp(this.airLift, onGround ? 0 : c.air.lift, c.air.rate, dt);
    this.landDip = damp(this.landDip, 0, c.land.recovery, dt);

    const r = this.recoil;
    for (const key of ['back', 'rise', 'yaw', 'roll']) r[key] = damp(r[key], 0, c.recoil.recovery, dt);
    this.cameraRoll = damp(this.cameraRoll, 0, c.recoil.cameraRecovery, dt);

    const a = this.aim;
    const hip = this.hipPosition;
    const ads = this.adsPosition;
    this.root.position.set(
      hip.x + (ads.x - hip.x) * a + (sway.x * swayScale) + bobX + breathX,
      hip.y + (ads.y - hip.y) * a + (sway.y * swayScale) + bobY + breathY
        + (this.airLift - this.landDip) * steady(c.ads.bobScale),
      hip.z + (ads.z - hip.z) * a + r.back,
    );
    const hr = this.hipRotation;
    const ar = this.adsRotation;
    // The weapon tips a little with the view from the hip, so it does not
    // feel welded to the screen looking up and down; with the sights up it
    // must not, or they would leave the middle.
    this.root.rotation.set(
      hr.x + (ar.x - hr.x) * a + r.rise + sway.pitch * swayScale + breathPitch
        + pitch * 0.05 * (1 - a),
      hr.y + (ar.y - hr.y) * a + r.yaw + sway.yaw * swayScale,
      hr.z + (ar.z - hr.z) * a + r.roll + bobRoll,
      'YXZ',
    );

    const lit = this.flash > 0;
    this.flash = Math.max(0, this.flash - dt);
    this.flashGroup.visible = lit;
    if (lit) {
      // The roll and the size of *this* flash were chosen when the shot was
      // fired; all that happens here is that it shrinks as it dies.
      const fade = this.flash / c.flashSeconds;
      this.flashGroup.scale.setScalar(this.flashSize * (0.62 + fade * 0.5));
    }
    this.flashLight.intensity = lit ? 9 * (this.flash / c.flashSeconds) : 0;

    this._poseArms();
    this._updateDebris(dt);
  }

  /**
   * How much to narrow the world camera, as a factor on the tangent of its
   * half-angle: 1 at the hip, `ads.zoom` with the sights up.
   */
  get zoom() {
    return 1 - this.aim * (1 - this.config.ads.zoom);
  }

  /** The same for the weapon's own camera. */
  get weaponZoom() {
    return 1 - this.aim * (1 - this.config.ads.weaponZoom);
  }

  /** Crosshair opacity for this frame. */
  get crosshairOpacity() {
    return 1 - this.aim * (1 - this.config.ads.crosshairOpacity);
  }

  _apply(position, rotation) {
    this.root.position.copy(position);
    this.root.rotation.set(rotation.x, rotation.y, rotation.z, 'YXZ');
  }

  setView(aspect, verticalFov) {
    this.camera.aspect = aspect;
    this.camera.fov = verticalFov;
    this.camera.updateProjectionMatrix();
  }
}
