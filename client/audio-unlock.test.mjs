import assert from 'node:assert/strict';
import test from 'node:test';
import { Audio } from './src/audio.js';

function device() {
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  const created = [];
  const node = () => ({ connect(to) { return to; }, disconnect() {} });
  let allowResume = false;
  let stuck = null;
  class Context {
    constructor() {
      this.state = 'suspended'; this.sampleRate = 8; this.destination = node();
      this.resumes = 0; this.primes = 0; created.push(this);
    }
    createGain() { return { ...node(), gain: { value: 0 } }; }
    createDynamicsCompressor() {
      return { ...node(), threshold: {}, knee: {}, ratio: {}, attack: {}, release: {} };
    }
    createBiquadFilter() { return { ...node(), frequency: {}, Q: {} }; }
    createBuffer(channels, frames) { return { getChannelData: () => new Float32Array(frames) }; }
    createBufferSource() {
      const context = this;
      return { ...node(), start() { context.primes += 1; } };
    }
    resume() {
      this.resumes += 1;
      if (!allowResume) return Promise.reject(new Error('NotAllowedError'));
      if (stuck === this) return new Promise(() => {});
      this.state = 'running';
      return Promise.resolve();
    }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  const window = new EventTarget();
  window.AudioContext = Context;
  window.localStorage = { getItem: () => null, setItem() {} };
  const document = new EventTarget(); document.hidden = false;
  const session = { type: 'auto' };
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: document },
    navigator: { configurable: true, value: { audioSession: session } },
  });
  return {
    window, document, session, created,
    allow: () => { allowResume = true; },
    blockResume: (context) => { stuck = context; },
    restore() {
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test('a policy-blocked touch start is retried on touchend and preserves game mute', async () => {
  const browser = device();
  try {
    const audio = new Audio();
    audio.bindUnlockEvents();
    browser.window.dispatchEvent(new Event('focus'));
    assert.equal(browser.created.length, 0, 'focus before a gesture must not open an audio device');
    browser.document.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();
    assert.equal(audio.ready, false);
    assert.equal(audio.failed, false, 'a temporary activation refusal must be retryable');
    browser.allow();
    browser.document.dispatchEvent(new Event('touchend'));
    await Promise.resolve();
    assert.equal(audio.ready, true);
    assert.equal(browser.session.type, 'playback');
    const context = audio.context;
    const primed = context.primes;
    browser.document.dispatchEvent(new Event('click'));
    assert.equal(context.primes, primed, 'a running device is not primed on every control tap');
    assert.equal(browser.created.length, 1);
    audio.setVolume(0);
    browser.document.dispatchEvent(new Event('pointerup'));
    assert.equal(audio.volume, 0);
    assert.equal(audio.master.gain.value, 0);
    assert.equal(browser.session.type, 'auto');
  } finally { browser.restore(); }
});

test('iOS interruption resumes on return and a closed device can be recreated', async () => {
  const browser = device();
  try {
    browser.allow();
    const audio = new Audio();
    const unbind = audio.bindUnlockEvents();
    assert.equal(audio.bindUnlockEvents(), unbind, 'binding twice must not stack handlers');
    browser.document.dispatchEvent(new Event('click'));
    await Promise.resolve();
    const first = audio.context;
    first.state = 'interrupted';
    browser.document.hidden = true;
    browser.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(first.state, 'interrupted', 'hidden audio is not restarted');
    assert.equal(browser.session.type, 'auto');
    browser.document.hidden = false;
    browser.document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    assert.equal(audio.ready, true);
    assert.equal(browser.session.type, 'playback');
    audio.setVolume(.2);
    audio.buffers.set('recording', { buffer: {} });
    first.state = 'closed';
    browser.document.dispatchEvent(new Event('pointerup'));
    await Promise.resolve();
    assert.notEqual(audio.context, first);
    assert.equal(audio.ready, true);
    assert.equal(audio.volume, .2);
    assert.equal(audio.buffers.has('recording'), true, 'decoded sound assets survive a device restart');
    unbind();
    audio.context.state = 'interrupted';
    browser.document.dispatchEvent(new Event('click'));
    assert.equal(audio.ready, false, 'disposal removes activation listeners');
  } finally { browser.restore(); }
});

test('foreground restoration refreshes the route when the context still reports running', () => {
  const browser = device();
  try {
    browser.allow();
    browser.session.type = 'ambient';
    const audio = new Audio();
    audio.bindUnlockEvents();
    browser.document.dispatchEvent(new Event('click'));
    assert.equal(browser.session.type, 'playback');
    browser.window.dispatchEvent(new Event('pagehide'));
    assert.equal(browser.session.type, 'ambient');
    assert.equal(audio.ready, true);
    browser.window.dispatchEvent(new Event('pageshow'));
    assert.equal(browser.session.type, 'playback');
    assert.equal(browser.created.length, 1);
  } finally { browser.restore(); }
});

test('a stuck interrupted context is replaced on a later tap', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const browser = device();
  try {
    browser.allow();
    const audio = new Audio();
    audio.bindUnlockEvents();
    browser.document.dispatchEvent(new Event('click'));
    const first = audio.context;
    audio.buffers.set('recording', { buffer: {} });
    first.state = 'interrupted';
    browser.blockResume(first);
    browser.window.dispatchEvent(new Event('focus'));
    now = 100;
    browser.document.dispatchEvent(new Event('pointerup'));
    assert.equal(audio.context, first, 'allow recovery in the same gesture');
    now = 1000;
    browser.window.dispatchEvent(new Event('focus'));
    assert.equal(audio.context, first, 'lifecycle events cannot replace the audio context');
    browser.document.dispatchEvent(new Event('click'));
    await Promise.resolve();
    assert.equal(first.state, 'closed');
    assert.notEqual(audio.context, first);
    assert.equal(audio.ready, true);
    assert.equal(audio.buffers.has('recording'), true);
  } finally { browser.restore(); }
});
