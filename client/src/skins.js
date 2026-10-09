// Skins: how a soldier is dressed.
//
// Eleven of them. The first is the soldier as he came - Mixamo's grey digital
// camouflage. The other ten are Solatel's own: patterns drawn in the shader,
// in colours of our own, on the soldier's cloth, with his gear (plate carrier,
// helmet, pads, straps, boots) tinted to go with them.
//
// # How a pattern is drawn
//
// From where each point of the cloth sits on the body at rest - the mesh's
// own bind pose, in metres - not from its texture coordinates. The texture is
// cut into islands, and a pattern drawn in their space breaks at every seam;
// drawn on the body at rest it runs across the seams, and since the skeleton
// moves the cloth and not the rest pose, it stays put on a body that is
// running. Which texels are cloth is a mask made from the soldier's own
// texture (`scripts/build-skins.py`), and the cloth keeps its own folds and
// grime: the original texture, blurred until its camouflage is gone and only
// the shading is left, scales the new pattern.
//
// # What a skin may not do
//
// Hide its wearer. This is played for money, and a skin that was harder to
// see than another would be cover bought - or chosen - on top of the map's.
// So every skin's cloth is brought to the same average brightness as the
// soldier's own (`CLOTH_MEAN`), whatever its colours; what a skin changes is
// its hue and its pattern, never how dark it is. And none is drawn from a
// map's own surfaces. The gear is tinted, never darkened, the same way.
//
// A skin is a number on the wire (`net::SKINS`), on the board everybody gets
// when a match starts, and nothing reads it but this module.

import * as THREE from 'three';
import { asset } from './assets.js';
import { lightMaterial } from './light.js';

/** The soldier's material with the uniform on it; the other is his gear. */
export const CLOTH_MATERIAL = 'Ch15_body';

/** Average linear brightness of the soldier's own cloth, measured by
 *  `scripts/build-skins.py`. Every skin's cloth averages this. */
const CLOTH_MEAN = 0.1389;

/** Pattern kinds, as the shader numbers them. */
const BLOTS = 1;
const PIXELS = 2;
const STRIPES = 3;
const MOTTLE = 4;
const SPLINTER = 5;
const HEX = 6;

/**
 * Every skin: its name, what it is, the pattern, its four colours (the first
 * is the ground), how big the pattern is (one over metres), and the gear's
 * tint. How bright the colours come out is not the skin's to say: see
 * `palette`.
 */
export const SKINS = [
  { id: 0, name: 'Issue', blurb: 'The soldier as he came: grey digital camouflage.' },
  {
    id: 1, name: 'Sunstrike', blurb: 'Sand and burnt orange, blotched like dry ground at noon.',
    pattern: BLOTS, colours: ['#b49a6e', '#93723f', '#8a4a26', '#4a3a2a'],
    scale: 4.2, gear: '#7a6648',
  },
  {
    id: 2, name: 'Tidewater', blurb: 'Navy, steel and sea-glass, cut into squares.',
    pattern: PIXELS, colours: ['#4c5d72', '#6c7f92', '#2f3e52', '#43666b'],
    scale: 3.4, gear: '#2a3340',
  },
  {
    id: 3, name: 'Ember', blurb: 'Charcoal and ash, with stripes of a fire banked down.',
    pattern: STRIPES, colours: ['#4a4643', '#635d57', '#7e2c1f', '#2f2c2a'],
    scale: 4.2, gear: '#2a2726',
  },
  {
    id: 4, name: 'Reef', blurb: 'Teal water over sand and coral.',
    pattern: BLOTS, colours: ['#3f6e69', '#a39270', '#a05d4b', '#2f4a40'],
    scale: 3.6, gear: '#4b5244',
  },
  {
    id: 5, name: 'Monsoon', blurb: 'Olive and wet stone, broken into splinters by the rain.',
    pattern: SPLINTER, colours: ['#5d6545', '#757870', '#37432f', '#8a8463'],
    scale: 3.2, gear: '#4a4f3a',
  },
  {
    id: 6, name: 'Ironclad', blurb: 'Gunmetal, mottled like forged plate.',
    pattern: MOTTLE, colours: ['#565d64', '#6d747b', '#454b51', '#5f666d'],
    scale: 3.0, gear: '#2b2e33',
  },
  {
    id: 7, name: 'Savanna', blurb: 'Dry grass with the shadows of the trees in it.',
    pattern: STRIPES, colours: ['#a09670', '#8a7954', '#4f3c29', '#6d6244'],
    scale: 2.6, gear: '#76644a',
  },
  {
    id: 8, name: 'Nightfall', blurb: 'Dusk violet and ink, in squares.',
    pattern: PIXELS, colours: ['#5b5468', '#706077', '#3a3d4e', '#7a7586'],
    scale: 3.4, gear: '#2c2a33',
  },
  {
    id: 9, name: 'Basalt', blurb: 'Black rock and grey ash with the glow still in the cracks.',
    pattern: MOTTLE, colours: ['#55524f', '#75716c', '#a3501f', '#3a3836'],
    scale: 3.4, gear: '#2d2b2a',
  },
  {
    id: 10, name: 'Jade', blurb: 'Green stone cut into a honeycomb.',
    pattern: HEX, colours: ['#507a66', '#3a5c4c', '#6f977f', '#2e4a3c'],
    scale: 9.0, gear: '#34413a',
  },
];

