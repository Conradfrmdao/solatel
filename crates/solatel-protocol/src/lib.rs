//! Types shared by the Solatel client and server.
//!
//! This crate exists to make client/server drift impossible. The server is
//! authoritative over movement, hits, and money, which means it has to
//! re-evaluate the same rules the client predicted with. Anywhere those two
//! implementations could disagree is a place where a player is told they hit a
//! shot that the server scored as a miss — or worse, where money moves
//! incorrectly. Keeping the wire format, the economy constants, and (from
//! Phase 2) the movement simulation in one crate means there is only ever one
//! definition to disagree with.
//!
//! Nothing in here may depend on Bevy or on the server's database layer.

pub mod economy;
pub mod ids;
pub mod money;
pub mod net;
pub mod sim;

/// The vector library this crate's public types are built from.
///
/// Re-exported rather than left for each consumer to depend on separately.
/// `PlayerState::position` is a `glam::Vec3`, so anything that touches a
/// player's position already speaks glam - and two crates depending on two
/// different glam majors would compile and then disagree about what a `Vec3`
/// is, which is the exact class of drift this crate exists to make
/// impossible.
pub use glam;

pub use economy::{MIN_WITHDRAWAL, RAKE_PERCENT, Stakes, TIERS};
pub use ids::{MatchId, PlayerId, SessionId};
pub use money::MicroUsd;
pub use net::{ClientMsg, PROTOCOL_VERSION, ServerMsg, TICK_DT, TICK_HZ};
pub use sim::{Buttons, InputCommand, PlayerState, map::TEST_MAP};
