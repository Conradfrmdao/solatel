// A kill, and the dollar it moves, over the real wire.
//
// The unit tests prove what the world decides when somebody dies, and
// `./x ledger` proves what the database refuses. This proves the join
// between them: that a shot fired by one websocket ends a life bought by
// another, and that the stake leaves escrow when it does.
//
// It speaks the protocol directly rather than driving a browser, because
// what is under test is the server. There is no wasm here, no rendering and
// no prediction - it sends inputs and reads snapshots, which is all a client
// is entitled to do.
//
//   node client/duel.mjs [--players N] [ws://host:port/ws]
//
// # The lobby
//
// Clients do not join a match; they stand in line for a table and the server
// forms one around them. So this queues everybody for the same stake and
// waits for `match_started` rather than asking to be let in - which is what a
// real client does, and is the only way to be sure the matchmaker is what put
// them together.
//
// # Why nobody walks anywhere
//
// An earlier version had two clients walk towards each other and shoot. It
// does not work, and the way it fails is worth writing down: two spawns are
// rarely in sight of one another, so the pair reliably ends up against
// opposite sides of the same wall with the server tracing their shots a
// third of a metre into it. Steering round that is pathfinding, and a test
// that needs a navigation mesh to prove a ledger entry is testing the wrong
// thing.
//
// So nobody moves, and instead there are more clients than the map has
// spawns. `Map::spawn` indexes modulo the spawn table, so the thirteenth
// client to join an arena with twelve spawns stands inside the first one,
// and two players occupying one point have line of sight to each other by
// construction. Everybody sweeps their aim across everybody else and fires;
// that pair is the duel, and it takes about twenty-five shots to find.
//
// Six clients, spread over six spawns, fired three thousand nine hundred
// and thirty shots without one landing. That is not a bug in the map - the
// spawns are deliberately far apart and mostly out of each other's sight,
// which is what you want of spawns - it is why this does not try.
//
// # What is checked, and why the pot is enough
//
// Also checked: that a kill pays the killer a flat reward and takes nothing
// off the victim. A player gets one life per match, and when it is over the
// money they won during it is already theirs - killing somebody moves their
// *entry fee* and nothing else.
//
// The pot in every snapshot is the escrow balance, summed by the database.
// A kill settlement is one transaction with three legs - the stake out of
// escrow, ninety cents to the killer, ten to the platform - and the
// sum-to-zero check is deferred to COMMIT, so the ledger cannot hold one of
// those legs without the other two. The pot falling by exactly one entry fee
// is therefore the whole transaction, not a third of it.

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('ws')) ?? 'ws://localhost:8080/ws';
// One more than the arena has spawns, so that two of them share one. Fewer
// works only if the map is small enough for two spawns to see each other,
// and this one is not.
const playerCount = Number(args[args.indexOf('--players') + 1]) || 13;

// From `solatel-protocol`. Written out rather than imported on purpose: a
// driver that read the server's own constants could not notice the server
// changing them, which is half of what a wire test is for. The entry fee is
// the exception - the server states it in the handshake, because a server
// may run a different stake from the one next to it.
const EYE_OFFSET = 0.8;
const FIRE = 1 << 1;
const TICK_MS = 1000 / 64;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const norm = (v) => {
  const l = Math.hypot(v.x, v.y, v.z);
  return l > 0 ? { x: v.x / l, y: v.y / l, z: v.z / l } : { x: 0, y: 0, z: -1 };
};

function fail(why) {
  console.error(`FAIL  ${why}`);
  process.exit(1);
}

