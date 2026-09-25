-- SUM() over a bigint column returns NUMERIC in Postgres, so both
-- reconciliation views exposed numeric columns and could not be decoded as
-- i64 by the server. Cast them back to bigint, which is what the underlying
-- amounts already are.
--
-- The views are replaced rather than altered because Postgres will not change
-- the data type of an existing view column.
--
-- Note for anyone reaching for these: both aggregate the entire journal. They
-- belong on a schedule (see solatel-server/src/reconcile.rs), never in a
-- per-request code path.

DROP VIEW IF EXISTS ledger_balance_drift;
CREATE VIEW ledger_balance_drift AS
SELECT a.id AS account_id,
       a.kind,
       COALESCE(b.balance_micro_usd, 0)::bigint AS cached_micro_usd,
       COALESCE(e.summed, 0)::bigint            AS computed_micro_usd
  FROM ledger_accounts a
  LEFT JOIN ledger_account_balances b ON b.account_id = a.id
  LEFT JOIN (
      SELECT account_id, SUM(amount_micro_usd)::bigint AS summed
        FROM ledger_entries GROUP BY account_id
  ) e ON e.account_id = a.id
 WHERE COALESCE(b.balance_micro_usd, 0) <> COALESCE(e.summed, 0);

DROP VIEW IF EXISTS ledger_total;
CREATE VIEW ledger_total AS
SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS total_micro_usd
  FROM ledger_entries;
