// Measures frame rate in a real, GPU-accelerated Chrome.
//
//   node client/perf.mjs [--seconds 8] [--map facility] [--crowd 25]
//
// It queues for the cheapest table on the map and measures once the match is
// live, so the server wants `SOLATEL_MATCH_FLOOR=1` and a short
// `SOLATEL_QUEUE_WAIT`. Each row is one graphics level (quality.js), plus the
// cost of shadows altogether.
//
// `--crowd N` fills the match first: N players over the wire queue for the
// same table and, once it is live, run in wide circles, jump now and then and
// fire short bursts at the sky - so everything a full match costs to draw is
// drawn (bodies, animation, flashes, tracers) and nobody is hurt. Run the
// server in free play for it (`SOLATEL_FREE_PLAY=1`), which costs the crowd
// nothing, and keep N under the map's seats.
//
// Besides frames a second, each row has the milliseconds the main thread
// spends on a frame before drawing it (network, simulation, everybody's
// animation) and on drawing it (three.js handing the scene to the GPU): a
// frame rate held down by those is the CPU's, not the graphics card's.
//
// The smoke test runs headless, where WebGL falls back to a software rasteriser
// and a frame takes half a second. That is fine for asking "did it load", and
// worthless for asking "is it smooth". This launches the browser properly, with
// the GPU, and reports what a player would actually get - plus the draw call
// and triangle counts that explain it, and what happens with each expensive
// feature turned off, so the cost of each one is a number rather than a guess.

import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.SOLATEL_URL ?? 'http://localhost:8080/?debug=1&nolock=1';

const at = process.argv.indexOf('--seconds');
const seconds = at === -1 ? 8 : Number(process.argv[at + 1]);
const mapAt = process.argv.indexOf('--map');
const mapName = mapAt === -1 ? null : process.argv[mapAt + 1];
const crowdAt = process.argv.indexOf('--crowd');
const crowdSize = crowdAt === -1 ? 0 : Number(process.argv[crowdAt + 1]);

