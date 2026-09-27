// Vehicles, drums and crates, drawn properly over the maps' stand-ins.
//
// The maps carry their cars, trucks, oil drums and crates as low-polygon
// stand-ins - octagon wheels, a car as a dozen flat faces - and those
// stand-ins are what the generator took each one's collision box from. This
// module leaves them exactly where they are, as far as the world is
// concerned, and draws something better in their place: a model built here,
// fitted to the stand-in's own box, so what a player sees fills the space
// they collide with and no more.
//
// Which node is which comes from its name, the way the maps name them:
// `truck`, `car`, `barrel`, `crate` for the facility's placements, `CAR`,
// `Wood` (the yard's drums) and two named trucks for the yard. The loader
// drops the dot from `truck.001`, so the names are matched without one.
//
// Everything is instanced: one draw per part per kind, however many there
// are, and each copy's paint comes from the stand-in's own colour.
//
// None of it decides anything. It is paint.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { photoSet } from './photo.js';

const KINDS = [
  { kind: 'truck', test: /^truck(_olive|_grey)?\d+$/ },
  // The yard's two trucks, by the only names they have. Only in the yard:
  // the arena has an unrelated `Cube.036` of its own.
  { kind: 'truck', test: /^(Cube036|Cube051)$/, yard: true },
  { kind: 'car', test: /^(car(_blue|_olive)?\d+|CAR\d+)$/ },
  { kind: 'drum', test: /^(barrel(_blue)?\d+|Wood\d+)$/ },
  { kind: 'crate', test: /^crate(_dark)?\d+$/ },
];

// ---- building blocks ----------------------------------------------------------

function flat(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  for (const name of Object.keys(g.attributes)) {
    if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  }
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((g.attributes.position.count) * 2), 2));
  }
  return g;
}

function merge(parts) {
  return mergeGeometries(parts.map(flat), false);
}

/** A side profile, `[x, y]` in metres, extruded to `width` about z = 0 with
 *  rounded edges. */
function profile(points, width, bevel = 0.05, segments = 3) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) shape.lineTo(x, y);
  shape.closePath();
  const depth = Math.max(width - 2 * bevel, 0.01);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: segments,
    curveSegments: 6,
  });
  g.translate(0, 0, -depth / 2);
  // Extrusion UVs are in metres of the shape; a quarter of that is a
  // sensible repeat for paint and grime.
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * 0.25, uv.getY(i) * 0.25);
  return g;
}

function box(x0, y0, z0, x1, y1, z1) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/** A wheel standing on the ground at `x`, `z`, axle across z. */
function wheel(x, z, radius, width) {
  const tyre = new THREE.CylinderGeometry(radius, radius, width, 22, 1);
  tyre.rotateX(Math.PI / 2);
  tyre.translate(x, radius, z);
  const rim = new THREE.CylinderGeometry(radius * 0.58, radius * 0.58, width + 0.02, 14, 1);
  rim.rotateX(Math.PI / 2);
  rim.translate(x, radius, z);
  const hub = new THREE.CylinderGeometry(radius * 0.18, radius * 0.18, width + 0.06, 8, 1);
  hub.rotateX(Math.PI / 2);
  hub.translate(x, radius, z);
  return { tyre, rim, hub };
}

// ---- the models ---------------------------------------------------------------
//
// Each is built in metres with x forward, y up, z to the side, standing on
// y = 0 and centred in x and z; `size` is the box it was built to fill.

