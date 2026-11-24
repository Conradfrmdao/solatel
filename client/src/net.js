// The link to the authoritative server.
//
// This module is the only thing that touches the socket. Everything else reads
// `inbox`, which is refilled once per frame, and calls `send`. Keeping the
// network edge in one place is what makes it possible to reason about what the
// client is allowed to say - which is: what keys are down and where it is
// looking, and nothing else. Never a position, never a hit, never a kill.
//
// Reconnection is automatic. The server restarts often during tuning and a
// client that needs a manual reload after each one makes the loop needlessly
// slow.

import { SIM } from './sim.js';

const PING_INTERVAL_MS = 1000;
const RECONNECT_DELAY_MS = 2000;

/** A ping with no reply by this age is written off, so the table stays bounded. */
const PING_TIMEOUT_MS = 10000;

/** How the server says another connection has taken this player. Matches
 *  `TAKEN_OVER` in `game.rs`. */
const TAKEN_OVER = 'this player was taken over';

// A cancellation is safe to retry, unlike a purchase or a new queue request.
// Keep it until the server confirms it, including across a mobile page restore.
const LEAVE_PENDING = 'solatel.queueLeavePending';

export const LinkState = Object.freeze({
  Connecting: 'connecting',
  Handshaking: 'handshaking',
  Ready: 'ready',
  Down: 'down',
});

/** Bits in an input command's `buttons` field. Matches `sim::Buttons`. */
export const BUTTON_JUMP = 1 << 0;
export const BUTTON_FIRE = 1 << 1;
export const BUTTON_CROUCH = 1 << 2;
export const BUTTON_RELOAD = 1 << 3;
export const BUTTON_THROW = 1 << 4;
export const BUTTON_AIM = 1 << 5;
export const BUTTON_SIDEARM = 1 << 6;
export const BUTTON_SPRINT = 1 << 7;

/** Where the resume token lives between page loads.
 *
 *  `sessionStorage`, not `localStorage`, and the difference is the whole
 *  design. Session storage is per tab and survives a reload, which is exactly
 *  the set of events a player expects to come back from. Local storage is
 *  shared by every tab on the origin, so two tabs open on the game would each
 *  present the same token and fight over one body.
 */
const RESUME_KEY = 'solatel.resume';

function readResumeToken() {
  try {
    return window.sessionStorage.getItem(RESUME_KEY) ?? null;
  } catch {
    // Private browsing, or storage disabled. A player who cannot store a
    // token simply gets a fresh spawn on reload, which is where this
    // started.
    return null;
  }
}

function writeResumeToken(token) {
  try {
    if (token) window.sessionStorage.setItem(RESUME_KEY, token);
  } catch {
    /* private browsing */
  }
}

/** Where the account key lives: who this player *is*, as against which body
 *  they were driving.
 *
 *  `localStorage`, the opposite choice from the resume token and for the
 *  opposite reason. A balance hangs off the account, and it has to survive
 *  closing the tab - which is exactly what session storage does not do. Two
 *  tabs therefore sign in as the same player, and the server hands the player
 *  to whichever connected last; the other is told, and stops reconnecting.
 */
export const ACCOUNT_KEY = 'solatel.account';

