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
//   upper    two stances and the way between them. At rest the rifle is at
//            the low ready (`lowReady`): lowered across the body, muzzle
//            down and to the left, arms relaxed, over the idle clip's
//            breathing. Aiming (`PlayerSnapshot.aiming`), and on a shot and
//            for a moment after it, it comes up to the shoulder - the first
//            frame of the fire clip, with a little of the run's arm swing at
//            a sprint, and the whole fire clip over it on each shot. `raise`
//            eases between the two, quickly up and less quickly down.
//   aim      a constraint, not a lean. After the clips have posed the body,
//            the line from the right palm to the left is measured, and the
//            spine is turned - about the vertical, then about the level -
//            until it points exactly where the rifle should: along the
//            player's yaw and pitch when raised, at the low ready's angle to
//            them when not. Split over three bones so the back bends rather
//            than hinges, and it serves the legs as well: turning them toward
//            a strafe turns the hands, and the constraint turns them back.
//            At the low ready the head takes most of the pitch, so where
//            somebody is looking still shows.
//   rifle    not parented to a bone. Every frame it is put in the right palm
//            and laid along that line, so raised it points exactly where the
//            player is looking, and either way the left hand is on it.
//   death    the death clip, once, and the body left where it fell.
//
// Players far away are animated less often: at sixty metres nobody can see a
// hand, and a browser has other players to draw.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';
import { SIM, lerpAngle, wrapAngle } from './sim.js';
import { flashTexture } from './viewmodel.js';
import { HAND, holdMatrix, palms } from './grip.js';
import { RIFLE as WEAPON } from './weapons.js';
import { lightMaterial } from './light.js';
import { SnapshotClock } from './snapclock.js';

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

/** How much snapshot history to keep, in the server's milliseconds -
 *  comfortably more than the interpolation delay, so a burst of late packets
 *  still has something to work from. */
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
  head: 'mixamorigHead',
  upLegL: 'mixamorigLeftUpLeg',
  legL: 'mixamorigLeftLeg',
  footL: 'mixamorigLeftFoot',
  upLegR: 'mixamorigRightUpLeg',
  legR: 'mixamorigRightLeg',
  footR: 'mixamorigRightFoot',
  armL: 'mixamorigLeftArm',
  foreArmL: 'mixamorigLeftForeArm',
  ...HAND,
};

/**
 * Bones posed by hand after the clips have posed them: aimed, knelt, dipped
 * or reached with. Their clip values are put back before the clips are
 * sampled again, because three.js's mixer only writes a bone whose sampled
 * value has changed - and the shouldered pose is a single still frame, so a
 * hand-posed arm on it would keep last frame's posing and build on it. That
 * left an arm at the magazine after a reload, and the aim then turned the
 * whole torso to put the hands back on a rifle the arm was no longer on.
 */
const POSED = [
  'hips', 'spine', 'spine1', 'spine2', 'neck', 'head',
  'upLegL', 'legL', 'footL', 'upLegR', 'legR', 'footR',
  'armL', 'foreArmL', 'handL',
];

/** Tracks from the spine up belong to the upper body; the rest - hips and
 *  legs - to the lower. */
const UPPER = /Spine|Neck|Head|Shoulder|Arm|Hand/;

/** The rifle: metres per model unit (4.4 units nose to stock), and where
 *  the muzzle is, in the model's units. Where the hand closes on it is in
 *  `grip.js`, shared with the first-person arms. */
const RIFLE = {
  scale: 0.19,
  muzzle: new THREE.Vector3(0, 0.065, -2.306),
};

/** Where the magazine sits, in the rifle model's units: under the receiver
 *  just ahead of the grip. A reload takes the left hand there. */
const MAGAZINE = new THREE.Vector3(0, -0.62, 0.1);

/** A reload as the body shows it: the rifle canted over and dipped, so the
 *  magazine well faces the hand that is changing it. Radians. */
const RELOAD_CANT = 0.65;
const RELOAD_DIP = 0.4;

/** A throw as the body shows it, and how long it takes. Nobody is told who
 *  threw a grenade; one appearing at a player's hand says it. */
const THROW_SECONDS = 0.7;
const THROW_DIP = 0.95;
const THROW_REACH = 3;

/** How far the legs turn toward the way a player is moving, and how fast. */
const LEG_TURN_LIMIT = 1.22;
const LEG_TURN_RATE = 10;

/** Shares of the aim correction taken by each spine bone, and of the look
 *  by the neck and the head. Each sums to one, so the hands end up pointing
 *  exactly along the aim and the face exactly along the look. */
const SPINE = [['spine', 0.3], ['spine1', 0.3], ['spine2', 0.4]];
const NECK = [['neck', 0.4], ['head', 0.6]];

/** The most the spine is ever turned to meet the aim, or the neck to meet
 *  the look, about either axis. A pose that would need more - a body
 *  mid-fall, say - is turned this far and no further. */
const MAX_TWIST = 1.6;

/** How much of the run's own arm swing shows at a sprint, aiming. */
const RUN_SWING = 0.3;

/**
 * The low ready: where the rifle is when it is not being aimed, as the
 * player stands - this far round to their left of where they face and this
 * far below level, in radians - and how much of their pitch it follows; the
 * head takes the rest, so where they look still shows. `grip` moves the
 * right hand from where the idle clip has it, in metres in the soldier's
 * own frame (x is their left, z ahead of them).
 */
const READY = { across: 0.95, down: 0.5, follow: 0.3, grip: [0, -0.02, 0.04] };

/** How long the rifle takes to come up, aiming and on a shot fired from
 *  the low ready, and to go down again: time constants, in seconds. A shot
 *  brings it up fastest, because the round has already left. */
const RAISE_TIME = 0.08;
const RAISE_SHOT_TIME = 0.03;
const LOWER_TIME = 0.25;

/** How long after the last shot the rifle stays at the shoulder. */
const RAISED_AFTER_SHOT = 1.4;

