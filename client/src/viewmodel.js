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
// this model is - so all of it can be tuned freely.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { wrapAngle } from './sim.js';

/**
 * Where the weapon sits relative to the eye: right, down, and forward.
 *
 * Further right, lower and further away than a real carbine would be. Held
 * where a person actually holds one it covers the lower right quadrant of the
 * screen, which is the quadrant a player needs to see things coming from. The
 * first version of this was life size at arm's length and read as "a gun in
 * front of the camera" rather than "a gun I am carrying".
 */
// Down and out into the corner, and close.
//
// A weapon held against the shoulder has its stock behind the camera, so
// most of what is drawn should be running off the bottom right of the
// frame. Sitting it far enough forward to show the whole rifle is what made
// it read as a prop hanging in space rather than something the player is
// carrying.
const REST = new THREE.Vector3(0.32, -0.30, -0.44);

/**
 * The model measures 4.405 units nose to stock, so this draws it at 0.79 m,
 * near enough a real carbine's 0.84 m.
 *
 * It was 0.135 - 0.59 m - on the theory that first-person weapons are drawn
 * small. They are drawn *cropped*, which is a different thing: near enough
 * full size, close to the camera, with the back of the weapon outside the
 * frame. Drawn small and whole it looks like a toy at arm's length.
 */
const SCALE = 0.18;

/** Pushed forward so the stock is not sitting on the near plane. */
const MODEL_OFFSET = new THREE.Vector3(0, 0, -0.1);

/**
 * Turned in towards the middle of the screen, and nosed down a little.
 *
 * A rifle held square to the view points its barrel at nothing and leads
 * the eye off the side of the frame. A few degrees inward puts the muzzle
 * near the crosshair, which is both what the weapon is for and what every
 * shooter does with its viewmodel.
 */
const MODEL_YAW = 0.085;
const MODEL_PITCH = -0.03;

/** Bore height and muzzle face in the model's own units, measured off its
 *  geometry, so the flash sits on the end of the barrel rather than near it. */
const BORE_HEIGHT = 0.065;
const MUZZLE_FACE = -2.306;

const RECOIL_KICK = 0.055;
const RECOIL_RECOVERY = 14;
const SWAY_PER_TURN = 0.035;
const SWAY_RECOVERY = 9;
const SWAY_LIMIT = 0.05;
const BOB_AMOUNT = 0.012;

/** How long the flash is lit. Shorter than the fire interval, so rapid fire
 *  reads as a series of flashes rather than one continuous glow. */
const FLASH_SECONDS = 0.04;

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
function flashTexture() {
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
  constructor() {
    this.scene = new THREE.Scene();
    // Angle and aspect are set by `setView` from the world camera, so the
    // weapon sits in the same perspective as everything else. Sharing the angle
    // matters: at a different one the gun's vanishing point disagrees with the
    // room's and it reads as a sticker on the screen.
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);

    this.root = new THREE.Group();
    this.root.position.copy(REST);
    this.scene.add(this.root);

    this.recoil = 0;
    this.sway = new THREE.Vector2();
    this.bobPhase = 0;
    this.previousYaw = 0;
    this.flash = 0;
    /** Size of the current flash, picked when it was fired. */
    this.flashSize = 1;

    this._buildLighting();
    this._buildFlash();
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
    const muzzle = new THREE.Vector3(
      MODEL_OFFSET.x,
      MODEL_OFFSET.y + BORE_HEIGHT * SCALE,
      MODEL_OFFSET.z + MUZZLE_FACE * SCALE,
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
    rifle.position.copy(MODEL_OFFSET);
    rifle.rotation.set(MODEL_PITCH, MODEL_YAW, 0);
    rifle.scale.setScalar(SCALE);
    this.root.add(rifle);
    this.rifle = rifle;
    return rifle;
  }

  /** Called when the server confirms a shot this player fired. */
  onShotFired() {
    this.recoil = RECOIL_KICK;
    this.flash = FLASH_SECONDS;
    // A different size and roll each time. Three identical frames in a burst
    // read as a decal being switched on and off; a little variation reads as
    // combustion, which is what it is.
    this.flashGroup.rotation.z = Math.random() * Math.PI;
    this.flashSize = 0.82 + Math.random() * 0.36;
  }

  /**
   * Places the weapon for this frame.
   *
   * `yaw` and `pitch` are the camera's, and the weapon is positioned in the
   * viewmodel camera's fixed space, so the whole rig stays glued to the view
   * without ever trailing it by a frame.
   */
  update(dt, yaw, pitch, speed, onGround) {
    this.recoil = Math.max(0, this.recoil - this.recoil * RECOIL_RECOVERY * dt);
    this.flash = Math.max(0, this.flash - dt);

    // Sway: the weapon lags a turn slightly, then settles.
    const turn = wrapAngle(yaw - this.previousYaw);
    this.previousYaw = yaw;
    this.sway.x += turn * SWAY_PER_TURN;
    this.sway.multiplyScalar(Math.max(0, Math.min(1, 1 - SWAY_RECOVERY * dt)));
    if (this.sway.length() > SWAY_LIMIT) this.sway.setLength(SWAY_LIMIT);

    // Bob while moving on the ground, so running has a rhythm to it.
    const moving = onGround && speed > 0.5;
    this.bobPhase += dt * (moving ? speed * 1.6 : 2);
    const bobScale = moving ? BOB_AMOUNT * Math.min(1, speed / 8) : 0;
    const bobX = Math.sin(this.bobPhase) * bobScale;
    const bobY = -Math.abs(Math.sin(this.bobPhase * 2)) * bobScale;

    this.root.position.set(
      REST.x + this.sway.x + bobX,
      REST.y + this.sway.y + bobY,
      REST.z + this.recoil,
    );
    // A touch of muzzle rise, and the weapon tips with the view so it does not
    // feel welded to the screen when looking up and down.
    this.root.rotation.set(-this.recoil * 3 + pitch * 0.05, 0, 0);

    const lit = this.flash > 0;
    this.flashGroup.visible = lit;
    if (lit) {
      // The roll and the size of *this* flash were chosen when the shot was
      // fired; all that happens here is that it shrinks as it dies. Rerolling
      // every frame - which is what this used to do - spins the flash through
      // a random angle sixty times a second for the forty milliseconds it is
      // alive, which reads as a strobe rather than as a shot.
      const fade = this.flash / FLASH_SECONDS;
      this.flashGroup.scale.setScalar(this.flashSize * (0.62 + fade * 0.5));
    }
    this.flashLight.intensity = lit ? 9 * (this.flash / FLASH_SECONDS) : 0;
  }

  setView(aspect, verticalFov) {
    this.camera.aspect = aspect;
    this.camera.fov = verticalFov;
    this.camera.updateProjectionMatrix();
  }
}
