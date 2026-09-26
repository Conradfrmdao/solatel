// The menu: everything that happens when you are not in a match.
//
// This is the first thing a player sees and the thing they come back to after
// every match, because a match is one life and one life does not last long.
// It is a screen rather than an overlay: the world is not drawn behind it, and
// until a match starts there is no world to draw - the map a player ends up on
// is whichever table they pick, and several are running at once on different
// ground.
//
// Four panes, and nothing in any of them is a number this client worked out:
// the balance, the stakes, the queues and what a kill pays all arrive from the
// server. A client that computed its own wallet would be a client that could
// be wrong about money.
//
// That includes SOL. The wallet pane states the server's rate and shows the
// lamports the server says it is sending; it never converts a dollar amount
// itself, because a preview that disagreed with the transfer would be a
// preview that lied about money.

const PANES = ['play', 'wallet', 'profile', 'settings'];

/** One line about each map's ground, for the card. Cosmetic: the server
 *  names the maps and seats them, and a map with no line here still shows. */
const MAP_BLURB = {
  arena: 'close quarters · stairs and rooftops',
  yard: 'open ground · long sightlines',
};

/** Micro-USD as a string, the way the rest of the client formats money. */
function money(micros) {
  const negative = micros < 0;
  const whole = Math.abs(micros);
  const dollars = Math.floor(whole / 1e6);
  const cents = String(Math.round((whole % 1e6) / 1e4)).padStart(2, '0');
  return `${negative ? '-' : ''}$${dollars.toLocaleString('en-US')}.${cents}`;
}