/** How far up a reload brings the rifle: changing a magazine is done in
 *  front of the chest, not at the belt. */
const RELOAD_RAISE = 0.5;

/** How quickly the fire clip gives way when it ends, in seconds. */
const FIRE_BLEND = 0.06;

/** How far up the rifle has to be before a shot's flash shows at its
 *  muzzle: a shot from the low ready flashes when the rifle reaches the
 *  shoulder, a few hundredths of a second later, not on the way up. */
const FLASH_RAISED = 0.7;

/** Where the muzzle is with the rifle at the shoulder, from the eye the
 *  server shoots from, in metres along the aim, below it and to the right -
 *  measured off the posed soldier, which brings it nearer the eye the
 *  higher it aims (`perPitch`, a metre per radian) and holds it closer
 *  under the eye kneeling. A tracer from a shot fired at the low ready
 *  leaves from here: the rifle is on its way up, and the round left from
 *  where it is going. */
const SHOULDER_MUZZLE = { forward: 0.8, perPitch: 0.48, down: 0.3, downKneeling: 0.15, right: 0.28 };

const FLASH_SECONDS = 0.05;
const LAND_DIP = 0.03;
const LAND_RECOVERY = 9;
/** The death clip is 3.8 s; the body stays down a little after it. */
const DEATH_LINGER_SECONDS = 5;

/** How far the hips come down walking crouched, in metres. Kneeling they
 *  come down as far as it takes to put a knee on the floor. */
const CROUCH_WALK_DROP = 0.38;
/** The knee's own thickness, between the bone and the floor. */
const KNEE_PAD = 0.07;
/** How far ahead of its hip the planted foot goes, kneeling. */
const LEAD_FOOT_AHEAD = 0.42;
/** How far the trailing foot is pitched onto its toes, in radians. */
const TOE_TUCK = -1.0;
/** How quickly the body goes down and comes up, per second. */
const CROUCH_RATE = 12;

/** Beyond these, animate less often. */
const NEAR = 35;
const FAR = 70;

/**
 * Fewer triangles the further away a player is.
 *
 * The soldier is 34,000 triangles and the rifle 5,500, which is right at
 * arm's length and a waste at forty metres, where the whole player is a few
 * dozen pixels tall: a full match drawn at full detail was most of a frame's
 * triangles. Each level is the same mesh with fewer triangles (meshoptimizer,
 * at load), never further from the full shape than `error` of its size - a
 * couple of pixels where it is first used - so nobody is any harder or easier
 * to see. Every player is drawn the same way, at every graphics level.
 */
const DETAIL = [
  { beyond: 0, keep: 1, error: 0 },
  { beyond: 15, keep: 0.3, error: 0.015 },
  { beyond: 40, keep: 0.1, error: 0.04 },
];

/**
 * How far an animated player reaches past the soldier at rest, as a multiple
 * of its resting bounds - lying dead, or a rifle at full stretch.
 *
 * Their bodies were never culled, because bounds taken from the resting pose
 * lost players at the edge of the screen when a clip carried them outside.
 * Never culled, every player in the match was drawn every frame, and drawn
 * again into the shadow map, behind the camera or across the map alike. A
 * sphere this generous never loses anybody and still culls almost everybody
 * out of view.
 */
const POSE_REACH = 2.5;

/** Each geometry's levels of detail, full first (see `DETAIL`). */
const DETAILS = new WeakMap();

/** A sphere round a player's feet that holds all of them, for asking
 *  whether they are in view. */
const SEEN_RADIUS = 2.5;

/** Builds `geometry`'s levels of detail, sharing its vertices: each level is
 *  only a shorter list of triangles, so a skinned mesh keeps its skin. */
function detailed(geometry) {
  if (DETAILS.has(geometry) || !geometry.index) return;
  const position = geometry.attributes.position;
  const points = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 1) {
    points[i * 3] = position.getX(i);
    points[i * 3 + 1] = position.getY(i);
    points[i * 3 + 2] = position.getZ(i);
  }
  const full = Uint32Array.from(geometry.index.array);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  const levels = [geometry];
  for (const { keep, error } of DETAIL.slice(1)) {
    const target = Math.max(3, Math.floor((full.length * keep) / 3) * 3);
    const [indices] = MeshoptSimplifier.simplify(full, points, 3, target, error);
    const level = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) level.setAttribute(name, attribute);
    level.setIndex(new THREE.BufferAttribute(position.count < 65536 ? Uint16Array.from(indices) : indices, 1));
    level.boundingSphere = geometry.boundingSphere;
    level.boundingBox = geometry.boundingBox;
    levels.push(level);
  }
  DETAILS.set(geometry, levels);
}

/** Which level of detail to draw at `distance`, given the one drawn now: a
 *  metre either side of an edge stays where it is, so a player standing on
 *  one does not flicker between two. */
function detailFor(distance, current) {
  let level = 0;
  for (let i = 1; i < DETAIL.length; i += 1) {
    if (distance >= DETAIL[i].beyond + (i <= current ? -1 : 1)) level = i;
  }
  return level;
}

// Scratch objects, reused every frame so posing a crowd allocates nothing.
const _seen = new THREE.Sphere();
const _view = new THREE.Matrix4();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _rifleDir = new THREE.Vector3();
const _twist = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _inverse = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qWorld = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _hip = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _foot = new THREE.Vector3();
const _goal = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _newKnee = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _qTurn = new THREE.Quaternion();
const _qFoot = new THREE.Quaternion();
const _goalL = new THREE.Vector3();
const _goalR = new THREE.Vector3();
const _kneelL = new THREE.Vector3();
const _kneelR = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _aimR = new THREE.Vector3();
const _upR = new THREE.Vector3();
const _hand = new THREE.Vector3();
const _lift = new THREE.Vector3();
const _mag = new THREE.Vector3();
const _pouch = new THREE.Vector3();
const _shoulder = new THREE.Vector3();
const _reach = new THREE.Vector3();

