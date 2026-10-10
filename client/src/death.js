// The moment a life ends.
//
// One entry fee buys one life, so being killed is the most expensive thing
// that happens in this game, and it used to be a cut straight to the menu:
// the server says `eliminated`, the match is gone, and the next frame is a
// list of tables. Nobody could see what had happened to them, or from where.
//
// So the last frame of the match is held for a few seconds and played out.
// The view drops to the floor and rolls, the colour drains and the sound
// goes dull, and then it turns to where the killer was standing as this
// client last saw them, under a card saying who, with what, from how far,
// and what the life was worth. Then the menu. A click skips the rest once
// the fall is over.
//
// All of it is drawn from what this client already had. The server has
// stopped sending this match by now and nothing here asks it for anything:
// the killer's position is the one the last snapshot put them at, which is
// no more than the player could see a moment before, and the player is out
// of that match for good.

import * as THREE from 'three';

/** How long the whole thing lasts, unless skipped. */
export const DEATH_SECONDS = 3.6;

/** How long before a click may skip it: the fall is the part that says what
 *  happened, and it is not optional. */
const SKIPPABLE_AFTER = 1.1;

/** The fall: how long, and where the eye ends up above the feet. */
const FALL_SECONDS = 0.7;
const FLOOR_EYE = 0.3;

/** How far over the view rolls, and how long it takes to settle there. */
const ROLL = 1.15;
const ROLL_SECONDS = 0.95;

/** When the view starts turning to the killer, and how long it takes. */
const TURN_AT = 0.75;
const TURN_SECONDS = 1.3;

/** How far the world's clock runs while it is held. */
export const DEATH_TIME_SCALE = 0.3;

const CAUSES = {
  rifle: 'assault rifle',
  pistol: 'pistol',
  smg: 'smg',
  lmg: 'machine gun',
  sniper: 'sniper rifle',
  grenade: 'grenade',
  zone: 'caught outside the zone',
  fall: 'fell',
};

/** The causes that are a gun: a headshot is said of these. */
const SHOT = new Set(['rifle', 'pistol', 'smg', 'lmg', 'sniper']);

const easeIn = (t) => t * t;
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp01 = (t) => Math.min(Math.max(t, 0), 1);

