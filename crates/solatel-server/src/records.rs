//! Match history, and flagging records nobody should be able to post.
//!
//! Every life leaves a row in `match_lives` when its stake leaves escrow:
//! where it was played, for how much, how it ended, and what the server
//! counted while it lasted. That is the match history an operator reads, and
//! it is what the anti-cheat judges.
//!
//! # What is judged, and what is done about it
//!
//! A player's last [`RECENT_LIVES`] lives are summed and held against three
//! lines - accuracy, the share of hits that were headshots, and the share
//! that landed at the end of a flick - each with a minimum sample under which
//! it says nothing at all. Cross any line and a review is opened.
//!
//! A review decides nothing. It is a question for a person, and until one
//! answers it the player cannot withdraw: what they have won stays in their
//! balance and they can keep playing with it, but it does not leave for the
//! chain. That is the checkpoint the product asks for in front of a payout,
//! and it is the whole of the enforcement. Nothing here takes money back or
//! stops anybody playing - both of those are a person's decision, made in the
//! admin view with the record in front of them.
//!
//! The lines are deliberately generous. A false flag costs a real player a
//! delayed withdrawal and costs us their trust; a missed one costs a payout
//! we can still refuse later. They are starting points to be tuned against
//! real records, not facts about human aim, and the reviewer sees every number
//! that tripped one.
//!
//! # Why it has its own queue
//!
//! Writing a life is two or three statements, and statements against a
//! managed Postgres are round trips of half a second each. On the ledger's
//! queue that would put every life ended in front of the next payout. Nothing
//! here moves money, so nothing here needs to be in line with money; the one
//! place the two meet - a withdrawal checking for an open review - reads the
//! reviews table in the statement it already makes.

use anyhow::{Context, Result};
use serde_json::json;
use solatel_protocol::{
    MicroUsd,
    ids::{MatchId, PlayerId},
};
use sqlx::PgPool;
use tokio::sync::mpsc;

/// How many of a player's lives are judged together. One life is too few
/// shots to say anything about; a whole history lets somebody who started
/// cheating last week hide behind a year of honest play.
pub const RECENT_LIVES: i64 = 20;

/// Accuracy: hits over shots fired, over at least this many shots.
///
/// A rifle held on a moving target lands a quarter to a third of its shots.
/// Seven in ten across sixty shots, against people who are shooting back, is
/// a bot or a player who is never missing, and either is worth a look.
pub const ACCURACY_LINE: f64 = 0.70;
pub const ACCURACY_MIN_SHOTS: i64 = 60;

/// Headshots over hits, over at least this many hits. The head is the
/// smallest box on a body and moves the most.
pub const HEADSHOT_LINE: f64 = 0.65;
pub const HEADSHOT_MIN_HITS: i64 = 25;

/// Hits that ended a flick, over hits, over at least this many hits.
///
/// A flick is the aim turning more than [`SNAP_DEGREES`] in the
/// [`SNAP_WINDOW_SECONDS`] before the shot. People flick, and land them; what
/// people do not do is land most of their hits that way, because a flick is
/// a guess about where the target is and tracking is how you confirm it. An
/// aimbot does not need to confirm anything.
pub const SNAP_LINE: f64 = 0.45;
pub const SNAP_MIN_HITS: i64 = 15;

/// How far the aim has to have swung, and how quickly, for a hit to count as
/// the end of a flick: thirty degrees in a tenth of a second, three hundred
/// degrees a second, sustained right up to the shot.
pub const SNAP_DEGREES: f32 = 30.0;
pub const SNAP_WINDOW_SECONDS: f32 = 0.1;

/// How a life ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Killed { killer: PlayerId },
    Survived,
    Abandoned,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Killed { .. } => "killed",
            Self::Survived => "survived",
            Self::Abandoned => "abandoned",
        }
    }

    fn killer(self) -> Option<PlayerId> {
        match self {
            Self::Killed { killer } => Some(killer),
            _ => None,
        }
    }
}

/// What the server counted over one life.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counts {
    pub kills: u32,
    pub shots_fired: u32,
    pub shots_hit: u32,
    pub headshots: u32,
    pub damage_dealt: u32,
    pub snap_hits: u32,
}