/** Smoothstep on [0, 1]. */
const ease = (t) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

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
    /** Which way the face looks, in the head bone's frame (see `load`). */
    this.face = null;
    this.players = new Map();
    /** Snapshots by the server time they were taken at, oldest first. */
    this.history = [];
    /** Which moment of the server's clock to draw. */
    this.clock = new SnapshotClock(SIM.interpolationDelayMs);
    /** Grenades in the last snapshot, to tell a new one from one in flight. */
    this._grenades = null;
    /** Who has just thrown one, by id, waiting to be posed. */
    this.throws = new Map();
    /** Where reloads started this frame, for the sound. */
    this.reloads = [];
    this.selfId = null;
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
    // Which way the face looks, in the head bone's own frame: the soldier
    // is loaded at rest, facing +Z.
    const head = this.template.getObjectByName(BONE.head);
    if (head) {
      this.template.updateMatrixWorld(true);
      this.face = new THREE.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()).invert());
    }

    await MeshoptSimplifier.ready;
    this.template.traverse((node) => {
      if (node.isMesh || node.isSkinnedMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        // Culled by bounds that reach as far as any pose does (see
        // `POSE_REACH`); the copies made for each player take these.
        if (node.isSkinnedMesh) {
          node.geometry.computeBoundingSphere();
          node.boundingSphere = node.geometry.boundingSphere.clone();
          node.boundingSphere.radius *= POSE_REACH;
          node.frustumCulled = true;
        }
        detailed(node.geometry);
        // Lit by the map's light, so a soldier in a dark room is in the dark.
        for (const material of [node.material].flat()) lightMaterial(material);
      }
    });
    // The rifle in somebody else's hands is lit by the map as they are. The
    // one in the player's own hands is drawn in a scene of its own, lit its
    // own way, so this is a copy with copies of its materials.
    const copies = new Map();
    const lit = (material) => {
      if (!copies.has(material)) copies.set(material, lightMaterial(material.clone()));
      return copies.get(material);
    };
    this.weapon = weapon.clone(true);
    this.weapon.traverse((node) => {
      if (!node.isMesh) return;
      node.castShadow = true;
      node.material = Array.isArray(node.material) ? node.material.map(lit) : lit(node.material);
      detailed(node.geometry);
    });

    const find = (name) => {
      const clip = THREE.AnimationClip.findByName(soldier.animations, name);
      if (!clip) throw new Error(`the soldier has no ${name} clip`);
      return clip;
    };
    const upper = (bone) => UPPER.test(bone);
    const lower = (bone) => !UPPER.test(bone);
    const fire = find(CLIP.fire);
    // The first frame of the shot: rifle shouldered, looking down it.
    const aim = split(THREE.AnimationUtils.subclip(fire, 'aim', 0, 1, 30), 'aim', upper);
    this.clips = {
      idle: split(find(CLIP.idle), 'idle-legs', lower),
      run: split(find(CLIP.run), 'run-legs', lower),
      aim,
      ready: lowReady(this.template, find(CLIP.idle), aim),
      swing: split(find(CLIP.run), 'run-arms', upper),
      fire: split(fire, 'fire-arms', upper),
      death: find(CLIP.death),
    };
    return this.template;
  }

  /** What every other player in a match is drawn with - the soldier and
   *  the rifle every copy is made from - for compiling before the first of
   *  them appears (`prepareToDraw` in main.js). */
  get prototypes() {
    return [this.template, this.weapon].filter(Boolean);
  }

  /**
   * Records a snapshot for later interpolation, by when the server took it
   * rather than when it arrived (see `snapclock.js`).
   */
  record(snapshot, nowMs) {
    // The server restarted: what was kept is on a clock that no longer runs.
    if (this.clock.note(snapshot.server_time_ms, nowMs)) this.history.length = 0;
    const at = snapshot.server_time_ms;
    this.history.push({ at, players: snapshot.players });
    // A grenade that was not there last time has just left somebody's hand,
    // and the nearest pair of eyes is whose.
    const live = snapshot.live_grenades ?? [];
    if (this._grenades) {
      for (const grenade of live) {
        if (this._grenades.has(grenade.id)) continue;
        const thrower = nearestThrower(snapshot.players, grenade.position, this.selfId);
        if (thrower) this.throws.set(thrower, nowMs);
      }
    }
    this._grenades = new Set(live.map((g) => g.id));
    while (this.history.length > 0 && at - this.history[0].at > HISTORY_MS) {
      this.history.shift();
    }
  }

  /** The server says this player fired. */
  onShot(id) {
    const player = this.players.get(id);
    if (!player || player.diedAt !== null) return;
    // Up to the shoulder, and kept there a moment (see `RAISED_AFTER_SHOT`).
    player.shotAt = player.age;
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
  update(nowMs, dt, selfId, eye, camera) {
    this.selfId = selfId;
    if (!this.template) return;
    // What the camera saw last frame, near enough to say who is in view.
    if (camera) {
      this.view ??= new THREE.Frustum();
      this.view.setFromProjectionMatrix(
        _view.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      );
    }

    const renderAt = this.clock.drawAt(nowMs, dt * 1000);
    if (renderAt === null) return;
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

  /** Where a player's feet were as last drawn, or null if they are not. */
  positionOf(id) {
    return this.players.get(id)?.root.position ?? null;
  }

  /**
   * Where a player's muzzle was as last drawn, into `out`, or null if they
   * are not drawn. Everybody else is drawn an interpolation delay behind the
   * server, and a shot arrives the moment the server fires it, so a tracer
   * from the server's own `from` would leave a strafing shooter's rifle from
   * most of a metre away. Only the tracer is moved: where the round went is
   * the server's.
   */
  muzzleOf(id, out) {
    const player = this.players.get(id);
    if (!player || player.diedAt !== null || !player.root.visible) return null;
    if (player.raise >= FLASH_RAISED) return player.flashSprite.parent.getWorldPosition(out);
    aimVector(player.yaw, player.pitch, _fwd);
    _side.crossVectors(_fwd, _up).normalize();
    _lift.crossVectors(_side, _fwd);
    return out
      .copy(player.root.position)
      .addScaledVector(_up, player.eye)
      .addScaledVector(_fwd, SHOULDER_MUZZLE.forward - SHOULDER_MUZZLE.perPitch * player.pitch)
      .addScaledVector(_lift, -(player.kneeling ? SHOULDER_MUZZLE.downKneeling : SHOULDER_MUZZLE.down))
      .addScaledVector(_side, SHOULDER_MUZZLE.right);
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
      ready: action(this.clips.ready),
      aim: action(this.clips.aim),
      swing: action(this.clips.swing),
      fire: action(this.clips.fire, false),
      death: action(this.clips.death, false),
    };
    actions.idle.play();
    for (const name of ['ready', 'aim', 'swing', 'fire']) actions[name].play().setEffectiveWeight(0);
    actions.ready.setEffectiveWeight(1);
    // A fresh fire action would play its one shot now; it waits for one.
    actions.fire.stop();

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

    // Everything drawn of them that has levels of detail.
    const details = [];
    root.traverse((node) => {
      const levels = node.isMesh ? DETAILS.get(node.geometry) : null;
      if (levels) details.push({ mesh: node, levels });
    });

    // What the clips last said for each bone in `POSED`.
    const clean = POSED.map((key) => bones[key])
      .filter(Boolean)
      .map((bone) => ({ bone, q: bone.quaternion.clone(), p: bone.position.clone() }));

    return {
      id, root, body, mixer, actions, bones, rifle, flashSprite, hipsScale, clean, details,
      level: 0,
      gait: 'idle',
      legYaw: 0,
      reverse: false,
      flash: 0,
      dip: 0,
      crouch: 0,
      /** 0 at the low ready, 1 at the shoulder (see `_driveArms`). */
      raise: 0,
      shotAt: -Infinity,
      yaw: 0,
      pitch: 0,
      eye: 0,
      kneeling: false,
      /** How much of the fire clip shows, easing out when it ends. */
      firing: 0,
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
    // Where they look from, as drawn, for a tracer (see `muzzleOf`).
    player.yaw = entry.yaw;
    player.pitch = entry.pitch;
    player.eye = SIM.halfExtentY + (entry.crouched ? SIM.eyeOffset - SIM.crouchDrop : SIM.eyeOffset);
    player.kneeling = entry.crouched;

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
      for (const name of ['ready', 'aim', 'swing']) actions[name].reset().play();
      player.raise = 0;
      player.shotAt = -Infinity;
      actions[player.gait]?.reset().play();
      player.rifle.visible = true;
    }
    root.visible = true;

    // A reload starting is seen, and heard by anybody close enough.
    if (entry.reloading && !player.reloading) {
      player.reloadAt = player.age;
      this.reloads.push([entry.x, entry.y, entry.z]);
    }
    player.reloading = entry.reloading;
    if (this.throws.has(player.id)) {
      this.throws.delete(player.id);
      player.throwAt = player.age;
    }

    const distance = eye ? root.position.distanceTo(eye) : 0;

    // Fewer triangles further away (see `DETAIL`).
    const level = detailFor(distance, player.level);
    if (level !== player.level) {
      player.level = level;
      for (const d of player.details) d.mesh.geometry = d.levels[level];
    }

    // Fewer mixer updates the further away they are: every frame near,
    // every other frame at middle distance, every fourth far away - or out
    // of view, where only a shadow might show it. The time is saved up
    // rather than dropped, so the clips stay in step.
    player.pending += dt;
    const seen = !this.view || this.view.intersectsSphere(_seen.set(root.position, SEEN_RADIUS));
    const every = !seen || distance > FAR ? 4 : distance > NEAR ? 2 : 1;
    player.frame += 1;
    if (player.frame % every !== 0) return;
    const step = player.pending;
    player.pending = 0;

    this._driveLegs(player, entry, step);
    this._driveArms(player, entry, step);
    // Undo last frame's hand posing, sample the clips, and remember what
    // they said (see `POSED`).
    for (const c of player.clean) {
      c.bone.quaternion.copy(c.q);
      c.bone.position.copy(c.p);
    }
    player.mixer.update(step);
    for (const c of player.clean) {
      c.q.copy(c.bone.quaternion);
      c.p.copy(c.bone.position);
    }

    const bones = player.bones;
    body.updateMatrixWorld(true);

    // The hands onto where the rifle should point: the aim, the low ready,
    // or on the way between the two.
    aimVector(entry.yaw, entry.pitch, _aim);
    this._orient(player, entry, player.raise, _rifleDir);

    // Down on one knee: the hips lowered and each leg solved so its foot
    // stays where the clip put it, the trailing one drawn back.
    player.crouch += ((entry.crouched ? 1 : 0) - player.crouch) * (1 - Math.exp(-CROUCH_RATE * step));
    if (player.crouch > 0.01) this._kneel(player, entry, player.crouch);

    // A dip in the hips when they come down.
    if (entry.onGround && !player.wasOnGround) player.dip = LAND_DIP;
    player.wasOnGround = entry.onGround;
    player.dip += (0 - player.dip) * (1 - Math.exp(-LAND_RECOVERY * step));
    if (bones.hips && player.dip > 1e-4) {
      bones.hips.position.y -= player.dip / player.hipsScale;
      bones.hips.updateMatrixWorld(true);
    }

    this._act(player, entry, _aim, _rifleDir);
    // The flash waits for the rifle to reach the shoulder (`FLASH_RAISED`).
    const up = player.raise >= FLASH_RAISED;
    if (up) player.flash = Math.max(0, player.flash - step);
    player.flashSprite.visible = up && player.flash > 0 && distance < FAR;
  }

  /**
   * Crouches the body by `weight`, 0 to 1.
   *
   * Standing still it is a kneel, placed rather than squatted into: the
   * right knee on the ground under the hip with the shin laid back along
   * the floor and the toes tucked, the left foot planted ahead with the
   * shin upright - the pose a rifleman takes. Moving, a kneel cannot walk,
   * so it gives way to the run clip's own stride with the hips lowered and
   * each leg solved back onto the foot the clip placed.
   */
  _kneel(player, entry, weight) {
    const { bones } = player;
    if (!bones.hips || !bones.upLegL || !bones.upLegR || !bones.footL || !bones.footR) return;
    const ground = player.root.position.y;
    // Where the legs face, which strafing turns away from the aim.
    aimVector(entry.yaw + player.legYaw, 0, _fwd);
    _side.crossVectors(_fwd, _up).normalize(); // the body's right

    // How much of a kneel this is: none at a walk.
    const still = 1 - Math.min(1, Math.max(0, (entry.speed - 0.4) / 1.2));
    const kneel = weight * still;

    // The clip's feet, and how high it holds an ankle off the floor.
    bones.footL.getWorldPosition(_goalL);
    bones.footR.getWorldPosition(_goalR);
    const ankle = Math.max(0.05, Math.min(_goalL.y, _goalR.y) - ground);

    // Down far enough that the right knee reaches the floor.
    bones.upLegR.getWorldPosition(_hip);
    bones.legR.getWorldPosition(_knee);
    bones.footR.getWorldPosition(_foot);
    const thigh = _hip.distanceTo(_knee);
    const shin = _knee.distanceTo(_foot);
    const kneelDrop = Math.max(0, _hip.y - ground - (thigh + KNEE_PAD));
    const drop = weight * (CROUCH_WALK_DROP + (kneelDrop - CROUCH_WALK_DROP) * still);
    bones.hips.position.y -= drop / player.hipsScale;
    bones.hips.updateMatrixWorld(true);

    if (kneel > 0.001) {
      // Left foot ahead of its hip, flat; right foot behind, on its toes.
      bones.upLegL.getWorldPosition(_hip);
      _kneelL.copy(_hip).addScaledVector(_fwd, LEAD_FOOT_AHEAD).addScaledVector(_side, -0.04);
      _kneelL.y = ground + ankle;
      bones.upLegR.getWorldPosition(_hip);
      _kneelR.copy(_hip).addScaledVector(_fwd, -shin * 0.92).addScaledVector(_side, 0.06);
      _kneelR.y = ground + ankle + 0.04;
      _goalL.lerp(_kneelL, kneel);
      _goalR.lerp(_kneelR, kneel);
    }

    solveLeg(bones.upLegL, bones.legL, bones.footL, _goalL, _fwd);
    solveLeg(bones.upLegR, bones.legR, bones.footR, _goalR, _fwd);

    // Toes tucked under on the knee that is down: the foot pitched about
    // the body's right so the sole faces backwards.
    if (kneel > 0.001) {
      _qTurn.setFromAxisAngle(_side, TOE_TUCK * kneel);
      turnWorld(bones.footR, _qTurn);
    }
  }

  /**
   * Turns the spine so the rifle points where it should, into `out`: along
   * the player's aim at the shoulder, at the low ready's angle to it at
   * rest, and by `raise` in between.
   *
   * The line from the right palm to the left is measured where the clips
   * left it and turned onto that direction: about the vertical, then about
   * the level axis across it, the two made one rotation and shared down the
   * spine about its own axis (`shareTurn`). Every share turns everything
   * above it, so the hands are turned by the whole of it, and the line
   * between them lands on the direction exactly. Yaw then pitch rather than
   * the shortest turn: the low ready points down, and the shortest turn
   * between two downward lines tips the torso over sideways instead of
   * turning it.
   */
  _orient(player, entry, raise, out) {
    const { bones } = player;
    const yaw = entry.yaw + READY.across * (1 - raise);
    const rest = -READY.down + READY.follow * entry.pitch;
    const pitch = rest + (entry.pitch - rest) * raise;
    aimVector(yaw, pitch, out);
    if (!bones.handR || !bones.handL || !bones.spine) return out;
    palms(bones, _a, _b);
    _c.subVectors(_b, _a);
    const length = _c.length();
    if (length < 1e-4) return out;
    const turn = clampTwist(wrapAngle(yaw - Math.atan2(-_c.x, -_c.z)));
    const bend = clampTwist(pitch - Math.asin(Math.min(1, Math.max(-1, _c.y / length))));
    shareTurn(bones, SPINE, yawThenPitch(turn, bend, yaw, _twist));

    // The face where the player is looking. Raised it is already, down the
    // sights; lowered, the idle clip turns the head about as it pleases, and
    // the rifle follows only a little of the pitch. Measured, like the hands,
    // and turned onto the look by the neck and the head between them.
    const look = 1 - raise;
    if (look > 1e-3 && bones.neck && bones.head && this.face) {
      bones.head.getWorldQuaternion(_q);
      _c.copy(this.face).applyQuaternion(_q);
      const turnHead = clampTwist(wrapAngle(entry.yaw - Math.atan2(-_c.x, -_c.z))) * look;
      const bendHead = clampTwist(entry.pitch - Math.asin(Math.min(1, Math.max(-1, _c.y)))) * look;
      shareTurn(bones, NECK, yawThenPitch(turnHead, bendHead, entry.yaw, _twist));
    }
    return out;
  }

  /**
   * The rifle into the hands, and whatever the hands are doing with it: a
   * reload or a throw, when one is under way. Neither is a clip - the
   * soldier has none for them - so both are placed: the rifle turned in the
   * right hand, and the left arm solved onto where it has to be.
   */
  _act(player, entry, aim, dir) {
    const reload = player.reloading ? (player.age - player.reloadAt) / SIM.reloadSeconds : null;
    const thrown = player.throwAt === undefined ? null : (player.age - player.throwAt) / THROW_SECONDS;
    if (thrown !== null && thrown > 1) player.throwAt = undefined;

    if (thrown !== null && thrown <= 1) {
      // The rifle hangs from the right hand while the left throws: dipped
      // from the shoulder, and from the low ready, where it hangs already,
      // left as it is.
      const lowered = ease(thrown / 0.15) * (1 - ease((thrown - 0.7) / 0.3));
      this._placeRifle(player, dir, THROW_DIP * lowered * player.raise, 0.3 * lowered);
      const { bones } = player;
      if (!bones.armL) return;
      bones.armL.getWorldPosition(_shoulder);
      _side.crossVectors(aim, _up).normalize();
      _fwd.set(aim.x, 0, aim.z).normalize();
      // Back behind the head, then out ahead and up: a lob.
      const windup = _reach.copy(_shoulder).addScaledVector(_fwd, -0.22).addScaledVector(_up, 0.32).addScaledVector(_side, -0.06);
      const release = _goal.copy(_shoulder).addScaledVector(_fwd, 0.55).addScaledVector(_up, 0.22);
      let weight;
      let target;
      if (thrown < 0.4) {
        weight = ease(thrown / 0.2);
        target = windup;
      } else if (thrown < 0.58) {
        weight = 1;
        target = windup.lerp(release, ease((thrown - 0.4) / 0.18));
      } else {
        weight = 1 - ease((thrown - 0.58) / 0.42);
        target = release;
      }
      this._reachLeft(player, target, weight);
      return;
    }

    if (reload !== null && reload <= 1) {
      const canted = ease(reload / 0.12) * (1 - ease((reload - 0.82) / 0.18));
      this._placeRifle(player, dir, RELOAD_DIP * canted, RELOAD_CANT * canted);
      // The hand to the magazine, down to the pouch at the hip for the next
      // one, back up to seat it, and back onto the handguard.
      _mag.copy(MAGAZINE).applyMatrix4(_m);
      const { bones } = player;
      if (!bones.hips) return;
      _side.crossVectors(aim, _up).normalize();
      _fwd.set(aim.x, 0, aim.z).normalize();
      bones.hips.getWorldPosition(_pouch);
      _pouch.addScaledVector(_side, -0.2).addScaledVector(_fwd, 0.1).addScaledVector(_up, 0.02);
      let weight = 1;
      const target = _reach;
      if (reload < 0.14) {
        weight = ease(reload / 0.14);
        target.copy(_mag);
      } else if (reload < 0.34) {
        target.lerpVectors(_mag, _pouch, ease((reload - 0.14) / 0.2));
      } else if (reload < 0.52) {
        target.lerpVectors(_pouch, _mag, ease((reload - 0.34) / 0.18));
      } else if (reload < 0.8) {
        // Seated with a shove up.
        const shove = Math.sin(Math.min(1, Math.max(0, (reload - 0.56) / 0.08)) * Math.PI) * 0.04;
        target.copy(_mag).addScaledVector(_up, shove);
      } else {
        weight = 1 - ease((reload - 0.8) / 0.2);
        target.copy(_mag);
      }
      this._reachLeft(player, target, weight);
      return;
    }

    this._placeRifle(player, dir);
  }

  /** The left hand towards `goal` by `weight`, the arm solved to reach it
   *  with the elbow hanging. */
  _reachLeft(player, goal, weight) {
    const { bones } = player;
    if (!bones.armL || !bones.foreArmL || !bones.handL || weight <= 0.001) return;
    bones.handL.getWorldPosition(_hand);
    _hand.lerp(goal, weight);
    solveLeg(bones.armL, bones.foreArmL, bones.handL, _hand, _down);
  }

  /**
   * The rifle in the right palm, laid along `dir` - dipped by `dip` and
   * canted about its own length by `cant`, both in radians, when the hands
   * are doing something other than holding it there.
   */
  _placeRifle(player, dir, dip = 0, cant = 0) {
    const { bones, rifle, root } = player;
    if (!bones.handR || !bones.handL) return;
    palms(bones, _a, _b);
    _aimR.copy(dir);
    if (dip) _aimR.applyAxisAngle(_side.crossVectors(dir, _up).normalize(), -dip);
    _upR.copy(_up);
    if (cant) _upR.applyAxisAngle(_aimR, cant);
    // Along the aim, upright against the world's up, grip in the palm.
    holdMatrix(_a, _aimR, _upR, RIFLE.scale, _m);

    root.updateMatrixWorld(true);
    _inverse.copy(root.matrixWorld).invert();
    rifle.matrix.multiplyMatrices(_inverse, _m);
    rifle.matrixWorldNeedsUpdate = true;
  }

  /**
   * The upper body's clips for this frame: the low ready, the shouldered
   * pose, the run's arm swing and the shot, weighted so they always sum to
   * one - three.js fills whatever weight is missing with the bind pose.
   */
  _driveArms(player, entry, dt) {
    const { ready, aim, swing, fire } = player.actions;
    // Up to the shoulder to aim, and on a shot and for a while after it.
    // Down for a throw, and half way for a reload.
    const shooting = player.age - player.shotAt < RAISED_AFTER_SHOT;
    let target = entry.aiming || shooting ? 1 : 0;
    if (player.throwAt !== undefined) target = 0;
    else if (player.reloading) target = RELOAD_RAISE;
    const time = target < player.raise ? LOWER_TIME : shooting && !entry.aiming ? RAISE_SHOT_TIME : RAISE_TIME;
    player.raise += (target - player.raise) * (1 - Math.exp(-dt / time));
    if (Math.abs(target - player.raise) < 1e-3) player.raise = target;
    const raise = player.raise;

    player.firing += ((fire.isRunning() ? 1 : 0) - player.firing) * (1 - Math.exp(-dt / FIRE_BLEND));
    const firing = player.firing;
    const sprint = entry.onGround
      ? Math.min(1, Math.max(0, (entry.speed - RUN_SPEED) / 3)) * RUN_SWING
      : 0;
    ready.setEffectiveWeight(1 - raise);
    aim.setEffectiveWeight(raise * (1 - sprint) * (1 - firing));
    swing.setEffectiveWeight(raise * sprint * (1 - firing));
    fire.setEffectiveWeight(raise * firing);
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

  /** Where somebody else's reload started since the last call, for the
   *  sound - as [x, y, z], the way positions cross the wire. */
  takeReloads() {
    if (this.reloads.length === 0) return EMPTY;
    const started = this.reloads;
    this.reloads = [];
    return started;
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

const EMPTY = [];

/** Metres between two snapshots past which a player was put somewhere, not
 *  moved there: a twentieth of a second at a run is 0.4 m. */
const TELEPORT = 4;

/**
 * Whose hand a grenade that has just appeared left: the living player, not
 * this one, whose eyes are nearest it and within `THROW_REACH`. The server
 * does not say, and does not need to - the grenade starts at the thrower's
 * eye, and at twenty snapshots a second it is still beside them.
 */
function nearestThrower(players, at, selfId) {
  let best = null;
  let bestDistance = THROW_REACH;
  for (const player of players ?? []) {
    if (player.id === selfId || player.state.health <= 0) continue;
    const p = player.state.position;
    const eye = p[1] + (player.state.crouched ? SIM.eyeOffset - SIM.crouchDrop : SIM.eyeOffset);
    const distance = Math.hypot(at[0] - p[0], at[1] - eye, at[2] - p[2]);
    if (distance < bestDistance) {
      best = player.id;
      bestDistance = distance;
    }
  }
  return best;
}

/** The unit vector a player with this yaw and pitch is looking along - the
 *  inverse of what the drivers compute from a look direction. */
function aimVector(yaw, pitch, out) {
  const flat = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * flat, Math.sin(pitch), -Math.cos(yaw) * flat);
}

/** Turns a bone by a world-space rotation. */
function turnWorld(bone, turn) {
  bone.getWorldQuaternion(_qWorld);
  _qWorld.premultiply(turn);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qParent);
    _qWorld.premultiply(_qParent.invert());
  }
  bone.quaternion.copy(_qWorld);
  bone.updateMatrixWorld(true);
}

