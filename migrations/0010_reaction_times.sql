-- Reaction times, for the anti-cheat (records.rs).
--
-- An engagement is measured at its first hit: how long the target had been
-- in the shooter's sight. `reactions` is how many were measured in a life and
-- `quick_reactions` how many of those came quicker than a person reacts.
-- Counts rather than times, like the rest of the row: the line is a share of
-- engagements, and a count sums over a player's recent lives exactly.
ALTER TABLE match_lives
    ADD COLUMN reactions       integer NOT NULL DEFAULT 0 CHECK (reactions >= 0),
    ADD COLUMN quick_reactions integer NOT NULL DEFAULT 0
        CHECK (quick_reactions >= 0 AND quick_reactions <= reactions);
