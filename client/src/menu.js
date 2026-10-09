// The menu: everything that happens when you are not in a match.
//
// This is the first thing a player sees and the thing they come back to after
// every match, because a match is one life and one life does not last long.
// It is a screen rather than an overlay: the world is not drawn behind it, and
// until a match starts there is no world to draw - the map a player ends up on
// is whichever table they pick, and several are running at once on different
// ground.
//
// Five panes, and nothing in any of them is a number this client worked out:
// the balance, the stakes, the queues, what a kill pays and what the game has
// paid out all arrive from the server. A client that computed its own wallet
// would be a client that could be wrong about money.
//
// That includes SOL. The wallet pane states the server's rate and shows the
// lamports the server says it is sending; it never converts a dollar amount
// itself, because a preview that disagreed with the transfer would be a
// preview that lied about money.

import qrcode from 'qrcode-generator';
import { asset } from './assets.js';
import { OPTICS, PRIMARIES, SIM, WEAPONS } from './sim.js';
import {
  canSend,
  connect,
  depositTransaction,
  latestBlockhash,
  parseSol,
  parseUsdc,
  signAndSend,
  signText,
  usdcAccountOf,
  usdcDepositTransaction,
  watchWallets,
} from './solana.js';

const PANES = ['play', 'wallet', 'board', 'profile', 'fair', 'settings'];

/** How long a read of the payout record is shown before it is read again.
 *  The server caches it for a minute; asking more often gains nothing. */
const PROOF_STALE_MS = 30_000;

/** How often the live feed and the leaderboard are read while on screen.
 *  The server caches its answer for fifteen seconds. */
const BOARD_STALE_MS = 20_000;

/** Two lines about each map's ground, for its card, in Conrad's words.
 *  Cosmetic: the server names the maps and seats them, and a map with no
 *  lines here still shows. */
const MAP_BLURB = {
  arena: ['Close quarters. Fast action.', 'No place to hide.'],
  yard: ['Open spaces. Tactical fights.', 'Control the yard.'],
  facility: ['High ground. Tight angles.', 'One mistake ends it.'],
};

/** Where the stake last chosen is kept, per browser: a convenience, so the
 *  table a player plays at is the one picked when they come back. */
const STAKE_KEY = 'solatel.stake';

/** And the gun and optic last chosen, the same way. */
const LOADOUT_KEY = 'solatel.loadout';

/** What each optic is called on a button. */
const OPTIC_NAMES = { irons: 'Iron sights', red_dot: 'Red dot', x2: '2x', x3: '3x', x4: '4x' };

/** A line about each gun, for its card. Cosmetic: what each one does is the
 *  shared table's, and is shown from it. */
