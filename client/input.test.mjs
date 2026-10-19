// Keyboard regressions without WebGL: exercise the real event listeners and
// sampled commands, including focus changes while a sprint is latched.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Input } from './src/input.js';

test('sprint respects hold, toggle, combat and focus transitions', () => {
  const saved = new Map();
  globalThis.window = new EventTarget();
  window.localStorage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
  globalThis.document = new EventTarget();
  const canvas = new EventTarget();
  const input = new Input(canvas, { requireLock: false });
  const key = (type, code, repeat = false) => {
    const event = new Event(type);
    Object.assign(event, { code, repeat });
    window.dispatchEvent(event);
  };
  const down = (code, repeat) => key('keydown', code, repeat);
  const up = (code) => key('keyup', code);
  down('KeyW');
  assert.equal(input.sample().sprint, false);
  down('ShiftLeft');
  assert.equal(input.sample().sprint, true);
  down('KeyD');
  assert.equal(input.sample().sprint, true);
  up('ShiftLeft');
  assert.equal(input.sample().sprint, false);
  input.setSprintToggle(true);
  down('ShiftLeft');
  up('ShiftLeft');
  assert.equal(input.sample().sprint, true);
  down('ShiftLeft', true);
  assert.equal(input.sample().sprint, true, 'key repeat must not toggle');
  window.dispatchEvent(new Event('blur'));
  down('KeyW');
  assert.equal(input.sample().sprint, false, 'blur releases the latch');
  down('ShiftLeft');
  assert.equal(input.sample().sprint, true);
  const aim = new Event('mousedown');
  Object.assign(aim, { button: 2 });
  window.dispatchEvent(aim);
  assert.equal(input.sample().sprint, false);
  const unaim = new Event('mouseup');
  Object.assign(unaim, { button: 2 });
  window.dispatchEvent(unaim);
  assert.equal(input.sample().sprint, false, 'aim ends a toggle sprint');
  down('ShiftLeft');
  down('KeyG');
  up('KeyG');
  const grenade = input.sample();
  assert.equal(grenade.throw, true, 'a short grenade tap is preserved');
  assert.equal(grenade.sprint, false);
  input.setSprintToggle(false);
  down('ShiftRight');
  down('KeyC');
  assert.equal(input.sample().sprint, false);
  input.resetCrouch();
  assert.equal(input.sample().sprint, true);
  down('KeyS');
  assert.equal(input.sample().sprint, false, 'opposing movement cannot sprint');
  up('KeyG');
  input.sample();
  down('KeyG');
  for (let tick = 0; tick < 200; tick++) {
    const held = input.sample();
    assert.equal(held.grenadeHeld, true);
    assert.equal(held.throw, false, 'holding must never throw on a timer');
  }
  up('KeyG');
  assert.equal(input.sample().throw, true, 'release throws on the very next tick');
  assert.equal(input.sample().throw, false, 'release is consumed once');
  down('KeyG');
  window.dispatchEvent(new Event('blur'));
  up('KeyG');
  assert.equal(input.sample().throw, false, 'tabbing away cancels, never throws');
  assert.equal(input.debug().fire, false);
  delete globalThis.window;
  delete globalThis.document;
});
