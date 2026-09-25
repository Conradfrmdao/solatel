# Working notes for Solatel

Conventions and gotchas that are not obvious from reading the code. See
`README.md` for what the project is and `documents/` for the PRD.

## Build and run

There is no Rust toolchain on the host — it runs in a container, driven by
`./x` (see `./x` with no arguments for the command list). Do not suggest
`cargo` commands to run directly on Windows; they will fail with a missing
linker. `./x sh` opens a shell inside the toolchain if you need one.

`target/` and the cargo registry live in named Docker volumes, not on the bind
mount, because Rust build directories are unusably slow over a Windows bind
mount. Build outputs that matter are written to `web/dist`, which is on the
mount and visible from the host.

**Claude Code on the web is the exception.** That container is Linux with
Rust, Node and Postgres installed natively and no Docker daemon, so `./x`
does not work there and the tools run directly: `cargo test --workspace`,
`cargo clippy --workspace --all-targets -- -D warnings`,
`bash scripts/build-sim.sh`, `npm --prefix client run build`,
`bash scripts/copy-assets.sh`, `cargo run -p solatel-server`.
`.claude/hooks/session-start.sh` installs what is missing and starts a local
Postgres (`postgres://solatel:solatel@localhost:5432/solatel`, exported as
`DATABASE_URL` unless the environment sets one). It cannot reach Neon: its
network passes web traffic only, and a Postgres connection is not.

## Editing files on this machine

Two Windows defaults have already corrupted files in this repo:

- **Python's `read_text()`/`write_text()` default to cp1252, not UTF-8.** Round
  tripping a file containing an em dash through them double-encodes it into
  mojibake. Always pass `encoding='utf-8'` explicitly.
- **`write_text()` also converts newlines to CRLF on write.** Shell scripts
  written that way fail inside the Linux container with `bad interpreter: ...^M`.
  Pass an explicit LF newline argument, or write bytes instead.

`.gitattributes` forces LF on checkout, but it cannot protect files written
directly into the working tree.

## Rules that are not negotiable

**The server is authoritative.** The client sends *inputs* and renders
*predictions*. It never reports facts. Anything that decides a position, a hit,
a kill, or a balance happens server-side, including in throwaway prototypes —
this is a real-money game and the habit is what keeps it correct.

**Money is `MicroUsd` (`i64` micro-USD). No floats, ever.** Not in the database,
not in the protocol, not in intermediate arithmetic.

**Ledger entries are append-only and must balance.** All legs of a transaction
must be inserted inside one explicit database transaction — the sum-to-zero
check is deferred to `COMMIT`, so a lone entry in autocommit mode is its own
transaction and will be rejected. Corrections are reversing transactions, never
edits. Every money-moving operation carries an idempotency key.

Run `./x ledger` after touching anything in `migrations/` **or after
changing the shape of the statement `ledger::post` sends**. That script tests
the database's rules against the SQL the server actually posts, and the one
thing it cannot catch is the server posting something else.

## The lobby, and the matches it runs

**One process holds every match.** A `Lobby` owns the connections and a map of
`MatchId -> Match`; several run at once, at different stakes, on the same map.
The industry answer at scale is a matchmaker allocating a dedicated server per
match - Agones, GameLift and Open Match all describe that - and it is the
right answer when matches outgrow a machine. It is the wrong one here for one
specific reason: **the escrow sweep assumes one process owns the escrow
account**. A second process pointing at this database would settle the first
one's live stakes out from under it, and those are real money being played
for. Splitting later means an escrow account per server, or a lease on that
sweep, and that is the work to do *first*.

A **`Connection`** is a person - socket, name, wallet, resume token. A
**`Body`** is that person inside one match - position, health, stats,
winnings. The split is what lets a player be eliminated from one match and
standing in another a second later without any of their identity being
rebuilt.

### Queue, form, charge, start

The sequence PlayFab and Open Match both describe, with the money put where it
has to go.

1. A player asks for a **table** by its stake and is in line. Nothing is
   charged; a line that never fills costs nobody anything.
2. Twice a second the lobby looks at each line. Three outcomes and no others:
   - **the table is full** (`Map::max_players`) - start at once,
   - **the window is up and there are at least `MATCH_FLOOR`** - start with
     whoever is in line,
   - **otherwise** - keep waiting.
3. The entry fees are taken, and the match starts with whoever paid.

`QUEUE_WAIT` is **two minutes**, measured from when the first person joined
that line. `MATCH_FLOOR` is **four**.

**The window is not a delay, it is the point.** Forming the instant a line is
merely *able* to sounds responsive and is wasteful: thirteen people arriving
together were split into a match of six and a match of seven, because the
sixth tripped the threshold while the other seven were still queueing. Twenty
people in one match is a better game than two thin ones. A full table skips
the window entirely - there is nothing left to gain and everybody in it has
something to lose.

**A line under the floor keeps waiting however long it has been there.** Four
is the fewest worth running: below that it is one or two people on a map built
for twenty or thirty, which is a long walk between fights and a poor way to
spend a dollar. The client says "waiting for more players" rather than showing
a countdown, because a clock on something that is not going to happen is a lie
with a clock on it.

**A player whose socket dropped is not in the line**, though their place is
held until the resume window closes. Placing them would charge an entry fee to
somebody who is not there to play it and take a seat from somebody who is.
Coming back inside the window puts them back in line where they left off.

**Several matches run at one stake, at the same time.** Each table's line is
drained until it will not fill another match, so forty-five people queued for
$1 on a twenty seat map become three $1 matches on the same pass - not one
every half second. Nothing about a match is exclusive to its table.

**A killed player is in the lobby that instant** and may queue again on the
next tick. They do not wait for the match they died in - that is the whole
reason for running several.

**A match with one player left alive is over.** One life each and no respawn
means it is already decided; holding the winner on an empty map for the rest
of five minutes is not suspense, it is somebody waiting to be handed their
stake back. Matches that started with one player - which only a test server
does - have nothing to decide and run their length.

That rule is why the shooting tests have a **bystander**: a two player duel
would end the instant anybody died, and every assertion that looked at the
match afterwards would be looking at a match that no longer existed.

`SOLATEL_MATCH_FLOOR` and `SOLATEL_QUEUE_WAIT` override the two numbers. `1`
for the floor is for a server being tested by one person and warns in the log.
The tests set both on the `Lobby` directly - a two minute window would mean
stepping seven and a half thousand ticks in every test that forms a match.

### A table is a map and a stake

