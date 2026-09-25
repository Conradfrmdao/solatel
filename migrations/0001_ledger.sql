-- Solatel ledger: append-only, double-entry, integer micro-USD.
--
-- Design notes, because these choices are expensive to reverse:
--
--  * There is no mutable `balance` column that code UPDATEs. A balance is the
--    sum of immutable journal entries. `ledger_account_balances` is a cache
--    maintained by trigger, and can always be rebuilt from `ledger_entries`.
--  * Every entry belongs to a transaction, and a transaction's entries must sum
--    to exactly zero. Money is never created or destroyed, only moved between
--    accounts, including the `external` account that represents the outside
--    world. This is checked by a deferred constraint at COMMIT.
--  * Every transaction carries a unique idempotency key. A client reconnect, a
--    retried webhook, or a replayed kill event can therefore never double-pay.
--  * All entries of a transaction MUST be INSERTed inside one explicit database
--    transaction. The sum-to-zero check is deferred to COMMIT, so a lone entry
--    posted in autocommit mode is its own transaction and is rejected. This is
--    verified by the ledger invariant tests.
--  * A paid life is held in `match_escrow` from spawn until the life ends. That
--    makes "player disconnected while still alive" a well-defined state with a
--    known amount of money sitting against it, rather than an accounting hole.

CREATE TYPE ledger_account_kind AS ENUM (
    'player_balance',   -- withdrawable money owed to a player
    'match_escrow',     -- entry fee for a life in progress
    'platform_revenue', -- Solatel's cut
    'treasury',         -- funds under our custody on-chain
    'external'          -- the world outside the ledger (deposits in, withdrawals out)
);

CREATE TYPE ledger_transaction_kind AS ENUM (
    'deposit',
    'life_purchase',      -- player_balance -> match_escrow
    'kill_settlement',    -- match_escrow -> killer + platform
    'forfeit_settlement', -- match_escrow -> platform (suicide, fall, disconnect)
    'withdrawal',
    'adjustment'          -- manual correction; always requires a reason
);

CREATE TABLE players (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    solana_pubkey   text UNIQUE,  -- NULL until a wallet is connected (Phase 4)
    display_name    text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_accounts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        ledger_account_kind NOT NULL,
    player_id   uuid REFERENCES players(id) ON DELETE RESTRICT,
    created_at  timestamptz NOT NULL DEFAULT now(),

    -- Player-owned accounts must name their player; system accounts must not.
    CONSTRAINT player_accounts_have_a_player CHECK (
        (kind = 'player_balance') = (player_id IS NOT NULL)
    )
);

-- Exactly one balance account per player.
CREATE UNIQUE INDEX ledger_accounts_one_balance_per_player
    ON ledger_accounts (player_id)
    WHERE kind = 'player_balance';

-- Exactly one of each system account.
CREATE UNIQUE INDEX ledger_accounts_singleton_system
    ON ledger_accounts (kind)
    WHERE kind IN ('match_escrow', 'platform_revenue', 'treasury', 'external');

CREATE TABLE ledger_transactions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            ledger_transaction_kind NOT NULL,
    -- Supplied by the caller, unique forever. This is what makes every
    -- money-moving operation safe to retry.
    idempotency_key text NOT NULL UNIQUE,
    reason          text,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT adjustments_require_a_reason CHECK (
        kind <> 'adjustment' OR (reason IS NOT NULL AND length(reason) > 0)
    )
);

CREATE TABLE ledger_entries (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id  uuid NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    account_id      uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
    -- Signed micro-USD. Negative debits the account, positive credits it.
    amount_micro_usd bigint NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT entries_are_never_zero CHECK (amount_micro_usd <> 0)
);

CREATE INDEX ledger_entries_by_account ON ledger_entries (account_id, id);
CREATE INDEX ledger_entries_by_transaction ON ledger_entries (transaction_id);

