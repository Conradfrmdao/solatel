//! Newtyped identifiers.
//!
//! These are distinct types rather than bare `Uuid`s so that a match id can
//! never be passed where a player id is expected. In a system that moves money
//! between accounts keyed by id, that mix-up is worth making impossible.

use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

macro_rules! id_type {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }

            pub const fn as_uuid(self) -> Uuid {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl From<Uuid> for $name {
            fn from(id: Uuid) -> Self {
                Self(id)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt::Display::fmt(&self.0, f)
            }
        }
    };
}

id_type!(
    /// A persistent account. Survives across sessions and matches.
    PlayerId
);
id_type!(
    /// One websocket connection. A player may hold several over time; the
    /// session is what the transport layer addresses.
    SessionId
);
id_type!(
    /// One continuous-cycle match instance.
    MatchId
);

id_type!(
    /// Lets one disconnected player take their body back.
    ///
    /// This is a bearer credential: whoever presents it becomes that player,
    /// with their position, their health and their record - and with the
    /// life they have paid for. It is therefore a credential for somebody's
    /// money, and it is built accordingly.
    ///
    /// * **Server-issued.** A client never chooses one. The only way to hold
    ///   a valid token is to have been handed it in a `Welcome`.
    /// * **Unguessable.** A v4 UUID is 122 bits from the operating system's
    ///   random source. Against a window measured in seconds, that is not a
    ///   thing anybody searches.
    /// * **Single-use.** Resuming consumes the token and issues a fresh one,
    ///   so a token that leaks - in a log, in a screenshot - is spent the
    ///   moment its owner reconnects.
    ///
    /// It is deliberately *not* the [`SessionId`]. A session is one
    /// websocket and is logged freely; this is a secret, and giving the two
    /// different types is what stops one being printed where the other was.
    ResumeToken
);
id_type!(
    /// One request to take money out.
    ///
    /// Minted by the server when the request is accepted, and the key every
    /// ledger entry for it hangs off - the money leaving the player, the
    /// money leaving us once the chain has it, or the money going back if
    /// the chain never does. A withdrawal is three events in the books and
    /// this is what makes them one withdrawal.
    WithdrawalId
);
