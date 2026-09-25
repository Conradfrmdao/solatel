# Handoff: Solatel, 2026-09-25

You are taking over Solatel from a Claude Code session that ran on Conrad's
Windows machine. Read this whole file, then `CLAUDE.md` (the authoritative
working notes; its rules are not negotiable), then start on the task list.
Everything described here is committed at `9bff08c` on `main`.

## What Solatel is

A browser first-person shooter where players pay a real-money entry fee and
earn money per kill. Three.js client, Rust server (axum + websockets), a
movement simulation shared by both (compiled to wasm for the browser), and an
append-only double-entry ledger in Postgres (Neon, managed). The owner is
Conrad. He writes fast and informally. When he asks for an explanation, give
it in simple terms. When he says "tell me if you understand first", do that
before building.

## Rules that are never broken (details in CLAUDE.md)

- **The server is authoritative.** The client sends inputs and renders
  predictions. It never reports a position, a hit, a kill or a balance, and it
  never computes money. It formats what the server sends.
- **Money is `MicroUsd` (`i64` micro-USD). No floats anywhere**: not in the
  database, the protocol, or intermediate arithmetic. Parse decimal text
  digit by digit (see `wallet::parse_decimal`, `menu.js parseDollars`).
- **The ledger is append-only and every transaction balances.** All legs go in
  one database transaction. Corrections are new transactions, never edits.
  Every money movement has an idempotency key. After touching `migrations/`
  or the statement `ledger::post` sends, run the ledger invariant tests
  (`scripts/test-ledger.sh`).
- **Solana stays on devnet** until Conrad explicitly says otherwise.
  `solana::Cluster::devnet()` is the only cluster, and nothing may be able to
  move mainnet funds by accident.
- **Protocol changes bump `PROTOCOL_VERSION`** (currently 10) in the same
  commit.
- **Never commit secrets.** `.env` is gitignored and never in the repo.
- The rifle model (`assets/weapons/rifle.glb`) and the yard map have
  unconfirmed licences. `scripts/asset-licence.py` flags the rifle. They must
  not ship until the terms are confirmed.

## The game as Conrad has decided it

- **One entry fee buys one life in one match. No respawn.** Killed means out.
  The player is back in the lobby instantly and may pay to queue for another
  match.
- **Winnings and the entry fee are separate things. Never net them.** Winnings
  are kills × the reward, posted to the wallet as each kill happens. A kill
  moves only the victim's entry fee: reward to the killer, rake to us.
  - Survive to the whistle: the entry is refunded, and winnings are kept.
  - Killed: the entry is gone, and winnings are kept.
  - Disconnect: the body stays shootable for 45 s. Killed inside that window,
    the killer claims the stake. Otherwise the player gets the reward back and
    we keep the rake.
- **Tables:** $1, $2, $5, $10. **The rake is 10% at every tier**
  ($0.90/$0.10, $1.80/$0.20, $4.50/$0.50, $9.00/$1.00 per kill/rake).
- **Lobby (Call of Duty style, free-for-all):** many matches run at once in
  one process, including several at the same stake. A table is a map plus a
  stake. The arena seats 20 and the yard 30, and spawns are shuffled per match.
  A full table starts at once. Otherwise it starts after 2 minutes if at least
  4 are in line; under 4 it keeps waiting. Conrad withdrew an earlier 10-player
  minimum, so 4 is the floor.
- **Menu first:** a black screen with play (map, then table), wallet, profile
  and settings. The 3D world loads only when a match starts.
- **Money in and out:** Solana devnet, native SOL, **one shared treasury
  address plus a memo** (the memo is the player id). The rate is **fixed by
  configuration, `SOLATEL_SOL_USD=140`**. This was Conrad's choice ("option 1").
  It means we eat the difference from the real price. **Plisio** becomes the
  real gateway later.

## Running it in the cloud

`CLAUDE.md` says there is no Rust on the host and to use `./x`. That is about
Conrad's Windows machine: `./x` wraps everything in a Docker toolchain
container. On Linux, run the tools directly if they are present (install
`rustup` if not; `rust-toolchain.toml` pins the version):

