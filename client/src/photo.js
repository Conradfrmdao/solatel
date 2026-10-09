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
// Each set is two KTX2 files the GPU keeps compressed (see
// `scripts/fetch-photo-assets.mjs`): the colour, and the normal map with the
// scan's own roughness in its alpha, so a worn steel plate catches the sky
// where it is polished and not where it is pitted.
//
// Which surface wears which photograph is keyed on the material's name, the
// same contract `SURFACES` in `world.js` keys its weathering on. The colour
// is the map's: each photograph is tinted towards the palette colour by
// `tint`, so the olive plaster stays olive and the maroon barn stays maroon
// - the texture brings the grain, the map keeps its look.
//
// Nothing here decides anything; it is paint.

import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { asset } from './assets.js';
import { PHOTO_SETS } from './photo-sets.js';

/**
 * Surface name -> [photo set, metres per repeat, how far towards the
 * palette colour (0 keeps the photograph's own colour, 1 is fully the
 * map's), how deep the normal map reads, whether its tiling is broken up].
 *
 * Breaking up the tiling suits a surface with no pattern to it - concrete,
 * asphalt, earth, rust - and ruins one that has: it shifts the photograph by
 * a different amount in each patch, which would put brick courses, planks
 * and the ribs of a sheet out of line where two patches meet.
 */
export const PHOTO = {
  concrete: ['concrete_wall', 3.0, 0.45, 1.0, 1],
  concrete_light: ['concrete_wall', 3.0, 0.45, 1.0, 1],
  concrete_grey: ['concrete_wall', 3.0, 0.75, 1.0, 1],
  concrete_dark: ['concrete_floor', 3.5, 0.5, 0.8, 1],
  silo: ['concrete_wall', 3.0, 0.4, 1.0, 1],
  asphalt: ['asphalt', 4.0, 0.25, 0.8, 1],
  plaster_tan: ['plaster', 3.0, 0.9, 1.0, 1],
  plaster_olive: ['plaster', 3.0, 0.9, 1.0, 1],
  plaster_maroon: ['plaster', 3.0, 0.9, 1.0, 1],
  plaster_sand: ['plaster', 3.0, 0.9, 1.0, 1],
  brick: ['brick', 2.4, 0.4, 1.0, 0],
  roof_metal: ['corrugated', 2.4, 0.55, 1.2, 0],
  roof_tiles: ['roof_tiles', 2.2, 0.35, 1.2, 0],
  cladding: ['corrugated', 2.4, 0.8, 1.2, 0],
  cladding_cream: ['corrugated', 2.4, 0.8, 1.2, 0],
  cladding_blue: ['corrugated', 2.4, 0.8, 1.2, 0],
  frame: ['metal_plate', 1.5, 0.9, 0.6, 0],
  rack_blue: ['metal_plate', 1.5, 0.9, 0.6, 0],
  cardboard: ['concrete_floor', 1.2, 0.95, 0.3, 1],
  frame_dark: ['painted_metal', 1.5, 0.9, 0.6, 1],
  container_rust: ['container', 2.6, 0.85, 1.2, 0],
  container_blue: ['container', 2.6, 0.85, 1.2, 0],
  container_grey: ['container', 2.6, 0.85, 1.2, 0],
  container_olive: ['container', 2.6, 0.85, 1.2, 0],
  steel: ['rusty_metal', 2.0, 0.5, 1.0, 1],
  steel_stair: ['metal_plate', 1.2, 0.55, 1.2, 0],
  tank_white: ['metal_plate', 3.5, 0.9, 0.6, 0],
  barrel_rust: ['painted_metal', 1.2, 0.9, 1.0, 1],
  barrel_olive: ['painted_metal', 1.2, 0.9, 1.0, 1],
  barrel_blue: ['painted_metal', 1.2, 0.9, 1.0, 1],
  crate_olive: ['painted_metal', 1.5, 0.9, 1.0, 1],
  crate_rust: ['rusty_metal', 1.5, 0.6, 1.0, 1],
  stripe_red: ['painted_metal', 2.0, 0.9, 0.8, 1],
  warning: ['painted_metal', 2.0, 0.9, 0.8, 1],
  wood: ['planks', 2.0, 0.6, 1.0, 0],
  wood_dark: ['planks', 2.0, 0.6, 1.0, 0],
  wood_pallet: ['planks', 1.2, 0.6, 1.0, 0],
  grass: ['grass', 2.6, 0.75, 0.9, 1],
  meadow: ['grass', 7.0, 0.8, 0.8, 1],
  grass_dry: ['dry_grass', 3.0, 0.6, 0.8, 1],
  dirt: ['dirt', 3.0, 0.3, 0.9, 1],
  gravel: ['gravel', 2.2, 0.25, 1.0, 1],
  shore: ['shore', 5.0, 0.3, 0.9, 1],
  rock: ['cliff', 7.0, 0.3, 1.2, 1],
  rock_dark: ['cliff', 7.0, 0.45, 1.2, 1],
  bark: ['bark', 1.5, 0.3, 1.0, 1],
};


