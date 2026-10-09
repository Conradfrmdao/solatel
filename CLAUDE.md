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
`cargo run -p solatel-server`.
`.claude/hooks/session-start.sh` installs what is missing and starts a local
Postgres (`postgres://solatel:solatel@localhost:5432/solatel`, exported as
`DATABASE_URL` unless the environment sets one). It cannot reach Neon: its
network passes web traffic only, and a Postgres connection is not.
`bash scripts/test-ledger-local.sh` runs the ledger invariant tests against
that Postgres instead of a container, and `cargo test -p solatel-server --
--ignored` runs the tests that need a database (they make their own players
and touch nobody else's rows).

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
for. Splitting later means an escrow account per server, and that is the
work to do *first*.

**The lease is what enforces one owner until then** (`lease.rs`, migration
0007). Before the ledger touches escrow a server takes the `escrow` row of
`escrow_lease`, renews it every ten seconds and releases it on a graceful
shutdown. A second server waits up to ninety seconds for it to lapse - a
crashed holder's does within thirty - and then refuses to start, naming the
holder. A server that finds its lease taken, or cannot renew it before it
would lapse, exits: its stakes are then orphans for the next owner to settle,
which is the safe side to be wrong on. A row with a heartbeat rather than an
advisory lock, because an advisory lock belongs to one session and Neon's
pooled endpoint does not keep one. Free play takes no lease.

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

### Found, loading, warm-up

What every matchmaker does between the click and the fight, in the order
they all do it, and what each step is here:

1. **Searching** - `matchmaking.js`, over the menu. The table, a clock since
   the click, how full the table is, the player's place, when it starts short
   of full (only when that is a real clock - under the floor it says how many
   more are needed), the price and that nothing is charged yet, and *leave
   the line*. It is up the moment play is pressed, before the server
   has answered, and gives up on a request nobody confirmed after four
   seconds.
2. **Match found** - `ServerMsg::MatchFound`, sent the instant a line becomes
   a match and *before* any money moves, with a chime. Without it the queue
   went quiet for as long as the buy-in took and then a map appeared. The
   splash is held for at least 1.6 s so it is seen even when the database
   answers in milliseconds - which costs nothing, because of step 4.
3. **Loading** - the same card, saying which map, until the world is drawn.
   A map is tens of megabytes, so its files are fetched into the browser's
   cache the moment play is pressed (`prefetch.js`), while the player
   waits in line, and the card counts them in megabytes - in line as a
   footnote, on the loading card as the bar. Which files a map needs is
   read from its glTF's JSON: the material names say which photographs,
   the scene extras whether it grows trees and grass. **The card stays up
   until the map can be drawn, not merely until it is in** (`prepareToDraw`
   in `main.js`): every shader compiled with `compileAsync`, the other
   players' soldier and rifle and a grenade's blast put in for the purpose,
   then one frame drawn behind the card for the shadow map's depth shaders,
   the post chain and the texture uploads. The first frame used to do all of
   that - seconds of black canvas through ANGLE on Windows, with the
   countdown running underneath: Conrad's countdown appeared at five. Then
   the client sends `Loaded` (protocol 17).
4. **Waiting for everybody's map** - the warm-up's countdown starts when the
   last player in the match has said `Loaded`, or after `LOAD_WAIT` (30 s,
   `SOLATEL_LOAD_WAIT`) so one machine that never finishes cannot hold the
   rest; nobody who has dropped is waited for, and a `Loaded` counts only
   from the socket playing that match. `Snapshot::loading` is how many are
   still loading; while it is above zero `starts_in_ms` is the whole warm-up
   and does not count, and the HUD says who it is waiting for.
5. **Warm-up** - `WARMUP`, twenty seconds (Conrad asked for at least
   sixteen of countdown he could see), `SOLATEL_WARMUP` to change it, and
   **spent together**: everybody stands on the map's gathering ground
   (`GATHERINGS`, its most open place - the yard's is the strip behind its
   south fence, where Conrad was put and asked everybody to be), on a grid
   1.6 m apart, so a match is seen to be full of people. They may walk, jump
   and crouch among each other; the server zeroes fire, throw and reload
   (`Hold::Gathered`), nothing can hurt anybody, and a fall puts a body back
   rather than ending it. When the countdown ends `disperse_if_live` puts
   each on their own spawn, facing its way, with no motion, guess or history
   carried over - so wandering bought nothing - and the client faces the
   spawn on the first snapshot that has it there. A map with nowhere to
   gather would hold everybody still on their spawns instead (`Hold::Still`),
   or the warm-up would be a head start; `Snapshot::gathered` tells the
   client which, so it predicts what the server will do. Another player who
   moves further between two snapshots than anybody can run (`TELEPORT`) is
   drawn there, not slid across the map. `Snapshot::starts_in_ms` counts it
   down; the match clock and the circle start when it ends
   (`Match::elapsed` is time since *live*). The HUD shows the count, ticks
   the last three seconds and says GO - but only when a snapshot says the
   match is live, never when the local count reaches zero, so a player
   starts a hair late rather than early and never rubber-bands.

It is also what makes loading fair: a match that went live when its map
arrived would start with whoever loaded fastest already moving.

The tests run with no warm-up and no wait for maps (`free_play` and `Paid`
set both to zero) except the ones about them; a match with no warm-up does
not gather. Every end-to-end driver sends `loaded` the moment its match
starts - it has no map to load - and waits for `starts_in_ms` to reach zero
before it does anything, because anything sent in the warm-up is discarded
- a speed check run during it would prove nothing.

### A table is a map and a stake

**There is no server-wide map.** A `Match` holds its own `&'static Map` and
several run at once on different ground, so every line is keyed on a map *and*
a stake: somebody who asked for the arena is not served by being put in the
yard. `SOLATEL_MAP`, `SOLATEL_MAP_SWITCH` and the whole `switch_map` message
are gone with it - they existed because one process ran one map, and it does
not.

`Map::max_players` - **20 on the arena, 30 on the yard and the facility** -
because it is a property of the ground rather than of the game: the yard is
252 metres across and swallows thirty, while thirty in the arena would be a
scrum.

There are deliberately **more spawn points than seats** (28, 42 and 44), and
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

**It looks like Conrad's key art**, at his asking, laid out after the
mockup he sent: night navy, the sunset's amber, the wordmark's worn white.
The art itself (`assets/menu/splash.webp`, cropped from his picture, logo
and all) is the boot screen, there before any script runs; a band of it
without the logo heads the play pane and the matchmaking card; its soldier
is behind the slogan. The wordmark in the top bar is `assets/menu/logo.svg`,
drawn by `scripts/build-logo.py` from Orbitron's letters with the peaked A
and its orange triangle, worn by an SVG filter. Headings are Saira Condensed
and text is Barlow, shipped in `assets/fonts` (OFL, `assets/fonts/OFL.txt`).
**The page's own styles name files by plain name** - `url(assets/menu/...)`
- and `client/build.mjs` rewrites each to its published name, failing on one
it did not publish, which is what lets the splash be in CSS. The map cards
are our own maps photographed from above (`assets/menu/map-*.webp`), not
paintings of them.

Six panes: **play**, **deposit** (the wallet), **leaderboard**, **profile**,
**fair play**, and **settings** behind the gear. Play is "choose your
battle": a map card, an entry fee, then **Play** - selecting a fee does not
join a line; the button does, and says what it will join ("Play $1 ·
arena"). The fee last chosen is remembered per browser. The settings moved here from the HUD - they belong on a screen you go to
between matches, not over your crosshair - though the wiring stayed in
`hud.js` and looks them up in the document. The menu is therefore built before
the HUD, or the HUD looks for sliders that do not exist yet.

**Nothing on it is made up.** The mockup had levels, missions, rewards and a
store; none exist, so none are drawn - a real-money game that showed
invented features, or an invented win in its feed, would be lying about
money. "Most popular" is the map with the most players in line and playing
right now, when anybody is. The feed and the leaderboard are real (below).

**Only the canvas takes the mouse.** `input.js` used to capture the pointer on
any click outside a short list of exceptions, which made the menu unusable
past its first press: the first click locked the pointer to the canvas and
every click after it landed there instead of on the button aimed at. It now
tests for the canvas rather than listing the things to stay off.

**A player's balance is asked for when they arrive** (`LedgerRequest::
ReadBalance`), so the wallet reads `$0.00` rather than a dash. A menu that
shows a dash cannot tell "you have nothing" from "we have not looked".
On a server handing out development money the purse wears a **test** tag
and the wallet says the first match brings test money, both from `/proof`,
read when the menu is built: a balance on a public test server must never be
taken for real money.

**Fair play is the proof, and the credits.** Early players of a real-money
game expect to be farmed, and the PRD's answer is visible proof of payouts.
The pane shows what `/proof` returns - paid for kills, withdrawn to wallets
with each landed withdrawal's signature linked to the explorer, stakes handed
back, the best single life, who played today, and the house cut, all told -
then the rules that make it fair, a plain list of what is not built yet, and
the credits, which carry the arena's CC-BY-4.0 notice as ATTRIBUTION.md gives
it. A devnet server, or one handing out development money, says so above the
figures, so a test total is never read as real money.

`/proof` (`proof.rs`) is public, unauthenticated and readable from any origin,
so it names nobody: totals are facts about the game, and who earned them is a
fact about a person. Every figure is one statement's sum over the ledger's own
legs by transaction kind - not a counter kept beside the ledger, which could
disagree with it - and the answer is cached for a minute, so a crowd costs one
query. Adding a figure means adding it to that statement and to its test,
`the_record_moves_by_exactly_what_a_kill_pays`.

**The live feed and the leaderboard name people, so they are a different
endpoint**: `/board` (`board.rs`), with no cross-origin header, for the
game's own menu. The feed is the newest lives that won something ("Name won
$1.80 on yard"), the board the week's biggest winners by what their kills
paid, both one statement over `match_lives`, cached fifteen seconds. Names
are display names - chosen by their players and shown to everybody they play
against already - stored on each life as the match had it when it formed
(migration 0014, `Life::name`), so an abandon settling after its owner has
gone still has one; lives from before that read "a player". No id, account
or wallet is in it. Its test, `the_board_adds_up_what_each_name_won`, takes
its own lives out again, because their winnings are far above any table's.

`node client/menu.mjs` drives the whole thing in a real browser: that the menu
is what a player lands on, that every tab opens and the leaderboard loads,
that the wordmark and the art are there, that picking a fee joins nothing
and the play button names what it will join, that queueing does not steal
the mouse, and that playing drops them into a match on the map they chose
with the world actually drawn. It needs `SOLATEL_MATCH_FLOOR=1` and a
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
- `node client/survive.mjs` - a client buys in, survives the whole match,
  and gets its stake back at the whistle. It takes `MATCH_DURATION` to run
  and there is no way to hurry it from a client, which is correct. Nobody
  shoots, but the circle burns: each survivor walks into the final circle
  by a route found with the real simulation (the wasm, loaded in Node) and
  stands there. Heading blind for the middle left one stuck behind a wall,
  burned to death in a match nobody shot in.

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

### Signing in with a Solana wallet

On its own the key is the weakest part of the wallet: lose it and the balance
goes with it. So an account can carry a Solana wallet (protocol 14, migration
0008), and signing in with that wallet from any browser is being that player.

- **The server writes what is signed.** `WalletChallenge` gets text naming
  the site (the upgrade's `Host`, filtered), the account, a nonce and the
  time; it is kept in the connection's own task, is good once, and lapses
  after five minutes. `WalletProof` carries the public key and the signature
  in base58, and `account::verify` checks the ed25519 signature itself.
- **What a good signature does** (`wallet_sign_in`): a wallet nobody has is
  linked to this account (`players.solana_pubkey`, unique); one this account
  has is already linked; one another account has signs this browser in as
  that account, with a **key of its own** in `account_keys`, which the
  browser keeps and reconnects with. The first browser's key keeps working -
  the server holds only hashes and could not hand the first one out anyway.
  An account has one wallet.
- **It will not strand money.** Leaving an account that holds a balance and
  has no wallet, for a wallet's account, is refused with the amount: the
  browser is about to forget the only key to it.
- The Wallet Standard is spoken directly (`solana.js`): the page announces
  itself, every wallet extension registers, and anything with
  `standard:connect` and `solana:signMessage` on a Solana chain is offered.
  No wallet library, and no key ever in the page.

### Invites

Protocol 16, migration 0012. Every account has an invite code - seven
characters of base58, unique - and the profile pane shows the link,
`/?ref=<code>`. A browser with no account that arrives on one keeps the code
(and takes it off the address bar), sends it in its `Hello`, and the server
records the inviter **in the same statement that makes the account**: an
existing player can never be re-attributed, an unknown code is no code, and
the database refuses an account inviting itself. The admin player view shows
the code, the inviter and how many were invited.

**Nothing is paid for an invite.** What one is worth is Conrad's decision.
When it is made, the reward belongs on the invited player's real-money
activity - a first deposit, a first paid match - never on the sign-up,
because an account costs nothing to make and a reward for making one is a
reward for making a thousand.

`client/menu.mjs` checks the account in a real browser: a closed tab comes
back as the same player, and a second tab takes over while the first stays
put. Wallet sign-in was checked the same way with a Wallet Standard wallet
injected into the page and signing with a real ed25519 key: linked, a second
browser signed in as the first account, the first still itself.

## The wallet

`wallet.rs`, `solana.rs`, `ledger.rs`, `chain.rs`, migrations 0004, 0005 and 0009. Playing never
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
once. The memo parser tolerates text around the UUID.

Most wallets' send screens have no memo box, so the wallet pane offers three
ways in that fill it for the player:

- **A connected wallet pays from the page.** The page builds the transfer
  with the memo (`depositTransaction` in `solana.js`) and the wallet signs
  and sends it (`solana:signAndSendTransaction`); the page never holds a
  key. The layout is `build_transfer`'s, byte for byte - checked against it
  on identical inputs, and by devnet itself, whose signature-verified
  simulation of one got as far as "this account holds nothing". The
  blockhash comes from `GET /chain/blockhash` (`chain.rs`, cached four
  seconds), never from the cluster directly, so a paid RPC's key stays the
  server's.
- **A Solana Pay code**, drawn from the same `solana:` link, for a phone's
  wallet to scan.
- The address and memo to copy, and `./x pay <memo> <sol>` from
  `SOLATEL_DEV_PAYER_KEY` for testing.

However it is sent, the watcher credits it the same way when the chain has
it; nothing the page says about a deposit moves money.

**USDC comes in the same way, at one to one** (protocol 15, migration
0009). A USDC unit is a millionth of a dollar, which is exactly a
`MicroUsd`, so there is no rate and nothing to round. It arrives at the
treasury's associated token account for the devnet USDC mint
(`USDC_DEVNET`, `associated_token_address` - a program-derived address,
checked against real devnet accounts), and the watcher reads that account's
history as well as the treasury's, judging each signature once whichever
list it was seen on. A deposit is credited from the token balances the
chain recorded before and after it (`read_incoming`, tested against a real
devnet transfer kept in `fixtures/`), never from the instruction's stated
amount, plus whatever SOL moved at the rate; the receipt keeps `usdc_units`
beside `lamports`. The page builds a USDC deposit as create-account-if-
missing, `TransferChecked` and the memo (`usdcDepositTransaction`), asking
`GET /chain/usdc-account?owner=` for the sender's token account, and the
Solana Pay code carries `spl-token=`. Withdrawals are still paid in SOL.

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

**The treasury is split hot and cold** (`cold.rs`, migration 0013), when
`SOLATEL_COLD_ADDRESS` and `SOLATEL_HOT_CAP_SOL` are both set. The treasury
key lives on the server, so what it controls is what a compromise costs: the
hot wallet keeps its cap plus every withdrawal asked for and not yet landed,
and anything over that by at least a tenth of the cap goes to the cold address
- once an hour at most, one in flight at a time (the database holds to that
too, with a partial unique index). A sweep is signed, written down, sent and
followed exactly as a withdrawal is, into `treasury_sweeps`; it is not a
ledger transaction, because the money is the game's either side. The cold
address need not be on the curve - a Squads multisig vault is a
program-derived address - and must not be the treasury. Solvency on
`/health` counts hot and cold together. SOL only; USDC stays where it lands.
Refilling hot from cold is the vault's signers' job, by hand. It has never
been run against devnet: that moves SOL, and waits on Conrad.

Protocol 10 carries it: `ClientMsg::Withdraw`, `ServerMsg::{Deposited,
Withdrawal, WithdrawalRefused}`, and `Welcome.wallet` with the terms;
protocol 14 adds wallet sign-in (see *Accounts*), 15 USDC and 16 invites. The
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
and mouse look; this one's JavaScript is about 1.2 MB (280 KB over the
wire), before the wasm and the assets. `./x client` builds it, `./x
watch` rebuilds the JavaScript on save.

**Movement is not reimplemented in JavaScript.** `crates/solatel-sim-wasm` wraps
`solatel-protocol::sim` and the client predicts by calling it, so there is still
exactly one description of how a player moves and the server runs the same one.
Do not be tempted to port `step_tick` into JS to save a build step: two
descriptions of movement drifting apart is the failure this whole design exists
to prevent, and in a game that pays per kill it pays the wrong player.

The wasm is 1.5 MB, about 260 KB of it over the wire as brotli, and almost
all of that is the three maps' brush tables - 61,000
brushes at six floats each is 1.4 MB on its own, against a simulation of about 50 KB.
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

### What a browser keeps

`client/build.mjs` and `served.rs`. **Every file the page loads is
published under a name hashed from its contents** -
`assets/maps/yard.0581c612a41ee1b5.glb`, `solatel.<hash>.js`, the wasm, the
icon - and the server tells the browser to keep any such name for a year,
`immutable`. A name like that cannot be served with other bytes, so keeping
it can never be wrong, and a map is downloaded once rather than at the
start of every match - which is what makes maps of tens of megabytes
affordable at all. The page is the one file that cannot be named that way,
since it is how the browser learns the other names, so **`index.html` is
never stored**, and neither is anything without a hash in its name (a
plain name, every API route, any 404). A new build is picked up on the next
page load and costs only the files that changed.

The code asks for files by their plain names through `asset()` in
`assets.js`; the page carries the table from plain to published names
(`#solatel-manifest`), written by the build. A plain name the build did not
publish throws, rather than 404ing somewhere later.

**A tab from another build is refused at the handshake.** Its page names
files the new build deleted, so it would fail at its next map. The page
says which build it is (`<meta name="solatel-build">`, sent as
`client_build`); the server reads which build it serves from
`web/dist/build.json` on every handshake - not once at start, because the
client is rebuilt under a running server - and refuses a mismatch, and the
tab reloads itself once for that build, exactly as for a protocol change.
The build is named from the bundle's name and the table, which between them
are every file a page can ask for. Only a name starting `solatel/` is
checked: the drivers name themselves (`duel.mjs`) and load no files.

**Everything worth compressing is compressed once, at build time**: a
brotli copy at the best setting with the widest window, and a gzip copy
for anything that does not speak brotli, beside each file, served by
`ServeDir` by `Accept-Encoding`. The yard is a thousand meshes of which
many are copies, so 11.1 MB goes over the wire as 0.23; the facility is 0.64
MB, the arena 0.06. That is a minute of CPU on a cold build, so a content-
named file's compressed copies are kept by every later build that publishes
the same bytes. WebP photographs are compressed already and are left alone.

`./x watch` keeps the bundle's plain name (`solatel.js`, never stored) and
publishes everything else as a full build does. `node client/cache.mjs`
checks all of it against a running server - headers, compression, a second
visit fetching only the page, a stale build refused - and `client/stale.mjs`
the reload, with no server.

### Photographs, sky and light

The maps are drawn with scanned CC0 materials (`photo.js`, `assets/photo`),
not flat colours. **The maps have no texture coordinates**, so each surface
is textured by triplanar projection in world metres, normal map included
(whiteout blend). `PHOTO` maps a surface name - the same names `SURFACES`
keys its weathering on - to a photo set, metres per repeat, how far it is
tinted towards the palette colour, bump strength, and whether its tiling is
broken up. The tint is what keeps the maroon barn maroon: the photograph
brings the grain, the map keeps its colours. A surface with a photograph
drops its drawn seams, ribs, planks and chips - the photograph has its own -
and keeps the streaks, grime and rust. A surface not in `PHOTO` draws as
before.

**A set is two KTX2 files the GPU keeps compressed** (Basis UASTC, zstd,
every mip): the colour, and the normal map with the scan's roughness in its
alpha. Compressed is what makes 2k affordable - a 2k photograph is 5 MB of
video memory against 22 for the WebP it replaced - and UASTC rather than the
smaller ETC1S because ETC1S shows its blocks on a wall a player stands at.
Colour is 2k for what a player stands next to and every normal map 1k;
grainy ground, rock and planks are 1k throughout. Those sizes were measured
against what each map downloads (`scripts/fetch-photo-assets.mjs` says
why), and with the baked light keep every map under 50 MB, every byte of
it cached for good. `scripts/build-basisu.sh` builds the encoder
from the upstream source on crates.io; the fetch script writes each set's
mean colour and roughness to `client/src/photo-sets.js`.

Things about the files that are not obvious:

- **They are stored upside down** (`basisu -y_flip`). WebGL flips a texture
  as it uploads it and cannot flip a compressed one, so without this every
  photograph lies the other way up from the WebP it replaced, and a normal
  map upside down lights every bump as a dent - on the props and trees that
  use UVs as much as on the triplanar maps.
- **The scan's roughness is variation, not level.** The palette says how
  glossy a surface is; the scan moves it up and down around the set's own
  mean. Taken whole, the steel stairs, measured as polished plate, caught
  the low sun as a line of glare, and the asphalt went grey with sky.
- **Most pixels sample one projection, not three.** The maps are flat-shaded
  and square to the world almost everywhere, so a projection whose weight is
  under 1% is skipped. The samples are therefore in branches, where a GPU's
  own derivatives are undefined, so every coordinate's rate of change is
  taken from the position's beforehand and passed to `textureGrad` - taken
  from the coordinates themselves it jumps where a face's sign flips, and
  that pixel reads the blurriest mip there is.
- **Tiling is broken up on patternless surfaces** (Quilez's technique 3: a
  slow noise picks one of eight shifts per patch, blended across a patch's
  edge), and never on bricks, planks or sheet metal, where a shift puts the
  courses out of line.
- **Up close there is a grain finer than any photograph**: a millimetre of
  grit a few millimetres across, bump-mapped from screen-space derivatives
  within six metres on patternless surfaces, so a wall a player is pressed
  against still has tooth.

**The sky is a photographed HDR panorama** (`assets/sky`), **one per map**
(`SKIES` in `world.js`): partly cloudy over the facility, a heavy overcast
over the yard with a weak sun and soft shadows, a late clear sun over the
arena. Each is read alongside its map and kept once read. Blurred by PMREM
into `scene.environment` it is what everything reflects, and the light of
whatever the bake below does not cover. The sun is put where the
panorama's own sun is (its brightest texel), so shadows agree with the sky,
and the fog takes the colour of the panorama's horizon. The water is a
standard material with travelling-sine wave normals in the shader,
reflecting that same environment: no mirror pass.

**The sky's light has no sun in it** (`cutSun`). Left in, the photograph's
sun was blurred into the environment as a second sun that cast no shadow -
on the arena's clear sky four times as bright as the directional light - and
it lit every shadow and every room: that is why both used to read pale and
flat. Everything within 8 degrees of the brightest texel is brought down to
the sky round it before the blur, and the directional light carries the sun
at the strength `SKIES` gives it. The sky the player sees is a separate
image and keeps its sun. The sky's light also keeps only 60% of its colour
(`SKY_SATURATION`): a clear sky is deep blue, and shade lit by all of it
read as night where an eye standing in it sees grey. Cutting the sun also
keeps the blur in range - PMREM renders into half-float targets, whose
largest value is 65,504, and a clear sky's sun disc is 135,000, which once
became infinity there and turned the frame white or black.

### Baked light

`scripts/bake-light.py`, `light.js`, `assets/light/<map>.bin`. What a
renderer of this kind cannot work out for itself, traced offline with Embree
into a grid of cells over each map - half a metre on the arena, three
quarters on the yard, a metre on the facility - because the maps have no
texture coordinates and a grid needs only a position:

- **the light arriving at each cell**: the sky's (its photograph, cut as
  above) and what the map's own surfaces send back at their own colour - the
  sun's off whatever it lands on and the sky's off everything - traced twice,
  so light that has bounced once comes round again. That is how a room is
  lit through its door and why the side of a building facing a sunlit yard
  is warm. Held as a colour and the way it leans: first-order spherical
  harmonics with one direction shared by the three colours, so a surface
  facing n gets E0 (1 + d.n);
- **whether the sun gets there**, for shadows past the shadow map's 34 m;
- **how much sky is in view**, for dimming reflections.

On the map it **replaces** the environment's diffuse light and the
hemisphere, ambient and bounce lights, which knew nothing of what stands in
the way. Players, props and trees are lit by it too (`lightMaterial`), so
nobody in a dark room is lit as if they stood in the open, and the
first-person rifle - drawn in a scene of its own - dims its own lights by
what `lightHere` finds at the eye. A map with nothing baked draws as it did
before there was any.

Things about it that are not obvious:

- **Re-run the bake after anything that changes a map's geometry or
  colours, or its numbers in `SKIES`.** The light is added up for one
  strength of sun and sky, and the console says so when they differ. The
  sun's light and the sky's are traced apart and added at the end, and the
  trace is kept in `target/light/` while the geometry, colours and
  photograph hold, so trying a brighter sun costs seconds; new geometry
  costs minutes (two for the arena, five for the facility, on four
  cores).
- **Light through a surface is the failure to watch for.** The shader reads
  the grid a cell out along the face's own normal, so a wall reads the air
  in front of it, and a cell and a half out from anything facing up: the
  texture is filtered between cells, so a nearer read takes in the cells
  behind the surface too, and the facility's pitched roofs came out black
  from the sealed attics under them. The smoothing that takes out the noise
  of a finite number of rays blends only cells that can see one another.
  Cells inside geometry are filled from their neighbours, and inside means
  what open air cannot reach through cells that see one another - not, as
  it first did, a cell whose rays met the backs of faces: the facility's
  shed roofs are wound inside out (drawn from both sides, so it never
  showed), and that put the air over every one of them inside a wall.
- **Nothing is darker than a floor** (`FLOOR`, a quarter of what open
  ground gets from the sky), met softly in the shader. A shut room is still
  one a player can see into: on a real-money map a black room is a place to
  hide.
- **The file is laid out for brotli**: each of the eight bytes a cell as a
  plane of its own, each row stored as differences, and the way light leans,
  the sun and the openness held to 33 values each - the colour alone keeps
  every bit. A tenth of the raw size goes over the wire, 1.8 to 2.5 MB a map.
- What it leaves out: anything that moves (the shadow map has that), the
  trees' shade (they are not in the bake), and the light of lamps.

`post.js` is the chain every frame goes through: a multisampled half-float
target, GTAO (still a setting, still off by default - it is the expensive
one), a restrained bloom that only finds real highlights, tonemapping, and a
light colour grade with a vignette. The bloom starts above what any lit
paint reaches (1.6): at 0.92 a white car's roof under the yard's overcast
flared. And nothing should be a perfect mirror - a car's windscreen was,
and the sun's glint off it, one line of pixels thousands of times brighter
than the paint round it, bloomed across half the car. `scripts/fetch-photo-assets.mjs`
downloads and transcodes every photograph; `ATTRIBUTION.md` lists them.

### Clips

`clips.js`. With the setting on, every drawn frame is scaled to at most
720p, marked SOLATEL in the corner and encoded with WebCodecs (VP9, else
VP8), a keyframe a second by the clock; the encoded chunks of the last twenty
seconds are kept, cut at a keyframe; F8 writes them out as a WebM. The
container is written here (`muxWebm`, a few dozen bytes of EBML round the
frames) rather than by a library: the maintained one is ten megabytes. The
clip is the canvas only - no HUD, no sound yet - and the setting is off by
default, because encoding costs frames on a machine without any spare. The
death sequence is captured too, which is most of what anybody will want to
show. Checked by recording in a real match and decoding the file in a
`<video>` element.

### Graphics quality

`quality.js`. Four levels - low, medium, high, ultra - and **auto**, the
default: it guesses from the graphics chip (software rendering and phones
start low, integrated graphics medium, anything else high, nothing ultra),
then steps down one level at a time while a match is being drawn if the
median frame rate over five seconds is under 48. It only ever steps down -
stepping back up on a good stretch would oscillate - and remembers where it
settled, so a slow machine does not start every session too high. A
`?quality=` in the address forces a level for a script.

**A level changes what drawing costs, never what can be seen.** Fog, the far
plane, the trees and the players are identical at every level: a setting that
thinned foliage or pulled the fog in would pay to be turned down, in a game
that pays per kill. What moves is the pixel ratio (low draws at three
quarters), the composer (off on low, where the renderer tonemaps directly),
bloom, ambient occlusion (ultra only - 60 fps against 23 on an Iris Xe), the
shadow map's resolution over the *same* area (shadows get coarser, never
shorter or absent, because a shadow round a corner is information), how far
out grass is planted, and birds and chimney smoke. Grass may vary only
because it is too short to hide anybody: the tallest tuft is about 0.7 m
against 1.25 m for a crouched player. Anything added to a preset has to pass
the same test.

