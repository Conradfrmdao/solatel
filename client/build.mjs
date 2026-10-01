// Bundles the client into web/dist, every file the page loads named after
// its own contents.
//
// What lands in web/dist:
//   index.html                       the page: never cached, and the table of
//                                    every other file's published name
//   build.json                       which build this is, so the server can
//                                    refuse a page from another one
//   solatel.<hash>.js (and .map)     the bundled client
//   sim/solatel_sim_bg.<hash>.wasm   the shared movement simulation
//   assets/**/<name>.<hash>.<ext>    models, photographs and skies
//   favicon.<hash>.png
//   <any of those>.br and .gz        compressed ahead of time, where it pays
//
// A name carrying a hash of its contents can never be served with other
// bytes, so the server tells browsers to keep it for good (`served.rs`): a
// map is downloaded once, not at the start of every match. The page is the
// one file that cannot be named that way, so it is never stored, and a new
// build is picked up on the next load at the cost of only what changed.
//
// esbuild rather than a framework's toolchain: one dependency, a cold build in
// well under a second, and nothing between the source and the output that has
// to be understood when something goes wrong.
//
// The wasm is *not* bundled. It is fetched at runtime by URL, which keeps it a
// cacheable file of its own rather than several hundred kilobytes of base64
// wedged into the JavaScript.

import { build, context } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(root, 'web', 'dist');
const watch = process.argv.includes('--watch');

/** Hex digits of a file's hash in its name. `HASH_DIGITS` in `served.rs`. */
const HASH_DIGITS = 16;
/** What a page calls its build. `BUILD_PREFIX` in `served.rs`. */
const BUILD_PREFIX = 'solatel/';

/** Worth compressing: text, and binary not compressed already. Photographs
 *  (WebP) are, and a second pass gains nothing. */
const COMPRESSIBLE = new Set(['.js', '.map', '.wasm', '.glb', '.hdr', '.json', '.html', '.bin', '.css', '.svg']);
/** A compressed copy is kept only when it is at most this much of the file. */
const WORTH = 0.9;

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/**
 * The best brotli there is, and a window as wide as the format allows. The
 * yard is a thousand meshes of which many are copies, and a 16 MB window
 * sees across the whole file: 11.7 MB goes over the wire as 0.24. It takes
 * seconds a file, once - a file's compressed copies are kept with its
 * content-named original and reused by every later build.
 */
const squeeze = {
  '.br': (bytes) =>
    brotli(bytes, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
        [zlib.constants.BROTLI_PARAM_LGWIN]: zlib.constants.BROTLI_MAX_WINDOW_BITS,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }),
  '.gz': (bytes) => gzip(bytes, { level: 9 }),
};

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

/** Every file this build wrote or kept, relative to `out`, with `/`. */
const produced = new Set();

const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, HASH_DIGITS);

/** `assets/maps/yard.glb` is published as `assets/maps/yard.<hash>.glb`. */
function contentName(plain, bytes) {
  const ext = extname(plain);
  return `${plain.slice(0, plain.length - ext.length)}.${hashOf(bytes)}${ext}`;
}

const onDisk = (published) => join(out, ...published.split('/'));

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Written beside the target and renamed into place, so a build stopped
 *  halfway never leaves a truncated file under a name a later build trusts. */
async function writeWhole(file, bytes) {
  await mkdir(dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, file);
}

/**
 * Writes `bytes` as `published`, with its compressed copies.
 *
 * A content-named file already on disk is these bytes by construction, and
 * so are its compressed copies, so both are kept rather than redone: a map's
 * best brotli is seconds of work and a rebuild should not repeat it.
 */
async function emit(published, bytes, { contentNamed }) {
  const file = onDisk(published);
  const reuse = contentNamed && (await exists(file));
  if (!reuse) await writeWhole(file, bytes);
  produced.add(published);
  if (!COMPRESSIBLE.has(extname(published))) return;
  await Promise.all(
    Object.entries(squeeze).map(async ([suffix, compress]) => {
      if (reuse && (await exists(file + suffix))) {
        produced.add(published + suffix);
        return;
      }
      const packed = await compress(bytes);
      if (packed.length > bytes.length * WORTH) return;
      await writeWhole(file + suffix, packed);
      produced.add(published + suffix);
    }),
  );
}

/** Publishes a file under its content name and returns that name. */
async function publish(plain, bytes) {
  const published = contentName(plain, bytes);
  await emit(published, bytes, { contentNamed: true });
  return published;
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/**
 * Publishes everything the page loads by URL - the simulation, every asset,
 * the icon - and returns the table from each plain name to its published one.
 * The plain names are what the code asks for (`asset()` in `assets.js`).
 */
async function publishFiles() {
  const names = {};
  const jobs = [];
  const add = (plain, bytes) =>
    jobs.push(
      publish(plain, bytes).then((published) => {
        names[plain] = published;
      }),
    );

  const wasm = resolve(here, 'generated', 'solatel_sim_bg.wasm');
  if (!(await exists(wasm))) {
    throw new Error(
      'client/generated/solatel_sim_bg.wasm is missing.\n' +
        'Build the shared simulation first:  ./x sim',
    );
  }
  add('sim/solatel_sim_bg.wasm', await readFile(wasm));
  add('favicon.png', await readFile(resolve(here, 'favicon.png')));

  // Every model, photograph and sky. Creating an empty table would be worse
  // than failing: the build would succeed and the client would die at load
  // time on a name it was told exists.
  const assets = resolve(root, 'assets');
  if (!(await exists(assets))) throw new Error('no assets/ directory at the workspace root');
  for await (const file of walk(assets)) {
    // URLs, so `/` whatever this machine's separator is.
    add(`assets/${relative(assets, file).split(sep).join('/')}`, await readFile(file));
  }

  await Promise.all(jobs);
  return Object.fromEntries(Object.entries(names).sort(([a], [b]) => a.localeCompare(b)));
}

/** Replaces the one occurrence of `from`, and says so if there is not one. */
function once(text, from, to) {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) {
    throw new Error(`client/index.html should contain ${JSON.stringify(from)} exactly once`);
  }
  return text.slice(0, at) + to + text.slice(at + from.length);
}

