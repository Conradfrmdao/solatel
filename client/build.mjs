// Bundles the client into web/dist.
//
// esbuild rather than a framework's toolchain: one dependency, a cold build in
// well under a second, and nothing between the source and the output that has
// to be understood when something goes wrong.
//
// What lands in web/dist:
//   solatel.js                the bundled client
//   index.html                the page shell
//   sim/solatel_sim_bg.wasm   the shared movement simulation
//   assets/                   models, copied by scripts/build-client.sh
//
// The wasm is *not* bundled. It is fetched at runtime by URL, which keeps it a
// cacheable file of its own rather than several hundred kilobytes of base64
// wedged into the JavaScript.

import { build, context } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(root, 'web', 'dist');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [resolve(here, 'src', 'main.js')],
  outfile: resolve(out, 'solatel.js'),
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

/**
 * Clears out anything a previous, different client left behind.
 *
 * web/dist is not versioned and is only ever regenerated, so a file in it that
 * this build did not produce is stale by definition. It matters more than it
 * sounds: the Bevy client this replaced left an 81 MB wasm bundle sitting there,
 * still being served, long after nothing referenced it.
 */
async function removeStale() {
  const keep = new Set([
    'solatel.js', 'solatel.js.map', 'index.html', 'favicon.png', 'sim', 'assets',
  ]);
  for (const entry of await readdir(out).catch(() => [])) {
    if (keep.has(entry)) continue;
    await rm(resolve(out, entry), { recursive: true, force: true });
    console.log(`   removed stale ${entry}`);
  }
}

async function copyStatic() {
  await mkdir(resolve(out, 'sim'), { recursive: true });
  await cp(resolve(here, 'index.html'), resolve(out, 'index.html'));
  await cp(resolve(here, 'favicon.png'), resolve(out, 'favicon.png'));

  const wasm = resolve(here, 'generated', 'solatel_sim_bg.wasm');
  try {
    await stat(wasm);
  } catch {
    throw new Error(
      'client/generated/solatel_sim_bg.wasm is missing.\n' +
        'Build the shared simulation first:  ./x sim',
    );
  }
  await cp(wasm, resolve(out, 'sim', 'solatel_sim_bg.wasm'));
}

async function report() {
  const js = await readFile(resolve(out, 'solatel.js'));
  const wasm = await readFile(resolve(out, 'sim', 'solatel_sim_bg.wasm'));
  const mb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
  console.log(`   bundle ${mb(js.length)}   simulation ${mb(wasm.length)}`);
}

await mkdir(out, { recursive: true });

// Nothing is deleted first. esbuild overwrites its own outputs, and clearing
// them up front means a build that fails to *parse* leaves web/dist with no
// client in it at all - so the next thing anyone sees is a 404 rather than the
// syntax error that actually happened.

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  await copyStatic();
  console.log('watching client/src for changes');
} else {
  await build(options);
  await copyStatic();
  await removeStale();
  await report();
}
