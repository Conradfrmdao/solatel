import assert from 'node:assert/strict';
import test from 'node:test';
import { enterFullscreen, initMobileLandscape } from './src/fullscreen.js';

test('mobile landscape is requested on visit and again after fullscreen gesture', async () => {
  const button = new EventTarget();
  const locks = [];
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  globalThis.screen = { orientation: { lock: async (type) => { locks.push(type); } } };
  globalThis.document = {
    fullscreenElement: null,
    documentElement: { requestFullscreen: async () => { document.fullscreenElement = true; } },
    getElementById: () => button,
  };
  initMobileLandscape();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(locks, ['landscape']);
  await enterFullscreen();
  assert.deepEqual(locks, ['landscape', 'landscape']);
  delete globalThis.window;
  delete globalThis.screen;
  delete globalThis.document;
});
