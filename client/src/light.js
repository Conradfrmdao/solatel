// Baked light: what reaches each part of a map from the sky and back off the
// map itself, and whether the sun does.
//
// `scripts/bake-light.py` traces it offline into a grid of cells over the
// whole map, half a metre to a metre on a side, and this puts it into the
// map's shading: every pixel looks up the cell it is in by its world
// position - the maps have no texture coordinates, so a grid that needs none
// is the shape that fits.
//
// A cell holds the light arriving there, as a colour and the way it leans:
// the sky's - its photograph with the sun taken out, because the sun is the
// directional light - and what the map's own surfaces send back, the sun's
// off the ground and walls it lands on and the sky's off everything. On the
// map's surfaces it replaces the environment map's diffuse light and the fill
// lights, none of which knew what stands in the way: a room is lit by what
// comes in at its door, the foot of a wall is darker than its top, and the
// side of a building facing a sunlit yard is lit warm by it.
//
// Two more numbers a cell: whether the sun gets there, for past the edge of
// the shadow map, and how much sky it sees, for dimming reflections where
// there is nothing to reflect.
//
// Nothing here decides anything; it is paint.

import * as THREE from 'three';
import { asset } from './assets.js';

/** How far the real-time shadow reaches from where it is centred, in
 *  metres: `SHADOW_EXTENT` in `world.js`. Past most of it the baked sun
 *  takes over. */
export const SHADOW_REACH = 34;

/** Where the real-time shadow box is centred, kept up to date by `world.js`. */
export const SHADOW_CENTRE = { value: new THREE.Vector3() };

function volume(data, dims) {
  const texture = new THREE.Data3DTexture(data, dims[0], dims[1], dims[2]);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** The light for a map with nothing baked: the shader's own, as before. */
function none() {
  return {
    lightVolumeA: volume(new Uint8Array([0, 0, 0, 255]), [1, 1, 1]),
    lightVolumeB: volume(new Uint8Array([128, 128, 128, 255]), [1, 1, 1]),
    lightVolumeMin: new THREE.Vector3(-1, -1, -1),
    lightVolumeSize: new THREE.Vector3(2, 2, 2),
    lightVolumeCell: 1,
    lightVolumeBrightest: 0,
    lightVolumeFloor: new THREE.Vector3(),
    lightVolumeStrength: 0,
    lightVolumeGround: 1,
  };
}

/**
 * The light of the map on screen, as uniforms every material lit by it
 * shares - the map's own and everything standing on it - so showing another
 * map changes their values and recompiles nothing (`useLight`).
 */
const NONE = none();
export const LIGHT = Object.fromEntries(Object.entries(NONE).map(([name, value]) => [name, { value }]));
LIGHT.lightShadowCentre = SHADOW_CENTRE;

/**
 * The baked light where `position` is, worked out on the CPU, for what is
 * drawn outside the world's scene - the rifle in the player's own hands: how
 * much falls from above, as a share of what open ground gets (1 in the open,
 * less under a roof), and how much of the sun gets there (0 to 1). Both 1
 * where nothing is baked.
 */
export function lightHere(position, out = { sky: 1, sun: 1 }) {
  if (!LIGHT.lightVolumeStrength.value) {
    out.sky = 1;
    out.sun = 1;
    return out;
  }
  const a = LIGHT.lightVolumeA.value.image;
  const b = LIGHT.lightVolumeB.value.image;
  const min = LIGHT.lightVolumeMin.value;
  const cell = LIGHT.lightVolumeCell.value;
  const dims = [a.width, a.height, a.depth];
  // Trilinear, between cell centres, as the GPU filters the texture.
  const at = [(position.x - min.x) / cell - 0.5, (position.y - min.y) / cell - 0.5, (position.z - min.z) / cell - 0.5];
  const base = at.map((u, i) => Math.min(Math.max(Math.floor(u), 0), dims[i] - 1));
  const frac = at.map((u, i) => Math.min(Math.max(u - base[i], 0), 1));
  const colour = [0, 0, 0, 0];
  let lean = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    let weight = 1;
    let index = 0;
    for (let axis = 2; axis >= 0; axis -= 1) {
      const up = (corner >> axis) & 1;
      const i = Math.min(base[axis] + up, dims[axis] - 1);
      weight *= up ? frac[axis] : 1 - frac[axis];
      index = index * dims[axis] + i;
    }
    for (let c = 0; c < 4; c += 1) colour[c] += a.data[index * 4 + c] * weight;
    lean += b.data[index * 4 + 1] * weight;
  }
  const brightest = LIGHT.lightVolumeBrightest.value;
  const shape = Math.max(0, 1 + (lean / 255) * 4 - 2);
  let fromAbove = 0;
  const weights = [0.2126, 0.7152, 0.0722];
  for (let c = 0; c < 3; c += 1) fromAbove += (colour[c] / 255) ** 2 * brightest * shape * weights[c];
  out.sky = fromAbove / LIGHT.lightVolumeGround.value;
  out.sun = colour[3] / 255;
  return out;
}

