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
// # How a soldier is posed
//
// The model is a Mixamo special-forces character with four rifle clips -
// idle, run, fire and death - built by `scripts/build-soldier.sh`. Each is
// split in two at load: the legs and hips, and everything from the spine up.
//
//   legs     idle or run by speed (walking is the run, slower), turned up to
//            70 degrees toward the way the player moves, and the run played
//            backwards when backing off. The spine turns back the other way,
//            so the chest keeps facing where they aim.
//   upper    the shouldered pose from the first frame of the fire clip, held,
//            with a little of the run's arm swing at a sprint; the whole fire
//            clip plays over it on each shot.
//   aim      a constraint, not a lean. After the clips have posed the body,
//            the line from the right palm to the left is measured, and the
//            spine is turned by exactly the rotation that takes it onto the
//            player's yaw and pitch - split over three bones so the back
//            bends rather than hinges. It serves the legs as well: turning
//            them toward a strafe turns the hands, and the constraint turns
//            them back.
//   rifle    not parented to a bone. Every frame it is put in the right palm
//            and laid along the aim, so it points exactly where the player is
//            looking and the left hand is on it.
//   death    the death clip, once, and the body left where it fell.
//
// Players far away are animated less often: at sixty metres nobody can see a
// hand, and a browser has other players to draw.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { SIM, lerpAngle, wrapAngle } from './sim.js';
import { flashTexture } from './viewmodel.js';

/** Clip names as `scripts/build-soldier.mjs` writes them. */
const CLIP = { idle: 'idle', run: 'run', fire: 'fire', death: 'death' };

/** Below this a player is standing still, comfortably above the residual
 *  velocity friction leaves behind so idle legs do not twitch. */
const IDLE_SPEED = 0.6;

/** Where walking becomes running. */
const RUN_SPEED = 4.2;

/** Ground speeds the run clip looks right at: Mixamo's rifle run covers
 *  3.1 m/s with the root motion left in, and a walk is the same clip slower.
 *  Playback is scaled around these so feet slide less at other speeds. */
const WALK_REFERENCE = 2.4;
const RUN_REFERENCE = 4.6;
const MIN_PLAYBACK = 0.6;
const MAX_PLAYBACK = 1.8;

/** Cross-fade between gaits. Leaving the ground is abrupt in a way walking to
 *  running is not, so it gets a shorter one. */
const BLEND_SECONDS = 0.18;
const BLEND_AIR_SECONDS = 0.08;

/** How much snapshot history to keep - comfortably more than the interpolation
 *  delay, so a burst of late packets still has something to work from. */
const HISTORY_MS = 2000;

/** The model faces +Z; yaw 0 in this game looks down -Z. Without this the
 *  soldier runs backwards. */
const MODEL_FACING_OFFSET = Math.PI;

/** The rig's bones, as three.js names them: it drops the colon from
 *  Mixamo's "mixamorig:Hips". */
const BONE = {
  hips: 'mixamorigHips',
  spine: 'mixamorigSpine',
  spine1: 'mixamorigSpine1',
  spine2: 'mixamorigSpine2',
  neck: 'mixamorigNeck',
  handR: 'mixamorigRightHand',
  palmR: 'mixamorigRightHandMiddle1',
  handL: 'mixamorigLeftHand',
  palmL: 'mixamorigLeftHandMiddle1',
};

/** Tracks from the spine up belong to the upper body; the rest - hips and
 *  legs - to the lower. */
const UPPER = /Spine|Neck|Head|Shoulder|Arm|Hand/;

/** The rifle: metres per model unit (4.4 units nose to stock), and where
 *  the right palm closes on it and the muzzle is, in the model's units. */
const RIFLE = {
  scale: 0.19,
  grip: new THREE.Vector3(0, -0.3, 0.62),
  muzzle: new THREE.Vector3(0, 0.065, -2.306),
};

/** How far the legs turn toward the way a player is moving, and how fast. */
const LEG_TURN_LIMIT = 1.22;
const LEG_TURN_RATE = 10;

