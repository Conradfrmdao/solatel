// Trees and grass, grown by the client from what the map says is there.
//
// A tree made of boxes looks like one made of boxes whatever is done to the
// boxes, and a field drawn as one flat face looks like a carpet. So a map can
// carry, in its scene extras, where each tree stands and where grass grows,
// and this module does the rest: tapered trunks, branches, leaves that catch
// the light as a rounded crown, a sway in the wind, and tufts of grass round
// the player that move with it.
//
// # None of it is the world
//
// What collides is decided elsewhere - a tree's trunk is a box in the map's
// hidden collision node, and grass collides with nothing. This module only
// decides what those things look like, from positions the file states, so
// every client draws the same tree in the same place. Leaves stop sight and
// not bullets, as in every shooter; the grass is low enough that it hides
// nobody.
//
// # Cost
//
// Everything is instanced: one draw per kind of tree and one for the grass,
// however many there are. Grass is only planted within `GRASS_RADIUS` of the
// eye and re-planted as it moves, from a hash of each spot so that a tuft
// never jumps when the patch is rebuilt.

import * as THREE from 'three';
import { foliageSet, photoSet } from './photo.js';

/** Seconds of wind, shared by every swaying material. */
const wind = { value: 0 };

/** How far from the eye grass is planted, in metres. */
const GRASS_RADIUS = 34;

/** Metres between grass tufts before jitter. */
const GRASS_STEP = 0.6;

/** How far the eye moves before the grass is re-planted round it. */
const GRASS_REPLANT = 5;

/**
 * How much of the scenery is drawn, from the graphics quality: `grass` is
 * the share of `GRASS_RADIUS` planted and `sky` whether birds and chimney
 * smoke are. Nothing here changes what a player can see of another player -
 * the trees are the same at every level - which is the rule the presets keep.
 */
const detail = { grass: 1, sky: true, version: 0 };

export function setNatureDetail({ grass = 1, sky = true } = {}) {
  if (grass === detail.grass && sky === detail.sky) return;
  detail.grass = grass;
  detail.sky = sky;
  detail.version += 1;
}

// ---- the textures --------------------------------------------------------

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** A clump of broad leaves: many small leaves, darker inside the clump. */
function leafTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    const random = seeded(7);
    // Twigs first, so leaves cover them.
    g.strokeStyle = 'rgba(58, 46, 34, 1)';
    g.lineWidth = 3;
    for (let i = 0; i < 6; i += 1) {
      const a = random() * Math.PI * 2;
      g.beginPath();
      g.moveTo(w / 2, h / 2);
      g.lineTo(w / 2 + Math.cos(a) * w * 0.4, h / 2 + Math.sin(a) * h * 0.4);
      g.stroke();
    }
    for (let i = 0; i < 260; i += 1) {
      // Denser in the middle, ragged at the edge.
      const r = Math.sqrt(random()) * w * 0.44;
      const a = random() * Math.PI * 2;
      const x = w / 2 + Math.cos(a) * r;
      const y = h / 2 + Math.sin(a) * r;
      const outer = r / (w * 0.44);
      const hue = 78 + random() * 30;
      const light = 16 + outer * 16 + random() * 12;
      g.fillStyle = `hsl(${hue}, ${34 + random() * 22}%, ${light}%)`;
      g.save();
      g.translate(x, y);
      g.rotate(random() * Math.PI * 2);
      const size = 7 + random() * 9;
      g.beginPath();
      g.ellipse(0, 0, size, size * 0.48, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  });
}

/**
 * Painted conifer foliage, two things side by side: on the left half a
 * spray of needles along a stem, which the branches wear; on the right half
 * a whole spruce in outline, layered skirts narrowing to the tip, which the
 * crossed cards through the crown wear so the tree has a silhouette from
 * the side. Branch cards are nearly level, and seen from the side at a
 * distance - which is how a player sees a tree - they are edge on and gone.
 */
function needleTexture() {
  return canvasTexture(512, 256, (g, w, h) => {
    const random = seeded(11);
    const half = w / 2;
    const needle = (x, y, angle, reach, light) => {
      g.strokeStyle = `hsl(${95 + random() * 30}, ${30 + random() * 16}%, ${light}%)`;
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(angle) * reach, y + Math.sin(angle) * reach);
      g.stroke();
    };
    // The spray.
    g.strokeStyle = 'rgba(56, 44, 32, 1)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(half * 0.97, h / 2);
    g.stroke();
    for (let x = 0; x < half * 0.97; x += 2.2) {
      const t = x / half;
      const reach = (1 - t * 0.5) * h * 0.3;
      for (const side of [-1, 1]) {
        needle(x, h / 2, side * (0.9 + random() * 0.4), reach, 17 + random() * 17);
      }
    }
    // The outline: skirts from the foot to the tip, each a fan of needles
    // drooping from the axis, darker towards the middle.
    const cx = half + half / 2;
    const skirts = 11;
    for (let k = 0; k < skirts; k += 1) {
      const t = k / (skirts - 1);
      const y = h * (0.97 - t * 0.9);
      const width = (1 - t) * half * 0.46 + half * 0.03;
      for (let i = 0; i < 90; i += 1) {
        const side = random() < 0.5 ? -1 : 1;
        const along = random();
        const x = cx + side * along * width;
        const yy = y - h * 0.05 + along * along * h * 0.07 + (random() - 0.5) * h * 0.03;
        const angle = side > 0 ? 0.4 + random() * 0.6 : Math.PI - 0.4 - random() * 0.6;
        needle(x, yy, angle, h * (0.03 + random() * 0.04), 12 + along * 16 + random() * 8);
      }
    }
    g.strokeStyle = 'rgba(56, 44, 32, 1)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx, h * 0.99);
    g.lineTo(cx, h * 0.05);
    g.stroke();
  });
}

