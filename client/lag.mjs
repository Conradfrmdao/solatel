// How the game holds up on a bad connection, measured rather than guessed.
//
//   node client/lag.mjs [--seconds 40] [--latency 30] [--jitter 5]
//        [--stall-every 0] [--stall-ms 250] [--fps 60] [--hitch-every 0]
//        [--hitch-ms 50] [--map facility] [--seed 1] [--json]
//        [--dump file.json] [ws://localhost:8082/ws]
//
// Two clients join one match through a proxy, in this process, that holds
// every byte for a one-way latency plus jitter and lets them out in order -
// the way TCP delivers - and every `--stall-every` seconds or so holds
// everything for `--stall-ms` more, the way one lost packet holds up all
// that follows it until it is sent again. One client runs, swerves, turns
// and jumps on a frame clock and predicts itself with the real simulation,
// the way the browser does: a command a tick, the last three in every
// message, and every snapshot adopted with the unacknowledged commands
// replayed over it. The other watches.
//
// Reported:
//  - corrections: how often and how far the runner's prediction was wrong
//    when a snapshot came back. Each is a jump in their view, or a glide
//    now that the client smooths them;
//  - input lag: from a command leaving to a snapshot saying it ran;
//  - what the watcher sees: which moment of the server's game it draws the
//    runner at, every frame, the way remotes.js draws everybody else - timed
//    by when each snapshot arrived (as it was) and by the server's clock (as
//    it is). Drawn smoothly, that moment moves on exactly as fast as the
//    watcher's own clock; every wobble in it is the runner speeding up and
//    slowing down on screen when they did not, and every frame it stands
//    still is the runner frozen. Judged on the clock and not on positions,
//    because the path itself has corners and slides along walls that both
//    ways draw alike.
//
// It wants a free-play server that starts a line of one at once:
//   SOLATEL_FREE_PLAY=1 SOLATEL_MATCH_FLOOR=1 SOLATEL_QUEUE_WAIT=2
//   SOLATEL_WARMUP=0
// and two runs, against two servers, are how a change is judged.

import { readFile } from 'node:fs/promises';
import net from 'node:net';
import init, { Predictor, constant_names, constants, select_map } from './generated/solatel_sim.js';
import { SnapshotClock } from './src/snapclock.js';

await init({ module_or_path: await readFile(new URL('./generated/solatel_sim_bg.wasm', import.meta.url)) });
const SIM = Object.fromEntries(constant_names().map((name, i) => [name, constants()[i]]));

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const url = new URL(args.find((a) => a.startsWith('ws')) ?? 'ws://localhost:8082/ws');
const seconds = option('seconds', 40);
const link = {
  latency: option('latency', 30),
  jitter: option('jitter', 5),
  stallEvery: option('stall-every', 0),
  stallMs: option('stall-ms', 250),
};
const fps = option('fps', 60);
const hitchEvery = option('hitch-every', 0);
const hitchMs = option('hitch-ms', 50);
const seed = option('seed', 1);
const mapArg = args.indexOf('--map') >= 0 ? args[args.indexOf('--map') + 1] : 'facility';
const json = args.includes('--json');

const TICK_MS = 1000 / SIM.tickHz;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(why) {
  console.error(`FAIL  ${why}`);
  process.exit(1);
}

/** A small seeded generator, so two runs meet the same weather. */
function random(state) {
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One direction of one connection: bytes out in order, each held for the
 *  latency and some jitter, and now and then everything held for a stall. */
class Lane {
  constructor(to, rng) {
    this.to = to;
    this.rng = rng;
    this.queue = [];
    this.last = 0;
    this.timer = null;
    this.nextStall = link.stallEvery > 0 ? performance.now() + this.exp(link.stallEvery * 1000) : Infinity;
  }

  exp(mean) {
    return -Math.log(1 - this.rng()) * mean;
  }

  push(chunk) {
    const now = performance.now();
    let delay = link.latency + (link.jitter > 0 ? this.exp(link.jitter) : 0);
    if (now >= this.nextStall) {
      delay += link.stallMs;
      this.nextStall = now + this.exp(link.stallEvery * 1000);
    }
    const at = Math.max(this.last, now + delay);
    this.last = at;
    this.queue.push([at, chunk]);
    this.schedule();
  }

  schedule() {
    if (this.timer || this.queue.length === 0) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        const now = performance.now();
        while (this.queue.length > 0 && this.queue[0][0] <= now + 0.5) {
          const [, chunk] = this.queue.shift();
          if (!this.to.destroyed) this.to.write(chunk);
        }
        this.schedule();
      },
      Math.max(0, this.queue[0][0] - performance.now()),
    );
  }
}