`node client/perf.mjs` queues into a match and measures each level in turn on
a real GPU; run with `PERF_HEADLESS=1` it only checks that the script works,
since a software rasteriser's frame rate means nothing. `--crowd N` fills the
match first with N players over the wire who run, jump and fire at the sky -
everything a full match costs to draw, with nobody hurt; run the server in
free play for it. Each row also has the main thread's milliseconds before a
frame is drawn and while drawing it (`stats().updateMs`, `drawMs`), which
tell a frame rate the CPU holds down from one the graphics card does - and
those, unlike the frame rate, mean something on the software renderer too.

`node client/tour.mjs --map yard` takes the same pictures of a map every
time - from its spawns at eye height, from above, and through the player's
own eyes - which is how a visual change is judged against the last one. It
wants a free-play server with a long `SOLATEL_WARMUP`: on a software
renderer a tour takes minutes, and once a match is live the circle burns a
player who never moves and puts the page back on the menu. The debug camera
it uses carries the shadow map and the sky with it, so a picture shows the
shadows a player standing there would see rather than the baked ones.

### Trees, grass, smoke and birds

`nature.js` grows what a map's scene extras describe. **Trees are data, not
geometry**: `trees` is x, y, z, height, kind in fives, `tree_kinds` names the
kinds, and the client builds tapered trunks, boughs and crowns of cards
carrying the scanned leaf and needle atlases, instanced per kind and swaying
in the wind. What collides is the trunk alone, a box in the map's
`collision_only` node (hidden by the client, read by the generator). Leaves
stop sight and not bullets. Spruces wear a painted spray and three crossed
outline cards through the crown, because their near-level branch cards are
edge on from the side and a distant spruce otherwise reads as a bare pole.

