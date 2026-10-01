-- Sweeps from the hot treasury to cold storage (cold.rs).
--
-- Bookkept like a withdrawal - signed, the signature written down, then sent
-- and followed until the chain answers - but not a ledger transaction: the
-- money is the game's in both places. This is the record of where it went.
CREATE TABLE treasury_sweeps (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lamports                bigint NOT NULL CHECK (lamports > 0),
    destination             text NOT NULL,
    signature               text NOT NULL UNIQUE,
    signed_transaction      text NOT NULL,
    last_valid_block_height bigint NOT NULL,
    status                  text NOT NULL DEFAULT 'sent'
                            CHECK (status IN ('sent', 'landed', 'failed', 'expired')),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

-- One in flight at a time, which the database holds to as well as the code.
CREATE UNIQUE INDEX one_sweep_in_flight ON treasury_sweeps ((true)) WHERE status = 'sent';
