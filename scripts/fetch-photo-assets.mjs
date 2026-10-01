// Fetches the photographic materials, the sky and the foliage textures from
// Poly Haven, and writes them to assets/photo and assets/sky.
//
//   bash scripts/build-basisu.sh      # once: the KTX2 encoder
//   node scripts/fetch-photo-assets.mjs
//
// Everything here is CC0 (https://polyhaven.com/license): free to use,
// change and redistribute with no attribution required. ATTRIBUTION.md lists
// it anyway, so anyone can find the originals.
//
// The files are committed, like the maps and the soldier: they are outputs,
// and this is how they were made. A file already written is left alone, so
// delete one to make it again.
//
// A surface is two KTX2 files, Basis Universal UASTC with zstd and every mip
// level: its colour, and its OpenGL-convention normal map with the roughness
// in the alpha. A GPU keeps them compressed - a 2k photograph is 5 MB of
// video memory rather than the 22 a decoded WebP took - which is what makes
// 2k affordable at all; and UASTC rather than the smaller ETC1S because
// ETC1S shows its blocks on a wall a player is standing at. Encoding needs
// `basisu`: `bash scripts/build-basisu.sh` builds it, or set BASISU. The
// average colour and roughness of each set, which `photo.js` tints from and
// varies the palette's gloss around, are written to `client/src/photo-sets.js`.
//
// Foliage and skies go through the headless Chromium the end-to-end drivers
// use, because the canvas is the one image encoder every machine that builds
// this already has: foliage as WebP at 1k (a colour map and, as a file of its
// own, the alpha mask), skies as a 1k HDR and a WebP panorama.

import { mkdir, writeFile, readFile, stat, rm, mkdtemp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'package.json'));
const puppeteer = require('puppeteer-core');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.polyhaven.com/files/';
const BASISU = process.env.BASISU ?? resolve(root, 'target', 'basisu', 'basisu');

/**
 * Surfaces: the Poly Haven texture, and the sizes its colour and its normal
 * map are fetched at. The client decides which of the map's surfaces wear
 * which (`PHOTO` in `photo.js`); several share one set.
 *
 * Sizes are bought by the megabyte, and these were measured: a map's
 * photographs are most of its download, and the facility, which wears
 * seventeen sets, is held under 50 MB. Colour at 2k for anything a player
 * stands next to - walls, floors, containers, roofs of corrugated sheet -
 * and every normal map at 1k: the lighting reads the
 * shape of a surface at a coarser scale than the eye reads its colour, and
 * up close the shader adds a grain finer than either. Grainy ground -
 * grass, gravel, earth - is 1k throughout: it is the worst case for the
 * encoder (gravel was 9.5 MB at 2k, against 4 for a concrete wall) and the
 * best case for the eye, which finds no edge in grain to call blurred - and
 * so are rock and planks, which are mostly crates and outcrops seen from a
 * few metres off.
 */
const SURFACES = {
  concrete_wall: ['concrete_wall_008', '2k', '1k'],
  concrete_floor: ['concrete_floor_worn_001', '2k', '1k'],
  asphalt: ['asphalt_02', '2k', '1k'],
  grass: ['leafy_grass', '1k', '1k'],
  dry_grass: ['dry_ground_01', '1k', '1k'],
  dirt: ['dirt', '1k', '1k'],
  gravel: ['gravel_floor', '1k', '1k'],
  shore: ['coast_sand_rocks_02', '1k', '1k'],
  cliff: ['cliff_side', '1k', '1k'],
  corrugated: ['corrugated_iron_02', '2k', '1k'],
  container: ['container_side', '2k', '1k'],
  rusty_metal: ['rusty_metal_02', '1k', '1k'],
  painted_metal: ['rusty_painted_metal', '1k', '1k'],
  metal_plate: ['metal_plate_02', '1k', '1k'],
  plaster: ['plastered_wall_02', '2k', '1k'],
  brick: ['brick_wall_02', '2k', '1k'],
  planks: ['brown_planks_03', '1k', '1k'],
  roof_tiles: ['clay_roof_tiles_02', '1k', '1k'],
  bark: ['pine_bark', '1k', '1k'],
};

/**
 * Rate-distortion settings, by what was measured on concrete_wall_008 at 2k:
 * colour at 2 is 41.8 dB against the original in 2.2 MB, and nothing an eye
 * finds; a normal map takes a little more, because light spreads its error.
 *
 * Every image is stored upside down (`-y_flip`). A WebGL texture is flipped
 * as it is uploaded and a compressed one cannot be, so without this every
 * photograph would lie the other way up from the WebP it replaced - and a
 * normal map the other way up lights every bump as a dent.
 */
