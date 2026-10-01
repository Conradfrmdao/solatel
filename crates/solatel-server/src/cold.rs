//! Cold storage: the treasury split into a hot wallet and a cold one.
//!
//! The treasury key signs every withdrawal, so it lives on the server, and a
//! key on a server is the first thing an attacker goes looking for. Whatever
//! that key controls is what a compromise costs. So the hot wallet is kept to
//! what withdrawals need - a cap, plus whatever is already promised - and
//! everything over it is swept to a cold address whose key is not here at
//! all: a multisig vault (Squads, on Solana) that takes several people to
//! move. Refilling the hot wallet from cold is those people's job, done by
//! hand, which is the point.
//!
//! Off unless both `SOLATEL_COLD_ADDRESS` and `SOLATEL_HOT_CAP_SOL` are set.
//! It moves SOL only; USDC stays where it lands until there is a rule for it.
//!
//! A sweep is bookkept like a withdrawal: signed, its signature written down,
//! then sent, and followed on later passes until the chain says it landed,
//! failed or expired. It is not a ledger transaction - the money is the
//! game's in both places, and the ledger's treasury account stands for both -
//! but it is a row in `treasury_sweeps`, so where the money went is on record
//! with the chain's own name for each move.

use crate::solana::{self, Address};
use anyhow::{Context, Result, bail};
use std::time::Duration;

/// At most one sweep this often. The hot wallet going over its cap is not
/// urgent, and a server that swept on every pass would spend its fees
/// chasing deposits as they arrived.
pub const SWEEP_EVERY: Duration = Duration::from_secs(3600);

/// The least worth a sweep: a tenth of the cap, and never under a tenth of
/// a SOL, so a wallet sitting a little over its cap is left alone.
pub const MIN_SWEEP_LAMPORTS: u64 = solana::LAMPORTS_PER_SOL / 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColdStorage {
    /// Where the excess goes. Not required to be on the ed25519 curve: a
    /// multisig vault is a program-derived address, which is off it.
    pub address: Address,
    /// What the hot wallet keeps, over and above what is already promised.
    pub hot_cap_lamports: u64,
}

impl ColdStorage {
    /// From `SOLATEL_COLD_ADDRESS` and `SOLATEL_HOT_CAP_SOL`: both or
    /// neither, and never the treasury itself.
    pub fn from_env(treasury: Address) -> Result<Option<Self>> {
        let address = std::env::var("SOLATEL_COLD_ADDRESS")
            .ok()
            .filter(|v| !v.trim().is_empty());
        let cap = std::env::var("SOLATEL_HOT_CAP_SOL")
            .ok()
            .filter(|v| !v.trim().is_empty());
        Self::parse(address.as_deref(), cap.as_deref(), treasury)
    }

    pub fn parse(
        address: Option<&str>,
        cap: Option<&str>,
        treasury: Address,
    ) -> Result<Option<Self>> {
        let (address, cap) = match (address, cap) {
            (None, None) => return Ok(None),
            (Some(_), None) => bail!(
                "SOLATEL_COLD_ADDRESS is set but SOLATEL_HOT_CAP_SOL is not: how much should the hot wallet keep?"
            ),
            (None, Some(_)) => {
                bail!(
                    "SOLATEL_HOT_CAP_SOL is set but SOLATEL_COLD_ADDRESS is not: where should the rest go?"
                )
            }
            (Some(a), Some(c)) => (a, c),
        };
        let address = Address::parse(address.trim()).context("SOLATEL_COLD_ADDRESS")?;
        if address == treasury {
            bail!(
                "SOLATEL_COLD_ADDRESS is the treasury itself; cold storage has to be somewhere else"
            );
        }
        let lamports = crate::wallet::parse_decimal(cap.trim(), 9)
            .filter(|l| *l > 0)
            .and_then(|l| u64::try_from(l).ok())
            .context("SOLATEL_HOT_CAP_SOL should be a positive amount of SOL, e.g. 25")?;
        Ok(Some(Self {
            address,
            hot_cap_lamports: lamports,
        }))
    }

