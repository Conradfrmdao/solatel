// Photographic surfaces: scanned CC0 materials laid onto the maps.
//
// The maps have no texture coordinates - every face is a flat colour, and
// the facility's are generated in metres - so each surface is textured by
// *triplanar* projection: the texture is laid along whichever world axis a
// face looks down, at a fixed number of metres per repeat. Walls get the
// texture standing up, floors get it lying down, and a wall that turns a
// corner carries on without a seam. The normal map goes the same way (the
// "whiteout" blend), so light rakes across the joints in a concrete panel
// and the ribs in a steel sheet as it would across the real thing.
//
// Which surface wears which photograph is keyed on the material's name, the
// same contract `SURFACES` in `world.js` keys its weathering on. The colour
// is the map's: each photograph is tinted towards the palette colour by
// `tint`, so the olive plaster stays olive and the maroon barn stays maroon
// - the texture brings the grain, the map keeps its look.
//
// Nothing here decides anything; it is paint.

import * as THREE from 'three';
import { asset } from './assets.js';

/**
 * Surface name -> [photo set, metres per repeat, how far towards the
 * palette colour (0 keeps the photograph's own colour, 1 is fully the
 * map's), how deep the normal map reads].
 */
export const PHOTO = {
  concrete: ['concrete_wall', 3.0, 0.45, 1.0],
  concrete_light: ['concrete_wall', 3.0, 0.45, 1.0],
  concrete_dark: ['concrete_floor', 3.5, 0.5, 0.8],
  silo: ['concrete_wall', 3.0, 0.4, 1.0],
  asphalt: ['asphalt', 4.0, 0.25, 0.8],
  plaster_tan: ['plaster', 3.0, 0.9, 1.0],
  plaster_olive: ['plaster', 3.0, 0.9, 1.0],
  plaster_maroon: ['plaster', 3.0, 0.9, 1.0],
  plaster_sand: ['plaster', 3.0, 0.9, 1.0],
  brick: ['brick', 2.4, 0.4, 1.0],
  roof_metal: ['corrugated', 2.4, 0.55, 1.2],
  roof_tiles: ['roof_tiles', 2.2, 0.35, 1.2],
  cladding: ['corrugated', 2.4, 0.8, 1.2],
  cladding_cream: ['corrugated', 2.4, 0.8, 1.2],
  cladding_blue: ['corrugated', 2.4, 0.8, 1.2],
  frame: ['metal_plate', 1.5, 0.9, 0.6],
  rack_blue: ['metal_plate', 1.5, 0.9, 0.6],
  cardboard: ['concrete_floor', 1.2, 0.95, 0.3],
  frame_dark: ['painted_metal', 1.5, 0.9, 0.6],
  container_rust: ['container', 2.6, 0.85, 1.2],
  container_blue: ['container', 2.6, 0.85, 1.2],
  container_grey: ['container', 2.6, 0.85, 1.2],
  container_olive: ['container', 2.6, 0.85, 1.2],
  steel: ['rusty_metal', 2.0, 0.5, 1.0],
  steel_stair: ['metal_plate', 1.2, 0.55, 1.2],
  tank_white: ['metal_plate', 3.5, 0.9, 0.6],
  barrel_rust: ['painted_metal', 1.2, 0.9, 1.0],
  barrel_olive: ['painted_metal', 1.2, 0.9, 1.0],
  barrel_blue: ['painted_metal', 1.2, 0.9, 1.0],
  crate_olive: ['painted_metal', 1.5, 0.9, 1.0],
  crate_rust: ['rusty_metal', 1.5, 0.6, 1.0],
  stripe_red: ['painted_metal', 2.0, 0.9, 0.8],
  warning: ['painted_metal', 2.0, 0.9, 0.8],
  wood: ['planks', 2.0, 0.6, 1.0],
  wood_dark: ['planks', 2.0, 0.6, 1.0],
  wood_pallet: ['planks', 1.2, 0.6, 1.0],
  grass: ['grass', 2.6, 0.75, 0.9],
  meadow: ['grass', 7.0, 0.8, 0.8],
  grass_dry: ['dry_grass', 3.0, 0.6, 0.8],
  dirt: ['dirt', 3.0, 0.3, 0.9],
  gravel: ['gravel', 2.2, 0.25, 1.0],
  shore: ['shore', 5.0, 0.3, 0.9],
  rock: ['cliff', 7.0, 0.3, 1.2],
  rock_dark: ['cliff', 7.0, 0.45, 1.2],
  bark: ['bark', 1.5, 0.3, 1.0],
};