/** Lights everything with `light`, from `loadLight`; null for none. */
export function useLight(light) {
  for (const [name, value] of Object.entries(light ?? NONE)) LIGHT[name].value = value;
}

/** The file a map's light is read from, if it has been baked. */
export function lightFiles(mapName) {
  try {
    return [asset(`assets/light/${mapName}.bin`)];
  } catch {
    return [];
  }
}

/**
 * A map's baked light, for `useLight`; null if it has none, and it is then
 * lit as it was before there was any. `sky` is the map's entry in `SKIES`:
 * the light was added up for one strength of sun and sky, and says so if it
 * is drawn under another.
 */
export async function loadLight(mapName, sky) {
  const [url] = lightFiles(mapName);
  if (!url) return null;
  let bytes;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status}`);
    bytes = await response.arrayBuffer();
  } catch (err) {
    console.warn(`baked light for ${mapName} unavailable:`, err);
    return null;
  }
  const view = new DataView(bytes);
  const magic = String.fromCharCode(...new Uint8Array(bytes, 0, 4));
  if (magic !== 'SLV2') {
    console.warn(`baked light for ${mapName} is not a light volume this client reads`);
    return null;
  }
  const dims = [view.getUint16(4, true), view.getUint16(6, true), view.getUint16(8, true)];
  const min = new THREE.Vector3(view.getFloat32(12, true), view.getFloat32(16, true), view.getFloat32(20, true));
  const cell = view.getFloat32(24, true);
  const brightest = view.getFloat32(28, true);
  const baked = { sun: view.getFloat32(32, true), sky: view.getFloat32(36, true), sunColour: view.getUint32(40, true) };
  if (
    sky &&
    (Math.abs(baked.sun - sky.sun) > 1e-3 || Math.abs(baked.sky - sky.sky) > 1e-3 || baked.sunColour !== sky.sunColour)
  ) {
    console.warn(`baked light for ${mapName} was added up for another sky; run scripts/bake-light.py ${mapName}`);
  }
  const floor = new THREE.Vector3(view.getFloat32(44, true), view.getFloat32(48, true), view.getFloat32(52, true));
  const ground = view.getFloat32(56, true);
  const cells = dims[0] * dims[1] * dims[2];
  if (bytes.byteLength !== 64 + cells * 8) {
    console.warn(`baked light for ${mapName} is the wrong size`);
    return null;
  }
  // Eight planes of a byte a cell, each row as differences along x: summed
  // back and laid side by side as the two textures' four channels.
  const planes = new Uint8Array(bytes, 64);
  const a = new Uint8Array(cells * 4);
  const b = new Uint8Array(cells * 4);
  const row = dims[0];
  for (let plane = 0; plane < 8; plane += 1) {
    const into = plane < 4 ? a : b;
    const channel = plane % 4;
    const from = plane * cells;
    for (let start = 0; start < cells; start += row) {
      let value = 0;
      for (let x = 0; x < row; x += 1) {
        value = (value + planes[from + start + x]) & 255;
        into[(start + x) * 4 + channel] = value;
      }
    }
  }
  return {
    lightVolumeA: volume(a, dims),
    lightVolumeB: volume(b, dims),
    lightVolumeMin: min,
    lightVolumeSize: new THREE.Vector3(dims[0], dims[1], dims[2]).multiplyScalar(cell),
    lightVolumeCell: cell,
    lightVolumeBrightest: brightest,
    lightVolumeFloor: floor,
    lightVolumeStrength: 1,
    lightVolumeGround: ground,
  };
}

/** Declarations the fragment shader needs, after `#include <common>`;
 *  `position` names the varying that holds the world position. */
