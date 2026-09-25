// Loads the client in a real browser and reports what happened.
//
//   node client/smoke.mjs [--shot out.png] [--seconds 6] [--tabs 2]
//
// This is not a unit test. It is the cheapest way to answer the questions that
// actually go wrong in a browser client and that nothing else catches: did the
// wasm instantiate, did the models parse, did WebGL come up, did the socket
// reach the server, and is anything throwing once a frame. All of those fail
// silently to a person who is only told "the page is blank".
//
// `--tabs 2` opens a second client so the first has someone to look at, which
// is the only way to see another player's model and animation at all.

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.SOLATEL_URL ?? 'http://localhost:8080/?debug=1&nolock=1';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};

const seconds = Number(flag('--seconds', '6'));
const tabs = Number(flag('--tabs', '1'));
const shot = flag('--shot', null);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--window-size=1280,760',
    // Headless Chrome has no GPU, so WebGL has to come from the software
    // rasteriser. Without these the context creation fails and the page is
    // blank for a reason that has nothing to do with the client.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--mute-audio',
    '--no-sandbox',
  ],
});

const report = [];
const pages = [];

for (let i = 0; i < tabs; i += 1) {
  const page = await browser.newPage();
  // Headless has no GPU: everything is software-rasterised, so a full-size
  // viewport runs at a couple of frames a second and the simulation - which
  // deliberately refuses to replay a backlog - barely advances. A small
  // viewport is the difference between testing movement and testing nothing.
  await page.setViewport({ width: 800, height: 500 });

  const log = { index: i, console: [], errors: [], failed: [], aborted: [] };
  page.on('console', (message) => {
    const type = message.type();
    if (type === 'error' || type === 'warning') {
      log.console.push(`${type}: ${message.text()}`);
    }
  });
  page.on('pageerror', (err) => log.errors.push(String(err)));
  page.on('requestfailed', (request) => {
    const why = request.failure()?.errorText ?? '';
    // Closing the browser aborts whatever is still in flight, which is not a
    // fault in the client. Kept visible, but not counted against it.
    const line = `${request.url()} ${why}`;
    if (why.includes('ERR_ABORTED')) log.aborted.push(line);
    else log.failed.push(line);
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      log.failed.push(`${response.url()} HTTP ${response.status()}`);
    }
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Boot is several megabytes of models parsed by a software renderer, so how
  // long it takes is not worth guessing at. Wait for the client to say it is
  // in the world instead.
  try {
    await page.waitForFunction(
      () => window.solatel && window.solatel.link.isReady,
      { timeout: 90000, polling: 250 },
    );
  } catch {
    log.errors.push('client never reached the world within 90 s');
  }
  pages.push({ page, log });
  report.push(log);
}

// A moment for the first snapshots to arrive and for everyone to see everyone.
await new Promise((r) => setTimeout(r, 1500));

const driver = pages[0].page;
// Synthetic key events go to the focused page, and in a multi-tab headless
// browser that is whichever was opened last.
await driver.bringToFront();

// Point the first client at the second and walk at them, so that the remote
// player's model, its animation and the weapon in its hand are all actually on
// screen rather than merely constructed. Standing still would have proved only
// that nothing crashed.
if (pages[1] && (await pages[1].page.evaluate(() => Boolean(window.solatel)))) {
  const target = await pages[1].page.evaluate(() => ({
    x: window.solatel.local.current.x,
    z: window.solatel.local.current.z,
  }));
  await driver.evaluate((to) => {
    const me = window.solatel.local.current;
    // yaw 0 looks down -Z, and yaw increases towards -X.
    window.solatel.input.yaw = Math.atan2(-(to.x - me.x), -(to.z - me.z));
  }, target);
}

await driver.keyboard.down('KeyW');
await driver.mouse.down({ button: 'left' });
await new Promise((r) => setTimeout(r, seconds * 1000));
await driver.mouse.up({ button: 'left' });
await driver.keyboard.up('KeyW');
await new Promise((r) => setTimeout(r, 400));

// Turn the second client to face the first, so the screenshot it takes has
// another player's model in it. Everything about the character - the skinning,
// the animation, the rifle on the hand bone - is only ever visible from
// somebody else's eyes.
if (pages[1] && (await pages[1].page.evaluate(() => Boolean(window.solatel)))) {
  const at = await driver.evaluate(() => ({
    x: window.solatel.local.current.x,
    z: window.solatel.local.current.z,
  }));
  await pages[1].page.evaluate((to) => {
    const me = window.solatel.local.current;
    window.solatel.input.yaw = Math.atan2(-(to.x - me.x), -(to.z - me.z));
  }, at);
  await new Promise((r) => setTimeout(r, 600));
}

for (const { page, log } of pages) {
  log.probe = await page.evaluate(() => {
    const s = window.solatel;
    if (!s) return null;
    const remotes = [...s.remotes.players.values()];
    const first = remotes[0];
    let weapon = null;
    if (first) {
      const bone = first.root.getObjectByName('hand_R_022');
      weapon = bone ? bone.children.length : 0;
    }
    return {
      position: [s.local.current.x, s.local.current.y, s.local.current.z].map(
        (v) => Number(v.toFixed(2)),
      ),
      onGround: s.local.onGround,
      speed: Number(s.local.speed.toFixed(2)),
      predictionError: Number(s.local.predictionError.toFixed(4)),
      remoteCount: remotes.length,
      remoteGait: first ? first.gait : null,
      weaponsOnHand: weapon,
      brushes: s.SIM ? undefined : undefined,
    };
  });

  log.state = await page.evaluate(() => {
    const stats = document.getElementById('stats');
    const banner = document.getElementById('banner');
    const boot = document.getElementById('boot-status');
    const canvas = document.getElementById('solatel-canvas');
    return {
      stats: stats ? stats.textContent : null,
      banner: banner && !banner.classList.contains('hidden') ? banner.textContent : null,
      boot: boot ? boot.textContent : null,
      running: document.body.classList.contains('running'),
      // Where the client actually is. Booting the client no longer drops
      // anybody into a world: it lands in the menu, and the world is loaded
      // when a match forms around the table they pick. `running` is false
      // there, correctly, and saying only that would read as a failure.
      menu: document.getElementById('menu')
        ? !document.getElementById('menu').classList.contains('hidden')
        : false,
      canvas: canvas ? `${canvas.width}x${canvas.height}` : null,
    };
  });
}

// Put the second client's camera a couple of metres in front of the first
// player and look straight at them. Nothing else can show whether the rifle
// really landed in the hand, since a player never sees their own body.
if (pages[1] && process.argv.includes('--inspect')) {
  const at = await driver.evaluate(() => ({
    x: window.solatel.local.current.x,
    y: window.solatel.local.current.y,
    z: window.solatel.local.current.z,
    yaw: window.solatel.input.yaw,
  }));
  await pages[1].page.evaluate((who) => {
    // Stand off along the direction they are facing, so we see their front.
    const ahead = { x: -Math.sin(who.yaw), z: -Math.cos(who.yaw) };
    // Above head height looking down, because at eye level whatever they are
    // standing behind is between us and them.
    window.solatel.cameraOverride = {
      x: who.x + ahead.x * 2.4,
      y: who.y + 2.2,
      z: who.z + ahead.z * 2.4,
      tx: who.x,
      ty: who.y + 0.35,
      tz: who.z,
    };
  }, at);
  await new Promise((r) => setTimeout(r, 1500));
}

// A camera high above one end looking down the arena, for judging the look of
// the place and how much cover is in it - neither of which is visible from
// inside a doorway, which is where a player who walked forward for ten seconds
// usually ends up.
if (process.argv.includes('--overview')) {
  await pages[0].page.evaluate(() => {
    window.solatel.cameraOverride = {
      x: 0, y: 26, z: -46, tx: 0, ty: 2, tz: 6,
    };
  });
  if (pages[1]) {
    await pages[1].page.evaluate(() => {
      window.solatel.cameraOverride = {
        x: 13, y: 7, z: 20, tx: -2, ty: 2, tz: -10,
      };
    });
  }
  await new Promise((r) => setTimeout(r, 1800));
}

if (shot) {
  await mkdir(dirname(resolve(shot)), { recursive: true });
  // Full size for the screenshots, so what lands on disk is what a player
  // would see rather than the reduced viewport the movement test ran at.
  for (const { page } of pages) {
    await page.setViewport({ width: 1280, height: 760 });
  }
  await new Promise((r) => setTimeout(r, 1200));
  await pages[0].page.screenshot({ path: resolve(shot) });
  if (pages[1]) {
    await pages[1].page.screenshot({
      path: resolve(shot).replace(/\.png$/, '-b.png'),
    });
  }
}

await browser.close();

let bad = 0;
for (const log of report) {
  console.log(`\n=== client ${log.index} ===`);
  const where = log.state.menu ? 'in the menu' : log.state.running ? 'in a match' : 'nowhere';
  console.log(`  ${where}   canvas: ${log.state.canvas}`);
  if (log.probe) {
    console.log(
      `  position ${JSON.stringify(log.probe.position)}  speed ${log.probe.speed}  ` +
        `onGround ${log.probe.onGround}  predictErr ${log.probe.predictionError}`,
    );
    console.log(
      `  remotes seen ${log.probe.remoteCount}` +
        (log.probe.remoteGait ? `  gait ${log.probe.remoteGait}` : '') +
        (log.probe.weaponsOnHand !== null
          ? `  weapons on hand bone ${log.probe.weaponsOnHand}`
          : ''),
    );
  }
  if (log.state.banner) {
    console.log(`  BANNER: ${log.state.banner}`);
    bad += 1;
  }
  if (log.state.boot) console.log(`  boot status: ${log.state.boot}`);
  console.log(
    log.state.stats
      ? log.state.stats
          .split('\n')
          .map((line) => `  | ${line}`)
          .join('\n')
      : '  (no stats)',
  );
  for (const err of log.errors) {
    console.log(`  PAGE ERROR: ${err}`);
    bad += 1;
  }
  for (const line of log.failed) {
    console.log(`  REQUEST FAILED: ${line}`);
    bad += 1;
  }
  if (log.aborted.length) {
    console.log(`  (${log.aborted.length} request(s) aborted at teardown)`);
  }
  for (const line of log.console.slice(0, 12)) console.log(`  ${line}`);
}

process.exit(bad > 0 ? 1 : 0);
