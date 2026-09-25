//! What a match costs, and where the money goes.
//!
//! # One stake, three ways out
//!
//! An entry fee buys one life in one match. There is no respawn: when that
//! life is over the player is out of that match, and the stake they put up
//! leaves escrow by exactly one of three routes.
//!
//! | what happened | to the player | to us |
//! |---|---|---|
//! | somebody killed them | — (the *killer* gets [`Stakes::reward`]) | [`Stakes::rake`] |
//! | still alive at the whistle | the whole stake back | nothing |
//! | walked away mid-match | [`Stakes::reward`] | [`Stakes::rake`] |
//!
//! Every stake leaves escrow once and for its full value, so the books cannot
//! drift: [`Stakes::splits_exactly`] is the arithmetic, and it is checked when
//! a tier is built rather than trusted.
//!
//! # The entry fee is not the winnings
//!
//! These are two different pots of money and conflating them is the mistake
//! this module exists to prevent.
//!
//! **Winnings** are [`Stakes::reward`] per kill and nothing else - ten kills
//! is ten rewards - and they are posted to the player's wallet as each kill
//! happens. A kill moves the *victim's entry fee* and only that. It does not
//! reach into what the victim had already earned, so being killed never costs
//! a player a penny of their winnings. Nobody gets somebody else's winnings
//! for killing them.
//!
//! **The stake** is the dollar they put up to be there, and it is the only
//! thing at risk.
//!
//! # Why the fee is not a constant
//!
//! Solatel runs several stakes side by side - a dollar table and a ten dollar
//! table are the same game for different money - so the fee is a value
//! carried by the match, not a number compiled into the client. The client is
//! told it in the handshake and displays what it is told; a client that knew
//! the price for itself would be a client that could be wrong about what it
//! is about to be charged.

use crate::money::MicroUsd;

/// Our cut, as a percentage of the stake. The same at every tier.
pub const RAKE_PERCENT: i64 = 10;

/// The stakes players may sit down for, in whole dollars.
///
/// Whole dollars on purpose: the rake has to come out in exact micro-USD with
/// nothing left over, and [`Stakes::from_usd`] refuses anything that does not.
pub const TIERS: [i64; 4] = [1, 2, 5, 10];

/// What one match costs and what it pays, for one tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stakes {
    /// Paid to join a match. One life, no respawn.
    entry: MicroUsd,
    /// Paid to the player who ends somebody's life - and paid back to a
    /// player who walks away without anybody ending theirs.
    reward: MicroUsd,
    /// Ours, on every stake that somebody loses.
    rake: MicroUsd,
}

impl Stakes {
    /// The dollar table, and what a server runs if it is not told otherwise.
    pub const DEFAULT: Stakes = match Stakes::from_usd(1) {
        Some(stakes) => stakes,
        None => panic!("the dollar tier must be buildable"),
    };

    /// Rebuilds a tier from a stake already measured in micro-USD.
    ///
    /// This is how the ledger settles: rather than being told which table a
    /// stake came from, it reads what it actually took out of the player's
    /// balance and splits *that*. A settlement then cannot disagree with its
    /// own purchase, whatever the caller believes about the tier - and the
    /// books are the thing that must not be wrong.
    pub const fn from_micros(micros: i64) -> Option<Stakes> {
        if micros <= 0 {
            return None;
        }
        let scaled = micros * RAKE_PERCENT;
        if scaled % 100 != 0 {
            return None;
        }
        let rake = MicroUsd(scaled / 100);
        let stakes = Stakes {
            entry: MicroUsd(micros),
            reward: MicroUsd(micros - rake.micros()),
            rake,
        };
        if stakes.splits_exactly() {
            Some(stakes)
        } else {
            None
        }
    }

    /// Builds a tier from a whole-dollar stake.
    ///
    /// `None` when the rake would not come out exactly, which for a whole
    /// number of dollars at ten percent it always does - the check is here so
    /// that changing [`RAKE_PERCENT`] to something that does not divide
    /// cleanly fails loudly instead of losing fractions of a cent per match.
    pub const fn from_usd(dollars: i64) -> Option<Stakes> {
        if dollars <= 0 {
            return None;
        }
        Stakes::from_micros(MicroUsd::from_usd(dollars).micros())
    }