/** One connection, and everything it has been told. */
class Client {
  constructor(name) {
    this.name = name;
    this.seq = 0;
    this.playerId = null;
    this.players = new Map();
    this.kills = [];
    this.hits = 0;
    this.shots = 0;
    this.pool = null;
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
      client_build: 'duel.mjs',
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
        this.onWelcome?.(msg);
        break;
      case 'rejected':
        fail(`${this.name} was rejected: ${msg.reason}`);
        break;
      case 'match_started':
        this.started = (this.started ?? []).concat(msg.match_id);
        this.matchId = msg.match_id;
        this.tier = msg.tier;
        this.playersInMatch = msg.players;
        break;
      case 'lobby':
        this.tables = msg.tables;
        break;
      case 'snapshot':
        // Several matches run at once. Anything about another one is a
        // straggler about a match this client is not in.
        if (msg.match_id !== this.matchId) break;
        // A position is `[x, y, z]` on the wire - a glam `Vec3` is a
        // sequence, not an object - and is named here once rather than
        // indexed at every use.
        this.players = new Map(
          msg.players.map((p) => [
            p.id,
            {
              ...p.state,
              at: { x: p.state.position[0], y: p.state.position[1], z: p.state.position[2] },
            },
          ]),
        );
        this.pool = msg.pool_micro_usd;
        break;
      case 'funds':
        this.funds = msg;
        break;
      case 'eliminated':
        this.eliminated = msg;
        // Out of that match, and the client stops belonging to it. Without
        // this the driver keeps answering "which match are you in" with the
        // one it was just thrown out of.
        this.matchId = null;
        break;
      case 'match_started':
        this.matchStarted = (this.matchStarted ?? 0) + 1;
        this.entered = false;
        break;
      case 'scoreboard':
        this.board = msg.entries;
        break;
      case 'killed':
        this.kills.push(msg);
        break;
      case 'hit_confirmed':
        this.hits += 1;
        break;
      case 'shot_fired':
        if (msg.shooter === this.playerId) this.shots += 1;
        break;
      default:
        break;
    }
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** One input command: standing still, looking along `look`, firing. */
  aimAndFire(look) {
    this.seq += 1;
    this.send({
      t: 'inputs',
      commands: [
        {
          seq: this.seq,
          forward: 0,
          right: 0,
          // The inverse of the simulation's `look_direction`.
          yaw: Math.atan2(-look.x, -look.z),
          pitch: Math.asin(Math.max(-1, Math.min(1, look.y))),
          buttons: FIRE,
        },
      ],
    });
  }

  get state() {
    return this.players.get(this.playerId);
  }

  /** Everyone else the server says is alive. */
  targets() {
    return [...this.players]
      .filter(([id, s]) => id !== this.playerId && s.health > 0)
      .map(([, s]) => s);
  }
}

const health = await fetch(url.replace(/^ws/, 'http').replace(/\/ws$/, '/health'));
const { protocol_version: protocolVersion } = await health.json();

const clients = [];
for (let i = 0; i < playerCount; i += 1) {
  const client = new Client(`Duellist ${i}`);
  await client.connect(protocolVersion);
  clients.push(client);
}
console.log(`>> ${clients.length} clients on protocol ${protocolVersion}`);

// The cheapest table this server runs. Everybody queues for the same one, so
// the matchmaker has no reason to split them across matches.
const table = (clients[0].tiers ?? []).slice().sort((a, b) => a.dollars - b.dollars)[0];
if (!table) fail('the server named no tables');
const ENTRY_FEE = table.entry_fee_micro_usd;
const KILL_REWARD = table.kill_reward_micro_usd;
console.log(`>> queueing for the $${table.dollars} table`);
for (const client of clients) client.send({ t: 'queue', tier_dollars: table.dollars });

// Wait for everyone to be alive, which is not the same as being in a
// snapshot: a body stays in the world while its owner reconnects, and a
// player who has not paid in is not in one at all. An earlier version of
// this script checked only for a snapshot entry, reported that everyone had
// spawned, and then complained that the pot was empty - which was the truth,
// and it was looking at eight dead men.
//
// The wait is generous because a short-handed line waits before starting and
// every entry fee is a database round trip, neither of which this process
// controls.
const alive = (c) => (c.state?.health ?? 0) > 0 && c.matchId;
const wanted = clients.length * ENTRY_FEE;
const patience = Date.now() + 300000;
while (Date.now() < patience && !(clients.every(alive) && (clients[0].pool ?? 0) >= wanted)) {
  await sleep(200);
}
const dead = clients.filter((c) => !alive(c));
if (dead.length) fail(`${dead.length} of ${clients.length} clients never got into a match`);

// All of them in one match, which is what queueing for one table should do.
const rooms = new Set(clients.map((c) => c.matchId));
if (rooms.size !== 1) fail(`the matchmaker split ${clients.length} clients across ${rooms.size} matches`);
console.log(`>> all ${clients.length} in one match`);