/** Shares of the aim correction taken by each spine bone. They sum to one,
 *  so the hands end up pointing exactly along the aim. */
const TWIST = { spine: 0.3, spine1: 0.3, spine2: 0.4 };

/** The most the spine is ever turned to meet the aim. Beyond this a pose is
 *  not one the constraint should rescue - a body mid-fall, say. */
const MAX_TWIST = 1.6;

/** How far from wrist to knuckles the palm's centre is, as a fraction. The
 *  hand closes round the rifle there, not at the wrist bone. */
const PALM = 0.7;

/** How much of the run's own arm swing shows at a sprint. */
const RUN_SWING = 0.3;

const FLASH_SECONDS = 0.05;
const LAND_DIP = 0.03;
const LAND_RECOVERY = 9;
/** The death clip is 3.8 s; the body stays down a little after it. */
const DEATH_LINGER_SECONDS = 5;

/** Beyond these, animate less often. */
const NEAR = 35;
const FAR = 70;

// Scratch objects, reused every frame so posing a crowd allocates nothing.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _twist = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _inverse = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qWorld = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/** A copy of `clip` with only the tracks `keep` accepts. */
function split(clip, name, keep) {
  const tracks = clip.tracks.filter((track) => keep(track.name.split('.')[0]));
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

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
   * The viewmodel needs the same rifle, and fetching its geometry twice
   * because two modules each asked for it is the kind of waste that is
   * invisible on localhost and expensive on a real connection.
   */
  async load(soldierUrl, weapon) {
    const soldier = await new GLTFLoader().loadAsync(soldierUrl);
    this.template = soldier.scene;
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

    const find = (name) => {
      const clip = THREE.AnimationClip.findByName(soldier.animations, name);
      if (!clip) throw new Error(`the soldier has no ${name} clip`);
      return clip;
    };
    const upper = (bone) => UPPER.test(bone);
    const lower = (bone) => !UPPER.test(bone);
    const fire = find(CLIP.fire);
    this.clips = {
      idle: split(find(CLIP.idle), 'idle-legs', lower),
      run: split(find(CLIP.run), 'run-legs', lower),
      // The first frame of the shot: rifle shouldered, looking down it.
      aim: split(THREE.AnimationUtils.subclip(fire, 'aim', 0, 1, 30), 'aim', upper),
      swing: split(find(CLIP.run), 'run-arms', upper),
      fire: split(fire, 'fire-arms', upper),
      death: find(CLIP.death),
    };
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
    if (!player || player.diedAt !== null) return;
    player.actions.fire.reset().play();
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
    // little further for the legs.
    const root = new THREE.Group();
    const body = cloneSkinned(this.template);
    root.add(body);
    this.scene.add(root);

    const mixer = new THREE.AnimationMixer(body);
    const action = (clip, loop = true) => {
      const a = mixer.clipAction(clip);
      if (loop) {
        a.setLoop(THREE.LoopRepeat, Infinity);
      } else {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      return a;
    };
    const actions = {
      idle: action(this.clips.idle),
      run: action(this.clips.run),
      aim: action(this.clips.aim),
      swing: action(this.clips.swing),
      fire: action(this.clips.fire, false),
      death: action(this.clips.death, false),
    };
    actions.idle.play();
    actions.aim.play();
    actions.swing.play();
    actions.swing.setEffectiveWeight(0);

    const bones = {};
    for (const [key, name] of Object.entries(BONE)) bones[key] = body.getObjectByName(name);
    // The hips move in their parent's units, which for a Mixamo rig is not
    // metres; a dip in metres is divided by this.
    const hipsScale = bones.hips?.parent
      ? bones.hips.parent.getWorldScale(new THREE.Vector3()).y || 1
      : 1;

    // The rifle, placed each frame from the hands rather than parented to
    // one of them.
    const rifle = new THREE.Group();
    rifle.matrixAutoUpdate = false;
    root.add(rifle);
    if (this.weapon) {
      // A copy of the first-person rifle, which carries that rig's own
      // offset and scale. Those are dropped: this one is placed and sized
      // here, and inheriting them is what once made it a toy.
      const copy = this.weapon.clone(true);
      copy.position.set(0, 0, 0);
      copy.rotation.set(0, 0, 0);
      copy.scale.setScalar(1);
      rifle.add(copy);
    }
    const muzzle = new THREE.Object3D();
    muzzle.position.copy(RIFLE.muzzle);
    rifle.add(muzzle);
    const flashSprite = new THREE.Sprite(this.flashMaterial.clone());
    flashSprite.scale.setScalar(0.35 / RIFLE.scale);
    flashSprite.visible = false;
    muzzle.add(flashSprite);

    return {
      id, root, body, mixer, actions, bones, rifle, flashSprite, hipsScale,
      gait: 'idle',
      legYaw: 0,
      reverse: false,
      flash: 0,
      dip: 0,
      wasOnGround: true,
      diedAt: null,
      age: 0,
      pending: 0,
      frame: 0,
    };
  }

  _pose(player, entry, dt, eye) {
    player.age += dt;
    const { root, body, actions } = player;
    root.position.set(entry.x, entry.y - SIM.halfExtentY, entry.z);
    root.rotation.y = entry.yaw + MODEL_FACING_OFFSET;

    // Dead: the death clip once, the body left where it fell for a while,
    // then gone. A body that vanished the instant it was hit read as the
    // player disconnecting.
    if (entry.health <= 0) {
      if (player.diedAt === null) {
        player.diedAt = player.age;
        for (const [name, a] of Object.entries(actions)) {
          if (name !== 'death') a.fadeOut(0.12);
        }
        actions.death.reset().fadeIn(0.12).play();
        player.rifle.visible = false;
        player.flashSprite.visible = false;
        body.rotation.y = 0;
      }
      root.visible = player.age - player.diedAt < DEATH_LINGER_SECONDS;
      player.mixer.update(dt);
      return;
    }
    if (player.diedAt !== null) {
      player.diedAt = null;
      actions.death.stop();
      for (const name of ['aim', 'swing']) actions[name].reset().play();
      actions[player.gait]?.reset().play();
      player.rifle.visible = true;
    }
    root.visible = true;

    const distance = eye ? root.position.distanceTo(eye) : 0;

    // Fewer mixer updates the further away they are: every frame near,
    // every other frame at middle distance, every fourth far away. The time
    // is saved up rather than dropped, so the clips stay in step.
    player.pending += dt;
    const every = distance > FAR ? 4 : distance > NEAR ? 2 : 1;
    player.frame += 1;
    if (player.frame % every !== 0) return;
    const step = player.pending;
    player.pending = 0;

    this._driveLegs(player, entry, step);
    this._driveArms(player, entry);
    player.mixer.update(step);

    const bones = player.bones;
    body.updateMatrixWorld(true);

    // The hands onto the aim.
    aimVector(entry.yaw, entry.pitch, _aim);
    this._aimSpine(player, _aim);

    // A dip in the hips when they come down.
    if (entry.onGround && !player.wasOnGround) player.dip = LAND_DIP;
    player.wasOnGround = entry.onGround;
    player.dip += (0 - player.dip) * (1 - Math.exp(-LAND_RECOVERY * step));
    if (bones.hips && player.dip > 1e-4) {
      bones.hips.position.y -= player.dip / player.hipsScale;
      bones.hips.updateMatrixWorld(true);
    }

    this._placeRifle(player, _aim);
    player.flash = Math.max(0, player.flash - step);
    player.flashSprite.visible = player.flash > 0 && distance < FAR;
  }

  /** Where the palms are, into `right` and `left`. */
  _palms(player, right, left) {
    const { bones } = player;
    bones.handR.getWorldPosition(right);
    if (bones.palmR) right.lerp(bones.palmR.getWorldPosition(_c), PALM);
    bones.handL.getWorldPosition(left);
    if (bones.palmL) left.lerp(bones.palmL.getWorldPosition(_c), PALM);
  }

  /**
   * Turns the spine so the hands point along `aim`.
   *
   * The rotation from where the clip left the hands pointing to where the
   * player is aiming, applied in world space in three shares down the spine.
   * Every share turns everything above it, so the three together turn the
   * hands by the whole rotation, and the direction between them lands on the
   * aim exactly.
   */
  _aimSpine(player, aim) {
    const { bones } = player;
    if (!bones.handR || !bones.handL || !bones.spine) return;
    this._palms(player, _a, _b);
    _c.subVectors(_b, _a);
    if (_c.lengthSq() < 1e-8) return;
    _twist.setFromUnitVectors(_c.normalize(), aim);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(_twist.w)));
    if (angle < 1e-4 || angle > MAX_TWIST) return;
    const sign = _twist.w < 0 ? -1 : 1;
    _axis.set(_twist.x * sign, _twist.y * sign, _twist.z * sign).normalize();
    rotateWorld(bones.spine, _axis, angle * TWIST.spine);
    rotateWorld(bones.spine1, _axis, angle * TWIST.spine1);
    rotateWorld(bones.spine2, _axis, angle * TWIST.spine2);
  }

  /** The rifle in the right palm, laid along the aim. */
  _placeRifle(player, aim) {
    const { bones, rifle, root } = player;
    if (!bones.handR || !bones.handL) return;
    this._palms(player, _a, _b);

    // The model's muzzle is down its -Z, so +Z is back along the aim. Up is
    // the world's, squared off against that.
    _z.copy(aim).negate();
    _y.copy(_up).addScaledVector(_z, -_up.dot(_z)).normalize();
    _x.crossVectors(_y, _z);
    _m.makeBasis(_x, _y, _z);
    _m.scale(_c.setScalar(RIFLE.scale));
    // Grip on the right palm.
    _c.copy(RIFLE.grip).applyMatrix4(_m);
    _m.setPosition(_a.sub(_c));

    root.updateMatrixWorld(true);
    _inverse.copy(root.matrixWorld).invert();
    rifle.matrix.multiplyMatrices(_inverse, _m);
    rifle.matrixWorldNeedsUpdate = true;
  }

  _driveArms(player, entry) {
    // The shouldered pose, with a little of the run's own arm swing at a
    // sprint, and the shot over both while it plays.
    const { aim, swing, fire } = player.actions;
    const sprint = entry.onGround
      ? Math.min(1, Math.max(0, (entry.speed - RUN_SPEED) / 3)) * RUN_SWING
      : 0;
    const firing = fire.isRunning() ? 1 : 0;
    aim.setEffectiveWeight((1 - sprint) * (1 - firing));
    swing.setEffectiveWeight(sprint * (1 - firing));
    swing.setEffectiveTimeScale(player.actions.run.getEffectiveTimeScale());
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
        // Backing off: face the legs the other way and play the stride in
        // reverse, rather than turning them round to run away.
        reverse = true;
        angle = wrapAngle(angle - Math.PI);
      }
      target = Math.max(-LEG_TURN_LIMIT, Math.min(LEG_TURN_LIMIT, angle));
    }
    player.legYaw += (target - player.legYaw) * (1 - Math.exp(-LEG_TURN_RATE * dt));
    player.body.rotation.y = player.legYaw;
    player.reverse = reverse;

    // Walking and running are both the run clip; in the air the legs hold
    // the idle stance.
    const gait = pickGait(entry.speed, entry.onGround);
    const clip = gait === 'walk' || gait === 'run' ? 'run' : 'idle';
    const action = player.actions[clip];
    if (clip !== player.gait) {
      const previous = player.actions[player.gait];
      const blend = gait === 'air' ? BLEND_AIR_SECONDS : BLEND_SECONDS;
      action.reset().play();
      if (previous && previous !== action) previous.crossFadeTo(action, blend, false);
      player.gait = clip;
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

/** The unit vector a player with this yaw and pitch is looking along - the
 *  inverse of what the drivers compute from a look direction. */
function aimVector(yaw, pitch, out) {
  const flat = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * flat, Math.sin(pitch), -Math.cos(yaw) * flat);
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