const cache = new Map();

let ktx2 = null;

/**
 * Readies the loader. Called once with the renderer, before any photograph
 * is asked for: the transcoder turns each file into whichever compressed
 * format this GPU takes (BC7 on a desktop, ASTC or ETC2 on a phone).
 */
export function initPhotos(renderer) {
  const manager = new THREE.LoadingManager();
  // The transcoder fetches its two files by plain name. They are published,
  // like everything else, under names hashed from their contents.
  manager.setURLModifier((url) => (url.startsWith('basis/') ? asset(url) : url));
  ktx2 = new KTX2Loader(manager).setTranscoderPath('basis/').detectSupport(renderer);
}

/** The KTX2 loader, for anything else that ships compressed textures - the
 *  guns' (`guns.js`), inside their glTF files. */
export function ktx2Loader() {
  if (!ktx2) throw new Error('initPhotos has not been called');
  return ktx2;
}

async function loadCompressed(url, colorSpace) {
  if (!ktx2) throw new Error('initPhotos has not been called');
  const texture = await ktx2.loadAsync(url);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.colorSpace = colorSpace;
  return texture;
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

async function loadSet(name) {
  const known = PHOTO_SETS[name];
  if (!known) throw new Error(`no photo set called ${name}`);
  const [albedo, normal] = await Promise.all([
    loadCompressed(asset(`assets/photo/${name}_albedo.ktx2`), THREE.SRGBColorSpace),
    loadCompressed(asset(`assets/photo/${name}_normal.ktx2`), THREE.NoColorSpace),
  ]);
  const [r, g, b] = known.average;
  const average = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  return { albedo, normal, average, roughness: known.roughness };
}

/** One photo set - colour, normal with roughness, and the colour's average -
 *  loaded once. */
export function photoSet(name) {
  if (!cache.has(name)) cache.set(name, loadSet(name));
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
        const [set, scale, tint, bump, vary] = PHOTO[name];
        try {
          out[name] = { ...(await photoSet(set)), scale, tint, bump, vary };
        } catch (err) {
          // A missing photograph leaves the surface flat-coloured, as it was.
          console.warn(`photo set ${set} unavailable:`, err);
        }
      }),
  );
  return out;
}

/** The files the named surfaces - and any sets named outright - will ask
 *  for, to be fetched ahead of time (`prefetch.js`). */
export function photoFiles(surfaceNames, setNames = []) {
  const sets = new Set([
    ...surfaceNames.filter((name) => PHOTO[name]).map((name) => PHOTO[name][0]),
    ...setNames,
  ]);
  return [...sets].filter((set) => PHOTO_SETS[set]).flatMap((set) => [
    asset(`assets/photo/${set}_albedo.ktx2`),
    asset(`assets/photo/${set}_normal.ktx2`),
  ]);
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
    photoVary: { value: photo.vary },
    photoRoughMean: { value: photo.roughness },
    // The photograph's own mean, in the space it is sampled in: the GPU
    // hands the shader linear colour from an sRGB texture.
    photoMean: { value: new THREE.Vector3(photo.average.r, photo.average.g, photo.average.b) },
  };
}