    /// How much to sweep now, if anything.
    ///
    /// The hot wallet keeps its cap, plus every withdrawal asked for and not
    /// yet landed, plus what it needs to stay open and pay the sweep's own
    /// fee. Anything over that, if it is worth moving and no sweep has gone
    /// in the last [`SWEEP_EVERY`] and none is still in flight, goes.
    pub fn sweep(
        &self,
        hot_lamports: u64,
        promised_lamports: u64,
        since_last: Option<Duration>,
        in_flight: bool,
    ) -> Option<u64> {
        if in_flight || since_last.is_some_and(|ago| ago < SWEEP_EVERY) {
            return None;
        }
        let keep = self
            .hot_cap_lamports
            .saturating_add(promised_lamports)
            .saturating_add(solana::RENT_EXEMPT_MINIMUM)
            .saturating_add(solana::SIGNATURE_FEE);
        let excess = hot_lamports.checked_sub(keep)?;
        let worth = MIN_SWEEP_LAMPORTS.max(self.hot_cap_lamports / 10);
        (excess >= worth).then_some(excess)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = solana::LAMPORTS_PER_SOL;

    fn treasury() -> Address {
        Address([7; 32])
    }

    fn cold(cap_sol: u64) -> ColdStorage {
        ColdStorage {
            address: Address([9; 32]),
            hot_cap_lamports: cap_sol * SOL,
        }
    }

    #[test]
    fn it_is_off_unless_both_halves_are_set() {
        assert_eq!(ColdStorage::parse(None, None, treasury()).unwrap(), None);
        assert!(
            ColdStorage::parse(Some("11111111111111111111111111111112"), None, treasury()).is_err()
        );
        assert!(ColdStorage::parse(None, Some("25"), treasury()).is_err());
        let on = ColdStorage::parse(
            Some("11111111111111111111111111111112"),
            Some("25"),
            treasury(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(on.hot_cap_lamports, 25 * SOL);
    }

    #[test]
    fn cold_storage_is_never_the_treasury_and_never_nothing() {
        let t = treasury();
        assert!(ColdStorage::parse(Some(&t.to_string()), Some("25"), t).is_err());
        assert!(ColdStorage::parse(Some("not an address"), Some("25"), t).is_err());
        assert!(
            ColdStorage::parse(Some("11111111111111111111111111111112"), Some("0"), t).is_err()
        );
        assert!(
            ColdStorage::parse(Some("11111111111111111111111111111112"), Some("-3"), t).is_err()
        );
    }

    #[test]
    fn only_what_is_over_the_cap_and_the_promises_goes() {
        let c = cold(25);
        // Under the cap: nothing.
        assert_eq!(c.sweep(20 * SOL, 0, None, false), None);
        // Forty in hot, five promised to withdrawals: keep thirty and the
        // change to stay open, sweep the rest.
        let swept = c.sweep(40 * SOL, 5 * SOL, None, false).unwrap();
        let kept = 40 * SOL - swept;
        assert_eq!(
            kept,
            30 * SOL + solana::RENT_EXEMPT_MINIMUM + solana::SIGNATURE_FEE
        );
    }

    #[test]
    fn a_little_over_is_left_alone() {
        let c = cold(25);
        // Half a SOL over a 25 SOL cap is under a tenth of the cap.
        assert_eq!(c.sweep(25 * SOL + SOL / 2, 0, None, false), None);
    }

    #[test]
    fn one_at_a_time_and_not_too_often() {
        let c = cold(25);
        assert_eq!(
            c.sweep(100 * SOL, 0, None, true),
            None,
            "one already in flight"
        );
        assert_eq!(
            c.sweep(100 * SOL, 0, Some(Duration::from_secs(600)), false),
            None
        );
        assert!(c.sweep(100 * SOL, 0, Some(SWEEP_EVERY), false).is_some());
    }

    /// Against a real Postgres: the database itself holds sweeps to one in
    /// flight, so a second server or a bug cannot send two at once.
    #[tokio::test]
    #[ignore = "needs a Postgres at DATABASE_URL"]
    async fn the_database_allows_one_sweep_in_flight() {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let pool = crate::db::connect(&url).await.unwrap();
        crate::db::migrate(&pool).await.unwrap();
        // Clear the way: earlier runs of this test leave theirs behind.
        sqlx::query("UPDATE treasury_sweeps SET status = 'expired' WHERE status = 'sent'")
            .execute(&pool)
            .await
            .unwrap();
        let insert = |signature: String| {
            let pool = pool.clone();
            async move {
                sqlx::query(
                    "INSERT INTO treasury_sweeps
                         (lamports, destination, signature, signed_transaction, last_valid_block_height)
                     VALUES (1000000, 'cold', $1, 'wire', 1)",
                )
                .bind(signature)
                .execute(&pool)
                .await
            }
        };
        let tag = uuid::Uuid::new_v4().to_string();
        insert(format!("first-{tag}")).await.unwrap();
        assert!(
            insert(format!("second-{tag}")).await.is_err(),
            "a second sweep in flight is refused"
        );
        sqlx::query("UPDATE treasury_sweeps SET status = 'landed' WHERE signature = $1")
            .bind(format!("first-{tag}"))
            .execute(&pool)
            .await
            .unwrap();
        insert(format!("third-{tag}")).await.unwrap();
        sqlx::query("UPDATE treasury_sweeps SET status = 'expired' WHERE signature = $1")
            .bind(format!("third-{tag}"))
            .execute(&pool)
            .await
            .unwrap();
    }
}
