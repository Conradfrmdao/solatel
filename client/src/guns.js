// The guns, which are real ones: an AK-47, an RPK made from it, an MP5, an
// M700 and an M1911, modelled and textured by Stein Games and given away
// under CC0 (ATTRIBUTION.md), turned into the game's files by
// `scripts/build-guns.mjs`. The code-built guns they replaced looked like
// toys next to a photographed map, which is what Conrad said of them.
//
// Each file is in metres with the origin where the right palm closes on the
// grip. Everything that holds a gun was measured against the rifle model the
// game started with, in its units - 0.19 m each in somebody else's hands,
// 0.18 in the first person - with the pistol grip at `GRIP` (`grip.js`) and
// the muzzle down -Z. So each gun is drawn at `1 / UNIT` with its grip put on
// `GRIP`, and its landmarks (`POINTS`) are read off the file in those units:
// the muzzle, the magazine, the ejection port, where the left hand closes,
// the rail and the iron sights. Nothing that holds a gun knows which one it
// is holding.
//
// The parts that move are nodes of their own - `magazine`, `bolt`,
// `trigger`, `hammer` - so a reload takes the magazine out and a shot works
// the action; `userData.parts` hands them over with their rest poses.
//
// The optics: a red dot and a compact 2x prism built here in code on the
// gun's rail, and for 3x and 4x the scope from 3DModelsCC0's sniper rifle
// (also CC0), on its own rings - shorter and slimmer at 3x.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { asset } from './assets.js';
import { GRIP } from './grip.js';
import { assemble, block, gather, pin, turned } from './gunkit.js';
import { ktx2Loader } from './photo.js';

/** Metres per model unit: what the rifle model everything was measured
 *  against was drawn at in a soldier's hands. */
export const UNIT = 0.19;

/** Every gun there is, by its name on the wire. */
export const WEAPON_IDS = ['pistol', 'smg', 'rifle', 'lmg', 'sniper'];

/** Which file each gun is in: one per model, so the RPK shares the AK's
 *  textures. */
const FILE = { rifle: 'ak47', lmg: 'ak47', smg: 'mp5', sniper: 'm700', pistol: 'm1911' };

/** The pistol's support hand cups the right one rather than holding the
 *  gun: this far from the grip, in model units - under it and a little
 *  ahead. */
const PISTOL_SUPPORT = [-0.02, -0.32, -0.14];

/** Where the eye is with the sights up: on the stock, this far behind the
 *  grip, in metres - a cheek on the comb. The sights are seen from there,
 *  whichever they are; the pistol, held out at arm's length, has none. */
const CHEEK = { rifle: 0.19, lmg: 0.19, smg: 0.17, sniper: 0.21 };

/** The 3x is the 4x's scope, smaller. */
const SCOPE_SCALE = { x3: 0.86, x4: 1 };

/** The parts that move, by the names `build-guns.mjs` gives them. */
const PART_NAMES = ['magazine', 'bolt', 'trigger', 'hammer'];

/**
 * Each gun's landmarks, in model units, once `loadGuns` has read them:
 *
 *   muzzle    the face of the muzzle, on the bore
 *   magazine  where a hand takes the magazine
 *   port      where spent cases leave
 *   support   where the left palm closes (the pistol's cups the right hand)
 *   rail      where an optic's mount sits: its top, and its middle along z
 *   irons     the iron sights' line, as [height, z] at the front and rear
 *   cheek     where the eye is along z with the sights up, or undefined
 */
export const POINTS = {};

/** Each gun as loaded, in model units, to be cloned. */
const templates = new Map();
/** The 3x and 4x scope, in metres, and where its tube is. */
let scope = null;

const toModel = (p) => [GRIP.x + p.x / UNIT, GRIP.y + p.y / UNIT, GRIP.z + p.z / UNIT];

/**
 * The node under `root` called `name`. three.js makes every name in a file
 * unique by numbering the repeats, and the AK's file holds two guns made of
 * the same parts, so the machine gun's muzzle is `muzzle_1`.
 */
function named(root, name) {
  const repeat = new RegExp(`^${name}_\\d+$`);
  let found = null;
  root.traverse((node) => {
    if (!found && (node.name === name || repeat.test(node.name))) found = node;
  });
  return found;
}

/**
 * Loads every gun and the scope. Everything else here needs them, so it is
 * awaited before the first gun is built - at boot, beside the soldier.
 */