/** Declarations the fragment shader needs, after `#include <common>`. */
export const PHOTO_DECLARATIONS = `
  uniform sampler2D photoAlbedo;
  uniform sampler2D photoNormal;
  uniform float photoScale;
  uniform vec3 photoTint;
  uniform float photoBump;
  uniform float photoVary;
  uniform float photoRoughMean;
  uniform vec3 photoMean;

  // What one triplanar pass found, for the colour, roughness and normal
  // stages of the shader to read in turn.
  vec3 photoColourOut;
  vec3 photoNormalOut;
  float photoRoughOut;

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

  float photoHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float photoValue(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(photoHash(i), photoHash(i + vec2(1.0, 0.0)), f.x),
               mix(photoHash(i + vec2(0.0, 1.0)), photoHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  // One projection's colour, and its normal with roughness in alpha.
  //
  // With the tiling broken up (Quilez, "texture repetition", technique 3): a
  // slow noise picks one of eight shifts of the photograph for each patch of
  // a few repeats, and neighbouring shifts are blended across a patch's
  // edge, so a forty metre wall shows no grid. The blend is a narrow band,
  // and keeps the photograph's contrast (Heitz and Neyret's variance-
  // preserving blend): two unrelated samples averaged are half as contrasty
  // as either, and a band as wide as Quilez's turned a whole field of grass
  // to a flat wash. One sample outside the band, two in it. The gradients
  // are passed in because these samples sit in branches, where a GPU's own
  // are undefined.
  void photoSample(vec2 uv, vec2 dx, vec2 dy, out vec4 colour, out vec4 normal) {
    if (photoVary < 0.5) {
      colour = textureGrad(photoAlbedo, uv, dx, dy);
      normal = textureGrad(photoNormal, uv, dx, dy);
      return;
    }
    float k = photoValue(uv * 0.37) * 8.0;
    float i = floor(k);
    float f = fract(k);
    vec2 shiftA = sin(vec2(3.0, 7.0) * i);
    vec2 shiftB = sin(vec2(3.0, 7.0) * (i + 1.0));
    if (f < 0.32) {
      colour = textureGrad(photoAlbedo, uv + shiftA, dx, dy);
      normal = textureGrad(photoNormal, uv + shiftA, dx, dy);
    } else if (f > 0.68) {
      colour = textureGrad(photoAlbedo, uv + shiftB, dx, dy);
      normal = textureGrad(photoNormal, uv + shiftB, dx, dy);
    } else {
      vec4 cA = textureGrad(photoAlbedo, uv + shiftA, dx, dy);
      vec4 cB = textureGrad(photoAlbedo, uv + shiftB, dx, dy);
      // Weighted by the colours themselves, so the seam follows the
      // photograph's own darks rather than a soft straight line.
      float t = smoothstep(0.38, 0.62, f - 0.08 * dot(cA.rgb - cB.rgb, vec3(1.0)));
      float keep = inversesqrt(t * t + (1.0 - t) * (1.0 - t));
      colour = vec4((mix(cA.rgb, cB.rgb, t) - photoMean) * keep + photoMean, 1.0);
      vec4 nA = textureGrad(photoNormal, uv + shiftA, dx, dy);
      vec4 nB = textureGrad(photoNormal, uv + shiftB, dx, dy);
      normal = vec4((mix(nA.xy, nB.xy, t) - 0.5) * keep + 0.5, mix(nA.z, nB.z, t), mix(nA.a, nB.a, t));
    }
  }

  // The whole pass: the colour laid along all three axes and blended by
  // which way the face looks, the normal by the whiteout blend (each
  // projection's tangent-space normal added onto the face's own in that
  // projection's frame), and the roughness. The maps are flat-shaded and
  // square to the world almost everywhere, so most pixels need one
  // projection rather than three, and only those that do are sampled.
  void photoTriplanar(vec3 P, vec3 n) {
    vec3 w = photoWeights(n);
    vec3 s = photoSigns(n);
    // Every coordinate's rate of change from the position's, here, where
    // every pixel of a quad runs the same code. Taken from the coordinates
    // themselves they would jump wherever the sign flips at a face's edge,
    // and that pixel would read the blurriest mip there is.
    vec3 px = dFdx(P) / photoScale;
    vec3 py = dFdy(P) / photoScale;
    vec2 uvX = vec2(P.z * s.x, P.y) / photoScale;
    vec2 uvY = vec2(P.x * s.y, P.z) / photoScale;
    vec2 uvZ = vec2(-P.x * s.z, P.y) / photoScale;
    vec2 dxX = vec2(px.z * s.x, px.y), dyX = vec2(py.z * s.x, py.y);
    vec2 dxY = vec2(px.x * s.y, px.z), dyY = vec2(py.x * s.y, py.z);
    vec2 dxZ = vec2(-px.x * s.z, px.y), dyZ = vec2(-py.x * s.z, py.y);

    vec3 colour = vec3(0.0);
    vec3 normal = vec3(0.0);
    float rough = 0.0;
    float used = 0.0;
    vec4 c;
    vec4 t;
    if (w.x > 0.01) {
      photoSample(uvX, dxX, dyX, c, t);
      vec3 tn = t.xyz * 2.0 - 1.0;
      tn.xy *= photoBump;
      tn.x *= s.x;
      tn = vec3(tn.xy + n.zy, abs(tn.z) * n.x);
      colour += c.rgb * w.x;
      normal += tn.zyx * w.x;
      rough += t.a * w.x;
      used += w.x;
    }
    if (w.y > 0.01) {
      photoSample(uvY, dxY, dyY, c, t);
      vec3 tn = t.xyz * 2.0 - 1.0;
      tn.xy *= photoBump;
      tn.x *= s.y;
      tn = vec3(tn.xy + n.xz, abs(tn.z) * n.y);
      colour += c.rgb * w.y;
      normal += tn.xzy * w.y;
      rough += t.a * w.y;
      used += w.y;
    }
    if (w.z > 0.01) {
      photoSample(uvZ, dxZ, dyZ, c, t);
      vec3 tn = t.xyz * 2.0 - 1.0;
      tn.xy *= photoBump;
      tn.x *= -s.z;
      tn = vec3(tn.xy + n.xy, abs(tn.z) * n.z);
      colour += c.rgb * w.z;
      normal += tn.xyz * w.z;
      rough += t.a * w.z;
      used += w.z;
    }
    colour /= used;
    rough /= used;

    // A second, much larger repeat of the same photograph mixed in as light
    // and dark, so that a wall forty metres long is not one even tone.
    bool lying = w.y > 0.5;
    bool alongX = w.x > w.z;
    vec2 uvFar = (lying ? uvY : (alongX ? uvX : uvZ)) * 0.183 + 0.37;
    vec2 dxFar = (lying ? dxY : (alongX ? dxX : dxZ)) * 0.183;
    vec2 dyFar = (lying ? dyY : (alongX ? dyX : dyZ)) * 0.183;
    vec3 far = textureGrad(photoAlbedo, uvFar, dxFar, dyFar).rgb;
    float macro = dot(far, vec3(0.3, 0.59, 0.11)) / max(dot(colour, vec3(0.3, 0.59, 0.11)), 0.05);

    photoColourOut = colour * mix(1.0, clamp(macro, 0.6, 1.5), 0.35) * photoTint;
    photoNormalOut = normalize(normal);
    photoRoughOut = rough;
  }
`;

