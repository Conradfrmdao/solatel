// Surviving a match, and getting the stake back.
//
// The other half of `duel.mjs`. That one proves a kill takes a stake out of
// escrow; this proves the stake of somebody nobody killed comes back to them
// instead. It is the only path in the economy that pays a player money for
// doing nothing, so it is the one worth watching go past on a real wire and
// not only in a unit test.
//
//   node client/survive.mjs [--players N] [ws://host:port/ws]
//
// It connects more than one client on purpose. A match needs `MATCH_FLOOR`
// players to start, and one player alone has nobody to kill - so a lone
// client would sit in the queue forever. They all stand still, nobody shoots
// anybody, and at the whistle every one of them should have their stake back.
//
// Still, but not stupid: the circle burns anybody outside it and closes on
// the middle, so once the match is live each survivor walks into the final
// circle and stands there. The way in is found by stepping the real movement
// simulation - the wasm the browser predicts with, so the server's own -
// across a metre grid; heading straight for the middle runs into walls, and
// a survivor stuck behind one burned to death in a match nobody shot in.
//
// It waits for the match to run its length, which is `MATCH_DURATION`. There
// is no way to hurry that from a client, and a client that could would be a
// client that could end everybody else's match too.

import { readFile } from 'node:fs/promises';
import init, { Predictor, constant_names, constants, select_map } from './generated/solatel_sim.js';

await init({ module_or_path: await readFile(new URL('./generated/solatel_sim_bg.wasm', import.meta.url)) });
const names = constant_names();
const values = constants();
const SIM = Object.fromEntries(names.map((name, i) => [name, values[i]]));

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('ws')) ?? 'ws://localhost:8080/ws';
const playerCount = Number(args[args.indexOf('--players') + 1]) || 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(why) {
  console.error(`FAIL  ${why}`);
  process.exit(1);
}

class Client {
  constructor(name) {
    this.name = name;
    this.seq = 0;
    this.playerId = null;
    this.matchId = null;
    this.tiers = [];
    this.balance = null;
    this.alive = false;
    this.remainingMs = null;
    this.ended = false;
  }

  async connect(protocolVersion) {
    this.ws = new WebSocket(url);
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
    this.send({
      t: 'hello',
      protocol_version: protocolVersion,
      client_build: 'survive.mjs',
      name: this.name,
      resume: null,
    });
    return welcome;
  }

