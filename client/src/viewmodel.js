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
//   strafe lag       going sideways, the gun lagging out and canting
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
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { BOLT_IN_RELOAD, BOLT_WORK } from './audio.js';
import { FINGER_RADIUS, PALM_DEPTH, applyCurls, closeOn, fingerChains, gripScore, handFrame, notePosed, placeHand, surfaceNear } from './fingers.js';
import { UNIT, buildGun } from './guns.js';
import { HAND, holdMatrix, palms } from './grip.js';
import { OPTICS, SIM, wrapAngle } from './sim.js';
import { RIFLE, feelFor } from './weapons.js';
import { CLOTH_MATERIAL, dressed } from './skins.js';

/** The first-person rifle's own key and fill, in full light (`setLight`). */
const KEY_LIGHT = 2.4;
const FILL_LIGHT = 1.7;
/** How much of the sky the gun reflects, against the world's own share:
 *  the guns are photographed metal and wood, and without it their steel
 *  is black. */
const ENVIRONMENT_LIGHT = 0.8;

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
const _hang = new THREE.Vector3();
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

/** How far a wrist bends, in radians, turning the forearm from in line with
 *  the hand towards where the elbow hangs (`_poseArms`): what a hand holding
 *  a gun bends easily, and not the right angle a forearm solved from the
 *  shoulder alone came to. */
const WRIST_BEND = 0.5;

/** How far it bends with the sights up, where the wrists are behind the gun
 *  and the forearms are what is seen: they fall away under it out of the
 *  picture, rather than coming back along it at the eye - which, true as it
 *  is of a pistol held out, filled the bottom of the picture with sleeves. */
const WRIST_BEND_AIMED = 1.25;

/** How far it may bend, and in what steps, when less would leave the elbow
 *  in the picture: a pistol held out at the eye has its forearms coming back
 *  past the face otherwise. */
const WRIST_MOST = 1.35;
const WRIST_STEP = 0.1;

/** How far outside the picture an elbow has to be, in metres: the sleeve's
 *  reach round it, so the sleeve is out of the picture too. */
const SLEEVE = 0.07;

/** How long the rifle is out of the way for a throw. */
const THROW_SECONDS = 0.65;

/** Metres a second at which the bob, and the lag of a gun carried sideways,
 *  are at their fullest: a run. */
const FULL_SPEED = 8;

/** Of a change of gun, how much is spent taking the old one down: the rest
 *  brings the new one up. */
const PUT_AWAY = 0.4;

/** How far down, tipped and rolled out a gun goes, out of sight, while guns
 *  change: down past the bottom of the picture, muzzle first, turning over
 *  to the right as a hand takes it down. */
const LOWERED = { drop: 0.34, tip: 0.85, roll: 0.45 };

/** Seconds a trigger stays pulled for a shot, and takes to come back. */
const TRIGGER_PULL = 0.05;

/** How far from the palm a hand can reach, in metres: what of the gun a
 *  finger could touch (`_fitHands`). */
const HAND_REACH = 0.2;

/** How far out a hand starts, in metres, to be brought in onto the gun. */
const HAND_APPROACH = 0.06;

/**
 * A right hand on a pistol grip raked back by `rake` degrees: the palm
 * against its right side, the knuckles running up the grip.
 */
function onGrip(rake) {
  const r = (rake * Math.PI) / 180;
  return {
    palm: new THREE.Vector3(-1, 0, -0.15),
    across: new THREE.Vector3(0, Math.cos(r), -Math.sin(r)),
    // Metres down the grip (up, negative) to try the hand at.
    slide: [-0.01, -0.005, 0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.035],
  };
}

/**
 * A left hand cupped under a handguard: the fingers reaching forward and up
 * round its far side, the palm up against its underside, and so the forearm
 * coming up to it from below and behind, in line with the hand - as a
 * shooter holds one. With the fingers straight across the gun instead, a
 * straight wrist sent the forearm out sideways to the left, its elbow in
 * the bottom of the picture; bent to come from below, the wrist folded over
 * at a right angle.
 */
function cupped(fingers, up) {
  const reach = fingers.clone().normalize();
  const palm = up.clone().addScaledVector(reach, -up.dot(reach)).normalize();
  // A left hand's knuckles, little finger to index, run palm × fingers.
  return { palm, across: new THREE.Vector3().crossVectors(palm, reach) };
}
const UNDER = cupped(new THREE.Vector3(0.45, 0.45, -0.77), new THREE.Vector3(0.3, 1, 0));

/**
 * How each gun is held, in its own frame (+X its right, +Y up, the muzzle
 * down -Z): which way each palm faces and which way its knuckles run, from
 * the little finger to the index (`fingers.placeHand`). The right hand
 * along each grip's own rake - the M700's is the wrist of a sporting
 * stock, nearly level; the left palm up under the handguard. The pistol's
 * left hand cups the right and is not fitted to the gun.
 */
