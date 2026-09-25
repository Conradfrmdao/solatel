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
// It waits for the match to run its length, which is `MATCH_DURATION`. There
// is no way to hurry that from a client, and a client that could would be a
// client that could end everybody else's match too.

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
        this.onWelcome?.(msg);
        break;
      case 'rejected':
        fail(`${this.name} was rejected: ${msg.reason}`);
        break;
      case 'match_started':
        this.matchId = msg.match_id;
        break;
      case 'funds':
        this.balance = msg.balance_micro_usd;
        break;
      case 'snapshot': {
        if (msg.match_id !== this.matchId) break;
        const mine = msg.players.find((p) => p.id === this.playerId);
        this.alive = (mine?.state.health ?? 0) > 0;
        this.remainingMs = msg.match_remaining_ms;
        break;
      }
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

  /** Stand still. Doing nothing is the whole point of this test. */
  idle() {
    this.seq += 1;
    this.send({
      t: 'inputs',
      commands: [{ seq: this.seq, forward: 0, right: 0, yaw: 0, pitch: 0, buttons: 0 }],
    });
  }
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
const ENTRY_FEE = table.entry_fee_micro_usd;
console.log(`>> ${clients.length} clients queueing for the $${table.dollars} table`);
for (const client of clients) client.send({ t: 'queue', tier_dollars: table.dollars });

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