export const lightDeclarations = (position) => `
  #define LIGHT_POSITION ${position}
  uniform highp sampler3D lightVolumeA;
  uniform highp sampler3D lightVolumeB;
  uniform vec3 lightVolumeMin;
  uniform vec3 lightVolumeSize;
  uniform float lightVolumeCell;
  uniform float lightVolumeBrightest;
  uniform vec3 lightVolumeFloor;
  uniform float lightVolumeStrength;
  uniform vec3 lightShadowCentre;
  // The light arriving at this pixel off the sky and the map, whether the
  // sun gets here, and how much of the sky is in view.
  vec3 lightVolumeLight = vec3(0.0);
  float lightVolumeSun = 1.0;
  float lightVolumeOpen = 1.0;
`;

/**
 * Before the lights are summed (it goes in front of `LIGHTS_FRAGMENT_BEGIN`):
 * read this pixel's cell - off the surface, along the face's own normal, so
 * the cell read is the air the surface faces and not the inside of the wall
 * it is on - and the light it holds for the way this pixel faces, bumps and
 * all.
 */
export const LIGHT_BEFORE_LIGHTS = `
  {
    vec3 n = normalize(inverseTransformDirection(normal, viewMatrix));
    vec3 face = normalize(inverseTransformDirection(nonPerturbedNormal, viewMatrix));
    // A cell out, and a cell and a half from anything facing up: the texture
    // is filtered between cells, so a read any nearer takes in the cells
    // behind the surface too - the sealed attic under a pitched roof, the
    // gap behind cladding - and their dark comes through it. Nothing is
    // ever sealed above a roof or a floor, so those can afford to look
    // further.
    float reach = lightVolumeCell * mix(1.0, 1.5, smoothstep(0.3, 0.8, face.y));
    vec3 at = (LIGHT_POSITION + face * reach - lightVolumeMin) / lightVolumeSize;
    vec4 colour = texture(lightVolumeA, at);
    vec4 lean = texture(lightVolumeB, at);
    float shape = max(0.0, 1.0 + dot(lean.xyz * 4.0 - 2.0, n));
    lightVolumeLight = colour.rgb * colour.rgb * lightVolumeBrightest * shape;
    // Never darker than the floor, met softly.
    lightVolumeLight = sqrt(lightVolumeLight * lightVolumeLight + lightVolumeFloor * lightVolumeFloor);
    lightVolumeOpen = mix(1.0, lean.w, lightVolumeStrength);
    // The baked sun only past most of the shadow map's reach, where it has
    // nothing to say: nearer in, the real shadow is sharper and moves.
    vec2 off = abs(LIGHT_POSITION.xz - lightShadowCentre.xz);
    float beyond = smoothstep(${(SHADOW_REACH * 0.7).toFixed(1)}, ${(SHADOW_REACH * 0.95).toFixed(1)}, max(off.x, off.y));
    lightVolumeSun = mix(1.0, colour.a, beyond * lightVolumeStrength);
  }
`;

/**
 * The directional lights: the sun - the one that casts a shadow - is cut by
 * the baked sun; any other is a stand-in for light bounced in off the
 * ground, which the bake has the real thing of, and goes.
 */
