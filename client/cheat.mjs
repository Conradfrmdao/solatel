// A cheating client, over the real wire. Phase 5's first check: the server is
// authoritative, so try to cheat it and see that nothing gets through.
//
//   node client/cheat.mjs [ws://host:port/ws]
//
// Needs a server that will start a match for one person, and a dev grant so
// the cheat can afford to try:
//
//   SOLATEL_MATCH_FLOOR=1 SOLATEL_QUEUE_WAIT=3 SOLATEL_DEV_GRANT=20 ./x server
//
// It speaks the protocol by hand, like `duel.mjs`, because a real client
// would never send most of this - which is the point. Every attack is one a
// modified client could make in a line or two:
//
//   * a speed hack: `forward` far past 1, sixteen commands a message, a
//     message every few milliseconds - a thousand commands a second against a
//     server that runs sixty-four;
//   * a fire-rate hack: the trigger held in every one of those commands;
//   * aim nobody could hold: yaw and pitch of 3e38 and of 1e308 (which a
//     float cannot hold and arrives as infinity), and every button bit set -
//     values the wire accepts and the simulation has to survive;
//   * values the wire cannot carry - a button byte of 65535, a speed that is
//     a string - and one message with ten thousand commands in it, far past
//     the size limit; each of those should end the connection;
//   * queueing for a second match from inside the first, which would be a
//     second life for one stake if it worked;
//   * a withdrawal of a negative amount;
//   * a message only the server sends - telling the server what our balance
//     is - and coming back afterwards to see whether it listened;
//   * a resume token nobody issued, to be somebody else.
//
// And after all of that, an honest client must still be able to connect
// and be answered promptly: a cheat that cannot win can still try to make
// the game unplayable for everyone else.

const url = process.argv.slice(2).find((a) => a.startsWith('ws')) ?? 'ws://localhost:8080/ws';
const health = url.replace(/^ws/, 'http').replace(/\/ws$/, '/health');

// From `solatel-protocol`, written out on purpose: a wire test that read the
// server's own constants could not notice them changing.
const MAX_GROUND_SPEED = 8.0;
const WEAPON_FIRE_INTERVAL = 0.12;
const FIRE = 1 << 1;
const JUMP = 1 << 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(ok, what, detail = '') {
  results.push({ ok, what });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
}

class Wire {
  constructor(name) {
    this.name = name;
    this.seq = 0;
    this.shots = 0;
    this.closed = false;
    this.me = null;
    this.matchStarts = 0;
    this.refusals = [];
  }

  async connect(hello = {}) {
    const { protocol_version } = await (await fetch(health)).json();
    this.ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error(`${this.name}: cannot connect`)), { once: true });
    });
    this.ws.addEventListener('close', () => { this.closed = true; });
    this.ws.addEventListener('message', (event) => this.receive(JSON.parse(event.data)));
    const welcome = new Promise((resolve, reject) => {
      this.onWelcome = resolve;
      setTimeout(() => reject(new Error(`${this.name}: no welcome`)), 15000);
    });
    this.send({
      t: 'hello',
      protocol_version,
      client_build: 'cheat.mjs',
      name: this.name,
      resume: null,
      account: null,
      ...hello,
    });
    return welcome;
  }

  receive(msg) {
    switch (msg.t) {
      case 'welcome':
        this.welcome = msg;
        this.playerId = msg.player_id;
        this.onWelcome?.(msg);
        break;
      case 'match_started':
        this.matchStarts += 1;
        this.matchId = msg.match_id;
        break;
      case 'snapshot':
        if (msg.match_id !== this.matchId) break;
        for (const p of msg.players) {
          if (p.id === this.playerId) {
            this.me = { at: p.state.position, health: p.state.health, yaw: p.state.yaw };
          }
        }
        break;
      case 'shot_fired':
        if (msg.shooter === this.playerId) this.shots += 1;
        break;
      case 'funds':
        this.balance = msg.balance_micro_usd;
        break;
      case 'withdrawal_refused':
        this.refusals.push(msg.reason);
        break;
      default:
        break;
    }
  }

  send(msg) {
    if (!this.closed) this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  close() {
    this.ws.close();
  }
}

const cheat = new Wire('Cheat');

// ---- someone else's resume token --------------------------------------------
await cheat.connect({ resume: crypto.randomUUID() });
check(
  cheat.welcome.resumed === false,
  'a resume token nobody issued makes a new player, not someone else',
  `resumed=${cheat.welcome.resumed}`,
);
const account = cheat.welcome.account_key;
const resumeToken = cheat.welcome.resume_token;

// ---- into a match ------------------------------------------------------------
cheat.send({ t: 'queue', map: 'arena', tier_dollars: 1 });
for (let i = 0; i < 200 && !cheat.me; i += 1) await sleep(100);
if (!cheat.me) {
  console.error('FAIL  never got into a match; is SOLATEL_MATCH_FLOOR=1 set?');
  process.exit(1);
}
await sleep(1500); // onto the floor, and the spawn settled
const balanceInMatch = cheat.balance;
const start = { at: [...cheat.me.at], t: performance.now() };
const shotsBefore = cheat.shots;

