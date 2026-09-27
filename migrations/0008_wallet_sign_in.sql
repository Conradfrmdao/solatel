-- Signing in with a Solana wallet.
--
-- The account key in a browser's storage is a bearer credential for the
-- balance, and losing it loses the balance. The answer is the wallet the
-- money came from: the player signs a challenge with it, the server checks
-- the signature, and the account carries the wallet's public key in
-- `players.solana_pubkey`, which has waited for this since the first
-- migration and is already unique.
--
-- Signing in with that wallet from another browser signs that browser in as
-- the account, which needs a key for it. The server keeps only hashes and
-- cannot send the first key again, and taking it away from the browser that
-- holds it would sign that one out; so each wallet sign-in makes a key of its
-- own, here, and the first stays in `players.account_key_hash` where it was.
CREATE TABLE account_keys (
    key_hash    bytea PRIMARY KEY,
    player_id   uuid NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
    made_for    text NOT NULL CHECK (made_for IN ('wallet_sign_in')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX account_keys_by_player ON account_keys (player_id);