/** Bark: vertical furrows, so a trunk is not a painted stick. */
function barkTexture() {
  const texture = canvasTexture(64, 128, (g, w, h) => {
    const random = seeded(5);
    g.fillStyle = '#4d4033';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i += 1) {
      const x = random() * w;
      const y = random() * h;
      g.fillStyle = random() < 0.5 ? 'rgba(30, 24, 18, 0.55)' : 'rgba(120, 104, 86, 0.35)';
      g.fillRect(x, y, 1 + random() * 2.5, 10 + random() * 30);
    }
  });
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// ---- the photographs ---------------------------------------------------------
//
// Scanned foliage from Poly Haven (CC0), cut out by each asset's own alpha
// mask. These are rectangles of the atlases, as u0, v0, u1, v1, found by
// looking at where the opaque islands are.

/** The leafy branch down the left of the broadleaf atlas. */
const LEAF_SPRAY = [0.0, 0.0, 0.45, 1.0];

/** Fir sprigs, each standing stem-down in the needle atlas. */
const NEEDLE_SPRIGS = [
  [0.305, 0.211, 0.648, 0.75],
  [0.625, 0.156, 0.961, 0.555],
  [0.641, 0.617, 0.953, 0.961],
];

/**
 * The five whole tufts along the bottom of the grass atlas, each as
 * [u0, v0, u1, v1] with v0 at the roots. Measured off the alpha map, one
 * box per tuft. The whole bottom strip used to be one card, which ran
 * through half-cut tufts and a stray brown blade-end between two of them,
 * and from any distance a field of those read as fallen leaves.
 */
const GRASS_TUFTS = [
  [0.029, 0.019, 0.205, 0.133],
  [0.193, 0.109, 0.493, 0.256],
  [0.24, 0.014, 0.498, 0.109],
  [0.586, 0.143, 0.815, 0.244],
  [0.574, 0.012, 0.786, 0.14],
];

/** Which tufts each kind of clump is made of, so neighbours differ. */
const GRASS_CLUMPS = [
  [1, 3, 0],
  [4, 2, 1],
  [3, 0, 4],
];

// ---- the geometry -----------------------------------------------------------

/** Accumulates triangles, then becomes a BufferGeometry. */
class Builder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.sway = [];
    this.shade = [];
    this.index = [];
    /** How much light reaches what is built next: 1 on the outside of a
     *  crown, less inside it. Set by the grower before each card. */
    this.light = 1;
  }

  vertex(p, n, u, v, sway) {
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    this.uvs.push(u, v);
    this.sway.push(sway);
    this.shade.push(this.light);
    return this.positions.length / 3 - 1;
  }

  quad(a, b, c, d) {
    this.index.push(a, b, c, a, c, d);
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(this.sway, 1));
    g.setAttribute('shade', new THREE.Float32BufferAttribute(this.shade, 1));
    g.setIndex(this.index);
    g.computeBoundingSphere();
    return g;
  }
}

/** A tapered cylinder from `from` to `to`, open at both ends. */
function limb(b, from, to, r0, r1, sides, sway0, sway1) {
  const axis = new THREE.Vector3().subVectors(to, from);
  const length = axis.length();
  axis.normalize();
  const side = Math.abs(axis.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(axis, side).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u).normalize();
  const rings = [];
  for (const [end, r, sway] of [[from, r0, sway0], [to, r1, sway1]]) {
    const ring = [];
    for (let i = 0; i <= sides; i += 1) {
      const a = (i / sides) * Math.PI * 2;
      const n = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a));
      const p = end.clone().addScaledVector(n, r);
      ring.push(b.vertex(p, n, i / sides, end === from ? 0 : length / 2, sway));
    }
    rings.push(ring);
  }
  for (let i = 0; i < sides; i += 1) {
    b.quad(rings[0][i], rings[0][i + 1], rings[1][i + 1], rings[1][i]);
  }
}

/**
 * A crown of leaf cards. Each card's normal points away from the middle of
 * the crown rather than off its own face, which is the whole trick: the
 * crown then shades as one rounded mass, lit on the sun's side and dark on
 * the other, instead of as a heap of flat cards each catching its own light.
 */
