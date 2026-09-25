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

export const LinkState = Object.freeze({
  Connecting: 'connecting',
  Handshaking: 'handshaking',
  Ready: 'ready',
  Down: 'down',
});

/** Bits in an input command's `buttons` field. Matches `sim::Buttons`. */
export const BUTTON_JUMP = 1 << 0;
export const BUTTON_FIRE = 1 << 1;

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
      });
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      this.handleServerMessage(event.data, performance.now());
    });

    socket.addEventListener('error', () => {
      this.dropLink('link error', performance.now());
    });

    socket.addEventListener('close', () => {
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
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
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

    switch (message.t) {
      case 'welcome': {
        // `MAP_VERSION` covers every map in the build, so this is checked
        // without choosing one. Which map gets played is decided per match,
        // when the player picks a table.
        if (message.map_version !== SIM.mapVersion) {
          // Predicting against different geometry from the server is worse
          // than not playing at all: it means being shot through cover that
          // only one side believes in.
          this.dropLink(
            `map mismatch: server has version ${message.map_version}, ` +
              `this client has ${SIM.mapVersion}. Reload the page.`,
            now,
          );
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
        }
        this.wallet = message.wallet ?? null;
        this.serverTickHz = message.tick_hz;
        /** Every map this server runs, with how many each seats. The menu
         *  offers these; the server forms a match on whichever is picked. */
        this.maps = message.maps ?? [];
        /** Every table it runs: a stake and what a kill pays at it. */
        this.tiers = message.tiers ?? [];
        this.note = 'in game';
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
        this.dropLink(`rejected: ${message.reason}`, now);
        if (message.reason && message.reason.startsWith(TAKEN_OVER)) {
          this.parked = true;
          this.note = 'playing in another tab';
        }
        break;
      }
      default:
        this.inbox.push(message);
    }
  }

  /** Called once per frame, before anything reads `inbox`. */
  pump(now) {
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
    return messages;
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