const potBefore = clients[0].pool ?? 0;
console.log(`>> everyone alive; pot is $${(potBefore / 1e6).toFixed(2)}`);
if (potBefore < wanted) {
  fail(
    `${clients.length} paid lives should put at least $${(wanted / 1e6).toFixed(2)} ` +
      `in escrow; the pot says $${(potBefore / 1e6).toFixed(2)}`,
  );
}

// Sweep. Each client cycles its aim across every other player, firing the
// whole time. The trigger is held rather than pulsed because the server rate
// limits it and does not count the shots it refuses.
const deadline = Date.now() + 90000;
let kill = null;
let round = 0;
while (Date.now() < deadline && !kill) {
  for (const client of clients) {
    const targets = client.targets();
    if (!targets.length) continue;
    const target = targets[round % targets.length];
    const eye = { ...client.state.at, y: client.state.at.y + EYE_OFFSET };
    client.aimAndFire(norm(sub(target.at, eye)));
  }
  round += 1;
  kill = clients.flatMap((c) => c.kills).find((k) => k.killer);
  await sleep(TICK_MS * 2);
}

const shots = clients.reduce((n, c) => n + c.shots, 0);
const hits = clients.reduce((n, c) => n + c.hits, 0);
if (!kill) fail(`${shots} shots and ${hits} hits, but nobody died`);
console.log(
  `>> ${shots} shots, ${hits} hits: ${kill.killer_name} killed ${kill.victim_name}` +
    `${kill.headshot ? ' (headshot)' : ''}`,
);

// One life per match. The victim is out, and asking to come back must not
// put them back into the match they died in - whatever the client does.
const victim = clients.find((c) => c.playerId === kill.victim);
const killer = clients.find((c) => c.playerId === kill.killer);
if (!victim.eliminated) fail('the victim was never told they were out');
const diedIn = killer.matchId;
for (let i = 0; i < 40; i += 1) {
  victim.send({ t: 'queue', tier_dollars: table.dollars });
  await sleep(100);
}
// One life per match: however many times they ask, they must not be let back
// into the one they were killed in.
const readmitted = (victim.started ?? []).filter((id) => id === diedIn).length;
if (readmitted !== 1) fail(`the victim was let into that match ${readmitted} times`);
if (victim.matchId === diedIn) fail('a dead player got back into the match they died in');
console.log('>> the victim asked forty times and did not get back into that match');

// The kill was worth a flat reward to the killer, and cost the victim
// nothing beyond the entry fee they had already paid.
const won = (c) => c.board?.find((e) => e.id === c.playerId)?.winnings_micro_usd ?? 0;
await sleep(1000);
if (won(killer) !== KILL_REWARD) {
  fail(`a kill should be worth $${(KILL_REWARD / 1e6).toFixed(2)}; the board says $${(won(killer) / 1e6).toFixed(2)}`);
}
if (won(victim) !== 0) {
  fail(`the victim had no kills and should have won nothing; the board says $${(won(victim) / 1e6).toFixed(2)}`);
}
console.log(
  `>> the kill paid $${(KILL_REWARD / 1e6).toFixed(2)} and took nothing off the victim`,
);

// The settlement is a database round trip behind the kill, and the pot in
// the snapshot is the server's cache of what the ledger last reported. Give
// it a moment, and count only the one kill: a second one landing in the
// meantime would take another fee out and the arithmetic below would be
// measuring two settlements rather than one.
await sleep(6000);
const killsNow = new Set(clients.flatMap((c) => c.kills).map((k) => `${k.victim}`)).size;
const potAfter = clients[0].pool;
const moved = potBefore - potAfter;
console.log(
  `>> pot $${(potBefore / 1e6).toFixed(2)} -> $${(potAfter / 1e6).toFixed(2)} over ${killsNow} death(s)`,
);
if (moved !== killsNow * ENTRY_FEE) {
  fail(
    `${killsNow} death(s) should take $${((killsNow * ENTRY_FEE) / 1e6).toFixed(2)} ` +
      `out of escrow; this took $${(moved / 1e6).toFixed(2)}`,
  );
}

for (const client of clients) client.ws.close();
console.log('OK   a kill over the wire settled a paid life out of escrow');