/** The shortest signed angle from `a` to `b`. */
function towards(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function money(micros) {
  const cents = Math.round(Math.abs(micros) / 10000);
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export class Death {
  constructor(root = document.body) {
    this.card = document.createElement('div');
    this.card.id = 'death-card';
    this.card.innerHTML = `
      <div class="dc-veil"></div>
      <div class="dc-body">
        <div class="dc-title">ELIMINATED</div>
        <div class="dc-by"></div>
        <div class="dc-how"></div>
        <div class="dc-money"></div>
        <div class="dc-skip">click to continue</div>
      </div>`;
    root.appendChild(this.card);
    this.by = this.card.querySelector('.dc-by');
    this.how = this.card.querySelector('.dc-how');
    this.money = this.card.querySelector('.dc-money');
    this.skip = this.card.querySelector('.dc-skip');
    this.active = null;
    /** The last death played out: who did it and how, as the card said. */
    this.summary = null;
    /** Seconds of the sequence per second of the clock. One, always, except
     *  for a test driving a software renderer at a frame every few seconds. */
    this.rate = 1;
    /** The last report of this player's own death, until the server says
     *  they are out - `killed` comes first, `eliminated` right behind it. */
    this.pending = null;
    this._skipAsked = false;
    window.addEventListener('pointerdown', () => {
      if (this.active) this._skipAsked = true;
    });
    window.addEventListener('keydown', (event) => {
      if (this.active && (event.code === 'Space' || event.code === 'Enter' || event.code === 'Escape')) {
        this._skipAsked = true;
      }
    });
  }

  /** The server's `killed`, when it is this player who died. */
  noteKilled(message, killerAt) {
    this.pending = {
      killer: message.killer ?? null,
      killerName: message.killer_name ?? null,
      headshot: Boolean(message.headshot),
      cause: message.cause ?? 'rifle',
      killerAt: killerAt ? killerAt.clone() : null,
    };
  }

  /**
   * Out of the match: start playing it out from where the eye was. Answers
   * false when there is nothing to play - no report of the death arrived -
   * and the caller should go straight to the menu as before.
   */
  begin(now, eye, yaw, pitch, { stake = 0, winnings = 0, eyeHeight = 1.6 } = {}) {
    const report = this.pending;
    this.pending = null;
    if (!report) return false;
    // Which way to fall: away from the killer if there was one, otherwise
    // whichever way the hash of the moment says.
    let side = (Math.floor(now) % 2) * 2 - 1;
    let killerYaw = null;
    let killerPitch = null;
    let distance = null;
    if (report.killerAt) {
      const to = new THREE.Vector3().subVectors(report.killerAt, eye);
      distance = to.length();
      // The eye the turn is measured from is the fallen one, a body's
      // height lower; looking up at whoever is standing over you is the
      // point of it.
      const fallen = to.clone();
      fallen.y += eyeHeight - FLOOR_EYE;
      killerYaw = Math.atan2(-fallen.x, -fallen.z);
      killerPitch = Math.atan2(fallen.y + 1.2, Math.hypot(fallen.x, fallen.z));
      side = towards(yaw, killerYaw) > 0 ? -1 : 1;
    }
    this.active = {
      start: now,
      eye: eye.clone(),
      yaw,
      pitch,
      side,
      drop: Math.max(0, eyeHeight - FLOOR_EYE),
      killerYaw,
      killerPitch,
    };
    this._skipAsked = false;

    const who = report.killerName;
    this.by.textContent = who ? `by ${who}` : '';
    const how = [];
    how.push(CAUSES[report.cause] ?? report.cause);
    if (SHOT.has(report.cause) && report.headshot) how.push('headshot');
    if (distance !== null && report.cause !== 'zone' && report.cause !== 'fall') how.push(`${Math.round(distance)} m`);
    this.how.textContent = how.join(' · ');
    /** Who and how, for the results screen after this (`debrief.js`). */
    this.summary = { who, how: how.join(' · ') };
    const lines = [];
    if (stake > 0) lines.push(who ? `your ${money(stake)} stake went to ${who}` : `your ${money(stake)} stake is settled`);
    lines.push(winnings > 0 ? `+${money(winnings)} won this life` : 'nothing won this life');
    this.money.textContent = lines.join('  ·  ');
    this.card.classList.remove('dc-skippable');
    document.body.classList.add('dying');
    return true;
  }

  /**
   * Where the camera is this frame, or null when the sequence is over (run
   * out, or skipped).
   */
  frame(now, out) {
    const a = this.active;
    if (!a) return null;
    const t = ((now - a.start) / 1000) * this.rate;
    if (t >= DEATH_SECONDS || (this._skipAsked && t >= SKIPPABLE_AFTER)) {
      this.end();
      return null;
    }
    if (t >= SKIPPABLE_AFTER) this.card.classList.add('dc-skippable');
    this._skipAsked = this._skipAsked && t >= SKIPPABLE_AFTER;

    const fall = easeIn(clamp01(t / FALL_SECONDS));
    out.position.copy(a.eye);
    out.position.y -= a.drop * fall;
    // A small bounce as the body lands, then still.
    if (t > FALL_SECONDS) {
      const after = t - FALL_SECONDS;
      out.position.y += Math.sin(Math.min(after / 0.18, 1) * Math.PI) * 0.05 * Math.exp(-after * 6);
    }
    let roll = a.side * ROLL * easeOut(clamp01(t / ROLL_SECONDS));
    let yaw = a.yaw + a.side * 0.25 * easeOut(clamp01(t / ROLL_SECONDS));
    // The head goes back as the body goes down.
    let pitch = a.pitch + (0.35 - a.pitch * 0.5) * easeOut(clamp01(t / FALL_SECONDS));
    if (a.killerYaw !== null) {
      const turn = easeInOut(clamp01((t - TURN_AT) / TURN_SECONDS));
      yaw += towards(yaw, a.killerYaw) * turn;
      pitch += (a.killerPitch - pitch) * turn;
      // Lifting the head off the floor to look: some of the roll comes out.
      roll *= 1 - 0.45 * turn;
    }
    out.yaw = yaw;
    out.pitch = pitch;
    out.roll = roll;
    out.t = t;
    return out;
  }

  get playing() {
    return Boolean(this.active);
  }

  end() {
    this.active = null;
    this.pending = null;
    document.body.classList.remove('dying');
    this.card.classList.remove('dc-skippable');
  }
}