/**
 * Two-bone IK for a leg: thigh and shin turned so the foot lands on `goal`,
 * the knee towards where it already pointed (or `forward` if the leg was
 * straight). The foot keeps its world orientation, so it stays flat.
 */
function solveLeg(upper, lower, foot, goal, forward) {
  foot.getWorldQuaternion(_qFoot);
  upper.getWorldPosition(_hip);
  lower.getWorldPosition(_knee);
  foot.getWorldPosition(_foot);
  const l1 = _hip.distanceTo(_knee);
  const l2 = _knee.distanceTo(_foot);
  if (l1 < 1e-4 || l2 < 1e-4) return;

  _dir.subVectors(goal, _hip);
  let d = _dir.length();
  if (d < 1e-4) return;
  _dir.divideScalar(d);
  d = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-3), (l1 + l2) * 0.999);

  // Which way the knee goes: where it is now, off the hip-foot line, with a
  // little of the facing so a straight leg still bends forwards.
  _pole.addVectors(_hip, _foot).multiplyScalar(0.5);
  _pole.subVectors(_knee, _pole).addScaledVector(forward, 0.05);
  _pole.addScaledVector(_dir, -_pole.dot(_dir));
  if (_pole.lengthSq() < 1e-8) _pole.copy(forward);
  _pole.normalize();

  const cos = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  _newKnee.copy(_hip).addScaledVector(_dir, l1 * cos).addScaledVector(_pole, l1 * sin);

  _from.subVectors(_knee, _hip).normalize();
  _to.subVectors(_newKnee, _hip).normalize();
  turnWorld(upper, _qTurn.setFromUnitVectors(_from, _to));

  lower.getWorldPosition(_knee);
  foot.getWorldPosition(_foot);
  _goal.copy(_hip).addScaledVector(_dir, d);
  _from.subVectors(_foot, _knee).normalize();
  _to.subVectors(_goal, _knee).normalize();
  turnWorld(lower, _qTurn.setFromUnitVectors(_from, _to));

  // Back to the foot's own orientation, in its new parent.
  lower.getWorldQuaternion(_qParent);
  foot.quaternion.copy(_qParent.invert().multiply(_qFoot));
  foot.updateMatrixWorld(true);
}

