// The map: geometry, light, and the tracers shots leave behind.
//
// # Drawing and colliding are two different things
//
// What is drawn here is a model. What the player collides with is the brush
// table in `solatel-protocol`, handed over by the wasm simulation. They are
// derived from each other - `scripts/derive-brushes.py` voxelises this very
// file - but they are not the same data, and this module must never be the one
// that decides where a wall is. It only decides what a wall looks like.
//
// The scale comes from the simulation for exactly that reason, and it is per
// map: the arena is authored at about a quarter of the size a shooter wants
// and the yard is already roughly in metres, and each one's brushes were
// generated at its own scale. Drawing either at any other scale would put
// every wall somewhere the server does not think it is.
//
// Which model to load is not this module's decision either. The server names
// the map in the handshake and `main.js` loads that one; a client that picked
// for itself could draw one world and predict against another.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SIM } from './sim.js';
import { blow, growNature } from './nature.js';
import { dressProps } from './props.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { PHOTO_DECLARATIONS, PHOTO_NORMAL, loadPhotos, photoUniforms } from './photo.js';

/** How long a tracer stays on screen. */
const TRACER_SECONDS = 0.06;

/** How many tracers can be in flight at once before the oldest is reused. */
const MAX_TRACERS = 48;

/**
 * A vertical gradient, mapped as if it were a sky sphere.
 *
 * Two pixels wide because only the vertical axis carries anything; the
 * equirectangular mapping stretches it around the horizon for free.
 */