let laneSeed = seed * 1000;
const proxy = net.createServer((client) => {
  client.setNoDelay(true);
  const upstream = net.connect(Number(url.port || 80), url.hostname);
  upstream.setNoDelay(true);
  const up = new Lane(upstream, random((laneSeed += 1)));
  const down = new Lane(client, random((laneSeed += 1)));
  client.on('data', (chunk) => up.push(chunk));
  upstream.on('data', (chunk) => down.push(chunk));
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  for (const end of [client, upstream]) {
    end.on('close', close);
    end.on('error', close);
  }
});
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const through = `ws://127.0.0.1:${proxy.address().port}${url.pathname}`;

class Client {
  constructor(name) {
    this.name = name;
    this.id = null;
    this.matchId = null;
  }

  async connect(protocolVersion) {
    this.ws = new WebSocket(through);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error(`${this.name}: cannot connect`)), {
        once: true,
      });
    });
    this.ws.addEventListener('message', (event) => this.receive(JSON.parse(event.data)));
    const welcome = new Promise((resolve, reject) => {
      this.onWelcome = resolve;
      setTimeout(() => reject(new Error(`${this.name}: no welcome`)), 15000);
    });
    this.send({ t: 'hello', protocol_version: protocolVersion, client_build: 'lag.mjs', name: this.name, resume: null });
    return welcome;
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  receive(msg) {
    switch (msg.t) {
      case 'welcome':
        this.id = msg.player_id;
        this.tiers = msg.tiers ?? [];
        this.maps = msg.maps ?? [];
        this.onWelcome?.(msg);
        break;
      case 'rejected':
        fail(`${this.name} was rejected: ${msg.reason}`);
        break;
      case 'match_started':
        this.matchId = msg.match_id;
        // No map to load: ready for the countdown at once.
        this.send({ t: 'loaded', match_id: msg.match_id });
        break;
      case 'snapshot':
        if (msg.match_id === this.matchId) {
          this.live = (msg.starts_in_ms ?? 0) === 0;
          this.snapshot(msg);
        }
        break;
      default:
        break;
    }
  }

  snapshot() {}
}

/** The player whose connection is under test. */
class Runner extends Client {
  constructor() {
    super('Runner');
    this.sim = new Predictor();
    this.seq = 0;
    this.unacked = [];
    this.sentAt = new Map();
    this.current = null;
    this.corrections = [];
    this.lags = [];
    /** Every correction over a centimetre, with when and against what. */
    this.log = [];
    /** [when, seq, how long its acknowledgement took], for --dump. */
    this.lagLog = [];
    this.running = false;
    this.t = 0;
  }

  snapshot(snap) {
    const mine = snap.players.find((p) => p.id === this.id);
    if (!mine) return;
    const now = performance.now();
    const ack = snap.ack_input_seq;
    for (const [seq, at] of this.sentAt) {
      if (seq > ack) break;
      if (this.running) {
        this.lags.push(now - at);
        this.lagLog.push([now, seq, now - at]);
      }
      this.sentAt.delete(seq);
    }
    const before = this.current;
    this.unacked = this.unacked.filter((c) => c.seq > ack);
    const s = mine.state;
    if (this.yaw0 === undefined) this.yaw0 = s.yaw;
    this.sim.adopt(
      s.position[0], s.position[1], s.position[2],
      s.velocity[0], s.velocity[1], s.velocity[2],
      s.yaw, s.pitch, s.on_ground, s.health, Boolean(s.crouched),
    );
    for (const c of this.unacked) this.sim.step(c.forward, c.right, c.yaw, c.pitch, c.buttons);
    this.current = { x: this.sim.x, y: this.sim.y, z: this.sim.z };
    if (before && this.running) {
      const size = Math.hypot(this.current.x - before.x, this.current.y - before.y, this.current.z - before.z);
      this.corrections.push(size);
      if (size > 0.01) this.log.push({ now, size, ack, sent: this.seq, server: snap.server_time_ms });
    }
  }

