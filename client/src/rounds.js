// Rounds in flight, as streaks of light, and where they come down.
//
// A round takes time to arrive (`sim::weapon`), so a tracer is not a line
// from the muzzle to the target drawn for a frame: it is a short bright
// streak flying along the round's own flight - the shared one, out of the
// wasm, stopping at the first wall the server's collision has there - at the
// round's own speed. A long shot is seen to take its time and to fall.
//
// Where a round lands is the server's to say. The dust or the mist is put
// there when the streak gets there (`land`), not when the message saying so
// happened to arrive, and a round the server says hit somebody stops at them.
// The player's own rounds are flown the moment they are fired, from the
// muzzle as it is drawn, and given their landing when the server's account
// of them comes back.
//
// All of it is drawn and none of it decides anything.

import * as THREE from 'three';
import { SIM, WEAPONS, roundPath } from './sim.js';

/** Streaks in the air at once before the oldest is reused. */
const POOL = 64;

/** How long a streak is, in seconds of the round's flight, and the most and
 *  least it may be in metres. */
const STREAK_SECONDS = 0.006;
const STREAK_MAX = 4.5;
const STREAK_MIN = 0.8;

/** Over how many metres a streak drawn from the muzzle closes on the round's
 *  true flight, which starts at the eye. */
const CONVERGE = 18;

/** Longest a flight is followed, in seconds. */
const LONGEST = 3;

/** Somebody else's round going by within this many metres of the listener
 *  is heard going by (`listen`). */
const PASS_RADIUS = 5;

/** Seconds into a flight at which it is `goal` metres from where it left. */
export function arrivalOn(path, goal) {
  const x0 = path[0];
  const y0 = path[1];
  const z0 = path[2];
  let before = 0;
  for (let i = 3; i < path.length; i += 3) {
    const d = Math.hypot(path[i] - x0, path[i + 1] - y0, path[i + 2] - z0);
    if (d >= goal) {
      const f = (goal - before) / Math.max(1e-6, d - before);
      return (i / 3 - 1 + f) * SIM.tickDt;
    }
    before = d;
  }
  return (path.length / 3 - 1) * SIM.tickDt;
}

function flightFor(weapon, from, velocity) {
  const gun = WEAPONS[weapon] ?? WEAPONS.rifle;
  const seconds = Math.min(LONGEST, (gun.range / gun.muzzleVelocity) * 2.5);
  return roundPath(weapon, from, velocity, seconds);
}