function sedan() {
  const L = 4.6;
  const W = 1.8;
  const H = 1.46;
  const hx = L / 2;
  const body = W - 0.16;
  const paint = [
    // Lower body: bumper to bumper, a raked nose and a short boot.
    profile([[-hx + 0.05, 0.28], [hx - 0.1, 0.28], [hx, 0.46], [hx - 0.04, 0.66], [hx - 0.35, 0.8],
      [1.05, 0.9], [-1.75, 0.95], [-hx + 0.12, 0.88], [-hx, 0.66], [-hx, 0.42]], body, 0.1, 4),
    // The roof, over a narrower glasshouse.
    profile([[0.38, 1.36], [-0.95, 1.38], [-1.0, 1.44], [0.33, 1.42]], body - 0.34, 0.05, 3),
  ];
  // The glasshouse: raked windscreen, flat roofline, sloping back light.
  const glass = [profile([[1.08, 0.88], [0.36, 1.37], [-0.97, 1.39], [-1.7, 0.93]], body - 0.3, 0.07, 3)];
  const dark = [
    box(hx - 0.08, 0.22, -body / 2, hx + 0.04, 0.44, body / 2),
    box(-hx - 0.04, 0.24, -body / 2, -hx + 0.08, 0.44, body / 2),
    box(-1.95, 0.16, -body / 2 + 0.08, 1.95, 0.3, body / 2 - 0.08),
    box(hx - 0.06, 0.48, -0.42, hx + 0.02, 0.62, 0.42),
  ];
  const rubber = [];
  const metal = [];
  for (const x of [1.38, -1.4]) {
    for (const z of [W / 2 - 0.12, -W / 2 + 0.12]) {
      const w = wheel(x, z, 0.33, 0.23);
      rubber.push(w.tyre);
      metal.push(w.rim, w.hub);
    }
  }
  const lamps = [
    box(hx - 0.1, 0.6, 0.48, hx + 0.01, 0.7, 0.76),
    box(hx - 0.1, 0.6, -0.76, hx + 0.01, 0.7, -0.48),
  ];
  const tail = [
    box(-hx - 0.01, 0.7, 0.52, -hx + 0.06, 0.8, 0.8),
    box(-hx - 0.01, 0.7, -0.8, -hx + 0.06, 0.8, -0.52),
  ];
  return { size: [L, H, W], paint, glass, dark, rubber, metal, lamps, tail };
}

function cargoTruck() {
  const L = 7.6;
  const W = 2.5;
  const hx = L / 2;
  const cabBack = 1.9;
  const paint = [
    // The cab: a flat-nosed military cab, rounded at the edges.
    profile([[cabBack, 0.95], [hx - 0.05, 0.95], [hx, 1.85], [hx - 0.3, 2.78], [cabBack, 2.8]], W - 0.1, 0.07),
    // The bed and its drop-sides.
    box(-hx, 1.0, -W / 2, cabBack - 0.1, 1.18, W / 2),
    box(-hx, 1.18, -W / 2, cabBack - 0.1, 1.72, -W / 2 + 0.06),
    box(-hx, 1.18, W / 2 - 0.06, cabBack - 0.1, 1.72, W / 2),
    box(-hx, 1.18, -W / 2, -hx + 0.06, 1.72, W / 2),
    // Mudguards over the rear wheels.
    box(-3.35, 1.0, -W / 2 - 0.02, -1.05, 1.08, -W / 2 + 0.42),
    box(-3.35, 1.0, W / 2 - 0.42, -1.05, 1.08, W / 2 + 0.02),
  ];
  // The canvas tilt over the bed: a half barrel, open underneath, closed
  // at both ends.
  const radius = W / 2 - 0.02;
  const run = cabBack - 0.15 + hx;
  const arch = (length, x) => {
    const g = new THREE.CylinderGeometry(radius, radius, length, 20, 1, length > 0.1, 0, Math.PI);
    // Axis along x, the half that was +x on top.
    g.rotateZ(Math.PI / 2);
    g.translate(x, 1.72, 0);
    return g;
  };
  const canvas = [
    arch(run, (cabBack - 0.15 - hx) / 2),
    arch(0.03, cabBack - 0.16),
    arch(0.03, -hx + 0.01),
  ];
  const glass = [
    box(hx - 0.2, 1.95, -W / 2 + 0.25, hx - 0.12, 2.6, W / 2 - 0.25),
    box(cabBack + 0.35, 1.9, -W / 2 + 0.02, hx - 0.45, 2.55, -W / 2 + 0.07),
    box(cabBack + 0.35, 1.9, W / 2 - 0.07, hx - 0.45, 2.55, W / 2 - 0.02),
  ];
  const dark = [
    box(-hx, 0.55, -0.5, hx - 0.1, 0.9, 0.5),
    box(hx - 0.08, 1.02, -0.85, hx + 0.08, 1.75, 0.85),
    box(hx - 0.02, 0.62, -W / 2 + 0.05, hx + 0.18, 0.92, W / 2 - 0.05),
    box(-hx - 0.05, 0.62, -W / 2 + 0.1, -hx + 0.08, 0.9, W / 2 - 0.1),
    box(0.2, 0.62, -W / 2 + 0.15, 1.5, 0.98, -W / 2 + 0.55),
  ];
  const rubber = [];
  const metal = [];
  for (const x of [2.85, -1.6, -2.8]) {
    for (const z of [W / 2 - 0.26, -W / 2 + 0.26]) {
      const w = wheel(x, z, 0.55, 0.42);
      rubber.push(w.tyre);
      metal.push(w.rim, w.hub);
    }
  }
  const lamps = [
    box(hx - 0.04, 1.3, 0.85, hx + 0.1, 1.5, 1.1),
    box(hx - 0.04, 1.3, -1.1, hx + 0.1, 1.5, -0.85),
  ];
  const tail = [
    box(-hx - 0.1, 0.8, 0.8, -hx, 0.95, 1.05),
    box(-hx - 0.1, 0.8, -1.05, -hx, 0.95, -0.8),
  ];
  return { size: [L + 0.2, 2.95, W], paint, canvas, glass, dark, rubber, metal, lamps, tail };
}

