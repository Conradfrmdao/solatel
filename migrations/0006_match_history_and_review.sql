-- Match history, and the review queue that sits in front of a payout.
--
-- Neither table holds money. Money is the ledger's, and a life's stake and
-- winnings are already in it; `match_lives` is what the server counted while
-- that stake was in play - shots, hits, kills - so that a human can look at a
-- player's record, and so that implausible records can be flagged for one to
-- look at.
--
--  * One row per life, written when the stake leaves escrow - killed,
--    survived to the whistle, or walked away - because that is the moment
--    the life is over and its numbers are final. Keyed on (match, player),
--    which is what a life is: one entry fee buys one life in one match.
--  * Every number in it was counted by the server. None of it is reported by
--    a client, and none of it could be.
--  * A review is opened by the server, never by a client, and closed only by
--    a person. While one is open or confirmed the player cannot withdraw:
--    what they have won stays in their balance, playable, until somebody has
--    looked. That is the "manual review checkpoint before a payout is
--    finalized" - a payout here is money leaving the ledger for the chain.

CREATE TYPE life_outcome AS ENUM (
    'killed',     -- another player took the stake
    'survived',   -- alive at the whistle; the stake came back
    'abandoned'   -- disconnected past the resume window, or fell out of the world
);

CREATE TABLE match_lives (
    match_id            uuid NOT NULL,
    player_id           uuid NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
    map                 text NOT NULL,
    stake_micro_usd     bigint NOT NULL CHECK (stake_micro_usd > 0),
    outcome             life_outcome NOT NULL,
    -- Who took the stake, when somebody did.
    killer_id           uuid,
    kills               integer NOT NULL CHECK (kills >= 0),
    shots_fired         integer NOT NULL CHECK (shots_fired >= 0),
    shots_hit           integer NOT NULL CHECK (shots_hit >= 0 AND shots_hit <= shots_fired),
    headshots           integer NOT NULL CHECK (headshots >= 0 AND headshots <= shots_hit),
    damage_dealt        integer NOT NULL CHECK (damage_dealt >= 0),
    -- Hits that landed at the end of a flick: the aim swung further than a
    -- player tracks in the moment before the shot. See `records.rs`.
    snap_hits           integer NOT NULL CHECK (snap_hits >= 0 AND snap_hits <= shots_hit),
    winnings_micro_usd  bigint NOT NULL CHECK (winnings_micro_usd >= 0),
    alive_ms            integer NOT NULL CHECK (alive_ms >= 0),
    ended_at            timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (match_id, player_id),
    CONSTRAINT a_killed_life_names_its_killer CHECK (
        (outcome = 'killed') = (killer_id IS NOT NULL)
    )
);

CREATE INDEX match_lives_by_player ON match_lives (player_id, ended_at DESC);
CREATE INDEX match_lives_by_time ON match_lives (ended_at DESC);

CREATE TYPE review_status AS ENUM (
    'open',       -- flagged by the server, waiting for a person
    'cleared',    -- a person looked and found nothing wrong
    'confirmed'   -- a person looked and found cheating; withdrawals stay shut
);

CREATE TABLE reviews (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id   uuid NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
    -- The life whose numbers tipped the player's record over a line.
    match_id    uuid,
    -- Which lines: 'accuracy', 'headshots', 'snaps'.
    reasons     text[] NOT NULL CHECK (cardinality(reasons) > 0),
    -- The record as it stood when it was flagged, and the lines it crossed,
    -- so the reviewer sees what the server saw rather than what it is now.
    evidence    jsonb NOT NULL,
    status      review_status NOT NULL DEFAULT 'open',
    decided_by  text,
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    decided_at  timestamptz,

    CONSTRAINT a_decision_says_who_and_why CHECK (
        status = 'open'
        OR (decided_by IS NOT NULL AND length(decided_by) > 0
            AND note IS NOT NULL AND length(note) > 0
            AND decided_at IS NOT NULL)
    )
);

-- One open review per player. A second suspicious life while the first is
-- waiting adds a row to `match_lives`, which the reviewer reads anyway; it
-- does not need a second review saying the same thing.
CREATE UNIQUE INDEX reviews_one_open_per_player
    ON reviews (player_id)
    WHERE status = 'open';

CREATE INDEX reviews_by_status ON reviews (status, created_at DESC);
