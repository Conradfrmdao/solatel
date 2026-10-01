// The rifle, built here rather than downloaded.
//
// The model the game shipped with had no licence anybody could find, and a
// game that charges money cannot ship somebody else's work on a guess. So the
// rifle is made in code, like the vehicles in `props.js`: an M4-pattern
// carbine with a carry handle, every part a side profile or a turned section
// with bevelled edges, so its corners catch light the way machined metal and
// moulded polymer do.
//
// It is built in the old model's own frame and units, because everything
// that handles the rifle was measured against that frame: the muzzle face at
// z -2.306 down its -Z, the bore 0.065 up, the carry handle's top at 0.49
// where the red dot mounts (`weapons.js`), the pistol grip at `GRIP` in
// `grip.js`, the magazine where `remotes.js` reaches for it, the ejection
// port where the cases come out. Nothing that holds it has to change.
//
// Three materials - anodised aluminium, black polymer, blued steel - and the
// whole rifle merged into one mesh per material, because thirty players each
// carry a copy.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const BORE = 0.066;

// ---- building blocks: everything is in (z, y) side view, x across ---------

function plain(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  for (const name of Object.keys(g.attributes)) {
    if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  }
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  return g;
}

/**
 * A side profile - points as [z, y] - extruded `width` across x about
 * `x`, with rounded edges. `holes` are more outlines, cut through.
 */
function side(points, width, { bevel = 0.012, x = 0, holes = [], segments = 2 } = {}) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  for (const hole of holes) shape.holes.push(new THREE.Path(hole.map(([z, y]) => new THREE.Vector2(z, y))));
  const depth = Math.max(width - 2 * bevel, 0.002);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: segments,
    curveSegments: 8,
  });
  // Shape x is our z; the extrusion runs across.
  g.translate(0, 0, -depth / 2);
  g.rotateY(-Math.PI / 2);
  g.translate(x, 0, 0);
  return g;
}

/** A round section turned about the z axis: `profile` is [z, radius]. */
function turned(profile, { y = BORE, x = 0, segments = 24 } = {}) {
  const pts = profile.map(([z, r]) => new THREE.Vector2(r, z));
  const g = new THREE.LatheGeometry(pts, segments);
  // The lathe turns about y; lay it along z.
  g.rotateX(Math.PI / 2);
  g.translate(x, y, 0);
  return g;
}

/** A plain cylinder from z0 to z1, radius r, about (x, y). */
function rod(z0, z1, r, { y = BORE, x = 0, segments = 18 } = {}) {
  return turned(
    [
      [z0, 0],
      [z0, r * 0.9],
      [z0 + Math.sign(z1 - z0) * r * 0.1, r],
      [z1 - Math.sign(z1 - z0) * r * 0.1, r],
      [z1, r * 0.9],
      [z1, 0],
    ],
    { y, x, segments },
  );
}

