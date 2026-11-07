import assert from 'node:assert/strict';
import test from 'node:test';
import { Input } from './src/input.js';

function setup() {
  const stored = new Map();
  globalThis.window = new EventTarget();
  window.localStorage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  globalThis.document = new EventTarget();
  return { stored, input: new Input(new EventTarget(), { requireLock: false }) };
}

function cleanup() { delete globalThis.window; delete globalThis.document; }

test('phone aim, crouch and sprint support hold, toggle and interruption safely', () => {
  const { input } = setup();
  try {
    for (const action of ['aim', 'crouch', 'sprint']) {
      input.setTouchOptions({ [action]: 'hold' });
      input._pressTouchButton(action);
      assert.equal(input._touch[action], true, `${action} must activate while held`);
      input._releaseTouchButton(action);
      assert.equal(input._touch[action], false, `${action} must release with the finger`);

      input.setTouchOptions({ [action]: 'toggle' });
      input._pressTouchButton(action); input._releaseTouchButton(action);
      assert.equal(input._touch[action], true, `${action} must remain active after a toggle tap`);
      input._pressTouchButton(action); input._releaseTouchButton(action);
      assert.equal(input._touch[action], false, `${action} must switch off on a second tap`);

      input._pressTouchButton(action); input._releaseTouchButton(action, true);
      assert.equal(input._touch[action], false, `${action} cannot remain stuck after pointer cancellation`);
    }
    input.setTouchOptions({ aim: 'toggle' }); input._pressTouchButton('aim');
    input.setTouchOptions({ aim: 'hold' });
    assert.equal(input.aiming, false, 'changing behavior must clear a previously locked aim');
  } finally { cleanup(); }
});

test('touch sensitivity is slightly faster by default and stays independent from the mouse', () => {
  const { input, stored } = setup();
  try {
    assert.equal(input.touchOptions.sensitivity, 115);
    const turnTouch = () => { input.yaw = 0; input._touchDx = 40; input.updateLook(); return input.yaw; };
    const initial = turnTouch();
    input.setSensitivity(.008);
    assert.equal(turnTouch(), initial, 'desktop sensitivity must not alter phone swipes');
    input.setTouchOptions({ sensitivity: 230, aim: 'hold', sprint: 'hold' });
    assert.ok(Math.abs(turnTouch() - initial * 2) < 1e-8, 'doubling phone sensitivity doubles the same swipe turn');
    input.yaw = 0; input._dx = 40; input.updateLook();
    assert.ok(Math.abs(input.yaw + .32) < 1e-8, 'phone preference must not alter mouse movement');
    const reopened = new Input(new EventTarget(), { requireLock: false });
    assert.equal(reopened.touchOptions.sensitivity, 230);
    assert.equal(reopened.touchOptions.aim, 'hold');
    assert.equal(reopened.touchOptions.sprint, 'hold');
    assert.equal(stored.get('solatel.sensitivity'), String(.008));
  } finally { cleanup(); }
});

test('invalid phone preferences cannot produce a broken look sensitivity', () => {
  const { input } = setup();
  try {
    input.setTouchOptions({ sensitivity: Infinity, aim: 'invalid' });
    assert.equal(input.touchOptions.sensitivity, 115);
    assert.equal(input.touchOptions.aim, 'toggle');
    input.setTouchOptions({ sensitivity: 9999 });
    assert.equal(input.touchOptions.sensitivity, 250);
  } finally { cleanup(); }
});