const SKIN_KEY = 'solatel.skin';

/** The skin this browser last chose. */
export function storedSkin() {
  try {
    const value = Number(window.localStorage.getItem(SKIN_KEY));
    if (Number.isInteger(value) && value >= 0 && value < SKINS.length) return value;
  } catch {
    /* private browsing */
  }
  return 0;
}

export function storeSkin(id) {
  try {
    window.localStorage.setItem(SKIN_KEY, String(id));
  } catch {
    /* private browsing */
  }
}

/** Linear brightness of a linear colour. */
const luminance = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * A skin's four colours in linear light, brought together to `CLOTH_MEAN`.
 *
 * How bright a pattern averages depends on how much of each colour it
 * shows, which is the pattern's to decide, not anybody's guess: guessed, the
 * skins came out up to a fifth darker than the soldier's own. So the
 * pattern is drawn here, in JavaScript - the same arithmetic as the shader -
 * at a few thousand points over a body's worth of space, and the colours
 * scaled so its average brightness is exactly the soldier's own.
 */
function palette(skin) {
  const colours = skin.colours.map((hex) => new THREE.Color(hex));
  const k = (CLOTH_MEAN * ON_SCREEN) / Math.max(meanBrightness(skin, colours), 1e-4);
  return colours.map((c) => c.multiplyScalar(k));
}

/**
 * How much brighter than the soldier's own a skin's cloth has to be, on
 * average and before the light, to look as bright once drawn. The soldier's
 * camouflage is grey blocks of strong contrast, and the tone curve every
 * frame passes through lifts strong contrast more than it lifts colour: at
 * the same average, ten skins drawn on the soldier came out 5 to 19% darker
 * than his own, 12% on average. Measured on the menu's own pictures of him
 * (`soldierPortraits`), all of him, gear and all.
 */
const ON_SCREEN = 1.18;

/** How bright a skin's cloth averages, as drawn: for its test. */
export function clothBrightness(id) {
  const skin = SKINS[id];
  if (!skin?.colours) return CLOTH_MEAN;
  return meanBrightness(skin, palette(skin));
}

/** The average linear brightness of `skin` in `colours`, sampled over a
 *  standing body's worth of space, every way the cloth can face. */
function meanBrightness(skin, colours) {
  let seed = 1;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const SAMPLES = 3000;
  let sum = 0;
  for (let i = 0; i < SAMPLES; i += 1) {
    const p = [(random() - 0.5) * 1.6, random() * 1.8, (random() - 0.5) * 0.5];
    const facing = [random() - 0.5, random() - 0.5, random() - 0.5];
    sum += luminance(patternColour(skin, colours, p, facing));
  }
  return sum / SAMPLES;
}