function card(b, centre, crown, size, random, uvs = LEAF_SPRAY) {
  const normal = centre.clone().sub(crown).normalize();
  // Face the card roughly outwards, with a random twist, so from any side
  // some cards are seen face on.
  const out = normal.clone().add(new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(1.4)).normalize();
  const side = new THREE.Vector3().crossVectors(out, new THREE.Vector3(0, 1, 0));
  if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
  side.normalize();
  const up = new THREE.Vector3().crossVectors(side, out).normalize();
  const spin = random() * Math.PI * 2;
  const [u0, v0, u1, v1] = uvs;
  // Shaped like the part of the atlas it shows, so leaves are not stretched.
  const aspect = (u1 - u0) / (v1 - v0);
  const a = side.clone().multiplyScalar(Math.cos(spin)).addScaledVector(up, Math.sin(spin)).multiplyScalar((size * aspect) / 2);
  const c = up.clone().multiplyScalar(Math.cos(spin)).addScaledVector(side, -Math.sin(spin)).multiplyScalar(size / 2);
  const corners = [
    [centre.clone().sub(a).sub(c), u0, v0],
    [centre.clone().add(a).sub(c), u1, v0],
    [centre.clone().add(a).add(c), u1, v1],
    [centre.clone().sub(a).add(c), u0, v1],
  ];
  const n = normal.clone().lerp(new THREE.Vector3(0, 1, 0), 0.25).normalize();
  const ids = corners.map(([p, u, v]) => b.vertex(p, n, u, v, 1));
  b.quad(ids[0], ids[1], ids[2], ids[3]);
}

/** Every tree is built ten metres tall and scaled to the height it is given. */
const BUILT_HEIGHT = 10;

function broadleaf(seed, detail = 1) {
  const random = seeded(seed);
  const wood = new Builder();
  const leaves = new Builder();
  const base = new THREE.Vector3(0, -0.3, 0);
  const fork = new THREE.Vector3((random() - 0.5) * 0.4, 4.2 + random() * 0.8, (random() - 0.5) * 0.4);
  limb(wood, base, fork, 0.34, 0.22, 8, 0, 0.1);
  const crown = new THREE.Vector3(fork.x, 6.9, fork.z);
  const radius = new THREE.Vector3(3.4 + random() * 0.6, 2.6 + random() * 0.4, 3.4 + random() * 0.6);
  // Boughs from the fork out into the crown.
  const boughs = 4 + Math.floor(random() * 2);
  for (let i = 0; i < boughs; i += 1) {
    const a = (i / boughs) * Math.PI * 2 + random() * 0.6;
    const end = new THREE.Vector3(
      crown.x + Math.cos(a) * radius.x * 0.7,
      crown.y + (random() - 0.2) * radius.y * 0.8,
      crown.z + Math.sin(a) * radius.z * 0.7,
    );
    limb(wood, fork, end, 0.16, 0.05, 5, 0.1, 0.7);
  }
  limb(wood, fork, crown.clone().add(new THREE.Vector3(0, radius.y * 0.8, 0)), 0.16, 0.04, 5, 0.1, 0.8);
  // Leaf clumps through the crown, most of them near its surface.
  const clumps = Math.round(46 * detail);
  const grow = 1 + (1 - detail) * 0.7;
  for (let i = 0; i < clumps; i += 1) {
    const d = new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1);
    if (d.lengthSq() > 1) {
      i -= 1;
      continue;
    }
    const depth = 0.55 + Math.sqrt(random()) * 0.45;
    d.normalize().multiplyScalar(depth);
    // Leaves deep in the crown, and underneath it, get little of the sky.
    leaves.light = (0.35 + 0.65 * ((depth - 0.55) / 0.45)) * (0.7 + 0.3 * (d.y * 0.5 + 0.5));
    const centre = crown.clone().add(new THREE.Vector3(d.x * radius.x, d.y * radius.y, d.z * radius.z));
    card(leaves, centre, crown, (3.2 + random() * 1.4) * grow, random);
  }
  return { wood: wood.geometry(), leaves: leaves.geometry() };
}

