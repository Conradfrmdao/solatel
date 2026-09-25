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

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { SIM, lerpAngle } from './sim.js';

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

/** The bone the weapon hangs off, and how big it is held. */
const WEAPON_BONE = 'hand_R_022';
const WEAPON_SCALE = 0.19;

/** The model faces +Z; yaw 0 in this game looks down -Z. Without this the
 *  soldier runs backwards. */
const MODEL_FACING_OFFSET = Math.PI;

export class Remotes {
  constructor(scene) {
    this.scene = scene;
    this.template = null;
    this.weapon = null;
    this._weaponOnBone = null;
    this.players = new Map();
    this.history = [];
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

    this._weaponOnBone = this._solveWeaponTransform();
    return this.template;
  }

  /**
   * Works out where the rifle sits on the hand bone, rather than guessing it.
   *
   * The transform wanted is "in the hand, pointing where the character points",
   * and that is easy to state in the model's own space and awkward to state in
   * a bone's. So it is stated in model space and then pushed through the
   * inverse of the bone's bind-pose matrix, which is the transform that would
   * have produced it. Six hand-tuned numbers would have needed a person and
   * several rebuilds to land; this needs neither and is right the first time.
   */
  _solveWeaponTransform() {
    this.template.updateMatrixWorld(true);
    const bone = this.template.getObjectByName(WEAPON_BONE);
    if (!bone) {
      console.warn(`no bone named ${WEAPON_BONE}; the weapon will not be held`);
      return null;
    }

    const modelInverse = this.template.matrixWorld.clone().invert();
    const boneInModel = modelInverse.clone().multiply(bone.matrixWorld);

    // Where the hand is, in the model's own space.
    const handPosition = new THREE.Vector3().setFromMatrixPosition(boneInModel);

    // The character faces +Z in its own space and the rifle's muzzle points
    // down -Z in its own, so the weapon is turned to face the way its owner
    // does. The small offsets push it out of the palm and forward of the wrist.
    const desired = new THREE.Matrix4().compose(
      handPosition.clone().add(new THREE.Vector3(-0.02, -0.03, 0.12)),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, Math.PI, 0, 'YXZ'),
      ),
      new THREE.Vector3(WEAPON_SCALE, WEAPON_SCALE, WEAPON_SCALE),
    );

    return boneInModel.invert().multiply(desired);
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

  /**
   * Places and animates every other player for this frame.
   *
   * `selfId` is skipped: you do not see your own body in first person, and
   * drawing it would put a shoulder through the camera.
   */
  update(nowMs, dt, selfId) {
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

      player.root.position.set(entry.x, entry.y - SIM.halfExtentY, entry.z);
      player.root.rotation.y = entry.yaw + MODEL_FACING_OFFSET;
      player.root.visible = entry.health > 0;

      this._driveGait(player, entry, dt);
      player.mixer.update(dt);
    }

    for (const [id, player] of this.players) {
      if (seen.has(id)) continue;
      this.scene.remove(player.root);
      this.players.delete(id);
    }
  }

  _spawn(id) {
    const root = cloneSkinned(this.template);
    this.scene.add(root);

    const mixer = new THREE.AnimationMixer(root);
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

    if (this.weapon && this._weaponOnBone) {
      const bone = root.getObjectByName(WEAPON_BONE);
      if (bone) {
        const weapon = this.weapon.clone(true);
        weapon.matrixAutoUpdate = false;
        weapon.matrix.copy(this._weaponOnBone);
        bone.add(weapon);
      }
    }

    return { id, root, mixer, actions, gait: 'idle' };
  }

  _driveGait(player, entry, dt) {
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
    action.setEffectiveTimeScale(playbackRate(gait, entry.speed));
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
 * Position and yaw are interpolated; speed and ground contact are taken from
 * the newer snapshot rather than blended, because they choose which clip plays
 * and half way between standing and running is not a gait.
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
      speed: Math.hypot(s.velocity[0], s.velocity[2]),
      onGround: s.on_ground,
      health: s.health,
    });
  }

  return entries;
}
