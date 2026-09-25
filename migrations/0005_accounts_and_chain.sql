-- Accounts that outlive a tab, and the chain side of the wallet.

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
--
-- A balance hangs off a player id, and until now a player id lasted as long as
-- the browser tab that was given it. That was harmless while every dollar in
-- the game was a development grant and would have lost real money the first
-- time somebody deposited and then closed the tab.
--
-- A browser now holds an account key, and this is its hash. The key itself is
-- never stored: it is a bearer credential for somebody's money, and a copy of
-- this table should not be one.
ALTER TABLE players ADD COLUMN account_key_hash bytea UNIQUE;

-- ---------------------------------------------------------------------------
-- Deposits
-- ---------------------------------------------------------------------------
--
-- Every transaction touching the treasury that the watcher has looked at, and
-- what it made of it. Money is credited through the ledger under the key
-- `deposit:<signature>`; this table is what stops the same signature being
-- fetched and judged on every pass, and it keeps the ones that were *not*
-- credited - a deposit whose memo named nobody is money we hold for somebody,
-- and it has to be findable to be given back.
CREATE TABLE treasury_receipts (
    signature           text PRIMARY KEY,
    -- What the treasury gained. Zero for a transaction that paid it nothing,
    -- which is usually one of our own withdrawals.
    lamports            bigint NOT NULL CHECK (lamports >= 0),
    memo                text,
    player_id           uuid REFERENCES players(id) ON DELETE RESTRICT,
    micro_usd           bigint NOT NULL DEFAULT 0 CHECK (micro_usd >= 0),
    micro_usd_per_sol   bigint NOT NULL CHECK (micro_usd_per_sol > 0),
    outcome             text NOT NULL CHECK (outcome IN (
                            'credited',     -- in the player's wallet
                            'unmatched',    -- the memo names nobody we know
                            'too_small',    -- worth less than one micro-USD
                            'not_incoming'  -- it did not pay the treasury
                        )),
    block_time          timestamptz,
    seen_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT credited_deposits_name_a_player CHECK (
        (outcome = 'credited') = (player_id IS NOT NULL AND micro_usd > 0)
    )
);

-- ---------------------------------------------------------------------------
-- Withdrawals
-- ---------------------------------------------------------------------------
--
-- A work queue, not a ledger. The money is in the ledger, which stays
-- append-only; this is where a withdrawal *is* on its way to the chain, and it
-- is updated as it moves. Every status change that moves money posts a ledger
-- transaction keyed on the withdrawal id, inside the same database
-- transaction as the update, so the two cannot disagree.
CREATE TYPE withdrawal_status AS ENUM (
    'requested',  -- out of the player's balance, into `treasury`; not signed
    'sent',       -- signed, and the signature recorded; not yet final
    'settled',    -- final on chain; `treasury` -> `external`
    'returned'    -- never landed; `treasury` -> the player
);

CREATE TABLE withdrawals (
    id                      uuid PRIMARY KEY,
    player_id               uuid NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
    destination             text NOT NULL,
    amount_micro_usd        bigint NOT NULL CHECK (amount_micro_usd > 0),
    -- Fixed when it is asked for, at the rate in force then. A rate changed
    -- while a transfer is in flight does not change what that transfer is.
    lamports                bigint NOT NULL CHECK (lamports > 0),
    micro_usd_per_sol       bigint NOT NULL CHECK (micro_usd_per_sol > 0),
    status                  withdrawal_status NOT NULL DEFAULT 'requested',
    -- Known before anything is sent: a transaction's first signature is its
    -- id. Recording it first is what makes sending safe to repeat - the same
    -- signed bytes are the same transaction, and the chain will not run it
    -- twice.
    signature               text UNIQUE,
    signed_transaction      text,
    -- Past this block height the transaction can never be included, so a
    -- signature the chain has still not seen by then is one it never will.
    last_valid_block_height bigint,
    reason                  text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sent_withdrawals_are_signed CHECK (
        status = 'requested'
        OR status = 'returned'
        OR (signature IS NOT NULL
            AND signed_transaction IS NOT NULL
            AND last_valid_block_height IS NOT NULL)
    )
);

CREATE INDEX withdrawals_in_flight ON withdrawals (created_at)
    WHERE status IN ('requested', 'sent');
CREATE INDEX withdrawals_by_player ON withdrawals (player_id, created_at DESC);
