//! The authoritative simulation clock.
//!
//! Phase 1 runs the loop empty. It is here now because the whole design rests
//! on the server owning the clock, and because a loop that cannot hold 64 Hz on
//! the target hardware is something worth discovering before gameplay depends
//! on it, not after. Lateness is logged rather than silently absorbed.

use crate::AppState;
use solatel_protocol::TICK_HZ;
use std::time::{Duration, Instant};
use tokio::time::MissedTickBehavior;

const HEALTH_LOG_INTERVAL: Duration = Duration::from_secs(30);

pub fn spawn(state: AppState) {
    tokio::spawn(run(state));
}

async fn run(state: AppState) {
    let period = Duration::from_secs_f64(1.0 / f64::from(TICK_HZ));
    let mut interval = tokio::time::interval(period);
    // If the loop falls behind, carry on from now rather than firing a burst of
    // catch-up ticks. A burst would replay simulation steps back to back, which
    // for an authoritative server means fast-forwarding the game.
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut last = Instant::now();
    let mut window_start = Instant::now();
    let mut ticks_in_window: u64 = 0;
    let mut worst_lateness = Duration::ZERO;

    loop {
        interval.tick().await;

        let now = Instant::now();
        worst_lateness = worst_lateness.max(now.duration_since(last).saturating_sub(period));
        last = now;
        ticks_in_window += 1;

        // Phase 2: step the authoritative simulation here.

        if window_start.elapsed() >= HEALTH_LOG_INTERVAL {
            tracing::debug!(
                ticks = ticks_in_window,
                sessions = state.session_count(),
                worst_lateness_ms = worst_lateness.as_secs_f64() * 1000.0,
                "tick loop health"
            );
            window_start = Instant::now();
            ticks_in_window = 0;
            worst_lateness = Duration::ZERO;
        }
    }
}