Two things about foliage that were found by looking:

- **A card's back is lit with the card's own normal.** Three's double-sided
  materials flip it, and the back of every leaf then faced away from the sun
  and drew black. `windy` replaces the normal setup for foliage.
- **Alpha is scaled up by the mip level being read.** A mip averages a leaf
  with the gaps round it, so at a distance the coverage fell under the
  cut-off and every tree thinned to a stick. The colour under the
  transparent parts of each atlas is filled with the leaves' own average,
  or the same mips drag it towards the scan's white background.

Colour and alpha are separate files because a canvas stores colour
premultiplied: encoding them together lost the colour under every
transparent pixel and filtering dragged each leaf's edge to black.

Grass is tufts of the scanned grass cards, planted within `GRASS_RADIUS` of
the eye from the map's `ground` extra (a run-length coded metre grid of
where grass grows and how high), from a hash of each spot so nothing pops
when the patch is replanted. It grows in over the last `GRASS_FADE` metres of
the radius, measured from the eye *every frame* in the vertex shader, and is
planted out past the radius by as far as the eye walks between replants. It
used to be sized when it was planted, so for five metres a tuft stayed the
size it was planted at and then jumped - the whole outer ring growing by half
in a frame, every five metres: what Conrad saw as grass popping up. `smoke` lists chimneys; birds circle whatever
map has trees. All of it is marked `scenery`, so the fog is sized without it.

### Static batching

After a map is prepared, `batchStatic` in `world.js` merges every plain,
visible mesh into one mesh per material, in the map's own frame. The yard is
a thousand small meshes and was 637 draw calls a frame; batched it is about
a hundred. The cost is culling: a batch is drawn whole, so the triangle count
goes up (the yard from 0.3 M to 0.8 M), which a GPU minds far less than draw
calls. Instanced meshes, hidden stand-ins and collision-only nodes are left
out. Nothing may look a map mesh up by name after this runs.