  /** One tick: what a player swerving across open ground would press. */
  tick() {
    this.t += TICK_MS / 1000;
    const t = this.t;
    const command = {
      seq: (this.seq += 1),
      forward: 1,
      right: Math.sin((t * Math.PI * 2) / 1.3) > 0 ? 0.8 : -0.8,
      yaw: this.yaw0 + 0.9 * Math.sin((t * Math.PI * 2) / 5),
      pitch: 0,
      buttons: t % 2.7 < TICK_MS / 1000 ? 1 : 0,
    };
    this.sim.step(command.forward, command.right, command.yaw, command.pitch, command.buttons);
    this.current = { x: this.sim.x, y: this.sim.y, z: this.sim.z };
    this.unacked.push(command);
    if (this.unacked.length > 128) this.unacked.shift();
    this.sentAt.set(command.seq, performance.now());
    this.send({ t: 'inputs', commands: this.unacked.slice(-3) });
  }
}

/** Somebody else in the match, drawing the runner. */
class Watcher extends Client {
  constructor() {
    super('Watcher');
    /** [page time it arrived, server time], as received. */
    this.snaps = [];
    this.clock = new SnapshotClock(SIM.interpolationDelayMs);
    /** Per drawn frame: page time, and the server time drawn each way. */
    this.frames = [];
  }

  snapshot(snap) {
    const now = performance.now();
    this.snaps.push([now, snap.server_time_ms]);
    this.clock.note(snap.server_time_ms, now);
  }

  /** One drawn frame, both ways. */
  frame(now, dtMs) {
    if (this.snaps.length < 2) return;
    const newest = this.snaps[this.snaps.length - 1][1];
    const oldest = this.snaps[0][1];
    // As remotes.js was: between the snapshots that arrived either side of
    // a moment a fixed delay ago.
    const at = now - SIM.interpolationDelayMs;
    let arrival = newest;
    for (let i = this.snaps.length - 1; i >= 0; i -= 1) {
      const [came, server] = this.snaps[i];
      if (came <= at) {
        const next = this.snaps[i + 1];
        if (next) {
          const f = Math.min(1, Math.max(0, (at - came) / Math.max(next[0] - came, 1e-6)));
          arrival = server + (next[1] - server) * f;
        } else {
          arrival = server;
        }
        break;
      }
      if (i === 0) arrival = oldest;
    }
    // As it is: the server's own clock, put on this one.
    const drawn = this.clock.drawAt(now, dtMs);
    const server = Math.min(newest, Math.max(oldest, drawn));
    this.frames.push({ now, arrival, server });
  }
}

// ---------------------------------------------------------------------------

const health = await fetch(`${url.protocol === 'wss:' ? 'https' : 'http'}://${url.host}/health`);
const { protocol_version: protocolVersion } = await health.json();
const runner = new Runner();
const watcher = new Watcher();
await runner.connect(protocolVersion);
await watcher.connect(protocolVersion);

const map = (runner.maps ?? []).find((m) => m.name === mapArg)?.name ?? runner.maps?.[0]?.name;
if (!map) fail('the server named no maps');
if (!select_map(map)) fail(`this build has no map called ${map}`);
const table = (runner.tiers ?? []).slice().sort((a, b) => a.dollars - b.dollars)[0];
if (!table) fail('the server named no tables');
for (const client of [runner, watcher]) client.send({ t: 'queue', map, tier_dollars: table.dollars });

const patience = Date.now() + 60000;
while (Date.now() < patience && !(runner.live && watcher.live && runner.matchId === watcher.matchId)) {
  await sleep(50);
}
if (!runner.live) fail('never got into a live match - is the warm-up zero and the floor one?');
if (runner.matchId !== watcher.matchId) fail('the two clients were put in different matches');

// The frame clock: drift-free, with a hitch now and then.
const rng = random(seed);
const frameMs = 1000 / fps;
let last = performance.now();
let next = last + frameMs;
let accumulator = 0;
let nextHitch = hitchEvery > 0 ? last + -Math.log(1 - rng()) * hitchEvery * 1000 : Infinity;
const started = last;
runner.running = true;
await new Promise((resolve) => {
  function frame() {
    // As main.js does it.
    const now = performance.now();
    const dt = Math.min(now - last, 250);
    last = now;
    accumulator += dt;
    let ticks = 0;
    while (accumulator >= TICK_MS && ticks < 5) {
      runner.tick();
      accumulator -= TICK_MS;
      ticks += 1;
    }
    if (accumulator > TICK_MS * 20) accumulator = 0;
    watcher.frame(now, dt);
    if (now - started > seconds * 1000) return resolve();
    next += frameMs;
    if (now >= nextHitch) {
      next += hitchMs;
      nextHitch = now + -Math.log(1 - rng()) * hitchEvery * 1000;
    }
    setTimeout(frame, Math.max(0, next - performance.now()));
  }
  frame();
});
runner.running = false;
runner.ws.close();
watcher.ws.close();
proxy.close();