/** Lamports as SOL, from the integer, with no float in between. */
function sol(lamports) {
  const digits = String(lamports).padStart(10, '0');
  const whole = digits.slice(0, -9).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(-9).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Micro-USD written out exactly, for filling in a form. */
function exactDollars(micros) {
  const whole = Math.floor(micros / 1e6);
  const fraction = String(micros % 1e6).padStart(6, '0').replace(/0+$/, '');
  return fraction.length < 2 ? `${whole}.${fraction.padEnd(2, '0')}` : `${whole}.${fraction}`;
}

/**
 * What somebody typed, as micro-USD, or null.
 *
 * Read as text, digit by digit. `Number("12.1") * 1e6` is 12099999.999999998,
 * and a withdrawal box is the last place to find that out.
 */
export function parseDollars(text) {
  const match = /^\s*\$?\s*(\d{1,9})(?:\.(\d{0,6}))?\s*$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'));
}

function shortAddress(address) {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

export class Menu {
  constructor(root) {
    this.root = root;
    this.root.innerHTML = TEMPLATE;

    this.purse = root.querySelector('#purse .amount');
    this.tabs = root.querySelector('#menu-tabs');
    this.maps = root.querySelector('#menu-maps');
    this.tables = root.querySelector('#menu-tables');
    this.status = root.querySelector('#menu-status');
    this.result = root.querySelector('#menu-result');
    this.balance = root.querySelector('#wallet-balance');
    this.walletNote = root.querySelector('#wallet-note');
    this.profile = root.querySelector('#menu-profile');
    this.history = root.querySelector('#wallet-history');

    /** Deposits and withdrawals seen this session, by id, newest last. */
    this.events = new Map();
    /** What the server said about its wallet, or null. */
    this.terms = null;
    /** The balance as last told, for the "all of it" button. */
    this.balanceMicros = null;

    // Every `data-copy` button copies the text of the element it names.
    root.addEventListener('click', (event) => {
      const button = event.target.closest('[data-copy]');
      if (!button) return;
      const source = root.querySelector(`#${button.dataset.copy}`);
      if (source) this._copy(source.textContent, button);
    });

    /** Which map the player is looking at. Chosen by them, not by the
     *  server: the server runs every map and will form a match on whichever
     *  they queue for. */
    this.chosenMap = null;
    /** The tables this server offers, from the handshake. */
    this.tiers = [];
    /** The maps it runs, and how many each seats. */
    this.mapList = [];

    this.tabs.addEventListener('click', (event) => {
      const button = event.target.closest('[data-pane]');
      if (button) this.showPane(button.dataset.pane);
    });

    this.maps.addEventListener('click', (event) => {
      const card = event.target.closest('[data-map]');
      if (!card) return;
      this.chosenMap = card.dataset.map;
      this._drawMaps();
      this._drawTables();
    });
  }

  /** What the server said it offers, from the `Welcome`. */
  setOffer(maps, tiers) {
    this.mapList = maps ?? [];
    this.tiers = tiers ?? [];
    if (!this.chosenMap && this.mapList.length) this.chosenMap = this.mapList[0].name;
    this._drawMaps();
    this._drawTables();
  }

  /**
   * What a click on a table does.
   *
   * Queueing is free - the entry fee is taken when a match actually forms -
   * so this is safe to wire directly to a button somebody can press twice.
   */
  bindPlay(onQueue, onLeaveQueue) {
    this.tables.addEventListener('click', (event) => {
      const button = event.target.closest('[data-stake]');
      if (button && this.chosenMap) onQueue(this.chosenMap, Number(button.dataset.stake));
    });
    this.status.addEventListener('click', (event) => {
      if (event.target.closest('#leave-queue')) onLeaveQueue();
    });
  }

  /**
   * What the withdraw form does. `onWithdraw(micros, destination)` is only
   * called with an amount that parsed; everything else about it - the
   * minimum, the address, the balance - is the server's to judge, and it
   * says why when it refuses.
   */
  bindWallet(onWithdraw) {
    const form = this.root.querySelector('#withdraw-form');
    const amount = this.root.querySelector('#withdraw-amount');
    const to = this.root.querySelector('#withdraw-to');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const micros = parseDollars(amount.value);
      if (micros === null || micros <= 0) {
        this.say('that is not an amount of dollars', true);
        return;
      }
      if (!to.value.trim()) {
        this.say('say which Solana address to send it to', true);
        return;
      }
      this.say('asking…');
      onWithdraw(micros, to.value.trim());
    });
    this.root.querySelector('#withdraw-max').addEventListener('click', () => {
      if (this.balanceMicros !== null) amount.value = exactDollars(this.balanceMicros);
    });
  }

  /**
   * The account pane: who this is, the key that proves it, and a way to use
   * a different one.
   *
   * `account.key()` reads the stored key rather than being handed a copy, so
   * the key is on screen only while somebody has asked to see it.
   */
  bindAccount(account) {
    const shown = this.root.querySelector('#account-key');
    const reveal = this.root.querySelector('#account-reveal');
    reveal.addEventListener('click', () => {
      const hidden = shown.classList.toggle('secret');
      shown.textContent = hidden ? 'hidden' : (account.key() ?? 'none yet');
      reveal.textContent = hidden ? 'show' : 'hide';
    });
    this.root.querySelector('#account-copy').addEventListener('click', (event) => {
      const key = account.key();
      if (key) this._copy(key, event.currentTarget);
    });
    this.root.querySelector('#account-restore').addEventListener('submit', (event) => {
      event.preventDefault();
      const pasted = this.root.querySelector('#account-paste').value.trim();
      if (pasted) account.restore(pasted);
    });
  }

  /** Who this player is, for the profile pane. */
  setPlayer(playerId) {
    this.root.querySelector('#account-id').textContent = playerId ?? '';
  }

  /**
   * What the server offers for money in and out, from the `Welcome`.
   *
   * Null is a server with no wallet, and the pane says so in words rather
   * than showing buttons that do nothing.
   */
  setWallet(terms) {
    this.terms = terms;
    const on = Boolean(terms);
    this.root.querySelector('#wallet-on').classList.toggle('hidden', !on);
    this.root.querySelector('#wallet-off').classList.toggle('hidden', on);
    if (!on) return;

    const q = (id) => this.root.querySelector(id);
    q('#wallet-network').innerHTML =
      terms.network === 'devnet'
        ? '<b>devnet</b> &middot; test SOL only, from faucet.solana.com. None of this is real money.'
        : `<b>${escapeHtml(terms.network)}</b>`;
    q('#deposit-address').textContent = terms.deposit_address;
    q('#deposit-memo').textContent = terms.deposit_memo;
    q('#deposit-rate').textContent =
      `1 SOL = ${money(terms.micro_usd_per_sol)} here. A fixed rate, not the market's.`;
    q('#deposit-link').href =
      `solana:${terms.deposit_address}?memo=${encodeURIComponent(terms.deposit_memo)}` +
      '&label=Solatel';
    q('#deposit-cli').textContent =
      `solana transfer ${terms.deposit_address} 0.1 --with-memo ${terms.deposit_memo} ` +
      `--url ${terms.network} --allow-unfunded-recipient`;

    const open = terms.withdrawals_open;
    for (const input of this.root.querySelectorAll('#withdraw-form input, #withdraw-form button')) {
      input.disabled = !open;
    }
    q('#withdraw-terms').textContent = open
      ? `At least ${money(terms.min_withdrawal_micro_usd)}, at the same rate. The network fee is ours.`
      : 'Withdrawals are off on this server while it hands out development money.';
  }

  /** A deposit landed, or a withdrawal moved on, or was refused. */
  walletEvent(message) {
    if (message.t === 'withdrawal_refused') {
      this.say(message.reason, true);
      return;
    }
    if (message.t === 'deposited') {
      this.events.set(message.signature, { kind: 'in', ...message });
      this.say(`${money(message.amount_micro_usd)} arrived`);
    } else if (message.t === 'withdrawal') {
      const first = !this.events.has(message.id);
      this.events.delete(message.id);
      this.events.set(message.id, { kind: 'out', ...message });
      if (first && message.status === 'requested') {
        this.say(`${money(message.amount_micro_usd)} is on its way`);
        this.root.querySelector('#withdraw-amount').value = '';
      } else if (message.status === 'returned') {
        this.say(`a withdrawal came back: ${message.reason ?? 'it did not land'}`, true);
      }
    }
    this._drawHistory();
  }

  _drawHistory() {
    const cluster = this.terms?.network ?? 'devnet';
    const link = (signature) =>
      signature
        ? ` <a href="https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=${encodeURIComponent(cluster)}" target="_blank" rel="noopener">view</a>`
        : '';
    const rows = [...this.events.values()].reverse().map((e) => {
      if (e.kind === 'in') {
        return (
          `<li class="in"><b>+${money(e.amount_micro_usd)}</b> deposited ` +
          `<span class="dim">${sol(e.lamports)} SOL</span>${link(e.signature)}</li>`
        );
      }
      const status = {
        requested: 'waiting to send',
        sent: 'sent, confirming',
        settled: 'arrived',
        returned: 'came back to your wallet',
      }[e.status] ?? e.status;
      return (
        `<li class="out ${escapeHtml(e.status)}"><b>&minus;${money(e.amount_micro_usd)}</b> ` +
        `to ${escapeHtml(shortAddress(e.destination))} ` +
        `<span class="dim">${sol(e.lamports)} SOL &middot; ${escapeHtml(status)}</span>` +
        `${link(e.signature)}</li>`
      );
    });
    this.history.innerHTML = rows.length ? rows.join('') : '<li class="dim">nothing yet</li>';
  }

  _copy(text, button) {
    const done = () => {
      const was = button.textContent;
      button.textContent = 'copied';
      setTimeout(() => (button.textContent = was), 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () =>
        this.say('the browser would not copy that; select it and copy by hand', true),
      );
    } else {
      this.say('the browser would not copy that; select it and copy by hand', true);
    }
  }

  showPane(name) {
    this.pane = name;
    for (const pane of PANES) {
      const on = pane === name;
      this.root.querySelector(`.pane[data-pane="${pane}"]`).classList.toggle('hidden', !on);
      this.root
        .querySelector(`#menu-tabs [data-pane="${pane}"]`)
        .classList.toggle('on', on);
    }
  }

  /** Whether the menu is the thing on screen. */
  show(on) {
    this.root.classList.toggle('hidden', !on);
    document.body.classList.toggle('in-menu', on);
  }

  /** Something the player needs told, in the wallet pane. */
  say(text, bad = false) {
    this.walletNote.textContent = text;
    this.walletNote.classList.toggle('warn', bad);
  }

  _drawMaps() {
    this.maps.innerHTML = this.mapList
      .map((map) => {
        const busy = this._busyOn(map.name);
        return (
          `<button class="map${map.name === this.chosenMap ? ' on' : ''}" ` +
          `type="button" data-map="${escapeHtml(map.name)}">` +
          `<span class="name">${escapeHtml(map.name)}</span>` +
          `<span class="seats">${map.seats} players</span>` +
          (MAP_BLURB[map.name] ? `<span class="blurb">${MAP_BLURB[map.name]}</span>` : '') +
          `<span class="busy">${busy}</span>` +
          `</button>`
        );
      })
      .join('');
  }

  _busyOn(name) {
    const rows = (this._tables ?? []).filter((t) => t.map === name);
    const waiting = rows.reduce((n, t) => n + t.waiting, 0);
    const running = rows.reduce((n, t) => n + t.running, 0);
    return `${waiting} waiting · ${running} playing`;
  }

  _drawTables() {
    const rows = (this._tables ?? []).filter((t) => t.map === this.chosenMap);
    // Before the first lobby message there is nothing to say about the
    // queues, but the stakes are known from the handshake - so the tables are
    // still offered, just without a crowd on them.
    const stakes = this.tiers.length
      ? this.tiers
      : rows.map((r) => ({ dollars: r.dollars, kill_reward_micro_usd: 0 }));

    this.tables.innerHTML = stakes
      .map((tier) => {
        const row = rows.find((t) => t.dollars === tier.dollars);
        const waiting = row ? row.waiting : 0;
        const running = row ? row.running : 0;
        const pays = tier.kill_reward_micro_usd
          ? `${money(tier.kill_reward_micro_usd)} a kill`
          : '';
        return (
          `<button class="table" type="button" data-stake="${tier.dollars}">` +
          `<span class="caption">stake</span>` +
          `<span class="stake">$${tier.dollars}</span>` +
          `<span class="pays">${pays}</span>` +
          `<span class="busy">${waiting} waiting · ${running} playing</span>` +
          `</button>`
        );
      })
      .join('');
  }

  /**
   * Redraw from the client's own state.
   *
   * Called every frame while the menu is up, which is cheap because it only
   * rewrites the parts that changed - the queues move a few times a minute,
   * not sixty times a second.
   */
  update(local, link) {
    const tablesChanged = JSON.stringify(local.tables) !== this._tablesJson;
    if (tablesChanged) {
      this._tables = local.tables;
      this._tablesJson = JSON.stringify(local.tables);
      this._drawMaps();
      this._drawTables();
    }

    this.balanceMicros = local.balanceMicroUsd;
    const purse = local.balanceMicroUsd === null ? '—' : money(local.balanceMicroUsd);
    if (purse !== this._purse) {
      this._purse = purse;
      this.purse.textContent = purse;
      this.balance.textContent = purse;
    }

    // What just happened, if anything did. Winnings are stated whether or not
    // there are any, because "you won nothing" is information and a blank
    // space is not - and they are already in the wallet, because nobody takes
    // them off a player for dying.
    let result = '';
    if (local.eliminated) {
      const by = local.killedBy
        ? `killed by <span class="who">${escapeHtml(local.killedBy)}</span>`
        : 'you are out';
      result = `${by} &middot; you won ${money(local.winningsMicroUsd)} that match`;
    } else if (local.finalBoard) {
      result = `match over &middot; you won ${money(local.winningsMicroUsd)}`;
    }
    if (result !== this._result) {
      this._result = result;
      this.result.innerHTML = result;
      this.result.classList.toggle('hidden', !result);
    }

    let status;
    if (link?.parked) {
      // Another tab has this player. The link is down on purpose, and
      // reloading is the way to take them back - which is a choice, so it is
      // a button rather than something that happens by itself.
      status =
        '<span class="warn">you are playing in another tab</span> ' +
        '<button id="play-here" type="button">play here instead</button>';
    } else if (local.broke) {
      status = `<span class="warn">not enough funds &mdash; ${purse} left</span>`;
    } else if (local.queuedFor !== null && local.queuedFor !== undefined) {
      const row = (local.tables ?? []).find(
        (t) => t.map === local.queuedMap && t.dollars === local.queuedFor,
      );
      const waiting = row ? row.waiting : 0;
      const needed = row ? row.needed : 0;
      // A line short of the floor is not counting down to anything, and a
      // clock on it would be a lie with a clock on it.
      const soon =
        waiting < needed
          ? 'waiting for more players'
          : local.formingInMs > 0
            ? `starting in ${Math.ceil(local.formingInMs / 1000)}s`
            : 'starting now';
      status =
        `in line for <b>${escapeHtml(local.queuedMap ?? '')} $${local.queuedFor}</b> ` +
        `&middot; ${waiting} of ${needed} &middot; you are #${local.place} &middot; ${soon} ` +
        `<button id="leave-queue" type="button">leave the line</button>`;
    } else if ((this.pane ?? 'play') === 'play' && this.chosenMap) {
      // Only on the play pane: a prompt to pick a table means nothing
      // under the wallet or the settings.
      status = `pick a table to join the line on <b>${escapeHtml(this.chosenMap)}</b>`;
    } else {
      status = '';
    }
    if (status !== this._status) {
      this._status = status;
      this.status.innerHTML = status;
      const here = this.status.querySelector('#play-here');
      if (here) here.addEventListener('click', () => window.location.reload());
    }
  }
}

