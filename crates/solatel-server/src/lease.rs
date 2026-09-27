//! The escrow lease: one running server owns the stakes in escrow.
//!
//! A match lives in the memory of the process running it, and its players'
//! entry fees sit in escrow until each of their lives ends. At startup a
//! server settles every stake it finds there as a walk-away - a process going
//! away is every one of its players disconnecting at once - which is right
//! only if those stakes are orphans. A second server pointed at the same
//! database would take the first one's live stakes for orphans and forfeit
//! them while they were still being played for.
//!
//! So a server takes this lease before it touches escrow, renews it while it
//! runs, and releases it when it shuts down. A server that finds it held
//! waits for it to expire - a crashed holder's does within [`LEASE`] - and
//! gives up, loudly, if it never does. A server that finds its own lease
//! gone, or cannot renew it for as long as it lasts, stops: it can no longer
//! be sure nobody else is settling its stakes, and a process that exits
//! leaves them for the next owner to settle, which is the safe side to err
//! on.
//!
//! Running several servers is a later job - an escrow account per server -
//! and this is what makes the mistake of starting two before then fail
//! instead of quietly costing players their stakes.

use anyhow::{Context, Result};
use sqlx::PgPool;
use std::time::Duration;
use uuid::Uuid;

/// How long a lease lasts without being renewed.
pub const LEASE: Duration = Duration::from_secs(30);

/// How often a held lease is renewed: three times per [`LEASE`], so one
/// slow round trip to a distant database does not lose it.
const RENEW_EVERY: Duration = Duration::from_secs(10);

/// How long a starting server waits for somebody else's lease to lapse
/// before it gives up. Long enough for a crashed holder's to expire; a live
/// holder renews and never lets it.
const PATIENCE: Duration = Duration::from_secs(90);

/// The lease the game server takes. Tests take leases under names of their
/// own, so they never touch this one.
pub const ESCROW: &str = "escrow";

/// A lease this process holds.
#[derive(Clone, Debug)]
pub struct Lease {
    pub name: String,
    pub holder: Uuid,
}

/// Take the lease if it is free, expired, or already ours. Returns who holds
/// it now and when that runs out, if it is somebody else.
async fn try_take(
    pool: &PgPool,
    name: &str,
    holder: Uuid,
    host: &str,
) -> Result<Option<(Uuid, String, f64)>> {
    let taken: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO escrow_lease (name, holder, host, expires_at)
              VALUES ($1, $2, $3, now() + make_interval(secs => $4))
         ON CONFLICT (name) DO UPDATE
                 SET holder = EXCLUDED.holder,
                     host = EXCLUDED.host,
                     acquired_at = now(),
                     expires_at = EXCLUDED.expires_at
               WHERE escrow_lease.expires_at < now()
                  OR escrow_lease.holder = EXCLUDED.holder
           RETURNING holder",
    )
    .bind(name)
    .bind(holder)
    .bind(host)
    .bind(LEASE.as_secs_f64())
    .fetch_optional(pool)
    .await
    .context("taking the escrow lease")?;
    if taken == Some(holder) {
        return Ok(None);
    }
    let other: (Uuid, String, f64) = sqlx::query_as(
        "SELECT holder, host, greatest(0, extract(epoch FROM expires_at - now()))::float8
           FROM escrow_lease WHERE name = $1",
    )
    .bind(name)
    .fetch_one(pool)
    .await
    .context("reading who holds the escrow lease")?;
    Ok(Some(other))
}

/// Take the lease `name`, waiting up to [`PATIENCE`] for somebody else's to
/// lapse.
pub async fn acquire(pool: &PgPool, name: &str) -> Result<Lease> {
    let holder = Uuid::new_v4();
    // Which machine and process, so a refusal says where the other one is.
    let machine = std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "unknown".into());
    let host = format!("{machine} pid {}", std::process::id());
    acquire_as(pool, name, holder, &host, PATIENCE).await
}

