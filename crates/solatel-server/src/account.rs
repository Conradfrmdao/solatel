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
//! On its own it is the weakest part of the wallet: lose the key and the
//! balance is gone with it. So an account can also carry a **Solana wallet**
//! (`players.solana_pubkey`): the player signs a challenge with it, and from
//! then on signing in with that wallet from any browser is being this player,
//! with a key of its own for that browser (`account_keys`, migration 0008),
//! so the first browser's key keeps working. See [`wallet_sign_in`].
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
    /// The wallet this account is signed in with, if it has one.
    pub solana_pubkey: Option<String>,
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
        // The key the account was made with, or one a wallet sign-in made.
        let known: Option<(Uuid, Option<String>)> = sqlx::query_as(
            "SELECT id, solana_pubkey FROM players WHERE account_key_hash = $1
             UNION ALL
             SELECT p.id, p.solana_pubkey
               FROM account_keys k JOIN players p ON p.id = k.player_id
              WHERE k.key_hash = $1
             LIMIT 1",
        )
        .bind(hash(key))
        .fetch_optional(pool)
        .await
        .context("looking up an account key")?;
        if let Some((id, solana_pubkey)) = known {
            return Ok(SignedIn {
                player_id: PlayerId::from(id),
                new_key: None,
                solana_pubkey,
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
        solana_pubkey: None,
    })
}

// ---- signing in with a wallet ----------------------------------------------

/// How long a challenge may be signed for.
pub const CHALLENGE_LIFETIME: std::time::Duration = std::time::Duration::from_secs(300);

/// The text a wallet is asked to sign.
///
/// Worded for the person reading it in their wallet: which site is asking,
/// that it is not a transaction, and which account it is for. The nonce makes
/// each one good once, and `domain` is what the browser said it was talking
/// to, so a message signed for somebody else's page says so.
pub fn challenge(domain: &str, player_id: PlayerId) -> Result<String> {
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce)
        .map_err(|err| anyhow::anyhow!("no randomness for a sign-in challenge: {err}"))?;
    let domain: String = domain
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
        .take(100)
        .collect();
    let domain = if domain.is_empty() { "Solatel".to_string() } else { domain };
    Ok(format!(
        "{domain} asks you to sign in to Solatel with this wallet.\n\n\
         Signing proves the wallet is yours. It is not a transaction: it \
         moves nothing and costs nothing.\n\n\
         Account: {player_id}\n\
         Nonce: {nonce}\n\
         Issued: {issued}",
        nonce = bs58::encode(nonce).into_string(),
        issued = utc_now(),
    ))
}

/// Checks `signature` over `message` against `public_key`, both base58, and
/// returns the key in its canonical base58 - the form it is stored in.
pub fn verify(message: &str, public_key: &str, signature: &str) -> Result<String, &'static str> {
    let key: [u8; 32] = bs58::decode(public_key.trim())
        .into_vec()
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or("that is not a Solana public key")?;
    let signature: [u8; 64] = bs58::decode(signature.trim())
        .into_vec()
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or("that is not a signature")?;
    let verifying =
        ed25519_dalek::VerifyingKey::from_bytes(&key).map_err(|_| "that is not a Solana public key")?;
    verifying
        .verify_strict(message.as_bytes(), &ed25519_dalek::Signature::from_bytes(&signature))
        .map_err(|_| "the signature does not match the message; sign it exactly as it was sent")?;
    Ok(bs58::encode(key).into_string())
}

/// What signing in with a wallet came to.
#[derive(Debug)]
pub enum WalletOutcome {
    /// This account carries the wallet now, or already did.
    Linked,
    /// The wallet is another account's. This browser is to be that account,
    /// with this key.
    SignedInAs { player_id: PlayerId, key: String },
    /// Nothing changed, for this reason.
    Refused(String),
}

