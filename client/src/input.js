// Keyboard, mouse and pointer lock.
//
// # Why this is its own module
//
// Aim is the thing players are most particular about, and the old client got it
// wrong in a way that took a long time to find: the engine's own mouse handling
// reduced movement under pointer lock and rounded slow movement to zero, so
// turning only worked if you moved the mouse hard. Reading `movementX` here
// directly is not a workaround - it is what the browser offers, and it is
// exactly what the engine was failing to pass along.
//
// # Sensitivity
//
// Radians of turn per unit of raw mouse movement. At the default a 180 degree
// turn takes about 800 units, which on a typical 800 DPI mouse is an inch of
// desk - in the range competitive shooters ship at. It is adjustable at
// runtime because no single value is right for everyone, and because settling
// it needs playing rather than reasoning.

import { SIM, wrapAngle } from './sim.js';

const DEFAULT_SENSITIVITY = 0.0022;

/** How long to wait before asking for the pointer again after a refusal.
 *  Chrome's own cooldown after Escape is about a second. */
const RELOCK_COOLDOWN_MS = 1300;

/** How long the browser may send no movement at all, while the player is
 *  holding a movement key, before the page says so.
 *
 *  Three seconds, not one and a half. Holding a key that long without
 *  touching the mouse is ordinary - lining up a run down a corridor does
 *  it - and this only raises a notice, so the cost of being slow is
 *  nothing and the cost of being hasty is a false alarm mid-fight. */
const SILENCE_MS = 3000;

/** Whether to ask for unaccelerated movement. Stored, because it is the
 *  one part of this that is known to fail in a way the page cannot see. */
const RAW_MOUSE_KEY = 'solatel.rawmouse';
const SENSITIVITY_KEY = 'solatel.sensitivity';

export class Input {
  /**
   * `requireLock` is true in normal play: without the mouse captured, a player
   * who has tabbed away should not keep running into a wall. It is turned off
   * by `?nolock=1`, which exists so an automated browser can drive the game -
   * synthetic clicks do not earn pointer lock, and without this there is no way
   * to test movement outside a person's hands.
   */
  constructor(canvas, { requireLock = true } = {}) {
    this.canvas = canvas;
    this.requireLock = requireLock;

    /** Where the player is looking. Updated every frame, never per tick. */
    this.yaw = 0;
    this.pitch = 0;

    this.sensitivity = readStoredSensitivity();

    this.locked = false;
    /** How many times the lock has been lost. A climbing number means
     *  something on the page is stealing it. */
    this.lockLosses = 0;
    /** Raw movement seen since the last frame, for the HUD. */
    this.lastDelta = 0;
    /** Whether the browser gave us unaccelerated deltas. */
    this.rawInput = false;

    this._dx = 0;
    this._dy = 0;
    this._keys = new Set();
    this._fire = false;
    this._capturing = false;
    this._retry = 0;
    /** How many movement events have arrived, for the diagnostics. */
    this.moveEvents = 0;
    /** When one last did, so a silence can be told from a still hand. */
    this._lastMotionAt = performance.now();
    /** Whether the browser has gone quiet while the player was moving. */
    this.silent = false;
    /** Whether to ask for unaccelerated movement at all. */
    this.rawWanted = readStoredFlag(RAW_MOUSE_KEY, true);

    this._bind();
  }