/** A spine correction kept to what a spine can do. */
function clampTwist(angle) {
  return Math.max(-MAX_TWIST, Math.min(MAX_TWIST, angle));
}

/** Into `out`, the world rotation that turns a direction by `turn` about
 *  the vertical and then raises it by `bend`, about the level axis across
 *  the way it then faces, `yaw`. */
function yawThenPitch(turn, bend, yaw, out) {
  _q.setFromAxisAngle(_up, turn);
  _axis.set(Math.cos(yaw), 0, -Math.sin(yaw));
  return out.setFromAxisAngle(_axis, bend).multiply(_q);
}

/**
 * Turns a chain of bones by the world rotation `turn` between them, each
 * by its share about the turn's own axis. Turns about one axis add up, so
 * whatever hangs off the last bone is turned by exactly `turn`. The chain's
 * matrices are brought up to date once, at the end: reading each bone's
 * world rotation already brings its parents up to date.
 */
function shareTurn(bones, chain, turn) {
  const angle = 2 * Math.acos(Math.min(1, Math.abs(turn.w)));
  if (angle < 1e-5) return;
  const sign = turn.w < 0 ? -1 : 1;
  _axis.set(turn.x * sign, turn.y * sign, turn.z * sign).normalize();
  let first = null;
  for (const [key, share] of chain) {
    const bone = bones[key];
    if (!bone) continue;
    first ??= bone;
    bone.getWorldQuaternion(_qWorld);
    _qWorld.premultiply(_q.setFromAxisAngle(_axis, angle * share));
    if (bone.parent) _qWorld.premultiply(bone.parent.getWorldQuaternion(_qParent).invert());
    bone.quaternion.copy(_qWorld);
  }
  first?.updateMatrixWorld(true);
}