/** A cylinder across the rifle (a pin, a button), at (z, y). */
function pin(z, y, r, length, { x = 0, segments = 12 } = {}) {
  const g = new THREE.CylinderGeometry(r, r, length, segments);
  g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

function block(x0, y0, z0, x1, y1, z1) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/** Points along a quadratic curve, for the magazine's sweep. */
function curve(a, c, b, n = 8) {
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
  return out;
}

// ---- the parts ------------------------------------------------------------

function upperReceiver() {
  const metal = [];
  const dark = [];
  // The receiver: a flat top under the handle, a chamfered shoulder down to
  // the lower, the forward assist's housing at the back right.
  metal.push(side([[0.71, -0.09], [0.71, 0.17], [0.66, 0.21], [-0.29, 0.21], [-0.31, 0.18], [-0.31, -0.09]], 0.17, { bevel: 0.016 }));
  // Ejection port on the right, its cover open on its hinge below it, and
  // the brass deflector behind it.
  dark.push(block(0.083, 0.03, -0.14, 0.09, 0.12, 0.11));
  metal.push(block(0.085, -0.02, -0.15, 0.1, 0.025, 0.12));
  metal.push(side([[0.2, 0.04], [0.2, 0.15], [0.14, 0.15], [0.12, 0.04]], 0.05, { x: 0.1, bevel: 0.008 }));
  // Forward assist: a plunger in a tube, angled up and back at the right.
  const assist = rod(0.36, 0.56, 0.038, { x: 0.085, y: 0.11, segments: 14 });
  metal.push(assist);
  metal.push(rod(0.56, 0.6, 0.046, { x: 0.085, y: 0.11, segments: 14 }));
  // Charging handle at the back, its latch to the left.
  metal.push(side([[0.83, 0.12], [0.83, 0.18], [0.7, 0.18], [0.7, 0.12]], 0.2, { bevel: 0.01 }));
  metal.push(block(-0.12, 0.13, 0.76, -0.09, 0.18, 0.82));
  return { metal, dark };
}

function carryHandle() {
  const metal = [];
  const dark = [];
  // The handle: a bridge with a window, the rear sight's housing rising at
  // the back, and the mount's thumb screws below.
  metal.push(
    side(
      [[0.63, 0.21], [0.63, 0.43], [0.59, 0.49], [0.43, 0.49], [0.4, 0.42], [-0.22, 0.42], [-0.28, 0.38], [-0.28, 0.21]],
      0.09,
      { holes: [[[0.36, 0.25], [-0.16, 0.25], [-0.2, 0.28], [-0.2, 0.36], [-0.16, 0.38], [0.36, 0.38], [0.38, 0.36], [0.38, 0.27]]], bevel: 0.012 },
    ),
  );
  // Rear sight: the aperture's drum and the windage knob on the right.
  dark.push(pin(0.52, 0.44, 0.028, 0.1));
  metal.push(pin(0.5, 0.35, 0.04, 0.05, { x: 0.07 }));
  // The mount's clamp screws, either side.
  for (const z of [0.25, -0.12]) {
    metal.push(pin(z, 0.22, 0.03, 0.13, { segments: 10 }));
    metal.push(pin(z, 0.22, 0.045, 0.02, { x: -0.075, segments: 12 }));
  }
  return { metal, dark };
}

function lowerReceiver() {
  const metal = [];
  const dark = [];
  // The lower: the receiver's floor, the magazine well flaring at its mouth,
  // the trigger guard's lugs.
  metal.push(
    side(
      [
        [0.71, -0.09], [0.71, -0.15], [0.62, -0.17], [0.13, -0.17], [0.12, -0.3], [0.16, -0.33],
        [-0.27, -0.33], [-0.24, -0.29], [-0.27, -0.17], [-0.31, -0.13], [-0.31, -0.09],
      ],
      0.15,
      { bevel: 0.014 },
    ),
  );
  // The trigger guard: a loop from the grip forward to the magazine well.
  metal.push(side([[0.56, -0.17], [0.56, -0.26], [0.5, -0.33], [0.13, -0.33], [0.13, -0.28], [0.48, -0.28], [0.52, -0.23], [0.52, -0.17]], 0.045, { bevel: 0.008 }));
  // The trigger: a curved blade.
  dark.push(side([[0.38, -0.17], [0.375, -0.21], [0.355, -0.255], [0.33, -0.27], [0.335, -0.245], [0.35, -0.21], [0.355, -0.17]], 0.03, { bevel: 0.004 }));
  // Takedown and pivot pins, the selector, the magazine catch, the bolt
  // catch: the small things a real lower is covered in.
  metal.push(pin(0.66, -0.04, 0.025, 0.17));
  metal.push(pin(-0.26, -0.06, 0.025, 0.17));
  metal.push(pin(0.5, -0.06, 0.035, 0.17));
  dark.push(side([[0.53, -0.04], [0.53, -0.025], [0.42, -0.0], [0.42, -0.02]], 0.02, { x: -0.09, bevel: 0.004 }));
  metal.push(pin(0.06, -0.12, 0.04, 0.03, { x: 0.08 }));
  dark.push(side([[0.1, 0.02], [0.1, -0.07], [0.06, -0.07], [0.04, 0.02]], 0.02, { x: -0.083, bevel: 0.004 }));
  // The buffer tube's castle nut, where the stock's tube meets the lower.
  metal.push(rod(0.71, 0.77, 0.085, { y: 0.09, segments: 12 }));
  return { metal, dark };
}

function pistolGrip() {
  // Raked back, swelling under the palm, finger grooves at the front, a
  // beaver tail into the web of the hand.
  const front = [];
  for (let i = 0; i <= 3; i += 1) {
    const t = i / 3;
    const z = 0.45 + t * 0.21;
    const y = -0.18 - t * 0.47;
    front.push([z - 0.012 * Math.sin(i * Math.PI), y]);
  }
  return {
    polymer: [
      side(
        [
          [0.66, -0.15], [0.47, -0.15], ...front.slice(1), [0.68, -0.68], [0.73, -0.71], [0.93, -0.7], [0.94, -0.66],
          [0.82, -0.3], [0.76, -0.18], [0.7, -0.15],
        ],
        0.11,
        { bevel: 0.022, segments: 3 },
      ),
    ],
  };
}

function magazine() {
  // A curved thirty-round box: the front and back edges as curves, a floor
  // plate below, and the ribs pressed into its sides.
  const back = curve([0.11, -0.33], [0.08, -0.6], [-0.02, -0.86]);
  const front = curve([-0.33, -0.86], [-0.24, -0.6], [-0.24, -0.33]);
  const metal = [side([...back, ...front], 0.12, { bevel: 0.01 })];
  const dark = [side([[0.0, -0.84], [-0.0, -0.9], [-0.36, -0.9], [-0.35, -0.84]], 0.14, { bevel: 0.012 })];
  for (const t of [0.2, 0.45, 0.7]) {
    const [bz, by] = back[Math.round(t * 8)];
    const [fz, fy] = front[8 - Math.round(t * 8)];
    for (const sx of [1, -1]) {
      dark.push(side([[bz - 0.03, by + 0.02], [fz + 0.03, fy + 0.02], [fz + 0.03, fy - 0.02], [bz - 0.03, by - 0.02]], 0.01, { x: sx * 0.062, bevel: 0.003 }));
    }
  }
  return { metal, dark };
}

function stock() {
  const polymer = [];
  const dark = [];
  // The buffer tube, and the collapsible stock riding on it: a body round
  // the tube, the toe dropping to the shoulder, a lightening cut, a rubber
  // butt plate.
  polymer.push(rod(0.74, 1.98, 0.072, { y: 0.09, segments: 16 }));
  polymer.push(
    side(
      [[1.22, 0.18], [2.04, 0.18], [2.06, 0.14], [2.06, -0.44], [1.99, -0.47], [1.86, -0.3], [1.64, -0.06], [1.22, -0.02]],
      0.13,
      { holes: [[[1.68, -0.08], [1.86, -0.08], [1.92, -0.2], [1.86, -0.3], [1.8, -0.24]]], bevel: 0.02, segments: 3 },
    ),
  );
  dark.push(side([[2.06, 0.19], [2.1, 0.19], [2.1, -0.47], [2.06, -0.47]], 0.14, { bevel: 0.012 }));
  // The adjustment lever under the tube.
  dark.push(side([[1.3, -0.02], [1.3, -0.06], [1.6, -0.06], [1.62, -0.03]], 0.04, { bevel: 0.006 }));
  return { polymer, dark };
}

function frontEnd() {
  const metal = [];
  const steel = [];
  const polymer = [];
  const dark = [];
  // The delta ring and its spring, where the handguard meets the receiver.
  metal.push(turned([[-0.31, 0], [-0.31, 0.12], [-0.32, 0.19], [-0.37, 0.19], [-0.39, 0.165], [-0.42, 0.165], [-0.42, 0]], { segments: 26 }));
  // The handguard: round, tapering forward, in two halves with a seam, ribs
  // running its length and two rows of vents.
  polymer.push(turned([[-0.42, 0], [-0.42, 0.158], [-0.44, 0.165], [-1.18, 0.15], [-1.2, 0.142], [-1.2, 0]], { segments: 32 }));
  for (let k = 0; k < 10; k += 1) {
    const a = (k / 10) * Math.PI * 2 + Math.PI / 10;
    const g = block(-0.009, 0.14, -1.17, 0.009, 0.172, -0.46);
    g.rotateZ(a);
    g.translate(0, BORE, 0);
    polymer.push(g);
  }
  for (const y of [0.04, 0.1]) {
    for (let i = 0; i < 6; i += 1) {
      const z = -0.55 - i * 0.11;
      for (const sx of [1, -1]) dark.push(pin(z, BORE + (y - 0.07), 0.022, 0.02, { x: sx * 0.155, segments: 10 }));
    }
  }
  dark.push(block(-0.004, BORE - 0.17, -1.18, 0.004, BORE + 0.17, -0.44));
  // The handguard's front cap.
  metal.push(turned([[-1.2, 0], [-1.2, 0.13], [-1.24, 0.12], [-1.24, 0]], { segments: 24 }));
  // The barrel, stepping down in front of the sight, the gas block under
  // the sight, the flash hider with its slots, the muzzle's crown.
  steel.push(rod(-0.31, -1.24, 0.048));
  steel.push(rod(-1.24, -2.07, 0.04));
  steel.push(turned([[-2.06, 0], [-2.06, 0.052], [-2.08, 0.058], [-2.29, 0.058], [-2.306, 0.05], [-2.306, 0.025], [-2.29, 0.02], [-2.29, 0]], { segments: 20 }));
  for (let k = 0; k < 4; k += 1) {
    const g = block(-0.008, 0.045, -2.27, 0.008, 0.062, -2.14);
    g.rotateZ((k / 4) * Math.PI * 2 + Math.PI / 4);
    g.translate(0, BORE, 0);
    dark.push(g);
  }
  // The front sight: an A-frame on its base, the post between its ears, the
  // bayonet lug and the sling swivel under it.
  metal.push(
    side(
      [[-1.24, -0.03], [-1.24, 0.13], [-1.3, 0.38], [-1.33, 0.41], [-1.4, 0.41], [-1.47, 0.13], [-1.47, -0.03]],
      0.11,
      { holes: [[[-1.33, 0.16], [-1.35, 0.33], [-1.385, 0.33], [-1.4, 0.16]]], bevel: 0.012 },
    ),
  );
  dark.push(block(-0.007, 0.3, -1.375, 0.007, 0.395, -1.36));
  metal.push(block(-0.025, -0.08, -1.46, 0.025, -0.02, -1.38));
  metal.push(pin(-1.42, -0.06, 0.016, 0.07, { segments: 8 }));
  return { metal, steel, polymer, dark };
}

// ---- the whole rifle ------------------------------------------------------

/** Parts by material. Exposed for the tests that check where it all is. */
export function rifleParts() {
  const parts = { metal: [], steel: [], polymer: [], dark: [] };
  for (const piece of [upperReceiver(), carryHandle(), lowerReceiver(), pistolGrip(), magazine(), stock(), frontEnd()]) {
    for (const [kind, list] of Object.entries(piece)) parts[kind].push(...list);
  }
  return parts;
}

let materials = null;
function rifleMaterials() {
  if (materials) return materials;
  materials = {
    // Hard-anodised aluminium: dark grey, satin, a little metallic.
    metal: new THREE.MeshStandardMaterial({ name: 'rifle_anodised', color: 0x45494d, roughness: 0.46, metalness: 0.55 }),
    // Blued steel: darker, harder, catches the light on the barrel.
    steel: new THREE.MeshStandardMaterial({ name: 'rifle_steel', color: 0x2a2b2d, roughness: 0.36, metalness: 0.8 }),
    // Moulded polymer: near black and matt.
    polymer: new THREE.MeshStandardMaterial({ name: 'rifle_polymer', color: 0x26282a, roughness: 0.74, metalness: 0.02 }),
    // Recesses, slots and small parts that read as shadow.
    dark: new THREE.MeshStandardMaterial({ name: 'rifle_dark', color: 0x0f1011, roughness: 0.7, metalness: 0.3 }),
  };
  return materials;
}

/** The rifle, one mesh per material, in the model frame described above. */
export function buildRifle() {
  const group = new THREE.Group();
  group.name = 'rifle';
  const mats = rifleMaterials();
  for (const [kind, geometries] of Object.entries(rifleParts())) {
    if (!geometries.length) continue;
    const merged = mergeGeometries(geometries.map(plain), false);
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, mats[kind]);
    mesh.name = `rifle_${kind}`;
    mesh.castShadow = true;
    group.add(mesh);
  }
  return group;
}