/// One life, over.
#[derive(Debug, Clone, PartialEq)]
pub struct Life {
    pub match_id: MatchId,
    pub player_id: PlayerId,
    pub map: &'static str,
    pub stake: MicroUsd,
    pub outcome: Outcome,
    pub counts: Counts,
    pub winnings: MicroUsd,
    pub alive_ms: u32,
}

/// A player's recent lives, added up.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Record {
    pub lives: i64,
    pub kills: i64,
    pub shots_fired: i64,
    pub shots_hit: i64,
    pub headshots: i64,
    pub snap_hits: i64,
}

impl Record {
    fn ratio(part: i64, whole: i64) -> f64 {
        if whole > 0 {
            part as f64 / whole as f64
        } else {
            0.0
        }
    }

    pub fn accuracy(&self) -> f64 {
        Self::ratio(self.shots_hit, self.shots_fired)
    }

    pub fn headshot_share(&self) -> f64 {
        Self::ratio(self.headshots, self.shots_hit)
    }

    pub fn snap_share(&self) -> f64 {
        Self::ratio(self.snap_hits, self.shots_hit)
    }
}

/// Which lines a record crosses. Empty is the answer almost every time.
///
/// Ratios are compared as floats because nothing here is money: they are
/// judgements for a person to check, and every one of them goes to the
/// reviewer alongside the counts it came from.
pub fn judge(record: &Record) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if record.shots_fired >= ACCURACY_MIN_SHOTS && record.accuracy() >= ACCURACY_LINE {
        reasons.push("accuracy");
    }
    if record.shots_hit >= HEADSHOT_MIN_HITS && record.headshot_share() >= HEADSHOT_LINE {
        reasons.push("headshots");
    }
    if record.shots_hit >= SNAP_MIN_HITS && record.snap_share() >= SNAP_LINE {
        reasons.push("snaps");
    }
    reasons
}

#[derive(Clone)]
pub struct RecordsHandle {
    lives: mpsc::Sender<Life>,
}

impl RecordsHandle {
    /// Queues a life to be written. A full queue drops it with a log line
    /// rather than holding up the game; nothing here is money, and a missing
    /// row of history is not worth a stalled tick.
    pub fn send(&self, life: Life) {
        if let Err(err) = self.lives.try_send(life) {
            tracing::error!(%err, "records queue full or closed; a life went unrecorded");
        }
    }
}

#[cfg(test)]
impl RecordsHandle {
    /// Records nothing, and keeps what it was given for a test to read.
    pub fn recording() -> (Self, mpsc::Receiver<Life>) {
        let (tx, rx) = mpsc::channel(64);
        (Self { lives: tx }, rx)
    }
}

/// Starts the task that writes lives and opens reviews.
pub fn spawn(pool: PgPool) -> RecordsHandle {
    let (tx, mut rx) = mpsc::channel::<Life>(4096);
    tokio::spawn(async move {
        while let Some(life) = rx.recv().await {
            match write(&pool, &life).await {
                Ok(Some(reasons)) => tracing::warn!(
                    player = %life.player_id,
                    match_id = %life.match_id,
                    ?reasons,
                    "record flagged for review; withdrawals are held until somebody looks"
                ),
                Ok(None) => {}
                Err(err) => tracing::error!(
                    ?err,
                    player = %life.player_id,
                    match_id = %life.match_id,
                    "could not record a life"
                ),
            }
        }
    });
    RecordsHandle { lives: tx }
}