function drum() {
  // A 200-litre steel drum: two rolling hoops, a rolled rim top and bottom.
  const r = 0.29;
  const pts = [
    [0, 0], [r - 0.01, 0], [r, 0.015], [r - 0.004, 0.04], [r - 0.004, 0.27], [r + 0.012, 0.285],
    [r + 0.012, 0.305], [r - 0.004, 0.32], [r - 0.004, 0.56], [r + 0.012, 0.575], [r + 0.012, 0.595],
    [r - 0.004, 0.61], [r - 0.004, 0.845], [r + 0.004, 0.87], [r - 0.012, 0.878], [r - 0.02, 0.868],
    [0, 0.866],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const body = new THREE.LatheGeometry(pts, 26);
  const bung = new THREE.CylinderGeometry(0.03, 0.03, 0.02, 8);
  bung.translate(0.17, 0.875, 0.05);
  return { size: [2 * (r + 0.012), 0.88, 2 * (r + 0.012)], paint: [body, bung] };
}

function crate() {
  // Boards on every face, and battens along every edge and across each side.
  const s = 1;
  const t = 0.07;
  const planks = [box(-0.5, 0, -0.5, 0.5, s, 0.5)];
  const battens = [];
  const e = 0.5 + 0.01;
  for (const [a, b] of [[-e, -e], [-e, e], [e, -e], [e, e]]) {
    battens.push(box(a - t / 2, 0, b - t / 2, a + t / 2, s, b + t / 2));
  }
  for (const y of [0, s - t]) {
    battens.push(box(-e, y, -e, e, y + t, -e + t), box(-e, y, e - t, e, y + t, e));
    battens.push(box(-e, y, -e, -e + t, y + t, e), box(e - t, y, -e, e, y + t, e));
  }
  return { size: [1.02, 1.0, 1.02], planks, battens };
}

const MODELS = { car: sedan, truck: cargoTruck, drum, crate };

// ---- materials -------------------------------------------------------------

async function tryPhoto(name) {
  try {
    return await photoSet(name);
  } catch {
    return null;
  }
}

async function materials() {
  const [painted, planks, rusty] = await Promise.all([
    tryPhoto('painted_metal'),
    tryPhoto('planks'),
    tryPhoto('rusty_metal'),
  ]);
  const withPhoto = (material, set, repeat = 1) => {
    if (!set) return material;
    const map = set.albedo.clone();
    map.repeat.set(repeat, repeat);
    map.needsUpdate = true;
    material.map = map;
    const normal = set.normal.clone();
    normal.repeat.set(repeat, repeat);
    normal.needsUpdate = true;
    material.normalMap = normal;
    material.normalScale = new THREE.Vector2(0.6, 0.6);
    return material;
  };
  return {
    // Factory paint, gone matt with dust, with a thin clear coat still
    // catching the sky on the curves.
    paint: new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.55,
      metalness: 0.25,
      clearcoat: 0.35,
      clearcoatRoughness: 0.35,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x10161b,
      roughness: 0.05,
      metalness: 0.0,
      clearcoat: 1.0,
      envMapIntensity: 1.3,
    }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1e1f20, roughness: 0.75, metalness: 0.2 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x151516, roughness: 0.95, metalness: 0 }),
    metal: withPhoto(new THREE.MeshStandardMaterial({ color: 0x8a8c8e, roughness: 0.45, metalness: 0.8 }), rusty, 0.5),
    lamps: new THREE.MeshStandardMaterial({ color: 0xd8d4c8, emissive: 0x2a2a26, roughness: 0.15 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x7a1a14, emissive: 0x1a0402, roughness: 0.2 }),
    canvas: new THREE.MeshStandardMaterial({ color: 0x6b6a4c, roughness: 0.98, side: THREE.DoubleSide }),
    drum: withPhoto(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.35 }), painted, 1),
    planks: withPhoto(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }), planks, 0.6),
    battens: withPhoto(new THREE.MeshStandardMaterial({ color: 0xb8aa98, roughness: 0.9 }), planks, 0.3),
  };
}