const GUN_BLURB = {
  smg: 'Fastest kill up close. Falls off quickly.',
  rifle: 'The all-rounder. Good from ten metres to a hundred.',
  lmg: 'A 75-round drum, holds its damage at range. Slow to reload.',
  sniper: 'One round to the head kills. Lead your target.',
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

/** How long ago an ISO timestamp was, in the one unit that matters. */
function ago(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 90) return 'just now';
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

/** A count with thousands separated. */
function count(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}

/** A count and the right word for it. */
function plural(n, one, many) {
  return `${count(n)} ${Number(n) === 1 ? one : many}`;
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
    this.play = root.querySelector('#menu-play');
    this.carrying = root.querySelector('#menu-carrying');
    this.activity = root.querySelector('#menu-activity');
    this.meName = root.querySelector('#me-name');
    this.meAvatar = root.querySelector('#me-avatar');
    this.meLine = root.querySelector('#me-line');
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

    /** What this player will carry: a primary and its optic, remembered. */
    this.loadout = { primary: 'rifle', optic: 'red_dot' };
    try {
      const kept = JSON.parse(window.localStorage.getItem(LOADOUT_KEY) ?? 'null');
      if (kept && WEAPONS[kept.primary]?.optics.includes(kept.optic) && PRIMARIES.includes(kept.primary)) {
        this.loadout = { primary: kept.primary, optic: kept.optic };
      }
    } catch {
      /* no storage, or something else in it: the rifle it is */
    }
    this.guns = root.querySelector('#menu-guns');
    this.optics = root.querySelector('#menu-optics');
    /** Pictures of the guns, once drawn (`setGunPictures`). */
    this.gunPictures = new Map();

    /** Which stake, of the tables this server offers. */
    this.chosenStake = null;
    try {
      this.chosenStake = Number(window.localStorage.getItem(STAKE_KEY)) || null;
    } catch {
      /* no storage: the first table it is */
    }

    // Every button naming a pane goes to it: the tabs, the wallet in the top
    // bar, the wordmark, and the links beside the tables.
    root.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-pane]');
      if (button) this.showPane(button.dataset.pane);
    });

    this.maps.addEventListener('click', (event) => {
      const card = event.target.closest('[data-map]');
      if (!card) return;
      this.chosenMap = card.dataset.map;
      this._drawMaps();
      this._drawTables();
    });
    this.guns.addEventListener('click', (event) => {
      const card = event.target.closest('[data-gun]');
      if (!card) return;
      const primary = card.dataset.gun;
      const optics = WEAPONS[primary]?.optics ?? [];
      // The optic chosen stays if this gun can carry it.
      const optic = optics.includes(this.loadout.optic) ? this.loadout.optic : optics[0];
      this._setLoadout({ primary, optic });
    });
    this.optics.addEventListener('click', (event) => {
      const button = event.target.closest('[data-optic]');
      if (!button) return;
      this._setLoadout({ ...this.loadout, optic: button.dataset.optic });
    });
    this.tables.addEventListener('click', (event) => {
      const button = event.target.closest('[data-stake]');
      if (!button) return;
      this.chosenStake = Number(button.dataset.stake);
      try {
        window.localStorage.setItem(STAKE_KEY, String(this.chosenStake));
      } catch {
        /* private browsing */
      }
      this._drawTables();
    });
  }

  /** What the server said it offers, from the `Welcome`. */
  setOffer(maps, tiers) {
    this.mapList = maps ?? [];
    this.tiers = tiers ?? [];
    if (!this.chosenMap && this.mapList.length) this.chosenMap = this.mapList[0].name;
    if (!this.tiers.some((t) => t.dollars === this.chosenStake)) this.chosenStake = this.tiers[0]?.dollars ?? null;
    this._drawMaps();
    this._drawTables();
    this._drawGuns();
  }

  /** The gun and optic to play with, remembered for next time. */
  _setLoadout(loadout) {
    this.loadout = loadout;
    try {
      window.localStorage.setItem(LOADOUT_KEY, JSON.stringify(loadout));
    } catch {
      /* private browsing */
    }
    this._drawGuns();
    this._drawPlay();
  }

  /** Pictures of each gun, drawn from its model (`portraits.js`). */
  setGunPictures(pictures) {
    this.gunPictures = pictures;
    this._drawGuns();
  }

  /**
   * The guns, as cards: a picture, a name, what the gun is for, and bars for
   * what it does - every one read off the shared table the server enforces.
   * The optics the chosen gun can carry go under them.
   */
  _drawGuns() {
    if (!this.guns) return;
    const tick = SIM.tickDt || 1 / 64;
    const bar = (label, fraction, text) =>
      `<span class="stat"><span class="label">${label}</span>` +
      `<span class="track"><span class="fill" style="width:${Math.round(Math.min(1, Math.max(0.04, fraction)) * 100)}%"></span></span>` +
      `<span class="value">${text}</span></span>`;
    this.guns.innerHTML = PRIMARIES.filter((id) => WEAPONS[id])
      .map((id) => {
        const gun = WEAPONS[id];
        const near = gun.bands[0];
        const rpm = Math.round(60 / (gun.fireTicks * tick));
        const falls = gun.bands.length > 1 ? `${gun.bands[1].from} m` : 'never';
        const reach = gun.bands.length > 1 ? gun.bands[gun.bands.length - 1].from / 120 : 1;
        const picture = this.gunPictures.get(`${id}:${gun.optics[0]}`);
        return (
          `<button class="gun${id === this.loadout.primary ? ' on' : ''}" type="button" data-gun="${id}">` +
          (picture ? `<img class="art" alt="" src="${picture}">` : '<span class="art"></span>') +
          `<span class="name">${escapeHtml(gun.name)}</span>` +
          `<span class="blurb">${escapeHtml(GUN_BLURB[id] ?? '')}</span>` +
          '<span class="stats">' +
          bar('Damage', near.body / 80, `${near.body} body · ${near.head} head`) +
          bar('Rate', rpm / 800, gun.automatic ? `${rpm}/min` : gun.fireTicks > 40 ? 'bolt' : 'semi') +
          bar('Range', reach, `falls off ${falls}`) +
          bar('Magazine', gun.magazine / 100, `${gun.magazine} rounds`) +
          '</span>' +
          `</button>`
        );
      })
      .join('');
    const gun = WEAPONS[this.loadout.primary];
    this.optics.innerHTML = (gun?.optics ?? [])
      .map((optic) => {
        const power = OPTICS[optic];
        const note = optic === 'red_dot' ? 'fast, wide view' : `${power}x magnification`;
        return (
          `<button class="optic${optic === this.loadout.optic ? ' on' : ''}" type="button" data-optic="${optic}">` +
          `<b>${OPTIC_NAMES[optic] ?? optic}</b><span>${note}</span></button>`
        );
      })
      .join('');
  }

  /**
   * What the play button does: join the line for the map and the stake
   * chosen.
   *
   * Queueing is free - the entry fee is taken when a match actually forms -
   * so this is safe to wire directly to a button somebody can press twice.
   */
  bindPlay(onQueue, onLeaveQueue) {
    this.play.addEventListener('click', () => {
      if (this.chosenMap && this.chosenStake) onQueue(this.chosenMap, this.chosenStake, { ...this.loadout });
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

  /** The name this player plays under, as the server has it, for the top
   *  bar. */
  setName(name) {
    const shown = (name ?? '').trim() || 'player';
    this.meName.textContent = shown;
    this.meAvatar.textContent = [...shown][0].toUpperCase();
  }

  /** Who this player is, and the link that invites people, for the
   *  profile pane. */
  setPlayer(playerId, inviteCode = null) {
    this.root.querySelector('#account-id').textContent = playerId ?? '';
    const link = this.root.querySelector('#invite-link');
    if (link) link.textContent = inviteCode ? `${window.location.origin}/?ref=${inviteCode}` : 'none yet';
  }

  /**
   * Signing in with a Solana wallet, and paying in from one.
   *
   * The wallets are whatever this browser has, found through the Wallet
   * Standard (`solana.js`). Signing in asks the server for text to sign,
   * has the wallet sign it, and sends the signature back: the server checks
   * it and either links the wallet to this account or, when the wallet is
   * another account's, hands over a key for that account (`switchTo`). A
   * deposit is a transfer with this player's memo, built here and signed
   * and sent by the wallet; the server credits it when the chain has it,
   * exactly as it credits one sent any other way.
   */
  bindSolana({ challenge, prove, switchTo }) {
    this.solana = { wallet: null, account: null, challenge, prove, switchTo, signingIn: false };
    const q = (id) => this.root.querySelector(id);
    watchWallets((wallets) => this._drawWallets(wallets));
    q('#solana-wallets').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-wallet]');
      if (!button) return;
      const wallet = this._wallets?.[Number(button.dataset.wallet)];
      if (!wallet) return;
      try {
        this.solana.account = await connect(wallet);
        this.solana.wallet = wallet;
        q('#solana-address').textContent = this.solana.account.address;
        q('#solana-connected').classList.remove('hidden');
        q('#solana-deposit button').disabled = !canSend(wallet);
        this.say(`connected to ${wallet.name}`);
      } catch (err) {
        this.say(`the wallet did not connect: ${err?.message ?? err}`, true);
      }
    });
    q('#solana-signin').addEventListener('click', () => {
      if (!this.solana.account) return;
      this.solana.signingIn = true;
      this.say('asking the server for something to sign…');
      challenge();
    });
    q('#deposit-assets').addEventListener('click', (event) => {
      const button = event.target.closest('[data-asset]');
      if (button) this._drawAsset(button.dataset.asset);
    });
    q('#solana-deposit').addEventListener('submit', (event) => {
      event.preventDefault();
      this._depositFromWallet();
    });
  }

  /** The server's text to sign: the connected wallet signs it. */
  async walletChallenge(text) {
    const { wallet, account, prove, signingIn } = this.solana ?? {};
    if (!signingIn || !wallet || !account) return;
    this.solana.signingIn = false;
    try {
      this.say(`sign the message in ${wallet.name}`);
      const signature = await signText(wallet, account, text);
      this.say('checking the signature…');
      prove(account.address, signature);
    } catch (err) {
      this.say(`not signed: ${err?.message ?? err}`, true);
    }
  }

  /** The signature checked out. */
  walletSignedIn(message) {
    if (message.account_key) {
      // The wallet is another account's: this browser becomes it.
      this.say('signed in; switching to the account that wallet belongs to…');
      this.solana?.switchTo(message.account_key);
      return;
    }
    this.setSolana(message.public_key);
    this.say('signed in: this account is yours from any browser you sign in to with that wallet');
  }

  walletRefused(reason) {
    this.say(reason, true);
  }

  /** The wallet this account is signed in with, or null. */
  setSolana(publicKey) {
    const q = (id) => this.root.querySelector(id);
    const linked = Boolean(publicKey);
    q('#solana-status').innerHTML = linked
      ? `Signed in with <code>${escapeHtml(shortAddress(publicKey))}</code>. Sign in with that wallet on any browser and this account, and its balance, are there.`
      : 'Not signed in with a wallet yet. Sign in with one and this account is yours from any browser, rather than resting on a key kept in this one.';
    q('#profile-wallet').textContent = linked ? publicKey : 'none yet: sign in with one in the wallet pane';
  }

  _drawWallets(wallets) {
    this._wallets = wallets;
    const q = (id) => this.root.querySelector(id);
    q('#solana-none').classList.toggle('hidden', wallets.length > 0);
    q('#solana-wallets').innerHTML = '';
    wallets.forEach((wallet, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.wallet = String(i);
      button.className = 'wallet-choice';
      // A wallet's icon is a data URL it supplies; anything else is dropped
      // rather than fetched.
      if (typeof wallet.icon === 'string' && wallet.icon.startsWith('data:image/')) {
        const icon = document.createElement('img');
        icon.src = wallet.icon;
        icon.alt = '';
        button.appendChild(icon);
      }
      button.append(`connect ${wallet.name ?? 'wallet'}`);
      q('#solana-wallets').appendChild(button);
    });
  }

  async _depositFromWallet() {
    const { wallet, account } = this.solana ?? {};
    const terms = this.terms;
    if (!wallet || !account || !terms) return;
    const usdc = this.asset === 'usdc';
    const typed = this.root.querySelector('#solana-amount').value;
    const amount = usdc ? parseUsdc(typed) : parseSol(typed);
    if (amount === null || amount <= 0n) {
      this.say(`that is not an amount of ${usdc ? 'USDC' : 'SOL'}`, true);
      return;
    }
    if (!canSend(wallet)) {
      this.say(`${wallet.name} cannot send from this page; use the address and memo below`, true);
      return;
    }
    try {
      this.say('building the transfer…');
      const blockhash = await latestBlockhash();
      const transaction = usdc
        ? usdcDepositTransaction({
            payer: account.address,
            from: await usdcAccountOf(account.address),
            treasury: terms.deposit_address,
            to: terms.usdc_address,
            mint: terms.usdc_mint,
            units: amount,
            blockhash,
            memo: terms.deposit_memo,
          })
        : depositTransaction({
            payer: account.address,
            to: terms.deposit_address,
            lamports: amount,
            blockhash,
            memo: terms.deposit_memo,
          });
      this.say(`approve it in ${wallet.name}`);
      const signature = await signAndSend(wallet, account, transaction, `solana:${terms.network}`);
      const cluster = encodeURIComponent(terms.network);
      this.walletNote.innerHTML =
        `sent: it is in your balance about fifteen seconds after it is final. ` +
        `<a href="https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=${cluster}" target="_blank" rel="noopener">see it on the chain</a>`;
      this.walletNote.classList.remove('warn');
      this.root.querySelector('#solana-amount').value = '';
    } catch (err) {
      this.say(`not sent: ${err?.message ?? err}`, true);
    }
  }

  /**
   * SOL or USDC: which the Solana Pay code asks for and the wallet deposit
   * sends. USDC is credited a dollar to the dollar, SOL at the stated rate.
   */
  _drawAsset(asset) {
    const terms = this.terms;
    if (!terms) return;
    this.asset = asset === 'usdc' && terms.usdc_mint ? 'usdc' : 'sol';
    const q = (id) => this.root.querySelector(id);
    for (const button of this.root.querySelectorAll('#deposit-assets [data-asset]')) {
      button.classList.toggle('on', button.dataset.asset === this.asset);
    }
    const usdc = this.asset === 'usdc';
    q('#solana-unit').textContent = usdc ? 'USDC' : 'SOL';
    q('#solana-amount').placeholder = usdc ? '5.00' : '0.10';
    // Solana Pay: with `spl-token` the wallet sends USDC to the treasury's
    // account for it; the memo is the same either way.
    const pay =
      `solana:${terms.deposit_address}?memo=${encodeURIComponent(terms.deposit_memo)}` +
      (usdc ? `&spl-token=${terms.usdc_mint}` : '') +
      '&label=Solatel';
    q('#deposit-link').href = pay;
    q('#deposit-rate').textContent = usdc
      ? 'USDC is credited dollar for dollar.'
      : `1 SOL = ${money(terms.micro_usd_per_sol)} here. A fixed rate, not the market's.`;
    // The same request as a code for a phone's wallet to scan: it opens a
    // transfer to the treasury with the memo already filled in.
    try {
      const code = qrcode(0, 'M');
      code.addData(pay);
      code.make();
      q('#deposit-qr').innerHTML = code.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    } catch (err) {
      console.warn('no QR code:', err);
    }
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
    q('#deposit-assets').classList.toggle('hidden', !terms.usdc_mint);
    this._drawAsset(this.asset ?? 'sol');
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
          `<span class="dim">${[
            e.lamports ? `${sol(e.lamports)} SOL` : '',
            e.usdc_units ? `${money(e.usdc_units)} USDC` : '',
          ].filter(Boolean).join(' + ')}</span>${link(e.signature)}</li>`
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
    if (!PANES.includes(name)) return;
    this.pane = name;
    if (name === 'fair') this._loadProof();
    if (name === 'play' || name === 'board') this._loadBoard();
    for (const pane of PANES) {
      this.root.querySelector(`.pane[data-pane="${pane}"]`).classList.toggle('hidden', pane !== name);
    }
    for (const button of this.root.querySelectorAll('.topbar [data-pane]')) {
      button.classList.toggle('on', button.dataset.pane === name);
    }
    this.root.scrollTop = 0;
  }

  /**
   * The live feed and the leaderboard, from the server's `/board`: the lives
   * that won something, newest first, and the week's biggest winners. Every
   * amount is what the server counted; this formats them and adds nothing
   * up.
   */
  async _loadBoard(force = false) {
    const now = Date.now();
    if (!force && this._boardAt && now - this._boardAt < BOARD_STALE_MS) return;
    this._boardAt = now;
    try {
      const response = await fetch('/board', { cache: 'no-store' });
      if (!response.ok) throw new Error(`status ${response.status}`);
      this._drawBoard(await response.json());
    } catch (err) {
      this._boardAt = now - BOARD_STALE_MS + 5_000;
      const none = '<li class="dim">The board could not be read just now.</li>';
      if (!this._boardDrawn) {
        this.activity.innerHTML = none;
        this.root.querySelector('#board-leaders').innerHTML = none;
      }
      console.warn('board', err);
    }
  }

  _drawBoard(board) {
    this._boardDrawn = true;
    const win = (r) =>
      `<li><span class="mark">${ICON.coins}</span>` +
      `<b class="name">${escapeHtml(r.name)}</b> <span class="dim">won</span> <b class="won">${money(r.winnings_micro_usd)}</b> ` +
      `<span class="dim">on</span> <span class="where">${escapeHtml(r.map)}</span>` +
      `<span class="when">${ago(r.at)}</span></li>`;
    const recent = board.recent ?? [];
    const quiet = '<li class="dim">No wins yet. Be the first on the board.</li>';
    this.activity.innerHTML = recent.length ? recent.slice(0, 5).map(win).join('') : quiet;
    this.root.querySelector('#board-recent').innerHTML = recent.length ? recent.map(win).join('') : quiet;
    const leaders = board.leaders ?? [];
    this.root.querySelector('#board-leaders').innerHTML = leaders.length
      ? leaders
          .map(
            (l, i) =>
              `<li class="${i < 3 ? `top top${i + 1}` : ''}"><span class="rank">${i + 1}</span>` +
              `<b class="name">${escapeHtml(l.name)}</b>` +
              `<span class="kills">${plural(l.kills, 'kill', 'kills')} &middot; ${plural(l.lives, 'life', 'lives')}</span>` +
              `<b class="won">${money(l.winnings_micro_usd)}</b></li>`,
          )
          .join('')
      : '<li class="dim">Nobody has won anything this week yet.</li>';
    this.root.querySelector('#board-asof').textContent = board.as_of
      ? `Read ${ago(board.as_of)}. The last seven days, every table and every map.`
      : '';
  }

  /**
   * The payout record, read from the server's `/proof` and drawn as it
   * came. Every amount is the ledger's own sum; this formats them and adds
   * nothing up.
   */
  async _loadProof() {
    const now = Date.now();
    if (this._proofAt && now - this._proofAt < PROOF_STALE_MS) return;
    this._proofAt = now;
    const figures = this.root.querySelector('#proof-figures');
    try {
      const response = await fetch('/proof', { cache: 'no-store' });
      if (!response.ok) throw new Error(`status ${response.status}`);
      this._drawProof(await response.json());
    } catch (err) {
      this._proofAt = 0;
      figures.innerHTML =
        '<div class="dim">The record could not be read just now. It is the ledger itself, so it will be back when the server is.</div>';
      console.warn('proof', err);
    }
  }

  _drawProof(proof) {
    const q = (id) => this.root.querySelector(id);
    const cluster = proof.network ?? 'devnet';

    // Said before any figure, so nobody reads a test total as real money.
    const notes = [];
    if (proof.network === 'devnet') {
      notes.push('Money here moves on Solana <b>devnet</b>: test SOL, not real money.');
    }
    if (proof.dev_money) {
      notes.push('This server funds new players with development money, so most of these figures are test money too.');
    }
    q('#proof-note').innerHTML = notes.join(' ');
    q('#proof-note').classList.toggle('hidden', notes.length === 0);

    const card = (value, caption, detail) =>
      `<div class="figure"><b>${value}</b><span class="caption">${caption}</span>` +
      `<span class="detail">${detail}</span></div>`;
    const best = proof.best_life;
    q('#proof-figures').innerHTML = [
      card(
        money(proof.kill_rewards_micro_usd),
        'paid for kills',
        `${count(proof.kills_paid)} kills &middot; ${money(proof.kill_rewards_24h_micro_usd)} today`,
      ),
      card(
        money(proof.withdrawn_micro_usd),
        'withdrawn to wallets',
        `${count(proof.withdrawals)} landed on-chain`,
      ),
      card(
        money(proof.stakes_returned_micro_usd),
        'stakes handed back',
        `whole, to the ${count(proof.survivors)} alive at the whistle`,
      ),
      card(
        best ? money(best.winnings_micro_usd) : '&mdash;',
        'best single life',
        best
          ? `${count(best.kills)} kills at the ${money(best.stake_micro_usd)} table &middot; ${escapeHtml(best.map)}`
          : 'nobody has been paid yet',
      ),
      card(
        count(proof.players_24h),
        'played today',
        `${count(proof.lives_24h)} lives &middot; ${money(proof.in_play_micro_usd)} in play now`,
      ),
      card(money(proof.house_cut_micro_usd), 'the house cut', 'everything we have kept, all told'),
    ].join('');
    q('#proof-asof').textContent = proof.as_of
      ? `Summed from the ledger that pays you, ${ago(proof.as_of)}. Nothing here is estimated.`
      : '';

    const rows = (proof.recent_withdrawals ?? []).map(
      (w) =>
        `<li><b>${money(w.amount_micro_usd)}</b> <span class="dim">${sol(w.lamports)} SOL &middot; ${ago(w.at)}</span> ` +
        `<a href="https://explorer.solana.com/tx/${encodeURIComponent(w.signature)}?cluster=${encodeURIComponent(cluster)}" ` +
        'target="_blank" rel="noopener">see it on the chain</a></li>',
    );
    q('#proof-withdrawals').innerHTML = rows.length
      ? rows.join('')
      : '<li class="dim">none yet</li>';
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
    // The map with the most people on it right now, when anybody is.
    let busiest = null;
    let most = 0;
    for (const map of this.mapList) {
      const crowd = this._crowdOn(map.name);
      if (crowd > most) {
        most = crowd;
        busiest = map.name;
      }
    }
    this.maps.innerHTML = this.mapList
      .map((map) => {
        const blurb = MAP_BLURB[map.name];
        return (
          `<button class="map${map.name === this.chosenMap ? ' on' : ''}" ` +
          `type="button" data-map="${escapeHtml(map.name)}">` +
          `<span class="art" aria-hidden="true"></span>` +
          (map.name === busiest ? `<span class="badge">${ICON.star}Most popular</span>` : '') +
          `<span class="name">${escapeHtml(map.name)}</span>` +
          (blurb ? `<span class="blurb">${blurb.map(escapeHtml).join('<br>')}</span>` : '') +
          `<span class="seats">${ICON.people}${map.seats} players</span>` +
          `<span class="busy">${this._busyOn(map.name)}</span>` +
          `</button>`
        );
      })
      .join('');
    this._drawPlay();
  }

  _crowdOn(name) {
    return (this._tables ?? [])
      .filter((t) => t.map === name)
      .reduce((n, t) => n + t.waiting + t.running, 0);
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
          `<button class="table${tier.dollars === this.chosenStake ? ' on' : ''}" type="button" data-stake="${tier.dollars}">` +
          `<span class="coin">${ICON.coins}</span>` +
          `<span class="stake">$${tier.dollars}</span>` +
          `<span class="pays">${pays}</span>` +
          `<span class="busy">${waiting} waiting · ${running} playing</span>` +
          `</button>`
        );
      })
      .join('');
    this._drawPlay();
  }

  /** The play button says exactly what it will do. */
  _drawPlay(queued = this._queued) {
    const ready = Boolean(this.chosenMap && this.chosenStake);
    const label = queued
      ? 'In line&hellip;'
      : ready
        ? `Play <span>$${this.chosenStake} &middot; ${escapeHtml(this.chosenMap)}</span>`
        : 'Play';
    if (label !== this._playLabel) {
      this._playLabel = label;
      this.play.innerHTML = label;
    }
    const gun = WEAPONS[this.loadout.primary];
    const carrying = gun
      ? `${gun.name} with ${this.loadout.optic === 'red_dot' ? 'a red dot' : `a ${OPTIC_NAMES[this.loadout.optic]} scope`}, and a pistol.`
      : '';
    if (this.carrying && this.carrying.textContent !== carrying) this.carrying.textContent = carrying;
    this.play.disabled = !ready || Boolean(queued);
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
    } else {
      status = '';
    }
    if (status !== this._status) {
      this._status = status;
      this.status.innerHTML = status;
      const here = this.status.querySelector('#play-here');
      if (here) here.addEventListener('click', () => window.location.reload());
    }

    // Under the name in the top bar: where this player is.
    const queued = local.queuedFor !== null && local.queuedFor !== undefined;
    const line = link?.parked
      ? 'in another tab'
      : queued
        ? `in line · ${local.queuedMap ?? ''} $${local.queuedFor}`
        : 'in the lobby';
    if (line !== this._line) {
      this._line = line;
      this.meLine.textContent = line;
    }
    if (queued !== this._queued) {
      this._queued = queued;
      this._drawPlay(queued);
    }
    if ((this.pane ?? 'play') === 'play' || this.pane === 'board') this._loadBoard();
  }
}

