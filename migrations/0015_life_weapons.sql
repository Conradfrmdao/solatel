-- The gun a life was played with: its primary, as the server settled it
-- when the match formed. Everybody also carries the pistol, so a life's
-- shots are both guns'; the primary is what the life chose.
--
-- The anti-cheat reads it. A sniper rifle that kills with one round to the
-- head is aimed at heads, and a good sniper's record would cross the lines
-- an automatic weapon's is held to; its lives are judged against their own.
-- Lives recorded before this have none and are judged as they always were.
ALTER TABLE match_lives ADD COLUMN weapon text;
