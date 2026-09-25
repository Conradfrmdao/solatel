// Everyone else.
//
// # Why other players are drawn in the past
//
// Snapshots arrive twenty times a second. Drawing each one the moment it lands
// would make everyone else move in visible steps, so the client renders other
// players slightly behind the newest snapshot and interpolates between the two
// that bracket that moment.
//
// The cost is that what you see is marginally out of date - and that is
// precisely the delay the server's lag compensation rewinds by when it decides
// whether your shot connected. The two numbers are the same constant, taken
// from the simulation, because if they ever disagreed players would have to aim
// slightly off-target to hit.
//
// # Why the animation is not sent
//
// Which clip a player is playing is derived here, every frame, from the
// velocity and ground contact already in the snapshot. Adding an "animation"
// field to the wire would be inventing a second, softer source of truth for
// something the first one already implies - and it would be one more thing a
// client could lie about. A player whose legs are moving is a player the server
// says is moving.
//
// # How a body is posed
//
// The soldier's clips are idle, walk, run and a jump, with the arms swinging
// and nothing in the hands. Everything else is layered on top of them here,
// every frame, from what the snapshot already says:
//
//   legs     turned toward the way the player is moving, up to 70 degrees
//            either side, and the walk played backwards when backing off -
//            no moonwalking. The spine turns back the other way, so the
//            chest keeps facing where they aim.
//   aim      the rifle is not in a hand: it sits at the shoulder in a frame
//            that turns with the player's yaw and pitch, so it points exactly
//            where they are looking. The torso and head lean with the pitch,
//            and both arms are bent onto it by two-bone IK - right hand on the
//            grip, left on the handguard.
//   shots    the rifle kicks and flashes when the server says they fired.
//   landing  a dip in the hips when they come down.
//   death    the body falls rather than vanishing, then goes.
//
// Players far away are animated less often and skip the IK: at sixty metres
// nobody can see a hand, and a browser has other players to draw.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { SIM, lerpAngle, wrapAngle } from './sim.js';
import { flashTexture } from './viewmodel.js';

/** Clip names exactly as the file spells them, pipes and spaces included. */
const CLIP = {
  idle: 'rig|idle -loop',
  walk: 'rig|walk -loop',
  run: 'rig|run -loop',
  air: 'rig|air -loop',
};

/** Below this a player is standing still, comfortably above the residual
 *  velocity friction leaves behind so idle legs do not twitch. */
const IDLE_SPEED = 0.6;

/** Where walking becomes running. */
const RUN_SPEED = 4.2;

/** Ground speeds the two locomotion clips look right at. Playback is scaled
 *  around these so feet slide less at other speeds. */
const WALK_REFERENCE = 2.6;
const RUN_REFERENCE = 7.0;
const MIN_PLAYBACK = 0.6;
const MAX_PLAYBACK = 1.7;

/** Cross-fade between gaits. Leaving the ground is abrupt in a way walking to
 *  running is not, so it gets a shorter one. */
const BLEND_SECONDS = 0.14;
const BLEND_AIR_SECONDS = 0.07;

/** How much snapshot history to keep - comfortably more than the interpolation
 *  delay, so a burst of late packets still has something to work from. */
const HISTORY_MS = 2000;

/** The model faces +Z; yaw 0 in this game looks down -Z. Without this the
 *  soldier runs backwards. */
const MODEL_FACING_OFFSET = Math.PI;

/** The rig's bones, as the file names them. */
const BONE = {
  hips: 'hips_01',
  spine: 'spine_02',
  chest: 'chest_03',
  neck: 'neck_04',
  head: 'head_05',
  upperArmR: 'up_arm_R_020',
  lowerArmR: 'low_arm_R_021',
  handR: 'hand_R_022',
  upperArmL: 'up_arm_L_08',
  lowerArmL: 'low_arm_L_09',
  handL: 'hand_L_010',
};

/**
 * How the rifle is carried, in the player's own frame: metres, +Z forward,
 * +Y up, -X to their right (the model faces +Z). Measured off the rig: the
 * shoulders are at 1.40 m and 0.19 m either side, the arms reach 0.47 m.
 */
const CARRY = {
  /** The shoulder pocket the stock sits in: a little inside the right
   *  shoulder joint, toward the cheek. */
  shoulder: new THREE.Vector3(-0.1, 1.4, 0.0),
  /** Metres of rifle: the model is 4.405 units nose to stock. */
  scale: 0.19,
  /** Stock-end to model origin, in model units, so the butt is on the pivot. */
  stock: 2.098,
  /** Up from the pivot, so the sights are near the cheek. */
  lift: 0.05,
  /** Where the wrists go, in the model's own units: behind the pistol grip
   *  (0.3 m from the butt), and under the front of the magazine well - the
   *  fingers carry on past the wrist onto the rifle. */
  grip: new THREE.Vector3(0, -0.4, 0.7),
  handguard: new THREE.Vector3(0, -0.12, -0.6),
  muzzle: new THREE.Vector3(0, 0.065, -2.306),
};

