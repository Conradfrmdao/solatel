#!/usr/bin/env bash
# Ledger invariant tests.
#
# Spins up a throwaway Postgres, applies the migrations, and asserts that the
# database itself refuses every way we know of to corrupt the books. These are
# SQL-level tests on purpose: the guarantees under test are enforced by
# constraints and triggers, so testing them through application code would test
# the wrong layer.
#
# Run from the host:  bash scripts/test-ledger.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1

CONTAINER=solatel-ledger-test
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILED=0

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
echo ">> starting throwaway postgres"
docker run -d --name "$CONTAINER" \
    -e POSTGRES_PASSWORD=test -e POSTGRES_DB=ledgertest \
    postgres:17-alpine >/dev/null

psql_run() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d ledgertest; }

# The postgres image runs a temporary server during first-time initialisation
# and then shuts it down, so pg_isready reports ready too early. Wait for a real
# query to succeed instead.
ready=0
for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" psql -U postgres -d ledgertest -c 'SELECT 1' >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 1
done
if [ "$ready" -ne 1 ]; then
    echo "postgres never became ready" >&2
    docker logs "$CONTAINER" 2>&1 | tail -20 >&2
    exit 1
fi

echo ">> applying migrations"
for migration in "$ROOT"/migrations/*.sql; do
    psql_run < "$migration" >/dev/null
    echo "   applied $(basename "$migration")"
done

out=$(mktemp)
expect_ok() {
    if psql_run <<<"$1" >"$out" 2>&1; then
        echo "   PASS  $2"
    else
        echo "   FAIL  $2 (expected this to succeed)"; sed 's/^/         /' "$out"; FAILED=1
    fi
}
expect_rejected() {
    if psql_run <<<"$1" >"$out" 2>&1; then
        echo "   FAIL  $2 (expected the database to reject this)"; FAILED=1
    else
        echo "   PASS  rejected: $2"
    fi
}

P_VICTIM=11111111-1111-1111-1111-111111111111
P_KILLER=22222222-2222-2222-2222-222222222222
BAL_V="(SELECT id FROM ledger_accounts WHERE kind='player_balance' AND player_id='$P_VICTIM')"
BAL_K="(SELECT id FROM ledger_accounts WHERE kind='player_balance' AND player_id='$P_KILLER')"
ESCROW="(SELECT id FROM ledger_accounts WHERE kind='match_escrow')"
PLATFORM="(SELECT id FROM ledger_accounts WHERE kind='platform_revenue')"
EXTERNAL="(SELECT id FROM ledger_accounts WHERE kind='external')"

echo
echo ">> the money path that must work"
expect_ok "INSERT INTO players (id,display_name) VALUES ('$P_VICTIM','victim'),('$P_KILLER','killer');
INSERT INTO ledger_accounts (kind,player_id) VALUES ('player_balance','$P_VICTIM'),('player_balance','$P_KILLER');" \
    "create two players with balance accounts"

expect_ok "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('a0000000-0000-0000-0000-000000000001','deposit','dep-1');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES
 ('a0000000-0000-0000-0000-000000000001',$EXTERNAL,-10000000),
 ('a0000000-0000-0000-0000-000000000001',$BAL_V,   10000000);
COMMIT;" "deposit \$10.00"

expect_ok "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('a0000000-0000-0000-0000-000000000002','life_purchase','life-1');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES
 ('a0000000-0000-0000-0000-000000000002',$BAL_V, -1000000),
 ('a0000000-0000-0000-0000-000000000002',$ESCROW, 1000000);
COMMIT;" "buy a life: \$1.00 into escrow"

expect_ok "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('a0000000-0000-0000-0000-000000000003','kill_settlement','kill-1');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES
 ('a0000000-0000-0000-0000-000000000003',$ESCROW,  -1000000),
 ('a0000000-0000-0000-0000-000000000003',$BAL_K,     900000),
 ('a0000000-0000-0000-0000-000000000003',$PLATFORM,  100000);
COMMIT;" "settle a kill: escrow -> killer \$0.90 + platform \$0.10"

echo
# A player who walks away mid-match: the reward back to them, the rake to
# us. The same three-way split a kill makes, with the player themself in the
# killer's place - which is the point, and is why it is worth a case of its
# own rather than being assumed to follow from the kill above.
expect_ok "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('a0000000-0000-0000-0000-000000000007','life_purchase','entry-abandoned');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES
 ('a0000000-0000-0000-0000-000000000007',$BAL_V,  -1000000),
 ('a0000000-0000-0000-0000-000000000007',$ESCROW,  1000000);
COMMIT;" "buy into a match that will be walked out of"

expect_ok "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('a0000000-0000-0000-0000-00000000000a','forfeit_settlement','abandon-1');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES
 ('a0000000-0000-0000-0000-00000000000a',$ESCROW, -1000000),
 ('a0000000-0000-0000-0000-00000000000a',$BAL_V,    900000),
 ('a0000000-0000-0000-0000-00000000000a',$PLATFORM, 100000);
COMMIT;" "walk away: escrow -> player \$0.90 + platform \$0.10"

# A player nobody killed keeps their stake. It is its own transaction kind
# rather than an `adjustment`, because an adjustment is somebody correcting
# the books by hand and this happens at the end of every match.
#
# A stake has to be in escrow before it can come back out, and the kill above
# emptied it - which the overdraw trigger says so loudly about that the first
# version of this test failed on it. So the victim buys into a second match
# and survives that one.
expect_ok "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('a0000000-0000-0000-0000-000000000008','life_purchase','entry-2');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES
 ('a0000000-0000-0000-0000-000000000008',$BAL_V,  -1000000),
 ('a0000000-0000-0000-0000-000000000008',$ESCROW,  1000000);
COMMIT;" "buy into a second match"

expect_ok "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('a0000000-0000-0000-0000-000000000009','entry_refund','refund-1');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES
 ('a0000000-0000-0000-0000-000000000009',$ESCROW, -1000000),
 ('a0000000-0000-0000-0000-000000000009',$BAL_V,   1000000);
COMMIT;" "refund a survivor: escrow -> player \$1.00"

echo
echo ">> ways of corrupting the books that must be refused"
expect_rejected "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('b0000000-0000-0000-0000-000000000001','deposit','unbalanced');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES
 ('b0000000-0000-0000-0000-000000000001',$EXTERNAL,-5000000),
 ('b0000000-0000-0000-0000-000000000001',$BAL_K,    7000000);
COMMIT;" "a transaction whose legs do not sum to zero"

expect_rejected "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('b0000000-0000-0000-0000-000000000002','deposit','single-leg');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES
 ('b0000000-0000-0000-0000-000000000002',$BAL_K,4200000);
COMMIT;" "a one-legged credit (money from nowhere)"

expect_rejected "INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('b0000000-0000-0000-0000-000000000003','deposit','autocommit');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES ('b0000000-0000-0000-0000-000000000003',$BAL_K,1000000);" \
    "an entry posted outside an explicit transaction"

expect_rejected "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('b0000000-0000-0000-0000-000000000004','life_purchase','overdraw');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES
 ('b0000000-0000-0000-0000-000000000004',$BAL_K, -99000000),
 ('b0000000-0000-0000-0000-000000000004',$ESCROW, 99000000);
COMMIT;" "overdrawing a player balance"

expect_rejected "UPDATE ledger_entries SET amount_micro_usd=999 WHERE id=(SELECT min(id) FROM ledger_entries);" \
    "editing a posted entry"
expect_rejected "DELETE FROM ledger_entries WHERE id=(SELECT min(id) FROM ledger_entries);" \
    "deleting a posted entry"
expect_rejected "INSERT INTO ledger_transactions (kind,idempotency_key) VALUES ('deposit','dep-1');" \
    "replaying an idempotency key"
expect_rejected "INSERT INTO ledger_transactions (kind,idempotency_key) VALUES ('adjustment','no-reason');" \
    "a manual adjustment with no stated reason"
expect_rejected "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('b0000000-0000-0000-0000-000000000005','deposit','zero');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES ('b0000000-0000-0000-0000-000000000005',$BAL_K,0);
COMMIT;" "a zero-amount entry"

echo
# The shape the server actually posts: one statement, the journal entry and
# every leg together, keyed so a replay is a no-op. It is a single statement
# and therefore a single transaction, which is what the deferred sum-to-zero
# check needs - but "therefore" is doing work there, so it is tested rather
# than reasoned about.
# A whole match buying in at once: one transaction, one leg per player and
# one for escrow. Charging player by player is the obvious shape and is the
# wrong one - thirteen round trips in a row took longer than a match was
# willing to wait to form, so a thirteen player match started with six.
echo
echo ">> a whole match buying in at once"
# Both need enough to sit down: by this point in the script the killer is
# carrying their winnings and not much else.
expect_ok "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('d0000000-0000-0000-0000-000000000000','deposit','top-up');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES
 ('d0000000-0000-0000-0000-000000000000',$EXTERNAL, -20000000),
 ('d0000000-0000-0000-0000-000000000000',$BAL_V,     10000000),
 ('d0000000-0000-0000-0000-000000000000',$BAL_K,     10000000);
COMMIT;" "top both players up"

expect_ok "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('d0000000-0000-0000-0000-000000000001','life_purchase','entry:match-1');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES
 ('d0000000-0000-0000-0000-000000000001',$BAL_V,  -1000000),
 ('d0000000-0000-0000-0000-000000000001',$BAL_K,  -1000000),
 ('d0000000-0000-0000-0000-000000000001',$ESCROW,  2000000);
COMMIT;" "two players buy into one match in one transaction"

# And each stake settles on its own afterwards, because a match ends player by
# player. The amount comes back out of the *player's* leg of that purchase,
# which is what stops a settlement disagreeing with what was charged.
expect_ok "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('d0000000-0000-0000-0000-000000000002','kill_settlement','kill:match-1:one');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES
 ('d0000000-0000-0000-0000-000000000002',$ESCROW, -1000000),
 ('d0000000-0000-0000-0000-000000000002',$BAL_K,    900000),
 ('d0000000-0000-0000-0000-000000000002',$PLATFORM, 100000);
COMMIT;" "one player of that match settles on their own"

expect_ok "BEGIN;
INSERT INTO ledger_transactions (id,kind,idempotency_key) VALUES ('d0000000-0000-0000-0000-000000000003','entry_refund','refund:match-1:two');
INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_usd) VALUES
 ('d0000000-0000-0000-0000-000000000003',$ESCROW, -1000000),
 ('d0000000-0000-0000-0000-000000000003',$BAL_K,   1000000);
COMMIT;" "and the other settles differently, out of the same purchase"

echo
echo ">> the one-statement form the server posts"
one_statement() {
    posted_as "$1" life_purchase "$2" "$3" "$4"
}
posted_as() {
    cat <<SQL
WITH t AS (
    INSERT INTO ledger_transactions (id, kind, idempotency_key)
    VALUES ('$1', '$2', '$3')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
)
INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_usd)
SELECT t.id, leg.account, leg.amount
  FROM t, UNNEST(ARRAY[$4]::uuid[], ARRAY[$5]::bigint[]) AS leg(account, amount);
SQL
}

expect_ok "$(one_statement c0000000-0000-0000-0000-000000000001 one-statement \
    "$BAL_V,$ESCROW" "-1000000,1000000")" \
    "a whole money event in one statement"

expect_rejected "$(one_statement c0000000-0000-0000-0000-000000000002 one-statement-bad \
    "$BAL_V,$ESCROW" "-1000000,2000000")" \
    "one statement whose legs do not sum to zero"

# The replay must insert nothing at all. `expect_ok` is right here: a replay
# is not an error, it is an event that has already happened - so what is
# checked is that the entry count did not move.
before=$(psql_run <<<"SELECT count(*) FROM ledger_entries;" | sed -n 3p | tr -d ' ')
expect_ok "$(one_statement c0000000-0000-0000-0000-000000000003 one-statement \
    "$BAL_V,$ESCROW" "-1000000,1000000")" \
    "replaying that statement is accepted and does nothing"
after=$(psql_run <<<"SELECT count(*) FROM ledger_entries;" | sed -n 3p | tr -d ' ')
if [ "$before" = "$after" ]; then
    echo "   PASS  the replay posted no entries ($before unchanged)"
else
    echo "   FAIL  the replay posted entries ($before -> $after)"; FAILED=1
fi

# Money that crosses the chain, in the one-statement form the server posts
# it. A deposit is keyed on the chain's signature for it, so the same
# transaction seen twice by the watcher is credited once.
echo
echo ">> money in and out, over the chain"
TREASURY="(SELECT id FROM ledger_accounts WHERE kind='treasury')"

expect_ok "$(posted_as e0000000-0000-0000-0000-000000000001 deposit 'deposit:5igAbc' \
    "$EXTERNAL,$BAL_V" "-25000000,25000000")" \
    "a deposit credited from the chain: external -> player"
before=$(psql_run <<<"SELECT count(*) FROM ledger_entries;" | sed -n 3p | tr -d ' ')
expect_ok "$(posted_as e0000000-0000-0000-0000-000000000002 deposit 'deposit:5igAbc' \
    "$EXTERNAL,$BAL_V" "-25000000,25000000")" \
    "the same signature seen twice is accepted and does nothing"
after=$(psql_run <<<"SELECT count(*) FROM ledger_entries;" | sed -n 3p | tr -d ' ')
if [ "$before" = "$after" ]; then
    echo "   PASS  a deposit is credited once however often it is seen"
else
    echo "   FAIL  a deposit was credited twice ($before -> $after)"; FAILED=1
fi

# A withdrawal leaves the player the moment it is asked for, and is held in
# `treasury` until the chain answers - so it cannot be spent twice while the
# transfer is in flight.
expect_ok "$(posted_as e0000000-0000-0000-0000-000000000003 withdrawal 'withdraw:w1' \
    "$BAL_V,$TREASURY" "-5000000,5000000")" \
    "withdrawal asked for: player -> treasury"
expect_ok "$(posted_as e0000000-0000-0000-0000-000000000004 withdrawal_sent 'withdrawn:w1' \
    "$TREASURY,$EXTERNAL" "-5000000,5000000")" \
    "final on chain: treasury -> external"

expect_ok "$(posted_as e0000000-0000-0000-0000-000000000005 withdrawal 'withdraw:w2' \
    "$BAL_V,$TREASURY" "-5000000,5000000")" \
    "a second withdrawal asked for"
expect_ok "$(posted_as e0000000-0000-0000-0000-000000000006 withdrawal_returned 'withdraw-returned:w2' \
    "$TREASURY,$BAL_V" "-5000000,5000000")" \
    "it never landed: treasury -> back to the player"

held=$(psql_run <<<"SELECT COALESCE(b.balance_micro_usd,0) FROM ledger_accounts a LEFT JOIN ledger_account_balances b ON b.account_id=a.id WHERE a.kind='treasury';" | sed -n 3p | tr -d ' ')
if [ "$held" = "0" ]; then
    echo "   PASS  treasury is empty once nothing is in flight"
else
    echo "   FAIL  treasury holds $held with nothing in flight"; FAILED=1
fi

expect_rejected "$(posted_as e0000000-0000-0000-0000-000000000007 withdrawal 'withdraw:w3' \
    "$BAL_V,$TREASURY" "-999000000,999000000")" \
    "withdrawing more than the wallet holds"

echo
echo ">> accounts, receipts and the withdrawal queue"
expect_ok "UPDATE players SET account_key_hash = '\\x01' WHERE id = '$P_VICTIM';" \
    "an account key hash is stored against a player"
expect_rejected "UPDATE players SET account_key_hash = '\\x01' WHERE id = '$P_KILLER';" \
    "two players sharing one account key"
expect_rejected "INSERT INTO treasury_receipts (signature, lamports, micro_usd_per_sol, outcome)
VALUES ('credit-to-nobody', 1000, 140000000, 'credited');" \
    "a credited deposit that names no player"
expect_ok "INSERT INTO treasury_receipts (signature, lamports, memo, micro_usd_per_sol, outcome)
VALUES ('held-for-nobody', 1000, 'hello', 140000000, 'unmatched');" \
    "a deposit nobody could be found for is recorded, not credited"
expect_rejected "INSERT INTO withdrawals (id, player_id, destination, amount_micro_usd, lamports, micro_usd_per_sol, status)
VALUES ('f0000000-0000-0000-0000-000000000001', '$P_VICTIM', 'x', 5000000, 35714285, 140000000, 'sent');" \
    "a withdrawal marked sent with no signature on record"
expect_ok "INSERT INTO withdrawals (id, player_id, destination, amount_micro_usd, lamports, micro_usd_per_sol)
VALUES ('f0000000-0000-0000-0000-000000000002', '$P_VICTIM', 'x', 5000000, 35714285, 140000000);" \
    "a withdrawal queued as requested"

echo
echo ">> final state"
docker exec -i "$CONTAINER" psql -U postgres -d ledgertest -t -A -F'  ' <<'SQL' | sed 's/^/   /'
SELECT a.kind, COALESCE(p.display_name,'-'), (b.balance_micro_usd::numeric/1000000)::money
  FROM ledger_accounts a
  JOIN ledger_account_balances b ON b.account_id = a.id
  LEFT JOIN players p ON p.id = a.player_id
 ORDER BY a.kind::text;
SQL

TOTAL=$(docker exec -i "$CONTAINER" psql -U postgres -d ledgertest -t -A -c "SELECT total_micro_usd FROM ledger_total;")
DRIFT=$(docker exec -i "$CONTAINER" psql -U postgres -d ledgertest -t -A -c "SELECT count(*) FROM ledger_balance_drift;")
[ "$TOTAL" = "0" ] || { echo "   FAIL  ledger does not sum to zero (got $TOTAL)"; FAILED=1; }
[ "$DRIFT" = "0" ] || { echo "   FAIL  $DRIFT account(s) drifted from their entries"; FAILED=1; }
echo "   ledger total: $TOTAL    drifted accounts: $DRIFT"

echo
if [ "$FAILED" -eq 0 ]; then
    echo "ALL LEDGER INVARIANTS HOLD"
else
    echo "LEDGER INVARIANT FAILURES - do not move money on this schema"
    exit 1
fi