export async function loadGuns() {
  if (templates.size) return;
  const loader = new GLTFLoader().setKTX2Loader(ktx2Loader());
  const names = [...new Set(Object.values(FILE)), 'optics'];
  const files = new Map(await Promise.all(names.map(async (name) => [name, await loader.loadAsync(asset(`assets/guns/${name}.glb`))])));
  for (const weapon of WEAPON_IDS) {
    const gltf = files.get(FILE[weapon]);
    const scene = gltf.scenes.find((s) => s.name === weapon || named(s, weapon) === s) ?? gltf.scene;
    const model = scene.children[0];
    model.removeFromParent();
    // Metres to model units, the grip on the rifle's grip.
    model.scale.setScalar(1 / UNIT);
    model.position.copy(GRIP);
    model.updateMatrixWorld(true);
    model.traverse((node) => {
      if (!node.isMesh) return;
      node.castShadow = true;
      for (const map of ['map', 'normalMap', 'roughnessMap']) {
        if (node.material[map]) node.material[map].anisotropy = 8;
      }
    });
    const holder = new THREE.Group();
    holder.name = weapon;
    holder.add(model);
    templates.set(weapon, holder);

    const at = (name) => {
      const node = named(model, name);
      return node ? toModel(node.position) : null;
    };
    const railTop = weapon === 'pistol' ? null : at('rail_top');
    const front = at('sight_front');
    const rear = at('sight_rear');
    POINTS[weapon] = {
      muzzle: at('muzzle'),
      magazine: at('magazine_grip'),
      port: at('port'),
      support: at('support') ?? [GRIP.x + PISTOL_SUPPORT[0], GRIP.y + PISTOL_SUPPORT[1], GRIP.z + PISTOL_SUPPORT[2]],
      rail: railTop ? { top: railTop[1], z: railTop[2] } : null,
      irons: { front: [front[1], front[2]], rear: [rear[1], rear[2]] },
      cheek: CHEEK[weapon] === undefined ? undefined : GRIP.z + CHEEK[weapon] / UNIT,
    };
  }
  const optics = files.get('optics');
  const mesh = named(optics.scene, 'scope');
  mesh.removeFromParent();
  mesh.castShadow = true;
  scope = { mesh, axis: mesh.userData.axis, front: mesh.userData.front, back: mesh.userData.back };
}

/**
 * A gun, with its optic, as one group in model units. `userData.sight` is
 * the line the eye aims down, `[height, z]` at the front and the rear - the
 * optic's, or the iron sights'; `userData.parts` the parts that move, each
 * with the pose it rests in.
 */
export function buildGun(weapon, optic) {
  const template = templates.get(weapon) ?? templates.get('rifle');
  if (!template) throw new Error('loadGuns has not finished');
  const group = template.clone(true);
  const model = group.children[0];
  const points = POINTS[weapon] ?? POINTS.rifle;
  const mounted = optic && optic !== 'irons' && points.rail ? optic : null;
  const rail = named(model, 'rail');
  if (rail) rail.visible = mounted !== null;

  let sight = { front: points.irons.front, rear: points.irons.rear, optic: 'irons' };
  if (mounted === 'x3' || mounted === 'x4') {
    // The scope on its rings, in the gun's own metres, its feet on the rail.
    const size = SCOPE_SCALE[mounted];
    const s = scope.mesh.clone();
    const top = named(model, 'rail_top').position;
    s.position.copy(top);
    s.scale.setScalar(size);
    model.add(s);
    const height = toModel(new THREE.Vector3(0, top.y + scope.axis * size, 0))[1];
    const zFront = toModel(new THREE.Vector3(0, 0, top.z + scope.front * size))[2];
    const zRear = toModel(new THREE.Vector3(0, 0, top.z + scope.back * size))[2];
    sight = { front: [height, zFront], rear: [height, zRear], optic: mounted };
  } else if (mounted) {
    const shape = opticShape(mounted, points.rail);
    const built = assemble(`optic_${mounted}`, gather([scopeParts(shape)], KINDS), opticMaterials());
    built.add(glassFor(shape));
    group.add(built);
    sight = { front: [shape.height, shape.front], rear: [shape.height, shape.rear], optic: mounted };
  }

  const parts = {};
  for (const name of PART_NAMES) {
    const node = named(model, name);
    if (node) parts[name] = { node, position: node.position.clone(), quaternion: node.quaternion.clone() };
  }
  group.userData = { weapon, points, sight, parts };
  return group;
}

// ---- the red dot and the 2x, built here -------------------------------------

/** How thick an optic's tube is: its inside is this much of its outside. */
const WALL = 0.86;
const KINDS = ['metal', 'dark'];

let materials = null;
function opticMaterials() {
  if (materials) return materials;
  materials = {
    // Hard-anodised aluminium, black and satin, as every optic is made.
    metal: new THREE.MeshStandardMaterial({ name: 'optic_anodised', color: 0x1d1f21, roughness: 0.46, metalness: 0.6 }),
    // The inside of the tube and small parts in shadow.
    dark: new THREE.MeshStandardMaterial({ name: 'optic_dark', color: 0x0c0d0e, roughness: 0.62, metalness: 0.4 }),
  };
  return materials;
}

/**
 * A sight: a lathed body along the bore from `front` to `rear` at `height`,
 * its outside following `profile` ([fraction along, radius] pairs), on a
 * ring or a block down to the rail at `base`.
 */