// The shader's pattern, in JavaScript, for `meanBrightness` alone. Keep the
// two in step: what is measured here is what is drawn there.
const fract = (x) => x - Math.floor(x);
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const step = (edge, x) => (x < edge ? 0 : 1);
function hash3(x, y, z) {
  let a = fract(x * 0.3183099 + 0.71) * 17;
  let b = fract(y * 0.3183099 + 0.113) * 17;
  let c = fract(z * 0.3183099 + 0.419) * 17;
  return fract(a * b * c * (a + b + c));
}
function noise3(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  let fx = x - ix;
  let fy = y - iy;
  let fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const h = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz);
  return mix(
    mix(mix(h(0, 0, 0), h(1, 0, 0), fx), mix(h(0, 1, 0), h(1, 1, 0), fx), fy),
    mix(mix(h(0, 0, 1), h(1, 0, 1), fx), mix(h(0, 1, 1), h(1, 1, 1), fx), fy),
    fz,
  );
}
function fbm3(x, y, z) {
  let sum = 0;
  let amp = 0.5;
  for (let i = 0; i < 4; i += 1) {
    sum += amp * noise3(x, y, z);
    x = x * 2.03 + 11.7;
    y = y * 2.03 + 3.1;
    z = z * 2.03 + 7.9;
    amp *= 0.5;
  }
  return sum / 0.9375;
}
/** Mixes colours by weight into a fresh colour, the way `mix` does. */
function blend(a, b, t) {
  return new THREE.Color(mix(a.r, b.r, t), mix(a.g, b.g, t), mix(a.b, b.b, t));
}
function patternColour(skin, [c0, c1, c2, c3], [px, py, pz], facing) {
  const s = skin.scale;
  const [qx, qy, qz] = [px * s, py * s, pz * s];
  switch (skin.pattern) {
    case BLOTS: {
      const a = fbm3(qx, qy, qz);
      const b = fbm3(qx * 1.6 + 31, qy * 1.6 + 31, qz * 1.6 + 31);
      let c = blend(c0, c1, smoothstep(0.49, 0.51, a));
      c = blend(c, c2, smoothstep(0.6, 0.62, b));
      return blend(c, c3, smoothstep(0.62, 0.64, a) * smoothstep(0.4, 0.42, b));
    }
    case PIXELS: {
      const [cx, cy, cz] = [Math.floor(qx * 7) / 7, Math.floor(qy * 7) / 7, Math.floor(qz * 7) / 7];
      const a = fbm3(cx, cy, cz) + (hash3(cx * 37, cy * 37, cz * 37) - 0.5) * 0.18;
      const b = fbm3(cx * 1.8 + 7, cy * 1.8 + 7, cz * 1.8 + 7);
      let c = blend(c0, c1, step(0.5, a));
      c = blend(c, c2, step(0.6, a));
      return blend(c, c3, step(0.63, b));
    }
    case STRIPES: {
      const warp = fbm3(qx * 0.8, qy * 0.8, qz * 0.8) * 2.6;
      const wave = Math.sin((py + px * 0.35 + pz * 0.25) * s * 7 + warp * 3);
      const broken = smoothstep(0.38, 0.42, fbm3(qx * 2.2 + 5, qy * 2.2 + 5, qz * 2.2 + 5));
      let c = blend(c0, c1, smoothstep(0.52, 0.54, fbm3(qx + 3, qy + 3, qz + 3)));
      c = blend(c, c3, smoothstep(0.66, 0.68, fbm3(qx * 1.3 + 9, qy * 1.3 + 9, qz * 1.3 + 9)));
      return blend(c, c2, smoothstep(0.5, 0.6, wave) * broken);
    }
    case MOTTLE: {
      const a = fbm3(qx * 2, qy * 2, qz * 2);
      const b = fbm3(qx * 6 + 2, qy * 6 + 2, qz * 6 + 2);
      let c = blend(c0, c1, smoothstep(0.4, 0.7, a));
      c = blend(c, c2, smoothstep(0.62, 0.75, b) * 0.8);
      return blend(c, c3, smoothstep(0.7, 0.8, a));
    }
    case SPLINTER: {
      const rx = (px * 0.8 + py * 0.6) * s;
      const ry = (py * 0.8 - px * 0.6) * s;
      const rz = pz * s;
      const w = fbm3(rx, ry, rz) * 1.2;
      const [sx, sy, sz] = [Math.floor(rx * 1.6 + w), Math.floor(ry * 5 + w), Math.floor(rz * 1.6 + w)];
      const a = hash3(sx, sy, sz);
      const b = hash3(sx + 13, sy + 13, sz + 13);
      let c = blend(c0, c1, step(0.55, a));
      c = blend(c, c2, step(0.75, a));
      return blend(c, c3, step(0.85, b));
    }
    case HEX: {
      const [nx, ny, nz] = facing.map(Math.abs);
      const [u, v] = nx > ny && nx > nz ? [pz, py] : ny > nz ? [px, pz] : [px, py];
      const [hx, hy] = [u * s, v * s];
      const r = [1, 1.7320508];
      const mod = (x, m) => x - m * Math.floor(x / m);
      const a = [mod(hx, r[0]) - 0.5, mod(hy, r[1]) - r[1] * 0.5];
      const b = [mod(hx - 0.5, r[0]) - 0.5, mod(hy - r[1] * 0.5, r[1]) - r[1] * 0.5];
      const g = a[0] * a[0] + a[1] * a[1] < b[0] * b[0] + b[1] * b[1] ? a : b;
      const id = [hx - g[0], hy - g[1]];
      const edge = 0.5 - Math.max(Math.abs(g[0]) * 0.5 + Math.abs(g[1]) * 0.8660254, Math.abs(g[0]));
      let c = blend(c0, c2, step(0.72, hash3(id[0], id[1], 1)));
      c = blend(c, c3, step(0.85, hash3(id[0], id[1], 2)));
      return blend(c1, c, smoothstep(0.03, 0.06, edge));
    }
    default:
      return c0;
  }
}

