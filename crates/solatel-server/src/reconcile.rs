//! Periodic ledger reconciliation.
//!
//! The two checks that matter - that the journal sums to zero, and that no
//! cached balance disagrees with the entries behind it - both aggregate every
//! entry ever written. That is fine on a schedule and unacceptable per request,
//! so the work happens here and `/health` reports the cached verdict.
//!
//! A ledger that stops reconciling means money is being created or destroyed
//! somewhere, which is the most serious class of bug this system can have. It
//! is surfaced as unhealthy rather than logged and forgotten.

use crate::db;
use sqlx::PgPool;
use std::{
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

const RECONCILE_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct LedgerHealth {
    pub reconciles: bool,
    /// `None` until the first check completes.
    pub checked_at: Option<Instant>,
    pub error: Option<String>,
}

impl LedgerHealth {
    fn unknown() -> Self {
        Self {
            reconciles: false,
            checked_at: None,
            error: Some("no reconciliation has run yet".to_string()),
        }
    }

    pub fn checked_seconds_ago(&self) -> Option<f64> {
        self.checked_at.map(|at| at.elapsed().as_secs_f64())
    }
}

/// Shared handle to the most recent reconciliation result.
#[derive(Clone)]
pub struct LedgerHealthHandle(Arc<RwLock<LedgerHealth>>);

impl LedgerHealthHandle {
    pub fn get(&self) -> LedgerHealth {
        // Only poisoned if a writer panicked mid-update. The value is a plain
        // snapshot, so reading it anyway is safe and better than taking the
        // server down over a stale health figure.
        match self.0.read() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    fn set(&self, health: LedgerHealth) {
        match self.0.write() {
            Ok(mut guard) => *guard = health,
            Err(poisoned) => *poisoned.into_inner() = health,
        }
    }
}

/// Starts the reconciliation loop and returns a handle to its latest result.
pub fn spawn(pool: PgPool) -> LedgerHealthHandle {
    let handle = LedgerHealthHandle(Arc::new(RwLock::new(LedgerHealth::unknown())));

    tokio::spawn({
        let handle = handle.clone();
        async move {
            let mut interval = tokio::time::interval(RECONCILE_INTERVAL);
            loop {
                interval.tick().await;

                let health = match db::ledger_is_consistent(&pool).await {
                    Ok(true) => LedgerHealth {
                        reconciles: true,
                        checked_at: Some(Instant::now()),
                        error: None,
                    },
                    Ok(false) => {
                        tracing::error!(
                            "LEDGER DOES NOT RECONCILE - entries do not sum to zero, or a \
                             cached balance disagrees with its entries. Stop processing \
                             withdrawals and investigate."
                        );
                        LedgerHealth {
                            reconciles: false,
                            checked_at: Some(Instant::now()),
                            error: Some("ledger does not reconcile".to_string()),
                        }
                    }
                    Err(err) => {
                        tracing::warn!(%err, "reconciliation check could not run");
                        LedgerHealth {
                            reconciles: false,
                            checked_at: Some(Instant::now()),
                            error: Some(err.to_string()),
                        }
                    }
                };

                handle.set(health);
            }
        }
    });

    handle
}