const HOLDS = {
  rifle: { right: onGrip(20), left: UNDER },
  lmg: { right: onGrip(20), left: UNDER },
  smg: { right: onGrip(14), left: UNDER },
  sniper: { right: onGrip(52), left: UNDER },
  pistol: { right: onGrip(20), left: null },
};

/** How far out on the gun's right the hand goes to work the action, in
 *  metres from the part's own pivot. */
const HANDLE_REACH = 0.03;

const _turn = new THREE.Quaternion();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _shift = new THREE.Vector3();
const _hand = new THREE.Vector3();
const _support = new THREE.Vector3();
const _shiftMatrix = new THREE.Matrix4();
const _slide = new THREE.Matrix4();

/** Every moving part of a gun back where it rests. */
function restParts(model) {
  for (const part of Object.values(model.userData.parts ?? {})) {
    part.node.position.copy(part.position);
    part.node.quaternion.copy(part.quaternion);
    part.node.visible = true;
  }
}

export class Viewmodel {
  constructor() {
    const rifle = RIFLE.ads;
    const config = feelFor('rifle', 'red_dot', { front: rifle.frontSight, rear: rifle.rearSight }, 1.25);
    this.config = config;
    /** Every gun this player has been handed, built once each: `{ weapon,
     *  optic, config, model }` by `weapon:optic`. */
    this.rigs = new Map();
    /** A change of gun under way: from where, to which, and how long. */
    this.switching = null;
    /** Cases still to come out of a bolt action: when, from this scene. */
    this.ejections = [];
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
    /** How fast the player is going sideways, -1 to 1 of a run, eased. */
    this.strafe = 0;
    this.airLift = 0;
    this.landDip = 0;
    this.recoil = { back: 0, rise: 0, yaw: 0, roll: 0 };
    this.shotIndex = 0;
    this.lastShotAt = -Infinity;
    /** When the action last cycled: the shot the moving parts answer to. */
    this.cycleAt = -Infinity;
    /** How far the left hand is moved off the gun's support this frame, in
     *  model units: onto the magazine for a reload, onto the handle to work
     *  the action. */
    this.leftShift = new THREE.Vector3();
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
    const key = new THREE.DirectionalLight(0xffffff, KEY_LIGHT);
    key.position.set(-0.6, 1.0, 0.4);
    this.scene.add(key);
    // Enough fill that dark camouflage and black gloves still read as cloth
    // and leather rather than as holes in the picture.
    const fill = new THREE.HemisphereLight(0xb4c8e6, 0x3a3228, FILL_LIGHT);
    this.scene.add(fill);
    this.lights = { key, fill, sky: 1, sun: 1 };
  }

  /**
   * The world's light where the player stands (`lightHere` in `light.js`),
   * so the rifle in their hands is in the shade they are in: the key dims
   * out of the sun, the fill under a roof. Never to nothing - it is the
   * player's own weapon and has to read - and eased, so walking through a
   * doorway is a change of light rather than a switch.
   */
  setLight(dt, sky, sun) {
    const lights = this.lights;
    const ease = 1 - Math.exp(-dt / 0.25);
    lights.sky += (Math.min(Math.max(sky, 0.35), 1.15) - lights.sky) * ease;
    lights.sun += (sun - lights.sun) * ease;
    lights.key.intensity = KEY_LIGHT * (0.45 + 0.55 * lights.sun) * Math.min(1, 0.4 + 0.6 * lights.sky);
    lights.fill.intensity = FILL_LIGHT * lights.sky;
    this.scene.environmentIntensity = (this.environmentBase ?? 1) * ENVIRONMENT_LIGHT * lights.sky;
  }