function skyGradient(zenith, horizon) {
  // Wide enough to wrap the horizon without the clouds smearing, and short,
  // because the only thing that varies quickly is the vertical gradient.
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');

  const fill = context.createLinearGradient(0, 0, 0, height);
  fill.addColorStop(0, `#${zenith.toString(16).padStart(6, '0')}`);
  fill.addColorStop(0.5, `#${horizon.toString(16).padStart(6, '0')}`);
  // Below the horizon is never seen from inside the arena - the floor covers
  // it - so it only has to not be a bright band peeking under the walls.
  fill.addColorStop(0.52, `#${horizon.toString(16).padStart(6, '0')}`);
  fill.addColorStop(1, '#5d6570');
  context.fillStyle = fill;
  context.fillRect(0, 0, width, height);

  drawClouds(context, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Cloud onto an equirectangular sky.
 *
 * Two things this has to get right. It has to wrap: the left and right edges
 * of the image are the same place in the world, so anything overhanging one
 * is drawn again at the other. And it has to thin out towards the top, where
 * the projection squeezes a whole circle of sky into one row of pixels and
 * anything drawn there smears into a disc over the player's head.
 */
function drawClouds(context, width, height) {
  // Deterministic, so everyone in the match is under the same sky rather
  // than each under their own.
  let seed = 20260920;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const puff = (x, y, radius, alpha) => {
    const fade = context.createRadialGradient(x, y, 0, x, y, radius);
    fade.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    fade.addColorStop(0.45, `rgba(250, 252, 255, ${alpha * 0.5})`);
    fade.addColorStop(1, 'rgba(240, 246, 255, 0)');
    context.fillStyle = fade;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  };

  for (let i = 0; i < 34; i += 1) {
    // Between a little above the horizon and most of the way up. Nothing at
    // the very top, where the projection would smear it across the zenith.
    const y = height * (0.10 + random() * 0.30);
    const x = random() * width;
    // Clouds near the horizon are further away, so smaller and fainter.
    const nearness = y / (height * 0.45);
    const radius = height * (0.018 + 0.05 * nearness * random());
    const alpha = (0.18 + 0.42 * nearness) * (0.6 + random() * 0.4);

    for (let lump = 0; lump < 6; lump += 1) {
      const ox = x + (random() - 0.5) * radius * 3.2;
      const oy = y + (random() - 0.5) * radius * 0.9;
      const size = radius * (0.45 + random() * 0.7);
      // Drawn again either side, so a cloud overhanging the seam appears
      // whole rather than sliced in half.
      for (const wrap of [-width, 0, width]) {
        puff(ox + wrap, oy, size, alpha);
      }
    }
  }
}

/** How far the grain is still drawn. Past this it is smaller than a pixel and
 *  would only shimmer as the player moves, so it fades out instead. */
const GRAIN_RANGE = 45;

/** How much it darkens and lightens, at most. Small on purpose: this is meant
 *  to be felt rather than seen. */
const GRAIN_DEPTH = 0.1;

/** Roughly one patch per this many metres. Tuned so a wall has a few hundred
 *  across it rather than a visible checkerboard. */
const GRAIN_SCALE = 0.55;

/** The two ways a named surface is drawn: most things weather, and the
 *  ground additionally carries paint. */
const WEATHERED = 1;
const GROUND = 2;

/**
 * How each of the arena's surfaces ages, by the name `extend-arena.py` gives
 * its material. The colour is the file's; this is everything a flat colour
 * cannot say. Every number is a strength from 0 to 1 unless it says
 * otherwise, and anything left out is off.
 *
 * - `blotch`: patchiness at the scale of metres - weather, repairs, fading.
 * - `streak`: dark runs down vertical faces, from rain off the top.
 * - `foot`: grime at the bottom of every wall, where splash and dirt collect.
 * - `seams`: formwork joints, as [metres between vertical joints, metres
 *   between horizontal ones]. Concrete poured in panels shows every one.
 * - `plinth`: a darker painted band round the base of a building,
 *   [height in metres, how much darker].
 * - `rust`: orange-brown bloom, worst low down and in the streaks.
 * - `chips`: paint knocked off edges and faces, showing bare metal.
 * - `ribs`: corrugation, metres between ribs, across roofs and containers.
 * - `planks`: board width in metres, for anything made of timber.
 *
 * A surface not listed here - everything in the yard - gets the grain alone,
 * exactly as before.
 */
const CONCRETE = { kind: WEATHERED, blotch: 0.22, streak: 0.85, foot: 0.32 };
const PLASTER = { kind: WEATHERED, blotch: 0.16, streak: 0.3, foot: 0.25, plinth: [0.45, 0.22] };
const PAINTED = { kind: WEATHERED, blotch: 0.12, streak: 0.15, foot: 0.2, chips: 0.3 };
const TIMBER = { kind: WEATHERED, blotch: 0.12, foot: 0.2, planks: 0.2 };
const SURFACES = {
  concrete: { ...CONCRETE, seams: [3.0, 3.066] },
  concrete_dark: CONCRETE,
  concrete_light: { ...CONCRETE, streak: 0.3 },
  silo: { ...CONCRETE, seams: [0, 1.53], rust: 0.3 },
  asphalt: { kind: GROUND, blotch: 0.2 },
  plaster_tan: PLASTER,
  plaster_olive: PLASTER,
  plaster_maroon: PLASTER,
  plaster_sand: PLASTER,
  roof_metal: { ...PAINTED, streak: 0, chips: 0, rust: 0.2, ribs: 0.3 },
  container_rust: { ...PAINTED, rust: 0.45, ribs: 0.25 },
  steel: { ...PAINTED, rust: 0.35 },
  steel_stair: { ...PAINTED, chips: 0.5, rust: 0.2 },
  tank_white: { ...PAINTED, rust: 0.25, streak: 0.4 },
  car_red: { ...PAINTED, blotch: 0.2, chips: 0, rust: 0.15 },
  car_blue: { ...PAINTED, blotch: 0.2, chips: 0, rust: 0.15 },
  barrel_rust: { ...PAINTED, rust: 0.5 },
  barrel_olive: { ...PAINTED, rust: 0.3 },
  barrel_blue: { ...PAINTED, rust: 0.3 },
  crate_olive: { ...PAINTED, chips: 0.45 },
  crate_rust: { ...PAINTED, rust: 0.4 },
  wood: TIMBER,
  wood_dark: TIMBER,
  wood_pallet: { ...TIMBER, planks: 0.14 },
  brick: { kind: WEATHERED, blotch: 0.15, foot: 0.2 },
  sandbag: { kind: WEATHERED, blotch: 0.2, foot: 0.15 },
  // The facility's country, and what it adds to the works.
  grass: { kind: WEATHERED, blotch: 0.32 },
  grass_dry: { kind: WEATHERED, blotch: 0.32 },
  meadow: { kind: WEATHERED, blotch: 0.4 },
  roof_tiles: { kind: WEATHERED, blotch: 0.15, streak: 0.3 },
  glass: { kind: WEATHERED, blotch: 0.05 },
  frame: { ...PAINTED, streak: 0.2 },
  frame_dark: { ...PAINTED, rust: 0.15 },
  cladding: { ...PAINTED, rust: 0.2, ribs: 0.2 },
  cladding_cream: { ...PAINTED, rust: 0.15, ribs: 0.2 },
  rack_blue: { ...PAINTED, chips: 0.4 },
  cardboard: { kind: WEATHERED, blotch: 0.25, streak: 0.1 },
  cladding_blue: { ...PAINTED, rust: 0.15, ribs: 0.2 },
  shore: { kind: WEATHERED, blotch: 0.3 },
  dirt: { kind: WEATHERED, blotch: 0.35 },
  gravel: { kind: WEATHERED, blotch: 0.25 },
  rock: { kind: WEATHERED, blotch: 0.3, streak: 0.35, foot: 0.15 },
  rock_dark: { kind: WEATHERED, blotch: 0.3, streak: 0.35, foot: 0.15 },
  foliage: { kind: WEATHERED, blotch: 0.25 },
  foliage_dark: { kind: WEATHERED, blotch: 0.25 },
  bark: { kind: WEATHERED, blotch: 0.2, foot: 0.1 },
  rubber: { kind: WEATHERED, blotch: 0.1 },
  container_blue: { ...PAINTED, rust: 0.4, ribs: 0.25 },
  container_grey: { ...PAINTED, rust: 0.4, ribs: 0.25 },
  container_olive: { ...PAINTED, rust: 0.4, ribs: 0.25 },
  car_olive: { ...PAINTED, blotch: 0.2, chips: 0, rust: 0.15 },
  car_white: { ...PAINTED, blotch: 0.2, chips: 0, rust: 0.2 },
  stripe_red: { ...PAINTED, rust: 0.3 },
  warning: { ...PAINTED, chips: 0.4 },
};

/** Paint on the ground is one of these, by the index the map stores. */
const MARKING_COLOURS = [new THREE.Color(0xc9a23a), new THREE.Color(0xd8d6cc)];

/** The colour rust blooms to, and the colour under chipped paint. */
const RUST = new THREE.Color(0x7c4a2b);
const BARE_METAL = new THREE.Color(0x77776f);

/**
 * Break up large flat surfaces with a faint world-space grain, and age the
 * ones the map says what they are made of.
 *
 * Both maps are untextured flat colour, which is fine on a crate and a real
 * problem on a hundred-metre wall: a surface with no variation in it gives the
 * eye nothing to judge distance or speed against, and both are things a player
 * is aiming with. Standing in front of one there is no way to tell whether it
 * is two metres away or twenty.
 *
 * This is computed from world position in the shader rather than sampled from
 * a texture, for two reasons. The maps have no texture coordinates - they are
 * stripped when the assets are prepared, because nothing sampled them and they
 * were megabytes - so there is nothing to sample against. And world space is
 * the right space anyway: the patch size comes out the same on every surface
 * however the model happens to be unwrapped, and nothing stretches. The one
 * thing a texture would have supplied that world space does not is which way
 * a face points, and that comes from the screen-space derivatives of the
 * position - the same trick flat shading already uses for its normals.
 *
 * Everything fine fades out with distance, because detail finer than a pixel
 * does not read as detail. It reads as noise crawling over the geometry as
 * the camera moves. Lines - seams, planks, ribs, paint - are also faded by
 * their own width on screen, which is what keeps a wall of joints forty
 * metres away from turning into moire.
 */
function addSurfaceDetail(material, photo = null) {
  const surface = SURFACES[material.name];
  if (!surface) photo = null;
  const markings = surface?.kind === GROUND ? material.userData?.markings ?? [] : [];

  material.onBeforeCompile = (shader) => {
    shader.uniforms.grainRange = { value: GRAIN_RANGE };
    shader.uniforms.grainDepth = { value: GRAIN_DEPTH };
    if (surface) {
      shader.uniforms.surfaceBlotch = { value: surface.blotch ?? 0 };
      shader.uniforms.surfaceStreak = { value: surface.streak ?? 0 };
      shader.uniforms.surfaceFoot = { value: surface.foot ?? 0 };
      shader.uniforms.surfaceSeams = { value: new THREE.Vector2(...(photo ? [0, 0] : surface.seams ?? [0, 0])) };
      shader.uniforms.surfacePlinth = { value: new THREE.Vector2(...(surface.plinth ?? [0, 0])) };
      shader.uniforms.surfaceRust = { value: surface.rust ?? 0 };
      // A photograph already has its joints, ribs, boards and knocks; the
      // drawn ones would be a second set on top.
      shader.uniforms.surfaceChips = { value: photo ? 0 : surface.chips ?? 0 };
      shader.uniforms.surfaceRibs = { value: photo ? 0 : surface.ribs ?? 0 };
      shader.uniforms.surfacePlanks = { value: photo ? 0 : surface.planks ?? 0 };
      if (photo) {
        shader.uniforms.surfaceBlotch.value *= 0.45;
        Object.assign(shader.uniforms, photoUniforms(photo, material.color));
      }
      shader.uniforms.rustColour = { value: RUST };
      shader.uniforms.bareColour = { value: BARE_METAL };
    }
    if (markings.length) {
      // Two vec4s a line: the segment, then width, dash and colour.
      shader.uniforms.markingEnds = {
        value: markings.map(([x0, z0, x1, z1]) => new THREE.Vector4(x0, z0, x1, z1)),
      };
      shader.uniforms.markingLook = {
        value: markings.map(([, , , , width, dash, colour]) => new THREE.Vector4(width, dash, colour, 0)),
      };
      shader.uniforms.markingColours = { value: MARKING_COLOURS };
    }

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vGrainPosition;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vGrainPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        ${surface ? `#define SURFACE_KIND ${surface.kind}` : ''}
        ${markings.length ? `#define MARKINGS ${markings.length}` : ''}
        ${photo ? '#define PHOTO' : ''}
        varying vec3 vGrainPosition;
        ${photo ? PHOTO_DECLARATIONS : ''}
        uniform float grainRange;
        uniform float grainDepth;

        // A hash rather than a texture lookup: a couple of instructions, no
        // memory traffic, and no texture coordinates required.
        float grainHash(vec3 cell) {
          return fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        }

        // Value noise: hash the eight corners of the cell a point falls in and
        // interpolate between them smoothly. Without the smoothing this is
        // per-cell static, which reads as dirt on the lens rather than as
        // texture on the surface.
        float grainNoise(vec3 p) {
          vec3 cell = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float n000 = grainHash(cell + vec3(0.0, 0.0, 0.0));
          float n100 = grainHash(cell + vec3(1.0, 0.0, 0.0));
          float n010 = grainHash(cell + vec3(0.0, 1.0, 0.0));
          float n110 = grainHash(cell + vec3(1.0, 1.0, 0.0));
          float n001 = grainHash(cell + vec3(0.0, 0.0, 1.0));
          float n101 = grainHash(cell + vec3(1.0, 0.0, 1.0));
          float n011 = grainHash(cell + vec3(0.0, 1.0, 1.0));
          float n111 = grainHash(cell + vec3(1.0, 1.0, 1.0));
          return mix(
            mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
            mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
            f.z);
        }

        #ifdef SURFACE_KIND
        uniform float surfaceBlotch;
        uniform float surfaceStreak;
        uniform float surfaceFoot;
        uniform vec2 surfaceSeams;
        uniform vec2 surfacePlinth;
        uniform float surfaceRust;
        uniform float surfaceChips;
        uniform float surfaceRibs;
        uniform float surfacePlanks;
        uniform vec3 rustColour;
        uniform vec3 bareColour;

        // The same noise in two dimensions, for patterns that live on a face:
        // half the hashes, and every pattern below is laid out on a plane.
        float surfaceHash(vec2 cell) {
          return fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
        }
        float surfaceNoise(vec2 p) {
          vec2 cell = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(surfaceHash(cell), surfaceHash(cell + vec2(1.0, 0.0)), f.x),
            mix(surfaceHash(cell + vec2(0.0, 1.0)), surfaceHash(cell + vec2(1.0, 1.0)), f.x),
            f.y);
        }

        // 1 on a line of half-width w repeating every period along t, 0 off
        // it, soft by one pixel either side - and fading out entirely once
        // a period is only a few pixels across, where lines turn to moire.
        float surfaceLines(float t, float period, float w) {
          float d = abs(fract(t / period + 0.5) - 0.5) * period;
          float px = fwidth(t);
          float line = 1.0 - smoothstep(w, w + px, d);
          return line * (1.0 - smoothstep(period * 0.08, period * 0.25, px));
        }
        #endif

        #ifdef MARKINGS
        uniform vec4 markingEnds[MARKINGS];
        uniform vec4 markingLook[MARKINGS];
        uniform vec3 markingColours[2];
        #endif`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // Two octaves: the coarse one is the patchiness of a weathered
          // surface, the fine one is its tooth.
          float coarse = grainNoise(vGrainPosition / GRAIN_COARSE);
          float fine = grainNoise(vGrainPosition / GRAIN_FINE);
          float grain = (coarse - 0.5) * 0.7 + (fine - 0.5) * 0.3;
          float fade = 1.0 - smoothstep(
            grainRange * 0.45, grainRange, distance(vGrainPosition, cameraPosition));
          diffuseColor.rgb *= 1.0 + grain * grainDepth * 2.0 * fade;

          #ifdef SURFACE_KIND
          vec3 P = vGrainPosition;
          vec3 colour = diffuseColor.rgb;
          #ifdef PHOTO
          colour = photoColour(P, photoFaceNormal(P));
          #endif
          // Which way this face points, from how position changes across the
          // pixel. Only its axis is wanted, so the sign does not matter.
          vec3 facing = abs(normalize(cross(dFdx(P), dFdy(P))));
          bool level = facing.y > 0.7;
          // Along a vertical face, whichever horizontal axis it runs down.
          float across = facing.x > facing.z ? P.z : P.x;
          vec2 face = level ? P.xz : vec2(across, P.y);

          // Metres-scale patches: two octaves, so they are not all one size.
          float blotch = surfaceNoise(face / 3.1 + 17.0) * 0.65
                       + surfaceNoise(face / 0.9 + 5.0) * 0.35;
          colour *= 1.0 + (blotch - 0.5) * surfaceBlotch * 2.0;

          float low = 1.0 - smoothstep(0.0, 1.4, P.y);
          float stain = 0.0;
          if (!level) {
            // Rain runs: long in y, narrow across, and patchy along the top.
            float run = surfaceNoise(vec2(across * 1.6, P.y * 0.11))
                      * 0.7 + surfaceNoise(vec2(across * 4.7 + 9.0, P.y * 0.35)) * 0.3;
            stain = smoothstep(0.5, 0.85, run);
            colour *= 1.0 - stain * surfaceStreak * 0.5;
            colour *= 1.0 - low * low * surfaceFoot;
            if (surfacePlinth.x > 0.0 && P.y < surfacePlinth.x && P.y > -0.1) {
              colour *= 1.0 - surfacePlinth.y;
            }
            if (surfaceSeams.x > 0.0) {
              colour *= 1.0 - 0.3 * surfaceLines(across, surfaceSeams.x, 0.02);
            }
            if (surfaceSeams.y > 0.0) {
              colour *= 1.0 - 0.3 * surfaceLines(P.y, surfaceSeams.y, 0.02);
            }
          }

          if (surfaceRust > 0.0) {
            float bloom = surfaceNoise(face * 1.3 + 31.0) * 0.6
                        + surfaceNoise(face * 4.3) * 0.4;
            float rust = smoothstep(0.55, 0.8, bloom + low * 0.25 + stain * 0.2);
            colour = mix(colour, rustColour * (0.8 + 0.4 * blotch), rust * surfaceRust);
          }
          if (surfaceChips > 0.0) {
            // Small and sparse: a knock here and there, not a camouflage.
            float chip = smoothstep(0.86, 0.9, surfaceNoise(face * 26.0 + 3.0))
                       * smoothstep(0.4, 0.7, surfaceNoise(face * 2.0 + 8.0));
            colour = mix(colour, bareColour, chip * surfaceChips * fade);
          }
          if (surfaceRibs > 0.0) {
            // Corrugation: shading that rolls with the sheet, fading to flat
            // once the ribs are too fine to draw.
            float t = level ? P.x : across;
            float px = fwidth(t) / surfaceRibs;
            colour *= 1.0 + sin(t * 6.2832 / surfaceRibs) * 0.09 * (1.0 - smoothstep(0.1, 0.35, px));
          }
          if (surfacePlanks > 0.0) {
            // Boards: horizontal up the sides, along x on top. Each board a
            // shade of its own, a dark gap between them, and grain along it.
            float t = level ? P.z : P.y;
            float along = level ? P.x : across;
            float board = floor(t / surfacePlanks);
            float shade = surfaceHash(vec2(board, floor(along / 1.9)));
            colour *= 0.9 + shade * 0.2;
            colour *= 1.0 - 0.45 * surfaceLines(t, surfacePlanks, 0.008);
            colour *= 1.0 + (surfaceNoise(vec2(along * 1.5, t * 30.0)) - 0.5) * 0.12 * fade;
          }

          #if SURFACE_KIND == ${GROUND}
          if (level) {
            // Grit: speckle a few centimetres across, gone at a distance.
            colour *= 1.0 + (surfaceHash(floor(P.xz * 16.0)) - 0.5) * 0.14 * fade;
            // Patches where it has been dug up and resurfaced, darker.
            colour *= 1.0 - 0.14 * smoothstep(0.6, 0.63, surfaceNoise(P.xz / 7.0 + 3.0));
            // Oil and water stains, only in some parts of the map.
            float spill = smoothstep(0.7, 0.8, surfaceNoise(P.xz / 1.4 + 40.0))
                        * smoothstep(0.45, 0.7, surfaceNoise(P.xz / 11.0));
            colour *= 1.0 - 0.4 * spill;
            #ifdef MARKINGS
            float worn = smoothstep(0.25, 0.6, surfaceNoise(P.xz * 2.3 + 11.0));
            for (int i = 0; i < MARKINGS; i++) {
              vec2 a = markingEnds[i].xy;
              vec2 ab = markingEnds[i].zw - a;
              vec2 ap = P.xz - a;
              float h = clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);
              float d = length(ap - ab * h);
              vec4 look = markingLook[i];
              float dash = look.y > 0.0 ? step(fract(h * length(ab) / look.y), 0.5) : 1.0;
              float px = fwidth(d);
              float paint = (1.0 - smoothstep(look.x * 0.5, look.x * 0.5 + px, d)) * dash;
              colour = mix(colour, markingColours[int(look.z)] * (0.85 + 0.3 * blotch),
                           paint * (0.35 + 0.55 * worn));
            }
            #endif
          }
          #endif

          diffuseColor.rgb = colour;
          #endif
        }`,
      )
      .replace('#include <normal_fragment_maps>', photo ? PHOTO_NORMAL : '#include <normal_fragment_maps>')
      .replace('GRAIN_COARSE', GRAIN_SCALE.toFixed(2))
      .replace('GRAIN_FINE', (GRAIN_SCALE * 0.28).toFixed(2));
  };

  // Three.js caches compiled programs per material configuration and does not
  // know that `onBeforeCompile` changed the source. Without a key of its own,
  // a grained material and a plain one with the same settings would share one
  // program and whichever compiled first would win. Every setting that is a
  // uniform can share a program; what changes the source is the kind and the
  // number of markings, so those are the key.
  material.customProgramCacheKey = () =>
    `solatel-surface-${surface?.kind ?? 0}-${markings.length}-${photo ? 1 : 0}`;
}

/** How far out the sun and the cloud deck sit. Inside the far plane, which is
 *  set from the map, so both are always drawn. */
const SKY_DISTANCE = 0.82;

/** Water sits just below the ground so the two never fight over the same
 *  depth, and so the map reads as a platform standing in it. A map can say
 *  otherwise in its scene's extras - the facility stands well clear of its
 *  sea and has a river cut down to it. */
const WATER_DEPTH = -0.4;
const WATER_COLOUR = 0x2c6b8f;

/** How tall the match boundary is drawn.
 *
 *  Above everything either map has to stand on. The constraint itself has no
 *  height - it is a circle, applied at every altitude - so a wall a player
 *  could see over would be lying about what it does. */
const ZONE_WALL_HEIGHT = 60;

/** Half the width of the sun's shadow box, in metres. It travels with the
 *  player rather than covering the map, so this is "how far away a shadow
 *  is still worth drawing" and not "how big is the map". Thirty-four metres
 *  of it across 2048 texels is about 30 texels per metre. */
const SHADOW_EXTENT = 34;

/** Where the sun sits relative to whatever it is lighting. Fixed, so that
 *  shadows keep pointing the same way as the player moves. */
const SUN_OFFSET = { x: 18, y: 34, z: 12 };

/**
 * A soft round glow, for the sun.
 *
 * Drawn rather than downloaded, like everything else here. A disc with a hard
 * edge reads as a sticker; what reads as the sun is a white core that never
 * quite stops, which is what the outer stops of this gradient are for.
 */
function sunTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  const middle = size / 2;
  const glow = context.createRadialGradient(middle, middle, 0, middle, middle, middle);
  glow.addColorStop(0.0, 'rgba(255, 255, 250, 1)');
  glow.addColorStop(0.12, 'rgba(255, 250, 225, 0.95)');
  glow.addColorStop(0.26, 'rgba(255, 228, 165, 0.45)');
  glow.addColorStop(0.55, 'rgba(255, 200, 120, 0.12)');
  glow.addColorStop(1.0, 'rgba(255, 190, 110, 0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}


/**
 * Merge a map's fixed geometry into one mesh per material.
 *
 * A downloaded map is often a thousand small meshes - the yard is - and each
 * is a draw call, twice over with the shadow pass. Nothing in a map moves,
 * so everything drawn with the same material can be one mesh in the map's
 * own frame. Instanced meshes (trees, vehicles) are already one draw each
 * and are left alone, as are hidden stand-ins and anything not a plain mesh.
 */
function batchStatic(map) {
  map.updateMatrixWorld(true);
  const toMap = new THREE.Matrix4().copy(map.matrixWorld).invert();
  const groups = new Map();
  const merged = [];
  map.traverse((node) => {
    if (!node.isMesh || node.isInstancedMesh || node.isSkinnedMesh) return;
    let visible = true;
    for (let n = node; n && n !== map; n = n.parent) {
      if (!n.visible || n.userData?.collision_only) visible = false;
    }
    if (!visible || Array.isArray(node.material)) return;
    const key = node.material.uuid;
    if (!groups.has(key)) groups.set(key, { material: node.material, parts: [] });
    const g = node.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toMap, node.matrixWorld));
    for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
    groups.get(key).parts.push(g.index ? g : g);
    merged.push(node);
  });
  let batches = 0;
  for (const { material, parts } of groups.values()) {
    if (parts.length < 2) continue;
    const indexed = parts.every((g) => g.index);
    const geometry = mergeGeometries(indexed ? parts : parts.map((g) => (g.index ? g.toNonIndexed() : g)));
    if (!geometry) continue;
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `batch:${material.name}`;
    // The map is scaled by the simulation's scale; the batch is in the map's
    // own frame, so it goes in as a child and takes the same scale.
    map.add(mesh);
    batches += 1;
    for (const part of parts) part.dispose();
  }
  // Only now hide what went into a batch, so a material that ended up
  // alone keeps its original mesh.
  for (const node of merged) {
    const key = node.material.uuid;
    const group = groups.get(key);
    if (group && group.parts.length >= 2) node.visible = false;
  }
  return batches;
}

/**
 * A wire-mesh fence: a diamond lattice cut out of a flat panel.
 *
 * Coverage goes to the multisampler rather than a hard cut, so where the
 * wires are finer than a pixel the fence thins to a haze instead of
 * shimmering, as the real thing does at a distance.
 */
function chainLink(material) {
  material.alphaToCoverage = true;
  material.side = THREE.DoubleSide;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLinkPosition;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvLinkPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLinkPosition;')
      .replace(
        '#include <alphatest_fragment>',
        `{
          vec3 P = vLinkPosition;
          vec3 facing = abs(normalize(cross(dFdx(P), dFdy(P))));
          float across = facing.x > facing.z ? P.z : P.x;
          vec2 q = vec2(across + P.y, across - P.y) / 0.065;
          vec2 d = abs(fract(q) - 0.5);
          float w = 0.09;
          vec2 px = fwidth(q);
          vec2 wire = 1.0 - smoothstep(vec2(w), vec2(w) + px, d);
          float cover = max(wire.x, wire.y);
          // Finer than a pixel: fade to the lattice's average coverage.
          float fine = smoothstep(0.25, 0.6, max(px.x, px.y));
          diffuseColor.a = mix(cover, 0.3, fine);
          if (diffuseColor.a < 0.02) discard;
        }`,
      );
  };
  material.customProgramCacheKey = () => 'solatel-chainlink';
  material.needsUpdate = true;
}

/**
 * The box a map's play happens in: everything but its scenery.
 *
 * A node the map marks `scenery` - hills past the edge, leaves - is drawn and
 * never collided with, and it can reach hundreds of metres past the ground
 * anybody stands on. The fog is sized from this box, and sizing it from the
 * hills would push the haze out past the whole map.
 */
function playBounds(map, box) {
  box.makeEmpty();
  map.updateWorldMatrix(true, true);
  const visit = (node) => {
    if (node.userData?.scenery) return;
    if (node.isMesh) box.expandByObject(node);
    else node.children.forEach(visit);
  };
  visit(map);
  return box;
}

export class World {
  constructor(scene, renderer = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.sunOffset = new THREE.Vector3(SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z);
    this.arena = null;
    this.bounds = new THREE.Box3();
    this._tracers = [];
    this._nextTracer = 0;

    this._buildLighting();
    this._buildSky();
    this._buildTracerPool();
    this._buildZone();
    this.skyReady = renderer ? this._loadSky().catch((err) => console.warn('sky unavailable:', err)) : null;
  }

  /**
   * A photographed sky, and the light it gives.
   *
   * The sky is a scanned HDR panorama. Blurred into an environment map it
   * lights everything the sun does not reach, the way the real sky does -
   * blue from above, warm off the ground, bright towards the sun - and
   * gives every surface something true to reflect. That is most of the
   * difference between a scene that looks lit and one that looks drawn.
   *
   * The sun is put where the panorama's own sun is, found as its brightest
   * texel, so the shadows fall the way the sky says they should. The fog is
   * the colour of the panorama's horizon, so the land fades into the sky
   * behind it rather than into a grey of its own.
   */
  async _loadSky() {
    const hdr = await new HDRLoader().setDataType(THREE.FloatType).loadAsync('assets/sky/sky_1k.hdr');
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const { data, width, height } = hdr.image;
    let best = -1;
    let at = 0;
    for (let i = 0; i < width * height; i += 1) {
      const lum = data[i * 4] * 0.3 + data[i * 4 + 1] * 0.59 + data[i * 4 + 2] * 0.11;
      if (lum > best) {
        best = lum;
        at = i;
      }
    }
    const u = ((at % width) + 0.5) / width;
    const v = (Math.floor(at / width) + 0.5) / height;
    let elevation = (0.5 - v) * Math.PI;
    if (elevation < 0) elevation = -elevation;
    const azimuth = (u - 0.5) * Math.PI * 2;
    const toSun = new THREE.Vector3(
      Math.cos(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.sin(azimuth) * Math.cos(elevation),
    );
    this.sunOffset.copy(toSun).multiplyScalar(42);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromEquirectangular(hdr).texture;
    this.scene.environmentIntensity = 0.9;
    pmrem.dispose();
    hdr.dispose();

    const background = await new THREE.TextureLoader().loadAsync('assets/sky/sky.webp');
    background.mapping = THREE.EquirectangularReflectionMapping;
    background.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = background;
    this.scene.backgroundIntensity = 1.0;

    // The horizon's colour, from the band of the panorama just above it.
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 32;
    const g = canvas.getContext('2d');
    g.drawImage(background.image, 0, 0, 64, 32);
    const band = g.getImageData(0, 13, 64, 2).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < band.length; i += 4) for (let c = 0; c < 3; c += 1) sum[c] += band[i + c];
    const n = band.length / 4;
    this.scene.fog.color.setRGB(sum[0] / n / 255, sum[1] / n / 255, sum[2] / n / 255, THREE.SRGBColorSpace);

    // The sky now does the fill the hemisphere, bounce and ambient lights
    // stood in for; keep a little of each so interiors are not black.
    this._fill.hemisphere.intensity = 0.35;
    this._fill.bounce.intensity = 0.3;
    this._fill.ambient.intensity = 0.0;
    this.sun.intensity = 3.4;
    this.sun.color.set(0xfff0dc);
    if (this.sunSprite) this.sunSprite.visible = false;
  }

  /**
   * Light the place so it reads as a place.
   *
   * Four sources, each doing a different job. The sun casts the shadows that
   * make geometry look solid and tell a player how far away something is. A
   * dimmer bounce from the opposite side reaches under the roofs the sun
   * cannot. The sky light fills the rest with light that is blue from above
   * and warm from the ground, which is what stops shadowed faces going flat
   * grey. The ambient term is the smallest of the four on purpose: leaning on
   * it was the previous client's mistake, and a scene lit mostly by ambient
   * has no form in it at all, only coloured shapes.
   */
  /**
   * The shadow map's size, from the graphics quality. Over the same area at
   * every size, so a lower setting makes shadows coarser, never shorter: a
   * shadow round a corner is information, and no setting takes it away.
   */
  setShadowSize(size) {
    const shadow = this.sun?.shadow;
    if (!shadow || shadow.mapSize.x === size) return;
    shadow.mapSize.set(size, size);
    // Made again at the new size on the next frame.
    shadow.map?.dispose();
    shadow.map = null;
  }

  _buildLighting() {
    const sun = new THREE.DirectionalLight(0xfff2e0, 3.2);
    sun.position.set(SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z);
    sun.castShadow = true;
    // 2048 until the quality setting says otherwise (`setShadowSize`): four
    // times the texels cost real frames on integrated graphics and buy an
    // edge nobody looks at while being shot at, so only ultra pays for them.
    sun.shadow.mapSize.set(2048, 2048);

    // The shadow camera is an orthographic box that has to contain everything
    // that should cast. Sized to the arena rather than left at the default,
    // which covers ten metres and would drop every shadow past the first crate.
    //
    // It is no longer big enough to hold a map, and is not meant to be: the
    // arena is 102 m across now and the yard 252 m long, and a box that
    // covered either would be spreading 2048 texels over it. It follows the
    // player instead, in `positionSky`, so the texels stay where they are
    // being looked at.
    const extent = SHADOW_EXTENT;
    sun.shadow.camera.left = -extent;
    sun.shadow.camera.right = extent;
    sun.shadow.camera.top = extent;
    sun.shadow.camera.bottom = -extent;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 110;
    // Slopes and thin geometry self-shadow into stripes without these.
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    // Softens the shadow edge. A hard edge on flat-shaded geometry reads as a
    // second piece of geometry rather than as shade.
    sun.shadow.radius = 2.5;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // Bounce: a second, dimmer key from the opposite side that casts nothing.
    // Half this arena is roofed, and a single sun leaves everything under a
    // roof genuinely black - which is not what a real interior looks like,
    // because light gets in sideways and off the floor. This is the cheap
    // version of that, and the difference between a room and a hole.
    const bounce = new THREE.DirectionalLight(0xccd6e6, 0.85);
    bounce.position.set(-22, 12, -16);
    this.scene.add(bounce);
    this._fill = { bounce };

    // Paler than the sky it stands for. At full saturation every shadow on
    // the ground came out navy, which reads as a cartoon's night rather
    // than as shade on a sunny day - grey asphalt in shadow is grey.
    const sky = new THREE.HemisphereLight(0xbccbe0, 0x7a6449, 1.9);
    this.scene.add(sky);
    this._fill.hemisphere = sky;

    this._fill.ambient = new THREE.AmbientLight(0xffffff, 0.16);
    this.scene.add(this._fill.ambient);

    // The arena has no sky of its own, and the map's fourteen-metre walls do
    // not quite hide it. Left at a dark clear colour the gap above them reads
    // as a hole cut in the world; a daylight blue reads as outside, which is
    // what it is meant to be. The fog matches it, so geometry fades into the
    // sky rather than into a different colour a few metres short of it.
    // A gradient rather than a flat fill. A single colour behind the arena
    // reads as a backdrop; a sky that is paler at the horizon than overhead
    // reads as distance, and costs one 2x256 image.
    const skyColour = new THREE.Color(0x9fc2e8);
    this.scene.background = skyGradient(0x3f74bd, 0x9fc2e8);
    // Set here so there is fog before anything loads, and resized to the map
    // in `load`: distance haze that is right for a thirty-metre arena hides
    // half of a two-hundred-metre one.
    this.skyColour = skyColour;
    this.scene.fog = new THREE.Fog(skyColour, 38, 130);
  }

  /**
   * Fade geometry out at a distance that suits the map actually loaded.
   *
   * Fog is doing two jobs, and both scale with the map. It tells the eye how
   * far away something is, which flat-shaded untextured geometry otherwise
   * cannot; and it hides the far edge of the world, so the map ends in haze
   * rather than in a visible last wall with sky behind it.
   *
   * Tied to the diagonal rather than to either side, because that is the
   * longest sightline the map actually has - on a map three times longer than
   * it is wide, fog sized to the width would swallow the length of it.
   */
  _fogForSize(diagonal) {
    // Nothing within a third of the longest sightline is hazed at all, or
    // targets a player is shooting at would wash out; past the far edge is
    // beyond the world, so that is where geometry finishes fading.
    this.scene.fog.near = diagonal * 0.32;
    this.scene.fog.far = diagonal * 1.05;
  }

  /**
   * Sun, cloud and water.
   *
   * None of it is reachable and none of it collides - the perimeter brushes
   * stop a player long before any of it. It is there because the alternative
   * was worse: a flat pale void overhead and a hard edge where the map's
   * footprint stops, which reads as an unfinished level rather than as a
   * place. The water in particular does a job no fog could: it explains the
   * boundary instead of hiding it.
   *
   * All three follow the camera, so none of them can be walked out from
   * under. That is safe here precisely because they are scenery: nothing a
   * player does to them is visible to anyone else, and nothing about them
   * reaches the simulation.
   */
  _buildSky() {
    const sun = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: sunTexture(),
        color: 0xfff4dc,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    // Drawn before everything else and without depth, so it is always behind
    // the world however far away the far plane happens to be on this map.
    sun.renderOrder = -1;
    this.scene.add(sun);
    this.sunSprite = sun;

    // Water that reflects the sky it lies under. Standard rather than a
    // mirror pass: the environment map is already the sky, so reflecting it
    // costs nothing extra, and a mirror would draw the whole scene twice.
    // The waves are in the shader - sums of travelling sines, differentiated
    // into a normal - so the sun glints and the sky wobbles across it, and
    // the surface itself stays one flat quad.
    this._waterTime = { value: 0 };
    const waterMaterial = new THREE.MeshStandardMaterial({
      color: WATER_COLOUR,
      roughness: 0.06,
      metalness: 0.0,
      transparent: true,
      opacity: 0.93,
    });
    waterMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.waterTime = this._waterTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWorld;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vWaterWorld;
          uniform float waterTime;
          vec2 waterSlope(vec2 p) {
            vec2 g = vec2(0.0);
            // direction, wavelength, amplitude, speed
            vec4 waves[6];
            waves[0] = vec4(normalize(vec2(1.0, 0.3)), 9.0, 0.10);
            waves[1] = vec4(normalize(vec2(0.7, -1.0)), 5.3, 0.07);
            waves[2] = vec4(normalize(vec2(-0.4, 1.0)), 3.1, 0.045);
            waves[3] = vec4(normalize(vec2(1.0, 1.2)), 1.7, 0.03);
            waves[4] = vec4(normalize(vec2(-1.0, 0.2)), 0.9, 0.018);
            waves[5] = vec4(normalize(vec2(0.2, -1.0)), 0.47, 0.01);
            for (int i = 0; i < 6; i++) {
              float k = 6.2832 / waves[i].z;
              float c = sqrt(9.8 / k);
              float f = k * (dot(waves[i].xy, p) - c * waterTime * 0.6);
              g += waves[i].xy * k * waves[i].w * cos(f);
            }
            return g;
          }`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            float fade = 1.0 - smoothstep(60.0, 260.0, distance(vWaterWorld, cameraPosition));
            vec2 slope = waterSlope(vWaterWorld.xz) * mix(0.25, 1.0, fade);
            vec3 up = normalize(vec3(-slope.x, 1.0, -slope.y));
            normal = normalize((viewMatrix * vec4(up, 0.0)).xyz);
          }`,
        );
    };
    const water = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), waterMaterial);
    water.rotation.x = -Math.PI / 2;
    water.position.y = WATER_DEPTH;
    water.receiveShadow = false;
    this.scene.add(water);
    this.water = water;
  }

  /**
   * Place the scenery for this frame.
   *
   * `range` is the camera's far plane: everything here is sized and placed
   * from it, so a map with a 300 m view and one with a 150 m view both get a
   * sun near the edge of what they can see rather than one clipped away and
   * one sitting in the middle of the yard.
   */
  positionSky(eye, range) {
    if (!this.sunSprite) return;
    this.sunSprite.visible = !this.scene.environment;

    // Along the key light, so the sun is where the shadows say it is. Nothing
    // gives away a painted-on sky faster than shadows pointing elsewhere.
    const toSun = this._sunDirection ??= new THREE.Vector3();
    toSun.copy(this.sun.position).sub(this.sun.target.position).normalize();

    const distance = range * SKY_DISTANCE;
    this.sunSprite.position.copy(eye).addScaledVector(toSun, distance);
    this.sunSprite.scale.setScalar(distance * 0.16);

    this.water.position.set(eye.x, this.waterLevel ?? WATER_DEPTH, eye.z);
    this.arena?.userData.nature?.update(eye);
    this.water.scale.setScalar(range * 3);

    // Carry the shadow camera along with the player, keeping the sun's
    // direction fixed so the shadows do not swing as they walk.
    //
    // Snapped to whole shadow-map texels first. Without that the projection
    // slides by a fraction of a texel every frame and every shadow edge
    // crawls and fizzes as you move - the classic artefact of a moving
    // directional shadow, and far more distracting than the shadows simply
    // ending would have been.
    const texel = (SHADOW_EXTENT * 2) / this.sun.shadow.mapSize.x;
    const atX = Math.round(eye.x / texel) * texel;
    const atZ = Math.round(eye.z / texel) * texel;
    this.sun.position.set(atX + this.sunOffset.x, this.sunOffset.y, atZ + this.sunOffset.z);
    this.sun.target.position.set(atX, 0, atZ);
    this.sun.target.updateMatrixWorld();
  }

  /**
   * The match boundary, as something you can see before you walk into it.
   *
   * An open-ended cylinder, drawn from both sides and writing no depth, so
   * it reads as a sheet of light rather than as geometry. That matters: it
   * is not geometry - the simulation holds players inside a circle, and this
   * is only the client saying where that circle is. A player who cannot see
   * it walks into an invisible wall, which is the single most confusing
   * thing a game can do.
   *
   * Tall enough that no rooftop in either map is above it, because the
   * boundary applies at every height and a wall you can see the top of looks
   * like one you could climb over.
   */
  _buildZone() {
    const geometry = new THREE.CylinderGeometry(1, 1, ZONE_WALL_HEIGHT, 72, 1, true);
    const material = new THREE.MeshBasicMaterial({
      color: 0x74d0ff,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.zone = new THREE.Mesh(geometry, material);
    this.zone.position.y = ZONE_WALL_HEIGHT / 2;
    this.zone.renderOrder = 2;
    this.zone.visible = false;
    this.scene.add(this.zone);
  }

  /** Put the boundary where the server says it is. */
  setZone(radius) {
    if (!this.zone) return;
    // Not finite means no limit yet - before the first snapshot, or on a map
    // the circle never closes on. Drawing a ring at radius zero would put a
    // column of light through the middle of the map.
    if (!Number.isFinite(radius) || radius <= 0) {
      this.zone.visible = false;
      return;
    }
    this.zone.visible = true;
    this.zone.scale.set(radius, 1, radius);
  }

  _buildTracerPool() {
    // One reused pool rather than allocating geometry per shot. At the fire
    // rate this game runs, allocating would have the collector running during
    // firefights.
    const material = new THREE.LineBasicMaterial({
      color: 0xffe9a8,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    for (let i = 0; i < MAX_TRACERS; i += 1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(6), 3),
      );
      const line = new THREE.Line(geometry, material.clone());
      line.visible = false;
      line.frustumCulled = false;
      this.scene.add(line);
      this._tracers.push({ line, remaining: 0 });
    }
  }

  /**
   * Puts a map into the scene, taking the old one out.
   *
   * Callable more than once, because a player goes back to the menu between
   * matches and the next one may be somewhere else. Each map is downloaded
   * and prepared once and then kept: the yard is eleven megabytes, and paying
   * that again every time somebody plays two matches on it would be a loading
   * screen for something already in memory.
   */
  async load(url) {
    if (this.arena && this._loadedUrl === url) {
      this._takeWater(this.arena);
      return this.arena;
    }

    if (this.arena) {
      this.scene.remove(this.arena);
      this.arena = null;
    }

    let arena = this._maps?.get(url);
    if (arena) {
      this.scene.add(arena);
      this.arena = arena;
      this._loadedUrl = url;
      playBounds(arena, this.bounds);
      const cached = this.bounds.getSize(new THREE.Vector3());
      this._fogForSize(Math.hypot(cached.x, cached.z));
      this._takeWater(arena);
      return arena;
    }

    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    arena = gltf.scene;
    const names = [];
    arena.traverse((node) => {
      if (!node.isMesh) return;
      for (const material of [node.material].flat()) if (material?.name) names.push(material.name);
    });
    const photos = await loadPhotos(names);
    // The scale belongs to the map, and `SIM.arenaScale` is whichever map the
    // simulation is pointed at - so this reads it after `selectMap`, never
    // before. Drawing a map at another one's scale would put every wall
    // somewhere the server does not think it is.
    arena.scale.setScalar(SIM.arenaScale);

    arena.traverse((node) => {
      // Collided with, never drawn: the trunks of trees `nature.js` grows.
      if (node.userData?.collision_only) node.visible = false;
      if (!node.isMesh) return;
      node.castShadow = true;
      node.receiveShadow = true;
      // The map ships with flat colour materials and no texture at all, so
      // how it reads is almost entirely down to how it takes light.
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (!material) continue;
        // Left at the default these read as wet plastic, and at fully rough
        // they read as paper. This is closer to the painted metal and concrete
        // the shapes are meant to be, and leaves enough sheen for the key
        // light to pick out which way a surface faces. A surface the map
        // names carries its own roughness from the palette, and keeps it.
        if (!SURFACES[material.name]) {
          material.roughness = 0.72;
          material.metalness = 0.04;
        }
        // The model has no normals worth interpolating - every face is one
        // flat colour - so shading it flat is both truer to the art and what
        // makes each facet read as a separate plane catching its own light.
        material.flatShading = true;
        // Two surfaces are not paint. A lamp's lens gives light of its own,
        // and chain-link is a wire mesh you see through: drawn as a diamond
        // pattern cut out of its panel, in world metres, since the map has
        // no texture coordinates.
        if (material.name === 'lamp') {
          material.emissive = new THREE.Color(0xffe1b0);
          material.emissiveIntensity = 2.2;
          material.needsUpdate = true;
          continue;
        }
        if (material.name === 'chainlink') {
          chainLink(material);
          continue;
        }
        // Vertex colours are present on some of the arena meshes and multiply
        // the base colour to near black if the material does not expect them.
        addSurfaceDetail(material, photos[material.name]);
        material.needsUpdate = true;
      }
    });

    // Trees and grass, grown from what the map's extras say is there. After
    // the loop above, which is for the model's own flat-coloured materials.
    arena.userData.nature = await growNature(arena);
    // Vehicles, drums and crates, drawn properly over their stand-ins.
    await dressProps(arena);
    batchStatic(arena);

    this._maps = this._maps ?? new Map();
    this._maps.set(url, arena);
    this.scene.add(arena);
    this.arena = arena;
    this._loadedUrl = url;
    this._takeWater(arena);
    playBounds(arena, this.bounds);

    const size = this.bounds.getSize(new THREE.Vector3());
    this._fogForSize(Math.hypot(size.x, size.z));
    return arena;
  }

  /**
   * The sea's level and colour, as this map describes them.
   *
   * The map's scene extras carry them, the way the asphalt carries its own
   * paint, so the client stays a renderer of what the file says. Either
   * left out means the one every map had before a map could say.
   */
  _takeWater(map) {
    const extras = map.userData ?? {};
    this.waterLevel = typeof extras.water_level === 'number' ? extras.water_level : WATER_DEPTH;
    this.water?.material.color.set(
      typeof extras.water_colour === 'string' ? extras.water_colour : WATER_COLOUR,
    );
  }

  /** Whether the world has a map in it to draw. */
  get ready() {
    return Boolean(this.arena);
  }

  /** Draws the tracer for a shot the server says happened. */
  addTracer(from, to, hitPlayer) {
    const slot = this._tracers[this._nextTracer];
    this._nextTracer = (this._nextTracer + 1) % this._tracers.length;

    const positions = slot.line.geometry.getAttribute('position');
    positions.setXYZ(0, from[0], from[1], from[2]);
    positions.setXYZ(1, to[0], to[1], to[2]);
    positions.needsUpdate = true;

    slot.line.material.color.setHex(hitPlayer ? 0xff8a4d : 0xffe9a8);
    slot.line.visible = true;
    slot.remaining = TRACER_SECONDS;
  }

  /**
   * Grenades still to go off, as the server last placed them. Each is eased
   * towards its reported position so a grenade at twenty snapshots a second
   * rolls rather than hops. Purely drawn: where it goes off, and whom it
   * hurts, is the server's.
   */
  setGrenades(list) {
    this._grenades = this._grenades ?? new Map();
    const seen = new Set();
    for (const g of list) {
      seen.add(g.id);
      let entry = this._grenades.get(g.id);
      if (!entry) {
        entry = { mesh: makeGrenade(), target: new THREE.Vector3() };
        entry.mesh.position.set(g.position[0], g.position[1], g.position[2]);
        this.scene.add(entry.mesh);
        this._grenades.set(g.id, entry);
      }
      entry.target.set(g.position[0], g.position[1], g.position[2]);
    }
    for (const [id, entry] of this._grenades) {
      if (seen.has(id)) continue;
      this.scene.remove(entry.mesh);
      this._grenades.delete(id);
    }
  }

  /** A grenade went off here: a flash, a light, and smoke that rises. */
  explode(at) {
    this._blasts = this._blasts ?? [];
    let blast = this._blasts.find((b) => b.age >= BLAST_SECONDS);
    if (!blast) {
      blast = makeBlast();
      this.scene.add(blast.group);
      this._blasts.push(blast);
    }
    blast.group.position.set(at[0], at[1], at[2]);
    blast.age = 0;
    blast.group.visible = true;
    for (const puff of blast.puffs) {
      puff.mesh.position.set(
        (Math.random() - 0.5) * 1.6,
        Math.random() * 0.6,
        (Math.random() - 0.5) * 1.6,
      );
      puff.rise = 0.6 + Math.random() * 0.9;
      puff.grow = 1.4 + Math.random() * 1.6;
    }
  }

  update(dt) {
    blow(dt);
    if (this._waterTime) this._waterTime.value += dt;
    if (this._grenades) {
      const k = 1 - Math.exp(-18 * dt);
      for (const entry of this._grenades.values()) {
        entry.mesh.position.lerp(entry.target, k);
        entry.mesh.rotation.x += dt * 6;
        entry.mesh.rotation.z += dt * 4;
      }
    }
    for (const blast of this._blasts ?? []) {
      if (blast.age >= BLAST_SECONDS) continue;
      blast.age += dt;
      const t = blast.age;
      if (t >= BLAST_SECONDS) {
        blast.group.visible = false;
        continue;
      }
      const flash = Math.max(0, 1 - t / 0.22);
      blast.fireball.scale.setScalar(0.4 + (1 - flash) * 3.2);
      blast.fireball.material.opacity = flash;
      blast.light.intensity = flash * 60;
      for (const puff of blast.puffs) {
        puff.mesh.position.y += puff.rise * dt;
        const life = t / BLAST_SECONDS;
        puff.mesh.scale.setScalar(0.5 + puff.grow * Math.sqrt(life));
        puff.mesh.material.opacity = 0.55 * (1 - life) * Math.min(1, t / 0.08);
      }
    }
    for (const slot of this._tracers) {
      if (slot.remaining <= 0) continue;
      slot.remaining -= dt;
      if (slot.remaining <= 0) {
        slot.line.visible = false;
      } else {
        slot.line.material.opacity = Math.max(0, slot.remaining / TRACER_SECONDS);
      }
    }
  }

  /**
   * Keeps the sun's shadow box over the player.
   *
   * A 2048 map spread over the whole arena would be coarse enough to show
   * stair-stepped shadow edges. Following the player keeps the resolution where
   * it is being looked at.
   */
  followWithShadows(target) {
    if (!this.sun) return;
    this.sun.position.set(target.x + 18, target.y + 34, target.z + 12);
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
  }
}

/** How long a blast's smoke hangs. */
const BLAST_SECONDS = 2.6;

function makeGrenade() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0x3d4a2c, roughness: 0.8, metalness: 0.2 }),
  );
  body.scale.set(1, 1.25, 1);
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.026, 0.05, 8),
    new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.4, metalness: 0.8 }),
  );
  cap.position.y = 0.085;
  group.add(body, cap);
  group.castShadow = true;
  return group;
}

function makeBlast() {
  const group = new THREE.Group();
  const fireball = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({
      color: 0xffc070,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const light = new THREE.PointLight(0xffa550, 0, 18, 2);
  light.position.y = 0.5;
  const smoke = new THREE.MeshLambertMaterial({ color: 0x55504a, transparent: true, depthWrite: false });
  const puffs = [];
  for (let i = 0; i < 7; i += 1) {
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 1), smoke.clone());
    group.add(mesh);
    puffs.push({ mesh, rise: 1, grow: 2 });
  }
  group.add(fireball, light);
  return { group, fireball, light, puffs, age: BLAST_SECONDS };
}
