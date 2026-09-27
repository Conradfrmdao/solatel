//! The public record of what the game has paid.
//!
//! Early players of a real-money game expect to be farmed, and they are right
//! to. The answer is visible proof of payouts, and this is that proof as data.
//! Every figure is summed from the same double-entry ledger that pays the
//! players - not a counter kept beside it, which could disagree with it - and
//! every withdrawal that has landed carries its signature, which anybody can
//! look up on an explorer without taking our word for anything.
//!
//! It names nobody. A total is a fact about the game; who earned it is a fact
//! about a person, and a public page should carry none of those. Where a
//! withdrawal went is on the chain for anybody who follows its signature,
//! which is the nature of a public chain rather than something this adds.
//!
//! It is public and unauthenticated, so it is cached: one statement at most
//! once a minute however many people are reading, and a stale answer rather
//! than none if the database is briefly away - each answer says when it was
//! read. Any origin may read it, so a community page or a bot can quote it.

use crate::AppState;
use axum::{
    Json,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::Value;
use sqlx::PgPool;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

/// How long an answer is served before the ledger is read again.
const FRESH_FOR: Duration = Duration::from_secs(60);

/// How many landed withdrawals are listed with their signatures.
const RECENT: i64 = 10;

/// The last answer, and what the server says about itself alongside it.
#[derive(Clone)]
pub struct Proof {
    cached: Arc<Mutex<Option<(Instant, Value)>>>,
    /// Which chain the money moves on, when this server has a wallet.
    network: Option<&'static str>,
    /// Whether this server funds new players with development money, which
    /// is most of what its totals will be.
    dev_money: bool,
}

impl Proof {
    pub fn new(has_wallet: bool, dev_money: bool) -> Self {
        Self {
            cached: Arc::default(),
            // `solana::Cluster::devnet()` is the only cluster there is.
            network: has_wallet.then_some("devnet"),
            dev_money,
        }
    }
}

/// `GET /proof`.
pub async fn handler(State(state): State<AppState>) -> Response {
    let proof = &state.proof;
    let value = {
        // Held across the read, so a crowd arriving at once waits for one
        // statement instead of each sending its own.
        let mut cached = proof.cached.lock().await;
        match cached.as_ref() {
            Some((at, value)) if at.elapsed() < FRESH_FOR => value.clone(),
            _ => match read(&state.pool).await {
                Ok(value) => {
                    *cached = Some((Instant::now(), value.clone()));
                    value
                }
                Err(err) => {
                    tracing::warn!(?err, "could not read the payout record");
                    match cached.as_ref() {
                        Some((_, value)) => value.clone(),
                        None => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
                    }
                }
            },
        }
    };
    let mut value = value;
    if let Value::Object(fields) = &mut value {
        fields.insert("network".into(), proof.network.into());
        fields.insert("dev_money".into(), proof.dev_money.into());
    }
    let mut response = Json(value).into_response();
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    response
}

/// The whole record in one statement, as JSON built by Postgres.
///
/// Every amount is integer micro-USD, as the ledger holds it; the page that
/// shows them formats and computes nothing.
async fn read(pool: &PgPool) -> anyhow::Result<Value> {
    let text: String = sqlx::query_scalar(
        "WITH legs AS (
             SELECT t.kind::text AS kind, a.kind::text AS account,
                    e.amount_micro_usd AS amount, t.created_at
               FROM ledger_transactions t
               JOIN ledger_entries e ON e.transaction_id = t.id
               JOIN ledger_accounts a ON a.id = e.account_id
              WHERE t.kind IN ('kill_settlement', 'forfeit_settlement',
                               'entry_refund', 'withdrawal_sent')
         ),
         day AS (SELECT now() - interval '24 hours' AS since)
         SELECT json_build_object(
             'as_of', now(),
             'kills_paid',
                 (SELECT count(*) FROM legs
                   WHERE kind = 'kill_settlement' AND account = 'player_balance'),
             'kill_rewards_micro_usd',
                 (SELECT coalesce(sum(amount), 0)::bigint FROM legs
                   WHERE kind = 'kill_settlement' AND account = 'player_balance'),
             'kills_paid_24h',
                 (SELECT count(*) FROM legs, day
                   WHERE kind = 'kill_settlement' AND account = 'player_balance'
                     AND created_at > day.since),
             'kill_rewards_24h_micro_usd',
                 (SELECT coalesce(sum(amount), 0)::bigint FROM legs, day
                   WHERE kind = 'kill_settlement' AND account = 'player_balance'
                     AND created_at > day.since),
             'survivors',
                 (SELECT count(*) FROM legs
                   WHERE kind = 'entry_refund' AND account = 'player_balance'),
             'stakes_returned_micro_usd',
                 (SELECT coalesce(sum(amount), 0)::bigint FROM legs
                   WHERE kind = 'entry_refund' AND account = 'player_balance'),
             'house_cut_micro_usd',
                 (SELECT coalesce(sum(amount), 0)::bigint FROM legs
                   WHERE account = 'platform_revenue'),
             'withdrawals',
                 (SELECT count(*) FROM legs
                   WHERE kind = 'withdrawal_sent' AND account = 'external'),
             'withdrawn_micro_usd',
                 (SELECT coalesce(sum(amount), 0)::bigint FROM legs
                   WHERE kind = 'withdrawal_sent' AND account = 'external'),
             'recent_withdrawals',
                 (SELECT coalesce(json_agg(w ORDER BY w.at DESC), '[]') FROM (
                     SELECT amount_micro_usd, lamports, signature, updated_at AS at
                       FROM withdrawals
                      WHERE status = 'settled'
                      ORDER BY updated_at DESC
                      LIMIT $1) w),
             'best_life',
                 (SELECT json_build_object(
                             'kills', kills,
                             'winnings_micro_usd', winnings_micro_usd,
                             'stake_micro_usd', stake_micro_usd,
                             'map', map,
                             'at', ended_at)
                    FROM match_lives
                   WHERE winnings_micro_usd > 0
                   ORDER BY winnings_micro_usd DESC, kills DESC, ended_at DESC
                   LIMIT 1),
             'players_24h',
                 (SELECT count(DISTINCT player_id) FROM match_lives, day
                   WHERE ended_at > day.since),
             'lives_24h',
                 (SELECT count(*) FROM match_lives, day WHERE ended_at > day.since),
             'in_play_micro_usd',
                 (SELECT coalesce(sum(b.balance_micro_usd), 0)::bigint
                    FROM ledger_accounts a
                    JOIN ledger_account_balances b ON b.account_id = a.id
                   WHERE a.kind = 'match_escrow')
         )::text",
    )
    .bind(RECENT)
    .fetch_one(pool)
    .await?;
    Ok(serde_json::from_str(&text)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The record agrees with the ledger it is read from: a kill settled
    /// for a player shows up in the totals as exactly its reward, and the
    /// house cut as exactly its rake.
    ///
    /// Ignored by default because it needs a database. Run it with
    /// `DATABASE_URL=... cargo test -p solatel-server -- --ignored proof`.
    /// It posts its own purchase and kill for players of its own.
    #[tokio::test]
    #[ignore = "needs a Postgres at DATABASE_URL"]
    async fn the_record_moves_by_exactly_what_a_kill_pays() {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let pool = crate::db::connect(&url).await.unwrap();
        crate::db::migrate(&pool).await.unwrap();

        let figure = |value: &Value, name: &str| value[name].as_i64().unwrap();
        let before = read(&pool).await.unwrap();
        let (reward, rake) = crate::ledger::post_test_kill(&pool).await.unwrap();
        let after = read(&pool).await.unwrap();

        // Other tests may be settling kills against the same database at the
        // same time, so these are lower bounds rather than equalities - but
        // a record that missed this kill, or counted it at the wrong amount
        // with nothing else running, fails.
        assert!(figure(&after, "kills_paid") > figure(&before, "kills_paid"));
        assert!(
            figure(&after, "kill_rewards_micro_usd")
                >= figure(&before, "kill_rewards_micro_usd") + reward
        );
        assert!(
            figure(&after, "house_cut_micro_usd") >= figure(&before, "house_cut_micro_usd") + rake
        );
        assert!(after["as_of"].is_string());
        assert!(after["recent_withdrawals"].is_array());
    }
}
