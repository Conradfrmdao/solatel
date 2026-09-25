// The menu, driven the way a player drives it.
//
// `smoke.mjs` proves the client boots. This proves the screen in front of it
// works: that the menu is what a player lands on, that picking a map and a
// table puts them in a line, and that when the match forms the world is
// actually there to play - the map loaded, the canvas drawn, the pointer
// available.
//
// And the account behind it: that closing the tab and coming back is the
// same player with the same wallet, that a second tab takes the player over
// and the first stops fighting for them, and that the wallet pane tells a
// player where to send money and what to write in the memo.
//
//   node client/menu.mjs [--url http://host:port]
//
// It needs a server that will start a match for one person, which is
// `SOLATEL_MATCH_FLOOR=1` and a short `SOLATEL_QUEUE_WAIT`. On a real server a
// single client would sit in the queue, correctly, forever.

import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);

/** The value after a flag, or null. `indexOf` answers -1 for a flag that is
 *  not there, and -1 + 1 is 0 - which is the first argument, not nothing. */
function flag(name) {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? null) : null;
}

const base = flag('--url') ?? 'http://localhost:8080';
const url = `${base}/?debug=1&nolock=1`;

const CHROME = [
  // Set by the cloud session's startup hook to the preinstalled Chromium.
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(why) {
  console.error(`FAIL  ${why}`);
  process.exit(1);
}

const fs = await import('node:fs');
const executablePath = CHROME.find((p) => p && fs.existsSync(p));
if (!executablePath) fail('no Chrome found to drive');

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
/** A tab on the game, landed on the menu and welcomed. */
async function openTab() {
  const tab = await browser.newPage();
  await tab.setViewport({ width: 1280, height: 760 });
  tab.on('pageerror', (err) => fail(`page error: ${err.message}`));
  await tab.goto(url, { waitUntil: 'domcontentloaded' });
  await tab.waitForSelector('#menu:not(.hidden)', { timeout: 60000 });
  await tab.waitForFunction(() => Boolean(window.solatel?.link?.playerId), {
    timeout: 60000,
  });
  return tab;
}

const who = (tab) =>
  tab.evaluate(() => ({
    player: window.solatel.link.playerId,
    key: window.localStorage.getItem('solatel.account'),
  }));

// 0. An account, kept across closing the tab. Session storage - the resume
//    token - goes with the tab; the account key must not.
const first = await openTab();
const before = await who(first);
if (!before.key) fail('no account key was kept');
console.log(`>> account ${before.player}`);
await first.close();

let page = await openTab();
const after = await who(page);
if (after.player !== before.player) {
  fail(`closing the tab made a new player: ${before.player} -> ${after.player}`);
}
console.log('>> a closed tab comes back as the same player');

// A second tab on the same account takes the player over. The first is told
// and stops reconnecting - otherwise two tabs pass one player between them
// every couple of seconds.
const second = await openTab();
if ((await who(second)).player !== before.player) fail('a second tab was a different player');
// The displaced tab is in the background now, and a background tab gets no
// animation frames - which is where the menu redraws - so it is brought
// forward to be looked at.
await page.waitForFunction(() => window.solatel.link.parked === true, { timeout: 20000 });
await page.bringToFront();
await page.waitForFunction(
  () => document.querySelector('#menu-status').textContent.includes('another tab'),
  { timeout: 20000 },
);
await new Promise((r) => setTimeout(r, 5000));
const stillParked = await page.evaluate(() => window.solatel.link.parked);
if (!stillParked) fail('the displaced tab reconnected and took the player back');
console.log('>> a second tab takes over, and the first stays put');
await page.close();
page = second;
await page.bringToFront();

// 1. The menu is what a player lands on, and the world is not drawn behind it.
await page.waitForFunction(
  () => document.querySelectorAll('#menu-maps .map').length > 0,
  { timeout: 60000 },
);
const maps = await page.$$eval('#menu-maps .map', (els) =>
  els.map((e) => e.dataset.map),
);
const stakes = await page.$$eval('#menu-tables .table', (els) =>
  els.map((e) => Number(e.dataset.stake)),
);
console.log(`>> menu: maps ${maps.join(', ')}; tables ${stakes.map((s) => `$${s}`).join(', ')}`);
if (maps.length < 1) fail('the menu offered no maps');
if (stakes.length < 1) fail('the menu offered no tables');

const inMenu = await page.evaluate(() => document.body.classList.contains('in-menu'));
if (!inMenu) fail('the world was being drawn behind the menu');

// 2. The wallet says a figure rather than a dash. A player who has never been
//    charged still has a balance, and it is zero, not unknown.
await page.waitForFunction(
  () => !document.querySelector('#purse .amount').textContent.includes('—'),
  { timeout: 30000 },
);
const purse = await page.$eval('#purse .amount', (e) => e.textContent);
console.log(`>> wallet reads ${purse}`);

// 2b. The wallet says where to send money and what memo makes it this
//     player's - or says plainly that this server has no wallet.
await page.click('#menu-tabs [data-pane="wallet"]');
const wallet = await page.evaluate(() => ({
  terms: window.solatel.link.wallet,
  on: !document.getElementById('wallet-on').classList.contains('hidden'),
  address: document.getElementById('deposit-address').textContent,
  memo: document.getElementById('deposit-memo').textContent,
  player: window.solatel.link.playerId,
  formOff: document.getElementById('withdraw').disabled,
}));
if (wallet.terms) {
  if (!wallet.on) fail('the server has a wallet and the pane hid it');
  if (wallet.address !== wallet.terms.deposit_address) fail('the deposit address is not the server\'s');
  if (wallet.memo !== wallet.player) fail(`the memo ${wallet.memo} is not this player`);
  if (wallet.formOff === wallet.terms.withdrawals_open) {
    fail('the withdraw form disagrees with the server about whether withdrawals are open');
  }
  console.log(
    `>> deposits to ${wallet.address}, memo = player id; withdrawals ${wallet.terms.withdrawals_open ? 'open' : 'off'}`,
  );
} else {
  if (wallet.on) fail('a server with no wallet was shown one');
  console.log('>> this server has no wallet, and the pane says so');
}

// 3. The tabs work.
for (const pane of ['wallet', 'profile', 'settings', 'play']) {
  await page.click(`#menu-tabs [data-pane="${pane}"]`);
  const shown = await page.$eval(`.pane[data-pane="${pane}"]`, (e) =>
    !e.classList.contains('hidden'),
  );
  if (!shown) fail(`the ${pane} tab did not open its pane`);
}
console.log('>> every tab opens its pane');

// 4. Pick the cheapest table on the first map and get in line.
const stake = Math.min(...stakes);
await page.click(`#menu-maps [data-map="${maps[0]}"]`);
await page.click(`#menu-tables [data-stake="${stake}"]`);
await page.waitForFunction(
  () => document.querySelector('#menu-status').textContent.includes('in line'),
  { timeout: 20000 },
);
console.log(`>> in line for ${maps[0]} $${stake}`);

// The mouse must still be the player's: they are looking at a screen full of
// buttons, and one of them is "leave the line".
const locked = await page.evaluate(() => Boolean(document.pointerLockElement));
if (locked) fail('queueing took the mouse away from a screen full of buttons');

// 5. The match forms and the world is there to play.
await page.waitForFunction(() => Boolean(window.solatel?.local?.matchId), {
  timeout: 180000,
});
await page.waitForFunction(() => window.solatel?.world?.ready === true, {
  timeout: 120000,
});
await page.waitForFunction(() => document.body.classList.contains('running'), {
  timeout: 60000,
});
const entered = await page.evaluate(() => ({
  map: window.solatel.local.mapName,
  menuHidden: document.getElementById('menu').classList.contains('hidden'),
  brushes: window.solatel.SIM ? window.solatel.world.arena !== null : false,
}));
console.log(`>> dropped into ${entered.map}`);
if (!entered.menuHidden) fail('the menu stayed up over the match');
if (entered.map !== maps[0]) fail(`asked for ${maps[0]} and got ${entered.map}`);

// Give it a moment to draw, then check it is actually rendering the world.
await sleep(2000);
const drawn = await page.evaluate(() => window.solatel.stats().triangles);
console.log(`>> drawing ${drawn.toLocaleString()} triangles`);
if (drawn < 1000) fail('the world is not being drawn');

const shot = flag('--shot');
if (shot) await page.screenshot({ path: shot });

await browser.close();
console.log('OK   menu to match, on the map that was picked');
