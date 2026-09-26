// Many players arriving at once. Phase 6's first question: does the server
// hold up when a crowd turns up together, the way a launch or a streamer's
// link brings one?
//
//   node client/load.mjs [--players N] [--seconds S] [ws://host:port/ws]
//
// Needs a server that funds new players and does not make them wait long:
//
//   SOLATEL_DEV_GRANT=20 SOLATEL_MATCH_FLOOR=1 SOLATEL_QUEUE_WAIT=3 ./x server
//
// Every client connects in the same instant, queues for a table spread over
// every map and every stake, and once in a match runs, turns and shoots at
// random for S seconds. Measured, and judged:
//
//   * how long each waited for its Welcome, and for its match - every one of
//     them must get in;
//   * whether the lines were drained into full matches rather than dribbled
//     out, which is what the matchmaker promises;
//   * how many snapshots a second each client received - the server sends
//     twenty, and a server falling behind shows here first;
//   * whether the match clock kept pace with the wall clock - a tick loop
//     that cannot keep up runs game time slow;
//   * how quickly /health answers under all of that; and
//   * that the ledger still reconciles at the end.
//
// It speaks the protocol by hand, like `duel.mjs`: a browser per player would
// measure the machine running the test rather than the server.

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('ws')) ?? 'ws://localhost:8080/ws';
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const PLAYERS = option('--players', 80);
const SECONDS = option('--seconds', 20);
const healthUrl = url.replace(/^ws/, 'http').replace(/\/ws$/, '/health');

import { execFile } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(ok, what, detail = '') {
  results.push({ ok, what });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
}
function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
const ms = (n) => `${Math.round(n)} ms`;

class Player {
  constructor(n) {
    this.name = `Load ${n}`;
    this.seq = 0;
    this.snapshots = 0;
    this.closed = false;
  }

  connect(protocolVersion) {
    this.startedAt = performance.now();
    this.ws = new WebSocket(url);
    this.ws.addEventListener('close', () => { this.closed = true; });
    this.ws.addEventListener('message', (event) => this.receive(JSON.parse(event.data)));
    return new Promise((resolve) => {
      this.onWelcome = resolve;
      this.ws.addEventListener('open', () => this.send({
        t: 'hello',
        protocol_version: protocolVersion,
        client_build: 'load.mjs',
        name: this.name,
        resume: null,
        account: null,
      }), { once: true });
      this.ws.addEventListener('error', () => resolve(), { once: true });
    });
  }

  receive(msg) {
    switch (msg.t) {
      case 'welcome':
        this.id = msg.player_id;
        this.tiers = msg.tiers;
        this.maps = msg.maps;
        this.welcomedAt = performance.now();
        this.onWelcome?.();
        break;
      case 'match_started':
        this.matchId = msg.match_id;
        this.matchedAt = performance.now();
        break;
      case 'snapshot':
        if (msg.match_id !== this.matchId) break;
        this.snapshots += 1;
        this.remainingMs = msg.match_remaining_ms;
        this.startsInMs = msg.starts_in_ms ?? 0;
        break;
      case 'eliminated':
        this.eliminated = true;
        break;
      default:
        break;
    }
  }

