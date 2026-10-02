// The overlay: diagnostics, crosshair, health.
//
// Plain DOM rather than anything drawn in the scene. Text is the one thing the
// browser is already better at than a renderer, and keeping it out of the
// scene means it costs no draw calls and stays crisp at any resolution.
//
// The diagnostics are not decoration. `predict` is the distance between what
// this client drew and what the server said, and a number that climbs is the
// single clearest sign that client and server have stopped agreeing - which in
// a game that pays per kill is the failure that matters most. `input` shows
// the raw key state, which answers a question that is otherwise guesswork:
// when a control does not work, is the client failing to act on it, or is the
// browser never delivering it?

import { LinkState } from './net.js';
import { SIM } from './sim.js';

export class Hud {
  constructor(root) {
    this.root = root;
    this.root.innerHTML = TEMPLATE;

    this.stats = root.querySelector('#stats');
    this.health = root.querySelector('#health');
    this.healthFill = root.querySelector('#health .fill');
    this.healthText = root.querySelector('#health .value');
    this.weapon = root.querySelector('#weapon');
    this.ammo = root.querySelector('#weapon .ammo');
    this.reloadBar = root.querySelector('#weapon .reload .fill');
    this.grenadeCount = root.querySelector('#weapon .grenades');
    this.zoneWarning = root.querySelector('#zone-warning');
    this.warmup = root.querySelector('#warmup');
    this.warmupCount = root.querySelector('#warmup .count');
    this.warmupAbout = root.querySelector('#warmup .about');
    this.warmupHint = root.querySelector('#warmup .hint');
    this.go = root.querySelector('#go');
    this._wasWarming = false;
    this.hurtFlash = root.querySelector('#hurt-flash');
    this.damageRing = root.querySelector('#damage-dirs');
    /** Where recent hits came from, each kept until it fades. */
    this._damage = [];
    this._lastHealth = null;
    this.crosshair = root.querySelector('#crosshair');
    this.marker = root.querySelector('#hitmarker');
    this.lockHint = root.querySelector('#lock-hint');
    this.banner = root.querySelector('#banner');
    // These controls sit in the menu rather than on the HUD - settings
    // belong on a screen you go to between matches, not over your crosshair -
    // but the wiring stays here, so they are looked up in the document rather
    // than in this subtree.
    this.sensitivity = document.querySelector('#sensitivity');
    this.sensitivityValue = document.querySelector('#sensitivity-value');
    this.fov = document.querySelector('#fov');
    this.fovValue = document.querySelector('#fov-value');
    this.quality = document.querySelector('#quality');
    this.rawMouse = document.querySelector('#rawmouse');
    this.volume = document.querySelector('#volume');
    this.volumeValue = document.querySelector('#volume-value');
    this.pool = root.querySelector('#pool');
    this.balance = root.querySelector('#balance');

    this.winnings = root.querySelector('#winnings');
    this.payouts = root.querySelector('#payouts');
    /** Payouts on screen that have not reached the counter yet. */
    this._pops = new Set();
    /** Kills in the current quick run, and when the last one was. */
    this._streak = 0;
    this._streakAt = -Infinity;
    /** The winnings as last drawn, and whether a payout has just reached
     *  the counter so that it should tick over. */
    this._shownWinnings = null;
    this._landed = false;
    this.playerName = document.querySelector('#playername');
    this.matchClock = root.querySelector('#matchclock');
    this.killfeed = root.querySelector('#killfeed');
    this.scoreboard = root.querySelector('#scoreboard');

    /** Latest board from the server, kept so holding the key can redraw it
     *  without waiting for the next broadcast. */
    this._entries = [];
    this._localId = null;

    this._frames = 0;
    this._fpsAt = performance.now();
    this._fps = 0;
  }

  get fps() {
    return this._fps;
  }

