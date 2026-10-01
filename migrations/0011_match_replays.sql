-- A recording of every match, for whoever decides a review (replay.rs).
--
-- Plain text rather than jsonb: nothing queries inside it, it is handed to
-- the admin page whole, and text of this size is compressed by Postgres on
-- its own (TOAST). Kept for fourteen days, or for as long as somebody who
-- played in the match is under review or has been found against.
CREATE TABLE match_replays (
    match_id    uuid PRIMARY KEY,
    map         text NOT NULL,
    data        text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX match_replays_by_age ON match_replays (recorded_at);
