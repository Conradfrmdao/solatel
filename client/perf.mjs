// Measures frame rate in a real, GPU-accelerated Chrome.
//
//   node client/perf.mjs [--seconds 8]
//
// The smoke test runs headless, where WebGL falls back to a software rasteriser
// and a frame takes half a second. That is fine for asking "did it load", and
// worthless for asking "is it smooth". This launches the browser properly, with
// the GPU, and reports what a player would actually get - plus the draw call
// and triangle counts that explain it, and what happens with each expensive
// feature turned off, so the cost of each one is a number rather than a guess.

import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.SOLATEL_URL ?? 'http://localhost:8080/?debug=1&nolock=1';

const at = process.argv.indexOf('--seconds');
const seconds = at === -1 ? 8 : Number(process.argv[at + 1]);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  defaultViewport: null,
  args: [
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
console.log(`GPU: ${renderer}\n`);

/** Runs for a while and reports the frame rate the client itself measured. */
async function sample(label, setup) {
  if (setup) await page.evaluate(setup);
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
  const worst = fps.length ? fps[0] : 0;
  // The heaviest view the spin passed through, not whichever one it stopped
  // on. What costs frames is the worst direction, not the average one.
  const peak = (key) => Math.max(0, ...samples.map((s) => s[key] ?? 0));
  const last = { drawCalls: peak('drawCalls'), triangles: peak('triangles') };

  console.log(
    `${label.padEnd(30)} ${median.toFixed(0).padStart(4)} fps median, ` +
      `${worst.toFixed(0).padStart(4)} worst   ` +
      `${String(last.drawCalls ?? '?').padStart(5)} draws  ` +
      `${String(last.triangles ?? '?').padStart(7)} tris`,
  );
  return median;
}

// Each row turns the camera through a full circle from the spawn, so all four
// see the same geometry and the difference between them is the setting rather
// than the view. Draw calls and triangles are the worst the spin found.
await sample('as shipped');
await sample('without ambient occlusion', () => window.solatel.setComposer(false));
await sample('without shadows', () => {
  window.solatel.renderer.shadowMap.enabled = false;
  window.solatel.scene.traverse((n) => {
    if (n.isMesh) n.castShadow = n.receiveShadow = false;
  });
});
await sample('at half resolution', () => window.solatel.renderer.setPixelRatio(0.5));

if (errors.length) {
  console.log('\nerrors:');
  for (const e of errors.slice(0, 8)) console.log(`  ${e}`);
}

await browser.close();
