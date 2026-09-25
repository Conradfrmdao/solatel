//! Database pool setup and migrations.

use anyhow::{Context, Result};
use sqlx::postgres::{PgPool, PgPoolOptions};
use std::time::Duration;

/// Postgres and the server usually start together under compose, so the first
/// few connection attempts are expected to fail while Postgres initialises.
const CONNECT_ATTEMPTS: u32 = 30;
const CONNECT_RETRY_DELAY: Duration = Duration::from_secs(1);

pub async fn connect(database_url: &str) -> Result<PgPool> {
    let mut last_err = None;

    for attempt in 1..=CONNECT_ATTEMPTS {
        match PgPoolOptions::new()
            .max_connections(16)
            .acquire_timeout(Duration::from_secs(5))
            .connect(database_url)
            .await
        {
            Ok(pool) => {
                tracing::info!(attempt, "connected to postgres");
                return Ok(pool);
            }
            Err(err) => {
                tracing::debug!(attempt, %err, "postgres not ready yet");
                last_err = Some(err);
                tokio::time::sleep(CONNECT_RETRY_DELAY).await;
            }
        }
    }

    Err(last_err.expect("loop runs at least once"))
        .context("could not reach postgres after repeated attempts")
}

pub async fn migrate(pool: &PgPool) -> Result<()> {
    sqlx::migrate!("../../migrations")
        .run(pool)
        .await
        .context("running database migrations")?;
    tracing::info!("migrations up to date");
    Ok(())
}

/// Cheap liveness probe used by `/health`.
pub async fn ping(pool: &PgPool) -> Result<()> {
    sqlx::query("SELECT 1").execute(pool).await?;
    Ok(())
}

/// Reconciliation check: the whole ledger must sum to zero, and no cached
/// balance may disagree with the entries behind it. Exposed on `/health` so a
/// drift shows up without anyone having to go looking for it.
pub async fn ledger_is_consistent(pool: &PgPool) -> Result<bool> {
    let total: i64 = sqlx::query_scalar("SELECT total_micro_usd FROM ledger_total")
        .fetch_one(pool)
        .await?;
    let drifted: i64 = sqlx::query_scalar("SELECT count(*) FROM ledger_balance_drift")
        .fetch_one(pool)
        .await?;
    Ok(total == 0 && drifted == 0)
}