  _bind() {
    window.addEventListener('mousemove', (event) => {
      if (this.requireLock && !this.locked) return;
      // Sum the coalesced samples when the browser offers them. A 1000 Hz
      // mouse produces sixteen samples between two frames and the browser
      // merges them into one event; the merged event's own movement is
      // meant to be their sum, and Chromium has got that wrong more than
      // once. Reading the parts when they exist cannot double-count,
      // because the parent is only read when there are none.
      const parts = event.getCoalescedEvents ? event.getCoalescedEvents() : null;
      if (parts && parts.length) {
        for (const part of parts) {
          this._dx += part.movementX || 0;
          this._dy += part.movementY || 0;
        }
      } else {
        this._dx += event.movementX || 0;
        this._dy += event.movementY || 0;
      }
      this.moveEvents += 1;
      this._lastMotionAt = performance.now();
    });

    window.addEventListener('mousedown', (event) => {
      // Only while the mouse is captured. Without this, dragging the
      // sensitivity slider fires the gun.
      if ((this.locked || !this.requireLock) && event.button === 0) {
        this._fire = true;
      }
    });
    window.addEventListener('mouseup', (event) => {
      if (event.button === 0) this._fire = false;
    });

    window.addEventListener('keydown', (event) => {
      this._keys.add(event.code);
      // Space scrolls the page and the arrow keys move the caret; neither is
      // wanted while the mouse is captured.
      if (this.locked && SWALLOWED.has(event.code)) event.preventDefault();
    });
    window.addEventListener('keyup', (event) => this._keys.delete(event.code));

    // Losing focus must release every key, or a player who alt-tabs while
    // running comes back still running.
    window.addEventListener('blur', () => {
      this._keys.clear();
      this._fire = false;
    });

    // Coming back to the window is exactly when raw input registration is
    // most likely to have been lost, so treat it as a fresh start rather
    // than trusting whatever state was left behind.
    window.addEventListener('focus', () => {
      this._lastMotionAt = performance.now();
    });

    // Anywhere, not just the canvas. The settings panel covers a corner of
    // the screen and takes its own clicks, so a player who clicked there to
    // get the mouse back got nothing at all - which is indistinguishable
    // from the game having frozen.
    window.addEventListener('mousedown', (event) => {
      if (this.locked) return;
      // Only the world takes the mouse. Anywhere else - the menu, the
      // settings, a button - a click means what the button says, and
      // capturing the pointer there is worse than doing nothing: the first
      // click works, the pointer goes to the canvas, and every click after
      // it lands on a locked canvas instead of the thing the player aimed
      // at. That is what made the menu unusable past its first press, and it
      // is why this tests for the canvas rather than listing the things to
      // stay off.
      if (event.target !== this.canvas) return;
      this.capture();
    });

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.canvas;
      if (this.locked && !locked) this.lockLosses += 1;
      this.locked = locked;
      if (!locked) {
        // Drop anything accumulated while unlocked, so re-capturing does not
        // apply a backlog of movement in one jump.
        this._dx = 0;
        this._dy = 0;
        this._keys.clear();
        this._fire = false;
      }
    });

    document.addEventListener('pointerlockerror', () => {
      console.warn('pointer lock error');
      this._retryCapture();
    });
  }

  /**
   * Ask for the mouse.
   *
   * Two attempts at different times, because the browser refuses for
   * reasons that pass. Chrome will not hand the pointer back for about a
   * second after Escape, and a game that only asks once inside that second
   * leaves the player clicking at a window that has stopped responding to
   * them.
   */
  async capture() {
    if (this.locked || this._capturing) return;
    this._capturing = true;
    try {
      if (!this.rawWanted) {
        // The player has turned unaccelerated movement off. The OS curve
        // is applied to the deltas instead, which is worse to aim with and
        // does not depend on raw input registration surviving.
        await this.canvas.requestPointerLock();
        this.rawInput = false;
        return;
      }
      // Chrome and Edge honour this and hand back unaccelerated movement.
      // Firefox and Safari ignore the option and fall back to accelerated
      // deltas, which still play acceptably.
      await this.canvas.requestPointerLock({ unadjustedMovement: true });
      this.rawInput = true;
    } catch {
      try {
        await this.canvas.requestPointerLock();
        this.rawInput = false;
      } catch {
        this._retryCapture();
      }
    } finally {
      this._capturing = false;
    }
  }

  /** Once more when the browser's cooldown has passed, and only once. */
  _retryCapture() {
    if (this._retry) return;
    this._retry = window.setTimeout(() => {
      this._retry = 0;
      // Not if they have gone somewhere else in the meantime, and not if
      // they got it back another way.
      if (!this.locked && document.hasFocus()) this.capture();
    }, RELOCK_COOLDOWN_MS);
  }

  /**
   * Notice the browser having stopped sending movement, and say so.
   *
   * Called once a frame. It does not take the pointer back. An earlier
   * version did, and it was a bad idea: the only evidence available is
   * "a movement key is held and no mouse movement has arrived", which is
   * also what lining up a long run down a corridor looks like. Breaking
   * the lock underneath a player doing that would be a worse bug than the
   * one being chased, introduced blind.
   *
   * So it raises a flag, the HUD shows it, and a click - anywhere - fixes
   * it. What this is really for is telling the two cases apart: if this
   * never trips while the view is frozen, the browser is still sending and
   * the fault is in this file.
   */
  checkForSilence(now) {
    if (!this.locked || !this.requireLock) {
      this.silent = false;
      return;
    }
    if (this._keys.size === 0) {
      // Not at the controls. A still mouse means a still hand.
      this._lastMotionAt = now;
      this.silent = false;
      return;
    }
    this.silent = now - this._lastMotionAt >= SILENCE_MS;
  }

  /** Turn unaccelerated movement on or off, and re-take the pointer so it
   *  applies at once rather than at the next lock. */
  setRawMouse(wanted) {
    this.rawWanted = wanted;
    try {
      window.localStorage.setItem(RAW_MOUSE_KEY, wanted ? '1' : '0');
    } catch {
      /* private browsing */
    }
    if (this.locked) {
      document.exitPointerLock();
      this._retryCapture();
    }
  }

  /** Whether a key is down right now, by `KeyboardEvent.code`.
   *
   *  For keys the simulation must never see. Movement and firing go through
   *  `command()`, where they are sequenced and sent to the server; this is
   *  for the ones that only change what this client draws, like holding the
   *  scoreboard open. Tab is already swallowed while the pointer is
   *  captured, and `blur` clears every key, so tabbing away cannot leave it
   *  stuck down. */
  held(code) {
    return this._keys.has(code);
  }

  setSensitivity(value) {
    this.sensitivity = value;
    try {
      window.localStorage.setItem(SENSITIVITY_KEY, String(value));
    } catch {
      // Private browsing; the setting just will not persist.
    }
  }

  /**
   * Applies this frame's mouse movement to the look angles.
   *
   * Called once per rendered frame rather than once per simulation tick, and
   * before the tick that builds the input command. Sampling it after would mean
   * every command carried the previous frame's aim, which makes turning while
   * moving fight itself - a mistake the old client made and had to undo.
   */
  updateLook() {
    const dx = this._dx;
    const dy = this._dy;
    this._dx = 0;
    this._dy = 0;
    this.lastDelta = Math.round(Math.hypot(dx, dy));

    if (this.requireLock && !this.locked) return;

    this.yaw = wrapAngle(this.yaw - dx * this.sensitivity);
    this.pitch -= dy * this.sensitivity;
    const limit = SIM.maxPitch;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  /** Movement intent for this tick, as the wire wants it. */
  sample() {
    if (this.requireLock && !this.locked) {
      // A player who has released the mouse should not keep running into a
      // wall.
      return { forward: 0, right: 0, jump: false, fire: false };
    }
    let forward = 0;
    let right = 0;
    if (this._keys.has('KeyW')) forward += 1;
    if (this._keys.has('KeyS')) forward -= 1;
    if (this._keys.has('KeyD')) right += 1;
    if (this._keys.has('KeyA')) right -= 1;
    return {
      forward,
      right,
      jump: this._keys.has('Space'),
      fire: this._fire,
    };
  }

  /** Raw key state, for the HUD's input row. */
  debug() {
    return {
      forward: this._keys.has('KeyW'),
      back: this._keys.has('KeyS'),
      left: this._keys.has('KeyA'),
      right: this._keys.has('KeyD'),
      jump: this._keys.has('Space'),
      fire: this._fire,
    };
  }
}

const SWALLOWED = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Tab',
]);

function readStoredFlag(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) return raw === '1';
  } catch {
    /* private browsing */
  }
  return fallback;
}

function readStoredSensitivity() {
  try {
    const stored = Number(window.localStorage.getItem(SENSITIVITY_KEY));
    if (Number.isFinite(stored) && stored > 0) return stored;
  } catch {
    /* private browsing */
  }
  return DEFAULT_SENSITIVITY;
}
