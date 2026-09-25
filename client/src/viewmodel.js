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

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { wrapAngle } from './sim.js';
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

export class Viewmodel {
  constructor(config = RIFLE) {
    this.config = config;
    this.scene = new THREE.Scene();
    // Angle and aspect are set by `setView` from the world camera's *hip*
    // angle, so the weapon sits in the same perspective as everything else.
    // It is not narrowed with the sights up: the weapon is placed for this
    // angle, and zooming it with the world would move the sights off centre.
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

    this._buildLighting();
    this._buildFlash();
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
    this.scene.add(new THREE.HemisphereLight(0x9ec4ff, 0x30281f, 1.1));
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

  async load(url) {
    const gltf = await new GLTFLoader().loadAsync(url);
    const rifle = gltf.scene;
    rifle.position.copy(this.modelOffset);
    rifle.scale.setScalar(this.config.scale);
    this.root.add(rifle);
    this.rifle = rifle;
    return rifle;
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
  }

  /** The player came down at `speed` metres per second. */
  onLanded(speed) {
    const { land } = this.config;
    this.landDip = Math.min(land.maxDip, this.landDip + speed * land.dipPerMetrePerSecond);
  }

  /**
   * Places the weapon for this frame.
   *
   * `yaw` and `pitch` are the camera's. The weapon is positioned in the
   * viewmodel camera's fixed space, so the rig stays glued to the view
   * without ever trailing it by a frame; sway is an offset on top, not lag.
   */
  update(dt, yaw, pitch, speed, onGround) {
    const c = this.config;
    this.time += dt;

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
  }

  /**
   * How much to narrow the world camera, as a factor on the tangent of its
   * half-angle: 1 at the hip, `ads.zoom` with the sights up.
   */
  get zoom() {
    return 1 - this.aim * (1 - this.config.ads.zoom);
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