/// Write one life, then judge the record it is now part of. Answers the
/// reasons a review was opened for, if one was.
async fn write(pool: &PgPool, life: &Life) -> Result<Option<Vec<&'static str>>> {
    let c = life.counts;
    // The player's row is made if this is the first the database has heard
    // of them, which in a free-play or test server it can be.
    let written = sqlx::query(
        "WITH known AS (
             INSERT INTO players (id) VALUES ($2) ON CONFLICT (id) DO NOTHING
         )
         INSERT INTO match_lives
             (match_id, player_id, map, stake_micro_usd, outcome, killer_id,
              kills, shots_fired, shots_hit, headshots, damage_dealt, snap_hits,
              winnings_micro_usd, alive_ms)
         VALUES ($1, $2, $3, $4, $5::life_outcome, $6,
                 $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (match_id, player_id) DO NOTHING",
    )
    .bind(life.match_id.as_uuid())
    .bind(life.player_id.as_uuid())
    .bind(life.map)
    .bind(life.stake.micros())
    .bind(life.outcome.as_str())
    .bind(life.outcome.killer().map(PlayerId::as_uuid))
    .bind(c.kills as i32)
    .bind(c.shots_fired as i32)
    .bind(c.shots_hit.min(c.shots_fired) as i32)
    .bind(c.headshots.min(c.shots_hit) as i32)
    .bind(c.damage_dealt as i32)
    .bind(c.snap_hits.min(c.shots_hit) as i32)
    .bind(life.winnings.micros().max(0))
    .bind(life.alive_ms as i32)
    .execute(pool)
    .await
    .context("writing a life")?;
    // Already written: a retry, or a settlement raised twice. Judged once.
    if written.rows_affected() == 0 {
        return Ok(None);
    }

    let record = recent_record(pool, life.player_id).await?;
    let reasons = judge(&record);
    if reasons.is_empty() {
        return Ok(None);
    }

    let evidence = json!({
        "lives": record.lives,
        "kills": record.kills,
        "shots_fired": record.shots_fired,
        "shots_hit": record.shots_hit,
        "headshots": record.headshots,
        "snap_hits": record.snap_hits,
        "accuracy": record.accuracy(),
        "headshot_share": record.headshot_share(),
        "snap_share": record.snap_share(),
        "lines": {
            "accuracy": { "at_least": ACCURACY_LINE, "over_shots": ACCURACY_MIN_SHOTS },
            "headshots": { "at_least": HEADSHOT_LINE, "over_hits": HEADSHOT_MIN_HITS },
            "snaps": {
                "at_least": SNAP_LINE,
                "over_hits": SNAP_MIN_HITS,
                "degrees": SNAP_DEGREES,
                "within_seconds": SNAP_WINDOW_SECONDS,
            },
        },
    });
    let opened = sqlx::query(
        "INSERT INTO reviews (player_id, match_id, reasons, evidence)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (player_id) WHERE status = 'open' DO NOTHING",
    )
    .bind(life.player_id.as_uuid())
    .bind(life.match_id.as_uuid())
    .bind(reasons.iter().map(|r| r.to_string()).collect::<Vec<_>>())
    .bind(evidence)
    .execute(pool)
    .await
    .context("opening a review")?;
    Ok((opened.rows_affected() > 0).then_some(reasons))
}

