# Solatel

A browser-based, skill-based multiplayer shooter where players pay a small entry
fee in Solana and earn real money per kill.

**Status: Phase 2 — movement and shooting.** Playable: WASD to move, mouse to
look, space to jump, click to shoot. Click the canvas to capture the mouse and
Escape to release it. Money is not wired in yet; that is Phase 3.

Because this game pays out real money, correctness and fairness rank above
visual polish everywhere in this codebase.

## Layout

```
crates/solatel-protocol   shared wire format, money type, economy constants
crates/solatel-server     authoritative server: axum + websockets + postgres
crates/solatel-sim-wasm   the shared movement simulation, compiled for the browser
client/                   three.js browser client; ./x client bundles it
assets/                   models the client loads at runtime
migrations/               ledger schema
scripts/                  build and test scripts (run via ./x)
web/                      page shell; ./x client builds into web/dist
```

`solatel-protocol` is the reason the two sides agree with each other. The server
is authoritative over movement, hits, and money, so it must re-evaluate the same
rules the client predicted with. Keeping the wire format, the economy constants,
and the movement simulation in one crate means there is exactly one definition
of how a player moves.

The client is JavaScript, so it cannot compile that crate directly - it calls
it. `solatel-sim-wasm` wraps `solatel-protocol::sim` for the browser, and the
client predicts through it. That is fifty kilobytes of wasm, and it is what
keeps prediction honest: the alternative was translating the movement into
JavaScript and hoping two descriptions of it stayed in step, in a game that pays
per kill. Rendering, input, assets and everything else are ordinary JavaScript.

## The maps and the models

The client draws three models from `assets/`: a soldier for other players, a
rifle for your own hands, and the map itself. `ATTRIBUTION.md` records where
each came from and under what licence, and `scripts/prepare-assets.py` records
what was done to it.

There are two maps. `arena` is a 34 by 66 metre deathmatch box; `yard` is 116
by 252 metres of open ground. The server picks one at startup:

```
SOLATEL_MAP=yard ./x server
```

Add `SOLATEL_MAP_SWITCH=1` and the settings panel grows a map picker, which
ends the round and reloads everyone onto the other map. It is for looking at
the maps, not for playing: leave it off anywhere real.

Every spawn on a map is reachable on foot from every other, which
`every_spawn_can_reach_every_other` checks by walking the map with the real
collision resolver rather than by reasoning about the brush table.

and names it in the handshake, so the client loads the model the server is
actually colliding against rather than whichever one it happened to cache.

The maps are the interesting part, because the server has to collide against
whatever the client draws. The collision brushes in
`solatel-protocol/src/sim/map.rs` are therefore *generated* from the same
models:

```
./x maps            # both, into map.rs
./x maps yard       # just one, leaving the other table alone
```

It voxelises the art, turns each blocked column into a box, and refuses to emit
a table that would fail the invariants in `map.rs`. `scripts/check-collision.py`
then measures the result against the model: how much of the wall a player can
walk up to has nothing behind it. Both maps are currently at or under a tenth
of a per cent. Edit a model and
regenerate; do not hand-edit the table, and bump `MAP_VERSION` when you do, so
a stale cached client is told to reload rather than quietly colliding against a
different map.

The yard takes a few minutes, almost all of it voxelising a quarter of a
million square metres at 0.25 m. The arena takes two seconds.

Everything the art blocks at player height is solid, down to a quarter-metre
cell — there is no size threshold. An earlier version left barrels and loose
crates out to keep the table short, and the result was that 27% of what a player
could see had nothing behind it, including the inner faces of the arena's own
walls. It is still a height field, so you can walk into the building in the
middle of the map but not stand on its roof, and you cannot walk *under*
something you can climb onto.

Only the map being played is downloaded. Both ship with their normals and
texture coordinates stripped, because neither file has a texture in it and the
client flat-shades every map material - that alone is more than half of the
yard's bytes.

## Getting started

The Rust toolchain runs in a container — this machine has no MSVC linker, and
the server deploys to Linux regardless. You need Docker running, and a `.env`
(copy `.env.example`) with a `DATABASE_URL`.

