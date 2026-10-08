// The kit every gun in `guns.js` and the rifle in `rifle.js` is built from.
//
// Everything is in a gun's side view: points as [z, y], with the muzzle down
// -Z, up +Y and x across, in the rifle model's own units - 0.18 m each in the
// first person, 0.19 in somebody else's hands - so every gun shares the
// rifle's landmarks: the bore at `BORE`, the pistol grip at `GRIP` in
// `grip.js`. A part is a profile extruded across, a section turned about the
// bore, a rod, a pin or a block, with bevelled edges so its corners catch the
// light the way machined metal and moulded polymer do. A gun is then merged
// into one mesh per material, because thirty players each carry one.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const BORE = 0.066;

// ---- building blocks: everything is in (z, y) side view, x across ---------

export function plain(geometry) {
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
export function side(points, width, { bevel = 0.012, x = 0, holes = [], segments = 2 } = {}) {
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
export function turned(profile, { y = BORE, x = 0, segments = 24 } = {}) {
  const pts = profile.map(([z, r]) => new THREE.Vector2(r, z));
  const g = new THREE.LatheGeometry(pts, segments);
  // The lathe turns about y; lay it along z.
  g.rotateX(Math.PI / 2);
  g.translate(x, y, 0);
  return g;
}

/** A plain cylinder from z0 to z1, radius r, about (x, y). */
export function rod(z0, z1, r, { y = BORE, x = 0, segments = 18 } = {}) {
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
export function pin(z, y, r, length, { x = 0, segments = 12 } = {}) {
  const g = new THREE.CylinderGeometry(r, r, length, segments);
  g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

export function block(x0, y0, z0, x1, y1, z1) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/** Points along a quadratic curve, for the magazine's sweep. */
export function curve(a, c, b, n = 8) {
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
  return out;
}

/**
 * Parts by material, merged into one mesh each and grouped as `name`, in the
 * model frame described at the top. `materials` maps each kind of part to
 * the material it is drawn in.
 */
export function assemble(name, parts, materials) {
  const group = new THREE.Group();
  group.name = name;
  for (const [kind, geometries] of Object.entries(parts)) {
    if (!geometries.length) continue;
    const merged = mergeGeometries(geometries.map(plain), false);
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, materials[kind]);
    mesh.name = `${name}_${kind}`;
    mesh.castShadow = true;
    group.add(mesh);
  }
  return group;
}

/** Collects parts, `{ metal: [...], ... }`, from pieces that each return
 *  some of them. */
export function gather(pieces, kinds) {
  const parts = Object.fromEntries(kinds.map((k) => [k, []]));
  for (const piece of pieces) {
    for (const [kind, list] of Object.entries(piece)) parts[kind].push(...list);
  }
  return parts;
}