```
cargo test --workspace                                            # 163 tests at 9bff08c
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
bash scripts/test-ledger.sh      # needs Docker (throwaway postgres:17). Without Docker,
                                 # apply migrations/*.sql to a local Postgres and run its SQL.
bash scripts/build-sim.sh        # wasm sim (wasm32 target + wasm-bindgen), then:
npm --prefix client ci && npm --prefix client run build && bash scripts/copy-assets.sh
cargo run -p solatel-server      # serves web/dist on :8080
```

Environment variables the server needs. Conrad sets these in the cloud
environment's settings. Never write their values into a file or a commit:

- `DATABASE_URL`: Neon Postgres
- `SOLATEL_TREASURY_KEY`: the devnet treasury secret. Public address:
  `5du3i7LTZa3dNPdG6Hthzo5v2ACL9yDKkpAgKe2CuUk2`
- `SOLATEL_SOL_USD=140`: required whenever the treasury key is set
- `SOLATEL_DEV_PAYER_KEY`: devnet payer for test deposits. Address:
  `4oCUSZdLSzTEZVRXoZMqY4o3dQdy57vgTCRAbkqKt1Wq` (currently 0 SOL)
- `SOLATEL_DEV_GRANT=20`: funds new players once, for development.
  **Withdrawals are refused while this is set, by design.**
- For testing alone: `SOLATEL_MATCH_FLOOR=1 SOLATEL_QUEUE_WAIT=3`

End-to-end drivers (Node plus a local Chrome; `puppeteer-core` needs a Chrome
path, so adjust the `CHROME` lists for Linux):
`client/menu.mjs`, `client/resume.mjs`, `client/duel.mjs`,
`client/survive.mjs`, `client/smoke.mjs`.

## What was built in the last session (all in 9bff08c)

**Accounts** (`crates/solatel-server/src/account.rs`, migration 0005). A
balance hangs off a `PlayerId`, and until this session that id lasted only as
long as the browser tab, so a deposit would have been lost when the tab
closed. Now:

- A browser holds a 32-byte base58 **account key** in `localStorage`
  (`solatel.account`). The `Welcome` hands it over only when an account is
  made, and the database stores only its SHA-256 (`players.account_key_hash`).
- The `Hello` carries `account`. `ws.rs` signs the connection in before the
  lobby hears of it, and a missing or unknown key makes a new account.
- The account says *who* the player is; the resume token (`sessionStorage`,
  per tab, single-use) says *which body*. A token is honoured only for its own
  account.
- A second tab on the same account takes the player over. The first tab gets
  `Rejected` with `TAKEN_OVER` and **stops reconnecting**, shown as "you are
  playing in another tab / play here instead" in the menu.
- The profile pane shows the player id and the key (hidden until asked), with
  a warning, and a form to sign in with a saved key.

**Wallet** (`wallet.rs`, `ledger.rs`, `solana.rs`, migrations 0004 and 0005).

- **Deposits.** A watcher polls the treasury's *finalized* history every 5 s,
  pages until it reaches a signature it has already judged, and judges each
  new one exactly once into `treasury_receipts`: `credited`, `unmatched` (the
  memo names nobody), `too_small`, or `not_incoming`. A credit posts
  `external → player` under the key `deposit:<signature>`, in the same DB
  transaction as the receipt. The memo parser is lenient about text around a
  UUID, and it was checked against a real devnet memo transaction's format.
- **Withdrawals, in three ledger steps.**
  1. Requested: `player → treasury` under `withdraw:<id>`, on the sequential
     ledger queue, so it cannot race a match buy-in.
  2. The wallet loop signs it and **records the signature before sending**.
     Resending the same bytes is safe.
  3. Once finalized on chain: `treasury → external` (`withdrawn:<id>`, kind
     `withdrawal_sent`). If it failed, or expired past its last valid block
     height plus 32, the money goes back: `treasury → player`
     (`withdraw-returned:<id>`, kind `withdrawal_returned`).

  Rules checked before the ledger sees a request: minimum $5; a valid base58
  address that is on the ed25519 curve; not the treasury itself; at least the
  rent-exempt minimum; a 5 s cooldown per player; refused while the dev grant
  is on. The treasury keeps its rent-exempt minimum plus the fee, or the
  withdrawal is returned with a reason.