const cache = new Map();

/** The average colour of an image, in linear light, from an 8 x 8 copy. */
function averageColour(image) {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const g = canvas.getContext('2d');
  g.drawImage(image, 0, 0, 8, 8);
  const data = g.getImageData(0, 0, 8, 8).data;
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    for (let c = 0; c < 3; c += 1) sum[c] += data[i + c];
    n += 1;
  }
  const colour = new THREE.Color();
  colour.setRGB(sum[0] / n / 255, sum[1] / n / 255, sum[2] / n / 255, THREE.SRGBColorSpace);
  return colour;
}

function loadTexture(url, srgb) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      (texture) => {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = 8;
        texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        resolve(texture);
      },
      undefined,
      reject,
    );
  });
}

/** One photo set - colour, normal and the colour's average - loaded once. */
export function photoSet(name) {
  if (!cache.has(name)) {
    cache.set(
      name,
      Promise.all([
        loadTexture(asset(`assets/photo/${name}_albedo.webp`), true),
        loadTexture(asset(`assets/photo/${name}_normal.webp`), false),
      ]).then(([albedo, normal]) => ({ albedo, normal, average: averageColour(albedo.image) })),
    );
  }
  return cache.get(name);
}

/** A foliage atlas: its colour, and its coverage mask as a second file. */
export function foliageSet(name) {
  const key = `foliage:${name}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      Promise.all([
        loadTexture(asset(`assets/photo/${name}_albedo.webp`), true),
        loadTexture(asset(`assets/photo/${name}_alpha.webp`), false),
      ]).then(([albedo, alpha]) => ({ albedo, alpha })),
    );
  }
  return cache.get(key);
}

/** Every set the named surfaces use, loaded, keyed by surface name. */
export async function loadPhotos(surfaceNames) {
  const out = {};
  await Promise.all(
    [...new Set(surfaceNames)]
      .filter((name) => PHOTO[name])
      .map(async (name) => {
        const [set, scale, tint, bump] = PHOTO[name];
        try {
          out[name] = { ...(await photoSet(set)), scale, tint, bump };
        } catch (err) {
          // A missing photograph leaves the surface flat-coloured, as it was.
          console.warn(`photo set ${set} unavailable:`, err);
        }
      }),
  );
  return out;
}

/**
 * Uniforms for one material's photograph. `base` is the material's own
 * colour, which the photograph is tinted towards.
 */
export function photoUniforms(photo, base) {
  const target = base.clone();
  const tint = new THREE.Color(
    target.r / Math.max(photo.average.r, 1e-3),
    target.g / Math.max(photo.average.g, 1e-3),
    target.b / Math.max(photo.average.b, 1e-3),
  );
  // Partway: 0 is the photograph as shot, 1 is fully the palette's hue.
  tint.r = THREE.MathUtils.clamp(1 + (tint.r - 1) * photo.tint, 0.25, 3);
  tint.g = THREE.MathUtils.clamp(1 + (tint.g - 1) * photo.tint, 0.25, 3);
  tint.b = THREE.MathUtils.clamp(1 + (tint.b - 1) * photo.tint, 0.25, 3);
  return {
    photoAlbedo: { value: photo.albedo },
    photoNormal: { value: photo.normal },
    photoScale: { value: photo.scale },
    photoTint: { value: tint },
    photoBump: { value: photo.bump },
  };
}

/** Declarations the fragment shader needs, after `#include <common>`. */
export const PHOTO_DECLARATIONS = `
  uniform sampler2D photoAlbedo;
  uniform sampler2D photoNormal;
  uniform float photoScale;
  uniform vec3 photoTint;
  uniform float photoBump;

  // The world normal of this face, turned to face the eye, from how the
  // position changes across the pixel: the maps are flat-shaded, and this is
  // the face's own normal exactly.
  vec3 photoFaceNormal(vec3 P) {
    vec3 n = normalize(cross(dFdx(P), dFdy(P)));
    return dot(n, cameraPosition - P) < 0.0 ? -n : n;
  }

  vec3 photoWeights(vec3 n) {
    vec3 w = pow(abs(n), vec3(8.0));
    return w / (w.x + w.y + w.z);
  }

  vec3 photoSigns(vec3 n) {
    return vec3(n.x < 0.0 ? -1.0 : 1.0, n.y < 0.0 ? -1.0 : 1.0, n.z < 0.0 ? -1.0 : 1.0);
  }

  // The colour, laid along all three axes and blended by which way the face
  // looks. A second, much larger repeat of the same photograph is mixed in
  // as light and dark, so that a wall forty metres long does not show the
  // same three metres of concrete over and over.
  vec3 photoColour(vec3 P, vec3 n) {
    vec3 w = photoWeights(n);
    vec3 s = photoSigns(n);
    vec2 uvX = vec2(P.z * s.x, P.y) / photoScale;
    vec2 uvY = vec2(P.x * s.y, P.z) / photoScale;
    vec2 uvZ = vec2(-P.x * s.z, P.y) / photoScale;
    vec3 c = texture2D(photoAlbedo, uvX).rgb * w.x
           + texture2D(photoAlbedo, uvY).rgb * w.y
           + texture2D(photoAlbedo, uvZ).rgb * w.z;
    vec3 far = texture2D(photoAlbedo, (w.y > 0.5 ? uvY : (w.x > w.z ? uvX : uvZ)) * 0.183 + 0.37).rgb;
    float macro = dot(far, vec3(0.3, 0.59, 0.11)) / max(dot(c, vec3(0.3, 0.59, 0.11)), 0.05);
    return c * mix(1.0, clamp(macro, 0.6, 1.5), 0.35) * photoTint;
  }

  // The normal, by the whiteout blend: each projection's tangent-space
  // normal added onto the face's own in that projection's frame.
  vec3 photoNormalWorld(vec3 P, vec3 n) {
    vec3 w = photoWeights(n);
    vec3 s = photoSigns(n);
    vec2 uvX = vec2(P.z * s.x, P.y) / photoScale;
    vec2 uvY = vec2(P.x * s.y, P.z) / photoScale;
    vec2 uvZ = vec2(-P.x * s.z, P.y) / photoScale;
    vec3 tX = texture2D(photoNormal, uvX).xyz * 2.0 - 1.0;
    vec3 tY = texture2D(photoNormal, uvY).xyz * 2.0 - 1.0;
    vec3 tZ = texture2D(photoNormal, uvZ).xyz * 2.0 - 1.0;
    tX.xy *= photoBump;
    tY.xy *= photoBump;
    tZ.xy *= photoBump;
    tX.x *= s.x;
    tY.x *= s.y;
    tZ.x *= -s.z;
    tX = vec3(tX.xy + n.zy, abs(tX.z) * n.x);
    tY = vec3(tY.xy + n.xz, abs(tY.z) * n.y);
    tZ = vec3(tZ.xy + n.xy, abs(tZ.z) * n.z);
    return normalize(tX.zyx * w.x + tY.xzy * w.y + tZ.xyz * w.z);
  }
`;

/** Replaces the flat face normal with the photograph's, in view space. */
export const PHOTO_NORMAL = `
  #include <normal_fragment_maps>
  {
    vec3 faceWorld = photoFaceNormal(vGrainPosition);
    vec3 bumped = photoNormalWorld(vGrainPosition, faceWorld);
    // Fade the bump with distance: past a few tens of metres it is below a
    // pixel and would only shimmer.
    float near = 1.0 - smoothstep(35.0, 90.0, distance(vGrainPosition, cameraPosition));
    normal = normalize((viewMatrix * vec4(mix(faceWorld, bumped, near), 0.0)).xyz);
  }
`;