### Vehicles, drums and crates

`props.js` draws the maps' cars, trucks, oil drums and crates properly over
their low-polygon stand-ins, which stay in the file and in the collision
exactly as they were. Each model is built in code - a sedan with a raked
glasshouse, a flat-nosed cargo truck with a canvas tilt, a ribbed 200-litre
drum, a boarded crate with battens - and fitted into its stand-in's own box
(`fit`: which axis is up, which is longest, and the lower end is the nose).
Instanced per part, painted in the stand-in's colour. Stand-ins are found by
node name, without the dot the loader strips (`truck001`, `CAR002`, `Wood003`,
`crate017`); the yard's two trucks are `Cube.036` and `Cube.051`, matched in
the yard only because the arena has an unrelated `Cube.036`. The yard's
other drums and all its tyres are bare `Cylinder`s, told apart by material
(`cylinderKind`): a barrel colour is a drum, rubber is a tyre - turned on a
lathe with tread grooves - and rubber taller than it is wide is a stack of
five. The sedan has arches cut over its wheels, five-spoke steel wheels,
mirrors, a B-pillar and plates.

**Grass is cut from whole tufts** (`GRASS_TUFTS` in `nature.js`), five
boxes measured off the atlas's alpha, three crossed per clump in three
mixes. A card spanning the atlas's whole bottom strip took in half-cut tufts
and a stray blade-end and read, across a field, as fallen leaves.

### Rubbish, damp and puddles

`scripts/scatter.py`, `scatter.js`, `assets/scatter/<map>.bin`. Heaps of
rubble, grit, broken brick, offcuts, litter and cans at the foot of walls
and in corners, and twigs and stones on the facility's grass.

- **Placed from the drawn map, never the collision**, which has walls
  nobody can see - the yard's guardrail, pits filled in so nobody is
  trapped - and rubbish lined up along one would be lying about where a
  wall is. The floor is every face of the art pointing up, sampled by area;
  a wall is whatever a ray along the floor runs into.
- **In heaps, where something stops it.** A heap starts with a chance that
  falls off with distance from a wall and is two and a half times as likely
  in a corner, and a third as likely off the ground (stair treads, roofs);
  every piece must be seen from its heap's middle along the floor, so none
  lies through or inside a wall.
- **A few shapes of each kind, built in code**, textured with photo sets
  every map loads anyway at the photograph's own scale (a chip of brick is
  part of one brick), instanced, a draw call a shape: 80 to 250 KB a map.
- **Never a place to hide**: nothing is taller than a crouched player's
  ankle, nothing collides, and it is the same at every graphics level.

**Damp and puddles** (`wet` in `SURFACES` and in `SKIES`): level ground open
to the sky - which the baked light knows, so never under a roof - is darker
and glossier in patches, puddles more so and smoothed over. Never a mirror:
the environment map is the sky alone and knows nothing of the walls round a
puddle, and a mirror puddle in a walled yard read as a white hole in the
ground. The overcast yard is the wettest map, the arena the driest.

### The weapon in your hands

**The guns are real ones** - see *The guns* below for what each is and
where it came from. Everything that holds one was measured against the
rifle model the game started with, in its units (0.18 m each in the first
person), with the pistol grip at `GRIP`, so every gun is drawn in that frame
and its landmarks - the sights, the muzzle, the ejection port, the support
hand's place, the magazine - are read off its own file (`POINTS` in
`guns.js`) and handed to the feel (`feelFor`). Nothing in the controller
knows which gun it is holding.

`viewmodel.js`, tuned from `weapons.js` - one entry per weapon, every number
in it, nothing hard-coded in the controller. The pose each frame is layers
added together: hip-to-sights, sway from turning, a breath when still, a
figure-of-eight bob paced by *distance covered* (so it quickens with speed),
a lift in the air and a dip on landing, then recoil. Every layer eases with
an exponential that takes `dt`, so the feel is the same at any frame rate,
and most of them are steadied with the sights up.

**Aiming down the sights is solved, not tuned.** The gun's model gives the
two sight points - the optic's tube ends, or the iron sights - and the rig
is pitched until the line between them is level and moved so the front
point is on the view axis, **with the eye on the stock**: a cheek on the
comb, `CHEEK` behind the grip in `guns.js`, not a fixed distance behind
whatever sight is mounted. A fixed distance put the eye over the AK's grip,
because its rail is further forward than the old rifle's carry handle, and
the hands filled the screen. The pistol, held out at arm's length, keeps
`ads.eyeRelief`. The world camera narrows by scaling the tangent of its
half-angle (`ads.zoom`), and turning is scaled by the same factor so a flick
covers the same part of the screen. The weapon's own camera narrows by its
own factor (`ads.weaponZoom`) to draw the sights larger; they are on the view
axis, so magnifying about the middle of the screen does not move them. The
crosshair - four short black lines round a gap and a dot in it, with a thin
light edge so it shows against a dark wall, as Conrad asked - dims with the
sights up and never disappears: its middle is where the shot goes, and on
real stakes a player should always see it.

**None of it changes where a shot goes.** Recoil kicks the weapon and rolls
the camera around its own axis; a roll leaves the middle of the screen where
it was aimed. A recoil pattern that actually walks the aim, bullet spread
that differs between hip and sights, and sprinting are all *not built*, on
purpose: each changes who wins a fight, so each has to be enforced by the
server, and a client-only version would be a lie a cheater removes in one
line. They are Conrad's decision and server work first. Magazines, reloading,
crouching and grenades went that way round - server first - and are in
*Health, the circle, and what a life carries*.

**The weapon is drawn with a view of its own**, 70 degrees across
(`WEAPON_HORIZONTAL_FOV` in `main.js`), whatever the player sets the world's
to: at the default 90 a gun a hand's breadth from the eye is stretched into a
wedge. The sights are on the view's axis, so it moves nothing aimed.

**The parts move** (`_workParts`, tuned by `action` in `weapons.js`): the
AK's carrier and handle and the pistol's slide run back with each shot and
the pistol's hammer falls and is cocked again, the M700's bolt is worked by
hand after its shot - lifted, run back (which is when the case comes out),
home and down - and every trigger is pulled. A reload cants the gun to show
the magazine well (`reloadPose`), the left hand takes the magazine out,
goes away for the next one and seats it, and the AK, the RPK, the MP5 and
the pistol are racked at the end. The sights cannot come up during a reload;
`onThrow` drops the gun out of the way for 0.65 s. Mixamo has reload and
throw clips for the third-person body; they are not in `soldier.glb` yet.