export class Rounds {
  constructor(scene) {
    this.scene = scene;
    this.live = [];
    this.waiting = [];
    this.pool = [];
    const material = new THREE.LineBasicMaterial({
      color: 0xffe2a0,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    for (let i = 0; i < POOL; i += 1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geometry, material.clone());
      line.visible = false;
      line.frustumCulled = false;
      scene.add(line);
      this.pool.push(line);
    }
    this._next = 0;
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this.listener = null;
    this.onPass = null;
  }

  /**
   * Where the player's ears are, and what to call when somebody else's round
   * goes past them within `PASS_RADIUS`: `onPass(point, distance, speed,
   * shooter)` - the nearest point of its flight to them, how near, how fast
   * it was going there, and whose it was. Being shot at is heard as being
   * shot at, from the side it went by on, before the report that says from
   * where.
   */
  listen(eye, onPass) {
    this.listener = eye;
    this.onPass = onPass;
  }

  /**
   * A round out of a gun: `from` and `velocity` as it left (the eye, and
   * the aim raised by the zero), `drawnFrom` the muzzle as it is drawn. `key`
   * pairs it with its landing; the player's own are `own` and paired in the
   * order they were fired.
   */
  add({ key, weapon, from, drawnFrom, velocity, own = false, shooter = null }) {
    const path = flightFor(weapon, from, velocity);
    if (path.length < 6) return;
    const line = this.pool[this._next];
    this._next = (this._next + 1) % this.pool.length;
    // A streak still flying in the slot it takes is let go.
    this.live = this.live.filter((r) => r.line !== line);
    const offset = drawnFrom
      ? [drawnFrom[0] - from[0], drawnFrom[1] - from[1], drawnFrom[2] - from[2]]
      : [0, 0, 0];
    const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
    this.live.push({
      key,
      own,
      weapon,
      path,
      t: 0,
      end: (path.length / 3 - 1) * SIM.tickDt,
      offset,
      length: Math.min(STREAK_MAX, Math.max(STREAK_MIN, speed * STREAK_SECONDS)),
      speed,
      landing: null,
      onArrive: null,
      line,
      shooter,
      passed: own,
      prev: new THREE.Vector3(path[0], path[1], path[2]),
    });
    line.material.color.setHex(0xffe2a0);
  }

  /**
   * Where the round `key` came down, and what to do when it gets there. A
   * round that is still flying stops there; one that is not - already
   * landed by the drawing's own reckoning, or never drawn - has `onArrive`
   * run after `delay` seconds.
   */
  land(key, landing, delay, own, onArrive) {
    let round = this.live.find((r) => r.key === key && key !== null);
    if (!round && own) round = this.live.find((r) => r.own && !r.landing);
    if (round) {
      const at = landing.at;
      const goal = Math.hypot(at[0] - round.path[0], at[1] - round.path[1], at[2] - round.path[2]);
      round.landing = landing;
      round.end = Math.min(round.end, arrivalOn(round.path, goal));
      round.onArrive = onArrive;
      if (landing.hit_player) round.line.material.color.setHex(0xff9a5a);
      if (round.t >= round.end) this._arrive(round);
      return;
    }
    this.waiting.push({ at: delay, onArrive });
  }

  /** Whether `round` has just gone past the listener: the nearest point of
   *  the stretch it flew this frame, if that is nearer than `PASS_RADIUS`
   *  and behind the round's head rather than still ahead of it. */
  _listen(round, dt) {
    if (!this.listener || !this.onPass) return;
    const head = this._at(round.path, Math.min(round.t, round.end), this._c);
    const from = round.prev;
    const step = this._d.subVectors(head, from);
    const length2 = step.lengthSq();
    const toEar = this._a.subVectors(this.listener, from);
    const s = length2 > 1e-9 ? Math.min(1, Math.max(0, toEar.dot(step) / length2)) : 1;
    const nearest = this._b.copy(from).addScaledVector(step, s);
    const distance = nearest.distanceTo(this.listener);
    const ended = round.t >= round.end;
    if (distance < PASS_RADIUS && (s < 1 || ended)) {
      round.passed = true;
      this.onPass(nearest, distance, Math.sqrt(length2) / Math.max(dt, 1e-4), round.shooter);
    } else if (ended) {
      round.passed = true;
    }
    from.copy(head);
  }

  _arrive(round) {
    round.line.visible = false;
    const done = round.onArrive;
    round.onArrive = null;
    round.done = true;
    if (done) done();
  }

  /** Where a flight is at `t` seconds, into `out`. */
  _at(path, t, out) {
    const f = Math.max(0, t / SIM.tickDt);
    const i = Math.min(Math.floor(f), path.length / 3 - 2);
    const k = Math.min(1, f - i);
    const j = i * 3;
    return out.set(
      path[j] + (path[j + 3] - path[j]) * k,
      path[j + 1] + (path[j + 4] - path[j + 1]) * k,
      path[j + 2] + (path[j + 5] - path[j + 2]) * k,
    );
  }

  update(dt) {
    for (const wait of this.waiting) wait.at -= dt;
    const due = this.waiting.filter((w) => w.at <= 0);
    if (due.length) {
      this.waiting = this.waiting.filter((w) => w.at > 0);
      for (const w of due) w.onArrive();
    }
    const still = [];
    for (const round of this.live) {
      round.t += dt;
      if (!round.passed) this._listen(round, dt);
      if (round.t >= round.end) {
        // Out of flight: landed where the server said, or into a wall, or
        // spent. A landing still to come keeps it waiting a moment, so its
        // dust is not lost.
        if (round.landing || round.t > round.end + 0.6) {
          this._arrive(round);
          continue;
        }
        round.line.visible = false;
        still.push(round);
        continue;
      }
      const head = this._at(round.path, round.t, this._a);
      const travelled = head.distanceTo(this._b.set(round.path[0], round.path[1], round.path[2]));
      const tail = this._at(round.path, Math.max(0, round.t - round.length / round.speed), this._b);
      // From the muzzle as drawn, closing on the true flight from the eye.
      const near = (d) => Math.max(0, 1 - d / CONVERGE);
      const headFade = near(travelled);
      const tailFade = near(Math.max(0, travelled - round.length));
      const [ox, oy, oz] = round.offset;
      const positions = round.line.geometry.getAttribute('position');
      positions.setXYZ(0, tail.x + ox * tailFade, tail.y + oy * tailFade, tail.z + oz * tailFade);
      positions.setXYZ(1, head.x + ox * headFade, head.y + oy * headFade, head.z + oz * headFade);
      positions.needsUpdate = true;
      round.line.visible = true;
      round.line.material.opacity = 0.85;
      still.push(round);
    }
    this.live = still;
  }
}