- **Conversions** round down in both directions (`SolUsd::micros_for`,
  `lamports_for`).
- **Protocol v10:** `ClientMsg::Withdraw`, `ServerMsg::{Deposited, Withdrawal,
  WithdrawalRefused}`, `Welcome.{account_key, wallet: WalletTerms}`.
- **Menu wallet pane:** a devnet banner; the address and memo with copy
  buttons; the rate stated as fixed; a Solana Pay link; a CLI command; the
  withdraw form with an "all of it" button; recent activity with explorer
  links.
- `/health` has a `wallet` block (treasury lamports and value, what is owed,
  the rate).
- `./x pay` creates a devnet payer. `./x pay <memo> <sol>` sends a deposit
  with a memo, because most wallets have no memo box.

**Fixes found in the bug sweep:**

- Reloading mid-match stranded the player on the menu while their body stood
  in the match. The server now re-sends `MatchStarted` on takeover.
- The balance and recent withdrawals are re-read on every rejoin.
- The escrow sweep now only judges current-format keys (`entry:<match>`).
  Older key formats produced a false ERROR on every boot.
- The `./x` help had an uncommented line that ran `./x treasury` on every
  invocation.
- `./x` passed a POSIX `--env-file` path that Docker on Windows cannot open.
- `./x server` forwards `SOLATEL_MATCH_FLOOR` and `SOLATEL_QUEUE_WAIT`
  (instead of the removed `SOLATEL_MAP`) and needs no TTY.
- The spawn test checked against a stale global 10 instead of each map's
  seats. Dead `INTERMISSION` and `MATCH_MIN/MAX_PLAYERS` were removed.

**Verified at that point:**

- 163 Rust tests; clippy and rustfmt clean.
- 42 ledger invariant checks, including deposit replay, the three withdrawal
  steps, an overdraw refused, and the new table constraints.
- `menu.mjs` passes: account persistence across closing a tab, takeover,
  wallet pane, queue → match → arena drawn.
- `resume.mjs` passes (rewritten for menu-first): same player, same match,
  0.00 m drift.
- Live devnet: a memo transfer from the unfunded payer got through the
  cluster's format and signature checks and failed only at `AccountNotFound`
  (no funds), which proves the hand-rolled wire format.

## Task list, in order

**1. Fix the stale end-to-end drivers (a real failure, found last).**
`client/duel.mjs` sends `{t:'queue', tier_dollars}` without `map`, a field
required since tables became map plus stake. The server logs `missing field
\`map\`` and drops the connection, so all 13 clients never get into a match.
Send `map` (take `welcome.maps[0].name`, or `'arena'`). Check
`client/survive.mjs` for the same bug. Run both against a server with
`SOLATEL_MATCH_FLOOR=1 SOLATEL_QUEUE_WAIT=3`. `duel.mjs` must show a pot of
$13.00, a kill paying $0.90 that takes nothing from the victim, the victim
unable to rejoin, and the pot falling by exactly $1.00. `survive.mjs` takes a
full 5-minute match: the survivor ends at +$1.00 (stake refunded).

**2. Watch ledger-queue latency when many players arrive together.** Every
arrival queues a `ReadBalance` on the one sequential ledger task (it has to
stay ordered behind payouts; see `ledger.rs`). Against Neon each took
2.5–3.5 s (about 5 round trips: account upsert, id, balance, recent
withdrawals). Thirteen simultaneous arrivals backlog about 39 s, which is more
than `FORMING_TIMEOUT` (30 s), so a buy-in queued behind them can land after
the match has started without them (they get refunded, but miss the match).
Measure with `duel.mjs` once task 1 is done. If it bites, collapse
`ReadBalance` into one statement (a CTE that upserts the account and returns
the balance plus recent withdrawals); do not move it off the queue.

