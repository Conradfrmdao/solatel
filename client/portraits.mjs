// The menu's pictures of the guns and of the soldier in every skin, drawn
// once and kept as files.
//
// The menu used to draw them itself when it opened, on a renderer of its
// own, and that held the main thread for seconds - shaders compiled, an
// environment built, a picture read back per gun and per skin - exactly as
// the player arrived. So they are drawn here instead, by the page's own code
// (`portraits.js`, run when the address carries `?portraits=1`), from the
// same models a player sees, and written as WebP into the assets the build
// publishes:
//
//   assets/menu/guns/<weapon>.webp    each primary, with its first optic
//   assets/menu/skins/<skin>.webp     the soldier in each skin
//
// Run it after changing a gun's model, a skin, or the soldier, against a
// server serving the current build (any server: nothing here plays):
//
//   node client/portraits.mjs [--url http://localhost:8080]
//
// then rebuild the client so the new files are published.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const at = args.indexOf('--url');
const base = at >= 0 ? args[at + 1] : 'http://localhost:8080';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const fs = await import('node:fs');
const executablePath = CHROME.find((p) => p && fs.existsSync(p));
if (!executablePath) {
  console.error('FAIL  no Chrome found to draw with');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  protocolTimeout: 900_000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.log('page error:', error.message));
  await page.goto(`${base}/?portraits=1&nolock=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.solatelPortraits), { timeout: 600_000, polling: 500 });
  const drawn = await page.evaluate(() => window.solatelPortraits);
  const write = async (folder, name, url) => {
    if (!url?.startsWith('data:image/webp;base64,')) throw new Error(`${folder}/${name} was not drawn as WebP`);
    const path = join(root, 'assets', 'menu', folder, `${name}.webp`);
    await mkdir(dirname(path), { recursive: true });
    const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    await writeFile(path, bytes);
    console.log(`>> ${join('assets', 'menu', folder, `${name}.webp`)}  ${(bytes.length / 1024).toFixed(1)} KB`);
  };
  // The guns come back keyed `weapon:optic`; the file is the weapon's.
  for (const [key, url] of Object.entries(drawn.guns)) await write('guns', key.split(':')[0], url);
  for (const [skin, url] of Object.entries(drawn.skins)) await write('skins', skin, url);
  if (!Object.keys(drawn.guns).length || !Object.keys(drawn.skins).length) {
    throw new Error('nothing was drawn');
  }
  console.log('OK   the menu\'s pictures are drawn; rebuild the client to publish them');
} finally {
  await browser.close();
}
