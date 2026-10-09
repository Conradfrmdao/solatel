# Running Solatel

What it takes to put the server somewhere real and keep it there. The
reasons behind each rule are in `CLAUDE.md`; this is the operator's list.

## What runs

**One server process and one Postgres.** The process holds every match at
every stake, serves the client, and owns the escrow account. There is no
second replica to add for load or for availability, and there must not be:
a second process pointing at the same database would settle the first one's
live stakes out from under it. The escrow lease (`escrow_lease`, migration
0007) enforces that - a second server waits up to 90 seconds for the lease
and then refuses to start, naming the holder - but the platform should not
be trying.

The image is built from the `Dockerfile` at the root:

    docker build -t solatel .
    docker run --env-file solatel.env -p 8080:8080 --stop-timeout 20 solatel

It listens on 8080 and serves the game at `/`, the websocket at `/ws`, and
the endpoints below. Put TLS in front of it (the platform's, or a proxy);
the websocket follows the page's scheme, so `https` gives `wss`.

## Configuration

Everything is an environment variable; `.env.example` describes each one.
Nothing secret is in the image or the repository, and none of it should be:
keep the values in the platform's secret store.

| variable | what | secret |
|---|---|---|
| `DATABASE_URL` | Postgres, with `sslmode=require` for a managed one | yes |
| `SOLATEL_ADMIN_TOKEN` | turns on `/admin`; 24 characters or more | yes |
| `SOLATEL_TREASURY_KEY` | the devnet treasury's secret key; with the rate, turns the wallet on | yes |
| `SOLATEL_SOL_USD` | dollars per SOL, fixed; required with the treasury key | no |
| `SOLATEL_COLD_ADDRESS`, `SOLATEL_HOT_CAP_SOL` | cold storage: the hot wallet's excess over its cap swept there hourly | no |
| `SOLATEL_TIERS` | which tables, out of `1,2,5,10`; all four by default | no |
| `SOLATEL_QUEUE_WAIT`, `SOLATEL_MATCH_FLOOR`, `SOLATEL_WARMUP` | matchmaking; defaults are 120 s, 4, 15 s | no |
| `RUST_LOG` | the image defaults to `solatel_server=info` | no |

Never set these anywhere a real player can reach, except a test server
that takes no real money and says so (*One VPS*, below):

- `SOLATEL_DEV_GRANT` hands every new player free money (and turns
  withdrawals off, so it cannot leave).
- `SOLATEL_FREE_PLAY` makes entry and kills free.
- `SOLATEL_DEV_PAYER_KEY` is a test wallet for `./x pay`.
- `SOLATEL_MATCH_FLOOR=1` starts a match for one person.

**The chain is devnet and only devnet.** `solana::Cluster::devnet()` is the
only cluster in the code; there is no variable that points it elsewhere, and
moving to mainnet is Conrad's decision and a code change, not a setting.

### The database

Postgres 15 or later. Migrations are compiled into the binary and applied
when it starts, so a new version's schema arrives with it; there is no
separate migration step and nothing to run by hand. The ledger's rules -
append-only entries, transactions that sum to zero, checked at `COMMIT` -
are in the schema, so they hold whatever connects to it.

Back it up. The ledger is the record of who owns what, and everything the
proof page and the admin view show is read from it. A managed Postgres's
point-in-time recovery is the right tool; take a snapshot before any deploy
that brings a new migration.

## Deploying a new version

**Stop the old server, then start the new one.** Not the other way round:
the new one takes the escrow lease before it listens, so a platform that
starts it and waits for it to pass a health check before stopping the old
one waits on a server that is itself waiting on the old one, and after 90
seconds the new one gives up. Use the platform's *recreate* or *stop-first*
strategy, never blue-green or a rolling update with overlap.

The server stops on SIGTERM - what `docker stop` and every orchestrator send
- and releases the lease on the way out, so the next one starts straight
away. Allow it a grace period of a few seconds (`--stop-timeout`, or the
platform's kill timeout). Killed without one, the lease lapses on its own
within 30 seconds and the next server waits for that.

**Deploy when nobody is playing for money.** Restarting ends every match in
progress, and the next server settles each live stake the way it settles a
player who walked away: the reward back to the player, the rake to us. That
is the right answer for a crash and a poor one for a deploy we chose to do,
because it charges players the rake for our restart. Until there is a drain
- stop forming matches, let the running ones finish, then exit - deploy when
`/health` shows `escrow_micro_usd` at 0, or close to it.

The page itself is sent `no-store` and every file it loads is named after
its contents and kept by browsers for good, so a new client is picked up on
the next page load and players download only what changed. A tab left open
on the old one is refused at the handshake if the protocol changed
(`PROTOCOL_VERSION`), the maps did (`MAP_VERSION`) or the client did (its
build, against `build.json` in the web directory), and reloads itself - once
per version, so a server older than the page cannot make it loop - and its
resume token brings the player back. Put no cache of your own in front of
the page: a CDN that keeps `index.html` despite `no-store` serves a page
whose files a deploy has deleted.
`node client/stale.mjs` checks that without a server.

## One VPS

How the game runs today: one rented server (an OVHcloud VPS in Europe, for
the test month that began in October 2026), set up by one command and kept
up to date by itself. Everything is in `deploy/`.

**Setting one up.** Point the domain's DNS at the machine first - an `A`
record for the bare name and one for `www`, both to its IPv4 address - then,
on a fresh Ubuntu 24.04 (or Debian 12):

    curl -fsSL https://raw.githubusercontent.com/Conradfrmdao/solatel/main/deploy/install.sh | sudo bash -s -- example.com

It installs Postgres, Caddy (which gets the domain's certificate and renews
it), the services and the firewall, and starts the first build, which takes
about twenty minutes. Running it again is safe and is how a broken install
is repaired.

**What runs, and as whom.** The server is `solatel.service`, as the system
user `solatel`, on `127.0.0.1:8080` behind Caddy. It reaches Postgres
through its socket as that same user, so the database has no password at
all. The build runs as `solatel-build`, in a copy of the code of its own,
and can change nothing root or the server runs. The admin token is made on
the machine and never leaves it: `sudo cat /etc/solatel/secret.env`.

**Deploying is merging into main.** `solatel-update.timer` runs every two
minutes: it fetches main, builds it if it moved (`deploy/update.sh`), and
switches to it when `/health` shows nothing in escrow - stop the old
server, point `/opt/solatel/current` at the new release, start it, and wait
for `/health` to answer 200. A release that does not come up healthy is
rolled back to the one before, and a commit that failed is not tried again
until main moves. The update script is run from main as it is fetched, so a
fix to the deploy reaches the machine the same way as any other change.

**Watching it from anywhere**: `https://<domain>/deploy.json` says what
the updater is doing - `building`, `waiting` (built, and matches have money
in them), `switching`, `live` or `failed` - with the commit, and on a
failure the end of the log that explains it. On the machine:

    sudo journalctl -fu solatel           # the server
    sudo journalctl -fu solatel-update    # the updater
    sudo solatel-update --now             # switch now, ending matches in progress
    sudo solatel-update --retry           # build again a commit that failed

**Settings** are `deploy/solatel.env`, copied into each release, so a change
is a commit and goes live like any other. Nothing secret may go in it.
`/etc/solatel/local.env`, written by hand on the machine, overrides it there
alone. The test month's settings are there, and **every one of them goes
before real money**, with the rest of *Before real money*.

**Backups.** The database is dumped every night at 03:30 UTC into
`/var/backups/solatel`, kept fourteen days; OVHcloud also keeps a copy of
the whole machine every day. To restore one, with the server stopped:

    sudo systemctl stop solatel
    sudo -u solatel pg_restore --clean --if-exists -d solatel /var/backups/solatel/<file>
    sudo systemctl start solatel

Those are copies of a ledger: restoring one rewinds everybody's balance to
that night, so it is Conrad's decision, never a fix.

## Watching it

`GET /health` answers 200 when the database answers and the ledger
reconciles, and 503 otherwise. Point the platform's health check at it, and
alert on:

| field | alert when | what it means |
|---|---|---|
| `status` | not `ok` | one of the two below |
| `database` | `false` | Postgres is unreachable; nobody can buy in or be paid |
| `ledger_reconciles` | `false` | the balances no longer match the journal; see below |
| `ledger_checked_seconds_ago` | over a few minutes | the reconciliation task has stopped |
| `escrow_micro_usd` | not falling back towards 0 after matches end | a settlement has stopped happening |
| `wallet.treasury_micro_usd` | below `wallet.owed_micro_usd` | the treasury could not pay everybody out at once |
| `wallet.checked` | `false` for more than a minute | the wallet loop cannot reach the chain |
| `wallet.treasury_lamports` | far over the hot cap for more than an hour | sweeps to cold storage are not landing; read `treasury_sweeps` |

`sessions` is how many sockets are open. `/proof` is the public payout
record and should always answer; `/admin` is the operator's view of
players, matches, the ledger and the review queue.

Every money event is timed, and anything over `SLOW_EVENT_MS` is logged as
slow. A database far from the server makes every event a round trip of half
a second; put them in the same region.

## When something is wrong

**The ledger does not reconcile.** Stop taking money first: there is no
switch for that yet, so stop the server. Then find the account that drifted
- the admin view shows the total in each kind of account and any player's
balance and ledger history - and the transactions against it. The schema will not accept an unbalanced transaction or an edit,
so a drift means a balance row and its journal disagree, which is a bug in a
migration or in hand-run SQL, not in play. Corrections are new reversing
transactions with a reason, never edits, and **every one is Conrad's to
approve** before it is posted.

**A second server will not start, naming a holder.** Another process holds
the escrow lease. If that process is really gone, the lease lapses within 30
seconds of its last renewal and the next start takes it. If it is still
running somewhere - an old container nobody stopped - stop that one. Do not
delete the lease row by hand while a holder might be alive.

**The server exited saying it lost the lease.** It could not renew in time -
usually the database was unreachable for most of 30 seconds - and stepped
down rather than risk two owners. Its live stakes are settled by the next
start. Restart it once the database is back.

**A withdrawal is stuck.** Withdrawals are recorded with their signature
before they are sent, so a stuck one is either still waiting for the chain
or past its last valid block height. The wallet loop resolves both on its
own: sent and final, or returned to the player with a reason. Nothing needs
doing by hand, and nothing should be: re-sending money by hand is how a
withdrawal gets paid twice.

**A player is flagged.** A review holds their withdrawals and nothing else;
they keep playing with their balance. Decide it in `/admin` with the lives
in front of you. Taking money back is a separate ledger adjustment with a
reason, and is Conrad's decision.

## Before real money

Not settings - work that is not done, listed so nobody mistakes a working
devnet server for a launch:

- Plisio (or another processor) for deposits and withdrawals in place of
  the devnet rail.
- A multisig vault (Squads) set up and its address configured as cold
  storage; the sweep is built and waits on it.
- A drain on SIGTERM, so a deploy does not end matches in progress.
- The rifle model's licence confirmed, or the model replaced.
- Legal review of real-money play where it will be offered.