**3. A real devnet deposit and withdrawal, end to end.** This is blocked on
devnet SOL: the RPC faucet returns 429 for our IP. Ask Conrad to fund the
payer `4oCUSZdLSzTEZVRXoZMqY4o3dQdy57vgTCRAbkqKt1Wq` at faucet.solana.com. Then:

- `./x pay <player-id-from-the-menu> 0.5` (or `cargo run -p solatel-server --
  pay …`). The server should log "deposit credited" about 15 s after
  finality, and the menu should show the deposit and the new balance. That
  also funds the treasury.
- For withdrawals, unset `SOLATEL_DEV_GRANT`, restart, and withdraw at least
  $5 to a devnet address. Watch requested → sent → settled in the menu and in
  the `withdrawals` table, check the explorer link, and confirm the ledger
  reconciles (`/health`).
- Also test the return path (a treasury too short to pay is returned with a
  reason) and a deposit whose memo names nobody (`unmatched`, not credited).

**4. The $4.00 stuck in escrow on the dev database. Needs Conrad's approval;
do not post it without that.** The stake `entry:81978025-91e4-4c4f-b92d-729468ff5c30:1`
($5, from an old per-life code path) was settled by the old code as a $1
walk-away ($0.90 back, $0.10 rake). The correct $5 walk-away is $4.50 back
and $0.50 rake. The correction is one `adjustment` transaction with a reason:
`match_escrow −4,000,000`, that player's balance `+3,600,000`,
`platform_revenue +400,000`, under a key such as
`correction:forfeit:81978025-91e4-4c4f-b92d-729468ff5c30:1`. That player id
predates accounts, so nobody can sign in as it; this only makes the books
right.

**5. Documentation.**

- `CLAUDE.md`, Assets section: the paragraphs about `SOLATEL_MAP`,
  `map::select` refusing to change, `map::switch` being server-only, and
  `SOLATEL_MAP_SWITCH` are all stale. The server runs every map at once, and
  the wasm client calls `map::switch` between matches only.
- `CLAUDE.md`: add sections for **Accounts** and **The wallet** (everything
  above), and update "A player who reloads" (account key vs resume token,
  takeover parking, the `MatchStarted` rejoin).
- `README.md` is badly stale (it says "Phase 2", a per-life fee, and
  `SOLATEL_MAP`). Rewrite its money section to the per-match economy and its
  run instructions.
- The doc comments on `map::select`/`map::switch` in
  `crates/solatel-protocol/src/sim/map.rs` are stale. `select` is now used
  only by its own test; remove it or document it honestly.

**6. The rest of the bug sweep.**

- `room_0` in the arena has its own floor at y=0 that z-fights inside that
  building. Hide it in `scripts/extend-arena.py`, run `./x maps`, and bump
  `MAP_VERSION`.
- Asset licences are unresolved (see above).
- The `brushes` field in `menu.mjs` is unused.
- A few `ledger.rs` docstrings still say "life" where they mean "stake".

**7. Next features, when Conrad asks.**

- **Plisio** as the real gateway behind the same interface. It needs an API
  key and a public callback URL from Conrad.
- A Solana Pay QR code in the deposit pane.
- **Sign in with the Solana wallet** (`players.solana_pubkey`) to replace
  account keys, which are the weakest part of the wallet: lose the key, lose
  the balance.
- Before running more than one server process, give each its own escrow
  account or a lease on the startup sweep (see "The lobby" in CLAUDE.md).

## How to finish anything

Run the tests and clippy. Run the ledger invariant tests after any ledger or
migration change. Run the relevant end-to-end driver against a live server.
Then report to Conrad plainly: what changed, what you ran and what it showed,
and anything you could not do and why. Commit with a clear message. Push only
when he says so.
