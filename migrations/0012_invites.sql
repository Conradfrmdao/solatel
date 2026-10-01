-- Invites (account.rs): every account has a code to hand out, and a new
-- account that arrived with somebody's code records whose it was.
--
-- Nothing here pays anybody. What an invite is worth is not decided; when it
-- is, the reward belongs on the invited player's real-money activity, not on
-- the sign-up, because accounts cost nothing to make.
ALTER TABLE players
    ADD COLUMN referral_code text UNIQUE,
    ADD COLUMN referred_by   uuid REFERENCES players(id) ON DELETE SET NULL,
    ADD CONSTRAINT nobody_invites_themselves CHECK (referred_by IS DISTINCT FROM id);

CREATE INDEX players_by_referrer ON players (referred_by) WHERE referred_by IS NOT NULL;