/**
 * After the palette's roughness is read: the scan's variation around it.
 *
 * The palette says how glossy a surface is; the scan says where it is
 * glossier and where it is duller. Taken whole, a scan's own level replaced
 * the palette's: steel stair treads measured as a polished plate caught the
 * sun as a line of glare, and the asphalt went grey with reflected sky.
 */
export const PHOTO_ROUGHNESS = `
  #include <roughnessmap_fragment>
  roughnessFactor = clamp(roughnessFactor + photoRoughOut - photoRoughMean, 0.04, 1.0);
`;

/**
 * Replaces the flat face normal with the photograph's, in view space - and,
 * up close on a surface with no pattern to keep, adds a grain finer than
 * any photograph holds: a millimetre of grit a few millimetres across, so a
 * wall a player is pressed against still has tooth when the photograph's
 * own texels are the size of a fingernail. Bump mapping without tangents
 * (Mikkelsen, 2010): the height's change across the pixel tilts the normal.
 */
export const PHOTO_NORMAL = `
  #include <normal_fragment_maps>
  {
    vec3 P = vGrainPosition;
    vec3 faceWorld = photoFaceNormal(P);
    float distanceToEye = distance(P, cameraPosition);
    // Fade the bump with distance: past a few tens of metres it is below a
    // pixel and would only shimmer.
    float near = 1.0 - smoothstep(35.0, 90.0, distanceToEye);
    vec3 bumped = normalize(mix(faceWorld, photoNormalOut, near));

    // The grain, laid along the face like the photograph, and taken with its
    // rate of change before anything branches.
    vec3 axis = abs(faceWorld);
    vec2 q = (axis.y > 0.7 ? P.xz : (axis.x > axis.z ? P.zy : P.xy)) * 140.0;
    float h = photoValue(q) * 0.65 + photoValue(q * 2.3 + 7.0) * 0.35;
    vec2 dh = vec2(dFdx(h), dFdy(h));
    vec3 dx = dFdx(P);
    vec3 dy = dFdy(P);
    // Gone by six metres, and wherever a grain is finer than a pixel.
    float grit = photoVary * (1.0 - smoothstep(1.5, 6.0, distanceToEye))
               * (1.0 - smoothstep(0.35, 0.9, fwidth(q.x) + fwidth(q.y)));
    if (grit > 0.0) {
      // The height's change across a pixel over the metres the pixel
      // spans is a true slope, so the grain is as deep at any distance.
      float lx = max(length(dx), 1e-6);
      float ly = max(length(dy), 1e-6);
      vec3 sx = dx / lx;
      vec3 sy = dy / ly;
      vec3 r1 = cross(sy, bumped);
      vec3 r2 = cross(bumped, sx);
      float det = dot(sx, r1);
      vec3 gradient = sign(det) * ((dh.x / lx) * r1 + (dh.y / ly) * r2) * 0.0007 * grit;
      bumped = normalize(abs(det) * bumped - gradient);
    }
    normal = normalize((viewMatrix * vec4(bumped, 0.0)).xyz);
  }
`;