  send(msg) {
    if (!this.closed && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Run, turn and shoot at random: the cost of a player to the server is
   *  their inputs, and a player standing still costs it almost nothing. */
  play() {
    this.seq += 1;
    this.yaw = (this.yaw ?? Math.random() * 6.28) + (Math.random() - 0.5) * 0.3;
    this.send({
      t: 'inputs',
      commands: [{
        seq: this.seq,
        forward: 1,
        right: Math.random() < 0.5 ? -1 : 1,
        yaw: this.yaw,
        pitch: 0,
        buttons: Math.random() < 0.3 ? 2 : 0,
      }],
    });
  }
}

const { protocol_version: protocolVersion } = await (await fetch(healthUrl)).json();
console.log(`>> ${PLAYERS} clients, all at once, on protocol ${protocolVersion}`);

// ---- arrive ------------------------------------------------------------------
const players = Array.from({ length: PLAYERS }, (_, n) => new Player(n));
await Promise.all(players.map((p) => p.connect(protocolVersion)));
const welcomed = players.filter((p) => p.welcomedAt);
const welcomeTimes = welcomed.map((p) => p.welcomedAt - p.startedAt);
check(
  welcomed.length === PLAYERS,
  'every client that arrived at once was welcomed',
  `${welcomed.length}/${PLAYERS}; p50 ${ms(percentile(welcomeTimes, 50))}, ` +
    `p95 ${ms(percentile(welcomeTimes, 95))}, max ${ms(Math.max(...welcomeTimes))}`,
);

// ---- queue, spread over every table ------------------------------------------
const tables = [];
for (const map of welcomed[0].maps ?? []) {
  for (const tier of welcomed[0].tiers ?? []) tables.push({ map: map.name, dollars: tier.dollars });
}
// Half on the cheapest arena table, the rest spread: one table has to be
// drained into several matches, and every other table has to form at all.
welcomed.forEach((p, n) => {
  const table = n % 2 === 0 ? tables[0] : tables[n % tables.length];
  p.table = table;
  p.queuedAt = performance.now();
  p.send({ t: 'queue', map: table.map, tier_dollars: table.dollars });
});

const patience = performance.now() + 120_000;
while (performance.now() < patience && welcomed.some((p) => !p.matchId)) await sleep(200);
const matched = welcomed.filter((p) => p.matchId);
const matchTimes = matched.map((p) => p.matchedAt - p.queuedAt);
check(
  matched.length === welcomed.length,
  'every one of them got into a match',
  `${matched.length}/${welcomed.length}; p50 ${ms(percentile(matchTimes, 50))}, ` +
    `p95 ${ms(percentile(matchTimes, 95))}, max ${ms(Math.max(...matchTimes))}`,
);

const matches = new Map();
for (const p of matched) {
  const key = p.matchId;
  if (!matches.has(key)) matches.set(key, { table: p.table, players: 0 });
  matches.get(key).players += 1;
}
const sizes = [...matches.values()].map((m) => `${m.table.map} $${m.table.dollars}: ${m.players}`);
console.log(`>> ${matches.size} matches - ${sizes.join(', ')}`);
const busiest = matched.filter((p) => p.table === tables[0]).length;
const seats = (welcomed[0].maps ?? []).find((m) => m.name === tables[0].map)?.seats ?? 20;
const expected = Math.ceil(busiest / seats);
const busiestMatches = [...matches.values()].filter((m) => m.table === tables[0]).length;
check(
  busiestMatches === expected,
  'the busiest line was drained into full tables, not dribbled out',
  `${busiest} players in ${busiestMatches} matches, ${expected} needed`,
);

// ---- wait out the warm-up -------------------------------------------------------
// Everybody is held on their spawn and the match clock stands still until it
// ends, so the clock check below would fail against a match that had not
// started yet.
const warmupUntil = performance.now() + 60_000;
while (performance.now() < warmupUntil && matched.some((p) => (p.startsInMs ?? 1) > 0)) {
  await sleep(200);
}

// ---- play --------------------------------------------------------------------
for (const p of matched) {
  p.snapshots = 0;
  p.clockBefore = p.remainingMs;
}
const wallBefore = performance.now();
const healthTimes = [];
const until = performance.now() + SECONDS * 1000;
let lastHealth = 0;
while (performance.now() < until) {
  for (const p of matched) if (!p.eliminated) p.play();
  if (performance.now() - lastHealth > 1000) {
    lastHealth = performance.now();
    // Timed by curl in its own process: this one is driving every socket,
    // and a stopwatch in it would be timing its own event loop.
    execFile('curl', ['-s', '-o', '/dev/null', '-w', '%{time_total}', healthUrl], (error, out) => {
      if (!error) healthTimes.push(Number(out) * 1000);
    });
  }
  await sleep(1000 / 32);
}
const wall = (performance.now() - wallBefore) / 1000;
// On the clock of somebody still in a match: a player who was killed stops
// hearing about theirs, and their clock would look stopped.
const alive = matched.filter((p) => !p.eliminated && !p.closed);
const games = alive.map((p) => (p.clockBefore - p.remainingMs) / 1000);
const game = percentile(games, 5);
const rates = alive.map((p) => p.snapshots / wall);
check(
  percentile(rates, 5) >= 17,
  'snapshots kept coming at the rate the server promises',
  `per client: p5 ${percentile(rates, 5).toFixed(1)}/s, p50 ${percentile(rates, 50).toFixed(1)}/s of 20`,
);
check(
  game >= wall * 0.95,
  'every match clock kept pace with the wall clock',
  `slowest ${game.toFixed(1)} s of game in ${wall.toFixed(1)} s`,
);
check(
  percentile(healthTimes, 95) < 500,
  '/health stayed quick under load',
  `p50 ${ms(percentile(healthTimes, 50))}, p95 ${ms(percentile(healthTimes, 95))}`,
);
const dead = matched.filter((p) => p.eliminated).length;
console.log(`>> ${dead} of ${matched.length} were killed while it ran`);

// ---- leave -------------------------------------------------------------------
for (const p of players) p.ws.close();
await sleep(2000);
const health = await (await fetch(healthUrl)).json();
check(health.status === 'ok' && health.ledger_reconciles, 'the ledger still reconciles afterwards');

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nFAILED ${failed.length} of ${results.length}` : `\nOK   all ${results.length} checks held`);
process.exit(failed.length ? 1 : 0);