```
./x image      # build the toolchain image (first-time setup, a few minutes)
./x client     # build the browser client into web/dist
./x watch      # rebuild the client's JavaScript on every change
./x server     # run the server on http://localhost:8080
./x test       # workspace test suite
./x ledger     # ledger invariant tests against a throwaway postgres
./x check      # rustfmt + clippy
./x db         # psql shell on DATABASE_URL
```

`./x client` does three things in two places: the shared simulation compiles to
wasm in the container, esbuild bundles the JavaScript on the host, and the models
are copied in. Only the first needs Rust. While working on the client, leave
`./x watch` running and reload the page.

`node client/smoke.mjs --tabs 2 --shot out.png` loads the client in a real
headless browser and reports whether the wasm instantiated, the models parsed,
WebGL came up and the socket reached the server - the failures that otherwise
present as "the page is blank".

Then open <http://localhost:8080> and click to capture the mouse. The HUD shows
link state, ping, and the current prediction error in metres — a number that climbs means client and
server are drifting, which is the thing the shared simulation exists to prevent.
`/health` reports database liveness and whether the ledger reconciles.

## How the money works

Every amount in the system is an `i64` count of **micro-USD**. No floats touch
the ledger.

The entry fee is charged **per life**, not per match. That is what makes a
continuous-cycle match self-funding:

```
one death  =>  $1.00 in  =>  $0.90 to the killer + $0.10 to the platform
```

Under a per-match fee with free respawns, payouts scale with kills while income
stays fixed at a dollar per player, and a skilled player drains the treasury.
`solatel-protocol/src/economy.rs` asserts this relationship at compile time.

The ledger is an append-only double-entry journal. There is no mutable balance
column: a balance is the sum of immutable entries, and `ledger_account_balances`
is a cache that can be rebuilt from them at any time. The database itself
enforces the rules, so a bug in application code cannot corrupt the books:

- every transaction's entries must sum to exactly zero (deferred to `COMMIT`)
- entries cannot be updated or deleted — corrections are reversing transactions
- player balances and escrow cannot go negative
- every money-moving transaction carries a unique idempotency key, so a
  reconnect or a retried event cannot double-pay
- a paid life sits in `match_escrow` from spawn until the life ends, so
  "disconnected while still alive" is a known amount of money, not a hole

`./x ledger` asserts all of the above, including that the database refuses a
one-legged credit, an overdraft, an edit to history, and a replayed idempotency
key.

## How the netcode works

The server simulates at 64 Hz and broadcasts snapshots at 20 Hz. Three pieces
make that feel instant without giving up authority:

**Prediction.** The client runs the same movement code over its own input the
moment you press a key, so your own movement never waits for a round trip.

**Reconciliation.** Every input carries a sequence number. Snapshots report the
newest one the server consumed. The client adopts the server's state and
re-applies whatever it has not seen yet. Because both sides run the identical
code from `solatel-protocol::sim`, the result normally matches what was already
drawn and nothing visibly moves.

**Lag compensation.** You shoot at where someone *was*, not where they are —
your ping plus the client's interpolation buffer. So the server rewinds other
players by exactly that much before tracing the shot. Without it, hitting a
moving target would mean leading it by an amount that varies with your ping, and
worse connections would be systematically robbed. The rewind is capped at 300 ms,
and the round-trip time is measured by the server with websocket ping frames —
never reported by the client, which would otherwise be a way to buy extra rewind.

Two limits exist purely because this game pays money:

- Input is clamped server-side (`InputCommand::sanitized`), so a client sending
  `forward: 1e30` or a NaN yaw achieves nothing.
- Input consumption is budgeted against elapsed ticks, not just per tick. A
  client that floods commands keeps its queue full, and a naive per-tick
  catch-up allowance would hand it double speed forever.

## Phases

1. ~~Scaffolding — wasm client, server, database, websocket round trip.~~
2. **Movement and shooting, server-authoritative, with client prediction.** *(current)*
3. Match lifecycle and the live ledger.
4. Solana wallet connect and withdrawals — devnet only until Phase 1–3 are solid.
5. Anti-cheat foundations.
6. Polish and launch prep.

## Open decisions

- Payment processor: Plisio vs NOWPayments (PRD §7).
- Referral bonus mechanics.
- No geo-gating or KYC is currently planned. That is a deliberate product stance
  in the PRD rather than an oversight, but it is the project's largest
  non-technical risk, so the withdrawal path should keep those hooks available.