const COMMON = ['-uastc', '-uastc_level', '2', '-ktx2', '-ktx2_zstandard_level', '18', '-mipmap', '-y_flip'];
const COLOUR = [...COMMON, '-uastc_rdo_l', '2', '-mip_srgb'];
const NORMAL = [...COMMON, '-uastc_rdo_l', '3', '-linear', '-mip_linear', '-normal_map'];

/** Foliage: the model it comes from, and which of its maps. */
const FOLIAGE = {
  leaves: ['tree_small_02', 'leaves_diff', 'leaves_alpha', 'leaves_nor_gl'],
  needles: ['fir_tree_01', 'twig_diff', 'twig_alpha', 'twig_nor_gl'],
  grass_blades: ['grass_medium_01', 'Diffuse', 'Alpha', 'nor_gl'],
};

/**
 * Skies, by the name `world.js` knows them by: each map has its own (see
 * `SKIES` there). A 1k HDR for the light and a tonemapped panorama for what
 * is seen; a map downloads only its own.
 */
const SKIES = {
  partly: 'kloofendal_48d_partly_cloudy_puresky',
  overcast: 'overcast_soil_puresky',
  afternoon: 'syferfontein_18d_clear_puresky',
};

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

async function bytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function dataUrl(buffer, type = 'image/jpeg') {
  return `data:${type};base64,${buffer.toString('base64')}`;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
  headless: 'new',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.goto('about:blank');

/** Decode, resize, optionally take alpha from a mask, and encode as WebP. */
async function transcode(colour, { alpha = null, size = 1024, height = size, quality = 0.8 } = {}) {
  const out = await page.evaluate(
    async (colourUrl, alphaUrl, width, height, quality) => {
      const load = (url) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = url;
        });
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d', { colorSpace: 'srgb' });
      g.imageSmoothingQuality = 'high';
      g.drawImage(await load(colourUrl), 0, 0, width, height);
      if (alphaUrl) {
        // Paint everything the mask leaves out in the average colour of
        // what it keeps. The scan is near white under its transparent
        // parts, and a distant mip averages the leaves with whatever is
        // there: left white, every tree on a far hill turns to frost.
        const pixels = g.getImageData(0, 0, width, height);
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = width;
        maskCanvas.height = height;
        const m = maskCanvas.getContext('2d');
        m.drawImage(await load(alphaUrl), 0, 0, width, height);
        const mask = m.getImageData(0, 0, width, height).data;
        const sum = [0, 0, 0];
        let n = 0;
        for (let i = 0; i < mask.length; i += 4) {
          if (mask[i] < 128) continue;
          for (let c = 0; c < 3; c += 1) sum[c] += pixels.data[i + c];
          n += 1;
        }
        for (let i = 0; i < mask.length; i += 4) {
          if (mask[i] >= 128) continue;
          for (let c = 0; c < 3; c += 1) pixels.data[i + c] = sum[c] / Math.max(n, 1);
        }
        g.putImageData(pixels, 0, 0);
      }
      return canvas.toDataURL('image/webp', quality);
    },
    dataUrl(colour),
    alpha ? dataUrl(alpha) : null,
    size,
    height,
    quality,
  );
  return Buffer.from(out.split(',')[1], 'base64');
}