/**
 * The menu's icons: line drawings on a 24-unit square in the text's own
 * colour, small enough to keep in the page rather than as files.
 */
const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><circle cx="12" cy="12" r="1.2" class="dot"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h14.5a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6.5A1.5 1.5 0 0 1 5 5h11"/><path d="M15 12h5v4h-5a2 2 0 0 1 0-4z"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3M12 14v4M8 20h8"/></svg>',
  person: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 2.8h3.4l.5 2.4 1.7.7 2-1.4 2.4 2.4-1.4 2 .7 1.7 2.4.5v3.4l-2.4.5-.7 1.7 1.4 2-2.4 2.4-2-1.4-1.7.7-.5 2.4h-3.4l-.5-2.4-1.7-.7-2 1.4-2.4-2.4 1.4-2-.7-1.7-2.4-.5v-3.4l2.4-.5.7-1.7-1.4-2 2.4-2.4 2 1.4 1.7-.7z"/><circle cx="12" cy="12" r="3.2"/></svg>',
  gift: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h16v10H4zM3 7h18v3H3zM12 7v13"/><path d="M12 7c-1.5-3-5-3.5-5-1.2C7 7 9.5 7 12 7c2.5 0 5 0 5-1.2C17 3.5 13.5 4 12 7z"/></svg>',
  bars: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20v-5M10 20v-9M15 20V7M20 20V4"/></svg>',
  people: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.5" r="3.2"/><path d="M3 19a6 6 0 0 1 12 0"/><circle cx="16.5" cy="9.5" r="2.6"/><path d="M15.5 14.2A5 5 0 0 1 21 19"/></svg>',
  coins: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6.5" rx="7" ry="2.8"/><path d="M5 6.5v4c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-4M5 10.5v4c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-4M5 14.5v3c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-3"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8L3.6 9.6l5.8-.8z"/></svg>',
};