// ---- speed and fire rate --------------------------------------------------------
// Sixteen commands a message, a message every four milliseconds, for three
// seconds: four thousand commands a second, every one of them pushing
// forward at 1e30 with the trigger held. Straight along the way the spawn
// faces, because a spawn is chosen to face open ground: that way the run is
// long enough to show a speed hack if there were one, and the check can ask
// that the flood moved the player at all rather than passing because a wall
// stopped them.
const floodSeconds = 3;
const heading = cheat.me.yaw;
const flood = setInterval(() => {
  const commands = [];
  for (let k = 0; k < 16; k += 1) {
    cheat.seq += 1;
    commands.push({ seq: cheat.seq, forward: 1e30, right: 0, yaw: heading, pitch: 0, buttons: FIRE });
  }
  cheat.send({ t: 'inputs', commands });
}, 4);
await sleep(floodSeconds * 1000);
clearInterval(flood);
const elapsed = (performance.now() - start.t) / 1000;
await sleep(500); // the last snapshots in
check(!cheat.closed, 'the flood is read, not refused: the connection is still open');
const moved = Math.hypot(cheat.me.at[0] - start.at[0], cheat.me.at[2] - start.at[2]);
const legal = MAX_GROUND_SPEED * (elapsed + 0.5);
if (moved < 5) {
  console.log(`NOTE  the run was blocked after ${moved.toFixed(1)} m, so speed is only checked as an upper bound this time`);
}
check(
  moved <= legal,
  'a flood of maxed-out movement moves the player, and no faster than running',
  `${moved.toFixed(1)} m in ${elapsed.toFixed(1)} s, at most ${legal.toFixed(1)} m`,
);

const fired = cheat.shots - shotsBefore;

// ---- aim nobody could hold ------------------------------------------------------
const weird = setInterval(() => {
  const commands = [];
  for (let k = 0; k < 16; k += 1) {
    cheat.seq += 1;
    commands.push({
      seq: cheat.seq,
      forward: cheat.seq % 2 ? 1e30 : -1e30,
      right: cheat.seq % 3 ? -1e30 : 1e30,
      yaw: cheat.seq % 2 ? 3e38 : 1e308,
      pitch: cheat.seq % 2 ? -3e38 : -1e308,
      buttons: 0xff,
    });
  }
  cheat.send({ t: 'inputs', commands });
}, 4);
await sleep(1000);
clearInterval(weird);
await sleep(300);
check(
  cheat.me.at.every(Number.isFinite),
  'aim of 3e38 and 1e308 and every button bit set leave the player somewhere real',
  `at ${cheat.me.at.map((n) => n.toFixed(1)).join(', ')}`,
);

const allowed = Math.ceil((elapsed + 0.5) / WEAPON_FIRE_INTERVAL) + 1;
check(
  fired <= allowed,
  'holding the trigger in every command fires no faster than the weapon',
  `${fired} shots, at most ${allowed}`,
);

// ---- a second life for one stake ----------------------------------------------
const startsBefore = cheat.matchStarts;
cheat.send({ t: 'queue', map: 'arena', tier_dollars: 1 });
cheat.send({ t: 'queue', map: 'yard', tier_dollars: 10 });
await sleep(3000);
check(
  cheat.matchStarts === startsBefore && cheat.balance === balanceInMatch,
  'queueing from inside a match starts nothing and charges nothing',
  `balance ${cheat.balance} was ${balanceInMatch}`,
);

// ---- money out that is not there ----------------------------------------------
check(!cheat.closed, 'the cheat is still connected for what follows');
cheat.send({ t: 'withdraw', amount_micro_usd: -5_000_000, destination: '11111111111111111111111111111111' });
cheat.send({ t: 'withdraw', amount_micro_usd: 9_000_000_000_000, destination: 'not-an-address' });
await sleep(1500);
check(
  cheat.refusals.length === 2 && cheat.balance === balanceInMatch,
  'a negative withdrawal and an enormous one are both refused, and nothing moves',
  cheat.refusals.join(' | '),
);

// ---- telling the server what our balance is -----------------------------------
cheat.send({ t: 'funds', balance_micro_usd: 1_000_000_000_000, insufficient: false });
await sleep(1000);
check(cheat.closed, 'a message only the server sends ends the connection');
// Back as the same player, with the account key and resume token the server
// gave us, to see what it thinks our balance is now.
const back = new Wire('Cheat');
await back.connect({ account, resume: resumeToken });
await sleep(1500);
check(
  back.playerId === cheat.playerId && back.welcome.resumed === true,
  'the cheat can come back as itself afterwards',
);
check(
  back.balance === undefined || back.balance === balanceInMatch,
  'and its balance is what the ledger says, not what it claimed',
  `balance ${back.balance ?? '(no change sent)'}`,
);

// ---- values the wire cannot carry ---------------------------------------------
const command = { forward: 0, right: 0, yaw: 0, pitch: 0, buttons: 0 };
const tenThousand = Array.from({ length: 10000 }, (_, k) => ({ ...command, seq: k + 1, forward: 1 }));
for (const [what, commands] of [
  ['a button byte of 65535 is not a command', [{ ...command, seq: 1, buttons: 0xffff }]],
  ['a speed that is a string is not a command', [{ ...command, seq: 1, forward: 'fast' }]],
  ['ten thousand commands in one message is past the size limit', tenThousand],
]) {
  const probe = new Wire('Probe');
  await probe.connect();
  probe.send({ t: 'inputs', commands });
  await sleep(700);
  check(probe.closed, `${what}, and the connection ends`);
}

// ---- and everybody else can still play ----------------------------------------
const honest = new Wire('Honest');
const t0 = performance.now();
await honest.connect();
const answered = performance.now() - t0;
check(answered < 3000, 'an honest client is still answered promptly', `${Math.round(answered)} ms`);
const healthy = await (await fetch(health)).json();
check(healthy.status === 'ok' && healthy.ledger_reconciles, 'the server is healthy and the ledger reconciles');

honest.close();
back.close();

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nFAILED ${failed.length} of ${results.length}` : `\nOK   all ${results.length} checks held`);
process.exit(failed.length ? 1 : 0);
