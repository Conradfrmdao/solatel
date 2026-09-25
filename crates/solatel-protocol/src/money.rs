//! Money representation.
//!
//! Solatel pays real money, so the ledger never touches floating point. Every
//! amount in the system is an `i64` count of micro-USD (1/1_000_000 of a
//! dollar). At that scale an `i64` spans roughly ±9.2 trillion dollars, so
//! overflow is not a practical concern, but the arithmetic is still checked
//! because a silent wrap in a balance is the kind of bug that pays someone
//! else's money out.

use serde::{Deserialize, Serialize};
use std::fmt;

/// An amount of money, counted in micro-USD (1e-6 USD).
///
/// Signed, because ledger entries are signed: a debit is negative and a credit
/// is positive, and every transaction's entries must sum to zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MicroUsd(pub i64);

impl MicroUsd {
    pub const ZERO: Self = MicroUsd(0);

    /// Micro-USD in one dollar.
    pub const PER_USD: i64 = 1_000_000;

    pub const fn from_usd(usd: i64) -> Self {
        MicroUsd(usd * Self::PER_USD)
    }

    pub const fn from_cents(cents: i64) -> Self {
        MicroUsd(cents * (Self::PER_USD / 100))
    }

    pub const fn micros(self) -> i64 {
        self.0
    }

    pub const fn is_positive(self) -> bool {
        self.0 > 0
    }

    pub const fn is_negative(self) -> bool {
        self.0 < 0
    }

    pub const fn checked_add(self, rhs: Self) -> Option<Self> {
        match self.0.checked_add(rhs.0) {
            Some(v) => Some(MicroUsd(v)),
            None => None,
        }
    }

    pub const fn checked_sub(self, rhs: Self) -> Option<Self> {
        match self.0.checked_sub(rhs.0) {
            Some(v) => Some(MicroUsd(v)),
            None => None,
        }
    }

    /// Multiplied by a count - so many entry fees, so many kills.
    ///
    /// Takes a plain integer rather than another amount, because money times
    /// money is not money. Checked, like the rest of this type: an amount
    /// that silently wrapped would balance a ledger that is wrong.
    pub const fn checked_mul(self, count: i64) -> Option<Self> {
        match self.0.checked_mul(count) {
            Some(v) => Some(MicroUsd(v)),
            None => None,
        }
    }

    pub const fn negate(self) -> Self {
        MicroUsd(-self.0)
    }
}

impl std::ops::Add for MicroUsd {
    type Output = Self;
    /// Panics on overflow rather than wrapping. See [`MicroUsd::checked_add`].
    fn add(self, rhs: Self) -> Self {
        self.checked_add(rhs).expect("MicroUsd addition overflowed")
    }
}

impl std::ops::Sub for MicroUsd {
    type Output = Self;
    /// Panics on overflow rather than wrapping. See [`MicroUsd::checked_sub`].
    fn sub(self, rhs: Self) -> Self {
        self.checked_sub(rhs)
            .expect("MicroUsd subtraction overflowed")
    }
}

impl std::iter::Sum for MicroUsd {
    fn sum<I: Iterator<Item = Self>>(iter: I) -> Self {
        iter.fold(MicroUsd::ZERO, |a, b| a + b)
    }
}

impl fmt::Display for MicroUsd {
    /// Renders as a signed dollar amount with 2 decimal places, e.g. `$0.90`.
    /// Sub-cent precision is preserved in storage but not shown here; use
    /// [`MicroUsd::micros`] when the exact value matters.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sign = if self.0 < 0 { "-" } else { "" };
        let abs = self.0.unsigned_abs();
        let dollars = abs / Self::PER_USD as u64;
        let cents = (abs % Self::PER_USD as u64) / 10_000;
        write!(f, "{sign}${dollars}.{cents:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn displays_as_dollars() {
        assert_eq!(MicroUsd::from_usd(1).to_string(), "$1.00");
        assert_eq!(MicroUsd(900_000).to_string(), "$0.90");
        assert_eq!(MicroUsd(100_000).to_string(), "$0.10");
        assert_eq!(MicroUsd(-2_500_000).to_string(), "-$2.50");
        assert_eq!(MicroUsd::ZERO.to_string(), "$0.00");
    }

    #[test]
    fn from_cents_matches_from_usd() {
        assert_eq!(MicroUsd::from_cents(100), MicroUsd::from_usd(1));
    }

    #[test]
    fn checked_arithmetic_catches_overflow() {
        assert_eq!(MicroUsd(i64::MAX).checked_add(MicroUsd(1)), None);
        assert_eq!(MicroUsd(i64::MIN).checked_sub(MicroUsd(1)), None);
    }
}
