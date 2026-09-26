//! The operator's view: players, their money and their matches, and the
//! anti-cheat's review queue.
//!
//! Off unless `SOLATEL_ADMIN_TOKEN` is set, and then only to a request that
//! carries it as a bearer token. The token is compared by its SHA-256, so the
//! comparison takes the same time whatever it is compared against, and only
//! the digest is kept in memory past startup.
//!
//! Everything here reads, except one thing: deciding a review. That moves no
//! money - a cleared review reopens withdrawals, a confirmed one keeps them
//! shut - and it is written with who decided and why, which the database
//! insists on. Correcting money is a ledger `adjustment` with a reason, made
//! deliberately and by hand; there is no button for it here on purpose.
//!
//! Every answer is JSON built by Postgres (`json_agg`, `json_build_object`),
//! so each endpoint is one statement and the shape of the answer is the shape
//! of the query. Money goes out as integer micro-USD, as it is stored; the page
//! formats it and computes nothing.

use crate::AppState;
use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use uuid::Uuid;

/// Shorter than this and the token is refused at startup: it is the only
/// thing between the internet and every player's record.
const MIN_TOKEN_LEN: usize = 24;

/// The admin token, as a digest. `None` means the admin view is off.
#[derive(Clone)]
pub struct AdminKey([u8; 32]);

impl AdminKey {
    /// From `SOLATEL_ADMIN_TOKEN`, if it is set and long enough.
    pub fn from_env() -> Option<Self> {
        let token = std::env::var("SOLATEL_ADMIN_TOKEN").ok()?;
        let token = token.trim();
        if token.len() < MIN_TOKEN_LEN {
            tracing::warn!(
                "SOLATEL_ADMIN_TOKEN is shorter than {MIN_TOKEN_LEN} characters; the admin view stays off"
            );
            return None;
        }
        Some(Self(Sha256::digest(token.as_bytes()).into()))
    }

    fn admits(&self, offered: &str) -> bool {
        let offered: [u8; 32] = Sha256::digest(offered.as_bytes()).into();
        offered
            .iter()
            .zip(self.0.iter())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
    }
}

/// The routes, all under `/admin`. The page itself is only a shell with no
/// data in it, but it is not served either while the view is off: a server
/// with no admin should not advertise where one would be.
pub fn router(state: AppState) -> Router<AppState> {
    let api = Router::new()
        .route("/overview", get(overview))
        .route("/reviews", get(reviews))
        .route("/reviews/{id}", axum::routing::post(decide))
        .route("/players", get(players))
        .route("/players/{id}", get(player))
        .route("/matches", get(matches))
        .route("/matches/{id}", get(one_match))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token));
    Router::new()
        .route("/admin", get(page))
        .nest("/admin/api", api)
}

async fn require_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Response {
    let Some(key) = &state.admin else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let offered = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if !key.admits(offered) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(request).await
}

async fn page(State(state): State<AppState>) -> Response {
    if state.admin.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    Html(include_str!("admin.html")).into_response()
}