/** How far the legs turn toward the way a player is moving, and how fast. */
const LEG_TURN_LIMIT = 1.22;
const LEG_TURN_RATE = 10;

/** Shares of the aim pitch taken by the spine, the chest and the neck. */
const LEAN = { spine: 0.2, chest: 0.25, neck: 0.3 };

/**
 * The chest turned toward the right, bringing the left shoulder forward to
 * reach the handguard - the bladed stance anyone holding a rifle stands in.
 * The neck turns back by the same amount, so the head still faces the aim.
 * Without it the rig's arms, at 0.47 m, cannot reach both ends of the rifle.
 */
const STANCE_TURN = -0.45;

const KICK_RECOVERY = 14;
const FLASH_SECONDS = 0.05;
const LAND_DIP = 0.012;
const LAND_RECOVERY = 9;
/** A fall takes this long, and the body stays down for the rest. */
const DEATH_FALL_SECONDS = 0.5;
const DEATH_LINGER_SECONDS = 2.5;

/** Beyond these, animate less often and skip the hands. */
const NEAR = 35;
const FAR = 70;
const DETAIL = 50;

// Scratch objects, reused every frame so posing a crowd allocates nothing.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qWorld = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

export class Remotes {
  constructor(scene) {
    this.scene = scene;
    this.template = null;
    this.weapon = null;
    this.players = new Map();
    this.history = [];
    this.flashMaterial = new THREE.SpriteMaterial({
      map: flashTexture(),
      color: 0xfff0c0,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  /**
   * `weapon` is a model somebody else already loaded.
   *
   * The viewmodel needs the same rifle, and fetching three megabytes of
   * identical geometry twice because two modules each asked for it is the kind
   * of waste that is invisible on localhost and expensive on a real
   * connection.
   */
  async load(soldierUrl, weapon) {
    const loader = new GLTFLoader();
    const soldier = await loader.loadAsync(soldierUrl);

    this.template = soldier.scene;
    this.clips = soldier.animations;
    this.weapon = weapon;

    this.template.traverse((node) => {
      if (node.isMesh || node.isSkinnedMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        // A skinned mesh whose bounds are computed from the bind pose gets
        // culled when an animation takes it outside them, which shows up as
        // players flickering out at the edge of the screen.
        node.frustumCulled = false;
      }
    });
    this.weapon.traverse((node) => {
      if (node.isMesh) node.castShadow = true;
    });
    return this.template;
  }

  /** Records a snapshot for later interpolation. */
  record(snapshot, nowMs) {
    this.history.push({ at: nowMs, players: snapshot.players });
    while (
      this.history.length > 0 &&
      nowMs - this.history[0].at > HISTORY_MS
    ) {
      this.history.shift();
    }
  }

  /** The server says this player fired. */
  onShot(id) {
    const player = this.players.get(id);
    if (!player) return;
    player.kick = 1;
    player.flash = FLASH_SECONDS;
    player.flashSprite.material.rotation = Math.random() * Math.PI;
  }

  /**
   * Places and animates every other player for this frame.
   *
   * `selfId` is skipped: you do not see your own body in first person, and
   * drawing it would put a shoulder through the camera. `eye` is where the
   * camera is, for deciding how much detail each player is worth.
   */
  update(nowMs, dt, selfId, eye) {
    if (!this.template) return;

    const renderAt = nowMs - SIM.interpolationDelayMs;
    const posed = this._sample(renderAt);
    if (!posed) return;

    const seen = new Set();
    for (const entry of posed) {
      if (entry.id === selfId) continue;
      seen.add(entry.id);

      let player = this.players.get(entry.id);
      if (!player) {
        player = this._spawn(entry.id);
        this.players.set(entry.id, player);
      }
      this._pose(player, entry, dt, eye);
    }

    for (const [id, player] of this.players) {
      if (seen.has(id)) continue;
      this.scene.remove(player.root);
      this.players.delete(id);
    }
  }

  _spawn(id) {
    // The root turns with the player's aim. The body inside it turns a
    // little further for the legs; the carry frame does not.
    const root = new THREE.Group();
    const body = cloneSkinned(this.template);
    root.add(body);
    this.scene.add(root);

    const mixer = new THREE.AnimationMixer(body);
    const actions = {};
    for (const [gait, name] of Object.entries(CLIP)) {
      const clip = THREE.AnimationClip.findByName(this.clips, name);
      if (!clip) {
        console.warn(`soldier has no clip named ${name}`);
        continue;
      }
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      actions[gait] = action;
    }
    if (actions.idle) actions.idle.play();

    const bones = {};
    for (const [key, name] of Object.entries(BONE)) bones[key] = body.getObjectByName(name);

    // The rifle, pivoting at the shoulder pocket.
    const carry = new THREE.Group();
    carry.position.copy(CARRY.shoulder);
    root.add(carry);
    const rifle = new THREE.Group();
    rifle.rotation.y = Math.PI; // muzzle forward, along +Z
    rifle.position.set(0, CARRY.lift, CARRY.stock * CARRY.scale);
    rifle.scale.setScalar(CARRY.scale);
    carry.add(rifle);
    if (this.weapon) {
      // A copy of the first-person rifle, which carries that rig's own
      // offset and scale. Those are dropped: this one is placed and sized by
      // the group above, and inheriting them is what made it a toy.
      const copy = this.weapon.clone(true);
      copy.position.set(0, 0, 0);
      copy.rotation.set(0, 0, 0);
      copy.scale.setScalar(1);
      rifle.add(copy);
    }
    const marker = (at) => {
      const node = new THREE.Object3D();
      node.position.copy(at);
      rifle.add(node);
      return node;
    };
    const gripR = marker(CARRY.grip);
    const gripL = marker(CARRY.handguard);
    const muzzle = marker(CARRY.muzzle);
    const flashSprite = new THREE.Sprite(this.flashMaterial.clone());
    flashSprite.scale.setScalar(0.35 / CARRY.scale);
    flashSprite.visible = false;
    muzzle.add(flashSprite);

    return {
      id, root, body, mixer, actions, bones, carry, rifle, gripR, gripL, flashSprite,
      gait: 'idle',
      legYaw: 0,
      reverse: false,
      kick: 0,
      flash: 0,
      dip: 0,
      wasOnGround: true,
      diedAt: null,
      age: 0,
      pending: 0,
    };
  }

  _pose(player, entry, dt, eye) {
    player.age += dt;
    const { root, body, carry } = player;
    root.position.set(entry.x, entry.y - SIM.halfExtentY, entry.z);
    root.rotation.y = entry.yaw + MODEL_FACING_OFFSET;

    // Dead: fall once, lie there a moment, then go. A body that vanished
    // the instant it was hit read as the player disconnecting.
    if (entry.health <= 0) {
      if (player.diedAt === null) {
        player.diedAt = player.age;
        carry.visible = false;
      }
      const since = player.age - player.diedAt;
      const t = Math.min(1, since / DEATH_FALL_SECONDS);
      body.rotation.x = -(Math.PI / 2) * t * t;
      root.visible = since < DEATH_FALL_SECONDS + DEATH_LINGER_SECONDS;
      player.mixer.update(dt);
      return;
    }
    if (player.diedAt !== null) {
      player.diedAt = null;
      body.rotation.x = 0;
      carry.visible = true;
    }
    root.visible = true;

    const distance = eye ? root.position.distanceTo(eye) : 0;

    // Fewer mixer updates the further away they are: every frame near,
    // every other frame at middle distance, every fourth far away. The time
    // is saved up rather than dropped, so the clips stay in step.
    player.pending += dt;
    const every = distance > FAR ? 4 : distance > NEAR ? 2 : 1;
    player.frame = (player.frame ?? 0) + 1;
    if (player.frame % every !== 0) return;
    const step = player.pending;
    player.pending = 0;

    this._driveLegs(player, entry, step);
    player.mixer.update(step);

    const bones = player.bones;
    body.updateMatrixWorld(true);

    // Chest back round to face the aim, torso and head leaning with it.
    const counter = -player.legYaw;
    const right = _axis.set(-1, 0, 0).applyQuaternion(root.quaternion);
    rotateWorld(bones.spine, _up, counter * 0.5 + STANCE_TURN * 0.4);
    rotateWorld(bones.chest, _up, counter * 0.5 + STANCE_TURN * 0.6);
    rotateWorld(bones.neck, _up, -STANCE_TURN);
    rotateWorld(bones.spine, right, entry.pitch * LEAN.spine);
    rotateWorld(bones.chest, right, entry.pitch * LEAN.chest);
    rotateWorld(bones.neck, right, entry.pitch * LEAN.neck);

    // Landing dip, in the hips.
    if (entry.onGround && !player.wasOnGround) player.dip = LAND_DIP;
    player.wasOnGround = entry.onGround;
    player.dip += (0 - player.dip) * (1 - Math.exp(-LAND_RECOVERY * step));
    if (bones.hips) bones.hips.position.y -= player.dip / Math.max(1e-6, body.scale.y);

    // The rifle points where they aim, and kicks when they fire.
    player.kick += (0 - player.kick) * (1 - Math.exp(-KICK_RECOVERY * step));
    carry.rotation.set(-entry.pitch - player.kick * 0.1, 0, 0);
    carry.position.set(CARRY.shoulder.x, CARRY.shoulder.y - player.dip, CARRY.shoulder.z - player.kick * 0.04);
    player.flash = Math.max(0, player.flash - step);
    player.flashSprite.visible = player.flash > 0 && distance < FAR;

    // Hands on the rifle, close enough to see them.
    if (distance < DETAIL && bones.upperArmR && bones.upperArmL) {
      root.updateMatrixWorld(true);
      // Elbows down and out: the pole is below and to the side of each
      // shoulder, in the player's own frame.
      player.gripR.getWorldPosition(_target);
      root.localToWorld(_pole.set(-0.45, 0.9, -0.1));
      solveArm(bones.upperArmR, bones.lowerArmR, bones.handR, _target, _pole);
      player.gripL.getWorldPosition(_target);
      root.localToWorld(_pole.set(0.45, 0.9, 0.1));
      solveArm(bones.upperArmL, bones.lowerArmL, bones.handL, _target, _pole);
    }
  }

  _driveLegs(player, entry, dt) {
    // Which way they are moving, against which way they face.
    const moving = entry.onGround && entry.speed >= IDLE_SPEED;
    let target = 0;
    let reverse = false;
    if (moving) {
      const faceX = -Math.sin(entry.yaw);
      const faceZ = -Math.cos(entry.yaw);
      const cross = faceZ * entry.vx - faceX * entry.vz;
      const dot = faceX * entry.vx + faceZ * entry.vz;
      let angle = Math.atan2(cross, dot);
      if (Math.abs(angle) > Math.PI * 0.6) {
        // Backing off: face the legs the other way and play the walk in
        // reverse, rather than turning them round to run away.
        reverse = true;
        angle = wrapAngle(angle - Math.PI);
      }
      target = Math.max(-LEG_TURN_LIMIT, Math.min(LEG_TURN_LIMIT, angle));
    }
    player.legYaw += (target - player.legYaw) * (1 - Math.exp(-LEG_TURN_RATE * dt));
    player.body.rotation.y = player.legYaw;
    player.reverse = reverse;

    const gait = pickGait(entry.speed, entry.onGround);
    const action = player.actions[gait];
    if (!action) return;
    if (gait !== player.gait) {
      const previous = player.actions[player.gait];
      const blend = gait === 'air' ? BLEND_AIR_SECONDS : BLEND_SECONDS;
      action.reset().play();
      if (previous && previous !== action) {
        previous.crossFadeTo(action, blend, false);
      }
      player.gait = gait;
    }
    const rate = playbackRate(gait, entry.speed);
    action.setEffectiveTimeScale(reverse ? -rate : rate);
  }

  /** Finds the two snapshots bracketing `atMs` and blends between them. */
  _sample(atMs) {
    if (this.history.length === 0) return null;

    let before = null;
    let after = null;
    for (const entry of this.history) {
      if (entry.at <= atMs) before = entry;
      else {
        after = entry;
        break;
      }
    }

    // Not enough history yet, or we have fallen behind: show the freshest
    // thing available rather than nothing.
    if (!before) return snapshotToEntries(after.players, after.players, 0);
    if (!after) return snapshotToEntries(before.players, before.players, 0);

    const span = Math.max(after.at - before.at, 1e-6);
    const alpha = Math.min(1, Math.max(0, (atMs - before.at) / span));
    return snapshotToEntries(before.players, after.players, alpha);
  }
}

/** Turns a bone by `angle` about an axis given in world space. */
function rotateWorld(bone, axis, angle) {
  if (!bone || angle === 0) return;
  bone.getWorldQuaternion(_qWorld);
  _q.setFromAxisAngle(axis, angle);
  _qWorld.premultiply(_q);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qParent);
    _qWorld.premultiply(_qParent.invert());
  }
  bone.quaternion.copy(_qWorld);
  bone.updateMatrixWorld(true);
}

/**
 * Two-bone IK: bends the elbow and swings the shoulder so the hand reaches
 * `target`, with the elbow turned toward `pole`.
 *
 * Analytic rather than iterative - the law of cosines gives the elbow angle
 * in one step - so it costs the same every frame and cannot fail to settle.
 * A target out of reach leaves the arm straight and pointing at it.
 */
function solveArm(upper, lower, hand, target, pole) {
  if (!upper || !lower || !hand) return;
  upper.getWorldPosition(_a);
  lower.getWorldPosition(_b);
  hand.getWorldPosition(_c);
  const upperLength = _a.distanceTo(_b);
  const lowerLength = _b.distanceTo(_c);
  const reach = Math.min(
    Math.max(_a.distanceTo(target), 1e-3),
    upperLength + lowerLength - 1e-3,
  );

  // 1. The elbow, to the angle that makes the arm exactly this long.
  _d.subVectors(_a, _b).normalize();
  _e.subVectors(_c, _b).normalize();
  const current = Math.acos(Math.max(-1, Math.min(1, _d.dot(_e))));
  const wanted = Math.acos(Math.max(-1, Math.min(1,
    (upperLength * upperLength + lowerLength * lowerLength - reach * reach) /
      (2 * upperLength * lowerLength))));
  _axis.crossVectors(_d, _e);
  if (_axis.lengthSq() < 1e-10) _axis.set(1, 0, 0);
  rotateWorld(lower, _axis.normalize(), current - wanted);

  // 2. The shoulder, so the hand points at the target.
  hand.getWorldPosition(_c);
  _d.subVectors(_c, _a).normalize();
  _e.subVectors(target, _a).normalize();
  _axis.crossVectors(_d, _e);
  const swing = Math.acos(Math.max(-1, Math.min(1, _d.dot(_e))));
  if (_axis.lengthSq() > 1e-10) rotateWorld(upper, _axis.normalize(), swing);

  // 3. Round the shoulder-to-target line, so the elbow is on the pole's side.
  lower.getWorldPosition(_b);
  _axis.subVectors(target, _a).normalize();
  _d.subVectors(_b, _a);
  _d.addScaledVector(_axis, -_d.dot(_axis));
  _e.subVectors(pole, _a);
  _e.addScaledVector(_axis, -_e.dot(_axis));
  if (_d.lengthSq() > 1e-10 && _e.lengthSq() > 1e-10) {
    _d.normalize();
    _e.normalize();
    const twist = Math.atan2(_c.crossVectors(_d, _e).dot(_axis), _d.dot(_e));
    rotateWorld(upper, _axis, twist);
  }
}

function pickGait(speed, onGround) {
  if (!onGround) return 'air';
  if (speed < IDLE_SPEED) return 'idle';
  if (speed < RUN_SPEED) return 'walk';
  return 'run';
}

function playbackRate(gait, speed) {
  if (gait === 'idle' || gait === 'air') return 1;
  const reference = gait === 'run' ? RUN_REFERENCE : WALK_REFERENCE;
  return Math.min(MAX_PLAYBACK, Math.max(MIN_PLAYBACK, speed / reference));
}

/**
 * Blends two snapshots into render-ready entries.
 *
 * Position, yaw and pitch are interpolated; speed and ground contact are taken
 * from the newer snapshot rather than blended, because they choose which clip
 * plays and half way between standing and running is not a gait.
 */
function snapshotToEntries(older, newer, alpha) {
  const byId = new Map(newer.map((p) => [p.id, p]));
  const entries = [];

  for (const old of older) {
    const fresh = byId.get(old.id) ?? old;
    const a = old.state;
    const b = fresh.state;
    const velocity = b.velocity;
    entries.push({
      id: old.id,
      x: a.position[0] + (b.position[0] - a.position[0]) * alpha,
      y: a.position[1] + (b.position[1] - a.position[1]) * alpha,
      z: a.position[2] + (b.position[2] - a.position[2]) * alpha,
      yaw: lerpAngle(a.yaw, b.yaw, alpha),
      pitch: a.pitch + (b.pitch - a.pitch) * alpha,
      vx: velocity[0],
      vz: velocity[2],
      speed: Math.hypot(velocity[0], velocity[2]),
      onGround: b.on_ground,
      health: b.health,
    });
    byId.delete(old.id);
  }

  // Players present only in the newer snapshot still need to exist, or someone
  // joining is invisible for a moment.
  for (const fresh of byId.values()) {
    const s = fresh.state;
    entries.push({
      id: fresh.id,
      x: s.position[0],
      y: s.position[1],
      z: s.position[2],
      yaw: s.yaw,
      pitch: s.pitch,
      vx: s.velocity[0],
      vz: s.velocity[2],
      speed: Math.hypot(s.velocity[0], s.velocity[2]),
      onGround: s.on_ground,
      health: s.health,
    });
  }

  return entries;
}