async fn acquire_as(
    pool: &PgPool,
    name: &str,
    holder: Uuid,
    host: &str,
    patience: Duration,
) -> Result<Lease> {
    let started = tokio::time::Instant::now();
    loop {
        match try_take(pool, name, holder, host).await? {
            None => {
                tracing::info!(lease = name, %holder, "holding the escrow lease");
                return Ok(Lease {
                    name: name.to_string(),
                    holder,
                });
            }
            Some((other, other_host, seconds_left)) => {
                if started.elapsed() >= patience {
                    anyhow::bail!(
                        "another server ({other} on {other_host}) holds the escrow lease and is \
                         keeping it; running two servers against one database would forfeit \
                         each other's live stakes, so this one will not start"
                    );
                }
                tracing::warn!(
                    lease = name,
                    %other,
                    host = %other_host,
                    seconds_left,
                    "the escrow lease is held; waiting for it to lapse"
                );
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

/// Renew the lease. `Ok(false)` means it is no longer ours.
pub async fn renew(pool: &PgPool, lease: &Lease) -> Result<bool> {
    let renewed: Option<i32> = sqlx::query_scalar(
        "UPDATE escrow_lease
            SET expires_at = now() + make_interval(secs => $3)
          WHERE name = $1 AND holder = $2
      RETURNING 1",
    )
    .bind(&lease.name)
    .bind(lease.holder)
    .bind(LEASE.as_secs_f64())
    .fetch_optional(pool)
    .await
    .context("renewing the escrow lease")?;
    Ok(renewed.is_some())
}

/// Give the lease up, so the next server does not have to wait it out.
pub async fn release(pool: &PgPool, lease: &Lease) -> Result<()> {
    sqlx::query("DELETE FROM escrow_lease WHERE name = $1 AND holder = $2")
        .bind(&lease.name)
        .bind(lease.holder)
        .execute(pool)
        .await
        .context("releasing the escrow lease")?;
    tracing::info!(lease = %lease.name, "released the escrow lease");
    Ok(())
}

/// Keep the lease renewed for as long as the process runs. If it is taken,
/// or cannot be renewed for as long as it lasts, the process exits: it can
/// no longer know that nobody else is settling its stakes.
pub fn keep(pool: PgPool, lease: Lease) {
    tokio::spawn(async move {
        let mut last_renewed = tokio::time::Instant::now();
        loop {
            tokio::time::sleep(RENEW_EVERY).await;
            match renew(&pool, &lease).await {
                Ok(true) => last_renewed = tokio::time::Instant::now(),
                Ok(false) => {
                    tracing::error!(
                        lease = %lease.name,
                        "the escrow lease was taken by another server; stopping so the two do not settle each other's stakes"
                    );
                    std::process::exit(3);
                }
                Err(err) => {
                    // A lease not renewed in time may already be somebody
                    // else's. Stop just before it would lapse.
                    let lapsing = last_renewed.elapsed() + RENEW_EVERY >= LEASE;
                    tracing::warn!(?err, lapsing, "could not renew the escrow lease");
                    if lapsing {
                        tracing::error!(
                            "the escrow lease is about to lapse unrenewed; stopping rather than risk two owners"
                        );
                        std::process::exit(3);
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A second holder cannot take a live lease, can once it has lapsed, and
    /// the first holder then finds it gone.
    ///
    /// Ignored by default because it needs a database. Run it with
    /// `DATABASE_URL=... cargo test -p solatel-server -- --ignored lease`.
    /// It takes a lease under a name of its own and gives it back.
    #[tokio::test]
    #[ignore = "needs a Postgres at DATABASE_URL"]
    async fn a_lease_has_one_holder_until_it_lapses() {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let pool = crate::db::connect(&url).await.unwrap();
        crate::db::migrate(&pool).await.unwrap();
        let name = format!("test:{}", Uuid::new_v4());

        let first = acquire_as(&pool, &name, Uuid::new_v4(), "first", Duration::ZERO)
            .await
            .unwrap();
        assert!(renew(&pool, &first).await.unwrap());

        // Held and live: a second server is refused.
        let refused = acquire_as(&pool, &name, Uuid::new_v4(), "second", Duration::ZERO).await;
        assert!(refused.is_err(), "a live lease was taken from its holder");

        // Taking it again as its own holder is a renewal, not a conflict.
        acquire_as(&pool, &name, first.holder, "first", Duration::ZERO)
            .await
            .unwrap();

        // Lapsed: the second server takes it, and the first finds it gone.
        sqlx::query(
            "UPDATE escrow_lease SET expires_at = now() - interval '1 second' WHERE name = $1",
        )
        .bind(&name)
        .execute(&pool)
        .await
        .unwrap();
        let second = acquire_as(&pool, &name, Uuid::new_v4(), "second", Duration::ZERO)
            .await
            .unwrap();
        assert!(
            !renew(&pool, &first).await.unwrap(),
            "a lapsed holder kept its lease"
        );
        assert!(renew(&pool, &second).await.unwrap());

        // Released: gone, and a release by a former holder does nothing.
        release(&pool, &first).await.unwrap();
        assert!(
            renew(&pool, &second).await.unwrap(),
            "a former holder released the new one's lease"
        );
        release(&pool, &second).await.unwrap();
        let left: i64 = sqlx::query_scalar("SELECT count(*) FROM escrow_lease WHERE name = $1")
            .bind(&name)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left, 0);
    }
}
