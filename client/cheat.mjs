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
//   * a grenade thrown every other command, for as many as the server will
//     let go of - two a life, whatever the client says;
//   * queueing for a second match from inside the first, which would be a
//     second life for one stake if it worked;
//   * a withdrawal of a negative amount;
//   * a message only the server sends - telling the server what our balance
//     is - and coming back afterwards to see whether it listened;
//   * a resume token nobody issued, to be somebody else;
//   * signing in with a wallet that never signed anything: a proof with no
//     challenge asked, a signature of random bytes, a real signature over
//     different words, a good proof sent twice, and one account's proof
//     replayed by another to take its wallet;
//   * a table nobody runs - a $3 stake, a map that does not exist - and a
//     name five hundred characters long full of control characters;
//   * guns nobody may carry - a sniper rifle with a red dot, a pistol as a
//     primary - and the trigger held against the actions: a bolt action
//     held on it, a pistol held on it and pulled every command, and the
//     guns changed every command with the trigger down.
//
// And after all of that, an honest client must still be able to connect
// and be answered promptly: a cheat that cannot win can still try to make
// the game unplayable for everyone else.

import nodeCrypto from 'node:crypto';

const url = process.argv.slice(2).find((a) => a.startsWith('ws')) ?? 'ws://localhost:8080/ws';
const health = url.replace(/^ws/, 'http').replace(/\/ws$/, '/health');

// From `solatel-protocol`, written out on purpose: a wire test that read the
// server's own constants could not notice them changing.
const MAX_GROUND_SPEED = 8.0;
const WEAPON_FIRE_INTERVAL = 0.12;
const FIRE = 1 << 1;
const JUMP = 1 << 0;
const THROW = 1 << 4;
const SIDEARM = 1 << 6;
/** The sniper rifle's bolt and the pistol's trigger, in seconds. */
const BOLT_INTERVAL = 1.25;
const PISTOL_INTERVAL = 10 / 64;
const GRENADES_PER_LIFE = 2;

