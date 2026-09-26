// Fetches the photographic materials, the sky and the foliage textures from
// Poly Haven, and writes them to assets/photo and assets/sky as WebP.
//
//   node scripts/fetch-photo-assets.mjs
//
// Everything here is CC0 (https://polyhaven.com/license): free to use,
// change and redistribute with no attribution required. ATTRIBUTION.md lists
// it anyway, so anyone can find the originals.
//
// The files are committed, like the maps and the soldier: they are outputs,
// and this is how they were made. Transcoding happens in the headless
// Chromium the end-to-end drivers use, because the canvas is the one image
// encoder every machine that builds this already has.
//
// Every texture is fetched at 1k and written as WebP: a colour map and, for
// a surface, an OpenGL-convention normal map. Foliage also has its alpha
// mask, as a file of its own.

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'package.json'));
const puppeteer = require('puppeteer-core');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.polyhaven.com/files/';

/**
 * Surfaces: the Poly Haven texture, and the name it is written under. The
 * client decides which of the map's surfaces wear which (`PHOTO` in
 * `photo.js`); several share one set.
 */
const SURFACES = {
  concrete_wall: 'concrete_wall_008',
  concrete_floor: 'concrete_floor_worn_001',
  asphalt: 'asphalt_02',
  grass: 'leafy_grass',
  meadow: 'aerial_grass_rock',
  dry_grass: 'dry_ground_01',
  dirt: 'dirt',
  gravel: 'gravel_floor',
  shore: 'coast_sand_rocks_02',
  cliff: 'cliff_side',
  corrugated: 'corrugated_iron_02',
  container: 'container_side',
  rusty_metal: 'rusty_metal_02',
  painted_metal: 'rusty_painted_metal',
  metal_plate: 'metal_plate_02',
  plaster: 'plastered_wall_02',
  brick: 'brick_wall_02',
  planks: 'brown_planks_03',
  roof_tiles: 'clay_roof_tiles_02',
  bark: 'pine_bark',
};

/** Foliage: the model it comes from, and which of its maps. */
const FOLIAGE = {
  leaves: ['tree_small_02', 'leaves_diff', 'leaves_alpha', 'leaves_nor_gl'],
  needles: ['fir_tree_01', 'twig_diff', 'twig_alpha', 'twig_nor_gl'],
  grass_blades: ['grass_medium_01', 'Diffuse', 'Alpha', 'nor_gl'],
};

const SKY = 'kloofendal_48d_partly_cloudy_puresky';

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
        const pixels = g.getImageData(0, 0, width, height);
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = width;
        maskCanvas.height = height;
        const m = maskCanvas.getContext('2d');
        m.drawImage(await load(alphaUrl), 0, 0, width, height);
        const mask = m.getImageData(0, 0, width, height).data;
        for (let i = 0; i < mask.length; i += 4) pixels.data[i + 3] = mask[i];
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

async function write(path, buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
  console.log(`  ${path.slice(root.length + 1)}  ${(buffer.length / 1024).toFixed(0)} KB`);
}

function url(files, key) {
  const entry = files[key]?.['1k']?.jpg ?? files[key]?.['1k']?.png;
  if (!entry) throw new Error(`no 1k map "${key}"`);
  return entry.url;
}

console.log('surfaces');
for (const [name, asset] of Object.entries(SURFACES)) {
  const albedoPath = resolve(root, 'assets', 'photo', `${name}_albedo.webp`);
  if (await exists(albedoPath)) continue;
  const files = await json(API + asset);
  await write(albedoPath, await transcode(await bytes(url(files, 'Diffuse'))));
  await write(
    resolve(root, 'assets', 'photo', `${name}_normal.webp`),
    await transcode(await bytes(url(files, 'nor_gl')), { quality: 0.8 }),
  );
}

console.log('foliage');
for (const [name, [asset, diffuse, alpha, normal]] of Object.entries(FOLIAGE)) {
  const albedoPath = resolve(root, 'assets', 'photo', `${name}_albedo.webp`);
  if (await exists(albedoPath)) continue;
  const files = await json(API + asset);
  // Colour and coverage as two files. A canvas stores colour premultiplied,
  // so encoding them together loses the colour under every transparent
  // pixel, and filtering then drags every leaf's edge towards black.
  await write(albedoPath, await transcode(await bytes(url(files, diffuse))));
  await write(
    resolve(root, 'assets', 'photo', `${name}_alpha.webp`),
    await transcode(await bytes(url(files, alpha)), { quality: 0.8 }),
  );
  await write(
    resolve(root, 'assets', 'photo', `${name}_normal.webp`),
    await transcode(await bytes(url(files, normal)), { quality: 0.8 }),
  );
}

console.log('sky');
const skyFiles = await json(API + SKY);
const hdrPath = resolve(root, 'assets', 'sky', 'sky_1k.hdr');
if (!(await exists(hdrPath))) await write(hdrPath, await bytes(skyFiles.hdri['1k'].hdr.url));
const backgroundPath = resolve(root, 'assets', 'sky', 'sky.webp');
if (!(await exists(backgroundPath))) {
  await write(
    backgroundPath,
    await transcode(await bytes(skyFiles.tonemapped.url), { size: 4096, height: 2048, quality: 0.84 }),
  );
}

await browser.close();