// ---- fitting a model into a stand-in's box --------------------------------------

/** The main colour of a stand-in: its largest non-rubber, non-steel part. */
function bodyColour(object) {
  let best = null;
  let most = -1;
  object.traverse((node) => {
    if (!node.isMesh) return;
    for (const material of [node.material].flat()) {
      if (!material?.color) continue;
      if (/rubber|steel|glass|frame/.test(material.name ?? '')) continue;
      const count = node.geometry.index ? node.geometry.index.count : node.geometry.attributes.position.count;
      if (count > most) {
        most = count;
        best = material.color;
      }
    }
  });
  return best ? best.clone() : new THREE.Color(0x555555);
}

/**
 * Where a stand-in stands, and which way round: its box in the map's own
 * frame, as a position on the ground, a rotation and a size.
 */
function fit(object, map, kind) {
  const toMap = new THREE.Matrix4().copy(map.matrixWorld).invert().multiply(object.matrixWorld);
  const points = [];
  const inverseObject = new THREE.Matrix4().copy(object.matrixWorld).invert();
  const v = new THREE.Vector3();
  object.traverse((node) => {
    if (!node.isMesh) return;
    const p = node.geometry.attributes.position;
    const nodeToObject = new THREE.Matrix4().multiplyMatrices(inverseObject, node.matrixWorld);
    const step = Math.max(1, Math.floor(p.count / 1500));
    for (let i = 0; i < p.count; i += step) points.push(v.fromBufferAttribute(p, i).applyMatrix4(nodeToObject).clone());
  });
  if (!points.length) return null;
  const local = new THREE.Box3().setFromPoints(points);
  const axes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  toMap.extractBasis(axes[0], axes[1], axes[2]);
  const size = new THREE.Vector3().subVectors(local.max, local.min);
  const lengths = [size.x * axes[0].length(), size.y * axes[1].length(), size.z * axes[2].length()];
  const units = axes.map((a) => a.clone().normalize());
  // Up is whichever axis points most nearly up; forward the longer of the
  // other two.
  const up = [0, 1, 2].sort((a, b) => Math.abs(units[b].y) - Math.abs(units[a].y))[0];
  const others = [0, 1, 2].filter((i) => i !== up);
  const along = lengths[others[0]] >= lengths[others[1]] ? others[0] : others[1];
  const across = others.find((i) => i !== along);
  const U = units[up].clone().multiplyScalar(Math.sign(units[up].y) || 1);
  let F = units[along].clone();
  const centre = local.getCenter(new THREE.Vector3()).applyMatrix4(toMap);

  if (kind === 'car' || kind === 'truck') {
    // The nose is the lower end: a bonnet under a windscreen, a cab lower
    // than the load behind it.
    let front = -Infinity;
    let back = -Infinity;
    const L = lengths[along];
    for (const p of points) {
      const q = p.clone().applyMatrix4(toMap).sub(centre);
      const f = q.dot(F);
      const h = q.dot(U);
      if (f > L * 0.3) front = Math.max(front, h);
      if (f < -L * 0.3) back = Math.max(back, h);
    }
    if (front > back + 0.05) F.negate();
  }
  const Z = new THREE.Vector3().crossVectors(F, U).normalize();
  F = new THREE.Vector3().crossVectors(U, Z).normalize();
  const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(F, U, Z));
  const height = lengths[up];
  const ground = centre.clone().addScaledVector(U, -height / 2);
  return { position: ground, rotation, dims: [lengths[along], height, lengths[across]] };
}