  receive(msg) {
    switch (msg.t) {
      case 'welcome':
        this.playerId = msg.player_id;
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
      case 'funds':
        this.balance = msg.balance_micro_usd;
        break;
      case 'snapshot': {
        if (msg.match_id !== this.matchId) break;
        const mine = msg.players.find((p) => p.id === this.playerId);
        this.alive = (mine?.state.health ?? 0) > 0;
        if (mine) this.at = mine.state.position;
        this.zone = msg.zone_radius;
        this.startsInMs = msg.starts_in_ms ?? 0;
        this.remainingMs = msg.match_remaining_ms;
        break;
      }
      case 'eliminated':
        this.eliminated = true;
        break;
      case 'match_ended':
        if (msg.match_id === this.matchId) this.ended = true;
        break;
      default:
        break;
    }
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Walk the route into the final circle, then stand still - doing nothing
   *  is the whole point of this test. A tick's worth of commands each time,
   *  so the server walks the body as smoothly as it would a real client's. */
  idle() {
    if (!this.at || (this.startsInMs ?? 0) > 0) return this.command(0, 0);
    const now = Date.now();
    const [x, y, z] = this.at;
    if (!this.route) {
      this.route = routeToMiddle([x, y, z]);
      console.log(`>> ${this.name} walks ${this.route.length} m into the final circle`);
    }
    while (this.route.length > 0 && Math.hypot(this.route[0][0] - x, this.route[0][1] - z) < 0.35) {
      this.route.shift();
    }
    if (this.route.length === 0) return this.command(0, 0);
    // No progress for two seconds: knocked off the route, so plan again from here.
    if (!this.checkAt || now - this.checkAt > 2000) {
      if (this.checkPos && Math.hypot(x - this.checkPos[0], z - this.checkPos[2]) < 0.3) {
        this.route = routeToMiddle([x, y, z]);
        if (this.route.length === 0) {
          // Either already inside the final circle, short of a waypoint it
          // cannot quite reach, or nowhere to go from here: stand.
          const inside = Math.hypot(x, z) <= SIM.zoneFinalRadius - 3;
          if (!inside) console.log(`>> ${this.name} is stuck at ${[x, y, z].map((n) => n.toFixed(1)).join(', ')}`);
        }
      }
      this.checkAt = now;
      this.checkPos = [x, y, z];
    }
    if (this.route.length === 0) return this.command(0, 0);
    const [tx, tz, jump] = this.route[0];
    return this.command(0.6, Math.atan2(x - tx, z - tz), jump ? 1 : 0);
  }

  /** One command for every tick since the last send, so the server is never
   *  short of input to walk with and never queues a backlog of it. */
  command(forward, yaw, buttons = 0) {
    const now = performance.now();
    const due = Math.round(((now - (this.sentAt ?? now - 200)) * SIM.tickHz) / 1000);
    this.sentAt = now;
    const commands = [];
    for (let i = 0; i < Math.min(Math.max(due, 1), 16); i += 1) {
      this.seq += 1;
      commands.push({ seq: this.seq, forward, right: 0, yaw, pitch: 0, buttons });
    }
    this.send({ t: 'inputs', commands });
  }
}

/**
 * The way from `from` into the final circle, as points to head for, or none
 * when already in it.
 *
 * Breadth first over a metre grid, each step tried by running the real
 * simulation from where the last one actually landed: a staircase, a gap a
 * body fits through and a wall it does not are all the simulation's answer,
 * not this function's guess. Keyed by storey as well as by cell, so a
 * walkway is not mistaken for the floor under it. The map's own test proves
 * a way exists from every spawn (`the_final_circle_is_ground_everybody_can_walk_to`).
 */
function routeToMiddle(from) {
  const inside = SIM.zoneFinalRadius - 3;
  const sim = new Predictor();
  const key = (x, y, z) => `${Math.round(x)},${Math.round(z)},${Math.round(y / 2)}`;
  const start = { x: from[0], y: from[1], z: from[2], back: null };
  const seen = new Set([key(start.x, start.y, start.z)]);
  const queue = [start];
  for (let head = 0; head < queue.length && head < 60000; head += 1) {
    const node = queue[head];
    if (Math.hypot(node.x, node.z) <= inside) {
      const points = [];
      for (let at = node; at.back; at = at.back) points.unshift([at.x, at.z, at.jump]);
      return points;
    }
    for (let d = 0; d < 8; d += 1) {
      const tx = Math.round(node.x) + Math.round(Math.cos((d * Math.PI) / 4));
      const tz = Math.round(node.z) + Math.round(Math.sin((d * Math.PI) / 4));
      // Walked, and failing that jumped: some ledges are a hop.
      let jump = 0;
      for (; jump < 2; jump += 1) {
        sim.adopt(node.x, node.y, node.z, 0, 0, 0, 0, 0, true, SIM.maxHealth, false);
        for (let t = 0; t < 60; t += 1) {
          if (t > 0 && sim.on_ground && Math.hypot(sim.x - tx, sim.z - tz) < 0.1) break;
          sim.step(0.6, 0, Math.atan2(sim.x - tx, sim.z - tz), 0, jump && t === 0 ? 1 : 0);
        }
        // Judged where it arrives: momentum would carry it on past the cell.
        if (Math.hypot(sim.x - tx, sim.z - tz) <= 0.3 && sim.on_ground) break;
      }
      if (jump === 2) continue;
      const k = key(sim.x, sim.y, sim.z);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push({ x: sim.x, y: sim.y, z: sim.z, jump: jump === 1, back: node });
    }
  }
  return [];
}

const health = await fetch(url.replace(/^ws/, 'http').replace(/\/ws$/, '/health'));
const { protocol_version: protocolVersion } = await health.json();

const clients = [];
for (let i = 0; i < playerCount; i += 1) {
  const client = new Client(`Survivor ${i}`);
  await client.connect(protocolVersion);
  clients.push(client);
}

const table = (clients[0].tiers ?? []).slice().sort((a, b) => a.dollars - b.dollars)[0];
if (!table) fail('the server named no tables');
// A table is a map *and* a stake, and a queue without the map is refused as
// undecodable. Which map does not matter to a client that stands still.
const map = clients[0].maps?.[0]?.name;
if (!map) fail('the server named no maps');
if (!select_map(map)) fail(`this build has no map called ${map}`);
const ENTRY_FEE = table.entry_fee_micro_usd;
console.log(`>> ${clients.length} clients queueing for the $${table.dollars} table on ${map}`);
for (const client of clients) client.send({ t: 'queue', map, tier_dollars: table.dollars });

// Generous, because a short line waits before starting and the entry fees are
// a database round trip - neither of which this process controls.
const patience = Date.now() + 180000;
while (Date.now() < patience && !clients.every((c) => c.alive)) await sleep(200);
const missing = clients.filter((c) => !c.alive);
if (missing.length) fail(`${missing.length} of ${clients.length} never got into a match`);

const rooms = new Set(clients.map((c) => c.matchId));
if (rooms.size !== 1) fail(`queueing for one table made ${rooms.size} matches`);

const paidIn = clients.map((c) => c.balance);
console.log(
  `>> in the match; balances ${paidIn.map((b) => `$${(b / 1e6).toFixed(2)}`).join(', ')}, ` +
    `${Math.ceil((clients[0].remainingMs ?? 0) / 1000)}s to go`,
);

// Stand still and stay alive. Nobody shoots, so nobody dies, so nobody wins
// anybody else's stake.
//
// Waited out on the *server's* clock rather than on this one. A match is
// counted in ticks, and a server that stalls - a container paused, a host
// that slept - has its game time run behind the wall. Giving up because a
// local stopwatch expired would report a bug in the match clock that was
// really a bug in the afternoon.
let idleFor = 0;
let lastRemaining = clients[0].remainingMs ?? 0;
while (!clients.every((c) => c.ended)) {
  for (const client of clients) client.idle();
  await sleep(200);
  const dead = clients.find((c) => (!c.alive || c.eliminated) && !c.ended);
  if (dead) fail(`${dead.name} died with nobody shooting, at ${dead.at?.map((n) => n.toFixed(1)).join(', ')}`);
  const remaining = clients[0].remainingMs ?? 0;
  if (remaining < lastRemaining) {
    lastRemaining = remaining;
    idleFor = 0;
  } else {
    // The server has not moved the match on. Only give up once it has been
    // still for long enough that it is not coming back.
    idleFor += 200;
    if (idleFor > 120000) {
      fail('the match clock stopped with ' + Math.ceil(remaining / 1000) + 's to go');
    }
  }
}
console.log('>> the whistle went');

// The refunds are a database round trip behind the whistle.
for (let i = 0; i < 300; i += 1) {
  if (clients.every((c, n) => c.balance - paidIn[n] === ENTRY_FEE)) break;
  await sleep(100);
}

for (const [n, client] of clients.entries()) {
  const gained = client.balance - paidIn[n];
  console.log(
    `>> ${client.name}: $${(paidIn[n] / 1e6).toFixed(2)} -> $${(client.balance / 1e6).toFixed(2)}`,
  );
  if (gained !== ENTRY_FEE) {
    fail(
      `a survivor should get their $${(ENTRY_FEE / 1e6).toFixed(2)} back; ` +
        `${client.name} got $${(gained / 1e6).toFixed(2)}`,
    );
  }
}

for (const client of clients) client.ws.close();
console.log('OK   nobody won the stakes, so everybody kept theirs');
