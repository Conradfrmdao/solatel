// The operator's view, in a real browser: it signs in, every tab loads, a
// match opens with its replay drawn, and nothing on the page throws.
//
//   SOLATEL_ADMIN_TOKEN=... node client/admin.mjs [http://host:port]
//
// Needs a server with that token set and at least one finished match. The
// page is one file of script compiled into the server; a typo in it breaks
// the whole view, and nothing else would notice - which is how one shipped.

import puppeteer from 'puppeteer-core';

const base = process.argv.slice(2).find((a) => a.startsWith('http')) ?? 'http://localhost:8080';
const token = process.env.SOLATEL_ADMIN_TOKEN;
if (!token) {
  console.error('FAIL  set SOLATEL_ADMIN_TOKEN to the server\'s admin token');
  process.exit(1);
}

const failures = [];
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(what);
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium',
  headless: 'new',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1240, height: 1000 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.evaluateOnNewDocument((t) => sessionStorage.setItem('solatel.admin', t), token);

await page.goto(`${base}/admin`, { waitUntil: 'domcontentloaded' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = async (hash, ready) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await sleep(200);
  await page.waitForFunction(ready, { timeout: 20000 }).catch(() => {});
  return page.evaluate(() => document.querySelector('main')?.textContent ?? '');
};

const loaded = () => !document.querySelector('main')?.textContent.includes('loading');
for (const tab of ['overview', 'reviews', 'players', 'matches']) {
  const text = await open(tab, loaded);
  check(text.length > 0 && !text.includes('could not load'), `the ${tab} tab loads`);
}

const matchId = await page.evaluate(() => document.querySelector('a[href^="#matches/"]')?.getAttribute('href').split('/')[1]);
check(Boolean(matchId), 'there is a finished match to open');
if (matchId) {
  await open(`matches/${matchId}`, () => document.querySelector('canvas') || document.body.textContent.includes('No recording'));
  const replay = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return null;
    const g = canvas.getContext('2d');
    const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit += 1;
    return { lit, slider: Number(document.querySelector('input[type=range]').max) };
  });
  check(Boolean(replay), 'the match has its replay', replay ? `${replay.slider} ticks` : 'no recording');
  if (replay) check(replay.lit > 1000, 'the replay draws the map and the players', `${replay.lit} pixels`);
}

check(errors.length === 0, 'nothing on the page threw', errors.join(' | '));
await browser.close();
console.log(failures.length ? `\nFAILED ${failures.length}` : '\nOK   the admin view works');
process.exit(failures.length ? 1 : 0);