**The arms are the soldier's own.** `setArms` clones the same Mixamo soldier
other players are drawn with and keeps only the triangles skinned to the arm
bones, with their weights given wholly to those bones so nothing of the torso
can drag them. The shouldered clip `remotes.js` uses supplies the **hands** -
how each closes on the rifle, measured against the rifle it would be holding
with `grip.js`, which both modules use. It does not supply the **arms**: the
first version bolted the whole third-person pose onto the first-person
rifle, which put the soldier's shoulders in front of the camera and pushed
the sleeves up through the bottom of the screen as stumps. Each arm now
hangs from a point below the frame (`arms` in `weapons.js`) and is solved
every frame (`_poseArms`, two bones, elbow bent towards a pole, the arm
turned as a whole frame so the elbow hinges the way the clip's did, half
the hand's roll handed to the forearm). The left palm sits on the handguard
rather than out by the front sight where the clip holds it, because no arm
reaches that far from below the screen. `hip.position` is high enough that
the support forearm is in the frame; lower it and the arm is cut off at the
wrist.

**Each shot throws a case and leaves a puff of smoke**, both pooled and
tuned in `weapons.js` (`casings`, `smoke`). Once out of the rifle they live
in **world** coordinates and are carried into the viewmodel's scene each
frame, so turning leaves them behind; a case inherits the player's velocity,
bounces once on the floor under them, and is gone in about a second. The
smoke is faint on purpose and fainter with the sights up, because it hangs
between the eye and the target. All of it is local decoration: nothing is
sent, and other players see only the flash.

**Your own shot is shown when you fire it**, not when the server echoes it a
round trip later. `LocalPlayer` predicts shots on the same ticks and interval
the server enforces (`takePredictedShots`), and `main.js` skips the kick and
sound for the echo of its own shot. The server still decides every hit.

### Other players

**The soldier is a Mixamo character**, "Ch15" - a special-forces operator in
urban digital camo, helmet with night vision, balaclava, plate carrier - with
four of Mixamo's rifle clips: idle, run, fire and death.
`scripts/build-soldier.sh` builds `assets/characters/soldier.glb` from the raw
downloads: FBX to glTF, 4096 px textures down to 1024 px WebP (98 MB to 2.8),
the clips copied onto the character's bones by name, root motion taken out of
idle, run and fire so the soldier runs on the spot the server puts him, and
the mesh simplified from 46k triangles to 34k. The raw downloads are **not in
the repository and must not be**: it is public, and Mixamo's terms allow the
assets inside a game but not as redistributed raw files. Mixamo bone names
lose their colon on load (`mixamorig:Hips` is `mixamorigHips`).

`remotes.js` splits each clip at load into legs (hips down) and upper body
(spine up):

- **Legs** are idle or run by speed - a walk is the run, slower - turned up
  to 70 degrees toward the way the player moves, with the run played
  backwards when backing off.
- **Upper body has two stances, and the rifle is up only when it is being
  used.** Everybody used to be drawn shouldered and aiming all the time,
  which is not what anybody looks like and told nobody anything; Conrad
  asked for the relaxed stance of a modern shooter. At rest it is the **low
  ready** (`lowReady`, `READY`): lowered across the body, muzzle down and to
  the left, arms relaxed. Aiming (`Buttons::AIM`, sent as
  `PlayerSnapshot.aiming`, protocol 18), and on a shot and for 1.4 s after
  it (`RAISED_AFTER_SHOT`), it comes up to the shoulder - the fire clip's
  first frame, a little of the run's arm swing at a sprint, the fire clip
  over it on every shot the server reports. A reload brings it half way up,
  a throw takes it down. `raise` eases between them, exponentially: up with
  a time constant of 0.08 s (0.03 on a shot from the low ready, because the
  round has already left - its tracer leaves from where the shouldered
  muzzle will be, `SHOULDER_MUZZLE`, and its flash waits for the rifle to
  arrive), down with 0.25 s. The clip weights always sum to one, because
  three.js fills a missing share with the bind pose.
- **The low ready is built, not downloaded.** The idle clip holds the rifle
  nearly level and pointing straight out to the side. So at load the torso
  and head are taken from the idle (breathing), the rifle is put where
  `READY` says - 54 degrees across, 29 down, chosen beside the references
  Conrad sent - and each arm is solved onto it by two-bone IK, the hands
  closing on the grip and the handguard exactly as the shouldered pose
  closes them, fingers included. Shoulders, arms and hands are one still
  frame over the idle's moving spine, so they ride the breathing together
  and the hands stay on the rifle. It is a clip like any other, so the two
  stances blend bone for bone.
- **Aim is a constraint, not a lean.** After the clips pose the body, the
  line from the right palm to the left is measured and the spine turned -
  about the vertical, then about the level axis across it, the two made one
  rotation and shared over three spine bones about its own axis, with one
  matrix update for the lot - until it points exactly where the rifle should: along
  the yaw and pitch at the shoulder, at the low ready's angle to them at
  rest, in between on the way. That also undoes the leg turn for strafing
  and the run's hip sway. Two rotations, not the one shortest: the low ready
  points down, and the shortest turn between two downward lines tips the
  torso over sideways. An earlier version leaned the spine by the pitch
  around a fixed axis; on this rig the clip's hands point 55 degrees off the
  hips, and the lean bent him sideways - measure the rifle against the aim,
  do not eyeball it.
- **At the low ready the head says where they look.** The rifle follows a
  third of the pitch; the face is measured and turned onto the yaw and pitch
  by the neck and head, because the idle clip turns the head about as it
  pleases. Raised, the head is down the sights already.
- **The rifle is not parented to a bone.** Each frame it is put in the right
  palm and laid along that line, so raised it points exactly where the
  player looks, and either way the left hand is on it.
- **A death is drawn by `kill`, not by the snapshot.** The server stops
  naming the dead (`a_dead_body_is_kept_for_the_board_and_off_the_map`),
  and for months that meant somebody killed simply vanished where they
  stood - no fall, nothing - which was most of why kills felt flat. Now the
  `killed` message plays the death clip from where they were last drawn,
  the body turned (at most a right angle, over 0.3 s) so they go down away
  from whoever killed them, and leaves them lying for 15 s, gone after that
  the first moment nobody is looking. Snapshots still naming them for the
  interpolation delay are ignored. Which way the clip falls is measured
  off the clip at load (`fallOf`).
- **A round landing jolts the body** away from it (`hit`): leaning from the
  feet for a tenth of a second, and the head snapped back on a shot that
  struck it. Whose body is whoever is drawn there - the server's landing
  says only that a player was hit, and the round in them is visible.
- Landing dips the hips; shots flash the muzzle.
- **Reloads and throws are placed, not played** - there are no clips for
  them. A reload cants and dips the rifle in the right hand while the left
  arm is solved (two-bone IK) to the magazine, down to the pouch at the hip,
  back up to seat it and onto the handguard; it is `PlayerSnapshot.
  reloading`, and it is heard within `RELOAD_AUDIBLE` of the listener. A
  throw lowers the rifle while the left arm winds up behind the head and
  lobs. Nobody is told who threw a grenade: one appearing that was not in
  the last snapshot is the nearest player's within `THROW_REACH`, because it
  starts at the thrower's eye.
- **Hand-posed bones are put back before the clips are sampled**
  (`POSED`). three.js's mixer writes a bone only when its sampled value
  changes, and the shouldered pose is one still frame, so an arm posed by
  hand kept last frame's posing and built on it: the arm stayed at the
  magazine after a reload, and the aim then turned the whole torso to put
  the hands back on a rifle the arm had left.
- Beyond 35 m the mixer runs every other frame, beyond 70 m every fourth,
  and every fourth out of view.
- **Fewer triangles further away** (`DETAIL`): the soldier and rifle are
  simplified at load with meshoptimizer to 30% beyond 15 m and 10% beyond
  40 m, each level an index list over the same vertices so the skin still
  works, never further off the full shape than a couple of pixels where it
  is first used. A crowd photographed both ways is the same picture.
- **Players are culled**, by a sphere `POSE_REACH` times their resting
  bounds. They never were - bounds from the bind pose lost a player whose
  clip carried them outside it - so every player in a match was drawn every
  frame, and again into the shadow map, wherever they stood. Together that
  took a twelve-player arena from 1.39 to 0.73 million triangles.

Each gun is a clone of the one `buildGun` makes, placed by the hands rather
than inheriting any rig's offset or scale - inheriting them is what once made
every other player hold a toy. The left hand is put on the gun's own support
by two-bone IK (`_reachLeft`) on every gun, because the soldier's poses were
made for the rifle the game started with and no real gun's handguard is
where that one's was.

## Sound, blood and dying

Conrad asked for the game to be intense: gun sounds, death sounds, blood,
footsteps heard close by, and knowing where shots come from. None of it
decides anything; all of it is drawn or heard from what the server already
says.

**The sounds are recordings** (`assets/sounds`, `scripts/build-sounds.py`,
ATTRIBUTION.md): every gun from beside the shooter and from mid distance,
footsteps by surface, rounds into bodies and ground and metal, bodies
falling, and four men's voices. 1.2 MB, fetched at boot (`audio.preload`)
and decoded when the audio device starts. What a recording would not help -
the till, the hit tick, the countdown, a reload's clicks, the crack of a
round going by - is still synthesised, and so is a gunshot heard before its
recording decodes. MP3 because every browser decodes it; each sound's onset
is found when it is decoded (`onsetOf`), because not every decoder removes
the encoder's padding and a late gunshot feels late.

- **Placed in three dimensions** - an HRTF panner set where the sound is
  relative to the listener, so behind is heard as behind - with distance
  applied by the game's own curve, and the speed of sound as before.
- **Near and far are different recordings**, crossed between 14 and 70 m,
  then dulled by the air. A shooter's last shot is turned down over a tenth
  of a second when the next one starts, so automatic fire does not stack
  ten tails and the last one rings out. A limiter on the master holds a
  firefight under clipping.
- **Footsteps** (`takeSteps` in `remotes.js`, `step` in `audio.js`): a
  footfall every stride on the ground, longer at speed; heard to 30 m
  running, 16 walking, 6 crouched - moving slowly to be unheard works. On
  grass where the map grows it (`world.surfaceAt`), otherwise hard ground.
  A player's own steps are heard too, quietly.
- **A round going past** within 5 m (`Rounds.listen`) cracks from where it
  passed - buzzes, for the pistol's slower-than-sound .45 - before the
  report arrives, and a thin pale arc on the HUD says where it was fired
  from (`hud.shotAt`), under the red one for a hit.
- **Voices**: a cry of pain on a hit (at most every 0.55 s), a death cry and
  the body hitting the ground; each player keeps one of the four voices for
  the match, by their id (`voiceOf`), the same on every client.

**Blood** (`blood.js`): a hit throws a spray out of the far side and a little
back out of the near, and drops that fall and leave spots where they land;
a death leaves a pool spreading from under the chest once the body is down.
The marks lie flat on the floor at the victim's feet - the server's height
for where they stood - and never on a wall, where the client does not know
the surface (see `impacts.js`). Pooled, the same at every graphics level,
gone over 45 s (spots) and 90 s (pools), cleared for a new match.

**On the player's own screen**: blood at the edges when hit (`hud.bleed`),
the edges red and beating under 35 health with the heart heard
(`audio.pulse`), their own voice crying out, and a kill marked by a red X
that pops (`hud.killed`).

## Skins

Protocol 20. Eleven ways to dress the soldier: 0 is Mixamo's grey digital
camouflage, 1 to 10 are Solatel's own (`skins.js`). Chosen in the menu
under the guns, kept per browser, sent with `Queue` (`skin`), and on
everybody's board (`ScoreEntry.skin`, left off the wire for 0) - the board
is sent when a match starts, and to a page that comes back mid-match. The
server only keeps the number honest (`net::skin`).

**A pattern is drawn in the shader, from where the cloth sits on the body
at rest** - the mesh's own bind pose, in metres - not from its texture
coordinates, which are cut into islands: drawn on the body it runs across
the seams and stays put on a body that runs. Which texels are cloth is a
mask made from the soldier's texture (`scripts/build-skins.py`,
`soldier-cloth.webp`, 18 KB); the cloth keeps its own folds and grime by
scaling the pattern with the original texture blurred until its
camouflage is gone. Patterns: blots, squares, stripes, mottle, splinters,
a honeycomb. Every skin is one shader program; skins differ in uniforms.

**A skin may not hide its wearer**, on real stakes. Every skin's cloth is
brought to the same average brightness as the soldier's own (`CLOTH_MEAN`,
measured by the script) whatever its colours, and the gear is tinted at
its own brightness, never darkened. What a skin changes is hue and
pattern. None copies a map's surfaces. Adding a skin means adding it to
`SKINS` in `skins.js` and raising `net::SKINS` (a protocol change).

The menu's pictures of each skin are drawn from the soldier himself at
boot (`soldierPortraits`), and the player's own sleeves in first person
wear their skin (`viewmodel.setSkin`).

## Assets

Runtime models live in `assets/` and are published into `web/dist/assets`
under content-hashed names by `./x client` (see *What a browser keeps*).
They are downloaded by every player, so size is a gameplay number - once
per player and build, now that a browser keeps them, and compressed. A player fetches only the map being played, so the budget is per map,
not for the folder, and Conrad's is **20 to 50 MB a map** if every byte goes
into how it looks and plays - and he has since said 51 is fine. Over the wire today, everything a map needs:
the arena 34.4 MB, the yard 31.9 and the facility 49.6, almost all of it
photographs (see *Photographs, sky and light*); the baked light is 1.8,
2.0 and 2.5 MB of that, and the models themselves 0.06, 0.23 and 0.64 MB as
brotli. The facility is the one nearest the limit: anything added to it has
to be paid for there. The soldier is 1.5 MB on top, once, and the guns
9.3 MB - every gun, since anybody may carry any - loaded at boot with the
soldier and kept for good.

`prepare-assets.py` strips normals and texture coordinates from the maps, which
is most of that 11 MB. Neither is ever read — there are no textures in either
file and the client flat-shades every map material — so if a map ever does get
a texture, that step has to be reconsidered rather than left running.

The files are committed, but they are outputs. `scripts/prepare-assets.py`
rebuilds them from the raw downloads and records what was done to each one,
which CC-BY-4.0 requires us to state; `ATTRIBUTION.md` is the licence record.
`scripts/asset-licence.py` prints what a `.glb` claims about itself, and exits
non-zero for a file with no embedded licence. The rifle was that file; it is
deleted, and the rifle is built in code (see *The weapon in your hands*).

**`scripts/extend-arena.py` is the one place geometry is authored**, and it is
separate from `prepare-assets.py` precisely so that "the download is untouched"
stays true of everything else. It adds Solatel's own buildings, ramps and
walls to `arena.glb`, and takes down 40 triangles of the original: the east and
west walls, so the map can continue past them, and a redundant red-orange floor
quad that was z-fighting with the grey ground plane over the whole arena. It
also takes down `room_0`'s own floor - 60 downward-facing triangles at ground
level, which the client's double-sided materials drew at exactly the ground's
depth inside that building. It is idempotent: everything it adds goes on
the end of each glTF array, the lengths from before are in `asset.extras`, and
nothing is ever deleted — removed triangles are only pointed away from. Run it,
then `./x maps`, then bump `MAP_VERSION`.

