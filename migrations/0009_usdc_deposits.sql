-- USDC deposits.
--
-- The PRD takes entry fees in SOL or USDC on Solana. USDC arrives in the
-- treasury's associated token account for Circle's mint, with the same memo
-- a SOL deposit carries, and is credited one base unit to one micro-USD:
-- USDC has six decimals, so no rate is involved. A receipt records what
-- arrived of each; `micro_usd` stays what was credited in all.
ALTER TABLE treasury_receipts
    ADD COLUMN usdc_units bigint NOT NULL DEFAULT 0 CHECK (usdc_units >= 0);
