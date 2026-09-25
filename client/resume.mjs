// Does reloading the page get the same player back?
//
//   node client/resume.mjs
//
// The server's own tests cover the rules - which tokens are honoured, which
// are refused, when a body is retired. What they cannot cover is whether the
// browser actually keeps the token across a reload and presents it, because
// that is `sessionStorage` and a real page load, and neither exists inside a
// Rust test.
//
// So this is the one question, asked end to end: get into a match, remember
// who you are and where you are standing, reload, and check you are the same
// player, back in the same match, in the same place. A failure here means a
// player who refreshes loses a life they paid for.
//
// "Back in the same match" is its own check since the menu came first. A
// reloaded page knows nothing, and a server that took the player back
// without telling the page which match it was in left it on the menu,
// throwing away every snapshot, while the body stood in the match being shot.
//
// Needs a server that will start a match for one person:
//
//   SOLATEL_MATCH_FLOOR=1 SOLATEL_QUEUE_WAIT=3 ./x server

import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.SOLATEL_URL ?? 'http://localhost:8080/?debug=1&nolock=1';

/** How far the player may legitimately have drifted across the reload.
 *
 *  Not zero. The body is still in the world while the page is loading, and
 *  gravity still applies to it, so a player standing on a slope settles a
 *  little. Anything past this is a respawn, not a drift. */
const DRIFT_TOLERANCE = 1.5;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  // --no-sandbox because a Linux container runs this as root, where
  // Chromium's sandbox will not start.
  args: ['--window-size=900,600', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});

const page = await browser.newPage();
const failures = [];

/** In a match, with the world loaded and the player standing in it. */
async function inGame() {
  await page.waitForFunction(() => window.solatel && window.solatel.link.isReady, {
    timeout: 90_000,
  });
  // The welcome is queued for the frame loop, so wait until the local player
  // has actually consumed it and knows its own id.
  await page.waitForFunction(() => window.solatel.local.id, { timeout: 30_000 });
  await page.waitForFunction(
    () =>
      window.solatel.local.matchId &&
      window.solatel.world.ready &&
      document.body.classList.contains('running'),
    { timeout: 120_000 },
  );
  // A snapshot or two, so the position is the server's and not the spawn
  // the client guessed at.
  await new Promise((done) => setTimeout(done, 1000));
  return page.evaluate(() => ({
    id: window.solatel.local.id,
    match: window.solatel.local.matchId,
    map: window.solatel.local.mapName,
    resumed: Boolean(window.solatel.link.resumed),
    token: window.sessionStorage.getItem('solatel.resume'),
    x: window.solatel.local.current.x,
    y: window.solatel.local.current.y,
    z: window.solatel.local.current.z,
  }));
}

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  // Into a match the way a player gets into one: the menu, a map, a table.
  await page.waitForSelector('#menu-maps .map', { timeout: 90_000 });
  await page.click('#menu-maps .map');
  await page.waitForSelector('#menu-tables .table', { timeout: 30_000 });
  await page.click('#menu-tables .table');
  const before = await inGame();
  console.log(
    `first connection : ${before.id.slice(0, 8)}  ` +
      `at ${before.x.toFixed(1)}, ${before.y.toFixed(1)}, ${before.z.toFixed(1)}  ` +
      `resumed=${before.resumed}`,
  );

  if (before.resumed) {
    failures.push('the very first connection claimed to be a resume');
  }
  if (!before.token) {
    failures.push('no resume token was stored after the first welcome');
  }

  // Walk a little, so "same place" means something more than "both at the
  // spawn". Held for a second of wall clock, which at walking pace is several
  // metres.
  await page.evaluate(() => window.solatel.input._keys.add('KeyW'));
  await new Promise((done) => setTimeout(done, 1000));
  await page.evaluate(() => window.solatel.input._keys.delete('KeyW'));
  // Until the player has come to rest, not for a fixed time. On a slow
  // renderer - a software GPU draws a frame a second - the client sends its
  // last few inputs late, and a position read too early is one the server
  // has not finished walking to, which reads as drift across the reload.
  const where = () => page.evaluate(() => ({
    x: window.solatel.local.current.x,
    y: window.solatel.local.current.y,
    z: window.solatel.local.current.z,
  }));
  let moved = await where();
  for (let tries = 0; tries < 30; tries += 1) {
    await new Promise((done) => setTimeout(done, 500));
    const now = await where();
    const still = Math.hypot(now.x - moved.x, now.z - moved.z) < 0.01;
    moved = now;
    if (still) break;
  }
  const walked = Math.hypot(moved.x - before.x, moved.z - before.z);
  console.log(`walked           : ${walked.toFixed(1)} m from the spawn`);

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
  const after = await inGame();
  console.log(
    `after reload     : ${after.id.slice(0, 8)}  ` +
      `at ${after.x.toFixed(1)}, ${after.y.toFixed(1)}, ${after.z.toFixed(1)}  ` +
      `resumed=${after.resumed}`,
  );

  if (!after.resumed) {
    failures.push('the reload was not recognised as a resume');
  }
  if (after.id !== before.id) {
    failures.push(`a different player came back: ${before.id} -> ${after.id}`);
  }
  if (after.match !== before.match) {
    failures.push(`came back to a different match: ${before.match} -> ${after.match}`);
  }
  if (after.map !== before.map) {
    failures.push(`came back on different ground: ${before.map} -> ${after.map}`);
  }
  if (after.token === before.token) {
    failures.push('the same token was handed back, so it was never spent');
  }

  const drift = Math.hypot(after.x - moved.x, after.z - moved.z);
  console.log(`drift across it  : ${drift.toFixed(2)} m`);
  if (drift > DRIFT_TOLERANCE) {
    failures.push(
      `the player moved ${drift.toFixed(1)} m across the reload, which is a respawn`,
    );
  }
} catch (err) {
  failures.push(`threw: ${err.message}`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error('\nFAILED');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('\nOK: a reload kept the same player, in the same match and place, on a fresh token');