const MAX_NAME_LEN = 16;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** A wallet: an ed25519 key, as a browser extension holds one. */
function wallet() {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
  // The raw 32 bytes are the last 32 of the SPKI encoding.
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    address: base58(raw),
    sign: (text) => base58(nodeCrypto.sign(null, Buffer.from(text, 'utf8'), privateKey)),
  };
}
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
    this.explosions = 0;
    this.walletAnswers = [];
  }

  /** Sends a request and waits for the next wallet answer to it. */
  async walletAnswer(msg) {
    const before = this.walletAnswers.length;
    this.send(msg);
    for (let i = 0; i < 50 && this.walletAnswers.length === before; i += 1) await sleep(100);
    return this.walletAnswers[before] ?? { ok: false, reason: '(no answer)' };
  }

  async askChallenge() {
    this.challenge = null;
    this.send({ t: 'wallet_challenge' });
    for (let i = 0; i < 50 && !this.challenge; i += 1) await sleep(100);
    return this.challenge;
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
        this.loadout = msg.loadout;
        // No map to load: ready for the countdown at once.
        this.send({ t: 'loaded', match_id: msg.match_id });
        break;
      case 'snapshot':
        if (msg.match_id !== this.matchId) break;
        this.startsInMs = msg.starts_in_ms ?? 0;
        for (const p of msg.players) {
          if (p.id === this.playerId) {
            this.me = { at: p.state.position, health: p.state.health, yaw: p.state.yaw };
          }
        }
        break;
      case 'exploded':
        if (msg.thrower === this.playerId) this.explosions += 1;
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
      case 'wallet_challenge':
        this.challenge = msg.message;
        break;
      case 'wallet_signed_in':
        this.walletAnswers.push({ ok: true, ...msg });
        break;
      case 'wallet_refused':
        this.walletAnswers.push({ ok: false, reason: msg.reason });
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
// Past the warm-up, which holds everybody still whatever they send - a
// flood sent during it would prove nothing about speed or fire rate.
for (let i = 0; i < 600 && (cheat.startsInMs ?? 1) > 0; i += 1) await sleep(100);
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
// Every button bit but the grenade's. A grenade thrown here can bounce back
// off a wall and kill the cheat itself, which the server rightly settles
// as walking away - stake back less the rake - and every balance checked
// after this would then be off by $0.90 through nothing the server did
// wrong. Grenades have checks of their own below.
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
      buttons: 0xff & ~THROW,
    });
  }
  cheat.send({ t: 'inputs', commands });
}, 4);
await sleep(1000);
clearInterval(weird);
await sleep(300);
check(
  cheat.me.at.every(Number.isFinite),
  'aim of 3e38 and 1e308 and every other button bit set leave the player somewhere real',
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

// ---- more grenades than a life carries -----------------------------------------
// The throw button pressed and released every other command, forty times:
// forty rising edges, each one a throw if the client were believed. Last,
// and thrown high, because a grenade is as dangerous to its thrower as to
// anybody and the checks above want the cheat alive.
for (let k = 0; k < 80; k += 1) {
  back.seq += 1;
  back.send({
    t: 'inputs',
    commands: [{ seq: back.seq, forward: 0, right: 0, yaw: heading, pitch: 0.9, buttons: k % 2 ? 0 : THROW }],
  });
  await sleep(20);
}
await sleep(4000); // past the fuse
check(
  back.explosions <= GRENADES_PER_LIFE,
  'forty throws in a row let go of no more grenades than a life carries',
  `${back.explosions} went off, at most ${GRENADES_PER_LIFE}`,
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

// ---- signing in with a wallet that never signed --------------------------------
const signer = new Wire('Signer');
await signer.connect();
const key = wallet();

let answer = await signer.walletAnswer({ t: 'wallet_proof', public_key: key.address, signature: key.sign('anything') });
check(!answer.ok, 'a proof with no challenge asked signs nobody in', answer.reason);

let challenge = await signer.askChallenge();
const noise = base58(nodeCrypto.randomBytes(64));
answer = await signer.walletAnswer({ t: 'wallet_proof', public_key: key.address, signature: noise });
check(!answer.ok, 'a signature of random bytes signs nobody in', answer.reason);

challenge = await signer.askChallenge();
answer = await signer.walletAnswer({
  t: 'wallet_proof', public_key: key.address, signature: key.sign(`${challenge}\nand credit me $1000`),
});
check(!answer.ok, 'a real signature over different words signs nobody in', answer.reason);

challenge = await signer.askChallenge();
const good = { t: 'wallet_proof', public_key: key.address, signature: key.sign(challenge) };
answer = await signer.walletAnswer(good);
check(
  answer.ok && answer.player_id === signer.playerId && !answer.account_key,
  'a real signature over the challenge links the wallet to the account that asked',
  answer.reason ?? '',
);
answer = await signer.walletAnswer(good);
check(!answer.ok, 'the same proof sent again is refused: a challenge is good once', answer.reason);

// Another account replays the first one's proof, hoping to be signed in as
// the wallet - which would hand it the first account's balance.
const thief = new Wire('Thief');
await thief.connect();
await thief.askChallenge();
answer = await thief.walletAnswer(good);
check(
  !answer.ok,
  "another account replaying that proof is not signed in as the wallet's account",
  answer.reason,
);

// ---- guns nobody may carry, and the trigger against the actions -----------------
// A loadout is chosen with the stake and the server says what it hands over:
// an optic the gun cannot carry is that gun's own, and a pistol is nobody's
// primary. Then whatever the trigger says, a bolt action fires once for each
// working of its bolt, a pistol once for each pull, and a gun being brought up
// fires nothing.
const armed = new Wire('Armed');
await armed.connect();
armed.send({ t: 'queue', map: 'arena', tier_dollars: 1, loadout: { primary: 'sniper', optic: 'red_dot' } });
for (let i = 0; i < 200 && !armed.me; i += 1) await sleep(100);
check(
  armed.loadout?.primary === 'sniper' && armed.loadout?.optic === 'x4',
  'a sniper rifle asked for with a red dot is handed over with its own scope',
  JSON.stringify(armed.loadout),
);
for (let i = 0; i < 600 && (armed.startsInMs ?? 1) > 0; i += 1) await sleep(100);
await sleep(1500);
/** Commands at the server's own rate for `seconds`, with `buttons` from
 *  each command's index; the shots the server says came of it. */
async function hold(wire, seconds, buttons) {
  const before = wire.shots;
  const t = performance.now();
  let n = 0;
  const timer = setInterval(() => {
    wire.seq += 1;
    n += 1;
    // Looking up, at nobody.
    wire.send({ t: 'inputs', commands: [{ seq: wire.seq, forward: 0, right: 0, yaw: wire.me?.yaw ?? 0, pitch: 1.2, buttons: buttons(n) }] });
  }, 1000 / 64);
  await sleep(seconds * 1000);
  clearInterval(timer);
  await sleep(500);
  return { fired: wire.shots - before, elapsed: (performance.now() - t) / 1000 };
}
const bolt = await hold(armed, 3, () => FIRE);
check(
  bolt.fired >= 1 && bolt.fired <= Math.ceil(bolt.elapsed / BOLT_INTERVAL) + 1,
  'a bolt action with the trigger held fires once for each working of the bolt',
  `${bolt.fired} shots in ${bolt.elapsed.toFixed(1)} s`,
);
await hold(armed, 1, () => SIDEARM);
const held = await hold(armed, 2, () => SIDEARM | FIRE);
check(held.fired === 1, 'a pistol with the trigger held fires once', `${held.fired} shots`);
const pulled = await hold(armed, 2, (n) => SIDEARM | (n % 2 ? FIRE : 0));
check(
  pulled.fired >= 2 && pulled.fired <= Math.ceil(pulled.elapsed / PISTOL_INTERVAL) + 1,
  'a pistol pulled every other command fires no faster than its trigger allows',
  `${pulled.fired} shots in ${pulled.elapsed.toFixed(1)} s`,
);
const swapped = await hold(armed, 2, (n) => FIRE | (n % 2 ? SIDEARM : 0));
check(swapped.fired === 0, 'changing guns every command with the trigger down fires nothing', `${swapped.fired} shots`);
armed.close();
const pistolero = new Wire('Pistolero');
await pistolero.connect();
pistolero.send({ t: 'queue', map: 'arena', tier_dollars: 1, loadout: { primary: 'pistol', optic: 'x4' } });
for (let i = 0; i < 200 && !pistolero.loadout; i += 1) await sleep(100);
check(
  pistolero.loadout?.primary === 'rifle' && pistolero.loadout?.optic === 'red_dot',
  'a pistol asked for as a primary is the rifle, with its own sight',
  JSON.stringify(pistolero.loadout),
);
pistolero.close();

// ---- tables nobody runs, and a name nobody should have ---------------------------
const fussy = new Wire('\u0000\u0007'.repeat(10) + 'x'.repeat(480) + '\u202e');
await fussy.connect();
const name = fussy.welcome.name;
check(
  [...name].length <= MAX_NAME_LEN && !/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(name),
  'a name five hundred characters long full of control characters is cut down and cleaned',
  JSON.stringify(name),
);
fussy.send({ t: 'queue', map: 'arena', tier_dollars: 3 });
fussy.send({ t: 'queue', map: 'the-moon', tier_dollars: 1 });
await sleep(2500);
check(
  fussy.matchStarts === 0 && !fussy.closed,
  'a $3 table and a map that does not exist start nothing',
);
// And one short enough to keep, with an override in it that would print
// every killfeed line it appears in backwards.
const sly = new Wire('ab\u202ecd\u200b');
await sly.connect();
check(sly.welcome.name === 'abcd', 'an override and a zero-width space are taken out of a name', JSON.stringify(sly.welcome.name));
sly.close();
fussy.close();
signer.close();
thief.close();

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
