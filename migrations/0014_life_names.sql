-- The name a life was played under (board.rs), as it was when the match
-- formed. A display name is the player's own and changes when they change
-- it; a life keeps the one it was played under. Lives recorded before this
-- have none and are shown as "a player".
ALTER TABLE match_lives ADD COLUMN name text;

-- The board reads the lives that won something, newest first, and adds up a
-- week of them by player.
CREATE INDEX match_lives_winning ON match_lives (ended_at DESC) WHERE winnings_micro_usd > 0;