let mask = null;

/** Loads the cloth mask; skins wait for it. */
export async function loadSkins() {
  if (mask) return mask;
  mask = await new THREE.TextureLoader().loadAsync(asset('assets/characters/soldier-cloth.webp'));
  mask.colorSpace = THREE.NoColorSpace;
  mask.flipY = false;
  return mask;
}

const CHUNKS = /* glsl */ `
uniform sampler2D skinMask;
uniform vec3 skinColours[4];
uniform float skinScale;
uniform int skinPattern;
uniform float skinUnit;
uniform float skinCloth;
uniform vec3 skinGear;
varying vec3 vSkinRest;
varying vec3 vSkinFacing;

float skinHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float skinNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(skinHash(i), skinHash(i + vec3(1, 0, 0)), f.x),
        mix(skinHash(i + vec3(0, 1, 0)), skinHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(skinHash(i + vec3(0, 0, 1)), skinHash(i + vec3(1, 0, 1)), f.x),
        mix(skinHash(i + vec3(0, 1, 1)), skinHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float skinFbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * skinNoise(p);
    p = p * 2.03 + vec3(11.7, 3.1, 7.9);
    amp *= 0.5;
  }
  return sum / 0.9375;
}
vec3 skinPatternColour(vec3 p) {
  vec3 c0 = skinColours[0];
  vec3 c1 = skinColours[1];
  vec3 c2 = skinColours[2];
  vec3 c3 = skinColours[3];
  vec3 q = p * skinScale;
  if (skinPattern == ${BLOTS}) {
    float a = skinFbm(q);
    float b = skinFbm(q * 1.6 + vec3(31.0));
    vec3 c = mix(c0, c1, smoothstep(0.49, 0.51, a));
    c = mix(c, c2, smoothstep(0.6, 0.62, b));
    return mix(c, c3, smoothstep(0.62, 0.64, a) * smoothstep(0.4, 0.42, b));
  }
  if (skinPattern == ${PIXELS}) {
    vec3 cell = floor(q * 7.0) / 7.0;
    float a = skinFbm(cell) + (skinHash(cell * 37.0) - 0.5) * 0.18;
    float b = skinFbm(cell * 1.8 + vec3(7.0));
    vec3 c = mix(c0, c1, step(0.5, a));
    c = mix(c, c2, step(0.6, a));
    return mix(c, c3, step(0.63, b));
  }
  if (skinPattern == ${STRIPES}) {
    float warp = skinFbm(q * 0.8) * 2.6;
    float s = sin((p.y * 1.0 + p.x * 0.35 + p.z * 0.25) * skinScale * 7.0 + warp * 3.0);
    float broken = smoothstep(0.38, 0.42, skinFbm(q * 2.2 + vec3(5.0)));
    vec3 c = mix(c0, c1, smoothstep(0.52, 0.54, skinFbm(q + vec3(3.0))));
    c = mix(c, c3, smoothstep(0.66, 0.68, skinFbm(q * 1.3 + vec3(9.0))));
    return mix(c, c2, smoothstep(0.5, 0.6, s) * broken);
  }
  if (skinPattern == ${MOTTLE}) {
    float a = skinFbm(q * 2.0);
    float b = skinFbm(q * 6.0 + vec3(2.0));
    vec3 c = mix(c0, c1, smoothstep(0.4, 0.7, a));
    c = mix(c, c2, smoothstep(0.62, 0.75, b) * 0.8);
    return mix(c, c3, smoothstep(0.7, 0.8, a));
  }
  if (skinPattern == ${SPLINTER}) {
    vec3 r = vec3(p.x * 0.8 + p.y * 0.6, p.y * 0.8 - p.x * 0.6, p.z) * skinScale;
    vec3 shard = floor(r * vec3(1.6, 5.0, 1.6) + skinFbm(r) * 1.2);
    float a = skinHash(shard);
    float b = skinHash(shard + vec3(13.0));
    vec3 c = mix(c0, c1, step(0.55, a));
    c = mix(c, c2, step(0.75, a));
    return mix(c, c3, step(0.85, b));
  }
  if (skinPattern == ${HEX}) {
    // A honeycomb, laid on whichever plane the cloth faces most nearly at
    // rest: a sleeve held out, a chest, the top of a shoulder.
    vec3 n = abs(vSkinFacing);
    vec2 plane = n.x > n.y && n.x > n.z ? p.zy : n.y > n.z ? p.xz : p.xy;
    vec2 h = plane * skinScale;
    vec2 r = vec2(1.0, 1.7320508);
    vec2 a = mod(h, r) - r * 0.5;
    vec2 b = mod(h - r * 0.5, r) - r * 0.5;
    vec2 g = dot(a, a) < dot(b, b) ? a : b;
    vec2 id = h - g;
    float edge = 0.5 - max(abs(g.x) * 0.5 + abs(g.y) * 0.8660254, abs(g.x));
    vec3 c = mix(c0, c2, step(0.72, skinHash(vec3(id, 1.0))));
    c = mix(c, c3, step(0.85, skinHash(vec3(id, 2.0))));
    return mix(c1, c, smoothstep(0.03, 0.06, edge));
  }
  return c0;
}
`;

