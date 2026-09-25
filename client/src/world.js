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

/**
 * Break up large flat surfaces with a faint world-space grain.
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
 * however the model happens to be unwrapped, and nothing stretches.
 *
 * It fades out with distance, because detail finer than a pixel does not read
 * as detail. It reads as noise crawling over the geometry as the camera moves.
 */
function addSurfaceGrain(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.grainRange = { value: GRAIN_RANGE };
    shader.uniforms.grainDepth = { value: GRAIN_DEPTH };

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
        varying vec3 vGrainPosition;
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
        }`,
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
        }`,
      )
      .replace('GRAIN_COARSE', GRAIN_SCALE.toFixed(2))
      .replace('GRAIN_FINE', (GRAIN_SCALE * 0.28).toFixed(2));
  };

  // Three.js caches compiled programs per material configuration and does not
  // know that `onBeforeCompile` changed the source. Without a key of its own,
  // a grained material and a plain one with the same settings would share one
  // program and whichever compiled first would win.
  material.customProgramCacheKey = () => 'solatel-grain';
}

/** How far out the sun and the cloud deck sit. Inside the far plane, which is
 *  set from the map, so both are always drawn. */
const SKY_DISTANCE = 0.82;

/** Water sits just below the ground so the two never fight over the same
 *  depth, and so the map reads as a platform standing in it. */
const WATER_DEPTH = -0.4;

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


export class World {
  constructor(scene) {
    this.scene = scene;
    this.arena = null;
    this.bounds = new THREE.Box3();
    this._tracers = [];
    this._nextTracer = 0;

    this._buildLighting();
    this._buildSky();
    this._buildTracerPool();
    this._buildZone();
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
  _buildLighting() {
    const sun = new THREE.DirectionalLight(0xfff2e0, 3.2);
    sun.position.set(SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z);
    sun.castShadow = true;
    // 2048, not 4096. Four times the shadow texels cost real frames on
    // integrated graphics and buy an edge nobody looks at while being shot at.
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
    const bounce = new THREE.DirectionalLight(0xbfd4ff, 0.85);
    bounce.position.set(-22, 12, -16);
    this.scene.add(bounce);

    const sky = new THREE.HemisphereLight(0xa8c8ff, 0x7a6449, 1.9);
    this.scene.add(sky);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.16));

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

    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      // Lambert rather than standard. The water fills most of the screen
      // whenever a player looks outwards, and a physically-based shader over
      // that many pixels is real frames on integrated graphics for a surface
      // that is one flat colour taking one light. It still takes the light,
      // which is all that is wanted: the sun should sit on it.
      new THREE.MeshLambertMaterial({
        color: 0x2c6b8f,
        transparent: true,
        opacity: 0.94,
      }),
    );
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

    // Along the key light, so the sun is where the shadows say it is. Nothing
    // gives away a painted-on sky faster than shadows pointing elsewhere.
    const toSun = this._sunDirection ??= new THREE.Vector3();
    toSun.copy(this.sun.position).sub(this.sun.target.position).normalize();

    const distance = range * SKY_DISTANCE;
    this.sunSprite.position.copy(eye).addScaledVector(toSun, distance);
    this.sunSprite.scale.setScalar(distance * 0.16);

    this.water.position.set(eye.x, WATER_DEPTH, eye.z);
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
    this.sun.position.set(atX + SUN_OFFSET.x, SUN_OFFSET.y, atZ + SUN_OFFSET.z);
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
    if (this.arena && this._loadedUrl === url) return this.arena;

    if (this.arena) {
      this.scene.remove(this.arena);
      this.arena = null;
    }

    let arena = this._maps?.get(url);
    if (arena) {
      this.scene.add(arena);
      this.arena = arena;
      this._loadedUrl = url;
      this.bounds.setFromObject(arena);
      const cached = this.bounds.getSize(new THREE.Vector3());
      this._fogForSize(Math.hypot(cached.x, cached.z));
      return arena;
    }

    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    arena = gltf.scene;
    // The scale belongs to the map, and `SIM.arenaScale` is whichever map the
    // simulation is pointed at - so this reads it after `selectMap`, never
    // before. Drawing a map at another one's scale would put every wall
    // somewhere the server does not think it is.
    arena.scale.setScalar(SIM.arenaScale);

    arena.traverse((node) => {
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
        // light to pick out which way a surface faces.
        material.roughness = 0.72;
        material.metalness = 0.04;
        // The model has no normals worth interpolating - every face is one
        // flat colour - so shading it flat is both truer to the art and what
        // makes each facet read as a separate plane catching its own light.
        material.flatShading = true;
        // Vertex colours are present on some of the arena meshes and multiply
        // the base colour to near black if the material does not expect them.
        addSurfaceGrain(material);
        material.needsUpdate = true;
      }
    });

    this._maps = this._maps ?? new Map();
    this._maps.set(url, arena);
    this.scene.add(arena);
    this.arena = arena;
    this._loadedUrl = url;
    this.bounds.setFromObject(arena);

    const size = this.bounds.getSize(new THREE.Vector3());
    this._fogForSize(Math.hypot(size.x, size.z));
    return arena;
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

  update(dt) {
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
