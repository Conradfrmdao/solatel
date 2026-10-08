//! The leaderboard and the live feed on the menu, at `/board`.
//!
//! Who won what, by the name they play under: the lives that won something,
//! newest first, and the week's biggest winners. Every figure is a sum over
//! `match_lives` - what the server counted when each stake settled - and the
//! winnings there are the kill rewards the ledger paid as the kills
//! happened.
//!
//! Unlike `/proof` it names people, so unlike `/proof` it is not offered to
//! other sites: no cross-origin header, for the game's own menu to read. The
//! names are display names, chosen by their players and already shown to
//! everybody they play against; no id, account or wallet is in it. Cached
//! for a short while, so a menu full of players costs one statement.

use crate::AppState;
use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::Value;
use sqlx::PgPool;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

/// How long an answer is served before it is read again: a feed that calls
/// itself live should not be a minute behind.
const FRESH_FOR: Duration = Duration::from_secs(15);

/// How many recent wins the feed shows, and how many players the board.
const RECENT: i64 = 8;
const LEADERS: i64 = 10;

/// The last answer.
#[derive(Clone, Default)]
pub struct Board {
    cached: Arc<Mutex<Option<(Instant, Value)>>>,
}

/// `GET /board`.
pub async fn handler(State(state): State<AppState>) -> Response {
    let mut cached = state.board.cached.lock().await;
    match cached.as_ref() {
        Some((at, value)) if at.elapsed() < FRESH_FOR => Json(value.clone()).into_response(),
        _ => match read(&state.pool).await {
            Ok(value) => {
                *cached = Some((Instant::now(), value.clone()));
                Json(value).into_response()
            }
            Err(err) => {
                tracing::warn!(?err, "could not read the board");
                match cached.as_ref() {
                    Some((_, value)) => Json(value.clone()).into_response(),
                    None => StatusCode::SERVICE_UNAVAILABLE.into_response(),
                }
            }
        },
    }
}

/// Both lists in one statement, as JSON built by Postgres. Amounts are
/// integer micro-USD; the menu formats them and computes nothing.
async fn read(pool: &PgPool) -> anyhow::Result<Value> {
    let text: String = sqlx::query_scalar(
        "WITH week AS (SELECT now() - interval '7 days' AS since)
         SELECT json_build_object(
             'as_of', now(),
             'recent',
                 (SELECT coalesce(json_agg(r ORDER BY r.at DESC), '[]') FROM (
                     SELECT coalesce(name, 'a player') AS name,
                            winnings_micro_usd, kills, map, stake_micro_usd,
                            ended_at AS at
                       FROM match_lives
                      WHERE winnings_micro_usd > 0
                      ORDER BY ended_at DESC
                      LIMIT $1) r),
             'leaders',
                 (SELECT coalesce(json_agg(l ORDER BY l.winnings_micro_usd DESC, l.kills DESC), '[]') FROM (
                     SELECT (array_agg(coalesce(name, 'a player') ORDER BY ended_at DESC))[1] AS name,
                            sum(winnings_micro_usd)::bigint AS winnings_micro_usd,
                            sum(kills)::bigint AS kills,
                            count(*) AS lives
                       FROM match_lives, week
                      WHERE ended_at > week.since
                      GROUP BY player_id
                     HAVING sum(winnings_micro_usd) > 0
                      ORDER BY sum(winnings_micro_usd) DESC, sum(kills) DESC
                      LIMIT $2) l)
         )::text",
    )
    .bind(RECENT)
    .bind(LEADERS)
    .fetch_one(pool)
    .await?;
    Ok(serde_json::from_str(&text)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::{Counts, Life, Outcome};
    use solatel_protocol::{MatchId, MicroUsd, PlayerId};

    /// A life that won something is in the feed under the name it was played
    /// under, and a week of a player's lives adds up on the board under the
    /// latest of their names; a life that won nothing is in neither.
    ///
    /// Ignored by default because it needs a database. Run it with
    /// `DATABASE_URL=... cargo test -p solatel-server -- --ignored board`;
    /// it makes its own players, touches nobody else's rows, and takes its
    /// lives away again when it has read the board.
    #[tokio::test]
    #[ignore = "needs a Postgres at DATABASE_URL"]
    async fn the_board_adds_up_what_each_name_won() {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let pool = crate::db::connect(&url).await.unwrap();
        crate::db::migrate(&pool).await.unwrap();

        // Winnings far above anything a real table pays, so this player is
        // at the top of the board whatever else the database holds.
        let winner = PlayerId::new();
        let loser = PlayerId::new();
        let life = |player_id: PlayerId, name: &str, kills: u32, winnings: i64| Life {
            match_id: MatchId::new(),
            player_id,
            name: name.to_string(),
            map: "yard",
            weapon: "rifle",
            stake: MicroUsd::from_usd(1),
            outcome: Outcome::Survived,
            counts: Counts {
                kills,
                ..Counts::default()
            },
            winnings: MicroUsd(winnings),
            alive_ms: 60_000,
        };
        crate::records::write_for_test(&pool, &life(winner, "Old Name", 3, 900_000_000))
            .await
            .unwrap();
        crate::records::write_for_test(&pool, &life(winner, "New Name", 2, 800_000_000))
            .await
            .unwrap();
        crate::records::write_for_test(&pool, &life(loser, "Nobody", 0, 0))
            .await
            .unwrap();

        let board = read(&pool).await.unwrap();
        let top = &board["leaders"][0];
        assert_eq!(top["name"], "New Name", "the latest name: {board}");
        assert_eq!(top["winnings_micro_usd"], 1_700_000_000_i64);
        assert_eq!(top["kills"], 5);
        assert_eq!(top["lives"], 2);
        let recent = board["recent"].as_array().unwrap();
        assert_eq!(recent[0]["name"], "New Name", "newest first: {board}");
        assert_eq!(recent[1]["name"], "Old Name");
        assert!(
            !recent.iter().any(|r| r["name"] == "Nobody")
                && !board["leaders"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["name"] == "Nobody"),
            "a life that won nothing is on neither list: {board}"
        );

        // Its winnings are far larger than any real table's, so they are not
        // left on the board of whatever database this ran against.
        sqlx::query("DELETE FROM match_lives WHERE player_id = ANY($1)")
            .bind(vec![winner.as_uuid(), loser.as_uuid()])
            .execute(&pool)
            .await
            .unwrap();
    }
}