  /** Wires the sensitivity slider to the input module. */
  bindSensitivity(input) {
    this.sensitivity.value = String(input.sensitivity * 10000);
    this.sensitivityValue.textContent = input.sensitivity.toFixed(4);
    this.sensitivity.addEventListener('input', () => {
      const value = Number(this.sensitivity.value) / 10000;
      input.setSensitivity(value);
      this.sensitivityValue.textContent = value.toFixed(4);
    });
    // The slider must not eat the keys the game uses once it has focus.
    this.sensitivity.addEventListener('keydown', (event) => event.preventDefault());
  }

  /** The name box. Editing it stores the name; it reaches the server on the
   *  next handshake, which is why the row says so. */
  bindName(initial, onChange) {
    this.playerName.value = initial;
    this.playerName.addEventListener('change', () => {
      onChange(this.playerName.value);
    });
  }

  /** Remember who this client is, so the board can pick their row out. */
  setLocalPlayer(id) {
    this._localId = id;
  }

  /** The server's board. Stored rather than drawn, because it arrives once a
   *  second and the player looks at it when they choose to. */
  setScores(entries) {
    this._entries = entries;
    if (!this.scoreboard.classList.contains('hidden')) this._drawScores();
  }

  showScoreboard(show) {
    this.scoreboard.classList.toggle('hidden', !show);
    if (show) this._drawScores();
  }