/// Sign `me` in with the wallet `public_key`, whose signature has been
/// checked.
///
/// A wallet nobody has is linked to this account, if it has none. A wallet
/// this account has is already linked. A wallet another account has signs
/// this browser in as that account, with a new key - unless this one holds
/// money and no wallet, because leaving it would leave the money with a key
/// the browser is about to forget.
pub async fn wallet_sign_in(pool: &PgPool, me: PlayerId, public_key: &str) -> Result<WalletOutcome> {
    let owner: Option<Uuid> = sqlx::query_scalar("SELECT id FROM players WHERE solana_pubkey = $1")
        .bind(public_key)
        .fetch_optional(pool)
        .await
        .context("looking up a wallet")?;
    match owner {
        Some(id) if id == me.as_uuid() => Ok(WalletOutcome::Linked),
        Some(id) => {
            let (mine, balance): (Option<String>, i64) = sqlx::query_as(
                "SELECT p.solana_pubkey, coalesce(b.balance_micro_usd, 0)::bigint
                   FROM players p
                   LEFT JOIN ledger_accounts a ON a.player_id = p.id AND a.kind = 'player_balance'
                   LEFT JOIN ledger_account_balances b ON b.account_id = a.id
                  WHERE p.id = $1",
            )
            .bind(me.as_uuid())
            .fetch_one(pool)
            .await
            .context("reading the account being left")?;
            if mine.is_none() && balance > 0 {
                return Ok(WalletOutcome::Refused(format!(
                    "that wallet is another account's, and this one holds ${}.{:02} with no wallet \
                     to get it back by. Play or withdraw it first, or sign this account in with \
                     a different wallet",
                    balance / 1_000_000,
                    (balance % 1_000_000) / 10_000,
                )));
            }
            let key = mint()?;
            sqlx::query(
                "INSERT INTO account_keys (key_hash, player_id, made_for)
                 VALUES ($1, $2, 'wallet_sign_in')",
            )
            .bind(hash(&key))
            .bind(id)
            .execute(pool)
            .await
            .context("making a key for a wallet sign-in")?;
            tracing::info!(player = %id, "signed in with a wallet from a new browser");
            Ok(WalletOutcome::SignedInAs {
                player_id: PlayerId::from(id),
                key,
            })
        }
        None => {
            let linked = sqlx::query(
                "UPDATE players SET solana_pubkey = $1 WHERE id = $2 AND solana_pubkey IS NULL",
            )
            .bind(public_key)
            .bind(me.as_uuid())
            .execute(pool)
            .await;
            match linked {
                Ok(done) if done.rows_affected() == 1 => {
                    tracing::info!(player = %me, "wallet linked");
                    Ok(WalletOutcome::Linked)
                }
                Ok(_) => Ok(WalletOutcome::Refused(
                    "this account is already signed in with a different wallet; it has one".into(),
                )),
                // Two browsers linking one wallet at once: the column is
                // unique, and the second is told so.
                Err(sqlx::Error::Database(err)) if err.is_unique_violation() => Ok(
                    WalletOutcome::Refused("that wallet was just linked to another account".into()),
                ),
                Err(err) => Err(err).context("linking a wallet"),
            }
        }
    }
}

