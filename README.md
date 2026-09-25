# Solatel

A browser-based, skill-based multiplayer shooter where players pay a small entry
fee in Solana and earn real money per kill.

**Status: Phase 4 — the wallet, on Solana devnet.** The game opens on a menu:
pick a map and a table, wait in line, and play one life for your stake. WASD to
move, mouse to look, space to jump, click to shoot; Escape releases the mouse.
Matches, stakes, kill rewards and the ledger are live. Deposits and withdrawals
in SOL are built and run against devnet only.

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
by 252 metres of open ground. The server runs both at once, and players pick a
map and a stake from the menu.

Every spawn on a map is reachable on foot from every other, which
`every_spawn_can_reach_every_other` checks by walking the map with the real
collision resolver rather than by reasoning about the brush table.

A match names its map when it starts, so the client loads the model the server
is actually colliding against rather than whichever one it happened to cache.

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

On Windows the Rust toolchain runs in a container — there is no MSVC linker,
and the server deploys to Linux regardless. You need Docker running, and a
`.env` (copy `.env.example`) with a `DATABASE_URL`.

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

To start a match on your own, with nobody else queueing:

```
SOLATEL_MATCH_FLOOR=1 SOLATEL_QUEUE_WAIT=3 ./x server
```

Then open <http://localhost:8080>, pick a map and a table, and click the game to
capture the mouse once the match starts. The HUD shows
link state, ping, and the current prediction error in metres — a number that climbs means client and
server are drifting, which is the thing the shared simulation exists to prevent.
`/health` reports database liveness, whether the ledger reconciles, what is in
escrow, and the wallet's figures.

**In a Claude Code on the web session** there is no Docker, and
`.claude/hooks/session-start.sh` sets the machine up instead (wasm-bindgen, the
npm packages, a local Postgres). Run the tools directly:

```
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bash scripts/build-sim.sh && npm --prefix client run build && bash scripts/copy-assets.sh
cargo run -p solatel-server
```

The end-to-end drivers `client/duel.mjs`, `client/survive.mjs` and
`client/menu.mjs` run against a live server started with the two variables
above.

## How the money works

Every amount in the system is an `i64` count of **micro-USD**. No floats touch
the ledger.

**One entry fee buys one life in one match. There is no respawn.** Pick a
table - $1, $2, $5 or $10 - and a map; the lobby starts a match when the table
fills, or after two minutes with at least four in line. Several matches run at
once, at every stake.

A kill moves the victim's stake and only that: the reward to the killer, ten
percent to the platform.

| stake | reward per kill | rake |
|---|---|---|
| $1 | $0.90 | $0.10 |
| $2 | $1.80 | $0.20 |
| $5 | $4.50 | $0.50 |
| $10 | $9.00 | $1.00 |

Winnings and the stake are separate and never netted. Winnings are posted to
the wallet as each kill happens, so they are the player's by the time anything
else does. The stake leaves escrow exactly once:

| what happened | the player gets | the platform gets |
|---|---|---|
| killed | nothing - the killer gets the reward | the rake |
| alive at the whistle | the whole stake back | nothing |
| walked away mid-match | the reward | the rake |
| the match never formed | the whole stake back | nothing |

`solatel-protocol/src/economy.rs` asserts at compile time that every table
divides exactly.

The ledger is an append-only double-entry journal. There is no mutable balance
column: a balance is the sum of immutable entries, and `ledger_account_balances`
is a cache that can be rebuilt from them at any time. The database itself
enforces the rules, so a bug in application code cannot corrupt the books:

- every transaction's entries must sum to exactly zero (deferred to `COMMIT`)
- entries cannot be updated or deleted — corrections are reversing transactions
- player balances and escrow cannot go negative
- every money-moving transaction carries a unique idempotency key, so a
  reconnect or a retried event cannot double-pay
- a stake sits in `match_escrow` from the buy-in until it settles, so
  "disconnected while still alive" is a known amount of money, not a hole

`./x ledger` asserts all of the above, including that the database refuses a
one-legged credit, an overdraft, an edit to history, and a replayed idempotency
key.

**Money in and out is Solana, devnet only.** A player sends SOL to one treasury
address with their player id as the memo, and the server credits it once the
transfer is final. Withdrawals leave the wallet the moment they are asked for
and are returned if the chain never takes them. The rate is fixed by
configuration (`SOLATEL_SOL_USD`) rather than read from a market; Plisio is the
planned gateway for real money. A player is an **account key** kept in the
browser, which is what makes a balance outlive a closed tab. `CLAUDE.md` has
the details of both.

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
2. ~~Movement and shooting, server-authoritative, with client prediction.~~
3. ~~Match lifecycle, the lobby and the live ledger.~~
4. **Deposits and withdrawals — devnet only.** *(current)* Built; waiting on an
   end-to-end run with real devnet SOL. Then Plisio, and signing in with a
   Solana wallet in place of account keys.
5. Anti-cheat foundations.
6. Polish and launch prep.

## Open decisions

- The rifle model and the yard map have unconfirmed licences
  (`scripts/asset-licence.py`) and must not ship until they are settled.
- Referral bonus mechanics.
- No geo-gating or KYC is currently planned. That is a deliberate product stance
  in the PRD rather than an oversight, but it is the project's largest
  non-technical risk, so the withdrawal path should keep those hooks available.