/// One statement's JSON answer, or a 500 with the error logged.
async fn json_of(state: &AppState, sql: &'static str, binds: &[Bind<'_>]) -> Response {
    let mut query = sqlx::query_scalar::<_, Option<String>>(sql);
    for bind in binds {
        query = match bind {
            Bind::Uuid(v) => query.bind(*v),
            Bind::Text(v) => query.bind(*v),
            Bind::Int(v) => query.bind(*v),
        };
    }
    match query.fetch_one(&state.pool).await {
        Ok(Some(text)) => match serde_json::from_str::<Value>(&text) {
            Ok(value) => Json(value).into_response(),
            Err(err) => {
                tracing::error!(%err, "admin query returned text that is not JSON");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(err) => {
            tracing::error!(%err, "admin query failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

enum Bind<'a> {
    Uuid(Uuid),
    Text(&'a str),
    Int(i64),
}

fn limit(params: &HashMap<String, String>, default: i64) -> i64 {
    params
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(default)
        .clamp(1, 500)
}

/// The whole operation at a glance.
async fn overview(State(state): State<AppState>) -> Response {
    json_of(
        &state,
        "SELECT json_build_object(
            'players', (SELECT count(*) FROM players),
            'lives_24h', (SELECT count(*) FROM match_lives
                           WHERE ended_at > now() - interval '24 hours'),
            'matches_24h', (SELECT count(DISTINCT match_id) FROM match_lives
                             WHERE ended_at > now() - interval '24 hours'),
            'reviews_open', (SELECT count(*) FROM reviews WHERE status = 'open'),
            'reviews_confirmed', (SELECT count(*) FROM reviews WHERE status = 'confirmed'),
            'withdrawals_in_flight', (SELECT count(*) FROM withdrawals
                                       WHERE status IN ('requested', 'sent')),
            'accounts', (SELECT json_object_agg(kind, total) FROM (
                SELECT a.kind::text AS kind,
                       coalesce(sum(b.balance_micro_usd), 0)::bigint AS total
                  FROM ledger_accounts a
                  LEFT JOIN ledger_account_balances b ON b.account_id = a.id
                 GROUP BY a.kind) k)
         )::text",
        &[],
    )
    .await
}

/// The review queue, oldest first, with each player's record as it stands
/// now beside the evidence from when they were flagged.
async fn reviews(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let status = match params.get("status").map(String::as_str) {
        None | Some("open") => "open",
        Some("cleared") => "cleared",
        Some("confirmed") => "confirmed",
        Some(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    json_of(
        &state,
        "SELECT coalesce(json_agg(r ORDER BY r.created_at), '[]')::text FROM (
            SELECT rv.id, rv.player_id, rv.match_id, rv.reasons, rv.evidence,
                   rv.status::text AS status, rv.decided_by, rv.note,
                   rv.created_at, rv.decided_at,
                   (SELECT b.balance_micro_usd
                      FROM ledger_accounts a
                      JOIN ledger_account_balances b ON b.account_id = a.id
                     WHERE a.kind = 'player_balance' AND a.player_id = rv.player_id)
                       AS balance_micro_usd,
                   (SELECT count(*) FROM match_lives l WHERE l.player_id = rv.player_id)
                       AS lives
              FROM reviews rv
             WHERE rv.status = $1::review_status
             ORDER BY rv.created_at
             LIMIT $2) r",
        &[Bind::Text(status), Bind::Int(limit(&params, 200))],
    )
    .await
}

/// Close an open review: `{"decision": "cleared" | "confirmed", "by": ...,
/// "note": ...}`. Who and why are required, here and by the database.
async fn decide(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<Value>,
) -> Response {
    let decision = body.get("decision").and_then(Value::as_str).unwrap_or("");
    let by = body.get("by").and_then(Value::as_str).unwrap_or("").trim();
    let note = body.get("note").and_then(Value::as_str).unwrap_or("").trim();
    if !matches!(decision, "cleared" | "confirmed") || by.is_empty() || note.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "a decision is cleared or confirmed, with who made it and why" })),
        )
            .into_response();
    }
    let decided = sqlx::query_scalar::<_, Uuid>(
        "UPDATE reviews
            SET status = $2::review_status, decided_by = $3, note = $4, decided_at = now()
          WHERE id = $1 AND status = 'open'
      RETURNING player_id",
    )
    .bind(id)
    .bind(decision)
    .bind(by)
    .bind(note)
    .fetch_optional(&state.pool)
    .await;
    match decided {
        Ok(Some(player)) => {
            tracing::warn!(review = %id, %player, decision, by, "review decided");
            Json(json!({ "id": id, "player_id": player, "status": decision })).into_response()
        }
        Ok(None) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "no open review with that id" })),
        )
            .into_response(),
        Err(err) => {
            tracing::error!(%err, "deciding a review failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// Players by the start of their id, newest first. The id is what a player
/// can read off their profile pane; names are cosmetic and not stored.
async fn players(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let prefix: String = params
        .get("q")
        .map(|q| {
            q.trim()
                .to_ascii_lowercase()
                .chars()
                .filter(|c| c.is_ascii_hexdigit() || *c == '-')
                .collect()
        })
        .unwrap_or_default();
    json_of(
        &state,
        "SELECT coalesce(json_agg(p ORDER BY p.created_at DESC), '[]')::text FROM (
            SELECT pl.id, pl.created_at, pl.solana_pubkey,
                   (SELECT b.balance_micro_usd
                      FROM ledger_accounts a
                      JOIN ledger_account_balances b ON b.account_id = a.id
                     WHERE a.kind = 'player_balance' AND a.player_id = pl.id)
                       AS balance_micro_usd,
                   (SELECT count(*) FROM match_lives l WHERE l.player_id = pl.id) AS lives,
                   (SELECT r.status::text FROM reviews r
                     WHERE r.player_id = pl.id AND r.status IN ('open', 'confirmed')
                     ORDER BY r.status = 'confirmed' DESC LIMIT 1) AS review
              FROM players pl
             WHERE pl.id::text LIKE $1 || '%'
             ORDER BY pl.created_at DESC
             LIMIT $2) p",
        &[Bind::Text(&prefix), Bind::Int(limit(&params, 50))],
    )
    .await
}

/// One player: their balance, their record, their lives, every ledger
/// movement on their balance, their withdrawals and deposits, and their
/// reviews.
async fn player(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    json_of(
        &state,
        "SELECT CASE WHEN pl.id IS NULL THEN NULL ELSE json_build_object(
            'id', pl.id,
            'created_at', pl.created_at,
            'solana_pubkey', pl.solana_pubkey,
            'balance_micro_usd', (SELECT b.balance_micro_usd
                                    FROM ledger_accounts a
                                    JOIN ledger_account_balances b ON b.account_id = a.id
                                   WHERE a.kind = 'player_balance' AND a.player_id = pl.id),
            'record', (SELECT json_build_object(
                           'lives', count(*),
                           'kills', coalesce(sum(kills), 0),
                           'shots_fired', coalesce(sum(shots_fired), 0),
                           'shots_hit', coalesce(sum(shots_hit), 0),
                           'headshots', coalesce(sum(headshots), 0),
                           'snap_hits', coalesce(sum(snap_hits), 0),
                           'winnings_micro_usd', coalesce(sum(winnings_micro_usd), 0))
                         FROM match_lives WHERE player_id = pl.id),
            'lives', (SELECT coalesce(json_agg(l ORDER BY l.ended_at DESC), '[]') FROM (
                        SELECT match_id, map, stake_micro_usd, outcome::text AS outcome,
                               killer_id, kills, shots_fired, shots_hit, headshots,
                               damage_dealt, snap_hits, winnings_micro_usd, alive_ms, ended_at
                          FROM match_lives WHERE player_id = pl.id
                         ORDER BY ended_at DESC LIMIT 100) l),
            'ledger', (SELECT coalesce(json_agg(e ORDER BY e.id DESC), '[]') FROM (
                        SELECT en.id, t.kind::text AS kind, t.idempotency_key AS key,
                               t.reason, en.amount_micro_usd, en.created_at
                          FROM ledger_entries en
                          JOIN ledger_transactions t ON t.id = en.transaction_id
                          JOIN ledger_accounts a ON a.id = en.account_id
                         WHERE a.kind = 'player_balance' AND a.player_id = pl.id
                         ORDER BY en.id DESC LIMIT 200) e),
            'withdrawals', (SELECT coalesce(json_agg(w ORDER BY w.created_at DESC), '[]') FROM (
                        SELECT id, destination, amount_micro_usd, lamports,
                               status::text AS status, signature, reason, created_at, updated_at
                          FROM withdrawals WHERE player_id = pl.id
                         ORDER BY created_at DESC LIMIT 50) w),
            'deposits', (SELECT coalesce(json_agg(d ORDER BY d.seen_at DESC), '[]') FROM (
                        SELECT signature, lamports, micro_usd, outcome, block_time, seen_at
                          FROM treasury_receipts WHERE player_id = pl.id
                         ORDER BY seen_at DESC LIMIT 50) d),
            'reviews', (SELECT coalesce(json_agg(r ORDER BY r.created_at DESC), '[]') FROM (
                        SELECT id, match_id, reasons, evidence, status::text AS status,
                               decided_by, note, created_at, decided_at
                          FROM reviews WHERE player_id = pl.id) r)
         )::text END
           FROM (SELECT $1::uuid AS wanted) w
           LEFT JOIN players pl ON pl.id = w.wanted",
        &[Bind::Uuid(id)],
    )
    .await
}