    /// Whether the stake divides into a reward and a rake with nothing over.
    ///
    /// This is the whole solvency argument. Every stake that leaves escrow
    /// leaves as a reward plus a rake, or as the entry fee returned whole; if
    /// the first two did not add to the third, the treasury would leak on
    /// every kill or silently overcharge on every match.
    pub const fn splits_exactly(&self) -> bool {
        self.reward.micros() + self.rake.micros() == self.entry.micros()
            && self.reward.micros() > 0
            && self.rake.micros() > 0
    }

    pub const fn entry(&self) -> MicroUsd {
        self.entry
    }

    pub const fn reward(&self) -> MicroUsd {
        self.reward
    }

    pub const fn rake(&self) -> MicroUsd {
        self.rake
    }

    /// The tier in whole dollars, for naming a table.
    pub const fn dollars(&self) -> i64 {
        self.entry.micros() / 1_000_000
    }
}

/// Every listed tier must be buildable. A tier that is not is a table nobody
/// can sit at, and finding that out at startup is too late.
const _: () = {
    let mut i = 0;
    while i < TIERS.len() {
        assert!(
            Stakes::from_usd(TIERS[i]).is_some(),
            "a listed tier does not divide into a reward and a rake"
        );
        i += 1;
    }
};

/// Minimum balance a player must have before a withdrawal can be requested.
pub const MIN_WITHDRAWAL: MicroUsd = MicroUsd::from_usd(5);

const _: () = assert!(
    MIN_WITHDRAWAL.micros() > 0,
    "minimum withdrawal must be positive"
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tier_splits_exactly() {
        for dollars in TIERS {
            let stakes = Stakes::from_usd(dollars).expect("a listed tier must build");
            assert!(stakes.splits_exactly(), "${dollars} does not split exactly");
            assert_eq!(
                stakes.reward() + stakes.rake(),
                stakes.entry(),
                "${dollars}: a stake must leave escrow for exactly what came in"
            );
        }
    }

    #[test]
    fn the_rake_is_a_tenth_at_every_tier() {
        let expected = [
            ("$0.90", "$0.10"),
            ("$1.80", "$0.20"),
            ("$4.50", "$0.50"),
            ("$9.00", "$1.00"),
        ];
        for (dollars, (reward, rake)) in TIERS.into_iter().zip(expected) {
            let stakes = Stakes::from_usd(dollars).unwrap();
            assert_eq!(stakes.reward().to_string(), reward, "${dollars} reward");
            assert_eq!(stakes.rake().to_string(), rake, "${dollars} rake");
        }
    }

    #[test]
    fn a_death_is_revenue_neutral_at_every_tier() {
        // One life: the player pays in, the killer is paid, we keep the rest.
        // The treasury must end exactly where it started.
        for dollars in TIERS {
            let stakes = Stakes::from_usd(dollars).unwrap();
            assert_eq!(stakes.entry(), stakes.reward() + stakes.rake());
        }
    }

    #[test]
    fn walking_away_costs_the_rake_and_no_more() {
        // A player who disconnects and is not killed inside the resume window
        // gets the reward back and we keep the rake - the same split as a
        // kill, with the player themself in the killer's place.
        let stakes = Stakes::DEFAULT;
        assert_eq!(stakes.reward().to_string(), "$0.90");
        assert_eq!(stakes.rake().to_string(), "$0.10");
        assert_eq!(stakes.reward() + stakes.rake(), stakes.entry());
    }

    #[test]
    fn a_nonsense_tier_is_refused() {
        assert!(Stakes::from_usd(0).is_none());
        assert!(Stakes::from_usd(-1).is_none());
        assert!(Stakes::from_micros(0).is_none());
        assert!(Stakes::from_micros(-1).is_none());
    }

    #[test]
    fn a_tier_read_back_from_micros_is_the_tier_that_was_charged() {
        // How the ledger settles: it reads what it actually took and splits
        // that, rather than being told which table the stake came from.
        for dollars in TIERS {
            let charged = Stakes::from_usd(dollars).unwrap();
            let read_back = Stakes::from_micros(charged.entry().micros()).unwrap();
            assert_eq!(
                charged, read_back,
                "${dollars} did not survive the round trip"
            );
        }
    }

    #[test]
    fn the_default_is_the_dollar_table() {
        assert_eq!(Stakes::DEFAULT.entry().to_string(), "$1.00");
        assert_eq!(Stakes::DEFAULT.dollars(), 1);
        assert_eq!(MIN_WITHDRAWAL.to_string(), "$5.00");
    }
}
