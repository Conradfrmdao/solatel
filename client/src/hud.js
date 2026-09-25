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

export class Hud {
  constructor(root) {
    this.root = root;
    this.root.innerHTML = TEMPLATE;

    this.stats = root.querySelector('#stats');
    this.health = root.querySelector('#health');
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
      line.innerHTML = `<span class="who">${victim}</span><span class="hs">fell</span>`;
    }

    this.killfeed.prepend(line);
    while (this.killfeed.childElementCount > KILLFEED_MAX) {
      this.killfeed.lastElementChild.remove();
    }
    window.setTimeout(() => line.remove(), KILLFEED_MS);
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
  bindQuality(initial, onChange) {
    this.quality.checked = initial;
    this.quality.addEventListener('change', () => onChange(this.quality.checked));
    this.quality.addEventListener('keydown', (event) => event.preventDefault());
  }

  /** Fades the crosshair with the sights up. Never to nothing: the dot is
   *  where the shot goes, and a player on real stakes should always see it. */
  setCrosshairOpacity(opacity) {
    const value = opacity.toFixed(2);
    if (value === this._crosshairOpacity) return;
    this._crosshairOpacity = value;
    this.crosshair.style.opacity = value;
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
    this.winnings.classList.toggle('hidden', local.winningsMicroUsd <= 0);
    if (local.winningsMicroUsd > 0) {
      this.winnings.firstChild.textContent = formatMoney(local.winningsMicroUsd);
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

    this.health.textContent = `${Math.max(0, local.health)} hp`;
    this.health.classList.toggle('hurt', local.health <= 34);

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
    for (const element of [this.health, this.crosshair, this.matchClock, this.pool]) {
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
  <div id="health">100 hp</div>
  <div id="pool"><span class="amount">$0.00</span><span class="caption">in play</span></div>
  <div id="balance"><span class="amount">$0.00</span><span class="caption">yours</span></div>
  <div id="winnings" class="hidden"><span class="amount">$0.00</span><span class="caption">won</span></div>
  <div id="matchclock"></div>
  <div id="crosshair"></div>
  <div id="hitmarker"></div>
  <div id="killfeed"></div>
  <div id="scoreboard" class="hidden"></div>
  <div id="lock-hint">click to capture the mouse &middot; escape to release</div>
  <div id="banner" class="hidden"></div>
`;