/// Recent matches, as their lives ended: when, where, at what stake, who
/// played and what was killed.
async fn matches(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    json_of(
        &state,
        "SELECT coalesce(json_agg(m ORDER BY m.ended_at DESC), '[]')::text FROM (
            SELECT match_id, min(map) AS map, min(stake_micro_usd) AS stake_micro_usd,
                   count(*) AS players,
                   sum(kills) AS kills,
                   count(*) FILTER (WHERE outcome = 'survived') AS survivors,
                   sum(winnings_micro_usd) AS winnings_micro_usd,
                   max(ended_at) AS ended_at
              FROM match_lives
             GROUP BY match_id
             ORDER BY max(ended_at) DESC
             LIMIT $1) m",
        &[Bind::Int(limit(&params, 50))],
    )
    .await
}

/// One match: every life in it, and every ledger transaction keyed on it.
async fn one_match(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    json_of(
        &state,
        "SELECT json_build_object(
            'match_id', $1::uuid,
            'lives', (SELECT coalesce(json_agg(l ORDER BY l.ended_at), '[]') FROM (
                        SELECT player_id, map, stake_micro_usd, outcome::text AS outcome,
                               killer_id, kills, shots_fired, shots_hit, headshots,
                               damage_dealt, snap_hits, winnings_micro_usd, alive_ms, ended_at
                          FROM match_lives WHERE match_id = $1) l),
            'ledger', (SELECT coalesce(json_agg(t ORDER BY t.created_at), '[]') FROM (
                        SELECT tx.kind::text AS kind, tx.idempotency_key AS key, tx.created_at,
                               (SELECT json_agg(json_build_object(
                                        'account', a.kind::text,
                                        'player_id', a.player_id,
                                        'amount_micro_usd', en.amount_micro_usd) ORDER BY en.id)
                                  FROM ledger_entries en
                                  JOIN ledger_accounts a ON a.id = en.account_id
                                 WHERE en.transaction_id = tx.id) AS legs
                          FROM ledger_transactions tx
                         WHERE tx.idempotency_key LIKE '%' || $1::text || '%') t)
         )::text",
        &[Bind::Uuid(id)],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_is_admitted_and_nothing_else_is() {
        let key = AdminKey(Sha256::digest(b"correct horse battery staple!!").into());
        assert!(key.admits("correct horse battery staple!!"));
        assert!(!key.admits("correct horse battery staple!"));
        assert!(!key.admits(""));
        assert!(!key.admits("Bearer correct horse battery staple!!"));
    }
}