const TEMPLATE = `
  <div class="menu-shell">
    <header>
      <div>
        <div class="brand">SOLATEL</div>
        <div class="tagline">one life &middot; real stakes &middot; paid per kill</div>
      </div>
      <div id="purse"><span class="amount">—</span><span class="caption">wallet</span></div>
    </header>

    <nav id="menu-tabs">
      <button type="button" data-pane="play" class="on">play</button>
      <button type="button" data-pane="wallet">wallet</button>
      <button type="button" data-pane="profile">profile</button>
      <button type="button" data-pane="settings">settings</button>
    </nav>

    <section class="pane" data-pane="play">
      <div id="menu-result" class="hidden"></div>
      <div class="label">map</div>
      <div id="menu-maps"></div>
      <div class="label">table</div>
      <div id="menu-tables"></div>

      <div class="label">how it works</div>
      <div class="rules">
        <div><b>one life</b><span>Your stake buys one life in one match. No respawn.</span></div>
        <div><b>paid per kill</b><span>Every kill pays the table's reward into your wallet at once.</span></div>
        <div><b>survive, get it back</b><span>Alive at the whistle, your whole stake comes back.</span></div>
        <div><b>killed</b><span>Your stake pays whoever killed you, less a 10% house cut.</span></div>
      </div>

      <div class="label">controls</div>
      <div class="keys">
        <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move</span>
        <span><kbd>mouse</kbd> look</span>
        <span><kbd>left click</kbd> shoot</span>
        <span><kbd>right click</kbd> aim</span>
        <span><kbd>space</kbd> jump</span>
        <span><kbd>tab</kbd> scores</span>
        <span><kbd>esc</kbd> free the mouse</span>
      </div>
      <div class="devices">
        <div class="device best">
          <b>mouse <em>recommended</em></b>
          <span class="pro">Fastest, most precise aim</span>
          <span class="pro">Turn and shoot while you run</span>
        </div>
        <div class="device">
          <b>laptop touchpad</b>
          <span class="pro">Works on any laptop</span>
          <span class="con">Slower, less precise aim against mouse players</span>
          <span class="con">Windows turns it off while you hold a key. Fix: Settings &rarr;
            Bluetooth &amp; devices &rarr; Touchpad &rarr; Taps &rarr; Touchpad
            sensitivity &rarr; <b>Most sensitive</b></span>
        </div>
      </div>
      <p class="needs-keyboard">Solatel is played with a keyboard and mouse. Open it on a computer to play.</p>
    </section>

    <section class="pane hidden" data-pane="wallet">
      <div class="big" id="wallet-balance">—</div>
      <div class="label">your balance</div>
      <div id="wallet-note"></div>

      <p id="wallet-off" class="fine">
        This server has no wallet, so money cannot go in or out.
      </p>

      <div id="wallet-on" class="hidden">
        <div id="wallet-network"></div>

        <div class="wallet-block">
          <div class="label">put money in</div>
          <div class="field">
            <span>send SOL to</span><code id="deposit-address"></code>
            <button type="button" data-copy="deposit-address">copy</button>
          </div>
          <div class="field">
            <span>with the memo</span><code id="deposit-memo"></code>
            <button type="button" data-copy="deposit-memo">copy</button>
          </div>
          <p class="fine" id="deposit-rate"></p>
          <p class="fine">
            The memo is how we know the money is yours. A transfer without it
            still arrives, but nobody can tell whose it is. Most wallets'
            send screens have no memo box:
            <a id="deposit-link">open this in a wallet that takes Solana Pay</a>,
            or send it from a terminal:
          </p>
          <code class="block" id="deposit-cli"></code>
          <p class="fine">It is in your balance about fifteen seconds after it is final.</p>
        </div>

        <div class="wallet-block">
          <div class="label">take money out</div>
          <form id="withdraw-form">
            <label>
              amount
              <span class="with-unit"><span>$</span><input id="withdraw-amount" inputmode="decimal" autocomplete="off" placeholder="5.00" /></span>
              <button type="button" id="withdraw-max">all of it</button>
            </label>
            <label>
              to
              <input id="withdraw-to" spellcheck="false" autocomplete="off" placeholder="your Solana address" />
            </label>
            <button id="withdraw" type="submit">withdraw</button>
          </form>
          <p class="fine" id="withdraw-terms"></p>
        </div>

        <div class="wallet-block">
          <div class="label">recent</div>
          <ul id="wallet-history"><li class="dim">nothing yet</li></ul>
        </div>
      </div>
    </section>

    <section class="pane hidden" data-pane="profile">
      <div id="menu-profile">
        <label>
          name
          <input id="playername" type="text" maxlength="16" />
          <span>used from your next reload</span>
        </label>
      </div>
      <div class="wallet-block">
        <div class="label">your account</div>
        <div class="field">
          <span>player id</span><code id="account-id"></code>
          <button type="button" data-copy="account-id">copy</button>
        </div>
        <div class="field">
          <span>account key</span><code id="account-key" class="secret">hidden</code>
          <button type="button" id="account-reveal">show</button>
          <button type="button" id="account-copy">copy</button>
        </div>
        <p class="fine">
          This key <b>is</b> your account. Anybody holding it can play as you
          and spend your balance, and if this browser forgets it your balance
          goes with it. Keep a copy somewhere safe.
        </p>
        <form id="account-restore" class="inline">
          <input id="account-paste" spellcheck="false" autocomplete="off" placeholder="paste a saved key to sign in with it" />
          <button type="submit">sign in</button>
        </form>
      </div>
    </section>

    <section class="pane hidden" data-pane="settings">
      <div id="settings">
        <label>
          sensitivity
          <input id="sensitivity" type="range" min="5" max="80" step="1" />
          <span id="sensitivity-value"></span>
        </label>
        <label>
          field of view
          <input id="fov" type="range" min="70" max="110" step="1" />
          <span id="fov-value"></span>
        </label>
        <label>
          volume
          <input id="volume" type="range" min="0" max="100" step="1" />
          <span id="volume-value"></span>
        </label>
        <label class="check">
          raw mouse
          <input id="rawmouse" type="checkbox" />
          <span>turn off if aim sticks after switching windows</span>
        </label>
        <label class="check">
          extra shading
          <input id="quality" type="checkbox" />
          <span>costs fps</span>
        </label>
      </div>
    </section>

    <footer id="menu-status"></footer>
  </div>
`;