/**
 * The page and `build.json`. The build is named from the script and the
 * table, which between them are every file the page can ask for: two builds
 * with the same name can serve each other's pages.
 */
async function writePage(script, names) {
  const buildId = BUILD_PREFIX + hashOf(`${script}\n${JSON.stringify(names)}`);
  let html = await readFile(resolve(here, 'index.html'), 'utf8');
  html = once(html, '<script type="module" src="solatel.js"></script>', `<script type="module" src="${script}"></script>`);
  html = once(html, '<link rel="icon" href="favicon.png" />', `<link rel="icon" href="${names['favicon.png']}" />`);
  // Escaped so no name can close the script element early.
  const table = JSON.stringify(names).replace(/</g, '\\u003c');
  html = once(
    html,
    '</head>',
    `  <meta name="solatel-build" content="${buildId}" />\n` +
      `    <script id="solatel-manifest" type="application/json">${table}</script>\n  </head>`,
  );
  // The page first: the server never claims a build whose page is not there.
  await emit('index.html', Buffer.from(html), { contentNamed: false });
  await emit('build.json', Buffer.from(`${JSON.stringify({ build: buildId })}\n`), { contentNamed: false });
  return buildId;
}

/**
 * The bundle, named by its contents. Its last line points at its source map,
 * and that is renamed to match.
 */
async function writeBundle() {
  // Quiet: esbuild would list the outputs under names they are not published as.
  const result = await build({ ...options, write: false, logLevel: 'warning' });
  const js = result.outputFiles.find((file) => file.path.endsWith('.js'));
  const map = result.outputFiles.find((file) => file.path.endsWith('.js.map'));
  const script = `solatel.${hashOf(js.contents)}.js`;
  const tail = /\/\/# sourceMappingURL=solatel\.js\.map\s*$/;
  if (!tail.test(js.text)) throw new Error('the bundle does not end by naming its source map');
  const code = js.text.replace(tail, `//# sourceMappingURL=${script}.map\n`);
  await emit(script, Buffer.from(code), { contentNamed: true });
  await emit(`${script}.map`, Buffer.from(map.contents), { contentNamed: true });
  return { script, bytes: code.length };
}

/**
 * Clears out everything this build did not produce.
 *
 * web/dist is not versioned and is only ever regenerated, so a file in it that
 * this build did not produce is stale by definition: an old build's hashed
 * files, and above all a compressed copy whose original has changed, which
 * the server would otherwise go on sending in its place. It matters more than
 * it sounds: the Bevy client this replaced left an 81 MB wasm bundle sitting
 * there, still being served, long after nothing referenced it.
 */
async function removeStale(dir = out) {
  let left = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if ((await removeStale(path)) === 0) await rm(path, { recursive: true, force: true });
      else left += 1;
      continue;
    }
    if (produced.has(relative(out, path).split(sep).join('/'))) {
      left += 1;
      continue;
    }
    await rm(path, { force: true });
  }
  return left;
}

/** What a player downloads, before and after compression. */
async function report(names, bundle) {
  const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;
  const sized = async (published) => {
    const raw = (await stat(onDisk(published))).size;
    const br = (await exists(`${onDisk(published)}.br`)) ? (await stat(`${onDisk(published)}.br`)).size : raw;
    return `${mb(raw)} (${mb(br)} over the wire)`;
  };
  if (bundle) console.log(`   bundle      ${await sized(bundle.script)}`);
  console.log(`   simulation  ${await sized(names['sim/solatel_sim_bg.wasm'])}`);
  for (const [plain, published] of Object.entries(names)) {
    if (plain.startsWith('assets/maps/')) console.log(`   ${plain.slice(12).padEnd(11)} ${await sized(published)}`);
  }
}

await mkdir(out, { recursive: true });

// Nothing is deleted first. esbuild overwrites its own outputs, and clearing
// them up front means a build that fails to *parse* leaves web/dist with no
// client in it at all - so the next thing anyone sees is a 404 rather than the
// syntax error that actually happened.

if (watch) {
  // The bundle keeps its plain name here, rewritten on every save, and the
  // server never lets a browser keep a plain name. Everything else is
  // published as in a full build.
  const names = await publishFiles();
  produced.add('solatel.js');
  produced.add('solatel.js.map');
  const ctx = await context(options);
  await ctx.watch();
  const buildId = await writePage('solatel.js', names);
  await removeStale();
  console.log(`watching client/src for changes (${buildId})`);
} else {
  const [names, bundle] = await Promise.all([publishFiles(), writeBundle()]);
  const buildId = await writePage(bundle.script, names);
  await removeStale();
  console.log(`   build ${buildId}`);
  await report(names, bundle);
}