function scopeParts({ base, height, front, rear, profile, rings = [0.3, 0.7], turrets = false, prism = false }) {
  const metal = [];
  const dark = [];
  const length = rear - front;
  // A wall, not a skin: out along the outside, back along the inside, so the
  // tube can be looked down and is solid from either side.
  const outside = profile.map(([f, r]) => [front + f * length, r]);
  const inside = outside.map(([z, r]) => [z, r * WALL]).reverse();
  metal.push(turned([...outside, ...inside, outside[0]], { y: height, segments: 32 }));
  // A lip at each end, so the rims read as rims.
  const first = outside[0][1];
  const last = outside[outside.length - 1][1];
  const ring = (z0, z1, r) => [[z0, r * WALL], [z0, r * 1.04], [z1, r * 1.04], [z1, r * WALL], [z0, r * WALL]];
  dark.push(turned(ring(front - 0.005, front + 0.03, first), { y: height, segments: 32 }));
  dark.push(turned(ring(rear - 0.03, rear + 0.005, last), { y: height, segments: 32 }));
  if (prism) {
    // A prism sight's body is a box under the tube, not rings, clamped to
    // the rail with a thumb nut on the left. Its top stops at the tube's
    // inside wall: higher, it filled the bottom of the view through it.
    const [from, to] = [0.18, 0.82];
    const under = Math.min(...profile.filter(([f]) => f >= from && f <= to).map(([, rr]) => rr));
    metal.push(block(-0.075, base, front + length * from, 0.075, height - under * WALL, front + length * to));
    dark.push(pin(front + length * 0.5, base + 0.05, 0.035, 0.06, { x: -0.105, segments: 12 }));
  } else {
    for (const at of rings) {
      const z = front + at * length;
      const r = profile.reduce((best, [f, rr]) => (Math.abs(f - at) < Math.abs(best[0] - at) ? [f, rr] : best))[1];
      // A ring round the tube, not a disc through it: turned from the axis,
      // it closed the tube in the middle, and looking through the red dot
      // was looking at the face of its own mount, with the dot behind it.
      metal.push(turned([[z - 0.05, r * 0.98], [z - 0.05, r * 1.2], [z + 0.05, r * 1.2], [z + 0.05, r * 0.98], [z - 0.05, r * 0.98]], { y: height, segments: 24 }));
      metal.push(block(-0.07, base, z - 0.05, 0.07, height - r, z + 0.05));
      // The clamp's cross bolt, through the ring's foot under the tube.
      dark.push(pin(z, height - r * 1.1, 0.025, r * 2.8, { segments: 8 }));
    }
  }
  if (turrets) {
    const z = front + length * 0.5;
    const r = profile[Math.floor(profile.length / 2)][1];
    metal.push(turned([[0, 0], [0, 0.07], [0.1, 0.07], [0.1, 0]], { y: 0, segments: 18 }).rotateX(-Math.PI / 2).translate(0, height + r, z));
    metal.push(turned([[0, 0], [0, 0.07], [0.1, 0.07], [0.1, 0]], { y: 0, segments: 18 }).rotateX(-Math.PI / 2).rotateZ(-Math.PI / 2).translate(r, height, z));
  }
  return { metal, dark };
}

/** The tinted glass at each end of an optic, and for a red dot its dot. */
function glassFor({ height, front, rear, profile, dot = 0 }) {
  const group = new THREE.Group();
  const glass = new THREE.MeshBasicMaterial({
    color: 0x7fb8c8,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const length = rear - front;
  for (const [f, z] of [[profile[0], front + 0.02], [profile[profile.length - 1], rear - 0.02]]) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(f[1] * 0.86, 32), glass);
    disc.position.set(0, height, z);
    group.add(disc);
  }
  if (dot > 0) {
    // Lit, not painted: the tone curve would turn an LED's red to brick.
    const red = new THREE.Mesh(
      new THREE.CircleGeometry(dot, 20),
      new THREE.MeshBasicMaterial({ color: 0xff2a20, side: THREE.DoubleSide, toneMapped: false }),
    );
    red.position.set(0, height, front + length * 0.05);
    group.add(red);
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(dot * 1.9, 20),
      new THREE.MeshBasicMaterial({
        color: 0xff3a2a,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    halo.position.set(0, height, front + length * 0.051);
    group.add(halo);
  }
  return group;
}

/**
 * The red dot or the 2x on a rail whose top is at `rail.top` and middle at
 * `rail.z`, in model units. `height` is the line of sight and `front` and
 * `rear` its ends: the sights' line for aiming through it.
 */
function opticShape(optic, rail) {
  const base = rail.top;
  const z = rail.z;
  if (optic === 'x2') {
    // A compact prism: a short squat tube on a block.
    const height = base + 0.16;
    return { base, height, front: z - 0.32, rear: z + 0.2, profile: [[0, 0.13], [0.2, 0.12], [0.8, 0.12], [1, 0.11]], prism: true, turrets: true };
  }
  // A tube red dot on a single ring.
  const height = base + 0.15;
  return { base, height, front: z - 0.16, rear: z + 0.16, profile: [[0, 0.12], [0.12, 0.12], [0.88, 0.12], [1, 0.12]], dot: 0.011, rings: [0.5], turrets: true };
}