const TEMPLATE = `
  <header class="topbar">
    <div class="bar">
      <button type="button" class="brand" data-pane="play" title="play">
        <img src="${asset('assets/menu/logo.svg')}" alt="Solatel" width="190" height="30" />
        <span class="motto"><i></i>Play <b>Kill</b> Earn<i></i></span>
      </button>
      <nav id="menu-tabs" aria-label="menu">
        <button type="button" data-pane="play" class="on">${ICON.play}<span>Play</span></button>
        <button type="button" data-pane="wallet">${ICON.wallet}<span>Deposit</span></button>
        <button type="button" data-pane="board">${ICON.trophy}<span>Leaderboard</span></button>
        <button type="button" data-pane="profile">${ICON.person}<span>Profile</span></button>
        <button type="button" data-pane="fair">${ICON.shield}<span>Fair play</span></button>
        <button type="button" data-pane="settings" class="gear" title="settings" aria-label="settings">${ICON.gear}</button>
      </nav>
      <div class="me">
        <span class="avatar" id="me-avatar" aria-hidden="true"></span>
        <span class="who"><b id="me-name"></b><span id="me-line">in the lobby</span></span>
      </div>
      <button type="button" id="purse" data-pane="wallet" title="your wallet">
        ${ICON.wallet}<span class="amount">—</span><span class="plus" aria-hidden="true">+</span>
      </button>
    </div>
  </header>
  <div id="menu-status"></div>

  <div class="menu-shell">
    <section class="pane" data-pane="play">
      <div id="menu-result" class="hidden"></div>
      <div class="hero">
        <h1>Choose your battle</h1>
        <p>Select a map. Pick your entry. Get in the game.</p>
      </div>

      <div id="menu-maps"></div>

      <section class="arms">
        <h2>Choose your weapon</h2>
        <p class="sub">What your stake buys a life with. Everybody carries a pistol as well: <kbd>Q</kbd> or the wheel to swap.</p>
        <div id="menu-guns"></div>
        <div id="menu-optics"></div>
      </section>

      <div class="play-row">
        <div class="fees">
          <h2>Select entry fee</h2>
          <p class="sub">Choose how much you want to play with. Every kill pays its table's reward into your wallet at once.</p>
          <div id="menu-tables"></div>
          <div class="go">
            <button type="button" id="menu-play" disabled>Play</button>
            <p class="fine"><span id="menu-carrying"></span> Nothing is charged until your match forms. One stake buys one life.</p>
          </div>
        </div>
        <aside class="side">
          <button type="button" class="deposit" data-pane="wallet">${ICON.wallet}<span>Deposit</span><i>&rsaquo;</i></button>
          <p class="sub">Add funds to your wallet and start playing.</p>
          <div class="links">
            <button type="button" data-pane="board">${ICON.trophy}<span>Leaderboard</span><i>&rsaquo;</i></button>
            <button type="button" data-pane="fair">${ICON.shield}<span>Fair play &amp; payouts</span><i>&rsaquo;</i></button>
            <button type="button" data-pane="profile">${ICON.gift}<span>Invite a friend</span><i>&rsaquo;</i></button>
          </div>
        </aside>
      </div>

      <div class="lower-row">
        <div class="slogan"><span>Skill wins.</span><span>Strategy pays.</span><b>Play. Kill. Earn.</b></div>
        <section class="activity">
          <h3>${ICON.bars}Live activity</h3>
          <ul id="menu-activity" class="feed"><li class="dim">reading the latest wins&hellip;</li></ul>
        </section>
      </div>

      <h2 class="section">How it works</h2>
      <div class="rules">
        <div><b>one life</b><span>Your stake buys one life in one match. No respawn.</span></div>
        <div><b>paid per kill</b><span>Every kill pays the table's reward into your wallet at once.</span></div>
        <div><b>survive, get it back</b><span>Alive at the whistle, your whole stake comes back.</span></div>
        <div><b>killed</b><span>Your stake pays whoever killed you, less a 10% house cut.</span></div>
      </div>

      <h2 class="section">Controls</h2>
      <div class="keys">
        <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move</span>
        <span><kbd>mouse</kbd> look</span>
        <span><kbd>left click</kbd> shoot</span>
        <span><kbd>right click</kbd> aim</span>
        <span><kbd>space</kbd> jump</span>
        <span><kbd>C</kbd> crouch</span>
        <span><kbd>R</kbd> reload</span>
        <span><kbd>Q</kbd> or <kbd>wheel</kbd> swap gun</span>
        <span><kbd>1</kbd><kbd>2</kbd> primary, pistol</span>
        <span><kbd>G</kbd> grenade</span>
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

    <section class="pane hidden" data-pane="board">
      <h2>Leaderboard</h2>
      <p class="sub">The week's biggest winners, by what their kills paid. Counted by the server as each stake settled, and shown under the name each player plays under.</p>
      <ol id="board-leaders" class="leaders"><li class="dim">reading the board&hellip;</li></ol>
      <h3 class="section">Latest wins</h3>
      <ul id="board-recent" class="feed"></ul>
      <p class="fine" id="board-asof"></p>
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

        <div class="wallet-block" id="solana-block">
          <div class="label">your solana wallet</div>
          <p class="fine" id="solana-status"></p>
          <div id="solana-wallets"></div>
          <p class="fine hidden" id="solana-none">
            No wallet found in this browser. Phantom, Solflare and Backpack all
            work here; on a phone, scan the code below with yours.
          </p>
          <div id="solana-connected" class="hidden">
            <div class="field"><span>connected</span><code id="solana-address"></code></div>
            <button type="button" id="solana-signin">sign in with this wallet</button>
            <form id="solana-deposit" class="inline">
              <span class="with-unit"><input id="solana-amount" inputmode="decimal" autocomplete="off" placeholder="0.10" /><span id="solana-unit">SOL</span></span>
              <button type="submit">deposit from this wallet</button>
            </form>
          </div>
        </div>

        <div class="wallet-block">
          <div class="label">put money in</div>
          <div id="deposit-assets" class="assets hidden">
            <button type="button" data-asset="sol" class="on">SOL</button>
            <button type="button" data-asset="usdc">USDC</button>
          </div>
          <div id="deposit-qr" class="qr" title="scan with a phone wallet"></div>
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
          <span>wallet</span><code id="profile-wallet"></code>
        </div>
        <div class="field">
          <span>invite</span><code id="invite-link"></code>
          <button type="button" data-copy="invite-link">copy</button>
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

    <section class="pane hidden" data-pane="fair">
      <div class="label">paid out, in public</div>
      <div id="proof-note" class="notice hidden"></div>
      <div id="proof-figures" class="figures"><div class="dim">reading the ledger&hellip;</div></div>
      <p class="fine" id="proof-asof"></p>

      <div class="wallet-block">
        <div class="label">landed on-chain</div>
        <ul id="proof-withdrawals" class="plain"><li class="dim">none yet</li></ul>
        <p class="fine">
          The latest withdrawals to land, each with its transaction. Follow one
          and the chain shows it to you, with no need to take our word for it.
        </p>
      </div>

      <div class="label">fair play</div>
      <div class="rules wide">
        <div><b>the server decides</b><span>Your game sends the keys you press
          and where you aim, and nothing else. Where everybody is, what a shot
          hit and who died are worked out on our server, the same for
          everybody. A modified game cannot report a kill.</span></div>
        <div><b>money is booked twice</b><span>Every cent moves through a
          double-entry ledger that the database refuses to let fall out of
          balance. Nothing in it is ever edited; a correction is a new entry
          with a reason.</span></div>
        <div><b>aim is watched</b><span>Accuracy, headshots and flicks over
          your last twenty lives are held against lines no human aim reaches.
          Crossing one holds your withdrawals until a person has looked. It
          never takes your balance or stops you playing.</span></div>
        <div><b>no second life</b><span>One stake buys one life. Nobody can
          pay their way back into a match they are losing.</span></div>
      </div>

      <div class="label">what is not done yet</div>
      <ul class="plain honest">
        <li>Solatel is new and small. Tables fill fastest at the play times we announce.</li>
        <li>Without a Solana wallet, your account is a key this browser keeps,
          and losing it loses the balance. Sign in with a wallet in the wallet
          pane and the account is yours from any browser.</li>
        <li>The anti-cheat is statistics and a person, not a program on your
          machine. It will not catch everybody on day one, and we would rather
          say so than pretend.</li>
      </ul>

      <div class="label">credits</div>
      <ul class="plain credits">
        <li>The arena is based on
          <a href="https://sketchfab.com/3d-models/lowpoly-fps-tdm-game-map-by-resoforge-d41a19f699ea421a9aa32b407cb7537b" target="_blank" rel="noopener">"LOWPOLY | FPS | TDM | GAME | MAP by ResoForge"</a>
          by <a href="https://sketchfab.com/aslbekburonbey" target="_blank" rel="noopener">Space_One</a>,
          licensed under <a href="http://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC-BY-4.0</a>.
          Changed by Solatel: repainted, two walls taken down, and extended with
          buildings, stairs and walls of our own.</li>
        <li>The yard, and the vehicles and props dressing the facility, are from
          a low-poly map pack by ResoForge, repainted by Solatel.</li>
        <li>Soldier and animations from <a href="https://www.mixamo.com" target="_blank" rel="noopener">Adobe Mixamo</a>.</li>
        <li>The AK-47, MP5, M700 and M1911 from Stein Games'
          <a href="https://stein-indie.itch.io/classic-weapons-pack" target="_blank" rel="noopener">Free Classic Weapons Pack</a>,
          and the rifle scope from 3DModelsCC0's
          <a href="https://3dmodelscc0.itch.io/free-cc0-guns-explosives-pack" target="_blank" rel="noopener">Guns &amp; Explosives pack</a>
          (both CC0). The RPK is Solatel's, made from the AK-47.</li>
        <li>Lettering in <a href="https://github.com/jpt/barlow" target="_blank" rel="noopener">Barlow</a> and
          <a href="https://github.com/Omnibus-Type/Saira" target="_blank" rel="noopener">Saira Condensed</a>; the
          wordmark is drawn from <a href="https://github.com/theleagueof/orbitron" target="_blank" rel="noopener">Orbitron</a>
          (all <a href="https://openfontlicense.org" target="_blank" rel="noopener">SIL Open Font License</a>).</li>
        <li>Photographed surfaces, leaves, grass and sky from
          <a href="https://polyhaven.com" target="_blank" rel="noopener">Poly Haven</a> (CC0).
          Drawn with <a href="https://threejs.org" target="_blank" rel="noopener">three.js</a> (MIT).
          Payment codes by <a href="https://github.com/kazuhikoarase/qrcode-generator" target="_blank" rel="noopener">qrcode-generator</a>,
          Copyright (c) 2009 Kazuhiko Arase (MIT).</li>
        <li>The key art, the facility, the code and everything else: Solatel.</li>
      </ul>
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
          clips
          <input id="clips" type="checkbox" />
          <span id="clips-note">F8 saves the last 20 seconds as a video</span>
        </label>
        <label>
          graphics
          <select id="quality">
            <option value="auto">auto</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="ultra">ultra</option>
          </select>
          <span id="quality-note"></span>
        </label>
        <p class="fine settings-note">
          Every level shows the same world: fog, distance, trees and players
          are identical, so nobody sees more by turning it down. Lower levels
          draw fewer pixels and cheaper effects. Ultra adds ambient occlusion,
          which roughly halves the frame rate on laptop graphics.
        </p>
      </div>
    </section>

  </div>
`;