export function readAccountKey() {
  try {
    return window.localStorage.getItem(ACCOUNT_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * The invite code a link brought this browser, kept until an account is
 * made with it. Only a browser with no account yet keeps one: an existing
 * player opening somebody's link is not becoming anybody's invitee, and the
 * server would ignore it anyway.
 */
const REFERRAL_KEY = 'solatel.ref';

export function noteReferral() {
  try {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('ref');
    if (!code) return;
    if (!readAccountKey()) window.localStorage.setItem(REFERRAL_KEY, code.slice(0, 16));
    // Off the address bar, so it is not passed on by accident.
    url.searchParams.delete('ref');
    window.history.replaceState(null, '', url.toString());
  } catch {
    /* no storage: the invite is lost, which costs nobody anything */
  }
}

function readReferral() {
  try {
    return window.localStorage.getItem(REFERRAL_KEY);
  } catch {
    return null;
  }
}

function forgetReferral() {
  try {
    window.localStorage.removeItem(REFERRAL_KEY);
  } catch {
    /* nothing to forget */
  }
}

export function writeAccountKey(key) {
  try {
    if (key) window.localStorage.setItem(ACCOUNT_KEY, key);
  } catch {
    /* private browsing: the account lasts as long as the tab */
  }
}

export class Link {
  constructor(clientBuild, playerName) {
    this.clientBuild = clientBuild;
    /** What to ask to be called. The server has the final say. */
    this.playerName = playerName;
    this.url = serverUrl();
    this.state = LinkState.Down;
    this.note = 'starting';
    this.sessionId = null;
    this.playerId = null;
    this.serverTickHz = null;
    this.rttMs = null;

    /** Every map and every table this server runs, from the handshake. The
     *  menu offers these; the server decides which match anybody is in. */
    this.maps = [];
    this.tiers = [];
    /** How money gets in and out, or null when this server has no wallet. */
    this.wallet = null;
    /** True once another tab or device has taken this player. The link
     *  stays down: reconnecting would sign in as the same player and take
     *  them straight back, and the two would pass one player between them
     *  every couple of seconds. */
    this.parked = false;
    this.updateRequired = null;
    this.queueLeavePending = false;
    try { this.queueLeavePending = window.sessionStorage.getItem(LEAVE_PENDING) === '1'; } catch { /* private mode */ }
    /** Set when the account key this browser sent was not recognised and the
     *  server made a new account instead. */
    this.accountReplaced = false;

    /** Messages received since the last drain, for the frame to consume. */
    this.inbox = [];

    this.socket = null;
    this.nextPingSeq = 0;
    this.inflight = new Map();
    this.nextPingAt = 0;
    this.reconnectAt = 0;
    this.lastReceivedAt = performance.now();
    this.openedAt = this.lastReceivedAt;
    this.hiddenAt = null;
    // Mobile browsers can freeze a TCP connection without dispatching close.
    // Reconnect through the existing resume token instead of trusting OPEN.
    const resume = () => {
      if (document.hidden) {
        this.hiddenAt ??= performance.now();
        return;
      }
      if (this.hiddenAt === null) return;
      const elapsed = performance.now() - this.hiddenAt;
      this.hiddenAt = null;
      if (elapsed > 1500 && !this.parked) this.recover('resuming connection', performance.now());
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pagehide', () => { this.hiddenAt ??= performance.now(); });
    window.addEventListener('pageshow', resume);
    window.addEventListener('online', () => {
      if (!this.parked && this.state === LinkState.Down) this.reconnectAt = 0;
    });

    // Settles when the server has accepted this client and said which map is
    // being played. Boot waits on it, because until the handshake lands there
    // is no way to know which world to load - and loading the wrong one means
    // drawing an arena the server is not colliding against.
    //
    // It settles once. Later reconnections are the game's problem, not the
    // loading screen's.
    this.firstWelcome = new Promise((resolve, reject) => {
      this._settle = { resolve, reject };
    });

    this.open(performance.now());
  }

  get isReady() {
    return this.state === LinkState.Ready;
  }

  open(now) {
    this.openedAt = now;
    this.lastReceivedAt = now;
    this.sessionId = null;
    this.playerId = null;
    this.rttMs = null;
    this.inflight.clear();

    let socket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      this.dropLink(`could not open socket: ${err}`, now);
      return;
    }

    this.socket = socket;
    this.state = LinkState.Connecting;
    this.note = 'connecting';

    socket.addEventListener('open', () => {
      if (socket !== this.socket) return;
      this.state = LinkState.Handshaking;
      this.note = 'socket open, sending hello';
      this.send({
        t: 'hello',
        protocol_version: SIM.protocolVersion,
        client_build: this.clientBuild,
        // A request, not a claim. The server trims it, bounds it, and may
        // hand back something else entirely in the welcome - which is what
        // gets displayed, so the two can never disagree about what the rest
        // of the match is reading.
        name: this.playerName,
        // Whatever token we were last given, if any. The server ignores one
        // it does not recognise and hands out a new player, so sending a
        // stale token costs nothing and forgetting to send a good one costs
        // the player their position and their record.
        resume: readResumeToken(),
        // Who this is. Absent on the very first visit, and the welcome then
        // carries a new key to keep.
        account: readAccountKey(),
        // Somebody's invite, sent only by a browser that has no account yet.
        referral: readAccountKey() ? null : readReferral(),
      });
    });

    socket.addEventListener('message', (event) => {
      if (socket !== this.socket) return;
      if (typeof event.data !== 'string') return;
      this.handleServerMessage(event.data, performance.now());
    });

    socket.addEventListener('error', () => {
      if (socket !== this.socket) return;
      this.dropLink('link error', performance.now());
    });

    socket.addEventListener('close', () => {
      if (socket !== this.socket) return;
      // A close during handshaking is usually a rejection the server sent
      // immediately before hanging up, so keep whatever note we already have.
      const why = this.note.startsWith('rejected')
        ? this.note
        : 'server closed the connection';
      this.dropLink(why, performance.now());
    });
  }

  dropLink(why, now) {
    if (this.socket) {
      // Detach first: closing fires another `close`, and a reconnect loop that
      // re-enters itself schedules two sockets.
      const socket = this.socket;
      this.socket = null;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    }
    this.state = LinkState.Down;
    this.sessionId = null;
    this.playerId = null;
    this.rttMs = null;
    this.inflight.clear();
    this.note = why;
    this.reconnectAt = now + RECONNECT_DELAY_MS;
    this.settle(why, null);
  }

  /**
   * Resolves or rejects `firstWelcome`, once and once only.
   *
   * A failure before the first handshake is a failure to start - there is
   * nothing to draw and no map to draw it in - so boot hears about it. After
   * that the link reconnects on its own and a drop is just a bad minute, not a
   * reason to tear the page down.
   */
  settle(why, welcome) {
    if (!this._settle) return;
    const { resolve, reject } = this._settle;
    this._settle = null;
    if (welcome) resolve(welcome);
    else reject(new Error(why));
  }

  send(message) {
    if (message.t === 'leave_queue' || message.t === 'queue') {
      this.setQueueLeavePending(message.t === 'leave_queue');
    }
    if (message.t === 'leave_queue' && !this.isReady) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    // Never queue seconds of obsolete movement behind a stalled uplink.
    if (message.t === 'inputs' && this.socket.bufferedAmount > 64 * 1024) {
      this.recover('connection stalled', performance.now());
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  recover(why, now) {
    if (this.parked || this.updateRequired) return;
    this.inbox.length = 0;
    this.dropLink(why, now);
    this.reconnectAt = now;
  }

  setQueueLeavePending(pending) {
    this.queueLeavePending = pending;
    try { window.sessionStorage.setItem(LEAVE_PENDING, pending ? '1' : '0'); } catch { /* private mode */ }
  }

  requireUpdate(what, now) {
    if (this.updateRequired) return;
    this.updateRequired = what;
    this.dropLink('An update is ready. Reload to reconnect.', now);
    // Never navigate away from a phone match without an explicit tap.
    window.dispatchEvent(new Event('solatel:update-required'));
  }

  handleServerMessage(raw, now) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (err) {
      console.warn('undecodable message from server:', err);
      this.note = 'undecodable server message';
      return;
    }
    this.lastReceivedAt = now;

    switch (message.t) {
      case 'welcome': {
        // `MAP_VERSION` covers every map in the build, so this is checked
        // without choosing one. Which map gets played is decided per match,
        // when the player picks a table.
        if (message.map_version !== SIM.mapVersion) {
          // Predicting against different geometry from the server is worse
          // than not playing at all: it means being shot through cover that
          // only one side believes in.
          this.requireUpdate(`map ${message.map_version}`, now);
          return;
        }
        this.state = LinkState.Ready;
        this.sessionId = message.session_id;
        this.playerId = message.player_id;
        /** What the server settled on calling this player, which may not be
         *  what was asked for. Shown in the settings box so the two never
         *  disagree about what the rest of the match is reading. */
        this.assignedName = message.name ?? '';
        /** Whether this connection took an existing body back. */
        this.resumed = Boolean(message.resumed);
        // Stored before anything else is done with the welcome. This is the
        // only copy of the credential that gets the player their body back,
        // and the window to use it is measured in seconds.
        writeResumeToken(message.resume_token);
        // A key comes only with a new account. If one arrives when this
        // browser had sent one, the old key was not recognised - a database
        // reset, or a mistyped restore - and the player should hear that
        // rather than find an empty wallet and wonder.
        if (message.account_key) {
          this.accountReplaced = Boolean(readAccountKey());
          writeAccountKey(message.account_key);
          forgetReferral();
        }
        /** This player's own invite code, for the link in the profile. */
        this.inviteCode = message.invite_code ?? null;
        this.wallet = message.wallet ?? null;
        /** The Solana wallet this account is signed in with, or null. */
        this.solanaPubkey = message.solana_pubkey ?? null;
        this.serverTickHz = message.tick_hz;
        /** Every map this server runs, with how many each seats. The menu
         *  offers these; the server forms a match on whichever is picked. */
        this.maps = message.maps ?? [];
        /** Every table it runs: a stake and what a kill pays at it. */
        this.tiers = message.tiers ?? [];
        this.note = 'in game';
        if (this.queueLeavePending) this.send({ t: 'leave_queue' });
        this.inbox.push(message);
        this.settle(null, message);
        break;
      }
      case 'pong': {
        const sentAt = this.inflight.get(message.seq);
        if (sentAt !== undefined) {
          this.inflight.delete(message.seq);
          this.rttMs = now - sentAt;
        }
        break;
      }
      case 'rejected': {
        console.warn('server rejected this client:', message.reason);
        const speaks = /^protocol version mismatch: server speaks (\d+)/.exec(message.reason ?? '');
        if (speaks) { this.requireUpdate(`protocol ${speaks[1]}`, now); return; }
        // A page from another build names files the server no longer has.
        const serves = /^client build mismatch: server serves ([\w/]+)/.exec(message.reason ?? '');
        if (serves) { this.requireUpdate(`build ${serves[1]}`, now); return; }
        this.dropLink(`rejected: ${message.reason}`, now);
        if (message.reason && message.reason.startsWith(TAKEN_OVER)) {
          this.parked = true;
          this.note = 'playing in another tab';
        }
        break;
      }
      default:
        if (message.t === 'queue_leave_result') this.setQueueLeavePending(false);
        this.inbox.push(message);
    }
  }

  /** Called once per frame, before anything reads `inbox`. */
  pump(now) {
    if (document.hidden || this.updateRequired) return;
    if ((this.state === LinkState.Ready && now - this.lastReceivedAt > 6000) ||
        ((this.state === LinkState.Connecting || this.state === LinkState.Handshaking) && now - this.openedAt > 12000)) {
      this.recover('connection timed out', now);
    }
    if (this.state === LinkState.Ready && now >= this.nextPingAt) {
      const seq = this.nextPingSeq;
      this.nextPingSeq = (this.nextPingSeq + 1) >>> 0;
      this.inflight.set(seq, now);
      for (const [key, sentAt] of this.inflight) {
        if (now - sentAt >= PING_TIMEOUT_MS) this.inflight.delete(key);
      }
      this.send({ t: 'ping', seq, client_time_ms: now });
      this.nextPingAt = now + PING_INTERVAL_MS;
    } else if (this.state === LinkState.Down && !this.parked && now >= this.reconnectAt) {
      this.open(now);
    }
  }

  /** Hands over this frame's messages and clears the queue. */
  drain() {
    if (this.inbox.length === 0) return EMPTY;
    const messages = this.inbox;
    this.inbox = [];
    // A slow frame can collect many complete world states. Replaying the
    // same prediction history for every obsolete state makes the next frame
    // slow too. Keep the newest state per match, with every reliable event
    // still in its original order (hits, kills, payouts and transitions).
    const latest = new Map();
    for (let i = 0; i < messages.length; i += 1) {
      if (messages[i].t === 'snapshot') latest.set(messages[i].match_id, i);
    }
    return messages.filter((message, index) => message.t !== 'snapshot' || latest.get(message.match_id) === index);
  }
}

const EMPTY = [];

/**
 * The websocket URL, derived from the page the client was served from, so one
 * build works on localhost and in production with no configuration.
 */
function serverUrl() {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws`;
}