/** The mean colour of an image, sRGB 0 to 255, from an 8 x 8 copy. */
async function averageColour(image) {
  return page.evaluate(async (src) => {
    const picture = new Image();
    await new Promise((done, fail) => {
      picture.onload = done;
      picture.onerror = fail;
      picture.src = src;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const g = canvas.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(picture, 0, 0, 8, 8);
    const data = g.getImageData(0, 0, 8, 8).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c += 1) sum[c] += data[i + c];
    return sum.map((v) => Math.round(v / 64));
  }, dataUrl(image));
}

async function write(path, buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
  console.log(`  ${path.slice(root.length + 1)}  ${(buffer.length / 1024).toFixed(0)} KB`);
}

/** A map's URL at a size, in the first of `kinds` it comes in. */
function url(files, key, size = '1k', kinds = ['jpg', 'png']) {
  for (const kind of kinds) {
    const entry = files[key]?.[size]?.[kind];
    if (entry) return entry.url;
  }
  throw new Error(`no ${size} map "${key}"`);
}

function encode(args) {
  const run = spawnSync(BASISU, args, { encoding: 'utf8' });
  if (run.error) throw new Error(`cannot run ${BASISU} (bash scripts/build-basisu.sh builds it): ${run.error.message}`);
  if (run.status !== 0) throw new Error(`basisu failed:\n${run.stdout}\n${run.stderr}`);
}

console.log('surfaces');
const sets = {};
const work = await mkdtemp(join(tmpdir(), 'solatel-photo-'));
for (const [name, [asset, colourSize, normalSize]] of Object.entries(SURFACES)) {
  const colourPath = resolve(root, 'assets', 'photo', `${name}_albedo.ktx2`);
  const normalPath = resolve(root, 'assets', 'photo', `${name}_normal.ktx2`);
  const files = await json(API + asset);
  const colour = await bytes(url(files, 'Diffuse', colourSize));
  const roughness = await bytes(url(files, 'Rough', normalSize));
  sets[name] = {
    average: await averageColour(colour),
    roughness: (await averageColour(roughness))[1] / 255,
    size: Number.parseInt(colourSize, 10) * 1024,
  };
  const at = (file) => join(work, `${name}_${file}`);
  if (!(await exists(colourPath))) {
    await writeFile(at('colour.jpg'), colour);
    encode([at('colour.jpg'), ...COLOUR, '-output_file', at('albedo.ktx2')]);
    await write(colourPath, await readFile(at('albedo.ktx2')));
  }
  if (!(await exists(normalPath))) {
    // The normal map as PNG: a JPEG's blocks would be bumps in the light.
    await writeFile(at('normal.png'), await bytes(url(files, 'nor_gl', normalSize, ['png'])));
    await writeFile(at('rough.jpg'), roughness);
    encode([at('normal.png'), '-alpha_file', at('rough.jpg'), ...NORMAL, '-output_file', at('normal.ktx2')]);
    await write(normalPath, await readFile(at('normal.ktx2')));
  }
}
await rm(work, { recursive: true, force: true });
await writeFile(
  resolve(root, 'client', 'src', 'photo-sets.js'),
  '// Written by scripts/fetch-photo-assets.mjs; do not edit.\n' +
    '//\n' +
    "// Each photo set's average colour (sRGB, 0 to 255), which `photo.js` tints\n" +
    "// from; its average roughness, which the palette's gloss is varied around;\n" +
    '// and the size its colour was fetched at.\n' +
    'export const PHOTO_SETS = {\n' +
    Object.entries(sets)
      .map(
        ([name, { average, roughness, size }]) =>
          `  ${name}: { average: [${average.join(', ')}], roughness: ${roughness.toFixed(3)}, size: ${size} },\n`,
      )
      .join('') +
    '};\n',
);

console.log('foliage');
for (const [name, [asset, diffuse, alpha, normal]] of Object.entries(FOLIAGE)) {
  const albedoPath = resolve(root, 'assets', 'photo', `${name}_albedo.webp`);
  if (await exists(albedoPath)) continue;
  const files = await json(API + asset);
  // Colour and coverage as two files. A canvas stores colour premultiplied,
  // so encoding them together loses the colour under every transparent
  // pixel, and filtering then drags every leaf's edge towards black.
  const mask = await bytes(url(files, alpha));
  await write(albedoPath, await transcode(await bytes(url(files, diffuse)), { alpha: mask }));
  await write(
    resolve(root, 'assets', 'photo', `${name}_alpha.webp`),
    await transcode(mask, { quality: 0.8 }),
  );
  await write(
    resolve(root, 'assets', 'photo', `${name}_normal.webp`),
    await transcode(await bytes(url(files, normal)), { quality: 0.8 }),
  );
}

for (const [name, id] of Object.entries(SKIES)) {
  console.log(`sky ${name}`);
  const skyFiles = await json(API + id);
  const hdrPath = resolve(root, 'assets', 'sky', `${name}_1k.hdr`);
  if (!(await exists(hdrPath))) await write(hdrPath, await bytes(skyFiles.hdri['1k'].hdr.url));
  const backgroundPath = resolve(root, 'assets', 'sky', `${name}.webp`);
  if (!(await exists(backgroundPath))) {
    await write(
      backgroundPath,
      await transcode(await bytes(skyFiles.tonemapped.url), { size: 4096, height: 2048, quality: 0.84 }),
    );
  }
}

await browser.close();