const SHADOW_LINE = /(directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ i \][^\n]*\n\s*#endif)/;
if ((THREE.ShaderChunk.lights_fragment_begin.match(new RegExp(SHADOW_LINE, 'g')) ?? []).length !== 1) {
  throw new Error('three.js lights_fragment_begin has changed; light.js cannot find the sun');
}
export const LIGHTS_FRAGMENT_BEGIN = THREE.ShaderChunk.lights_fragment_begin.replace(
  SHADOW_LINE,
  `$1
    #if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
    directLight.color *= lightVolumeSun;
    #else
    directLight.color *= 1.0 - lightVolumeStrength;
    #endif`,
);

/** After the environment is read: the baked light in place of its diffuse
 *  light, and of the ambient and hemisphere lights. */
export const LIGHT_INDIRECT = `
  #include <lights_fragment_maps>
  #if defined( RE_IndirectDiffuse )
  iblIrradiance = mix(iblIrradiance, lightVolumeLight, lightVolumeStrength);
  irradiance *= 1.0 - lightVolumeStrength;
  #endif
`;

/** After the lights: reflections dimmed where little of the sky is in view. */
export const LIGHT_OCCLUSION = `
  #include <aomap_fragment>
  #if defined( USE_ENVMAP ) && defined( STANDARD )
  {
    float lightDotNV = saturate(dot(geometryNormal, geometryViewDir));
    reflectedLight.indirectSpecular *= computeSpecularOcclusion(lightDotNV, lightVolumeOpen, material.roughness);
  }
  #endif
`;

/** Every material `lightMaterial` has already changed. */
const LIT = new WeakSet();

/** Where a vertex is in the world, as `worldpos_vertex` works it out. */
const WORLD_POSITION = `
  {
    vec4 lightWorld = vec4(transformed, 1.0);
    #ifdef USE_BATCHING
    lightWorld = batchingMatrix * lightWorld;
    #endif
    #ifdef USE_INSTANCING
    lightWorld = instanceMatrix * lightWorld;
    #endif
    vLightWorld = (modelMatrix * lightWorld).xyz;
  }
`;

/**
 * Lights something that stands on a map rather than being part of it - a
 * player, a car, a tree - with the map's baked light as well, so nothing in
 * a dark room is lit as if it stood in the open, and a soldier by a sunlit
 * wall takes its warmth. Returns the material, changed in place; anything
 * else using it is lit the same way.
 */
export function lightMaterial(material) {
  // Not a mark in `userData`, which `clone` copies: a copy of a lit material
  // has lost the shader changes and has to be lit again.
  if (LIT.has(material)) return material;
  LIT.add(material);
  const before = material.onBeforeCompile;
  // A program is shared by every material with the same key, and the
  // default key is the source of `onBeforeCompile` - this one's, now, the
  // same for all - so the key keeps what the material was keyed on before.
  const own = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey')
    ? material.customProgramCacheKey
    : null;
  const beforeKey = before ? before.toString() : '';
  material.onBeforeCompile = function onBeforeCompile(shader, renderer) {
    if (before) before.call(this, shader, renderer);
    Object.assign(shader.uniforms, LIGHT);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLightWorld;')
      .replace('#include <project_vertex>', `#include <project_vertex>\n${WORLD_POSITION}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vLightWorld;\n${lightDeclarations('vLightWorld')}`)
      .replace('#include <lights_fragment_begin>', LIGHT_BEFORE_LIGHTS + LIGHTS_FRAGMENT_BEGIN)
      .replace('#include <lights_fragment_maps>', LIGHT_INDIRECT)
      .replace('#include <aomap_fragment>', LIGHT_OCCLUSION);
  };
  material.customProgramCacheKey = function customProgramCacheKey() {
    return `${own ? own.call(this) : beforeKey}|baked-light`;
  };
  material.needsUpdate = true;
  return material;
}