  _drawScores() {
    // The server sorted these. The client renders them in the order given
    // rather than sorting again, so two players watching the same match
    // never disagree about who is ahead when their records are level.
    const rows = this._entries
      .map((entry) => {
        const mine = entry.id === this._localId ? ' class="me"' : '';
        const dim = entry.alive ? '' : ' style="opacity:0.55"';
        return `<tr${mine}${dim}>
          <td class="name">${escapeHtml(entry.name)}</td>
          <td>${entry.kills}</td>
          <td>${entry.deaths}</td>
          <td>${entry.headshots}</td>
          <td>${accuracy(entry)}</td>
          <td>${entry.damage_dealt}</td>
        </tr>`;
      })
      .join('');
    this.scoreboard.innerHTML = `
      <table>
        <thead><tr>
          <th class="name">player</th><th>k</th><th>d</th>
          <th>hs</th><th>acc</th><th>dmg</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  /** One line in the feed. Everything here is already the server's account of
   *  what happened; the client only decides how long it stays up. */
  addKill(event) {
    const line = document.createElement('div');
    line.className = 'kill';
    const victim = escapeHtml(event.victim_name);
    const mineKill = event.killer && event.killer === this._localId;
    const mineDeath = event.victim === this._localId;
    if (mineKill || mineDeath) line.classList.add('mine');

    if (event.killer_name) {
      const killer = escapeHtml(event.killer_name);
      const mark = event.headshot ? '<span class="hs">✖</span>' : '<span class="hs">→</span>';
      line.innerHTML = `<span class="who">${killer}</span>${mark}<span class="who">${victim}</span>`;
    } else {
      // No killer: a fall, or the world taking them.
      const how = { zone: 'burned in the zone', grenade: 'blew up', fall: 'fell' }[event.cause] ?? 'fell';
      line.innerHTML = `<span class="who">${victim}</span><span class="hs">${how}</span>`;
    }
    // A kill by something other than the rifle says so, because a grenade
    // through a doorway and a zone that finished off a wounded player are
    // different stories about the same fight.
    if (event.killer_name && event.cause && event.cause !== 'rifle') {
      const how = { grenade: 'grenade', zone: 'zone', fall: 'fall' }[event.cause];
      if (how) line.insertAdjacentHTML('beforeend', `<span class="cause">${how}</span>`);
    }

    this.killfeed.prepend(line);
    while (this.killfeed.childElementCount > KILLFEED_MAX) {
      this.killfeed.lastElementChild.remove();
    }
    window.setTimeout(() => line.remove(), KILLFEED_MS);
  }

  /**
   * The moment a kill pays. The reward punches in under the crosshair,
   * holds long enough to read, and flies up into the winnings counter,
   * which ticks over as it lands.
   *
   * `rewardMicroUsd` is the reward the server stated for this match's table
   * in `MatchStarted`, and every kill it credits pays exactly that; this
   * only formats it. Each kill shows its own reward. Two kills are two
   * payouts, never a total the client added up - the total is the counter,
   * and the counter is the server's.
   *
   * Returns which kill this is in a quick run, for the sound.
   */
  payout(event, rewardMicroUsd, { onLand } = {}) {
    const now = performance.now();
    this._streak = now - this._streakAt <= STREAK_MS ? this._streak + 1 : 1;
    this._streakAt = now;
    const paid = Number.isInteger(rewardMicroUsd) && rewardMicroUsd > 0;

    // Anything still under the crosshair goes up now, so a second kill
    // never lands on top of the first.
    for (const pop of this._pops) pop.fly();

    const box = document.createElement('div');
    box.className = 'payout';
    const amount = document.createElement('div');
    amount.className = paid ? 'amount' : 'amount unpaid';
    amount.textContent = paid ? `+${formatMoney(rewardMicroUsd)}` : 'ELIMINATED';
    const details = document.createElement('div');
    details.className = 'details';
    const tags = document.createElement('div');
    tags.className = 'tags';
    const tag = (text, kind) => {
      const span = document.createElement('span');
      span.className = `tag ${kind}`;
      span.textContent = text;
      tags.appendChild(span);
    };
    if (event.headshot) tag('HEADSHOT', 'head');
    const how = { grenade: 'GRENADE', zone: 'ZONE', fall: 'FALL' }[event.cause];
    if (how) tag(how, 'cause');
    if (this._streak >= 2) tag(streakName(this._streak), 'streak');
    const victim = document.createElement('div');
    victim.className = 'victim';
    const name = document.createElement('b');
    // A name off the wire goes in as text, never markup.
    name.textContent = event.victim_name ?? '';
    // With no reward to show, the headline already says it.
    victim.append(paid ? 'eliminated ' : '', name);
    if (tags.childElementCount) details.appendChild(tags);
    details.appendChild(victim);
    box.append(amount, details);
    this.payouts.appendChild(box);

    amount.animate(
      [
        { transform: 'scale(1.9)', opacity: 0 },
        { transform: 'scale(0.93)', opacity: 1, offset: 0.55 },
        { transform: 'scale(1)', opacity: 1 },
      ],
      { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'both' },
    );
    details.animate(
      [
        { transform: 'translateY(-5px)', opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 200, delay: 90, easing: 'ease-out', fill: 'both' },
    );
    // A drift upwards while it is read, so it never sits dead still.
    box.animate([{ translate: '0 0' }, { translate: '0 -8px' }], {
      duration: PAYOUT_HOLD_MS,
      easing: 'ease-out',
      fill: 'forwards',
    });
    this._sparks(box, amount);

    let flown = false;
    let finished = false;
    const pop = {};
    const finish = () => {
      if (finished) return;
      finished = true;
      box.remove();
      this._pops.delete(pop);
      if (paid) {
        this._landed = true;
        onLand?.();
      }
    };
    pop.fly = () => {
      if (flown) return;
      flown = true;
      details.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
      if (!paid) {
        amount.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: 'forwards' });
        window.setTimeout(finish, 280);
        return;
      }
      // Up to the counter along a curve that passes to one side of the
      // crosshair rather than across it, speeding up as it goes.
      const from = amount.getBoundingClientRect();
      const to = this._winningsTarget();
      const dx = to.x - (from.left + from.width / 2);
      const dy = to.y - (from.top + from.height / 2);
      const bow = Math.abs(dy) * 0.32;
      const frames = [];
      for (let k = 0; k <= FLIGHT_FRAMES; k += 1) {
        const u = k / FLIGHT_FRAMES;
        const t = u ** 2.1;
        // A quadratic curve through a control point off to the right.
        const x = 2 * (1 - t) * t * (dx * 0.5 + bow) + t * t * dx;
        const y = 2 * (1 - t) * t * (dy * 0.45) + t * t * dy;
        const scale = 1 + (0.3 - 1) * t;
        frames.push({
          transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`,
          opacity: k === FLIGHT_FRAMES ? 0.3 : 1 - 0.4 * t,
        });
      }
      amount
        .animate(frames, { duration: PAYOUT_FLY_MS, fill: 'forwards' })
        .finished.then(finish, finish);
      // Animations are not guaranteed to finish in a hidden tab; the
      // counter must not wait on one forever.
      window.setTimeout(finish, PAYOUT_FLY_MS + 250);
    };
    this._pops.add(pop);
    window.setTimeout(pop.fly, PAYOUT_HOLD_MS);
    return this._streak;
  }

  /** A burst of sparks off the reward as it lands on screen. Decoration. */
  _sparks(box, amount) {
    const centre = amount.offsetTop + amount.offsetHeight / 2;
    for (let i = 0; i < SPARKS; i += 1) {
      const spark = document.createElement('i');
      spark.className = 'spark';
      spark.style.top = `${centre}px`;
      box.appendChild(spark);
      const angle = (i / SPARKS) * Math.PI * 2 + Math.random() * 0.45;
      const reach = 44 + Math.random() * 40;
      // Wider than tall, the shape of the number it comes off, and each
      // streak pointing the way it flies.
      const x = Math.cos(angle) * reach * 1.8;
      const y = Math.sin(angle) * reach * 0.8;
      const turn = `rotate(${Math.atan2(y, x).toFixed(3)}rad)`;
      const at = (f, stretch) =>
        `translate(${(x * f).toFixed(1)}px, ${(y * f).toFixed(1)}px) ${turn} scaleX(${stretch})`;
      spark.animate(
        [
          { transform: at(0.3, 1.8), opacity: 1 },
          { transform: at(1, 0.4), opacity: 0 },
        ],
        {
          duration: 480 + Math.random() * 220,
          easing: 'cubic-bezier(0.1, 0.7, 0.3, 1)',
          fill: 'forwards',
        },
      ).finished.then(() => spark.remove(), () => spark.remove());
    }
  }

  /** Where the winnings counter is on screen, measured even while it is
   *  hidden - before the first kill of a match it is. */
  _winningsTarget() {
    const hidden = this.winnings.classList.contains('hidden');
    if (hidden) this.winnings.classList.remove('hidden');
    const rect = this.winnings.getBoundingClientRect();
    if (hidden) this.winnings.classList.add('hidden');
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  /** The counter taking the reward: a swell and a flash of white. */
  _bumpWinnings() {
    this.winnings.animate(
      [
        { transform: 'translateX(-50%) scale(1)' },
        { transform: 'translateX(-50%) scale(1.5)', offset: 0.22 },
        { transform: 'translateX(-50%) scale(1)' },
      ],
      { duration: 460, easing: 'ease-out' },
    );
    this.winnings.firstChild.animate(
      [
        { color: '#ffffff', textShadow: '0 0 14px rgba(159, 232, 180, 1), 0 0 3px #ffffff' },
        { color: '#9fe8b4', textShadow: '0 1px 2px rgba(0, 0, 0, 0.9)' },
      ],
      { duration: 800, easing: 'ease-out' },
    );
  }

  /**
   * Wires the volume slider.
   *
   * A slider rather than a mute button, because sound here is information -
   * where a shot came from and how far away it was - and a player who finds it
   * loud should turn it down rather than turn it off and lose the cue.
   */
  bindVolume(initial, onChange) {
    this.volume.value = String(Math.round(initial * 100));
    this.volumeValue.textContent = `${Math.round(initial * 100)}%`;
    this.volume.addEventListener('input', () => {
      const value = Number(this.volume.value);
      this.volumeValue.textContent = `${value}%`;
      onChange(value / 100);
    });
    this.volume.addEventListener('keydown', (event) => event.preventDefault());
  }

  /**
   * Wires the field-of-view slider.
   *
   * Quoted horizontally, the way shooters quote it, because that is the number
   * a player already has an opinion about from every other game they play.
   */
  bindFov(initial, onChange) {
    this.fov.value = String(initial);
    this.fovValue.textContent = `${initial}°`;
    this.fov.addEventListener('input', () => {
      const value = Number(this.fov.value);
      this.fovValue.textContent = `${value}°`;
      onChange(value);
    });
    this.fov.addEventListener('keydown', (event) => event.preventDefault());
  }

  /**
   * Wires the unaccelerated-movement toggle.
   *
   * Exposed because it is the one part of the mouse pipeline with a known
   * way of failing silently - the browser keeps the pointer and stops
   * sending movement - and turning it off is the quickest way to find out
   * whether that is what is happening.
   */
  bindRawMouse(input) {
    this.rawMouse.checked = input.rawWanted;
    this.rawMouse.addEventListener('change', () => {
      input.setRawMouse(this.rawMouse.checked);
    });
    this.rawMouse.addEventListener('keydown', (event) => event.preventDefault());
  }

  /**
   * Wires the ambient-occlusion toggle.
   *
   * Named for what it costs rather than what it is: "ambient occlusion" means
   * nothing to most players, and the thing they need to know is that it is the
   * setting to turn off when the game stutters.
   */
  /** Wires the graphics level: `auto` or a preset, see quality.js. */
  bindQuality(initial, onChange) {
    this.quality.value = initial;
    this.quality.addEventListener('change', () => onChange(this.quality.value));
  }

  /** What is in force, and why, beside the setting. */
  setQualityNote(text) {
    const note = document.querySelector('#quality-note');
    if (note) note.textContent = text;
  }

  /** Fades the crosshair with the sights up. Never to nothing: its middle
   *  is where the shot goes, and a player on real stakes should always see
   *  it. */
  setCrosshairOpacity(opacity) {
    const value = opacity.toFixed(2);
    if (value === this._crosshairOpacity) return;
    this._crosshairOpacity = value;
    this.crosshair.style.opacity = value;
  }

  /**
   * A hit taken from somebody at `from` (world metres): an arc round the
   * crosshair on the side it came from, held there as the player turns, so
   * "where is that coming from" is answered at a glance. Fades in
   * `DAMAGE_SHOW_MS`; a harder hit is a heavier arc.
   */
  damageFrom(now, from, amount) {
    if (!from || !this.damageRing) return;
    // One arc per attacker: a second hit from the same place refreshes it.
    let entry = this._damage.find((d) => d.from.distanceToSquared(from) < 4);
    if (!entry) {
      const el = document.createElement('div');
      el.className = 'dmg';
      el.appendChild(document.createElement('i'));
      this.damageRing.appendChild(el);
      entry = { el, from: from.clone() };
      this._damage.push(entry);
    }
    entry.from.copy(from);
    entry.until = now + DAMAGE_SHOW_MS;
    entry.weight = Math.min(1, 0.45 + amount / 50);
  }

  /** Turns each arc to where its hit came from, as the view turns. */
  updateDamage(now, eye, yaw) {
    this._damage = this._damage.filter((d) => {
      const left = d.until - now;
      if (left <= 0) {
        d.el.remove();
        return false;
      }
      const toYaw = Math.atan2(-(d.from.x - eye.x), -(d.from.z - eye.z));
      const relative = toYaw - yaw;
      d.el.style.transform = `translate(-50%, -50%) rotate(${-relative}rad)`;
      d.el.style.opacity = String(Math.min(1, left / 600) * d.weight);
      return true;
    });
  }

  update(now, link, local, input) {
    this._frames += 1;
    if (now - this._fpsAt >= 500) {
      this._fps = (this._frames * 1000) / (now - this._fpsAt);
      this._frames = 0;
      this._fpsAt = now;
    }

    const keys = input.debug();
    const held = (on, name) => (on ? name : '-'.repeat(name.length));

    this.stats.textContent = [
      `SOLATEL   three.js client`,
      `render    ${this._fps.toFixed(0)} fps`,
      `link      ${link.state}${link.note ? `  (${link.note})` : ''}`,
      `ping      ${link.rttMs === null ? '--' : `${link.rttMs.toFixed(0)} ms`}`,
      // Always shown, not just under ?debug=1. When a player says they
      // cannot get up something, this is the difference between finding it
      // in a minute and not finding it at all.
      `at        ${local.current.x.toFixed(1)}, ${local.current.y.toFixed(1)}, ` +
        `${local.current.z.toFixed(1)}`,
      `predict   ${local.predictionError.toFixed(3)} m error`,
      `unacked   ${local.unacked.length} inputs`,
      `input     ${held(keys.forward, 'W')} ${held(keys.left, 'A')} ` +
        `${held(keys.back, 'S')} ${held(keys.right, 'D')} ` +
        `${held(keys.jump, 'JUMP')} ${held(keys.fire, 'FIRE')}`,
      // Enough to tell "the browser stopped sending movement" from "the
      // page stopped applying it" in a screenshot. `events` climbing while
      // `units/frame` stays zero means the page has a bug; `events` frozen
      // means the browser has stopped delivering.
      `mouse     ${input.lastDelta} units/frame  ` +
        `captured ${input.locked ? 'yes' : 'no'}` +
        (input.lockLosses ? `  (lost ${input.lockLosses}x)` : '') +
        (input.locked && !input.rawInput ? '  [accelerated]' : ''),
      `          ${input.moveEvents} events` +
        (input.silent ? '   NOT RESPONDING - click to recapture' : ''),
    ].join('\n');

    // The pot, in the one place everyone looks anyway. It arrives with every
    // snapshot as an integer count of micro-USD and is only formatted here -
    // the number is the server's, and a client that worked it out for itself
    // would be a client that could be wrong about money.
    if (local.poolMicroUsd !== null) {
      this.pool.firstChild.textContent = formatMoney(local.poolMicroUsd);
      this.pool.classList.add('shown');
    }

    // And what this player has left, which only a paid server ever sends.
    // In free play it stays hidden rather than showing a confident $0.00
    // that is really "nobody has told us".
    if (local.balanceMicroUsd !== null) {
      this.balance.firstChild.textContent = formatMoney(local.balanceMicroUsd);
      this.balance.classList.add('shown');
      this.balance.classList.toggle('broke', local.broke);
    }

    // What the match has been worth so far: kills times the reward, counted
    // by the server. Shown only once there is something to show, so a player
    // with no kills is not stared at by a zero all match.
    //
    // While a payout is on its way up the counter waits for it, so the
    // reward lands and the total ticks over in the same instant. The figure
    // drawn is the server's either way - this moves when it is drawn, never
    // what it says.
    const waiting = this._pops.size > 0 && !this._landed;
    if (!waiting && local.winningsMicroUsd !== this._shownWinnings) {
      this._shownWinnings = local.winningsMicroUsd;
      this.winnings.classList.toggle('hidden', this._shownWinnings <= 0);
      if (this._shownWinnings > 0) {
        this.winnings.firstChild.textContent = formatMoney(this._shownWinnings);
      }
    }
    if (this._landed) {
      this._landed = false;
      if (this._shownWinnings > 0) this._bumpWinnings();
    }

    // The clock, and whether the circle is moving right now. A player
    // needs to know the boundary is closing *while* it closes, not after
    // they have been walked into the middle of the map by it.
    const left = Math.max(0, local.matchRemainingMs);
    const seconds = Math.ceil(left / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = String(seconds % 60).padStart(2, '0');
    this.matchClock.textContent = `${mins}:${secs}`;
    this.matchClock.classList.toggle('urgent', seconds <= 30);

    // Health is a bar as well as a number: at a glance in a fight the
    // length is read, not the digits. It is the server's figure - regen and
    // the zone both happen there - and only drawn here.
    const hp = Math.max(0, local.health);
    const max = SIM.maxHealth || 100;
    this.healthText.textContent = String(hp);
    this.healthFill.style.transform = `scaleX(${hp / max})`;
    this.health.classList.toggle('hurt', hp <= max / 3);
    if (this._lastHealth !== null && hp < this._lastHealth && local.inMatch) {
      this.hurtFlash.classList.remove('flash');
      void this.hurtFlash.offsetWidth; // restart the animation
      this.hurtFlash.classList.add('flash');
    }
    this.health.classList.toggle('regen', this._lastHealth !== null && hp > this._lastHealth);
    this._lastHealth = hp;

    const reloading = local.reloadMs > 0;
    this.ammo.innerHTML = reloading
      ? '<span class="reloading">RELOADING</span>'
      : `<b>${local.ammo}</b> / ${SIM.magazine}`;
    this.ammo.classList.toggle('empty', !reloading && local.ammo === 0);
    this.ammo.classList.toggle('low', !reloading && local.ammo > 0 && local.ammo <= SIM.magazine / 5);
    this.reloadBar.parentElement.classList.toggle('hidden', !reloading);
    if (reloading) {
      const done = 1 - local.reloadMs / (SIM.reloadSeconds * 1000);
      this.reloadBar.style.transform = `scaleX(${Math.min(1, Math.max(0, done))})`;
    }
    this.grenadeCount.textContent = '●'.repeat(local.grenades) + '○'.repeat(
      Math.max(0, SIM.grenadesPerLife - local.grenades),
    );

    // The warm-up: everybody on their spawn, counting down together. The
    // count is the server's, run down between its messages; "go" is shown
    // when the server says the match is live, not when the local count
    // reaches zero, so it is never early.
    const warming = local.inMatch && local.warmingUp;
    this.warmup.classList.toggle('hidden', !warming);
    if (warming) {
      const seconds = Math.max(1, Math.ceil(local.startsInMs / 1000));
      if (this.warmupCount.textContent !== String(seconds)) {
        this.warmupCount.textContent = String(seconds);
        this.warmupCount.classList.remove('beat');
        void this.warmupCount.offsetWidth;
        this.warmupCount.classList.add('beat');
      }
      const about = [
        local.mapName,
        local.tier ? `$${local.tier.dollars} table` : null,
        local.matchPlayers ? `${local.matchPlayers} players` : null,
        local.poolMicroUsd !== null ? `${formatMoney(local.poolMicroUsd)} in play` : null,
      ].filter(Boolean).join(' · ');
      if (this.warmupAbout.textContent !== about) this.warmupAbout.textContent = about;
      const hint = input.locked || !input.requireLock
        ? 'look around - you can move when it hits zero'
        : 'click to take the mouse - you can move when it hits zero';
      if (this.warmupHint.textContent !== hint) this.warmupHint.textContent = hint;
    }
    if (this._wasWarming && !warming && local.inMatch) {
      this.go.classList.remove('show');
      void this.go.offsetWidth;
      this.go.classList.add('show');
    }
    this._wasWarming = warming;

    // Outside the circle it hurts, and the player is told so in the middle
    // of the screen, because the edge is behind them by definition.
    this.zoneWarning.classList.toggle('hidden', !(local.outsideZone && local.isAlive));

    this.marker.classList.toggle('show', local.hitMarker > 0);
    this.marker.classList.toggle('head', local.hitMarker > 0 && local.hitWasHead);
    this.lockHint.classList.toggle('hidden', input.locked);

    // Held, not toggled. A scoreboard you have to press twice is a
    // scoreboard somebody leaves open during a fight.
    this.showScoreboard(input.held('Tab'));

    // Everything that describes a match is hidden while the player is not in
    // one. A health bar over the lobby says "you are playing" to somebody who
    // is choosing a table, and the crosshair invites them to shoot at it.
    const playing = local.inMatch && local.isAlive;
    for (const element of [this.health, this.crosshair, this.matchClock, this.pool, this.weapon]) {
      element.classList.toggle('out-of-match', !playing);
    }


    const down = link.state !== LinkState.Ready;
    this.banner.classList.toggle('hidden', !down);
    if (down) this.banner.textContent = link.note;
  }
}

/**
 * Micro-USD as dollars and cents.
 *
 * Integer arithmetic throughout, including the split into the two halves:
 * this is money, and a float here would be the one place in the codebase
 * where a cent could go missing on its way to the screen.
 */
/** How long a killfeed line stays up. */
const KILLFEED_MS = 6000;

/** How long an arc saying where a hit came from stays up. */
const DAMAGE_SHOW_MS = 2200;

/** How long a payout sits under the crosshair before it flies to the
 *  counter, and how long the flight takes. */
const PAYOUT_HOLD_MS = 900;
const PAYOUT_FLY_MS = 520;

/** Steps the flight's curve is drawn in. */
const FLIGHT_FRAMES = 10;

/** Sparks thrown off a payout as it lands. */
const SPARKS = 12;

/** Kills closer together than this are one run: a double, a triple. */
const STREAK_MS = 4500;

function streakName(count) {
  if (count === 2) return 'DOUBLE KILL';
  if (count === 3) return 'TRIPLE KILL';
  return `KILL STREAK ×${count}`;
}

/** Most lines kept at once, so a busy fight cannot paper over the screen. */
const KILLFEED_MAX = 5;

/** Accuracy as a whole percent, from the two counts the server kept.
 *
 *  Zero shots is not zero accuracy, it is no data, and showing "0%" next to
 *  somebody who has not fired reads as an insult rather than a statistic.
 */
function accuracy(entry) {
  if (!entry.shots_fired) return '–';
  return `${Math.round((entry.shots_hit / entry.shots_fired) * 100)}%`;
}

function escapeHtml(text) {
  // Names come off the wire. The server strips control characters and bounds
  // the length, which makes them safe to *store*; this is what makes them
  // safe to put in a document. Somebody will eventually be called
  // `<img onerror=...>` and it should render as that, not run as it.
  return String(text).replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

function formatMoney(micros) {
  const negative = micros < 0;
  const cents = Math.round(Math.abs(micros) / 10000);
  const dollars = Math.floor(cents / 100);
  const remainder = String(cents % 100).padStart(2, '0');
  return `${negative ? '-' : ''}$${dollars.toLocaleString('en-US')}.${remainder}`;
}

const TEMPLATE = `
  <pre id="stats"></pre>
  <div id="health"><span class="value">100</span><span class="bar"><span class="fill"></span></span></div>
  <div id="weapon">
    <div class="ammo"><b>30</b> / 30</div>
    <div class="reload hidden"><span class="fill"></span></div>
    <div class="grenades" title="grenades (G)">●●</div>
  </div>
  <div id="zone-warning" class="hidden">OUTSIDE THE ZONE &middot; get back in</div>
  <div id="warmup" class="hidden">
    <div class="caption">match starts in</div>
    <div class="count">15</div>
    <div class="about"></div>
    <div class="hint"></div>
  </div>
  <div id="go">GO</div>
  <div id="hurt-flash"></div>
  <div id="damage-dirs"></div>
  <div id="pool"><span class="amount">$0.00</span><span class="caption">in play</span></div>
  <div id="balance"><span class="amount">$0.00</span><span class="caption">your wallet</span></div>
  <div id="winnings" class="hidden"><span class="amount">$0.00</span><span class="caption">won this match</span></div>
  <div id="matchclock"></div>
  <div id="crosshair"><i class="n"></i><i class="s"></i><i class="w"></i><i class="e"></i><b></b></div>
  <div id="hitmarker"></div>
  <div id="payouts"></div>
  <div id="killfeed"></div>
  <div id="scoreboard" class="hidden"></div>
  <div id="lock-hint">click to capture the mouse &middot; escape to release</div>
  <div id="banner" class="hidden"></div>
`;