function spruce(seed, detail = 1) {
  const random = seeded(seed);
  const wood = new Builder();
  const leaves = new Builder();
  limb(wood, new THREE.Vector3(0, -0.3, 0), new THREE.Vector3(0, BUILT_HEIGHT, 0), 0.3, 0.03, 7, 0, 1);
  // Whorls of drooping branch sprays, wide at the foot and narrowing to
  // the tip: the silhouette every fir is known by.
  const layers = Math.max(detail < 1 ? 5 : 7, Math.round(12 * detail));
  for (let l = 0; l < layers; l += 1) {
    const t = l / (layers - 1);
    const y = 1.6 + t * (BUILT_HEIGHT - 2.2);
    const reach = (1 - t) * 2.9 + 0.35;
    const count = Math.max(detail < 1 ? 4 : 5, Math.round((7 + Math.floor((1 - t) * 3)) * Math.max(detail, 0.5)));
    for (let k = 0; k < count; k += 1) {
      const a = (k / count) * Math.PI * 2 + l * 0.9 + random() * 0.4;
      const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const across = new THREE.Vector3(-dir.z, 0, dir.x);
      const droop = reach * (0.32 + random() * 0.12);
      const rows = [
        [0.0, 0.0, 0.4],
        [0.55, droop * 0.35, 1.25],
        [1.0, droop, 0.95],
      ];
      const ids = [];
      rows.forEach(([f, down, width], r) => {
        leaves.light = (0.35 + 0.65 * f) * (0.7 + 0.3 * t);
        const centre = dir.clone().multiplyScalar(reach * f + 0.15).setY(y - down);
        const w = (width * reach) / 2;
        const n = dir.clone().multiplyScalar(0.8).setY(0.6).normalize();
        // The painted spray runs along u from stem to tip, v across it.
        ids.push([
          leaves.vertex(centre.clone().addScaledVector(across, -w), n, f * 0.5, 0, 0.25 + f * 0.75),
          leaves.vertex(centre.clone().addScaledVector(across, w), n, f * 0.5, 1, 0.25 + f * 0.75),
        ]);
        if (r === 0) return;
        leaves.quad(ids[r - 1][0], ids[r][0], ids[r][1], ids[r - 1][1]);
      });
    }
  }
  // The leader: two crossed sprays standing up at the top.
  leaves.light = 1;
  for (const a of [0, Math.PI / 2]) {
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const n = dir.clone();
    const p = (x, y, u, v) => leaves.vertex(new THREE.Vector3(dir.x * x, y, dir.z * x), n, u, v, 1);
    const ids = [p(-0.6, BUILT_HEIGHT - 1.6, 0, 0), p(0.6, BUILT_HEIGHT - 1.6, 0, 1), p(0.6, BUILT_HEIGHT + 0.5, 0.5, 1), p(-0.6, BUILT_HEIGHT + 0.5, 0.5, 0)];
    leaves.quad(ids[0], ids[1], ids[2], ids[3]);
  }
  // Three crossed outlines through the crown, so it has a shape from the
  // side. Each vertex's normal points out from the trunk, so the crown
  // shades round rather than as three flat boards.
  const R = 3.3;
  for (let c = 0; c < 3; c += 1) {
    const a = (c / 3) * Math.PI + random() * 0.3;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const corner = (x, y, u, v) => {
      const n = dir.clone().multiplyScalar(Math.sign(x) || 1).setY(0.45).normalize();
      leaves.light = 0.55 + 0.45 * (y / BUILT_HEIGHT);
      return leaves.vertex(new THREE.Vector3(dir.x * x, y, dir.z * x), n, u, v, 0.3 + 0.7 * (y / BUILT_HEIGHT));
    };
    const ids = [corner(-R, 0.6, 0.5, 0), corner(R, 0.6, 1, 0), corner(R, BUILT_HEIGHT + 0.4, 1, 1), corner(-R, BUILT_HEIGHT + 0.4, 0.5, 1)];
    leaves.quad(ids[0], ids[1], ids[2], ids[3]);
  }
  return { wood: wood.geometry(), leaves: leaves.geometry() };
}

function pine(seed, detail = 1) {
  const random = seeded(seed);
  const wood = new Builder();
  const leaves = new Builder();
  // A tall bare trunk with a slight lean, and a flat-topped crown of tufts.
  const top = new THREE.Vector3((random() - 0.5) * 0.8, BUILT_HEIGHT * 0.86, (random() - 0.5) * 0.8);
  limb(wood, new THREE.Vector3(0, -0.3, 0), top, 0.3, 0.1, 7, 0, 0.9);
  const crown = new THREE.Vector3(top.x, BUILT_HEIGHT * 0.8, top.z);
  const boughs = 6;
  for (let i = 0; i < boughs; i += 1) {
    const a = (i / boughs) * Math.PI * 2 + random();
    const from = new THREE.Vector3(top.x * 0.8, BUILT_HEIGHT * (0.6 + random() * 0.2), top.z * 0.8);
    const end = new THREE.Vector3(
      crown.x + Math.cos(a) * (1.8 + random()),
      from.y + 0.6 + random() * 0.9,
      crown.z + Math.sin(a) * (1.8 + random()),
    );
    limb(wood, from, end, 0.1, 0.04, 5, 0.6, 1);
    for (let k = 0; k < (detail < 1 ? 3 : 6); k += 1) {
      const centre = end.clone().add(new THREE.Vector3((random() - 0.5) * 1.8, (random() - 0.3) * 0.9, (random() - 0.5) * 1.8));
      card(leaves, centre, crown, (2.6 + random() * 0.9) * (detail < 1 ? 1.3 : 1), random, NEEDLE_SPRIGS[k % 3]);
    }
  }
  for (let k = 0; k < 10; k += 1) {
    const centre = crown.clone().add(new THREE.Vector3((random() - 0.5) * 2.6, 0.2 + random() * 1.2, (random() - 0.5) * 2.6));
    card(leaves, centre, crown, 2.8, random, NEEDLE_SPRIGS[k % 3]);
  }
  return { wood: wood.geometry(), leaves: leaves.geometry() };
}