  /**
   * The sky's light, for the gun's metal to catch: the map's own
   * environment, dimmed with the shade the player is in (`setLight`).
   */
  setEnvironment(environment, intensity = 1) {
    this.scene.environment = environment ?? null;
    this.environmentBase = intensity;
    this.scene.environmentIntensity = intensity * ENVIRONMENT_LIGHT * this.lights.sky;
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
    // Lying along x, which is how it leaves the port: sideways. Kept, so a
    // change of gun can reshape it to the new gun's cases.
    const geometry = new THREE.CylinderGeometry(casings.radius, casings.radius, casings.length, 8);
    geometry.rotateZ(Math.PI / 2);
    this.casingGeometry = geometry;
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

  /** The rifle and its red dot, built in code (`guns.js`): nobody else's
   *  model ships. In hand until a match hands the player something else. */
  async load() {
    this._useRig(this._rig('rifle', 'red_dot'));
    return this.rifle;
  }

  /** `weapon` with `optic`, built the first time it is asked for. */
  _rig(weapon, optic) {
    const key = `${weapon}:${optic}`;
    let rig = this.rigs.get(key);
    if (rig) return rig;
    const model = buildGun(weapon, optic);
    const config = feelFor(weapon, optic, model.userData.sight, OPTICS[optic] ?? 1.25, model.userData.points);
    model.position.set(...config.modelOffset);
    model.scale.setScalar(config.scale);
    model.visible = false;
    this.root.add(model);
    rig = { weapon, optic, config, model, slot: weapon === 'pistol' ? 'sidearm' : 'primary' };
    this.rigs.set(key, rig);
    return rig;
  }

  /** The guns a match hands this player, the primary in hand. */
  setLoadout(loadout) {
    this.loadout = { primary: loadout?.primary ?? 'rifle', optic: loadout?.optic ?? 'red_dot' };
    this.switching = null;
    this.ejections.length = 0;
    const sidearm = this._rig('pistol', 'irons');
    this._useRig(this._rig(this.loadout.primary, this.loadout.optic));
    // The pistol's hands now too, not at the first change to it mid-fight.
    this._fit(sidearm);
  }

  /** The rig for a slot of the current loadout. */
  _rigFor(slot) {
    const loadout = this.loadout ?? { primary: 'rifle', optic: 'red_dot' };
    return slot === 'sidearm' ? this._rig('pistol', 'irons') : this._rig(loadout.primary, loadout.optic);
  }

  /** Which gun is in hand, as the player has it. A change starts the old
   *  one going down and the new one coming up, over `seconds` - the drawn
   *  gun's own time, the same the server makes the player wait to fire. */
  setHeld(slot, seconds) {
    const to = this._rigFor(slot);
    const current = this.switching ? this.switching.to : this.rig;
    if (to === current) return;
    this.switching = { from: this.rig, to, at: this.time, seconds: Math.max(0.1, seconds) };
  }

  /** Puts `rig` in hand: its model shown, the others hidden, and everything
   *  that depends on the gun - the sights, the muzzle, the port, the cases,
   *  where the hands close - moved to it. */
  _useRig(rig) {
    if (this.rig && this.rig !== rig) restParts(this.rig.model);
    this.rig = rig;
    this.config = rig.config;
    for (const other of this.rigs.values()) other.model.visible = other === rig;
    this.rifle = rig.model;
    const c = rig.config;
    this.modelOffset.set(...c.modelOffset);
    this.hipPosition.set(...c.hip.position);
    this.hipRotation.set(...c.hip.rotation);
    this._solveSights();
    const muzzle = new THREE.Vector3(
      this.modelOffset.x,
      this.modelOffset.y + c.boreHeight * c.scale,
      this.modelOffset.z + c.muzzleFace * c.scale,
    );
    if (this.flashGroup) this.flashGroup.position.copy(muzzle);
    if (this.flashLight) this.flashLight.position.copy(muzzle);
    if (this.port) {
      const [px, py, pz] = c.casings.port;
      this.port.set(px, py, pz).multiplyScalar(c.scale).add(this.modelOffset);
    }
    if (this.casingGeometry) {
      const g = new THREE.CylinderGeometry(c.casings.radius, c.casings.radius, c.casings.length, 8);
      g.rotateZ(Math.PI / 2);
      this.casingGeometry.copy(g);
      g.dispose();
    }
    this._retargetArms();
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
  /** The sleeves in skin `skin` (`skins.js`): the player's own arms are
   *  dressed as everybody else sees the rest of them - and lit as the gun
   *  in their hands is, not by the map's baked light (`dressed`). */
  setSkin(skin) {
    this.skin = skin;
    this.body?.traverse((node) => {
      if (!node.isSkinnedMesh) return;
      node.userData.plain ??= node.material;
      const plain = node.userData.plain;
      node.material = dressed(plain, skin, { unit: 1, cloth: plain.name === CLOTH_MATERIAL, baked: false });
    });
  }

  setArms(template, pose) {
    const body = cloneSkinned(template);
    const bones = {};
    body.traverse((node) => {
      if (node.isBone) bones[node.name] = node;
    });
    const hands = {};
    for (const [key, name] of Object.entries(HAND)) hands[key] = bones[name];
    if (!hands.handR || !hands.handL || !this.rifle) return;
    // Each finger open, as the model was made, before the clip curls it.
    const fingers = { right: fingerChains(hands.handR, 'Right'), left: fingerChains(hands.handL, 'Left') };
    // And each wrist straight: which way the forearm leaves the hand, in the
    // hand's own frame, as the model was made - in line with it.
    body.updateMatrixWorld(true);
    const straight = {};
    for (const [side, prefix] of [['right', 'Right'], ['left', 'Left']]) {
      const fore = bones[`mixamorig${prefix}ForeArm`];
      const hand = bones[`mixamorig${prefix}Hand`];
      if (!fore || !hand) return;
      straight[side] = fore.getWorldPosition(new THREE.Vector3())
        .sub(hand.getWorldPosition(new THREE.Vector3()))
        .normalize()
        .applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()).invert());
    }

    const mixer = new THREE.AnimationMixer(body);
    mixer.clipAction(pose).play();
    mixer.update(0);
    body.updateMatrixWorld(true);
    notePosed(fingers.right);
    notePosed(fingers.left);
    const frames = { right: handFrame(fingers.right), left: handFrame(fingers.left) };

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
      // The hand against the rifle: this is the grip, and it is kept. The
      // left one is moved, gun by gun, onto where that gun is held
      // (`_retargetArms`); how it holds is the pose's.
      const base = unheld.clone().multiply(hand.matrixWorld);
      const palm = side === 'left' ? left.clone().applyMatrix4(unheld) : null;
      const grip = base.clone();
      const upper = b.clone().sub(a);
      const lower = c.clone().sub(b);
      const hinge = upper.clone().cross(lower).normalize();
      this.arms.push({
        side,
        arm,
        fore,
        hand,
        grip,
        base,
        palm,
        upperLength: upper.length(),
        lowerLength: lower.length(),
        upper: upper.normalize(),
        lower: lower.normalize(),
        hinge,
        armTurn: arm.getWorldQuaternion(new THREE.Quaternion()),
        foreTurn: fore.getWorldQuaternion(new THREE.Quaternion()),
        // Which way the forearm runs, in its own space: along the hand.
        foreAxis: hand.position.clone().normalize(),
        straight: straight[side],
        shoulder: new THREE.Vector3(...arms[side].shoulder),
        elbow: new THREE.Vector3(...arms[side].elbow),
        elbowAimed: new THREE.Vector3(...(arms[side].elbowAimed ?? arms[side].elbow)),
        fingers: fingers[side],
        frame: frames[side],
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
    this.setSkin(this.skin ?? 0);
    this._retargetArms();
    this._poseArms();
  }

  /**
   * The arms onto the gun in hand. The right hand is where it is on every
   * gun, because every gun's grip is where the rifle's is. The left is moved
   * from where the pose held the rifle onto this gun's support - under its
   * handguard, or for the pistol, under the right hand - and each arm hangs
   * from this gun's shoulders.
   */
  _retargetArms() {
    if (!this.arms) return;
    const { arms } = this.config;
    for (const limb of this.arms) {
      this._clipGrip(limb, this.config, limb.grip);
      limb.shoulder.set(...arms[limb.side].shoulder);
      limb.elbow.set(...arms[limb.side].elbow);
      limb.elbowAimed.set(...(arms[limb.side].elbowAimed ?? arms[limb.side].elbow));
    }
    this._fitHands();
  }

  /** Where the clip's hand goes on a gun with `config`, into `out`: the
   *  right on the grip, which is where every gun's is; the left moved onto
   *  that gun's support. */
  _clipGrip(limb, config, out) {
    out.copy(limb.base);
    if (limb.palm) {
      const [x, y, z] = config.arms.leftPalm;
      out.premultiply(new THREE.Matrix4().makeTranslation(x - limb.palm.x, y - limb.palm.y, z - limb.palm.z));
    }
    return out;
  }

  /**
   * Both hands fitted to the gun in hand (`fingers.js`): turned to its hold
   * (`HOLDS`), brought in until the palm rests on it, and every finger
   * closed until it touches. Once per gun, kept on its rig. A hand the hold
   * leaves out - the pistol's left, cupping the right - keeps the clip's
   * hand where the gun's `support` puts it.
   */
  _fitHands() {
    const rig = this.rig;
    if (!rig || !this.arms) return;
    this._fit(rig);
    for (const limb of this.arms) {
      const fit = rig.fitted[limb.side];
      if (fit) limb.grip.copy(fit.grip);
      if (limb.fingers?.length) applyCurls(limb.fingers, fit?.curls ?? limb.fingers.map(() => 1));
    }
  }

  /** `rig`'s hands, worked out if they have not been (`_fitHands`): a
   *  tenth of a second or so of arithmetic, done for a match's guns when
   *  the match hands them over rather than at the first change of gun. */
  _fit(rig) {
    if (rig.fitted || !this.arms) return;
    rig.fitted = {};
    const scale = rig.config.scale;
    const hold = HOLDS[rig.weapon] ?? HOLDS.rifle;
    for (const limb of this.arms) {
      if (!limb.fingers?.length || !limb.frame) continue;
      const want = hold[limb.side];
      if (!want) continue;
      const clip = this._clipGrip(limb, rig.config, new THREE.Matrix4());
      const centre = limb.frame.centre.clone().applyMatrix4(clip);
      const surface = surfaceNear(rig.model, centre, HAND_REACH / scale, (2 * PALM_DEPTH) / scale, PALM_DEPTH / scale);
      // Up and down the grip, for where the fingers close round it best: a
      // hand set where the grip's centre was measured can have its fingers
      // stopped on the trigger guard rather than round the grip.
      const along = want.across.clone().normalize();
      let best = null;
      for (const slide of want.slide ?? [0]) {
        const start = clip.clone().premultiply(_slide.makeTranslation(along.clone().multiplyScalar(-slide / scale)));
        const grip = placeHand(start, limb.frame, want.palm, want.across, surface, PALM_DEPTH / scale, HAND_APPROACH / scale);
        const closed = closeOn(limb.fingers, grip, surface, FINGER_RADIUS / scale);
        const score = gripScore(closed) - Math.abs(slide) * 4;
        if (!best || score > best.score) best = { grip, curls: closed.map((f) => f.curl), score };
      }
      rig.fitted[limb.side] = best;
    }
  }

  /**
   * Both arms, onto the rifle where it is this frame.
   *
   * Worked out from the hand back, not from the shoulder forward. The
   * forearm leaves the wrist in line with the hand - a wrist at rest - and
   * is turned towards where the elbow hangs by `WRIST_BEND`, or as much
   * further as keeps the elbow and its sleeve out of the picture; the elbow
   * is a forearm's length along it, and the upper arm runs from there
   * towards the shoulder at its own length, the shoulder going wherever
   * that puts it, out of sight. Solved the other way, from a shoulder below
   * the screen to a hand in front of the eye, every elbow came out under its
   * hand and every wrist bent at a right angle: forearms standing up out of
   * the bottom of the screen with the hands folded over the top of them,
   * which Conrad saw as arms bending. The upper arm and forearm are turned
   * as whole frames - direction and the plane they bend in - from how the
   * pose held them, so the elbow hinges the way it did in the clip rather
   * than whichever way the shortest rotation happens to leave it. The hand
   * is then set to how it holds the gun, and half its roll is handed back to
   * the forearm.
   */
  _poseArms() {
    if (!this.arms || !this.rifle) return;
    this.root.updateMatrixWorld(true);
    const rifle = this.rifle.matrixWorld;
    // The picture's edges, as slopes from the eye, for keeping elbows out:
    // a point is seen if it is less than a sleeve's reach outside every one
    // of them, measured square to each.
    const tall = Math.tan((this.camera.fov * Math.PI) / 360);
    const wide = tall * this.camera.aspect;
    const across = 1 / Math.sqrt(1 + wide * wide);
    const up = 1 / Math.sqrt(1 + tall * tall);
    const seen = (p) => Math.min(
      (-p.z * wide - Math.abs(p.x)) * across,
      (-p.z * tall - Math.abs(p.y)) * up,
      -p.z,
    ) > -SLEEVE;
    for (const limb of this.arms) {
      if (limb.side === 'left' && this.leftShift.lengthSq() > 0) {
        const { x, y, z } = this.leftShift;
        _target.multiplyMatrices(rifle, _shiftMatrix.makeTranslation(x, y, z).multiply(limb.grip));
      } else {
        _target.multiplyMatrices(rifle, limb.grip);
      }
      _target.decompose(_wrist, _grip, _scaleOut);

      // From the wrist to the elbow: in line with the hand, turned towards
      // where the elbow hangs by `WRIST_BEND` - and on towards it, a step at
      // a time up to `WRIST_MOST`, while the elbow would still be in the
      // picture, or above the hand: elbows hang below the hands that hold a
      // gun, and the M700's steeply raked grip, held with a straight wrist,
      // put that elbow up by the ear with its sleeve down the edge of the
      // picture.
      _upper.copy(limb.straight).applyQuaternion(_grip);
      _hang.lerpVectors(limb.elbow, limb.elbowAimed, this.aim);
      _reach.subVectors(_hang, _wrist).normalize();
      const off = _upper.angleTo(_reach);
      _bend.crossVectors(_upper, _reach);
      // Straight away from where the elbow hangs: any turn will do.
      if (_bend.lengthSq() < 1e-10) _bend.crossVectors(_upper, limb.shoulder);
      _bend.normalize();
      const easy = this.config.arms.wrist ?? WRIST_BEND;
      let turn = Math.min(off, easy + (WRIST_BEND_AIMED - easy) * this.aim);
      for (;;) {
        _lower.copy(_upper).applyAxisAngle(_bend, turn);
        _elbow.copy(_wrist).addScaledVector(_lower, limb.lowerLength);
        const most = Math.min(off, WRIST_MOST);
        if (turn >= most || (!seen(_elbow) && _elbow.y <= _wrist.y)) break;
        turn = Math.min(most, turn + WRIST_STEP);
      }
      // The upper arm from the elbow towards the shoulder, at its length.
      _upper.subVectors(limb.shoulder, _elbow).normalize();
      _shoulder.copy(_elbow).addScaledVector(_upper, limb.upperLength);

      // Shoulder to elbow and elbow to wrist, for turning the bones.
      _upper.negate();
      _lower.negate();
      _hinge.crossVectors(_upper, _lower);
      if (_hinge.lengthSq() < 1e-8) _hinge.crossVectors(_upper, limb.elbow);
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

  /** The player is holding the aim button, or has let go. Never while
   *  guns are being changed. */
  setAiming(on) {
    this.aiming = on && !this.switching;
  }

  /**
   * How far through a reload the weapon is, 0 to 1, or null when it is not
   * reloading. The server decides when a reload starts and ends; this only
   * draws it - the rifle tipped over to show the magazine well, a seat of
   * the fresh magazine two thirds of the way through, and back up.
   */
  setReload(progress, seconds = 1) {
    this.reloadProgress = progress;
    this.reloadSeconds = seconds;
  }

  /** A grenade left the player's hand: the rifle drops out of the way and
   *  comes back. */
  onThrow() {
    this.throwAt = this.time;
  }

  /** The eye's height over the feet, which crouching changes. Casings land
   *  on the floor under the player, and this is how far down it is. */
  setEyeOffset(offset) {
    this.eyeOffset = offset;
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
    this.cycleAt = this.time;
    // A different size and roll each time. Three identical frames in a burst
    // read as a decal being switched on and off; a little variation reads as
    // combustion, which is what it is.
    this.flashGroup.rotation.z = Math.random() * Math.PI;
    this.flashSize = 0.82 + Math.random() * 0.36;

    // A bolt action's case comes out when the bolt is worked, after the
    // shot; everything else throws it with the shot.
    const delay = this.config.casings.delay ?? 0;
    if (delay > 0) this.ejections.push(this.time + delay);
    else this._eject();
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
      if (onGround) this.floor = eye.y - (this.eyeOffset ?? SIM.eyeOffset) - SIM.halfExtentY;
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
    this.bobWeight = damp(this.bobWeight, moving ? Math.min(1, speed / FULL_SPEED) : 0, c.bob.fade, dt);
    this.bobPhase += speed * dt * c.bob.cyclesPerMetre * Math.PI * 2;
    const bob = c.bob.amount * this.bobWeight * steady(c.ads.bobScale);
    const bobX = Math.sin(this.bobPhase) * bob;
    const bobY = Math.sin(this.bobPhase * 2) * bob * 0.5 - bob * 0.3;
    const bobRoll = Math.sin(this.bobPhase) * c.bob.roll * this.bobWeight * steady(c.ads.bobScale);
    // The stride turns the gun a little as well: across with each step, and
    // up and down with each footfall.
    const swing = c.bob.rotation * this.bobWeight * steady(c.ads.bobScale);
    const bobYaw = Math.sin(this.bobPhase) * swing;
    const bobPitch = Math.sin(this.bobPhase * 2) * swing * 0.5;

    // Going sideways, the gun lags the way the body goes: out, and canted.
    const across = onGround && this.hasEye
      ? this.eyeVelocity.x * Math.cos(yaw) - this.eyeVelocity.z * Math.sin(yaw)
      : 0;
    this.strafe = damp(this.strafe, clamp(across / FULL_SPEED, 1), c.move.rate, dt);
    const lag = this.strafe * steady(c.ads.bobScale);

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

    // Reload and throw are envelopes over the whole pose: eased in, held,
    // eased out, so the weapon never snaps between poses.
    let reload = 0;
    let seat = 0;
    if (this.reloadProgress !== null && this.reloadProgress !== undefined) {
      const p = this.reloadProgress;
      reload = smooth(Math.min(1, p / 0.18)) * smooth(Math.min(1, (1 - p) / 0.2));
      seat = Math.max(0, 1 - Math.abs(p - 0.62) / 0.06);
    }
    let thrown = 0;
    if (this.throwAt !== undefined) {
      const since = this.time - this.throwAt;
      if (since < THROW_SECONDS) {
        const p = since / THROW_SECONDS;
        thrown = smooth(Math.min(1, p / 0.2)) * smooth(Math.min(1, (1 - p) / 0.45));
      }
    }
    // A change of gun: the old one down and out of sight, then the new one
    // up from there, over the time the server makes the player wait.
    let lowered = 0;
    if (this.switching) {
      const p = (this.time - this.switching.at) / this.switching.seconds;
      if (p < PUT_AWAY) {
        lowered = smooth(p / PUT_AWAY);
      } else {
        if (this.rig !== this.switching.to) this._useRig(this.switching.to);
        lowered = 1 - smooth(Math.min(1, (p - PUT_AWAY) / (1 - PUT_AWAY)));
        if (p >= 1) this.switching = null;
      }
    }
    while (this.ejections.length && this.ejections[0] <= this.time) {
      this.ejections.shift();
      this._eject();
    }

    const a = this.aim;
    const hip = this.hipPosition;
    const ads = this.adsPosition;
    this.root.position.set(
      hip.x + (ads.x - hip.x) * a + (sway.x * swayScale) + bobX + breathX - lag * c.move.shift,
      hip.y + (ads.y - hip.y) * a + (sway.y * swayScale) + bobY + breathY
        + (this.airLift - this.landDip) * steady(c.ads.bobScale)
        - reload * c.reloadPose.drop + seat * 0.02 - thrown * 0.38 - lowered * LOWERED.drop,
      hip.z + (ads.z - hip.z) * a + r.back + reload * c.reloadPose.back,
    );
    const hr = this.hipRotation;
    const ar = this.adsRotation;
    // The weapon tips a little with the view from the hip, so it does not
    // feel welded to the screen looking up and down; with the sights up it
    // must not, or they would leave the middle.
    this.root.rotation.set(
      hr.x + (ar.x - hr.x) * a + r.rise + sway.pitch * swayScale + breathPitch + bobPitch
        + pitch * 0.05 * (1 - a) + reload * c.reloadPose.pitch - thrown * 0.7 - lowered * LOWERED.tip,
      hr.y + (ar.y - hr.y) * a + r.yaw + sway.yaw * swayScale + bobYaw + reload * c.reloadPose.yaw,
      hr.z + (ar.z - hr.z) * a + r.roll + bobRoll + lag * c.move.roll + reload * c.reloadPose.roll + seat * 0.06
        - lowered * LOWERED.roll,
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

    // Through a magnified optic the picture is the scope's own (`scope`):
    // the gun and the arms holding it are not in it.
    const hidden = this.scope >= 0.999;
    this.root.visible = !hidden;
    if (this.body) this.body.visible = !hidden;

    this._workParts();
    this._poseArms();
    this._placeDot();
    this._updateDebris(dt);
  }

  /**
   * A red dot is seen on the point of aim from wherever the eye is behind
   * it - that is what one is for - so it is drawn on its glass where the
   * line from the eye straight ahead crosses it, and not at all where that
   * line misses the glass, as a real one is not seen from the hip. Painted
   * on the glass instead, it rode the gun: a bob or a sway with the sights
   * up carried it off the middle of the picture, where the shot goes.
   */
  _placeDot() {
    const dot = this.rifle?.dot;
    if (!dot) return;
    _inverse.copy(this.rifle.matrixWorld).invert();
    _v.setFromMatrixPosition(this.camera.matrixWorld).applyMatrix4(_inverse);
    _w.set(0, 0, -1).transformDirection(this.camera.matrixWorld).transformDirection(_inverse);
    const along = _w.z !== 0 ? (dot.z - _v.z) / _w.z : -1;
    const x = _v.x + _w.x * along;
    const y = _v.y + _w.y * along;
    const seen = along > 0 && Math.hypot(x, y - dot.height) < dot.radius;
    dot.red.visible = seen;
    dot.halo.visible = seen;
    if (!seen) return;
    dot.red.position.set(x, y, dot.z);
    dot.halo.position.set(x, y, dot.haloZ);
  }

  /**
   * The gun's own parts (`userData.parts`, tuned by `action` in weapons.js):
   * the bolt or slide back and home with each shot, a bolt action worked by
   * hand after one, the trigger pulled; and for a reload the magazine out
   * and a fresh one in, the left hand carrying it, and the action worked at
   * the end. Drawn only - the server says when a shot happened and when a
   * reload is done.
   */
  _workParts() {
    this.leftShift.set(0, 0, 0);
    const parts = this.rig?.model.userData.parts;
    const action = this.config.action;
    if (!parts || !action) return;
    const since = this.time - this.cycleAt;

    let back = 0;
    let lift = 0;
    if (action.bolt && since < action.bolt.seconds) {
      const f = since / action.bolt.seconds;
      back = action.bolt.back * (f < 0.3 ? smooth(f / 0.3) : 1 - smooth((f - 0.3) / 0.7));
    }
    if (action.boltAction) {
      const { after, lift: up, back: stroke } = action.boltAction;
      // After a shot, and in a reload once the new magazine is home: a bolt
      // action chambers its round by hand either way.
      const reloading = this.reloadProgress !== null && this.reloadProgress !== undefined;
      const t = reloading ? (this.reloadProgress - BOLT_IN_RELOAD) * this.reloadSeconds : since - after;
      if (t >= 0 && t < BOLT_WORK.done) {
        lift = up * (t < BOLT_WORK.lifted ? smooth(t / BOLT_WORK.lifted)
          : t < BOLT_WORK.home ? 1 : 1 - smooth((t - BOLT_WORK.home) / (BOLT_WORK.done - BOLT_WORK.home)));
        back = stroke * (t < BOLT_WORK.lifted ? 0
          : t < BOLT_WORK.back ? smooth((t - BOLT_WORK.lifted) / (BOLT_WORK.back - BOLT_WORK.lifted))
            : t < BOLT_WORK.home ? 1 - smooth((t - BOLT_WORK.back) / (BOLT_WORK.home - BOLT_WORK.back)) : 0);
      }
    }

    // A reload, in the fractions of it the server's clock gives.
    const p = this.reloadProgress;
    let out = 0;
    let shown = true;
    let carry = 0;
    let charge = 0;
    let atHandle = 0;
    if (p !== null && p !== undefined) {
      const span = (a, b) => smooth(Math.min(1, Math.max(0, (p - a) / (b - a))));
      carry = span(0.04, 0.12);
      out = span(0.12, 0.26);
      if (p >= 0.26 && p < 0.42) {
        // Away to the pouch for the next one, out of sight.
        shown = false;
        out = 1 + 0.6 * span(0.26, 0.34) * (1 - span(0.34, 0.42));
      } else if (p >= 0.42) {
        out = 1 - 0.88 * span(0.42, 0.56) - 0.12 * span(0.56, 0.62);
      }
      if (action.charge > 0) {
        atHandle = span(0.62, 0.7) * (1 - span(0.82, 0.95));
        charge = action.charge * span(0.7, 0.76) * (1 - span(0.76, 0.8));
        carry *= 1 - span(0.62, 0.7);
      } else {
        carry *= 1 - span(0.62, 0.78);
      }
      back = Math.max(back, charge);
    }

    const bolt = parts.bolt;
    if (bolt) {
      bolt.node.position.copy(bolt.position);
      bolt.node.position.z += back;
      bolt.node.quaternion.copy(bolt.quaternion);
      if (lift) bolt.node.quaternion.multiply(_turn.setFromAxisAngle(_zAxis, lift));
    }
    const pulled = since < TRIGGER_PULL ? 1 : Math.max(0, 1 - (since - TRIGGER_PULL) / TRIGGER_PULL);
    if (parts.trigger) {
      parts.trigger.node.quaternion.copy(parts.trigger.quaternion).multiply(_turn.setFromAxisAngle(_xAxis, -(action.trigger ?? 0) * pulled));
    }
    if (parts.hammer && action.hammer) {
      // Down with the shot, cocked again as the slide runs back over it.
      const fallen = action.bolt && since < action.bolt.seconds ? (since < action.bolt.seconds * 0.3 ? 1 : 1 - smooth((since - action.bolt.seconds * 0.3) / (action.bolt.seconds * 0.4))) : 0;
      parts.hammer.node.quaternion.copy(parts.hammer.quaternion).multiply(_turn.setFromAxisAngle(_xAxis, -action.hammer * fallen));
    }
    const magazine = parts.magazine;
    const [mx, my, mz] = action.magazine;
    if (magazine) {
      magazine.node.position.copy(magazine.position).add(_shift.set(mx * out, my * out, mz * out));
      magazine.node.visible = shown;
    }

    // The left hand: off where it holds the gun onto the magazine, or the
    // handle.
    const points = this.rig.model.userData.points;
    _support.fromArray(this.config.arms.leftPalm);
    if (carry > 0 && points?.magazine) {
      _hand.fromArray(points.magazine).add(_shift.set(mx * out, my * out, mz * out).divideScalar(UNIT));
      this.leftShift.copy(_hand.sub(_support).multiplyScalar(carry));
    }
    if (atHandle > 0 && bolt) {
      // The handle stands out on the gun's right; the hand goes over to it.
      bolt.node.getWorldPosition(_hand);
      this.rifle.worldToLocal(_hand);
      _hand.x += HANDLE_REACH / UNIT;
      this.leftShift.lerp(_hand.sub(_support), atHandle);
    }
  }

  /** How far the view is into a magnified optic's own picture, 0 to 1: the
   *  last quarter of the way to the sights, so the gun is seen coming up
   *  to the eye first. Zero for iron sights and a red dot. */
  get scope() {
    if (!this.config.ads.scoped) return 0;
    return smooth(Math.max(0, (this.aim - 0.75) / 0.25));
  }

  /** What is in hand: the gun and its optic, as the picture is drawn. */
  get held() {
    return this.rig;
  }

  /** Where the muzzle is drawn, in the world, for the player's own round to
   *  leave from: this scene's camera looks the way the world's does, from
   *  the eye. */
  muzzleInWorld(camera, out) {
    this.root.updateMatrix();
    return out.copy(this.flashGroup.position).applyMatrix4(this.root.matrix).applyMatrix4(camera.matrixWorld);
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
