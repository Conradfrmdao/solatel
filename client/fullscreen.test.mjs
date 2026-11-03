import assert from 'node:assert/strict';
import test from 'node:test';
import { initMobileLandscape } from './src/fullscreen.js';

test('mobile landscape is requested on visit and again after fullscreen gesture', async () => {
  const button = new EventTarget();
  const locks = [];
  const classes = new Set();
  globalThis.window = { matchMedia: (query) => ({ matches: query.includes('pointer: coarse') }) };
  globalThis.screen = { orientation: { lock: async (type) => { locks.push(type); } } };
  globalThis.document = {
    fullscreenElement: null,
    body: { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } },
    documentElement: { requestFullscreen: async () => { document.fullscreenElement = true; } },
    getElementById: () => button,
    addEventListener() {},
  };
  initMobileLandscape();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(locks, ['landscape']);
  assert.equal(classes.has('mobile-ready'), false);
  button.dispatchEvent(new Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(locks, ['landscape', 'landscape']);
  assert.equal(classes.has('mobile-ready'), true);
  delete globalThis.window;
  delete globalThis.screen;
  delete globalThis.document;
});
