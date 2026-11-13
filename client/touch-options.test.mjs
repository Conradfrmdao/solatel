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

test('phone camera and ADS sensitivity are independent of each other and the mouse', () => {
  const { input, stored } = setup();
  try {
    assert.equal(input.touchOptions.sensitivity, 115);
    input._touchWidth = 844;
    const turnTouch = () => { input.yaw = 0; input._turnTouch(40, 0); input.updateLook(); return input.yaw; };
    const initial = turnTouch();
    assert.ok(Math.abs(initial) > 0.34, 'a small right-thumb swipe should turn at least 19 degrees');
    input.setSensitivity(.008);
    assert.equal(turnTouch(), initial, 'desktop sensitivity must not alter phone swipes');
    input.setTouchOptions({ sensitivity: 230, adsSensitivity: 75, moveSensitivity: 155, aim: 'hold', sprint: 'hold' });
    assert.ok(Math.abs(turnTouch() - initial * 2) < 1e-8, 'doubling phone sensitivity doubles the same swipe turn');
    input.lookScale = .25;
    assert.ok(Math.abs(turnTouch() - initial * 2) < 1e-8, 'dropping ADS must immediately restore hip response');
    input._pressTouchButton('aim');
    const scoped = turnTouch();
    assert.ok(Math.abs(scoped - initial * .5 * 75 / 115) < 1e-8, 'scope uses its own slider and optic scaling');
    input.setTouchOptions({ sensitivity: 115 });
    assert.equal(turnTouch(), scoped, 'hip camera slider must not change scoped movement');
    input.setTouchOptions({ adsSensitivity: 150 });
    assert.ok(Math.abs(turnTouch() - scoped * 2) < 1e-8, 'ADS slider must change scoped movement');
    input._releaseTouchButton('aim');
    input.lookScale = 1;
    input.yaw = 0; input._dx = 40; input.updateLook();
    assert.ok(Math.abs(input.yaw + .32) < 1e-8, 'phone preference must not alter mouse movement');
    const reopened = new Input(new EventTarget(), { requireLock: false });
    assert.equal(reopened.touchOptions.sensitivity, 115);
    assert.equal(reopened.touchOptions.adsSensitivity, 150);
    assert.equal(reopened.touchOptions.moveSensitivity, 155);
    assert.equal(reopened.touchOptions.aim, 'hold');
    assert.equal(reopened.touchOptions.sprint, 'hold');
    assert.equal(stored.get('solatel.sensitivity'), String(.008));
  } finally { cleanup(); }
});

test('older saved layouts retain the camera slider and receive separate movement and ADS defaults', () => {
  const { stored } = setup();
  try {
    stored.set('solatel.touchOptions.v1', JSON.stringify({ sensitivity: 160, aim: 'hold' }));
    const reopened = new Input(new EventTarget(), { requireLock: false });
    assert.deepEqual(reopened.touchOptions, {
      sensitivity: 160, adsSensitivity: 90, moveSensitivity: 125, aim: 'hold', crouch: 'toggle', sprint: 'toggle',
    });
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