// ---------------------------------------------------------------------------

const quantile = (values, q) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const rms = (values) => Math.sqrt(values.reduce((s, v) => s + v * v, 0) / Math.max(1, values.length));

const real = runner.corrections.filter((c) => c > 0.01);
const minutes = seconds / 60;

/** How steadily one way of drawing moves through the server's game: how
 *  far behind the server it draws, how far the moment it draws strays from
 *  a steady march (in milliseconds, which at a run is eight millimetres
 *  each), and how many frames it does not move at all. */
function judge(key) {
  const frames = watcher.frames.slice(fps); // the first second settles
  const offset = Math.min(...watcher.snaps.map(([came, server]) => came - server));
  const behind = frames.map((f) => f.now - offset - f[key]);
  const mean = behind.reduce((s, v) => s + v, 0) / Math.max(1, behind.length);
  // Against a straight line rather than a constant: a server's ticks keep
  // their own time, and a little slower than the wall's is not a wobble.
  const t0 = frames[0]?.now ?? 0;
  const xs = frames.map((f) => f.now - t0);
  const mx = xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i += 1) {
    sxy += (xs[i] - mx) * (behind[i] - mean);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const strays = behind.map((b, i) => b - (mean + slope * (xs[i] - mx)));
  const stray = rms(strays);
  let frozen = 0;
  const rate = [];
  for (let i = 1; i < frames.length; i += 1) {
    const dt = frames[i].now - frames[i - 1].now;
    const moved = frames[i][key] - frames[i - 1][key];
    if (moved <= 0) frozen += 1;
    if (dt > 0) rate.push(moved / dt - 1);
  }
  return {
    behindMs: mean,
    strayMs: stray,
    worstMs: Math.max(...strays.map(Math.abs)),
    frozenPerMinute: frozen / minutes,
    wobble: rms(rate),
  };
}
const byArrival = judge('arrival');
const byServer = judge('server');

const report = {
  link: { ...link, fps, hitchEvery, hitchMs, seconds, map },
  corrections: {
    perMinute: real.length / minutes,
    meanCm: real.length ? (real.reduce((s, c) => s + c, 0) / real.length) * 100 : 0,
    maxCm: (Math.max(0, ...runner.corrections) || 0) * 100,
    totalM: real.reduce((s, c) => s + c, 0),
  },
  inputLagMs: { median: quantile(runner.lags, 0.5), p95: quantile(runner.lags, 0.95) },
  watcher: { byArrival, byServer },
};

const dump = args.indexOf('--dump') >= 0 ? args[args.indexOf('--dump') + 1] : null;
if (dump) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    dump,
    JSON.stringify({ report, snaps: watcher.snaps, frames: watcher.frames, corrections: runner.log, lags: runner.lagLog }),
  );
}
if (json) {
  console.log(JSON.stringify(report));
} else {
  const f = (v, d = 1) => v.toFixed(d);
  console.log(
    `link: ${link.latency} ms each way, ${link.jitter} ms jitter` +
      (link.stallEvery ? `, a ${link.stallMs} ms stall every ~${link.stallEvery} s` : '') +
      `; ${fps} fps` +
      (hitchEvery ? ` with a ${hitchMs} ms hitch every ~${hitchEvery} s` : '') +
      `; ${seconds} s on ${map}`,
  );
  console.log(
    `runner: ${f(report.corrections.perMinute)} corrections a minute over 1 cm, ` +
      `${f(report.corrections.meanCm)} cm on average, ${f(report.corrections.maxCm)} cm at most`,
  );
  console.log(`runner: input lag ${f(report.inputLagMs.median, 0)} ms median, ${f(report.inputLagMs.p95, 0)} ms p95`);
  for (const [name, j] of [['by arrival', byArrival], ['by server clock', byServer]]) {
    console.log(
      `watcher, timed ${name}: ${f(j.behindMs, 0)} ms behind, strays ${f(j.strayMs)} ms ` +
        `(${f(j.worstMs, 0)} at worst), speed wobbles ${f(j.wobble * 100, 0)}%, ` +
        `${f(j.frozenPerMinute)} frozen frames a minute`,
    );
  }
}
process.exit(0);