**There is no server-wide map.** A `Match` holds its own `&'static Map` and
several run at once on different ground, so every line is keyed on a map *and*
a stake: somebody who asked for the arena is not served by being put in the
yard. `SOLATEL_MAP`, `SOLATEL_MAP_SWITCH` and the whole `switch_map` message
are gone with it - they existed because one process ran one map, and it does
not.

`Map::max_players` - **20 on the arena, 30 on the yard** - because it is a
property of the ground rather than of the game: the yard is 252 metres across
and swallows thirty, while thirty in the arena would be a scrum.

There are deliberately **more spawn points than seats** (28 and 42), and
`Map::scatter` shuffles them per match. Two matches running on one map at the
same time therefore do not line everybody up identically, and one match does
not use the same corner every time. The shuffle takes its randomness from the
caller: the simulation runs on the server *and*, compiled to wasm, in every
client, so a function that reached for the clock would differ between them.

The client follows its match. `selectMap` calls `map::switch`, and it is
called **between matches only** - a match is a fresh
start with no world state to carry across, so there is nothing for a changed
table to contradict. Doing it mid-match would put a player's prediction on
different ground from the server's, which is the one disagreement this whole
design exists to prevent.

## The menu

`client/src/menu.js`. **A screen before the game, not a panel over it.** The
client connects, shows the menu, and does not load a map at all until a match
forms - because which map it loads is whichever table the player picked.
`body.in-menu` hides the canvas and the frame loop draws nothing while there
is no match.

Four panes: **play** (map, then stake), **wallet**, **profile**, **settings**.
The settings moved here from the HUD - they belong on a screen you go to
between matches, not over your crosshair - though the wiring stayed in
`hud.js` and looks them up in the document. The menu is therefore built before
the HUD, or the HUD looks for sliders that do not exist yet.

**Only the canvas takes the mouse.** `input.js` used to capture the pointer on
any click outside a short list of exceptions, which made the menu unusable
past its first press: the first click locked the pointer to the canvas and
every click after it landed there instead of on the button aimed at. It now
tests for the canvas rather than listing the things to stay off.

