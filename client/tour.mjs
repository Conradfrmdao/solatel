// Pictures of a map from fixed places, for judging how it looks.
//
//   node client/tour.mjs [--map yard] [--out shots] [--quality high]
//                        [--size 1280x720] [--views 5] [--url http://localhost:8080]
//
// Queues for the map, then - with the HUD hidden and the camera detached
// (`cameraOverride`, debug only) - stands at the map's own spawns at eye
// height, looking the way each one faces, which is exactly what a player
// sees first; then one picture from above, and one through the player's own
// eyes with the rifle and the HUD. Each view waits for a few drawn frames so
// shadows and textures have caught up. The same views every run, so a
// change can be judged against the last one.
//
// Needs a server that starts a match for one person (`SOLATEL_MATCH_FLOOR=1`,
// a short `SOLATEL_QUEUE_WAIT`); with `SOLATEL_FREE_PLAY=1` it moves no money.
// Give it a long warm-up too (`SOLATEL_WARMUP=600`): the detached views are
// taken in the warm-up, because on a software renderer they take minutes and
// once the match is live the circle closes on a player who never moves,
// burns them, and puts the page back on the menu.
// A software renderer draws the picture correctly and says nothing about
// speed - measure that with perf.mjs on a real GPU.

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
}
const base = flag('--url', 'http://localhost:8080');
const mapName = flag('--map', 'arena');
const out = resolve(flag('--out', 'shots'));
const quality = flag('--quality', 'high');
const [width, height] = flag('--size', '1280x720').split('x').map(Number);
const views = Number(flag('--views', '5'));

await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
  headless: 'new',
  args: [
    '--no-sandbox',
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    `--window-size=${width},${height}`,
  ],
  protocolTimeout: 600000,
});
const page = await browser.newPage();
await page.setViewport({ width, height });
page.on('pageerror', (e) => console.log('page error:', e.message.slice(0, 200)));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`console ${m.type()}:`, m.text().slice(0, 200));
});

/** Waits for the game to draw `n` more frames, however slowly it draws them. */
const frames = (n) =>
  page.evaluate(
    (count) =>
      new Promise((done) => {
        let left = count;
        const step = () => (--left <= 0 ? done() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );

try {
  await page.goto(`${base}/?debug=1&nolock=1&quality=${quality}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`#menu-maps .map[data-map="${mapName}"]`, { timeout: 120000 });
  await page.click(`#menu-maps .map[data-map="${mapName}"]`);
  await page.waitForSelector('#menu-tables .table:not([disabled])', { visible: true, timeout: 30000 });
  await page.click('#menu-tables .table');
  await page.waitForFunction(() => document.body.classList.contains('running'), { timeout: 300000, polling: 500 });
  await frames(4);
  const started = performance.now();
  await frames(5);
  console.log(`>> on ${mapName} at ${quality}, ${((performance.now() - started) / 5000).toFixed(2)} s a frame here`);

  // Detached, with nothing over the picture.
  const cover = await page.addStyleTag({ content: '#hud, #menu, #matchmaking, #boot { display: none !important; }' });
  const plan = await page.evaluate(() => {
    const { SIM } = window.solatel;
    window.solatel.viewmodel.scene.visible = false;
    return { eye: SIM.eyeOffset, hx: SIM.arenaHalfX, hz: SIM.arenaHalfZ, spawns: Array.from(window.solatel.spawns) };
  });
  const { spawns } = plan;
  const n = spawns.length / 4;
  const shots = [];
  for (let i = 0; i < Math.min(views, n); i += 1) {
    const s = Math.floor((i * n) / Math.min(views, n)) * 4;
    const [x, y, z, yaw] = spawns.slice(s, s + 4);
    const eye = y + plan.eye;
    shots.push({
      name: `spawn${i + 1}`,
      at: { x, y: eye, z, tx: x - Math.sin(yaw) * 20, ty: eye - 1.0, tz: z - Math.cos(yaw) * 20 },
    });
  }
  // Up close, where a texture's resolution shows: the first wall along the
  // first spawn's facing, from a step back, and the ground at its feet.
  {
    const [x, y, z, yaw] = spawns.slice(0, 4);
    const eye = y + plan.eye;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    const boxes = await page.evaluate(() => Array.from(window.solatel.brushes));
    let nearest = 30;
    for (let i = 0; i < boxes.length; i += 6) {
      const [x0, y0, z0, x1, y1, z1] = boxes.slice(i, i + 6);
      if (eye < y0 || eye > y1) continue;
      // Slab test along the ray, in x and z.
      let near = 0;
      let far = nearest;
      for (const [o, d, lo, hi] of [[x, dx, x0, x1], [z, dz, z0, z1]]) {
        if (Math.abs(d) < 1e-9) {
          if (o < lo || o > hi) far = -1;
          continue;
        }
        const a = (lo - o) / d;
        const b = (hi - o) / d;
        near = Math.max(near, Math.min(a, b));
        far = Math.min(far, Math.max(a, b));
      }
      if (near <= far && near > 0.4) nearest = Math.min(nearest, near);
    }
    const back = Math.max(0, nearest - 1.3);
    shots.push({
      name: 'wall',
      at: { x: x + dx * back, y: eye, z: z + dz * back, tx: x + dx * nearest, ty: eye - 0.15, tz: z + dz * nearest },
    });
    shots.push({
      name: 'ground',
      at: { x, y: eye, z, tx: x + dx * 1.6, ty: y, tz: z + dz * 1.6 },
    });
  }
  const { hx, hz } = plan;
  shots.push({
    name: 'above',
    at: { x: -hx * 0.75, y: Math.max(hx, hz) * 0.55, z: -hz * 0.75, tx: hx * 0.1, ty: 0, tz: hz * 0.1 },
  });
  const inMatch = () => page.evaluate(() => document.body.classList.contains('running') && !document.body.classList.contains('in-menu'));
  for (const shot of shots) {
    await page.evaluate((at) => {
      window.solatel.cameraOverride = at;
    }, shot.at);
    await frames(3);
    if (!(await inMatch())) throw new Error('the match ended under the tour; give the server a longer SOLATEL_WARMUP');
    const file = `${out}/${mapName}-${shot.name}.png`;
    await page.screenshot({ path: file });
    console.log(`>> ${file}`);
  }
  const stats = await page.evaluate(() => window.solatel.stats());
  console.log(`>> ${stats.drawCalls} draw calls, ${stats.triangles.toLocaleString()} triangles in the last view`);

  // Then through the player's own eyes: rifle, HUD and all.
  await cover.evaluate((element) => element.remove());
  await page.evaluate(() => {
    window.solatel.cameraOverride = null;
    window.solatel.viewmodel.scene.visible = true;
  });
  await frames(3);
  await page.screenshot({ path: `${out}/${mapName}-player.png` });
  console.log(`>> ${out}/${mapName}-player.png`);
} finally {
  await browser.close();
}