/** What each kind of tree is grown by. */
const GROWERS = {
  broadleaf: (seed) => broadleaf(seed),
  spruce: (seed) => spruce(seed),
  pine: (seed) => pine(seed),
};

/** Foliage tints, per kind, that each tree's own tint varies around. */
const TINTS = {
  broadleaf: new THREE.Color(0.82, 0.86, 0.74),
  spruce: new THREE.Color(0.62, 0.72, 0.66),
  pine: new THREE.Color(0.75, 0.8, 0.7),
};

// ---- the materials ----------------------------------------------------------

/**
 * Sway everything above the ground in the wind: the whole tree leaning a
 * little, the outer twigs and leaves fluttering more. `sway` is a vertex
 * attribute, zero at the base of the trunk and one at the tips, so the
 * trunk does not slide over the ground it stands in.
 */
function windy(material, { flutter = 0.06, lean = 0.28 } = {}) {
  material.onBeforeCompile = (shader) => {
    // Both faces of a card are lit by the normal the card was built with. A
    // double-sided material otherwise flips it on the back, and a leaf's
    // back then faces away from the sun and draws black, speckling every
    // crown and tuft with holes.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `float faceDirection = 1.0;
      vec3 normal = normalize( vNormal );
      {
        // Never let the normal face away from the eye: seen from behind,
        // a card would otherwise reflect the sky at a grazing angle and
        // turn a whole hillside of trees white. Bent towards the eye it
        // keeps the side facing the sun that it was built with.
        vec3 toEye = normalize( vViewPosition );
        float facing = dot( normal, toEye );
        if ( facing < 0.25 ) normal = normalize( normal + toEye * ( 0.25 - facing ) );
      }
      vec3 nonPerturbedNormal = normal;`,
    );
    // Keep foliage full at a distance. A mip of a leaf's alpha averages the
    // leaf with the gaps round it, so each level down is more transparent
    // than the last and, cut at a fixed threshold, a distant tree thins to
    // its trunk. Scaling alpha up by the mip level being read keeps the
    // coverage what it was at full size.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vShade;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vShade;')
      .replace(
      '#include <alphamap_fragment>',
      `#include <alphamap_fragment>
      #ifdef USE_ALPHAMAP
      {
        vec2 texel = vAlphaMapUv * 1024.0;
        vec2 dx = dFdx(texel);
        vec2 dy = dFdy(texel);
        float mip = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
        diffuseColor.a *= 1.0 + mip * 0.22;
      }
      #endif`,
    );
    shader.uniforms.windTime = wind;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float sway;
        attribute float shade;
        varying float vShade;
        uniform float windTime;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 rooted = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
        #else
          vec2 rooted = vec2(0.0);
        #endif
        vShade = shade;
        float gust = sin(windTime * 0.37 + rooted.x * 0.013) * 0.5 + 0.5;
        float phase = windTime * 1.1 + rooted.x * 0.07 + rooted.y * 0.05;
        float bend = sway * sway;
        transformed.x += (sin(phase) * 0.6 + 0.4) * ${lean.toFixed(3)} * bend * (0.4 + gust);
        transformed.z += cos(phase * 0.83) * ${(lean * 0.6).toFixed(3)} * bend * (0.4 + gust);
        transformed += normal * sin(windTime * 5.3 + dot(transformed, vec3(1.7, 2.3, 1.3)) + rooted.x)
          * ${flutter.toFixed(3)} * sway * (0.5 + gust);`,
      );
  };
  return material;
}

function leafMaterial({ albedo, alpha }) {
  const material = windy(
    new THREE.MeshStandardMaterial({
      map: albedo,
      alphaMap: alpha,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.55,
    }),
  );
  // Soft edges on a multisampled canvas rather than a hard cut-out, which
  // also stops distant crowns thinning to nothing as the texture mips down.
  material.alphaToCoverage = true;
  return material;
}

function leafShadow({ albedo, alpha }) {
  return windy(
    new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: albedo,
      alphaMap: alpha,
      alphaTest: 0.45,
      side: THREE.DoubleSide,
    }),
  );
}

// ---- the grass -------------------------------------------------------------

/**
 * One clump: three cards of photographed tufts standing crossed at sixty
 * degrees, so it is the same clump from any side. Each card is as wide as
 * its own tuft is in the atlas for its height - stretched, a tuft reads as
 * smeared - and they are of slightly different heights, as grass is.
 */
function tuftGeometry(clump) {
  const b = new Builder();
  const up = new THREE.Vector3(0, 1, 0);
  const heights = [0.42, 0.35, 0.29];
  clump.forEach((tuft, k) => {
    const [u0, v0, u1, v1] = GRASS_TUFTS[tuft];
    const height = heights[k];
    // The atlas is square, so a texel is as wide as it is tall.
    const width = (height * (u1 - u0)) / (v1 - v0);
    const angle = (k * Math.PI) / 3;
    const dx = Math.cos(angle) * width * 0.5;
    const dz = Math.sin(angle) * width * 0.5;
    const ids = [
      b.vertex(new THREE.Vector3(-dx, 0, -dz), up, u0, v0, 0),
      b.vertex(new THREE.Vector3(dx, 0, dz), up, u1, v0, 0),
      b.vertex(new THREE.Vector3(dx, height, dz), up, u1, v1, 1),
      b.vertex(new THREE.Vector3(-dx, height, -dz), up, u0, v1, 1),
    ];
    b.quad(ids[0], ids[1], ids[2], ids[3]);
  });
  return b.geometry();
}

function decodeGround(ground) {
  const [width, height] = ground.size;
  const cells = new Uint8Array(width * height);
  const raw = atob(ground.rle);
  let at = 0;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const value = raw.charCodeAt(i);
    const run = raw.charCodeAt(i + 1);
    cells.fill(value, at, at + run);
    at += run;
  }
  return { cells, width, height, x0: ground.origin[0], z0: ground.origin[1], cell: ground.cell };
}

function hash2(x, z) {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

class Grass {
  constructor(ground, parent, textures) {
    this.ground = decodeGround(ground);
    const capacity = Math.ceil((Math.PI * GRASS_RADIUS * GRASS_RADIUS) / (GRASS_STEP * GRASS_STEP));
    const material = windy(
      new THREE.MeshStandardMaterial({
        map: textures.grass.albedo,
        alphaMap: textures.grass.alpha,
        alphaTest: 0.4,
        side: THREE.DoubleSide,
        roughness: 1,
      }),
      { flutter: 0.0, lean: 0.12 },
    );
    material.alphaToCoverage = true;
    // One mesh per kind of clump, sharing the material: three draws, and a
    // field that does not repeat one clump to the horizon.
    this.meshes = GRASS_CLUMPS.map((clump) => {
      const mesh = new THREE.InstancedMesh(tuftGeometry(clump), material, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.name = 'grass';
      parent.add(mesh);
      return mesh;
    });
    this.at = null;
    this._matrix = new THREE.Matrix4();
    this._colour = new THREE.Color();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  heightAt(x, z) {
    const g = this.ground;
    const i = Math.floor((x - g.x0) / g.cell);
    const j = Math.floor((z - g.z0) / g.cell);
    if (i < 0 || j < 0 || i >= g.width || j >= g.height) return -1;
    const code = g.cells[j * g.width + i];
    return code === 0 ? -1 : (code - 1) * 0.25;
  }

  /** Plant round `eye` (in the map's own units) if it has moved far enough,
   *  or if the quality setting has changed how far out to plant. */
  plant(eye) {
    const moved = !this.at || Math.hypot(eye.x - this.at.x, eye.z - this.at.z) >= GRASS_REPLANT;
    if (!moved && this._detail === detail.version) return;
    this.at = { x: eye.x, z: eye.z };
    this._detail = detail.version;
    const m = this._matrix;
    const counts = this.meshes.map(() => 0);
    const capacity = this.meshes[0].instanceMatrix.count;
    const radius = GRASS_RADIUS * detail.grass;
    const r2 = radius * radius;
    const i0 = Math.floor((eye.x - radius) / GRASS_STEP);
    const i1 = Math.ceil((eye.x + radius) / GRASS_STEP);
    const j0 = Math.floor((eye.z - radius) / GRASS_STEP);
    const j1 = Math.ceil((eye.z + radius) / GRASS_STEP);
    for (let i = i0; i <= i1; i += 1) {
      for (let j = j0; j <= j1; j += 1) {
        const h = hash2(i, j);
        const x = (i + hash2(j, i) - 0.5) * GRASS_STEP;
        const z = (j + h - 0.5) * GRASS_STEP;
        const d2 = (x - eye.x) ** 2 + (z - eye.z) ** 2;
        if (d2 > r2) continue;
        // Patchy, as a field is: thick in places, sparse in others.
        const patch = Math.sin(x * 0.21 + Math.cos(z * 0.13) * 2.0) * Math.cos(z * 0.17 - x * 0.05);
        if (h > 0.55 + patch * 0.4) continue;
        const y = this.heightAt(x, z);
        if (y < 0) continue;
        // Shrink to nothing at the edge of the patch rather than stopping.
        const edge = 1 - Math.sqrt(d2) / radius;
        const size = Math.min(1, edge * 5) * (0.7 + hash2(x, z) * 0.7);
        this._q.setFromAxisAngle(this._up, h * 6.28);
        m.compose(new THREE.Vector3(x, y, z), this._q, new THREE.Vector3(size, size * (0.8 + patch * 0.35), size));
        const kind = Math.floor(hash2(z * 1.7, x * 0.9) * this.meshes.length) % this.meshes.length;
        const mesh = this.meshes[kind];
        const n = counts[kind];
        if (n >= capacity) continue;
        mesh.setMatrixAt(n, m);
        const dry = 0.5 + 0.5 * Math.sin(x * 0.05 + z * 0.037);
        // Darker than the photograph, which was shot in full sun: a field
        // of it at full brightness reads as lime rather than as grass.
        this._colour.setRGB(0.5 + dry * 0.16, 0.62 + hash2(z, x) * 0.1, 0.36 - dry * 0.08);
        mesh.setColorAt(n, this._colour);
        counts[kind] = n + 1;
      }
    }
    this.meshes.forEach((mesh, kind) => {
      mesh.count = counts[kind];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }
}

// ---- smoke and birds ----------------------------------------------------------

/** Which way the wind blows, and how hard, in metres a second. */
const WIND = new THREE.Vector3(2.6, 0, 1.4);

function puffTexture() {
  const texture = canvasTexture(128, 128, (g, w, h) => {
    const random = seeded(19);
    for (let i = 0; i < 14; i += 1) {
      const x = w / 2 + (random() - 0.5) * w * 0.35;
      const y = h / 2 + (random() - 0.5) * h * 0.35;
      const r = w * (0.18 + random() * 0.16);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.35)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    }
  });
  return texture;
}

/**
 * Smoke off a chimney: puffs that rise, drift downwind, swell and thin
 * out. Sprites, so they always face the eye, and a fixed pool per chimney.
 */
class Smoke {
  constructor(parent, sources) {
    const map = puffTexture();
    this.puffs = [];
    for (const [x, y, z] of sources) {
      for (let i = 0; i < 36; i += 1) {
        const material = new THREE.SpriteMaterial({
          map,
          color: 0xd8d5ce,
          transparent: true,
          depthWrite: false,
          opacity: 0,
        });
        const sprite = new THREE.Sprite(material);
        sprite.renderOrder = 3;
        parent.add(sprite);
        this.puffs.push({ sprite, origin: new THREE.Vector3(x, y, z), age: (i / 36) * 22, life: 22, spin: Math.random() });
      }
    }
  }

  /** Drawn or not, from the quality setting. */
  show(on) {
    if (on === this.shown) return;
    this.shown = on;
    for (const puff of this.puffs) puff.sprite.visible = on;
  }

  update(dt) {
    for (const puff of this.puffs) {
      puff.age += dt;
      if (puff.age > puff.life) puff.age -= puff.life;
      const t = puff.age / puff.life;
      const rise = 2.2 * puff.age - 0.02 * puff.age * puff.age;
      puff.sprite.position.copy(puff.origin)
        .addScaledVector(WIND, puff.age * (0.4 + t * 0.6))
        .add(new THREE.Vector3(Math.sin(puff.age * 0.7 + puff.spin * 6) * 1.2, rise, Math.cos(puff.age * 0.5 + puff.spin * 6) * 1.2));
      puff.sprite.scale.setScalar(2.5 + t * 16);
      puff.sprite.material.opacity = Math.min(1, t * 8) * (1 - t) * 0.75;
      puff.sprite.material.rotation = puff.spin * 6 + puff.age * 0.05;
    }
  }
}

/** A flock wheeling over the valley: dark wings that flap and glide. */
class Birds {
  constructor(parent, count = 14) {
    const b = new Builder();
    const up = new THREE.Vector3(0, 1, 0);
    // A body and two wings, flapped in the shader by the `sway` attribute.
    const v = (x, y, z, flap) => b.vertex(new THREE.Vector3(x, y, z), up, 0, 0, flap);
    const body = [v(0, 0, 0.35, 0), v(0.06, 0, -0.3, 0), v(-0.06, 0, -0.3, 0)];
    b.index.push(body[0], body[1], body[2], body[0], body[2], body[1]);
    for (const side of [-1, 1]) {
      const w = [v(0, 0, 0.12, 0), v(0, 0, -0.12, 0), v(side * 0.75, 0, -0.18, 1), v(side * 0.55, 0, 0.12, 0.8)];
      b.quad(w[0], w[1], w[2], w[3]);
    }
    const material = new THREE.MeshBasicMaterial({ color: 0x1d1f22 });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.windTime = wind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float sway;\nuniform float windTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
          float seed = instanceMatrix[3][0] * 0.13 + instanceMatrix[3][2] * 0.07;
          #else
          float seed = 0.0;
          #endif
          float beat = sin(windTime * 9.0 + seed * 20.0);
          float gliding = step(0.0, sin(windTime * 0.6 + seed * 5.0));
          transformed.y += sway * mix(beat * 0.35, 0.05, gliding);`,
        );
    };
    this.mesh = new THREE.InstancedMesh(b.geometry(), material, count);
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
    this.birds = Array.from({ length: count }, (_, i) => ({
      radius: 45 + (i % 5) * 9 + Math.random() * 6,
      height: 42 + Math.random() * 14,
      speed: 0.16 + Math.random() * 0.05,
      phase: (i / count) * Math.PI * 2 + Math.random() * 0.3,
      centre: new THREE.Vector3(-20 + (i % 2) * 30, 0, -40 + (i % 3) * 25),
    }));
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3(1.4, 1.4, 1.4);
  }

  update(time) {
    this.birds.forEach((bird, i) => {
      const a = bird.phase + time * bird.speed;
      const x = bird.centre.x + Math.cos(a) * bird.radius;
      const z = bird.centre.z + Math.sin(a) * bird.radius;
      const y = bird.height + Math.sin(time * 0.3 + i) * 3;
      this._e.set(0, -a, Math.sin(time * 0.4 + i) * 0.25, 'YXZ');
      this._q.setFromEuler(this._e);
      this._m.compose(new THREE.Vector3(x, y, z), this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---- putting it in a map --------------------------------------------------

/**
 * Grow what `map`'s extras describe, as children of the map. Returns an
 * object whose `update(eye)` keeps the grass round the eye, or null if the
 * map describes nothing to grow.
 */
export async function growNature(map) {
  const extras = map.userData ?? {};
  const trees = Array.isArray(extras.trees) ? extras.trees : [];
  const kinds = Array.isArray(extras.tree_kinds) ? extras.tree_kinds : [];
  if (!trees.length && !extras.ground) return null;

  const group = new THREE.Group();
  group.name = 'nature';
  // Drawn, never collided with, and reaching far past the ground anybody
  // stands on: the fog is sized without it.
  group.userData.scenery = true;
  map.add(group);

  // The photographs, falling back to the painted ones if they are missing.
  const photo = async (name, fallback) => {
    try {
      return await foliageSet(name);
    } catch {
      const painted = fallback();
      return painted && { albedo: painted, alpha: null };
    }
  };
  let bark;
  try {
    bark = (await photoSet('bark')).albedo;
  } catch {
    bark = barkTexture();
  }
  const textures = {
    leaves: await photo('leaves', leafTexture),
    needles: await photo('needles', needleTexture),
    bark,
    grass: await photo('grass_blades', () => null),
  };

  if (trees.length) {
    const leafMap = textures.leaves;
    const needleMap = textures.needles;
    const paintedNeedles = { albedo: needleTexture(), alpha: null };
    const bark = windy(new THREE.MeshStandardMaterial({ map: textures.bark, roughness: 0.95 }), {
      flutter: 0,
      lean: 0.28,
    });
    const variants = {};
    for (const kind of Object.keys(GROWERS)) {
      // Spruce wears a painted spray, not the scan: the scanned fir sprigs
      // are thin twigs, and stretched over a whole branch they are mostly
      // gap - up close that reads as needles, and from across the valley
      // as a bare pole with a glitter of frost.
      const map = kind.startsWith('broadleaf')
        ? leafMap
        : kind.startsWith('spruce')
          ? paintedNeedles
          : needleMap;
      variants[kind] = [11, 23, 37].map((seed) => {
        const grown = GROWERS[kind](seed);
        return { ...grown, leafMaterial: leafMaterial(map), shadow: leafShadow(map), list: [] };
      });
    }
    for (let t = 0; t + 4 < trees.length + 1; t += 5) {
      const [x, y, z, height, kindIndex] = trees.slice(t, t + 5);
      const kind = GROWERS[kinds[kindIndex]] ? kinds[kindIndex] : 'broadleaf';
      const pick = variants[kind][Math.floor(hash2(x, z) * 3) % 3];
      pick.list.push([x, y, z, height]);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const colour = new THREE.Color();
    for (const [kind, list] of Object.entries(variants)) {
      for (const variant of list) {
        if (!variant.list.length) continue;
        const count = variant.list.length;
        const trunks = new THREE.InstancedMesh(variant.wood, bark, count);
        const crowns = new THREE.InstancedMesh(variant.leaves, variant.leafMaterial, count);
        crowns.customDepthMaterial = variant.shadow;
        variant.list.forEach(([x, y, z, height], i) => {
          const s = height / BUILT_HEIGHT;
          const wide = 0.85 + hash2(z, x) * 0.3;
          q.setFromAxisAngle(up, hash2(x * 3, z) * Math.PI * 2);
          m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s * wide, s, s * wide));
          trunks.setMatrixAt(i, m);
          crowns.setMatrixAt(i, m);
          const shade = 0.82 + hash2(x, z * 7) * 0.3;
          colour.copy(TINTS[kind]).multiplyScalar(shade);
          colour.r *= 0.92 + hash2(z, x * 5) * 0.16;
          crowns.setColorAt(i, colour);
        });
        for (const mesh of [trunks, crowns]) {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.computeBoundingSphere();
          group.add(mesh);
        }
      }
    }
  }

  const grass = extras.ground && textures.grass ? new Grass(extras.ground, group, textures) : null;
  const smoke = Array.isArray(extras.smoke) && extras.smoke.length ? new Smoke(group, extras.smoke) : null;
  const birds = trees.length ? new Birds(group) : null;
  const local = new THREE.Vector3();
  let last = wind.value;
  return {
    update(eye) {
      const dt = Math.min(0.1, Math.max(0, wind.value - last));
      last = wind.value;
      smoke?.show(detail.sky);
      if (detail.sky) smoke?.update(dt);
      if (birds) {
        birds.mesh.visible = detail.sky;
        if (detail.sky) birds.update(wind.value);
      }
      if (!grass) return;
      local.copy(eye);
      map.worldToLocal(local);
      grass.plant(local);
    },
  };
}

/** Advance the wind. Called once a frame. */
export function blow(dt) {
  wind.value += dt;
}