-- Cached balances. Derived data: safe to DELETE and rebuild from ledger_entries.
CREATE TABLE ledger_account_balances (
    account_id       uuid PRIMARY KEY REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
    balance_micro_usd bigint NOT NULL DEFAULT 0,
    entry_count      bigint NOT NULL DEFAULT 0,
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Invariants, enforced by the database rather than by application discipline.
-- ---------------------------------------------------------------------------

-- 1. Entries are append-only. Correcting a mistake means posting a reversing
--    transaction, which leaves an audit trail; it never means editing history.
CREATE FUNCTION ledger_entries_are_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only: % on entry % is not allowed; post a reversing transaction instead',
        TG_OP, OLD.id
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_entries_immutable
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_entries_are_append_only();

-- 2. Every transaction's entries sum to zero. Deferred to COMMIT so that the
--    individual INSERTs of a multi-leg transaction may be issued in any order.
CREATE FUNCTION ledger_transaction_must_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    total bigint;
BEGIN
    SELECT COALESCE(SUM(amount_micro_usd), 0) INTO total
      FROM ledger_entries
     WHERE transaction_id = NEW.transaction_id;

    IF total <> 0 THEN
        RAISE EXCEPTION 'ledger transaction % does not balance: entries sum to % micro-USD, expected 0',
            NEW.transaction_id, total
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_must_balance
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger_transaction_must_balance();

-- 3. Maintain the cached balance, and refuse to overdraw an account that holds
--    real player money. `external` is a contra account and goes negative by
--    design (it is the mirror of every deposit); `platform_revenue` and
--    `treasury` may also legitimately be negative mid-reconciliation.
CREATE FUNCTION ledger_apply_entry_to_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    new_balance bigint;
    account_kind ledger_account_kind;
BEGIN
    INSERT INTO ledger_account_balances AS b (account_id, balance_micro_usd, entry_count, updated_at)
    VALUES (NEW.account_id, NEW.amount_micro_usd, 1, now())
    ON CONFLICT (account_id) DO UPDATE
        SET balance_micro_usd = b.balance_micro_usd + EXCLUDED.balance_micro_usd,
            entry_count       = b.entry_count + 1,
            updated_at        = now()
    RETURNING b.balance_micro_usd INTO new_balance;

    SELECT kind INTO account_kind FROM ledger_accounts WHERE id = NEW.account_id;

    IF account_kind IN ('player_balance', 'match_escrow') AND new_balance < 0 THEN
        RAISE EXCEPTION 'account % (%) would be overdrawn to % micro-USD',
            NEW.account_id, account_kind, new_balance
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER ledger_entries_maintain_balance
    AFTER INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_apply_entry_to_balance();

-- ---------------------------------------------------------------------------
-- Reconciliation helpers. Used by the Phase 3 admin view and by tests.
-- ---------------------------------------------------------------------------

-- Cached balance vs. authoritative sum of entries. Must always be empty.
CREATE VIEW ledger_balance_drift AS
SELECT a.id AS account_id,
       a.kind,
       COALESCE(b.balance_micro_usd, 0) AS cached_micro_usd,
       COALESCE(e.summed, 0)            AS computed_micro_usd
  FROM ledger_accounts a
  LEFT JOIN ledger_account_balances b ON b.account_id = a.id
  LEFT JOIN (
      SELECT account_id, SUM(amount_micro_usd) AS summed
        FROM ledger_entries GROUP BY account_id
  ) e ON e.account_id = a.id
 WHERE COALESCE(b.balance_micro_usd, 0) <> COALESCE(e.summed, 0);

-- The whole ledger must sum to zero across every account, always.
CREATE VIEW ledger_total AS
SELECT COALESCE(SUM(amount_micro_usd), 0) AS total_micro_usd FROM ledger_entries;

-- The system accounts. Created here so the server never has to decide whether
-- they exist; it looks them up by kind.
INSERT INTO ledger_accounts (kind) VALUES
    ('match_escrow'),
    ('platform_revenue'),
    ('treasury'),
    ('external');
