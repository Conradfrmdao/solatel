// The client's files as a browser gets them from a real server.
//
//   node client/cache.mjs [--url http://localhost:8080]
//
// Every file a page loads is named after its contents and kept for good, and
// the page itself is never kept (`served.rs`, `build.mjs`). So: the page says
// `no-store`; every file it names says `immutable` and arrives compressed
// where compressing pays; a second visit takes every one of them from the
// browser's cache and asks the server for the page alone; and a page from
// another build is refused at the handshake - it would ask for files that
// are gone - while a page from this one is let in.
//
// Needs a running server and a built client. Touches no money: nothing here
// queues for a match.

import zlib from 'node:zlib';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const at = args.indexOf('--url');
const base = at >= 0 ? args[at + 1] : 'http://localhost:8080';

const failures = [];
function check(ok, what) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
}

// 1. The page, and the table of names it carries.
const page = await fetch(`${base}/`, { headers: { 'accept-encoding': 'br, gzip' } });
const html = await page.text();
check(page.headers.get('cache-control') === 'no-store', 'the page is never stored');
const names = JSON.parse(/<script id="solatel-manifest" type="application\/json">(.*?)<\/script>/s.exec(html)[1]);
const build = /<meta name="solatel-build" content="([^"]+)"/.exec(html)[1];
const script = /<script type="module" src="([^"]+)"/.exec(html)[1];

// 2. Every file it names: kept for good, and compressed where that pays -
// which for a file sent plain is judged here the way the build judges it
// (`WORTH` in build.mjs): a model that is mostly compressed textures, like
// the guns, does not shrink enough to be worth a copy.
const COMPRESSED = /\.(js|wasm|glb|hdr)$/;
const WORTH = 0.9;
const pays = (bytes) =>
  zlib.brotliCompressSync(bytes, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  }).length <= bytes.length * WORTH;
const published = [script, ...Object.values(names)];
let wrong = 0;
let wire = 0;
for (const name of published) {
  const response = await fetch(`${base}/${name}`, { headers: { 'accept-encoding': 'br, gzip' } });
  const body = new Uint8Array(await response.arrayBuffer());
  wire += Number(response.headers.get('content-length') ?? 0);
  const cache = response.headers.get('cache-control') ?? '';
  const encoding = response.headers.get('content-encoding');
  if (response.status !== 200 || !cache.includes('immutable')) {
    console.log(`     ${name}: ${response.status}, cache-control ${cache}`);
    wrong += 1;
  } else if (COMPRESSED.test(name) && encoding !== 'br' && (encoding || pays(body))) {
    console.log(`     ${name}: sent ${encoding ?? 'uncompressed'}`);
    wrong += 1;
  }
}
check(wrong === 0, `${published.length} published files kept for good, compressed where it pays (${(wire / 1048576).toFixed(1)} MB over the wire for all of them)`);
const gone = await fetch(`${base}/assets/maps/arena.glb`);
check(gone.status === 404 && gone.headers.get('cache-control') === 'no-store', 'a plain name is not served, and the miss is not stored');

// 3. A browser's second visit asks the server for the page and nothing else.
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const tab = await browser.newPage();
const origin = new URL(base).origin;
async function visit() {
  const seen = [];
  const listen = (response) => {
    const url = new URL(response.url());
    // Not `blob:` - those are the textures a model unpacks in memory.
    if (!url.protocol.startsWith('http') || url.origin !== origin || url.pathname === '/ws') return;
    seen.push({ path: url.pathname, cached: response.fromCache() });
  };
  tab.on('response', listen);
  await tab.goto(`${base}/?debug=1&nolock=1`);
  // Set once boot has loaded the simulation, the rifle and the soldier.
  await tab.waitForFunction(() => window.solatel !== undefined, { timeout: 90000 });
  // Then the menu takes over from the boot screen and asks for its art. Left
  // in flight, those requests were cut off by the next visit, never cached,
  // and counted against it as files fetched twice.
  await tab.waitForNetworkIdle({ idleTime: 500, timeout: 30000 });
  tab.off('response', listen);
  return seen;
}
const first = await visit();
const second = await visit();
// Named by its contents - which the page and the API routes (`/board`) are
// not, and are never stored either.
const hashed = (path) => /\.[0-9a-f]{16}\.[a-z0-9]+$/.test(path);
check(first.some((r) => hashed(r.path)), `the first visit fetched ${first.filter((r) => hashed(r.path)).length} files`);
const refetched = second.filter((r) => hashed(r.path) && !r.cached);
for (const r of refetched) console.log(`     fetched again: ${r.path}`);
check(
  refetched.length === 0 && second.some((r) => hashed(r.path) && r.cached),
  `the second visit took ${second.filter((r) => r.cached).length} files from the cache and fetched none again`,
);
check(second.some((r) => r.path === '/' && !r.cached), 'the second visit fetched the page itself from the server');
await browser.close();

// 4. The handshake: this build is let in, another is refused.
const { protocol_version } = await (await fetch(`${base}/health`)).json();
function hello(clientBuild) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
    socket.onopen = () => socket.send(JSON.stringify({ t: 'hello', protocol_version, client_build: clientBuild, name: 'cache.mjs' }));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.t === 'welcome' || message.t === 'rejected') {
        socket.close();
        resolve(message);
      }
    };
    socket.onerror = () => resolve({ t: 'error' });
  });
}
const current = await hello(build);
check(current.t === 'welcome', `a page from this build (${build}) is let in`);
const old = await hello('solatel/0000000000000000');
check(
  old.t === 'rejected' && old.reason?.startsWith(`client build mismatch: server serves ${build}`),
  `a page from another build is refused: ${old.reason ?? old.t}`,
);
const driver = await hello('cache.mjs');
check(driver.t === 'welcome', 'a driver that names itself is not asked to match');

if (failures.length > 0) {
  console.log(`FAIL ${failures.length} check(s)`);
  process.exit(1);
}
console.log('OK   the client is cached the way it is meant to be');