**The yard's colours are `scripts/restyle-yard.py`'s.** The download paints
everything from ten primary colours; the script gives each kind of object -
by node name and original colour - a surface from the shared list, muted
for combat (weathered concrete, faded containers, rusty drums, dark steel),
picking per object where a kind comes in several. Materials only, so the
collision is untouched. Its walls are `concrete_grey`, tinted three quarters
of the way to a cool grey rather than the arena's halfway, because the
concrete photograph is warm and halfway left twenty thousand square metres
of wall cream under a grey sky; they weather like the arena's, rain streaks
and all. It records each primitive's original colour in its
`extras.yard_colour`, which keeps it idempotent and which `build-facility.py`
reads when it borrows the yard's props. It also writes the yard's scene
extras: the water's colour, and `spawn_exclude` over the strips behind the
two lines of barriers across the yard's ends (and the barriers themselves) -
seven spawns were out there, a life starting with the whole yard in front of
it, until Conrad asked for them inside. Run it, then `derive-maps.py yard`.

It is also where the arena's **colours** live. `PALETTE` repaints every
primitive of the original, by what the piece is, in weathered concrete,
asphalt, plaster, rusty steel and timber, and the geometry it adds is
painted from the same list. That changes materials and nothing else, so a
palette change needs no `MAP_VERSION` bump - but prove it: `python
scripts/derive-maps.py arena` must leave `map.rs` byte-identical. A piece
`surface_of` does not recognise is an error rather than a default.

The palette's names are a contract with `world.js`, which keys its shading
on them: `SURFACES` says how each one weathers - rain streaks, formwork
joints, grime at the foot of a wall, rust, chipped paint, corrugation,
planks - and the ground's paint comes from `markings` in the asphalt
material's `extras`, in world metres. All of it is computed from world
position in the shader, because the maps have no texture coordinates. A
material with a name `SURFACES` does not list - the whole yard - gets the
plain grain it always had.

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

**The arena's ways up are ramps, not stairs** (`Parts.ramp`), at Conrad's
asking: thirteen of them, three metres wide, about thirty degrees where the
lane has room, with a wall a metre high down each side. The flights they
replaced climbed straight up the middle and nowhere else - eleven degrees off
line or 0.8 m off centre walked a player off their open side on most of them -
and read from the side as a zigzag. A ramp is three things in three nodes: the
slope and its walls drawn and never collided with (`_drawn`, `scenery`); the
slope's collision, a column of the generator's own grid per cell along the
run, solid from the ground to the quarter metre nearest the drawn slope,
never drawn (`_collision`, `collision_only`); and the walls' collision as
exact boxes, a node each over one unit cube (`_exact`), because voxelised the
generator's smoothing flattened every sloped wall to the lowest height in
reach and near the top a wall stood half a metre over the slope - a step onto
it and off the outside. A column must sit *inside* one cell: a face on a cell
boundary counts in the cell above it, so a box exactly a cell deep marks two.
Each roof ramp stands beside its block's door, not in front of it - the
flights shut those doors. `every_ramp_in_the_arena_takes_a_player_to_the_top`,
`a_ramp_wall_cannot_be_stepped_onto` and `running_down_a_ramp_keeps_the_
player_on_it` walk every one, and `ARENA_RAMPS` in `map.rs` has to move with
the script's tables.

**Map collision is generated, not written.** `./x maps` runs
`scripts/derive-brushes.py` over every model in `assets/maps` and rewrites the
tables in `sim/map.rs` between its two markers. Regenerate rather than
hand-editing, or the server stops colliding against what the client draws — and
bump `MAP_VERSION` in the same commit, which is what tells a stale cached client
to reload. Each map carries its own `scale` for the same reason: the client
draws that model at that scale because its brushes were derived at it.

There are three maps, `arena`, `yard` and `facility`, and the server runs them
all at once: each
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

### The facility, and building a map from nothing

`scripts/build-facility.py`, then `python scripts/derive-maps.py facility`,
then bump `MAP_VERSION`. The third map is the first one authored here rather
than downloaded: a walled works (silos, tanks, hangars, warehouses) in open
country, a village and a wooded ridge with a road tunnel to the north, a river
along the south crossed by a road bridge, a dam and a footbridge. 320 m
square, thirty seats. The structure is boxes from the same kit
`extend-arena.py` uses; the dressing - trucks, containers, barrels, sandbags,
the water tower - is the yard's own props, instanced and repainted.

The generator was written for downloaded art, and a map built for it has to
respect what it assumes. Every one of these was found by a test failing:

- **The playable ground is at y = 0 and nothing below it collides.** The
  voxel grid starts at the floor. Hills are terraces standing on the ground,
  never lifted ground, or every building on them reads as solid from the
  floor up. The river is a cut drawn below zero with the water at the map's
  own level (`water_level` and `water_colour` in the scene extras, read by
  `world.js`).
- **The river cannot be entered, and must be closed at both ends.** Flood
  walls `FLOOD_WALL` high (over what a jump clears), bridge parapets as tall,
  and no climbable roof within `RIVER_CLEAR`. Somebody in the cut would stand
  on the invisible floor over it, and `seal_traps` would fill it in as a pit.
  Left open to the edge of the grid, `outside_the_art` reads the channel as
  void and seals it. `the_facility_river_cannot_be_entered` checks it.
- **Anything tall under a roof is a node of its own** (`Layout.solid`). In the
  structure mesh a rack or a machine fills a player's height, so
  `obstacle_heights` extends it to the highest surface in its column - the
  roof - and it becomes an invisible wall to the ceiling. A node is judged as
  a prop and collides as exactly its box. Interior stairs need a hole in the
  roof over the stairwell for the same reason.
- **Long thin faces are cut** (`Kit.box`, `FACE_ASPECT`). The voxeliser
  samples a triangle by its area, so a 40 m wall a quarter metre thick comes
  out as a comb with gaps a player walks through.
- **Treads are slices a cell deep.** A half-metre tread has an interior cell
  that no face passes through, which reads as hollow and stops the flight
  partway.
- **Walls sit on cell boundaries.** Surfaces are recorded at the bottom of
  their cell, so a height between boundaries is rounded down.
- **Spawns stay out of the compound** via `spawn_exclude` in the scene
  extras, which `derive-brushes.py` reads; lives start outside the walls and
  converge on the middle.

**Nodes can say they do not collide, or are not drawn.** `extras.scenery`
is drawn and never collided with - the generator skips it (`is_scenery`) and
the client leaves it out of the map's bounds: window glass and frames,
cladding, the warehouses' pitched roofs, vents. There was a heightfield of
wooded hills outside the map too; it was taken out on Conrad's call - nobody
plays there, and three thousand trees nobody reaches were most of the frame. `extras.collision_only` is collided with
and never drawn: tree trunks. Anything a player could stand on, or that is
more than a few centimetres proud of a wall, stays in the structure: the
houses' pitched roofs and chimneys are, because a roof stops a bullet.

**Outcrops are rocks drawn inside their collision** (`Kit.rocks`). Each
collides as the box it always was, in the hidden node, and is drawn as a
rounded, lumped rock fitted inside that box - never outside it, because rock
drawn past its collision is rock a bullet passes through. Its lumps are
seeded by where it stands, not drawn from the layout's generator, so nothing
built after it moves. Moving the boxes into the hidden node left `map.rs`
byte-identical, which is the check for a change like this.

**The facility is dressed**, all in `build-facility.py`: street lamps and
timber power poles (the poles collide; heads, crossarms and sagging wires
are drawn only), razor-wire coils along the works' walls, chain-link over the
flood walls (`chainlink`, cut into a diamond lattice by `world.js`), and
inside every shed pallet racking - a hidden solid box for the collision,
the rack and its load drawn over it (`Layout.rack`) - with pallets, drums
and crates in the corners clear of the doors, and lamps (`lamp`, emissive)
hung under the roof.

`FACILITY_CLIMBS` in `map.rs` walks every staircase, ramp and ladder of high
ground with the real resolver; add to it when adding something to stand on.

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

## Late commands, corrections, and drawing everybody else

`game.rs` (`Body::advance`), `localplayer.js`, `snapclock.js`. What decides
whether movement feels smooth on a real connection rather than on
localhost, all of it measured with `client/lag.mjs` (below).

**A command that is late costs its owner nothing.** The server runs one
command a tick. When the next has not arrived, the body is moved on a
**guess** - the last command again, without anything it fired, threw or
reloaded, and without its movement after `MAX_CARRY_FORWARD_TICKS` - so
everybody else sees it carry on. When the late commands come, the guess is
undone - position, motion, aim and crouch put back to where the owner's own
last command left them, health left as it is, because a guessed body takes
real damage - and every one of them is run in that tick: one for each tick
guessed, one for this. The owner's prediction was made from exactly those
commands, so it is then exactly right, and while a guess stands the owner's
own entry in their snapshot (`reported_state`) is where their commands left
them, not the guess, or replaying their unacknowledged commands would count
the guessed ticks twice. It used to run the late commands *on top of* the
guess: every late packet put the body a step ahead of its owner (a
correction on their screen) and left the queue a command deeper for good,
which after one stall on a lossy link meant a correction on most snapshots
and an eighth of a second of lag for the rest of the match.

- **Never more commands than ticks.** Each tick runs one or guesses and owes
  one, so holding commands back and sending them together moves nobody
  faster. A queue that builds with nothing owed - a client sending faster
  than the server steps - is lag, and past `BACKLOG_LIMIT` the oldest go.
- **Half a second** (`GUESS_WINDOW_TICKS`): a lost TCP packet is the
  retransmission timer plus a round trip, and with a frame hitching while it
  waits three eighths of a second was measured too short. A guess older than
  this stands; only the newest command is run on it, the rest are history.
  That bounds what a lag switch buys - its body seen on the guess for half
  a second, then where it really went - which is what carrying the last
  command forward always allowed.
- **Shots in a batch** leave from where their own command left the shooter,
  but the fire rate is still judged in server time, so commands held back
  cannot deliver three rounds in one tick.

**A shot is judged against what its shooter could see**: everybody else
rewound by the whole round trip, the time the command waited on the server
(`waited_ms`), and the interpolation delay. The snapshot the shooter was
looking at took half the round trip to reach them, and the command the
other half to come back. It was half the round trip and no wait, which
judged a running target a third of a metre past where it was drawn;
`a_shot_is_judged_against_what_its_shooter_could_see` and its pair fail
against the old sum. The round trip is still the server's measurement,
never the client's word.

**The tick clock keeps the wall's time** (`TickClock`). Clients make a
command every tick of their own clock, so a server whose ticks run slow
takes commands slower than they come and its queues only grow. tokio's
`Delay` moved the whole schedule on by every tick more than 5 ms late, and
on this container that was 0.3% - a dropped command, and a correction,
every five seconds per player. Lateness up to `MAX_CATCH_UP` is made up by
running the next tick at once; a real stall - a paused container - still
starts the clock again rather than fast-forwarding the match. And the
client keeps its clock too: a frame that hitched owes ticks, and it makes
them up over the next few frames (`CATCH_UP_TICKS`) instead of letting the
time go, which left its commands behind the server's clock for good.