/**
 * The rifle at the low ready, as a clip, built once at load from the idle
 * clip and the shouldered pose.
 *
 * The idle clip holds the rifle across the belt, nearly level and pointing
 * almost straight out to the soldier's left: relaxed, but not how anybody
 * carries a rifle they might need in a second. So the torso and the head
 * are the idle's, breathing; the rifle is put where `READY` says, lowered
 * across the body with the muzzle down and to the left; and each arm is
 * solved onto it, the hands closing on the grip and on the handguard the
 * way the shouldered pose closes them - fingers and all, so a hand holds
 * the rifle the same way whichever stance it is in. The shoulders, arms and
 * hands are one still frame over the idle's moving spine, so they ride the
 * breathing as one piece and the hands stay on the rifle.
 *
 * Built in the soldier's own frame: at the origin, facing +Z, its left +X.
 */
function lowReady(template, idle, aim) {
  const body = cloneSkinned(template);
  const bone = (name) => body.getObjectByName(name);
  const hands = {};
  for (const [key, name] of Object.entries(HAND)) hands[key] = bone(name);
  const arms = ['Right', 'Left'].map((side) => ({
    arm: bone(`mixamorig${side}Arm`),
    fore: bone(`mixamorig${side}ForeArm`),
    hand: bone(`mixamorig${side}Hand`),
  }));
  if (!hands.handR || !hands.handL || arms.some((a) => !a.arm || !a.fore || !a.hand)) return aim;
  const mixer = new THREE.AnimationMixer(body);
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const left = new THREE.Vector3();
  const turnOf = (matrix) => {
    const q = new THREE.Quaternion();
    matrix.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    return q;
  };
  const posedBy = (clip) => {
    mixer.stopAllAction();
    mixer.clipAction(clip).reset().play();
    mixer.setTime(0);
    body.updateMatrixWorld(true);
  };

  // How the shouldered pose holds the rifle: each hand's turn against it,
  // and where its palm is from its wrist, in the hand's own frame.
  posedBy(aim);
  palms(hands, right, left);
  const held = holdMatrix(right, left.clone().sub(right).normalize(), up, RIFLE.scale, new THREE.Matrix4());
  const heldTurn = turnOf(held).invert();
  const grips = arms.map(({ hand }, i) => {
    const turn = hand.getWorldQuaternion(new THREE.Quaternion());
    const wrist = hand.getWorldPosition(new THREE.Vector3());
    return {
      inRifle: heldTurn.clone().multiply(turn),
      palm: (i === 0 ? right : left).clone().sub(wrist).applyQuaternion(turn.clone().invert()),
    };
  });
  const fingers = new Map();
  body.traverse((node) => {
    if (node.isBone && /Hand(Thumb|Index|Middle|Ring|Pinky)/.test(node.name)) {
      fingers.set(node.name, node.quaternion.clone());
    }
  });

  // The idle's torso, and the rifle where the low ready puts it.
  posedBy(idle);
  palms(hands, right, left);
  const grip = right.clone().add(new THREE.Vector3(...READY.grip));
  const dir = new THREE.Vector3(
    Math.sin(READY.across) * Math.cos(READY.down),
    -Math.sin(READY.down),
    Math.cos(READY.across) * Math.cos(READY.down),
  );
  const placed = holdMatrix(grip, dir, up, RIFLE.scale, new THREE.Matrix4());
  const placedTurn = turnOf(placed);
  // The support hand under the handguard, where the first-person one is.
  const support = new THREE.Vector3(...WEAPON.arms.leftPalm).applyMatrix4(placed);
  const parentTurn = new THREE.Quaternion();
  arms.forEach(({ arm, fore, hand }, i) => {
    const turn = placedTurn.clone().multiply(grips[i].inRifle);
    const palm = i === 0 ? grip : support;
    const wrist = palm.clone().sub(grips[i].palm.clone().applyQuaternion(turn));
    // Twice: turning the hand moves nothing above it, but a first solve
    // from far away can leave the elbow where a second does better.
    for (let k = 0; k < 2; k += 1) solveLeg(arm, fore, hand, wrist, _down);
    hand.parent.getWorldQuaternion(parentTurn);
    hand.quaternion.copy(parentTurn.invert().multiply(turn));
    hand.updateMatrixWorld(true);
  });

  // One track per bone the shouldered pose moves, so the two always blend
  // bone for bone: the idle's for the spine and head, this frame's for the
  // shoulders and arms, the shouldered grip's for the fingers.
  const tracks = aim.tracks.map((track) => {
    const name = track.name.split('.')[0];
    if (/Spine|Neck|Head$/.test(name)) {
      const own = idle.tracks.find((t) => t.name === track.name);
      if (own) return own.clone();
    }
    const node = bone(name);
    const q = fingers.get(name) ?? node?.quaternion;
    if (!q || !track.name.endsWith('.quaternion')) return track.clone();
    return new THREE.QuaternionKeyframeTrack(track.name, [0], q.toArray());
  });
  mixer.stopAllAction();
  return new THREE.AnimationClip('ready', idle.duration, tracks);
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
    let a = old.state;
    const b = fresh.state;
    // Moved further between two snapshots than anybody can run or fall: put
    // there by the server - from the gathering to a spawn as a match goes
    // live - and drawn there, not slid across the map to it.
    const dx = b.position[0] - a.position[0];
    const dy = b.position[1] - a.position[1];
    const dz = b.position[2] - a.position[2];
    if (dx * dx + dy * dy + dz * dz > TELEPORT * TELEPORT) a = b;
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
      crouched: Boolean(b.crouched),
      reloading: Boolean(fresh.reloading),
      aiming: Boolean(fresh.aiming),
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
      crouched: Boolean(s.crouched),
      reloading: Boolean(fresh.reloading),
      aiming: Boolean(fresh.aiming),
    });
  }

  return entries;
}