/** One of the crowd. Runs once its match is live; never aims at anybody. */
class Bot {
  constructor(name, url, protocolVersion) {
    this.seq = 0;
    this.phase = Math.random() * Math.PI * 2;
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('error', () => reject(new Error(`${name}: cannot connect`)), { once: true });
      this.ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.t === 'welcome') resolve();
        if (msg.t === 'match_started') {
          this.matchId = msg.match_id;
          // No map to load: ready for the countdown at once.
          this.send({ t: 'loaded', match_id: msg.match_id });
        }
        if (msg.t === 'snapshot' && msg.match_id === this.matchId && (msg.starts_in_ms ?? 0) === 0) this.live = true;
      });
      this.ws.addEventListener('open', () => {
        this.send({ t: 'hello', protocol_version: protocolVersion, client_build: 'perf.mjs', name, resume: null });
      }, { once: true });
    });
    this.timer = setInterval(() => this.tick(), 1000 / 64);
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  queue(map, dollars) {
    this.send({ t: 'queue', map, tier_dollars: dollars });
  }

  tick() {
    if (!this.live) return;
    this.seq += 1;
    const t = this.seq / 64;
    // A burst of three every couple of seconds, at the sky.
    const firing = (t + this.phase) % 2.3 < 0.3;
    const jumping = (t + this.phase) % 3.7 < 1 / 64;
    this.send({
      t: 'inputs',
      commands: [{
        seq: this.seq,
        forward: 1,
        right: Math.sin(t * 0.9 + this.phase) * 0.6,
        yaw: this.phase + t * 0.35,
        pitch: firing ? 1.25 : 0,
        buttons: (firing ? 2 : 0) | (jumping ? 1 : 0),
      }],
    });
  }

  close() {
    clearInterval(this.timer);
    this.ws.close();
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  // Headless draws with a software rasteriser, so its numbers mean nothing;
  // it is only for checking that the script itself still works.
  headless: process.env.PERF_HEADLESS === '1',
  defaultViewport: null,
  args: [
    // Containers run as root, where Chrome will not start sandboxed.
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    '--window-size=1600,900',
    // Off to the side, so a profiling run does not take over the screen.
    '--window-position=2400,80',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const page = (await browser.pages())[0] ?? (await browser.newPage());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.solatel && window.solatel.link.isReady, {
  timeout: 120000,
  polling: 250,
});

const renderer = await page.evaluate(() => {
  const gl = window.solatel.renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});
console.log(`GPU: ${renderer}`);

// Nothing is drawn in the menu, so get into a match first - behind the
// crowd, if there is one, so they are all in the same line.
await page.waitForSelector('#menu-maps .map', { timeout: 60000 });
await page.click(mapName ? `#menu-maps [data-map="${mapName}"]` : '#menu-maps .map');
const crowd = crowdSize > 0 ? await gather(crowdSize) : [];
// Clicked from inside the page: the list is redrawn whenever the line
// changes, which with a crowd joining is constantly, and a handle taken
// from outside can be gone by the time it is clicked.
await page.evaluate(() => document.querySelector('#menu-tables .table').click());
await page.waitForFunction(
  () => window.solatel.world.ready && window.solatel.local.inMatch && !window.solatel.local.warmingUp,
  { timeout: 240000, polling: 250 },
);
console.log(
  `map: ${await page.evaluate(() => window.solatel.local.mapName)}, ` +
    `auto picked: ${await page.evaluate(() => window.solatel.quality)}\n`,
);

/**
 * The crowd: `n` players over the wire, in line for the table the page is
 * about to click - the cheapest on its map - before it clicks.
 */
async function gather(n) {
  // Whatever the page is about to click: the chosen map's first table.
  const { map, dollars } = await page.evaluate(() => ({
    map: document.querySelector('#menu-maps .map.on')?.dataset.map,
    dollars: Number(document.querySelector('#menu-tables .table')?.dataset.stake),
  }));
  if (!map || !Number.isFinite(dollars)) throw new Error('could not tell which table the page will click');
  const ws = URL.replace(/^http/, 'ws').replace(/\/(\?.*)?$/, '') + '/ws';
  const health = await fetch(ws.replace(/^ws/, 'http').replace(/\/ws$/, '/health')).then((r) => r.json());
  const bots = [];
  for (let i = 0; i < n; i += 1) bots.push(new Bot(`Crowd ${i + 1}`, ws, health.protocol_version));
  await Promise.all(bots.map((b) => b.ready));
  for (const bot of bots) bot.queue(map, dollars);
  console.log(`crowd: ${n} in line for $${dollars} on ${map}`);
  return bots;
}

/** Runs for a while and reports the frame rate the client itself measured. */
async function sample(label, setup, arg) {
  if (setup) await page.evaluate(setup, arg);
  // A moment to settle before counting: changing a render setting recompiles
  // shaders, and those frames are not representative of anything.
  await new Promise((r) => setTimeout(r, 1200));

  const samples = await page.evaluate(async (ms) => {
    const taken = [];
    const started = performance.now();
    while (performance.now() - started < ms) {
      await new Promise((r) => setTimeout(r, 250));
      // Turn on the spot rather than walk. Every row has to see the same
      // things from the same place or the comparison between them is
      // meaningless - and walking forward for half a minute across four
      // samples ends with the camera in a corner facing a wall, which reads
      // as "shadows are free" when it only means nothing was in view.
      window.solatel.input.yaw += 0.13;
      taken.push(window.solatel.stats());
    }
    return taken;
  }, seconds * 1000);

  const fps = samples.map((s) => s.fps).filter((f) => f > 0);
  fps.sort((a, b) => a - b);
  const median = fps.length ? fps[Math.floor(fps.length / 2)] : 0;
  const middle = (key) => {
    const values = samples.map((s) => s[key]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : NaN;
  };
  const worst = fps.length ? fps[0] : 0;
  // The heaviest view the spin passed through, not whichever one it stopped
  // on. What costs frames is the worst direction, not the average one.
  const peak = (key) => Math.max(0, ...samples.map((s) => s[key] ?? 0));
  const last = { drawCalls: peak('drawCalls'), triangles: peak('triangles') };

  console.log(
    `${label.padEnd(30)} ${median.toFixed(0).padStart(4)} fps median, ` +
      `${worst.toFixed(0).padStart(4)} worst   ` +
      `${String(last.drawCalls ?? '?').padStart(5)} draws  ` +
      `${String(last.triangles ?? '?').padStart(7)} tris   ` +
      `cpu ${middle('updateMs').toFixed(1).padStart(5)} + ${middle('drawMs').toFixed(1).padStart(5)} ms   ` +
      `${String(Math.max(0, ...samples.map((s) => s.players ?? 0))).padStart(2)} others drawn`,
  );
  return median;
}

// Each row turns the camera through a full circle from the spawn, so all four
// see the same geometry and the difference between them is the setting rather
// than the view. Draw calls and triangles are the worst the spin found.
await sample('as the player gets it');
for (const level of ['low', 'medium', 'high', 'ultra']) {
  await sample(`quality: ${level}`, (level) => window.solatel.setQuality(level), level);
}
// Last, because it cannot be undone: what shadows cost altogether, which no
// level turns off (see quality.js for why).
await sample('high, without shadows', () => {
  window.solatel.setQuality('high');
  window.solatel.renderer.shadowMap.enabled = false;
  window.solatel.scene.traverse((n) => {
    if (n.isMesh) n.castShadow = n.receiveShadow = false;
  });
});

for (const bot of crowd) bot.close();
if (errors.length) {
  console.log('\nerrors:');
  for (const e of errors.slice(0, 8)) console.log(`  ${e}`);
}

await browser.close();