**A player's balance is asked for when they arrive** (`LedgerRequest::
ReadBalance`), so the wallet reads `$0.00` rather than a dash. A menu that
shows a dash cannot tell "you have nothing" from "we have not looked".

`node client/menu.mjs` drives the whole thing in a real browser: that the menu
is what a player lands on, that every tab opens, that queueing does not steal
the mouse, and that picking a table drops them into a match on the map they
chose with the world actually drawn. It needs `SOLATEL_MATCH_FLOOR=1` and a
short `SOLATEL_QUEUE_WAIT`, because one client alone would otherwise sit in
the queue - correctly - forever.

## What money is for

**One entry fee buys one life in one match. There is no respawn.**

The entry fee and the winnings are **two different things**, and conflating
them is the mistake this area exists to prevent.

**Winnings** are `Stakes::reward` per kill and nothing else. Ten kills is ten
rewards - at the dollar table, $9.00. They are posted to the wallet *as each
kill happens*, so by the time somebody dies their winnings are already theirs.
**A kill moves the victim's entry fee and only that.** Nobody gets somebody
else's winnings for killing them.

**The stake** is what they put up to be there, and it leaves escrow exactly
once:

| what happened | the player gets | we get |
|---|---|---|
| killed | nothing - the *killer* gets the reward | the rake |
| alive at the whistle | the whole stake back | nothing |
| walked away mid-match | the reward | the rake |
| the match never formed | the whole stake back | nothing |

That third row is `abandon`. A disconnected body stays in the world for
`RESUME_WINDOW` and is entirely shootable; anybody who kills it inside that
window claims the stake properly and it settles as a kill. Past the window
nobody won it, so it comes back less the rake. Taking the whole stake would
punish a dropped connection harder than losing a fight does; returning it
whole would make pulling the cable a free exit. Falling out of the world
settles the same way, plus one more reason: a hole in our own map must not
cost a player their dollar.

### Tiers

Four tables - $1, $2, $5, $10 - and **the rake is ten percent at every one**.

| stake | reward per kill | our rake |
|---|---|---|
| $1 | $0.90 | $0.10 |
| $2 | $1.80 | $0.20 |
| $5 | $4.50 | $0.50 |
| $10 | $9.00 | $1.00 |

A compile-time assertion proves every listed tier divides exactly.
`SOLATEL_TIERS` narrows which a server offers; by default it runs all four,
because one process holding every match is what keeps the escrow assumption
true.

**The price is the server's to state.** `Welcome` carries the table list and
the client displays what it is told.

### A match buys in once

`LedgerRequest::BuyMatch` charges a whole forming match in **one transaction**
with one leg per player, keyed `entry:<match>`. Charging player by player is
the obvious shape and is the wrong one: every purchase is a database round
trip, and against a managed Postgres thirteen in a row took **forty seconds**
- longer than the match would wait - so a thirteen player match started with
six. Batched it is **under six seconds** for a match of any size.

Players who cannot afford it are left out and the rest still play. Failing the
whole transaction would let one broke player stop a match for everybody else.

**A stake that arrives after the door has closed goes straight back.** If the
money takes longer than `FORMING_TIMEOUT` the match starts without that
player - and the answer, when it comes, is driven by *who paid* rather than by
who the match is still waiting for. Walking `awaiting` instead finds nobody
and quietly leaves their stake sitting in escrow until the next restart sweeps
it, which is how that bug looked.

**Settlement reads what was actually taken.** `escrowed_for` looks up the
player's own leg of their match's purchase and splits *that*, rather than
being told which tier it was. A settlement therefore cannot disagree with its
own purchase, however many tables are running.

Settlement keys are `<what>:<match>:<player>`, so a match settles player by
player out of one purchase - which is what the startup sweep has to walk, leg
by leg rather than transaction by transaction.

### The rest of the rules

**Nobody is on the map before they have paid.** The lobby asks the ledger and
carries on; the player waits in the lobby until the answer comes back.

**The pot is this match's, and the lobby knows it exactly**: the stakes that
have not yet left escrow, times the entry fee. Not a headcount - those stop
agreeing the first time somebody dies - and not the server-wide escrow total,
which with several tables running would mean nothing on a scoreboard. That
figure is an operator's number and lives on `/health`.

**Escrow is swept at startup**, settling every stake as an abandon, because a
process going away is every player disconnecting at once.

**Game time is counted in ticks, not in seconds of the afternoon.** A server
that stalls - a paused container, a host that slept - has its match clock run
behind the wall clock, and both end-to-end drivers wait on the server's own
`match_remaining_ms` rather than a local stopwatch. `survive.mjs` gave up
early once for exactly this reason and reported a bug in the match clock that
was really a four minute stall in Docker.

`SOLATEL_DEV_GRANT=20` funds new players once, batched per match under
`dev-grant:<match>`. Two matches forming in the same instant could each decide
to fund the same brand new player and grant twice; that is development money
on a development server, and it is written down here so nobody mistakes it for
a rule that holds.

**Money events are round trips, and the round trips are the cost.** Each is
timed and anything over `SLOW_EVENT_MS` is logged. Against a managed Postgres
on the other side of the internet one round trip is about half a second.
Account ids are looked up once and cached; balances are read every time,
because those change. A money event is **one statement** rather than a
`BEGIN`, a row per leg and a `COMMIT` - still one transaction, which is what
the deferred sum-to-zero check needs, and `./x ledger` proves it for the
statement the server actually sends. Deployed next to the database these are
milliseconds; do not read the numbers as a property of the code.

Two scripts prove the economy over a real wire, and between them cover every
route a stake can take:

- `node client/duel.mjs` - N clients queue for one table, the matchmaker puts
  them in one match, one kills another, the pot falls by exactly one entry
  fee, the victim asks forty times to come back and is not let into that match
  again, and the board shows the killer up one reward and the victim down
  nothing. It defaults to **thirteen** clients and that is not arbitrary:
  `Map::spawn` indexes modulo the spawn table, so more clients than spawns
  puts two in one place and they can see each other by construction. Six
  clients on six spawns fired 3,930 shots without one landing, which is the
  spawns being well chosen rather than anything broken.
- `node client/survive.mjs` - a client buys in, stands still for the whole
  match, and gets its stake back at the whistle. It takes `MATCH_DURATION` to
  run and there is no way to hurry it from a client, which is correct.

**Solana stays on devnet** until Conrad explicitly says otherwise. Nothing in
this repo should be able to move mainnet funds by accident.

## Accounts

`crates/solatel-server/src/account.rs`, migration 0005. A balance hangs off a
`PlayerId`, and that id used to last as long as the tab did - harmless while
every dollar was a development grant, and a lost deposit the first time
somebody closed a tab. So a browser holds an **account key**.

- **32 random bytes, base58, in `localStorage`** (`solatel.account`). Handed
  over in the `Welcome` only when the account is made; the database keeps
  only its SHA-256 (`players.account_key_hash`), so the server cannot send it
  again and a copy of the database is not a copy of everybody's wallet. A
  plain hash, not a slow one: this is 256 random bits, not a password.
- **Signed in before the lobby hears of the connection.** `ws.rs` resolves
  the `Hello`'s `account` to a `PlayerId` in the connection's own task,
  because it is a database round trip and the lobby's loop never waits on
  one. A missing or unknown key is a new account.
- **The account says who; the resume token says which body.** Local storage
  and shared by every tab, against session storage and one per tab. A token
  is honoured only for its own account.
- **A second tab on one account takes the player over.** The first is sent
  `Rejected` with `TAKEN_OVER` and **stops reconnecting** - it is *parked*,
  and the menu says "you are playing in another tab" with a *play here
  instead* button. Without the park the two tabs would sign in over each
  other every couple of seconds, passing one player back and forth.
- The profile pane shows the player id and, when asked, the key, with a
  warning; and takes a saved key to sign in with.

It is the weakest part of the wallet on purpose and for now: lose the key and
the balance goes with it. The answer is signing in with the Solana wallet the
money came from, which is what `players.solana_pubkey` is waiting for.

`client/menu.mjs` checks the lot in a real browser: a closed tab comes back as
the same player, and a second tab takes over while the first stays put.

## The wallet

`wallet.rs`, `solana.rs`, `ledger.rs`, migrations 0004 and 0005. Playing never
touches a chain; money crosses it exactly twice, in and out. **Devnet only**:
`solana::Cluster::devnet()` is the only cluster there is.

**The rate is configuration, `SOLATEL_SOL_USD`, and nothing reads a market.**
That was Conrad's choice: on devnet the SOL is free and the rate only has to
be deterministic, and on a real network it means we eat the difference from
the real price. There is no default, because a guessed price is a guess about
what somebody's deposit is worth; the server refuses to start with the
treasury key and no rate. Both conversions **round down** - a deposit is never
credited for more than arrived, a withdrawal never sends more than was taken.
Plisio replaces this rail for real money.

**In: one treasury address, and the player id as the memo.** A watcher polls
the treasury's *finalized* history every five seconds, pages back until it
reaches a signature it has already judged, and judges each new one exactly
once into `treasury_receipts`: `credited`, `unmatched` (the memo names
nobody), `too_small` or `not_incoming`. A credit posts `external -> player`
under `deposit:<signature>`, the chain's own name for the event, in the same
database transaction as the receipt - so a transfer seen twice is credited
once. The memo parser tolerates text around the UUID. Most wallets have no
memo box, so `./x pay <memo> <sol>` sends a test deposit from
`SOLATEL_DEV_PAYER_KEY`.

**Out: three ledger steps, never one.**

1. *Requested*: `player -> treasury` under `withdraw:<id>`, on the ledger's
   sequential queue, so it cannot race a buy-in. The money is out of the
   player's reach before anything is signed.
2. *Sent*: the wallet loop signs it and **records the signature before
   sending**. A signature is a transaction's id, so a transfer on record can
   be sent again, or waited out, and never paid twice.
3. *Final*: `treasury -> external` (`withdrawn:<id>`, `withdrawal_sent`). If
   it failed, or expired past its last valid block height plus 32, the money
   goes back: `treasury -> player` (`withdraw-returned:<id>`,
   `withdrawal_returned`), with the reason.

Checked before the ledger sees a request: at least `MIN_WITHDRAWAL` ($5); a
base58 address on the ed25519 curve, which is what a wallet is; not the
treasury; at least the rent-exempt minimum; five seconds since the player's
last request; and **refused while `SOLATEL_DEV_GRANT` is set**, because
development money can be played with and must not leave as SOL. The treasury
keeps its own rent-exempt minimum plus the fee, and a withdrawal it cannot
cover is returned with a reason.

Protocol 10 carries it: `ClientMsg::Withdraw`, `ServerMsg::{Deposited,
Withdrawal, WithdrawalRefused}`, and `Welcome.wallet` with the terms. The
menu's wallet pane states the rate and shows what the server says it is
sending; it never converts an amount itself. `/health` has a `wallet` block -
the treasury against what is owed - which is an operator's number, not a
reconciliation.

**A player's wallet is read in one statement** (`read_wallet`): the account
made if new, the balance and the last few withdrawals. Every arrival asks for
it on the one ledger queue, and as five statements it held that queue for
five to seven seconds a player against a database half a second away -
enough for thirteen arrivals to keep a match's buy-in waiting past
`FORMING_TIMEOUT` until the match dissolved. Every statement costs two or
three round trips; count them before adding one to that queue.

## Protocol changes

`ClientMsg` and `ServerMsg` in `solatel-protocol` are the wire contract. Renaming
a variant or changing a field is a breaking change: bump `PROTOCOL_VERSION` in
the same commit. The server rejects mismatched handshakes on purpose, so that a
stale cached wasm bundle fails loudly instead of misbehaving subtly.

The wire format is JSON text frames for now, funnelled through `net::encode` /
`net::decode` so that moving to a binary format in Phase 2 touches one module.

## The client

Three.js, plain JavaScript, bundled by esbuild into `web/dist`. It replaced a
Bevy/wasm client that was 81 MB and fought us over asset compatibility, visuals
and mouse look; this one is about 690 KB all in. `./x client` builds it, `./x
watch` rebuilds the JavaScript on save.

**Movement is not reimplemented in JavaScript.** `crates/solatel-sim-wasm` wraps
`solatel-protocol::sim` and the client predicts by calling it, so there is still
exactly one description of how a player moves and the server runs the same one.
Do not be tempted to port `step_tick` into JS to save a build step: two
descriptions of movement drifting apart is the failure this whole design exists
to prevent, and in a game that pays per kill it pays the wrong player.

The wasm is 974 KB, 293 KB of it over the wire once the server has gzipped
it, and almost all of that is the two maps' brush tables - 39,000 brushes at
six floats each is 900 KB on its own, against a simulation of about 50 KB.
That is the price of the client colliding against the server's own table
rather than a copy, and it is still the right trade, but it is the number to
watch: it moves with the brush count and nothing else. If it needs to come
down, the table is the thing to encode, not the simulation to trim.

The interface is flat `f32` arguments and getters, deliberately - it is called
64 times a second plus a replay per snapshot, and JSON at that rate is not free.
`brushes()`, `spawns()` and `constants()` hand the client the map and every
shared number, so nothing is duplicated on the JavaScript side.

Mouse look reads `movementX`/`movementY` directly under pointer lock, requested
with `{ unadjustedMovement: true }`. Sensitivity is a slider in the HUD and
persists in `localStorage`; it is the setting players are most particular about
and no single value is right.

`?debug=1` exposes `window.solatel`. `?nolock=1` lets the keyboard work without
pointer lock, which is the only way an automated browser can drive the game -
synthetic clicks do not earn a lock. `node client/smoke.mjs --tabs 2 --shot
out.png` uses both and reports whether the wasm instantiated, the models parsed,
WebGL came up and the socket connected.

The viewmodel is rendered in its own scene over a cleared depth buffer, which is
what stops a wall the player is standing against cutting through the weapon.

### The weapon in your hands

`viewmodel.js`, tuned from `weapons.js` - one entry per weapon, every number
in it, nothing hard-coded in the controller. The pose each frame is layers
added together: hip-to-sights, sway from turning, a breath when still, a
figure-of-eight bob paced by *distance covered* (so it quickens with speed),
a lift in the air and a dip on landing, then recoil. Every layer eases with
an exponential that takes `dt`, so the feel is the same at any frame rate,
and most of them are steadied with the sights up.

**Aiming down the sights is solved, not tuned.** `weapons.js` gives the two
sight points in the model's own units; the rig is pitched until the line
between them is level and moved so the front point is on the view axis. The
rifle carries a **red-dot sight** (`optic`), built in code on the carry
handle - a lathed tube with turrets, tinted glass and an unlit dot - and the
sight points are the two ends of its tube, so aiming looks down it: a near
rim, a far rim, the dot in the middle. It is added to the rifle model itself,
so everyone else's rifle carries it too. The world camera narrows by scaling the tangent of its
half-angle (`ads.zoom`), and turning is scaled by the same factor so a flick
covers the same part of the screen. The weapon's own camera narrows by its
own factor (`ads.weaponZoom`) to draw the sights larger; they are on the view
axis, so magnifying about the middle of the screen does not move them. The
crosshair dims with the sights up and never disappears: it is
where the shot goes, and on real stakes a player should always see it.

**None of it changes where a shot goes.** Recoil kicks the weapon and rolls
the camera around its own axis; a roll leaves the middle of the screen where
it was aimed. A recoil pattern that actually walks the aim, bullet spread
that differs between hip and sights, sprinting, magazines and reloading are
all *not built*, on purpose: each changes who wins a fight, so each has to be
enforced by the server, and a client-only version would be a lie a cheater
removes in one line. They are Conrad's decision and server work first.

**Your own shot is shown when you fire it**, not when the server echoes it a
round trip later. `LocalPlayer` predicts shots on the same ticks and interval
the server enforces (`takePredictedShots`), and `main.js` skips the kick and
sound for the echo of its own shot. The server still decides every hit.

### Other players

**The soldier is generated.** `soldier.js` throws away the model's own skin at
load and builds tactical kit in its place - helmet with night vision and a
headset, balaclava and goggles, plate carrier with magazine pouches and a
radio, camouflage uniform from a canvas-drawn pattern, gloves, knee pads,
boots - out of boxes, capsules and spheres placed relative to the rig's
joints. Every piece is weighted to the bone it moves with (the far end of
each limb half onto the next, so elbows and knees bend the sleeve), and the
lot is merged into one skinned mesh bound to the original skeleton: one draw
call per player, and the clips, IK and aim lean drive it unchanged. The rig
and clips are still the downloaded model's, so `ATTRIBUTION.md` still credits
it. Loaded bone names have their dots stripped (`fingers_L.001` arrives as
`fingers_L001`); look them up that way.

`remotes.js` layers everything the clips lack on top of them - the clips are
idle, walk, run and jump with the arms swinging and nothing in the hands:

- **Legs** turn up to 70 degrees toward the way the player moves, and the
  walk plays backwards when backing off; the spine turns back so the chest
  faces the aim.
- **The rifle is not in a hand.** It sits in the right shoulder pocket -
  following the shoulder joint as posed each frame - in a frame that turns
  with the player's yaw and pitch, so it points where they look, and both
  arms are bent onto it by analytic two-bone IK. The chest is turned
  into a bladed stance (`STANCE_TURN`), because at 0.47 m the rig's arms
  cannot otherwise reach both ends of a 0.84 m rifle.
- The torso and head lean with the pitch; shots kick the rifle and flash its
  muzzle; landing dips the hips; death falls the body before it goes.
- Beyond 35 m the mixer runs every other frame, beyond 70 m every fourth, and
  beyond 50 m the IK is skipped.

The rifle is a clone of the viewmodel's, which carries that rig's offset and
scale. Both are reset on the copy - inheriting them is what made every other
player hold a toy.

## Assets

Runtime models live in `assets/` and are copied into `web/dist/assets` by
`./x client`. They are downloaded by every player, so size is a gameplay
number. A player fetches only the map being played, so the budget is per map,
not for the folder: arena is 3.3 MB and yard 11 MB, against 1.6 MB of soldier
and 0.1 MB of rifle either way. The arena's second half cost 40 KB of that —
it is a few thousand triangles of boxes, against a model whose bytes are all
in the original's detail.

`prepare-assets.py` strips normals and texture coordinates from the maps, which
is most of that 11 MB. Neither is ever read — there are no textures in either
file and the client flat-shades every map material — so if a map ever does get
a texture, that step has to be reconsidered rather than left running.

The files are committed, but they are outputs. `scripts/prepare-assets.py`
rebuilds them from the raw downloads and records what was done to each one,
which CC-BY-4.0 requires us to state; `ATTRIBUTION.md` is the licence record.
`scripts/asset-licence.py` prints what a `.glb` claims about itself, and exits
non-zero for a file with no embedded licence — the rifle is currently that file
and must not ship until its terms are confirmed.

**`scripts/extend-arena.py` is the one place geometry is authored**, and it is
separate from `prepare-assets.py` precisely so that "the download is untouched"
stays true of everything else. It adds Solatel's own buildings, stairs and
walls to `arena.glb`, and takes down 40 triangles of the original: the east and
west walls, so the map can continue past them, and a redundant red-orange floor
quad that was z-fighting with the grey ground plane over the whole arena. It
also takes down `room_0`'s own floor - 60 downward-facing triangles at ground
level, which the client's double-sided materials drew at exactly the ground's
depth inside that building. It is idempotent: everything it adds goes on
the end of each glTF array, the lengths from before are in `asset.extras`, and
nothing is ever deleted — removed triangles are only pointed away from. Run it,
then `./x maps`, then bump `MAP_VERSION`.

Two rules govern what may be built, both found the hard way and both in that
file's docstrings. **Nothing may be built over a column whose own obstacle
reaches 1.75 m**: `obstacle_heights` gives such a column the height of the
highest surface anywhere in it, so a walkway over a ramp that reaches head
height is not read as spanning it — the two weld and everything between fills
in solid. `scratchpad`-style probes aside, the map of which columns those are
is what to check first. And **each tread of a staircase must be its own box**,
spanning only its own depth: `voxelise` marks the cells a *surface* passes
through, not the cells inside a volume, so nested boxes stamp every tread's top
face onto every column below it and the flight comes back as floating slabs.

**Map collision is generated, not written.** `./x maps` runs
`scripts/derive-brushes.py` over every model in `assets/maps` and rewrites the
tables in `sim/map.rs` between its two markers. Regenerate rather than
hand-editing, or the server stops colliding against what the client draws — and
bump `MAP_VERSION` in the same commit, which is what tells a stale cached client
to reload. Each map carries its own `scale` for the same reason: the client
draws that model at that scale because its brushes were derived at it.

There are two maps, `arena` and `yard`, and the server runs both at once: each
match holds its own map (see *A table is a map and a stake*), and
`MatchStarted` names it. The client calls `select_map` with that name
**between matches only**, which points its prediction at that table through
`map::switch`. `map::active()` is the client's one map; the lobby never reads
it. There is no `SOLATEL_MAP`, no `map::select` and no map picker any more.

Tests run over every map in `MAPS`. Two of them pin the arena on purpose —
what they assert about its two staircases is true of those specifically.

The yard takes a few minutes to generate and prints a timing per stage, so a
slow run can be told from a wedged one.

Several things in that script are subtler than they look and were all found
the hard way.

`MIN_OBSTACLE_AREA` is zero on purpose: it used to drop small props as scenery,
which left 27% of what a player could see with no collision behind it, the
arena's own one-cell-thick wall faces among it. Correctness first.

`climb` grows the height field onto ledges a player could step up onto,
flooding out from the floor; without it the top half of every staircase is
missing, because a tread at 2.25 m has nothing at chest height and reads as
open floor. Simply widening the detection band instead turns 4,700 columns that
players currently walk *under* into walls from the floor up. It settles each
column at the *lowest* surface it can reach, by priority rather than in the
order the flood happens to arrive; with a plain queue a neighbour up on a roof
could claim a column at a ledge four metres up before the flood along the floor
got there, after which the floor's step to it was too big. Adding a bridge in
one corner cost 529 columns their reachability three metres away and turned a
staircase into a wall. Geometry that is added must never subtract. It also made
the yard's spawn pass thirty times faster, which is the same fact.

`harmonise` may move a cell three bands and no further. Unbounded, it votes a
cell to whatever its neighbours mostly are, and the window is wide enough to
contain the nine metre perimeter wall: one staircase went from 2.75 m to 9.00 m
— not fragmented, replaced by a tower, with the rooftops it served stranded
behind it. Which cells it is even offered comes from `climb`, so the cliff was
reachable by accident.

**The perimeter is a box and the art is not**, so there is bare stated floor
between them, running right round the map — 3,279 m² of it on the yard, with
open water past its edge. It is standable, and reaching it needs no jump: the
yard's own boundary wall drops to 6.75 m around z 37 and there is a ten metre
roof nine metres inside it, so a player walks off the roof, clears the wall on
the way down, and is outside the map. `outside_the_art` fills it.

**The voxel grid is porous over a large flat mesh, and anything that reads it
as "is there art here" has to allow for that.** `sample_triangles` caps a
triangle at 600 steps a side however big it is, so a ground plane — two
enormous triangles — is sampled every 0.42 m across the yard's 252 m against
cells of 0.25 m, and open ground comes out as a *lattice*: 204 of 576 cells in
one patch of plain yard marked by nothing. It causes no trouble anywhere else,
because the floor's collision is the stated perimeter slab and
`obstacle_heights` ignores row 0 — which is exactly why it went unnoticed.
`outside_the_art` flooded through it, decided the middle of the map was
outside the map, and left a comb of invisible 14 m walls across open ground.
It now erodes by `MARGIN_OPENING` before flooding and dilates after: a lattice
stripe one or two cells wide has no interior to flood through, and the real
margin is metres across and survives. That took it from 1,155 brushes of comb
to 7 brushes, and from a claimed 3,279 m² to the true 1,081 m².

Its test is "nothing whatsoever in this column", and both looser versions were
tried and measured. Judging on the voxel grid alone misses the props — 723 of
the yard's meshes are props, platforms among them — and walls off 12,000 m² of
ground players walk on. Judging on the finished brushes alone misses the floor,
because the art's ground plane is row 0 of the grid and deliberately produces
no brush, so the whole open yard reads as outside its own map. And testing
"nothing to *stand* on" rather than "nothing at all" leaks through the first
gateway it meets and claims 70% of the yard and 56% of the arena. Sealing the
margin costs the yard some edge strips that were only reachable by walking
out-of-bounds around them, which is the right trade and is why its walkable
area went down rather than up.

**Sealing the void is not the same as stopping a player leaving.** The art's
buildings stop several metres short of where its ground does, so there is an
apron of drawn, empty ground round the outside of the map with open water past
it. A player knocked onto it, or falling onto it from a roof, is behind the map
for the rest of the round. `edge_apron` makes the outer `EDGE_APRON` metres of
it solid — a guardrail in the collision, invisible, because the yard's art is
not ours to add rails to.

It is **distance-limited, never flooded**, and that is the whole safety of it:
a flood through open ground reaches the first gateway and swallows the map, at
70% of the yard measured. A band measured outward from the void can only ever
take the metres it is given, only takes ground with nothing standing on it, and
on a map with no void at all — the arena — it does nothing.

Spawn connectivity asks which geometry is *in the way*, not which exists.
`standable` returns a footprint of everything with a top above the floor,
roofs and lids included, and a column is marked from it however far overhead
the thing is. Using that to decide what connects to what says a roofed street
cannot be walked down: the arena's own lid, nine metres up over the original
compound, put its two halves in different regions and sent every spawn to one
side of gateways a player strolls through.

`band` quantises to the grid everywhere, and must keep doing so. It used to
snap anything above 2.75 m to one of three heights — 3, 6 or 12 m, which are
the arena's and nothing else's. On the yard that put two thirds of the surfaces
a player can stand on somewhere other than where they are drawn: half floated
one to two metres above the roof, one in seven was buried inside it, the worst
by nearly nine metres. It is most of what "I cannot climb things properly" and
"it is like I am closer to the ground" turned out to mean.

`harmonise` is for walls only, and `upper_obstacles` skips nothing. Smoothing
makes a cell agree with its neighbours, which is right for a fifty-metre run of
wall whose voxel height wanders and exactly wrong for a surface somebody is
standing on — a roof beside a tower gets voted up to the tower. Conversely, the
upper-storey pass needs no guard against swallowing floor, because `in_band`
already is one: a column with geometry within a standing body of the floor is a
column nobody can stand in. Two cleverer guards were tried and each threw away
most of the walls.

`clearance` does an exact ray-box intersection rather than marching along the
ray: sampling every quarter metre lets a diagonal ray pass through the corner
of a thin brush undetected, which put a spawn facing a wall while the generator
claimed the view was clear.

**One number per column cannot describe both a floor and a wall, and trying
was the worst bug this map generator has had.** `obstacle_heights` answers
"how high is the thing in the way here"; `climb` answers "how high is the
surface a player stands on here". They are the same for a crate and opposite
for a roof. `build_brushes` used to spend the second as the first: a player
climbs the stairs onto a roof, `climb` records 3.75 m for every column under
it, and the ground pass fills each of those solid from the floor. Two entire
rooms - 21% of the arena - were bricked up, and the same happened to every
roofed building on the yard.

So anything that does not rest on the ground is emitted as the run of solid
cells it actually is, by `standing_runs`, at the height it is. `climb` is
still how the spawn picker knows where a player can stand; it no longer
decides what is solid. This also subsumes two earlier patches - a stair tread
at 2.25 m is a run, and so is the wall of an upstairs room - so the separate
upper-storey pass is gone.

A run does reach down to whatever is under it when the gap is no more than a
step. Without that, a stair tread is a slab with a hole behind it: the player
steps up, their box overhangs the edge, and they drop into the gap. That is
what the runs change broke and this restored, and it is the difference
between a staircase and a series of small falls.

`scripts/check-reachable.py` is the other half of the picture: it asks
whether the places a player can *stand* can be walked to, which a doorway
check cannot see. Calibrate its `radius` against the Rust `walk_from` before
believing it - at two cells it calls every corridor too narrow and the map
disconnects from itself.

`scripts/check-passable.py` is the check for this, and it is the one to run
after any change to the generator. It floods the art and the brushes from the
same spawns and reports what the art opens that the collision does not. Seed
both from the *spawns*, never from the edge of the grid: a map sealed by its
own perimeter has no open edge, the two models then fall back to different
regions, and the report claims every square metre disagrees.

**Spawns must be somewhere a player can walk out of.** A map's walkable floor
is not one piece - the yard is hundreds of pieces, of which the yard proper is
78%, and the rest are fenced strips, roofed bays and pockets behind stacks.
Five of the twelve spawns were in one, and one of those was twelve cells
across. `walkable_regions` labels the pieces and only the largest is used.

Label them on the standable set eroded by the player's width, and on nothing
else. The spawn mask grows obstacles by the width *plus slack*, which turns
every stair tread into a wall and cut the arena's upstairs off from its own
downstairs. The bare standable set has no width, so it squeezes through
one-cell gaps and joins yards that nothing can pass between. Both were tried.
The erosion is also a square rather than a cross, because a cross leaves the
diagonals and a diagonal is exactly where a spurious one-cell link survives.

`every_spawn_can_reach_every_other` is the check that matters, and it is in
Rust rather than here: it walks the map with `move_and_slide` itself, so it
cannot be fooled by a mistake in the model above. Any change to spawn
selection should be judged against it.

**A pocket a player can fall into and not climb out of is filled in.**
`seal_traps` finds them: the walkable floor is a directed graph, because
falling is free and climbing is not, so a walled pen with no door is a place
a player reaches off a roof and then spends the match in. They are filled to
the height of the wall around them, so landing there puts a player on top of
the pen. 488 m2 of the yard and 2 m2 of the arena.

**`PROP_SLAB` must stay under `MAX_STEP_UP`, and the generator asserts it.**
Slicing a prop builds a staircase out of it. At 0.6 m against a 0.55 m step
that staircase is a wall, and all thirty-eight of the yard's sliced props
were silently unclimbable with nothing in the output to say so.

**A prop is a stack of boxes, not one box.** A bounding box is exact for a
crate square to the world and badly wrong for anything else, because it is the
same size at every height and at every angle: a car's box is solid from the
tarmac to the roofline across its whole length, so the air beside the bonnet is
solid too. `prop_boxes` follows the silhouette a slice at a time instead, and
falls back to the single box when the stack would not be smaller - which is
most props, so most of them still cost one brush.

The test for "is it worth slicing" is wasted cubic metres, not a percentage.
A percentage picks the wrong props: quantising a slice inflates it, so a small
object always looks close to its own box however badly the box fits, while a
car wasting thirty cubic metres comes in under the same fraction.

Spawns are seeded from the best-covered candidate, not from the extremes of z.
Seeding from the extremes guaranteed two of the twelve were the far corners of
the map by construction, which on a 252 m map is a player who starts by walking
for half a minute.

`scripts/check-collision.py` measures how much of the wall a player can see is
actually solid. Believe its number only because it judges against floors the
generator says are reachable: an earlier version took the floor under a sample
to be the top of whatever brush lay beneath it, counted the outsides of
fourteen-metre parapets, and reported 7% where the truth was 1%.

## A player who reloads

Reloading must not be a way out of a fight that is going badly, and must not
cost a player the position they had earned. Those pull in opposite directions,
and **the body staying in the world is what satisfies both**.

A disconnect marks a player `away_since` and changes nothing else. Their body
stays where it was for `RESUME_WINDOW` — standing still, visible, and entirely
shootable — and is retired only when the window closes. Removing them instead
would make closing the tab the cheapest escape in the game, and a way to walk
out of a fight without paying for the life you were about to lose. When the
window does close, the stake settles as an abandon - the reward back to the
player, the rake to us, the same settlement a fall gets - and not a refund.
Their held inputs are cleared on the way out, so a body whose owner
disconnected mid-sprint stands where it was rather than walking off a roof.

Coming back is a `ResumeToken` presented in the `Hello`. It is a bearer
credential — whoever holds it becomes that player, with their position, their
health and their record — so:

- **Server-issued.** A client never chooses one; the only way to hold a valid
  token is to have been handed it in a `Welcome`.
- **Unguessable.** A v4 UUID, 122 bits from the OS random source, against a
  window measured in seconds.
- **Single-use.** Resuming consumes it and issues a fresh one, so a token that
  leaks into a log or a screenshot is spent the moment its owner reconnects.
- **Honoured even against a live connection.** Requiring the body to be
  marked away first looks safer and is not: a socket can stay open for tens of
  seconds after the far end has gone — a phone moving from wifi to cellular is
  exactly this — so the owner reconnects, their own token is refused because a
  dead socket still holds their body, and they get a fresh spawn. That is the
  failure the whole mechanism exists to prevent. The displaced connection is
  told why and stops receiving.

Two sockets driving one player is prevented instead by **scoping every command
to a session**. `Inputs`, `Queue`, `LeaveQueue` and `Leave` all carry the `SessionId` that
sent them, and the world ignores any that do not match the player's current
one. That is where the check belongs: the old socket stops being able to move
the body the moment the new one takes it, rather than being trusted to close
first. It also means a `Leave` arriving late from a superseded connection
cannot mark a live player away and get them swept up when the window closes
underneath them.

A token the server does not recognise costs the client nothing: it simply
joins as a new player. That is what makes it safe for the client to always
send whatever it happens to have. A token is honoured **only for the account
it belongs to** (see *Accounts*), so holding somebody's token does not make a
connection them.

It lives in `sessionStorage`, not `localStorage`, and the difference is the
design. Session storage is per tab and survives a reload, which is exactly the
set of events a player expects to come back from. Local storage is shared by
every tab on the origin, so two tabs open on the game would each present the
same token and fight over one body.

**A reloaded page is told which match it is in.** It knows nothing on arrival
- not the match, not the map - and without that it discards every snapshot as
a straggler and sits on the menu while its body stands in the match being
shot. So a player taken back mid-match is sent `MatchStarted` again, right
behind the `Welcome`. That broke once when the menu came first, and
`coming_back_mid_match_is_being_told_which_match_and_which_map` pins it.

`client/resume.mjs` is the end-to-end check, and it is not redundant with the
Rust tests: those cover which tokens are honoured, but they cannot cover
whether a real browser keeps one across a real page load. It queues into a
match, walks, reloads, and asserts the same player came back into the same
match on the same map, within a metre or two of where it left — the tolerance
is not zero because gravity still applies to the body while the page is
loading.

## Shooting, and what it is worth

Damage is stated per region rather than as a multiplier on a base, because a
multiplier means a rounding rule and a rounding rule is one more thing that
has to match between whatever computes the number and whatever checks it. Two
shots to the head, three to the body, four to the legs, and the test that says
so counts them out against `MAX_HEALTH` rather than restating the constants.

A headshot is deliberately not a kill on its own. One-shot kills mean whoever
saw the other first wins outright, and there is nothing to play for in the
second between seeing and dying.

**The head box is layered over the full body box, never carved out of it.**
Tiling the silhouette into three sounds tidier and is wrong: a head is
narrower than the shoulders, so the corners above them would belong to no box
at all and a shot through one would report a clean miss on a player it visibly
went through. A shot that hit before still hits; the head box only decides
whether it hit harder. `the_head_box_never_turns_a_hit_into_a_miss` sweeps
every height and offset and says so.

`shots_fired` is counted where the fire rate *honours* the trigger, not where
the client pulls it. A client may send `fire` every tick; charging it for the
shots the weapon refused would make holding the trigger look like terrible
aim, and accuracy is a number players are judged — and paid — on.
Accuracy itself is never sent: it is `shots_hit / shots_fired`, and sending
the ratio as well as its two terms is sending the same fact twice with a
rounding rule for the client to disagree about. The client renders the
percentage, the way it renders the pot.

There is nothing to respawn into, and that is enforced on the server and
nowhere else. A match is formed once, out of a queue, and is never joined
again: `Queue` is refused outright from anybody already in a match, and a
match that has started admits nobody. So a client can ask as fast as it likes
and the answer does not change - the next match is a different match, and
buying into it is buying into it. A client that could put itself back on the
map could leave a fight it was losing and come back at full health somewhere
else, having paid once for both.

What a killed player *can* do, immediately, is queue for the next one. They
are in the lobby the instant they die.

Damage is told to the victim and the shooter and to nobody else. Broadcasting
it would tell every other player in the match how hurt their opponents are,
which is information nobody earned. The killfeed is the exception, and it
carries both names *in the event* rather than looking them up in the
scoreboard afterwards — the most interesting kill in a match is frequently the
one where somebody then leaves, and a feed that says "‹unknown› killed you" is
a feed nobody trusts.

The scoreboard is sorted by the server. Leaving the sort to the client means
two players watching the same match disagree about who is winning whenever two
of them are level. It is also its own message rather than part of the
snapshot: snapshots are twenty a second and already the bulk of the traffic,
and a name plus six counters per player in every one of them would be most of
a kilobyte a second per client to say nothing had changed.

Names are cosmetic and are treated as hostile input. `sanitise_name` collapses
whitespace, drops other control characters, bounds the length in `char`s and
falls back to a stable name rather than rejecting anybody. Whitespace is
tested *before* control characters and that order matters: a tab and a newline
are both, and dropping them outright turns "big⇥red" into "bigred" rather than
the two words somebody typed. Nothing is ever keyed on a name — anything that
moved money by name would be paying whoever typed the name.

## When aim stops responding

The reported symptom is the HUD saying the pointer is captured and zero
movement arriving, while the mouse is being moved. That is pointer lock on
Windows, not this code: `unadjustedMovement: true` asks Chrome for
unaccelerated deltas, Chrome gets them from the Raw Input API, and that
registration does not always survive the window losing focus - leaving
`document.pointerLockElement` set while the events stop.

It has not been reproduced here, and that shapes what is in the client.
There is a *setting* (`raw mouse`, on by default) so the mechanism can be
taken out of the picture from the HUD, and diagnostics - a count of
movement events, and a NOT RESPONDING notice after three seconds of silence
while a movement key is held. The two together separate the cases: events
climbing while the view is still means the fault is in `input.js`; events
frozen means the browser has stopped delivering.

What is deliberately *not* there is an automatic re-lock. A version of this
took the pointer back after 1.5 s of silence, and the only evidence
available - a key held, no mouse movement - is also what lining up a long
run looks like. Breaking the lock underneath a player doing that is a worse
bug than the one being chased, and it would have been introduced blind.

Coalesced events are summed rather than trusting the merged event's own
`movementX`, which Chromium has got wrong more than once.

## Scenery, and what it is allowed to be

The sun, the cloud deck and the water are drawn by the client and exist
nowhere else. They follow the camera, which is only safe because they are
scenery: nothing a player does to them is visible to anyone, and none of it
reaches the simulation. The perimeter brushes stop a player long before the
water, and they are what makes the boundary honest.

**A surface is recorded at the bottom of the cell holding it, never the
top.** `voxelise` resolves a sample sitting exactly on a cell boundary
upwards, and nearly every horizontal face in these models sits exactly on
one, so the cell's bottom *is* the surface and its top is a quarter of a
metre of invention.

Reporting the top inflated every surface in both maps by a full cell. The
differences between surfaces stayed right, which is why it survived so long
- a staircase of 0.50 m treads still read as 0.50 m steps. What did not stay
right was the step up from the ground, because the ground is at exactly zero
and is not inflated. The yard's white staircase came out with a 0.75 m first
step against a 0.65 m stride and could not be entered at all.

**Spawn connectivity is measured on the brush table, not on the voxel
grid.** The game collides against the table, and the table is the art
quantised, banded, smoothed and with prop boxes on top - asking the art
whether two places are joined got the answer wrong twice, both times caught
by `every_spawn_can_reach_every_other`, which walks the map with the real
resolver. When a model and that test disagree, the test is right.

`MAX_STEP_UP` is 0.65 m where Unreal ships 0.45 and Source 0.46, and the
reason is the representation rather than the player. Both of those collide
against the level's own triangles; this collides against a height field
quantised to a quarter of a metre, so a real 0.40 m step is stored as
anything up to 0.65 m once it has been rounded to a cell and banded. The
step height has to cover the art's step plus what the storage adds to it.
It is still far under the 1.13 m a jump clears, so cover is still cover.

The two halves of that number live in `collide.rs` and in the generator and
are kept in step by hand.

A spawn faces the middle of the playable area, and clear sight is only the
qualification for a direction rather than the thing being maximised.
Weighing the two against each other does not work: every direction on an
open map has tens of metres of clear ground, so whichever has the most wins
- and the most is frequently a long empty run at a blank wall, which is
what the player then spends their first second looking at.

Spawn connectivity is asked of a mask grown by *one cell*, not of the spawn
mask. The spawn mask is grown by the player's width plus slack because a
spawn wants elbow room; asking that whether two places are joined demands a
1.75 m corridor and split the arena in half, so every spawn ended up in the
same end of it. One cell is 0.75 m against a 0.70 m player.

A spawn's facing is chosen, not defaulted. Eight directions are tried and the
sight test used to give up at 14 m, so most of them tied and `argmax` took
whichever the loop reached first - which is why players kept starting nose to
a wall. It looks 45 m now, and ties go to the direction pointing into the
middle of the playable area, which is where the other players are.

The camera's height is a low-pass filter over the feet, in `localplayer.js`
and *only* there - the feet stay exactly where the server puts them.

It must be a filter, not an accumulated offset. The first version added each
step to a running lag and decayed it, which works for one step and fails on
a ramp: a ramp is a step every quarter of a metre, and walking one at eight
metres a second delivers them every thirty milliseconds, far faster than a
tenth-of-a-second decay can clear. The lag climbed to its own clamp and sat
there, and a saturated offset is not a filter - the eye simply tracked the
feet half a metre lower with every bump intact. A low-pass has no such
mode: a steady climb settles at climb-rate times the time constant, and it
is smooth because it is continuous rather than a stack of corrections.

Smooth only while grounded. A fall should be seen falling. Detect the step in the fixed tick and
nowhere else: reconciliation runs twenty times a second and rewinds the
player before replaying forward, so its endpoints differ by a few
centimetres of correction. Counting those as steps fed the smoother a
stream of phantom rises and made the view jitter continuously - worst on
stairs, where real steps were arriving as well and it looked like the
smoothing itself had failed. It is subtracted from the eye and from
nothing else, so the feet stay exactly where the server puts them - smoothing
the position instead would mean the client and the server disagreeing about
where the player is, which is the one thing this codebase is built not to do.

The money in play comes down with every snapshot as an integer count of
micro-USD, and the player's own balance arrives separately in `Funds` - only
to the player it concerns, and only when it changes. The client formats both
and computes neither: a client that worked out its own balance would be a
client that could be wrong about how much money it has.

A client told it cannot afford a life stops asking. The server does not rely
on that - a client is an untrusted source of inputs, and one asking twice a
second is a balance query against the database twice a second - so a refusal
also sets `broke_until`. The answer cannot change without the player doing
something outside the match anyway.

## Phase 2 note

Movement and shooting feel cannot be tuned by guessing at numbers. Build a
version, then ask Conrad for a test pass and a specific description of what
feels wrong. Expect several rounds; that is the plan, not a failure.
