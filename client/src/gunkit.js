// The kit the code-built optics in `guns.js` are made from - the red dot and
// the 2x prism. (The guns themselves are real models: `build-guns.mjs`.)
//
// Everything is in a gun's side view: points as [z, y], with the muzzle down
// -Z, up +Y and x across, in the model units every gun is drawn in - 0.18 m
// each in the first person, 0.19 in somebody else's hands. A part is a
// section turned about the bore, a pin or a block, and an optic is merged
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

/** A round section turned about the z axis: `profile` is [z, radius]. */
export function turned(profile, { y = BORE, x = 0, segments = 24 } = {}) {
  const pts = profile.map(([z, r]) => new THREE.Vector2(r, z));
  const g = new THREE.LatheGeometry(pts, segments);
  // The lathe turns about y; lay it along z.
  g.rotateX(Math.PI / 2);
  g.translate(x, y, 0);
  return g;
}

/** A cylinder across the gun (a pin, a button), at (z, y). */
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
