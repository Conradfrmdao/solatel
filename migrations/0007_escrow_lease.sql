-- The escrow lease: which running server owns the stakes in escrow.
--
-- Escrow holds one entry fee per player in a running match, and a match
-- lives in the memory of the process running it. At startup a server settles
-- every stake it finds in escrow as a walk-away, because a process going away
-- is every one of its players disconnecting at once. That is only right if
-- the stakes it finds are orphans. A second server pointed at this database
-- would find the first one's live stakes and forfeit them while they are
-- still being played for.
--
-- So a server takes this lease before it touches escrow, renews it while it
-- runs, and gives it up when it stops. Another one waits for it to expire -
-- which a crashed holder's does within the lease's length - and refuses to
-- start if it never does. A server that finds its lease gone stops.
--
-- A row with a heartbeat rather than a Postgres advisory lock: an advisory
-- lock belongs to one database session, and behind a transaction-pooling
-- proxy (Neon's `-pooler` endpoint is one) the session that took it is not
-- the one that runs the next statement.
--
-- Keyed by name so that the tests can take leases of their own without
-- touching the one a running server holds.

CREATE TABLE escrow_lease (
    name        text PRIMARY KEY,
    holder      uuid NOT NULL,
    host        text NOT NULL,
    acquired_at timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL
);