**A correction is a glide, not a jump.** When the server's answer does
differ - a stall outlasted the window, or commands were dropped - the feet
take it at once and the view closes the gap over
`CORRECTION_SMOOTH_TIME` (a tenth of a second, Source's `cl_smoothtime`).
More than two metres is a teleport and is seen as one.

**Everybody else is drawn by the server's clock, not by when snapshots
arrive.** Two snapshots held up on the way and released together used to
be drawn as a stop and a lurch; at 5 ms of jitter everybody's speed on
screen wobbled by 15%. Every snapshot carries `server_time_ms`, and
`SnapshotClock` puts that clock on the page's by the offset of the
snapshots that arrived soonest in the last two seconds, easing small
changes in and taking a stall or a restart at once. Nothing is drawn past
the newest snapshot: in a stall everybody else stands still, which is true,
rather than walking on along a guess through a wall, which a player would
shoot at and miss.

**A player faces the way their spawn does.** Spawns are dealt out afresh
every match, so which one a player was given is told by the first snapshot's
position (`spawnFacing`); the view used to be turned to the table's first
spawn, somebody else's, and a player could start the match facing a wall.

`node client/lag.mjs` is how any of this is judged: two clients through a
proxy in the process that adds latency, jitter and TCP-style stalls, one
running, swerving and jumping with the real wasm prediction on a frame
clock, the other watching. It reports corrections, input lag, and how
steadily the watcher draws the runner each way. It wants a free-play server
with the floor at one and no warm-up. Against the old server and the new,
45 s on the facility, three links (20 ms at 144 fps / 30 ms with 5 ms
jitter and frame hitches / 40 ms with a 250 ms stall every six seconds):

| | old | new |
|---|---|---|
| corrections a minute | 7 / 8 / 55 | 0 / 0 / 0 |
| input lag, median | 145 / 169 / 214 ms | 66 / 97 / 125 ms |
| others' speed wobble on screen | 8-15% (by arrival) | 0% (by server clock) |

The watcher's figures are for drawing, not the server: the old server
drawn by the server's clock steadies too.

## The guns

Protocol 19. `sim/weapon.rs` is the one description of every gun, shared by
the server, which enforces it, and the client, which predicts its own shots
and draws everybody's rounds from it.

**A loadout is bought with the stake.** Before queueing a player picks a
primary - the SMG, the assault rifle, the machine gun or the sniper rifle -
and an optic it can carry, and everybody carries the pistol as well
(`Queue.loadout`, `MatchStarted.loadout`). The server fills in the default
for anything missing and refuses nothing over it. Nothing lies on the map:
one entry fee buys one life with the gun its owner chose, and nobody dies
for being unlucky with what spawned near them. 1, 2, Q or the wheel swap
guns; the swap is the server's, timed in ticks like everything else
(`switch_ms`), and the sidearm is a posture bit (`Buttons::SIDEARM`) that a
guessed command carries and a warm-up hold lets through.

**Everything that decides a fight is in that table**: the fire interval in
whole ticks, semi or automatic (a semi fires on the trigger's edge), the
magazine, the reload, how long the gun takes to bring up, the round's muzzle
velocity and drag, the zero, the range, and the damage bands. The SMG wins
up close, the rifle in the middle, the machine gun at range for as long as
its drum lasts, the sniper rifle wherever its owner can put a round on a
head. The machine gun's 75-round drum and 4 s reload are the RPK's.

**Rounds fly.** Real gravity (9.81, not the players' heavier one), drag in
proportion to the square of the speed, and the real cartridges' speeds and
drag - .45 ACP, 9 mm, 7.62x39 and .308 - with every sight zeroed, so the
round is launched a fraction of a degree up and crosses the line of sight at
the gun's zero. The flight table at the top of `weapon.rs` is checked by its
tests. A round is stepped a tick at a time and judged on the segment between
one tick's position and the next, against the world as it was at that tick:
the ticks a shooter was behind are caught up at once against the rewound
world (the same lag compensation a shot always had), and after that a round
still in the air is stepped live (`step_rounds`, `Flying`). `ShotFired`
says where it left and how fast; `ShotLanded` where it came down, and
whether on somebody. The client flies a streak along the same flight
(`round_path` in the wasm, `rounds.js`) at the round's own speed and puts the
dust where the server said, when the streak gets there.

**Optics change what is seen, never where a round goes.** A red dot, a 2x
prism, and a 3x and 4x scope. Through a magnified one, at full aim, the
picture is the scope's own: the world at its magnification in a round
eyepiece, the gun hidden, and a reticle whose holdover marks are worked out
from the shared flight (`hud.js`).

**The models are real ones**: an AK-47, an MP5, an M700 and an M1911 from
Stein Games' CC0 pack, the scope from 3DModelsCC0's (ATTRIBUTION.md), and
an RPK made from the AK - its barrel stretched, a drum and a folded bipod
turned in code and textured from the AK's own sheet. `scripts/build-guns.sh`
makes `assets/guns/` from the downloads, which are not in the repository:
each gun cut into rigid parts along the bones it was skinned to (`body`,
`magazine`, `bolt`, `trigger`, `hammer`, and the `rail`, drawn only with an
optic on it), sockets for the muzzle, the port, the sights and the support
hand, and KTX2 textures - colour as ETC1S at 2048, the normal map as UASTC,
both 1k and packed into glTF's order. A file per model, so the RPK shares
the AK's sheet. Re-run the script after changing anything about how they are
cut or placed; the measurements it works from are in its `GUNS` table.

The guns they replaced were built in code, and Conrad said they looked fake
next to a photographed map, which they did.

**A sniper's record is judged on its own lines.** Its lives are recorded with
their weapon (migration 0015), and the anti-cheat's accuracy and headshot
lines for the sniper rifle sit higher (`SNIPER_*` in `records.rs`): a good
sniper's ratios are a cheater's on a rifle. Reactions are judged over every
life.

## Shooting, and what it is worth

Damage is stated per weapon, per region and per band of range (`Band` in
`sim/weapon.rs`) rather than as a multiplier on a base, because a multiplier
means a rounding rule and a rounding rule is one more thing that has to match
between whatever computes the number and whatever checks it. The rifle up
close is two to the head, four to the body, five to the legs, and the test
that says so (`shots_to_kill_are_the_design`) counts them out against
`MAX_HEALTH` rather than restating the constants.

A headshot is a kill on its own from one gun only: the sniper rifle, at any
range. Everywhere else one-shot kills would mean whoever saw the other first
wins outright, with nothing to play for in the second between seeing and
dying; the sniper rifle pays for it with a bolt action, five rounds, a second
and a quarter between them, and a round in flight long enough to have to be
led. Whether it should is Conrad's to change.

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
which is information nobody earned. That includes the snapshot, which goes to
the whole match: every body in it is sent at full health and only the
recipient's own entry carries the real figure. It was once sent whole, to
everybody, for months; `nobody_is_told_how_hurt_anybody_else_is` pins it. The killfeed is the exception, and it
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

**A death is seen happening** (`death.js`). Being killed is the most
expensive thing in the game and used to be a cut straight to the menu. Now
the last frame of the match is held for 3.6 s: the view drops to the floor
and rolls, colour drains, the sound goes dull behind a ring and a heartbeat
(`audio.dying`, a low-pass every sound already passes through), and the view
turns to where the killer was last drawn, under a card - who, how, how far,
where the stake went, what the life won. A click skips it after the fall.
Nothing in it is asked of the server: the match has stopped sending to this
player, and the killer's position is the last snapshot's.

**A hit taken says where it came from.** `Damaged` names the attacker, and
the HUD holds a red arc round the crosshair on that side - turned as the
player turns, one per attacker, for 2.2 s - and the view flinches: a roll
only, so the middle of the screen, where a shot goes, never moves.

**A kill that pays is seen paying.** `hud.payout` punches the table's reward
in under the crosshair (`+$0.90`, tagged HEADSHOT, GRENADE, DOUBLE KILL),
holds it, and flies it up into the winnings counter, which ticks over as it
lands. The amount is `MatchStarted.tier.kill_reward_micro_usd` - the
server's statement of what every credited kill pays - and each kill shows
its own; two kills are two payouts, never a total the client added up. The
counter waits for the flight but always draws the server's figure: the wait
moves *when* it is drawn, never what it says. The till climbs two semitones
a kill through a run (`STREAK_MS`), so a double kill is heard as one.

Names are cosmetic and are treated as hostile input. `sanitise_name` collapses
whitespace, drops other control characters, bounds the length in `char`s and
falls back to a stable name rather than rejecting anybody. Whitespace is
tested *before* control characters and that order matters: a tab and a newline
are both, and dropping them outright turns "big⇥red" into "bigred" rather than
the two words somebody typed. Invisible formatting characters go too
- bidi overrides and isolates, zero-width spaces and joiners - because
`is_control` does not count them, and an override prints the rest of a
killfeed line backwards. Nothing is ever keyed on a name — anything that
moved money by name would be paying whoever typed the name.

## Health, the circle, and what a life carries

Protocol 11. All of it is decided in `step_match` and the shared simulation;
the client predicts crouching (it moves the body) and draws the rest from the
snapshot.

**The circle hurts; it never moves anybody.** It used to push a player
inward, and a player pinned against a wall by that push was left stranded
outside as it closed past them. Now standing outside it costs health every
tick, faster as it closes (`ZONE_DAMAGE_PER_SECOND`, 4 to 20 a second), and
nothing about movement changes. The HUD says OUTSIDE THE ZONE while it
burns. Health comes off in whole points with the fraction carried, so the
rate is exact at 64 ticks a second.

**Health comes back.** After `REGEN_DELAY` (5 s) without being hurt, a
player regains the whole bar over `REGEN_SECONDS` (11 s), and never while
outside the circle. Regen is the server's and arrives in the snapshot.

**A death nobody shot is still somebody's kill.** Burning in the zone,
falling off the map, or catching your own grenade credits whoever last hurt
the victim, if that was within `KILL_CREDIT_SECONDS` (15 s), and settles as
a kill - their reward, the victim's stake. Otherwise it settles as an abandon,
exactly as a fall always did. Without the credit, a player losing a fight
could walk out of the circle, or off a roof, and deny the winner the stake.
`die_unshot` is the one place that decision is made; the killfeed carries a
`cause` (`rifle`, `grenade`, `zone`, `fall`).

**Crouching** (C, a toggle - Ctrl is Ctrl+W in a browser) caps speed at
`CROUCH_SPEED`, forbids jumping, and lowers the eye and the top of both hit
boxes by `CROUCH_DROP` without moving the feet. Pressing jump while crouched
stands up and jumps in the one command: the client clears its own toggle on
the key, so the server sees an uncrouched jump and nothing about the rule
changes. The eye eases between the two heights on a clock of its own
(`CROUCH_EYE_TIME`), in the air as well, so the jump rises out of the crouch. It is in `PlayerState`
because it changes the body, so it is predicted, and the wasm's `adopt`
takes it. Other players drop to one knee, and it is a *placed* pose rather
than a squat: `_kneel` lowers the hips until the right knee reaches the
floor, lays that shin back with the toes tucked, and plants the left foot
ahead with its shin upright, each leg by two-bone IK. The first version kept
the idle clip's feet and lowered the hips, which bent both legs the same way
and read as a deformed squat. Moving crouched cannot be a kneel, so it blends
to the run clip's stride with the hips lowered 0.38 m.

**Each gun's magazine and reload are its own** (`weapon.rs`; the rifle's are
thirty rounds and 2.2 seconds) - R, or pulling the trigger on an empty
magazine. The trigger does nothing while reloading.
The client runs its ammunition down between snapshots only so the kick stops
on the round the server will refuse; the count it displays is the server's.
What is in somebody else's magazine is not sent to anybody else; whether
they are reloading is (protocol 13), because a reload is done in plain view
and heard, and it is what a player standing there would know. So is whether
they are aiming (protocol 18): a rifle at the shoulder is seen. The aim
button decides nothing on the server - a shot goes where it goes either way,
`aiming_is_seen_by_everybody_and_decides_nothing` - and a late packet
carries it on, as it does a crouch.

**Where a shot lands is drawn** (`impacts.js`), from the server's own `to`
in `ShotFired` - never the prediction: a burst, dust thrown back towards the
shooter and chips off the surface, or a mist off a player. A shot that
reached `weaponRange` struck nothing and raises nothing. There are no bullet
holes on purpose: the ray stops on the collision, up to a cell off the drawn
wall, so a flat mark would float or sink; dust is a volume and forgives it.

**Two grenades a life** (G). A throw is the rising edge of the button, so
holding it throws one; the server steps the flight (`sim/grenade.rs`,
shared so there is one description of how one moves), sets it off after
`GRENADE_FUSE`, and hurts everybody it can see within `GRENADE_RADIUS` -
full damage inside two metres, falling to nothing at seven, and nothing
through a wall. The thrower is hurt too. `Exploded` is sent for the flash
and the bang; the damage arrives as `Damaged`. `blast.js` draws it: a white
flash bright enough for the bloom, a fireball cooling from white to orange
to nothing in half a second, sparks as streaks along their own velocity and
grit that comes to rest, a ring of dust and the shock along whatever floor is
under it, then smoke lit by the fire for a moment and by the bake after - pale,
not black - swelling and thinning for four seconds. Near it the view rolls
and the rifle jolts (a roll only). Every blast shares **one point light that
is always in the scene**, dark until something goes off: a light added for
the first grenade changed how many lights every lit material was compiled
for, and would have stalled that frame rebuilding the map's shaders. `cheat.mjs` presses the
button forty times and counts what goes off.

`node client/cheat.mjs` is the adversarial client, over the real wire:
speed and fire-rate floods, impossible aim, values the wire cannot carry,
a second life for one stake, withdrawals of nothing, claiming a balance,
somebody else's resume token, more grenades than a life carries, wallet
sign-in with no challenge, random bytes, a signature over other words, a
replayed proof and another account's proof, tables nobody runs, and names
built to break a killfeed - then that an honest client is still answered
and the ledger reconciles. Add to it whenever the protocol grows a way in.

## Match history, the anti-cheat, and the admin view

Phase 5's foundations and Phase 3's operator view, in `records.rs`,
`admin.rs` and migration 0006.

**Every life is written down when its stake settles** - killed, survived, or
walked away - as one row in `match_lives`: map, stake, outcome, killer, and
what the server counted (kills, shots, hits, headshots, damage, flick-hits,
winnings, time alive). `settle_stake` is the one place every life ends
through, so that is where `record_life` hangs. None of it is money - the
money is in the ledger already - and none of it is reported by a client.

**It has its own queue, not the ledger's.** Writing a life is two or three
statements, and on the ledger's queue each would sit in front of the next
payout at half a second a round trip. The one place the two meet is a
withdrawal, and that reads the reviews table in the statement it already
makes (`balance_and_review`).

**Judging is over a player's last twenty lives**, against four lines, each
with a minimum sample under which it says nothing: accuracy (70% over 60
shots), headshots as a share of hits (65% over 25), hits that ended a
flick (45% over 15), and fights opened quicker than a person reacts (50%
over 12). A **flick** is the aim having swung more than 30 degrees
in the tenth of a second before the shot, measured from the shooter's own
history, which lag compensation already keeps. People flick; what people do
not do is land most of their hits that way. The lines are generous on
purpose and are starting points to tune against real records, not facts
about human aim - `judge` is a pure function and its tests say where each
line sits.

**A reaction** is measured at the first hit of an engagement: how long the
target had been in the shooter's line of sight when the round landed,
walked back a tick at a time through both histories (`exposure` in
`game.rs`) - the shooter's eye as it was, against the target rewound by the
same lag compensation the shot was, so the sighting and the hit share one
frame of reference. Sight is a clear ray to the middle of the body or the
head. Under 120 ms is quicker than a person (`REACTION_QUICK_MS`); a target
in sight for the whole 600 ms window was being watched and is not measured;
the rest of a burst at one sighting is the same fight. It costs a few dozen
rays a *hit*, not a sweep of every pair every tick. Pre-aiming a corner
beats the line honestly now and then, which is why the line is half of all
fights rather than any of them. Migration 0010 adds `reactions` and
`quick_reactions` to `match_lives`.

**A review holds withdrawals and nothing else.** Crossing a line opens one
(one open per player, which the database enforces), and while it is open or
confirmed `request_withdrawal` refuses with a reason and the balance is
untouched and playable. That is the product's "manual review before a
payout is finalized": a payout is money leaving for the chain. Nothing here
claws money back or stops anybody playing; both are a person's decision.
Clawing back is a ledger `adjustment` with a reason, made deliberately.

**Every match is recorded for the reviewer** (`replay.rs`, migration 0011).
A review holds a payout until a person decides, and a person cannot decide
from ratios alone. The lobby samples every body eight times a second -
position, aim, health - and keeps every shot, kill and blast the match was
told about, by hooking `to_match` (the recorder sits in a `RefCell` on the
`Match`, because that path has only a shared borrow). Names are taken when
the match forms, since by its end some players have left. At `end_match` the
recording goes to its own queue on the records task - serialised there, not
on the tick - as integer JSON in decimetres and hundredths of a radian, into
`match_replays`, where Postgres compresses it: a thirteen-player match is
168 KB of text and 6 KB on disk. Recordings older than fourteen days go,
unless somebody in the match is under review or was found against. The admin
match view draws it from above over `/admin/api/maps/<name>/plan` (the brushes
between knee and eye height): aim lines, the focused player's field of view,
shots, kills, a timeline. A review links to its match with the flagged player
in focus. `node client/admin.mjs` drives the whole admin view in a browser.

**The admin view** is at `/admin`, off unless `SOLATEL_ADMIN_TOKEN` (24
characters or more) is set, and its API answers only a request carrying that
token as a bearer token, compared by SHA-256 so the comparison takes the same
time whatever it is given. It shows the ledger's accounts, the review queue,
any player (balance, record, lives, every ledger movement on their balance,
withdrawals, deposits, reviews) and any match (its lives and every
transaction keyed on it). Each endpoint is one statement that builds its JSON
in Postgres. The only write is deciding a review, which the database will not
accept without who decided and why. The page puts every value in as text,
never markup: notes are typed by people and the page can decide reviews.

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

**And a walking player is put down on anything within a step below**
(`MAX_STEP_DOWN`, `collide::step_down`, Source's `StayOnGround`). Without it
walking off anything was a fall, and a slope - held as quarter-metre steps -
a run of them: down a thirty-degree ramp at full speed a player left the
ground 0.4 s and three metres at a time and landed at 9 m/s with the thump
and the dip of a fall. Only for a body on the ground going into the tick, so
a jump is never pulled back and a drop taller than a step is still a fall.

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

The gap closes per metre walked as well as per second (`EYE_SMOOTH_DISTANCE`).
On time alone the lag up a ramp is the climb rate times the time constant,
and up a thirty-degree ramp at full speed that was 0.42 m - the view most of
a crouch low the whole way up. Per metre as well, it is 0.12 m, and a single
step at a run is smoothed over the third of a metre the body takes to cross
it. Crouching is eased apart from all of this (`CROUCH_EYE_TIME`).

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

## Load

`node client/load.mjs --players N --seconds S` connects N clients in the
same instant, queues them over every table, has them run and shoot for S
seconds, and judges the join times, that every busy line drained into full
tables, the snapshot rate, whether every match clock kept up with the wall,
`/health` latency (timed by `curl` in its own process, because the driver's
own event loop is the busiest thing on the machine), and the ledger.

Measured on a four-core cloud container, release build, local Postgres, and
the load generator on **the same four cores**:

| players | welcomed (p95) | in a match (p95) | snapshots | match clock |
|---|---|---|---|---|
| 300 | 0.4 s | 4.3 s | 21.3/s | on time |
| 600 | 0.6 s | 10.3 s | 21.1/s | on time |
| 1000 | 0.8 s | 25.9 s | 15.4/s at p5 | 17.5 s in 24.2 |

600 holds with nothing late. At 1000 the box is saturated - the server at
one core and the generator on the rest - and the slow part is joining:
`ReadBalance` answers were logged at 11 s, and that is the ledger task
waiting to hand its answer to a lobby loop that is busy sending snapshots,
not the database. The ceiling on a machine of its own is higher than this
says, and the first thing to look at when it matters is the lobby loop,
which does every match's tick and every client's snapshot on one task.

Deployed against a database half a second away, the join numbers are
dominated by round trips instead; see *Money events are round trips*.

## Deploying

`Dockerfile` builds one image - Rust for the server and the wasm, Node for
the bundle, a slim Debian to run it - and `documents/RUNBOOK.md` is how to
run it. The two rules that are easy to get wrong: **stop the old server
before starting the new one** (the new one takes the escrow lease before it
listens, so blue-green deadlocks for ninety seconds and then gives up), and
**deploy when escrow is empty**, because a restart settles live stakes as
abandons and that charges players the rake for our deploy. The server shuts
down on SIGTERM as well as Ctrl-C and releases the lease on the way out. A
tab left on the old client reloads itself once per server version or client
build (`reloadForNewBuild` in `net.js`).

**The game is live on one VPS, and merging into main deploys it**
(`deploy/`, *One VPS* in the runbook). A timer on the machine fetches main
every two minutes, builds it there, and switches when `/health` shows
escrow empty, rolling back a release that does not come up healthy - both
rules above, kept by the machine. Nothing here can reach it: this
container's network passes web traffic only, so there is no SSH and the
machine pulls rather than being pushed to. What it is doing is public at
`https://<domain>/deploy.json`, which is how a session watches a deploy
land, and the update script runs from main as fetched, so a broken deploy
is fixed with a commit like anything else. Its settings are
`deploy/solatel.env`, in the repository and never secret: the database is
reached through Postgres's socket as the server's own system user, with no
password, and the admin token is made on the machine and stays there. A
merge that breaks the build or the start leaves the last good release
serving and says why in `deploy.json` - so run the checks before merging,
not after.

## Phase 2 note

Movement and shooting feel cannot be tuned by guessing at numbers. Build a
version, then ask Conrad for a test pass and a specific description of what
feels wrong. Expect several rounds; that is the plan, not a failure.