// ---- putting them in a map ----------------------------------------------------

/**
 * Draw every vehicle, drum and crate in `map` properly, and hide the
 * stand-ins. Returns how many of each were replaced.
 */
export async function dressProps(map) {
  map.updateMatrixWorld(true);
  const found = { car: [], truck: [], drum: [], crate: [] };
  let yard = false;
  map.traverse((node) => {
    if (/^CAR\d+$/.test(node.name ?? '')) yard = true;
  });
  map.traverse((node) => {
    if (node === map || !node.name) return;
    for (const { kind, test, yard: yardOnly } of KINDS) {
      if (yardOnly && !yard) continue;
      if (test.test(node.name)) {
        found[kind].push(node);
        return;
      }
    }
  });
  const total = Object.values(found).reduce((n, list) => n + list.length, 0);
  if (!total) return {};

  const mats = await materials();
  const group = new THREE.Group();
  group.name = 'props';
  group.userData.scenery = true;
  const counts = {};
  const m = new THREE.Matrix4();
  for (const [kind, nodes] of Object.entries(found)) {
    if (!nodes.length) continue;
    const model = MODELS[kind]();
    const placements = [];
    for (const node of nodes) {
      const placed = fit(node, map, kind);
      if (!placed) continue;
      placed.colour = bodyColour(node);
      placements.push(placed);
      node.visible = false;
    }
    counts[kind] = placements.length;
    const parts = Object.entries(model).filter(([name]) => name !== 'size');
    for (const [part, geometries] of parts) {
      const material = kind === 'drum' ? mats.drum : mats[part];
      if (!material || !geometries.length) continue;
      const mesh = new THREE.InstancedMesh(merge(geometries), material, placements.length);
      const tinted = part === 'paint' || kind === 'drum' || part === 'planks' || part === 'battens';
      placements.forEach((p, i) => {
        const scale = new THREE.Vector3(p.dims[0] / model.size[0], p.dims[1] / model.size[1], p.dims[2] / model.size[2]);
        m.compose(p.position, p.rotation, scale);
        mesh.setMatrixAt(i, m);
        if (tinted) {
          // Crates keep the timber's own colour, lightly shaded per crate.
          const c = part === 'planks' || part === 'battens'
            ? new THREE.Color(1, 1, 1).multiplyScalar(0.8 + ((i * 37) % 10) / 40)
            : p.colour.clone().multiplyScalar(kind === 'drum' ? 2.2 : 1.3);
          mesh.setColorAt(i, c);
        }
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }
  map.add(group);
  return counts;
}