const MAP_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  vec3 skinned = sampledDiffuseColor.rgb;
  // The gear, tinted to the skin: its own brightness, the skin's hue.
  float gearLight = dot( skinned, vec3( 0.2126, 0.7152, 0.0722 ) );
  float tintLight = max( dot( skinGear, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
  skinned = mix( skinned, skinGear * ( gearLight / tintLight ), 0.55 );
  if ( skinCloth > 0.5 ) {
    float cloth = texture2D( skinMask, vMapUv ).r;
    if ( cloth > 0.003 ) {
      // The cloth's folds and grime, its camouflage blurred away.
      vec3 blurred = texture2D( map, vMapUv, 3.5 ).rgb;
      float fold = clamp( dot( blurred, vec3( 0.2126, 0.7152, 0.0722 ) ) / ${CLOTH_MEAN.toFixed(4)}, 0.3, 1.9 );
      skinned = mix( skinned, skinPatternColour( vSkinRest * skinUnit ) * fold, cloth );
    }
  }
  diffuseColor *= vec4( skinned, sampledDiffuseColor.a );
#endif
`;

/** Each base material's skinned copies, by skin. */
const DRESSED = new WeakMap();

/**
 * `material` (one of the soldier's) dressed in skin `id`: a copy with the
 * pattern and the tint in its shader, made once and shared by everybody in
 * that skin. Skin 0, and anything before the mask is in, is the material
 * itself. `unit` is metres per unit of the soldier's mesh, and `cloth`
 * whether this material is the one with the uniform on it.
 */
export function dressed(material, id, { unit, cloth }) {
  const skin = SKINS[id];
  if (!skin?.pattern || !mask) return material;
  let copies = DRESSED.get(material);
  if (!copies) {
    copies = new Map();
    DRESSED.set(material, copies);
  }
  if (copies.has(id)) return copies.get(id);
  const copy = material.clone();
  const uniforms = {
    skinMask: { value: mask },
    skinColours: { value: palette(skin) },
    skinScale: { value: skin.scale },
    skinPattern: { value: skin.pattern },
    skinUnit: { value: unit },
    skinCloth: { value: cloth ? 1 : 0 },
    skinGear: { value: new THREE.Color(skin.gear) },
  };
  copy.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSkinRest;\nvarying vec3 vSkinFacing;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkinRest = position;\nvSkinFacing = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CHUNKS}`)
      .replace('#include <map_fragment>', MAP_FRAGMENT);
  };
  // One program for every skin: they differ only in their uniforms.
  copy.customProgramCacheKey = () => `solatel-skin-${cloth ? 1 : 0}`;
  // A copy has lost the baked light the soldier's own materials carry.
  lightMaterial(copy);
  copies.set(id, copy);
  return copy;
}