/// The time now, as an RFC 3339 UTC timestamp, from the system clock.
fn utc_now() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Days since 1970 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
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
    fn a_wallet_signature_is_checked_and_nothing_else_passes() {
        use ed25519_dalek::{Signer, SigningKey};
        let wallet = SigningKey::from_bytes(&[7u8; 32]);
        let public = bs58::encode(wallet.verifying_key().to_bytes()).into_string();
        let message = challenge("play.solatel.test", PlayerId::new()).unwrap();
        let signed = bs58::encode(wallet.sign(message.as_bytes()).to_bytes()).into_string();

        assert_eq!(verify(&message, &public, &signed), Ok(public.clone()));
        // A different message, a different wallet, or rubbish: all refused.
        let other = challenge("play.solatel.test", PlayerId::new()).unwrap();
        assert!(verify(&other, &public, &signed).is_err());
        let stranger = SigningKey::from_bytes(&[9u8; 32]);
        let stranger = bs58::encode(stranger.verifying_key().to_bytes()).into_string();
        assert!(verify(&message, &stranger, &signed).is_err());
        assert!(verify(&message, "not base58 at all!", &signed).is_err());
        assert!(verify(&message, &public, "short").is_err());
    }

    #[test]
    fn a_challenge_names_the_site_the_account_and_a_fresh_nonce() {
        let player = PlayerId::new();
        let one = challenge("evil.example<script>", player).unwrap();
        let two = challenge("evil.example<script>", player).unwrap();
        assert!(one.starts_with("evil.examplescript asks you"), "{one}");
        assert!(one.contains(&player.to_string()));
        assert_ne!(one, two, "two challenges alike");
        assert!(challenge("", player).unwrap().starts_with("Solatel asks you"));
    }

    #[test]
    fn the_issued_time_is_a_real_date() {
        let now = utc_now();
        assert_eq!(now.len(), 20, "{now}");
        assert!(now.starts_with("20") && now.ends_with('Z'), "{now}");
    }

    /// Every way a wallet sign-in can go, against a real Postgres: linking,
    /// linking again, signing another browser in as the wallet's account
    /// with a key that works, refusing to strand a balance, and one wallet
    /// to an account.
    ///
    /// Ignored by default because it needs a database. Run it with
    /// `DATABASE_URL=... cargo test -p solatel-server -- --ignored wallet`.
    /// It makes players and wallets of its own.
    #[tokio::test]
    #[ignore = "needs a Postgres at DATABASE_URL"]
    async fn a_wallet_signs_in_as_one_account_from_any_browser() {
        use ed25519_dalek::SigningKey;
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let pool = crate::db::connect(&url).await.unwrap();
        crate::db::migrate(&pool).await.unwrap();
        let wallet_key = |seed: u8| {
            let mut bytes = [seed; 32];
            getrandom::getrandom(&mut bytes[..16]).unwrap();
            bs58::encode(SigningKey::from_bytes(&bytes).verifying_key().to_bytes()).into_string()
        };

        // A browser's account, and a wallet nobody has: linked.
        let first = sign_in(&pool, None).await.unwrap();
        let wallet = wallet_key(1);
        assert!(matches!(
            wallet_sign_in(&pool, first.player_id, &wallet).await.unwrap(),
            WalletOutcome::Linked
        ));
        // Again: still linked, nothing new.
        assert!(matches!(
            wallet_sign_in(&pool, first.player_id, &wallet).await.unwrap(),
            WalletOutcome::Linked
        ));
        // The account carries it when it signs in.
        let back = sign_in(&pool, first.new_key.as_deref()).await.unwrap();
        assert_eq!(back.solana_pubkey.as_deref(), Some(wallet.as_str()));

        // Another browser signs in with that wallet: it becomes the first
        // account, with a key of its own that works, and the first key
        // still works too.
        let second = sign_in(&pool, None).await.unwrap();
        let WalletOutcome::SignedInAs { player_id, key } =
            wallet_sign_in(&pool, second.player_id, &wallet).await.unwrap()
        else {
            panic!("a second browser was not signed in as the wallet's account");
        };
        assert_eq!(player_id, first.player_id);
        assert_eq!(sign_in(&pool, Some(&key)).await.unwrap().player_id, first.player_id);
        assert_eq!(
            sign_in(&pool, first.new_key.as_deref()).await.unwrap().player_id,
            first.player_id
        );

        // One wallet to an account.
        assert!(matches!(
            wallet_sign_in(&pool, first.player_id, &wallet_key(2)).await.unwrap(),
            WalletOutcome::Refused(_)
        ));

        // A browser holding money and no wallet is not walked away from.
        let holder = sign_in(&pool, None).await.unwrap();
        let mut accounts = crate::ledger::test_accounts();
        crate::ledger::test_deposit(&pool, &mut accounts, holder.player_id, 2_000_000)
            .await
            .unwrap();
        let refused = wallet_sign_in(&pool, holder.player_id, &wallet).await.unwrap();
        assert!(
            matches!(&refused, WalletOutcome::Refused(reason) if reason.contains("$2.00")),
            "{refused:?}"
        );
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
