//! Who somebody is, across tabs, reloads and restarts.
//!
//! # Why this exists
//!
//! A balance hangs off a [`PlayerId`]. Until there were deposits, a player id
//! was minted for every new connection and lasted as long as the tab plus the
//! resume window - which was harmless while every dollar in the game was a
//! development grant, and would have lost real money the first time somebody
//! deposited and then closed the tab.
//!
//! So a browser now holds an **account key**: 32 random bytes, base58, handed
//! out once in the `Welcome` of the connection that made the account and kept
//! in `localStorage`. Presenting it again is being that player again, with
//! their balance.
//!
//! # What kind of credential it is
//!
//! A bearer credential for somebody's money, and built as one:
//!
//! * **Server-issued, from the OS random source.** 256 bits; nobody searches
//!   that.
//! * **Stored hashed.** The table holds SHA-256 of the key, never the key. A
//!   copy of the database is not a copy of everybody's wallet. A plain hash
//!   rather than a slow one, because this is 256 random bits and not a
//!   password somebody chose: there is no dictionary to run against it.
//! * **Never sent twice.** The server cannot send it again - it does not have
//!   it - so the `Welcome` carries it only when it has just been made.
//!
//! It is also the weakest part of the wallet, deliberately and for now: lose
//! the key and the balance is gone with it. The real answer is signing in
//! with the Solana wallet the money came from, which is what
//! `players.solana_pubkey` has been waiting for since the first migration.
//! This is what makes deposits safe to test until then.
//!
//! # How it relates to the resume token
//!
//! They answer different questions. The account key says **who** - it lives in
//! `localStorage`, shared by every tab, and lasts until the browser forgets
//! it. The resume token says **which body** - it lives in `sessionStorage`,
//! one per tab, and is spent every time it is used. See `CLAUDE.md`.

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use solatel_protocol::ids::PlayerId;
use sqlx::PgPool;
use uuid::Uuid;

/// Who a connection turned out to be.
pub struct SignedIn {
    pub player_id: PlayerId,
    /// A key for a brand new account, to be handed over in the `Welcome`.
    /// `None` when the connection presented a key that was already good.
    pub new_key: Option<String>,
}

/// The stored form of a key.
fn hash(key: &str) -> Vec<u8> {
    Sha256::digest(key.trim().as_bytes()).to_vec()
}

/// A fresh key: 32 bytes from the operating system, in base58.
fn mint() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| anyhow::anyhow!("no randomness to make an account key from: {err}"))?;
    Ok(bs58::encode(bytes).into_string())
}

/// The player behind a key, or a new player if there is none.
///
/// A key that is missing, malformed or unknown is not an error: it is a new
/// account. That is what lets a client always send whatever it has - after a
/// database reset, every key in every browser is unknown, and the answer to
/// that must be "here is a new one" rather than a connection that cannot get
/// in.
pub async fn sign_in(pool: &PgPool, presented: Option<&str>) -> Result<SignedIn> {
    if let Some(key) = presented.filter(|k| !k.trim().is_empty()) {
        let known: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM players WHERE account_key_hash = $1")
                .bind(hash(key))
                .fetch_optional(pool)
                .await
                .context("looking up an account key")?;
        if let Some(id) = known {
            return Ok(SignedIn {
                player_id: PlayerId::from(id),
                new_key: None,
            });
        }
        tracing::info!("an account key nobody recognises; making a new account");
    }

    let key = mint()?;
    let player_id = PlayerId::new();
    sqlx::query("INSERT INTO players (id, account_key_hash) VALUES ($1, $2)")
        .bind(player_id.as_uuid())
        .bind(hash(&key))
        .execute(pool)
        .await
        .context("making an account")?;
    tracing::info!(%player_id, "account made");
    Ok(SignedIn {
        player_id,
        new_key: Some(key),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_thirty_two_bytes_of_base58() {
        let key = mint().unwrap();
        let raw = bs58::decode(&key).into_vec().unwrap();
        assert_eq!(raw.len(), 32);
        assert_ne!(key, mint().unwrap(), "two keys the same");
    }

    #[test]
    fn the_stored_form_is_not_the_key() {
        let key = mint().unwrap();
        let stored = hash(&key);
        assert_eq!(stored.len(), 32);
        assert_ne!(stored, key.as_bytes());
        // Pasted with a stray newline is still the same key.
        assert_eq!(hash(&format!("{key}\n")), stored);
    }
}