/// A player's last [`RECENT_LIVES`] lives, summed.
pub async fn recent_record(pool: &PgPool, player_id: PlayerId) -> Result<Record> {
    let row: (i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT count(*),
                coalesce(sum(kills), 0)::bigint,
                coalesce(sum(shots_fired), 0)::bigint,
                coalesce(sum(shots_hit), 0)::bigint,
                coalesce(sum(headshots), 0)::bigint,
                coalesce(sum(snap_hits), 0)::bigint
           FROM (SELECT * FROM match_lives
                  WHERE player_id = $1
                  ORDER BY ended_at DESC
                  LIMIT $2) recent",
    )
    .bind(player_id.as_uuid())
    .bind(RECENT_LIVES)
    .fetch_one(pool)
    .await
    .context("reading a player's recent record")?;
    Ok(Record {
        lives: row.0,
        kills: row.1,
        shots_fired: row.2,
        shots_hit: row.3,
        headshots: row.4,
        snap_hits: row.5,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(shots_fired: i64, shots_hit: i64, headshots: i64, snap_hits: i64) -> Record {
        Record {
            lives: 10,
            kills: 5,
            shots_fired,
            shots_hit,
            headshots,
            snap_hits,
        }
    }

    #[test]
    fn an_ordinary_record_crosses_no_line() {
        // A good player: a third of their shots land, a fifth of those in
        // the head, a few at the end of a flick.
        assert!(judge(&record(300, 100, 20, 10)).is_empty());
    }

    #[test]
    fn a_small_sample_says_nothing_however_perfect() {
        // Five shots, five hits, five headshots, all flicks: a lucky life,
        // and not enough of one to mean anything.
        assert!(judge(&record(5, 5, 5, 5)).is_empty());
        assert!(judge(&record(ACCURACY_MIN_SHOTS - 1, ACCURACY_MIN_SHOTS - 1, 0, 0)).is_empty());
    }

    #[test]
    fn each_line_is_crossed_on_its_own() {
        assert_eq!(judge(&record(100, 75, 10, 5)), vec!["accuracy"]);
        assert_eq!(judge(&record(200, 40, 30, 5)), vec!["headshots"]);
        assert_eq!(judge(&record(200, 40, 5, 20)), vec!["snaps"]);
    }

    #[test]
    fn an_aimbot_crosses_all_three() {
        assert_eq!(
            judge(&record(120, 110, 100, 90)),
            vec!["accuracy", "headshots", "snaps"]
        );
    }

    #[test]
    fn the_lines_are_inclusive_at_exactly_the_minimum_sample() {
        let shots = ACCURACY_MIN_SHOTS;
        let hits = (shots as f64 * ACCURACY_LINE).ceil() as i64;
        assert_eq!(judge(&record(shots, hits, 0, 0)), vec!["accuracy"]);
    }

    /// Against a real Postgres: an aimbot's record opens a review, a second
    /// suspicious life does not open a second one, and the review is what a
    /// withdrawal sees.
    ///
    /// Ignored by default because it needs a database. Run it with
    /// `DATABASE_URL=... cargo test -p solatel-server -- --ignored records`;
    /// it makes its own players and touches nobody else's rows.
    #[tokio::test]
    #[ignore = "needs a Postgres at DATABASE_URL"]
    async fn records_against_a_real_database() {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let pool = crate::db::connect(&url).await.unwrap();
        crate::db::migrate(&pool).await.unwrap();

        let honest = PlayerId::new();
        let cheat = PlayerId::new();
        let life = |player_id, counts| Life {
            match_id: MatchId::new(),
            player_id,
            map: "arena",
            stake: MicroUsd::from_usd(1),
            outcome: Outcome::Survived,
            counts,
            winnings: MicroUsd::ZERO,
            alive_ms: 60_000,
        };
        let aimbot = Counts {
            kills: 9,
            shots_fired: 60,
            shots_hit: 57,
            headshots: 45,
            damage_dealt: 1500,
            snap_hits: 45,
        };
        let ordinary = Counts {
            kills: 1,
            shots_fired: 40,
            shots_hit: 12,
            headshots: 2,
            damage_dealt: 300,
            snap_hits: 1,
        };

        // A short life, perfect but under every minimum sample: nothing yet.
        let lucky = Counts {
            kills: 1,
            shots_fired: 5,
            shots_hit: 5,
            headshots: 4,
            damage_dealt: 150,
            snap_hits: 4,
        };
        assert_eq!(write(&pool, &life(cheat, lucky)).await.unwrap(), None);
        // A long one on top of it is not, and all three lines are crossed.
        assert_eq!(
            write(&pool, &life(cheat, aimbot)).await.unwrap(),
            Some(vec!["accuracy", "headshots", "snaps"])
        );
        // A third while that review is open opens no second one.
        assert_eq!(write(&pool, &life(cheat, aimbot)).await.unwrap(), None);
        for _ in 0..3 {
            assert_eq!(write(&pool, &life(honest, ordinary)).await.unwrap(), None);
        }

        let record = recent_record(&pool, cheat).await.unwrap();
        assert_eq!(record.lives, 3);
        assert_eq!(record.shots_hit, 5 + 57 + 57);

        let (_, held) = crate::ledger::balance_and_review(&pool, cheat).await.unwrap();
        assert_eq!(held.as_deref(), Some("open"), "the cheat's withdrawals are held");
        let (_, clear) = crate::ledger::balance_and_review(&pool, honest).await.unwrap();
        assert_eq!(clear, None, "an honest record holds nothing");

        // A life written twice - a retried settlement - is one row.
        let twice = life(honest, ordinary);
        write(&pool, &twice).await.unwrap();
        write(&pool, &twice).await.unwrap();
        assert_eq!(recent_record(&pool, honest).await.unwrap().lives, 4);
    }

    #[test]
    fn nothing_divides_by_zero() {
        let empty = Record::default();
        assert_eq!(empty.accuracy(), 0.0);
        assert_eq!(empty.headshot_share(), 0.0);
        assert_eq!(empty.snap_share(), 0.0);
        assert!(judge(&empty).is_empty());
    }
}
