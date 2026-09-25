//! Money in and money out: the chain side of the wallet.
//!
//! # The shape
//!
//! Playing never touches a chain. Entry fees and kill rewards move between
//! accounts in Postgres, in micro-USD, at the speed of a database. Real money
//! crosses the boundary exactly twice, and this module is both crossings:
//!
//! * **In.** A player sends SOL to the treasury's one address with their
//!   player id as the memo. A watcher reads the treasury's finalized history,
//!   and each transfer it has not seen before is judged once: credited to the
//!   player the memo names, or recorded as money nobody could be found for.
//!   The ledger key is `deposit:<signature>` - the chain's own name for the
//!   event - so a transfer seen twice is credited once.
//!
//! * **Out.** A withdrawal is taken out of the player's balance the moment it
//!   is asked for (by the ledger task, in line with every other money event),
//!   and held in `treasury` until the chain has it. Only then is it signed,
//!   and the signature is written down *before* anything is sent: a
//!   transaction's signature is its id, so a transfer on record can be sent
//!   again, or waited out, without ever being paid twice. Final on chain, it
//!   leaves the books to `external`. Expired without landing, it goes back to
//!   the player.
//!
//! # The rate
//!
//! One SOL is worth whatever `SOLATEL_SOL_USD` says, and nothing reads a
//! market. That is a decision, not an omission: on devnet the SOL is free and
//! the rate only has to be deterministic, and on a real network it would mean
//! **we eat the difference** between the configured price and the real one on
//! every deposit and every withdrawal. Plisio replaces this rail for real
//! money, and prices its own invoices.
//!
//! There is no default. A guessed price is a guess about what somebody's
//! deposit is worth.
//!
//! Both conversions round down, and the direction is the point: a deposit is
//! never credited for more than arrived, and a withdrawal never sends more
//! than was taken. What rounding leaves behind is less than one lamport or
//! one micro-USD, and it stays in the treasury.
//!
//! # Devnet only
//!
//! [`solana::Cluster::devnet`] is the only cluster this talks to. See the note
//! in `CLAUDE.md`, which is not a style preference.

use crate::{
    game::{GameCommand, GameHandle},
    ledger::{self, Accounts, Receipt, ReceiptOutcome, WithdrawalRow},
    solana::{self, Address, Outcome, Rpc, Treasury},
};
use anyhow::{Context, Result, bail};
use solatel_protocol::{
    MIN_WITHDRAWAL,
    ids::PlayerId,
    money::MicroUsd,
    net::{ServerMsg, WalletTerms, WithdrawalStatus},
};
use sqlx::PgPool;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;
use uuid::Uuid;

/// Lamports in one SOL, as the decimal places a SOL amount is written with.
const SOL_PLACES: u32 = 9;

/// Micro-USD in one dollar, as decimal places.
const USD_PLACES: u32 = 6;

/// How often the chain is looked at when nothing asks sooner.
///
/// A deposit is final on devnet in about thirteen seconds, so five is the
/// difference between a player waiting fifteen and waiting twenty. A
/// withdrawal wakes the loop itself rather than waiting for this.
const POLL: Duration = Duration::from_secs(5);

/// Signatures fetched per page of the treasury's history.
const PAGE: u32 = 100;

/// Pages read in one pass before giving the rest to the next one.
///
/// Normally the first page contains a signature already judged and the pass
/// stops there. This bounds a first run against an address with a long past.
const MAX_PAGES: usize = 10;

/// Blocks past a transaction's last valid height before it is written off.
///
/// At the last valid height itself the answer is already certain in
/// principle. The margin is for the node answering being a little behind the
/// one that would have included it, and costs a player about thirteen
/// seconds on a transfer that has already failed.
const EXPIRY_MARGIN: u64 = 32;

/// What one SOL is worth, in micro-USD. Fixed by configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SolUsd(i64);

impl SolUsd {
    /// Read a price written in dollars: `140`, `140.5`, `139.999999`.
    pub fn parse(text: &str) -> Result<Self> {
        let micros = parse_decimal(text, USD_PLACES)
            .with_context(|| format!("{text:?} is not a price in dollars"))?;
        if micros <= 0 {
            bail!("a SOL price of {text} is not a price");
        }
        let micros = i64::try_from(micros).context("that SOL price is out of range")?;
        Ok(SolUsd(micros))
    }

    pub const fn micro_usd(self) -> i64 {
        self.0
    }

    /// What a deposit of this many lamports is worth. Rounded down.
    pub fn micros_for(self, lamports: u64) -> i64 {
        let micros = lamports as i128 * self.0 as i128 / 10i128.pow(SOL_PLACES);
        i64::try_from(micros).unwrap_or(i64::MAX)
    }

    /// How many lamports a withdrawal of this much sends. Rounded down.
    pub fn lamports_for(self, micros: i64) -> u64 {
        if micros <= 0 {
            return 0;
        }
        let lamports = micros as i128 * 10i128.pow(SOL_PLACES) / self.0 as i128;
        u64::try_from(lamports).unwrap_or(u64::MAX)
    }
}

/// A decimal written out as text, as an integer count of its smallest unit.
///
/// `parse_decimal("1.25", 6)` is `1_250_000`. Money arrives as text - from an
/// environment variable, from a command line - and turning it into a float on
/// the way to an integer is exactly the rounding this codebase forbids.
pub fn parse_decimal(text: &str, places: u32) -> Option<i128> {
    let text = text.trim();
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    if whole.is_empty() && fraction.is_empty() {
        return None;
    }
    if !whole.chars().all(|c| c.is_ascii_digit()) || !fraction.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if fraction.len() > places as usize || whole.len() > 18 {
        return None;
    }
    let whole: i128 = if whole.is_empty() {
        0
    } else {
        whole.parse().ok()?
    };
    let padded = format!("{fraction:0<width$}", width = places as usize);
    let fraction: i128 = if padded.is_empty() {
        0
    } else {
        padded.parse().ok()?
    };
    Some(whole * 10i128.pow(places) + fraction)
}

/// Lamports as SOL, for a log line or a terminal. Never for arithmetic.
pub fn sol_text(lamports: u64) -> String {
    let whole = lamports / 1_000_000_000;
    let fraction = lamports % 1_000_000_000;
    let fraction = format!("{fraction:09}");
    let fraction = fraction.trim_end_matches('0');
    if fraction.is_empty() {
        format!("{whole}")
    } else {
        format!("{whole}.{fraction}")
    }
}

/// What this server offers, and the rules a withdrawal is judged by.
///
/// Pure data, so the lobby - a synchronous loop that must not wait on
/// anything - can refuse a bad request on the spot and only ever hand the
/// ledger one it has a reason to process.
#[derive(Debug, Clone)]
pub struct Terms {
    pub treasury: Address,
    pub rate: SolUsd,
    /// False when this server hands out development money. That money can be
    /// played with and must not leave as SOL, however worthless devnet SOL
    /// is: the habit is the thing being kept.
    pub withdrawals_open: bool,
}

/// A withdrawal that has passed every rule that does not need the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quote {
    pub amount: MicroUsd,
    pub lamports: u64,
    pub destination: Address,
    pub rate: SolUsd,
}

impl Terms {
    /// What goes in the `Welcome`.
    pub fn offer(&self, player_id: PlayerId) -> WalletTerms {
        WalletTerms {
            network: "devnet".to_string(),
            deposit_address: self.treasury.to_string(),
            deposit_memo: player_id.to_string(),
            micro_usd_per_sol: self.rate.micro_usd(),
            min_withdrawal_micro_usd: MIN_WITHDRAWAL.micros(),
            withdrawals_open: self.withdrawals_open,
        }
    }

    /// Whether a withdrawal can be accepted, and what it would send.
    ///
    /// Everything but the balance, which is the ledger's to check. The
    /// reasons are written for the player, because they are shown to one.
    pub fn quote(&self, amount_micro_usd: i64, destination: &str) -> Result<Quote, String> {
        if !self.withdrawals_open {
            return Err(
                "withdrawals are off on this server: it hands out development money, \
                 and that must not leave as SOL"
                    .to_string(),
            );
        }
        if amount_micro_usd < MIN_WITHDRAWAL.micros() {
            return Err(format!("the least you can take out is {MIN_WITHDRAWAL}"));
        }
        let destination = Address::parse(destination.trim())
            .map_err(|_| "that is not a Solana address".to_string())?;
        // An address off the ed25519 curve belongs to a program rather than
        // to anybody with a key. SOL sent there is not lost, but nobody the
        // player knows can spend it either.
        if ed25519_dalek::VerifyingKey::from_bytes(&destination.0).is_err() {
            return Err("that address is not a wallet anybody can spend from".to_string());
        }
        if destination == self.treasury {
            return Err("that is the game's own address".to_string());
        }
        let lamports = self.rate.lamports_for(amount_micro_usd);
        if lamports < solana::RENT_EXEMPT_MINIMUM {
            return Err("that is too little to send to a new wallet".to_string());
        }
        Ok(Quote {
            amount: MicroUsd(amount_micro_usd),
            lamports,
            destination,
            rate: self.rate,
        })
    }
}

/// The wallet, configured: its terms and the key that signs for it.
pub struct Wallet {
    pub terms: Terms,
    treasury: Treasury,
}

fn configured(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

impl Wallet {
    /// Both halves or neither.
    ///
    /// A treasury with no rate would be a server that cannot say what a
    /// deposit is worth, and a rate with no treasury is a server with nowhere
    /// for one to go. Either is a mistake worth refusing to start over rather
    /// than running with half a wallet.
    pub fn from_env(dev_grant: bool) -> Result<Option<Self>> {
        let key = configured("SOLATEL_TREASURY_KEY");
        let rate = configured("SOLATEL_SOL_USD");
        let (key, rate) = match (key, rate) {
            (None, None) => return Ok(None),
            (Some(_), None) => bail!(
                "SOLATEL_TREASURY_KEY is set but SOLATEL_SOL_USD is not. There is no default: \
                 a guessed price is a guess about what somebody's deposit is worth. \
                 Set it in dollars per SOL, e.g. SOLATEL_SOL_USD=140"
            ),
            (None, Some(_)) => {
                bail!("SOLATEL_SOL_USD is set but SOLATEL_TREASURY_KEY is not (see ./x treasury)")
            }
            (Some(key), Some(rate)) => (key, rate),
        };
        let treasury = Treasury::from_base58(&key)?;
        let rate = SolUsd::parse(&rate).context("SOLATEL_SOL_USD")?;
        Ok(Some(Self {
            terms: Terms {
                treasury: treasury.address,
                rate,
                withdrawals_open: !dev_grant,
            },
            treasury,
        }))
    }
}

/// What the treasury holds against what is owed, for `/health`.
///
/// An operator's number. Informational rather than a health failure: on a
/// server handing out development grants, what is owed exceeds what is held
/// by design.
#[derive(Debug, Clone, Default)]
pub struct Solvency {
    pub treasury_lamports: u64,
    /// The treasury at the configured rate.
    pub treasury_micro_usd: i64,
    /// Every player balance, every stake in escrow and every withdrawal in
    /// flight.
    pub owed_micro_usd: i64,
    pub micro_usd_per_sol: i64,
}

#[derive(Clone, Default)]
pub struct WalletHealth(Arc<Mutex<Option<Solvency>>>);

impl WalletHealth {
    pub fn get(&self) -> Option<Solvency> {
        self.0.lock().ok().and_then(|s| s.clone())
    }

    fn set(&self, solvency: Solvency) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(solvency);
        }
    }
}

/// Starts the loop that watches the chain.
pub fn spawn(wallet: Wallet, pool: PgPool, game: GameHandle, wake: Arc<Notify>) -> WalletHealth {
    let health = WalletHealth::default();
    let published = health.clone();
    tracing::info!(
        treasury = %wallet.terms.treasury,
        sol_usd = %MicroUsd(wallet.terms.rate.micro_usd()),
        withdrawals = wallet.terms.withdrawals_open,
        "wallet on devnet: deposits to the treasury, memo = player id"
    );
    if !wallet.terms.withdrawals_open {
        tracing::warn!(
            "withdrawals are off because SOLATEL_DEV_GRANT is set; development money must not leave as SOL"
        );
    }

    tokio::spawn(async move {
        let rpc = match Rpc::new(solana::Cluster::devnet()) {
            Ok(rpc) => rpc,
            Err(err) => {
                tracing::error!(?err, "no Solana client; the wallet is not running");
                return;
            }
        };
        let mut accounts = Accounts::default();
        let mut ticker = tokio::time::interval(POLL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Failing the same way every five seconds is one fault, and logged
        // once until it clears.
        let mut failing = false;

        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = wake.notified() => {}
            }
            let chain = &Chain {
                rpc: &rpc,
                pool: &pool,
                game: &game,
                wallet: &wallet,
            };
            let outcome = async {
                chain.scan_deposits(&mut accounts).await?;
                chain.drive_withdrawals(&mut accounts).await?;
                chain.solvency().await
            }
            .await;
            match outcome {
                Ok(solvency) => {
                    if failing {
                        tracing::info!("the wallet is talking to the chain again");
                    }
                    failing = false;
                    published.set(solvency);
                }
                Err(err) if !failing => {
                    failing = true;
                    tracing::warn!(?err, "the wallet could not finish a pass; retrying");
                }
                Err(_) => {}
            }
        }
    });

    health
}

/// One pass's worth of everything the loop needs.
struct Chain<'a> {
    rpc: &'a Rpc,
    pool: &'a PgPool,
    game: &'a GameHandle,
    wallet: &'a Wallet,
}

impl Chain<'_> {
    fn treasury(&self) -> Address {
        self.wallet.terms.treasury
    }

    async fn tell(&self, player_id: PlayerId, message: ServerMsg) {
        self.game
            .send(GameCommand::Tell { player_id, message })
            .await;
    }

    async fn tell_balance(&self, player_id: PlayerId) {
        if let Ok(balance) = ledger::balance(self.pool, player_id).await {
            self.game
                .send(GameCommand::BalanceChanged {
                    player_id,
                    balance_micro_usd: balance.micros(),
                })
                .await;
        }
    }

    // ---- in ------------------------------------------------------------

    /// Judge every finalized transaction to the treasury not judged before.
    async fn scan_deposits(&self, accounts: &mut Accounts) -> Result<()> {
        let mut fresh = Vec::new();
        let mut before: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let page = self
                .rpc
                .signatures_for(self.treasury(), PAGE, before.as_deref())
                .await?;
            if page.is_empty() {
                break;
            }
            let signatures: Vec<String> = page.iter().map(|s| s.signature.clone()).collect();
            let known: HashSet<String> = sqlx::query_scalar(
                "SELECT signature FROM treasury_receipts WHERE signature = ANY($1)",
            )
            .bind(&signatures)
            .fetch_all(self.pool)
            .await
            .context("checking which signatures have been judged")?
            .into_iter()
            .collect();
            let reached_the_known = !known.is_empty();
            let full = page.len() == PAGE as usize;
            before = page.last().map(|s| s.signature.clone());
            fresh.extend(page.into_iter().filter(|s| !known.contains(&s.signature)));
            if reached_the_known || !full {
                break;
            }
        }

        // Oldest first, so money is credited in the order the chain made it.
        for seen in fresh.into_iter().rev() {
            if let Err(err) = self.judge(accounts, &seen).await {
                // One transaction the node will not describe yet must not
                // hold up every one after it. It is not recorded, so the
                // next pass asks again.
                tracing::debug!(signature = %seen.signature, ?err, "could not judge a treasury transaction yet");
            }
        }
        Ok(())
    }

    async fn judge(&self, accounts: &mut Accounts, seen: &solana::Seen) -> Result<()> {
        let rate = self.wallet.terms.rate;
        let nothing = |signature: &str| Receipt {
            signature: signature.to_string(),
            lamports: 0,
            memo: None,
            player_id: None,
            micro_usd: 0,
            micro_usd_per_sol: rate.micro_usd(),
            outcome: ReceiptOutcome::NotIncoming,
            block_time: None,
        };

        if seen.failed {
            ledger::record_receipt(self.pool, accounts, &nothing(&seen.signature)).await?;
            return Ok(());
        }
        let Some(incoming) = self.rpc.incoming(&seen.signature, self.treasury()).await? else {
            // It touched the treasury and paid it nothing - usually one of
            // our own withdrawals going out.
            ledger::record_receipt(self.pool, accounts, &nothing(&seen.signature)).await?;
            return Ok(());
        };

        let micro_usd = rate.micros_for(incoming.lamports);
        let named = incoming.memo.as_deref().and_then(memo_player);
        let player_id = match named {
            Some(id) => {
                let exists: bool =
                    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM players WHERE id = $1)")
                        .bind(id)
                        .fetch_one(self.pool)
                        .await
                        .context("looking for the player a memo names")?;
                exists.then(|| PlayerId::from(id))
            }
            None => None,
        };
        let outcome = if micro_usd <= 0 {
            ReceiptOutcome::TooSmall
        } else if player_id.is_none() {
            ReceiptOutcome::Unmatched
        } else {
            ReceiptOutcome::Credited
        };
        let receipt = Receipt {
            signature: incoming.signature.clone(),
            lamports: incoming.lamports,
            memo: incoming.memo.clone(),
            player_id: player_id.filter(|_| outcome == ReceiptOutcome::Credited),
            micro_usd: if outcome == ReceiptOutcome::Credited {
                micro_usd
            } else {
                0
            },
            micro_usd_per_sol: rate.micro_usd(),
            outcome,
            block_time: incoming.at,
        };

        let credited = ledger::record_receipt(self.pool, accounts, &receipt).await?;
        match (credited, receipt.player_id) {
            (true, Some(player_id)) => {
                tracing::info!(
                    %player_id,
                    amount = %MicroUsd(micro_usd),
                    sol = %sol_text(incoming.lamports),
                    signature = %incoming.signature,
                    "deposit credited"
                );
                self.tell(
                    player_id,
                    ServerMsg::Deposited {
                        amount_micro_usd: micro_usd,
                        lamports: incoming.lamports,
                        signature: incoming.signature,
                    },
                )
                .await;
                self.tell_balance(player_id).await;
            }
            _ if outcome == ReceiptOutcome::Unmatched => tracing::warn!(
                sol = %sol_text(incoming.lamports),
                memo = ?incoming.memo,
                signature = %incoming.signature,
                "a deposit whose memo names nobody; held, not credited"
            ),
            _ => {}
        }
        Ok(())
    }

    // ---- out -----------------------------------------------------------

    async fn drive_withdrawals(&self, accounts: &mut Accounts) -> Result<()> {
        self.sign_requested(accounts).await?;
        self.follow_sent(accounts).await
    }

    /// Sign what has been asked for, write each signature down, then send.
    async fn sign_requested(&self, accounts: &mut Accounts) -> Result<()> {
        let requested = ledger::withdrawals_in(self.pool, "requested").await?;
        if requested.is_empty() {
            return Ok(());
        }
        let mut available = self.rpc.balance(self.treasury()).await?;

        for row in requested {
            let lamports = row.lamports as u64;
            // The treasury has to cover the transfer and its fee and stay
            // open afterwards: an account left below the rent-exempt minimum
            // is one the chain refuses to leave that way.
            let needed = lamports + solana::SIGNATURE_FEE;
            if available < needed + solana::RENT_EXEMPT_MINIMUM {
                self.give_back(
                    accounts,
                    &row,
                    "the game's treasury cannot cover this right now",
                )
                .await?;
                continue;
            }
            let destination = Address::parse(&row.destination)?;
            let memo = format!("solatel withdrawal {}", row.id);
            let signed = self
                .rpc
                .sign_transfer(&self.wallet.treasury, destination, lamports, Some(&memo))
                .await?;

            // On record before it goes anywhere. If this process dies
            // between here and the send, the next one finds a signature it
            // can wait out, rather than a withdrawal it might sign twice.
            let recorded = sqlx::query(
                "UPDATE withdrawals
                    SET status = 'sent', signature = $2, signed_transaction = $3,
                        last_valid_block_height = $4, updated_at = now()
                  WHERE id = $1 AND status = 'requested'",
            )
            .bind(row.id)
            .bind(&signed.signature)
            .bind(&signed.wire_base64)
            .bind(signed.last_valid_block_height as i64)
            .execute(self.pool)
            .await
            .context("recording a signed withdrawal")?;
            if recorded.rows_affected() == 0 {
                continue;
            }
            available -= needed;
            tracing::info!(
                id = %row.id,
                sol = %sol_text(lamports),
                to = %row.destination,
                signature = %signed.signature,
                "withdrawal signed"
            );
            let mut sent = row.clone();
            sent.status = "sent".to_string();
            sent.signature = Some(signed.signature.clone());
            self.tell(sent.player(), sent.message()).await;

            if let Err(err) = self.rpc.send(&signed.wire_base64).await {
                // Not a failure: what happened is asked of the chain on the
                // next pass, and the same bytes are sent again until it
                // answers or the blockhash runs out.
                tracing::debug!(id = %row.id, ?err, "sending a withdrawal did not answer cleanly");
            }
        }
        Ok(())
    }

    /// Ask the chain what became of each withdrawal in flight.
    async fn follow_sent(&self, accounts: &mut Accounts) -> Result<()> {
        let sent = ledger::withdrawals_in(self.pool, "sent").await?;
        let mut height: Option<u64> = None;

        for row in sent {
            let (Some(signature), Some(wire), Some(last_valid)) = (
                row.signature.clone(),
                row.signed_transaction.clone(),
                row.last_valid_block_height,
            ) else {
                // The table's own constraint makes this impossible.
                continue;
            };
            match self.rpc.outcome(&signature).await? {
                Outcome::Finalized => {
                    if ledger::settle_withdrawal(self.pool, accounts, &row).await? {
                        tracing::info!(id = %row.id, %signature, "withdrawal final on chain");
                        let mut settled = row.clone();
                        settled.status = "settled".to_string();
                        self.tell(settled.player(), settled.message()).await;
                    }
                }
                Outcome::Failed => {
                    self.give_back(accounts, &row, "the chain refused the transfer")
                        .await?;
                }
                Outcome::Pending => {}
                Outcome::Unknown => {
                    let now = match height {
                        Some(h) => h,
                        None => {
                            let h = self.rpc.finalized_height().await?;
                            height = Some(h);
                            h
                        }
                    };
                    if now > last_valid as u64 + EXPIRY_MARGIN {
                        self.give_back(accounts, &row, "the transfer expired before it landed")
                            .await?;
                    } else if let Err(err) = self.rpc.send(&wire).await {
                        tracing::debug!(id = %row.id, ?err, "sending a withdrawal again");
                    }
                }
            }
        }
        Ok(())
    }

    /// Put a withdrawal that will never land back in the player's wallet.
    async fn give_back(
        &self,
        accounts: &mut Accounts,
        row: &WithdrawalRow,
        reason: &str,
    ) -> Result<()> {
        if !ledger::return_withdrawal(self.pool, accounts, row, reason).await? {
            return Ok(());
        }
        tracing::warn!(id = %row.id, reason, "withdrawal returned to the player");
        let mut returned = row.clone();
        returned.status = "returned".to_string();
        returned.reason = Some(reason.to_string());
        self.tell(returned.player(), returned.message()).await;
        self.tell_balance(returned.player()).await;
        Ok(())
    }

    async fn solvency(&self) -> Result<Solvency> {
        let lamports = self.rpc.balance(self.treasury()).await?;
        let owed = ledger::owed(self.pool).await?;
        let rate = self.wallet.terms.rate;
        Ok(Solvency {
            treasury_lamports: lamports,
            treasury_micro_usd: rate.micros_for(lamports),
            owed_micro_usd: owed.micros(),
            micro_usd_per_sol: rate.micro_usd(),
        })
    }
}

/// The player a memo names, if it names one.
///
/// Lenient about what surrounds the id - a memo of `solatel <id>` or one with
/// a trailing newline still finds its player - and strict about the id itself.
fn memo_player(memo: &str) -> Option<Uuid> {
    memo.split(|c: char| !(c.is_ascii_hexdigit() || c == '-'))
        .filter(|token| token.len() == 36 || token.len() == 32)
        .find_map(|token| Uuid::parse_str(token).ok())
}

impl WithdrawalRow {
    fn player(&self) -> PlayerId {
        PlayerId::from(self.player_id)
    }

    /// The row as the player is told it.
    pub fn message(&self) -> ServerMsg {
        let status = match self.status.as_str() {
            "sent" => WithdrawalStatus::Sent,
            "settled" => WithdrawalStatus::Settled,
            "returned" => WithdrawalStatus::Returned,
            _ => WithdrawalStatus::Requested,
        };
        ServerMsg::Withdrawal {
            id: self.id.into(),
            status,
            amount_micro_usd: self.amount_micro_usd,
            lamports: self.lamports as u64,
            destination: self.destination.clone(),
            signature: self.signature.clone(),
            reason: self.reason.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms() -> Terms {
        Terms {
            treasury: Treasury::from_seed([1u8; 32]).address,
            rate: SolUsd::parse("140").unwrap(),
            withdrawals_open: true,
        }
    }

    fn wallet_address() -> String {
        Treasury::from_seed([2u8; 32]).address.to_string()
    }

    #[test]
    fn prices_are_read_without_a_float() {
        assert_eq!(SolUsd::parse("140").unwrap().micro_usd(), 140_000_000);
        assert_eq!(SolUsd::parse("140.5").unwrap().micro_usd(), 140_500_000);
        assert_eq!(SolUsd::parse(" 0.000001 ").unwrap().micro_usd(), 1);
        for nonsense in [
            "",
            ".",
            "-1",
            "0",
            "1.0000001",
            "1e3",
            "abc",
            "1.2.3",
            "$140",
        ] {
            assert!(
                SolUsd::parse(nonsense).is_err(),
                "{nonsense:?} was accepted"
            );
        }
    }

    #[test]
    fn a_sol_amount_is_counted_in_lamports() {
        assert_eq!(parse_decimal("0.25", SOL_PLACES), Some(250_000_000));
        assert_eq!(parse_decimal("2", SOL_PLACES), Some(2_000_000_000));
        assert_eq!(parse_decimal(".5", SOL_PLACES), Some(500_000_000));
        assert_eq!(
            parse_decimal("0.0000000001", SOL_PLACES),
            None,
            "finer than a lamport"
        );
        assert_eq!(sol_text(250_000_000), "0.25");
        assert_eq!(sol_text(2_000_000_000), "2");
        assert_eq!(sol_text(1), "0.000000001");
    }

    #[test]
    fn both_conversions_round_in_our_favour_by_less_than_a_unit() {
        let rate = SolUsd::parse("140").unwrap();
        // One SOL is exactly the price.
        assert_eq!(rate.micros_for(1_000_000_000), 140_000_000);
        // $5 is 0.0357142857... SOL: rounded down to a whole lamport.
        let lamports = rate.lamports_for(5_000_000);
        assert_eq!(lamports, 35_714_285);
        // And that many lamports is worth a hair under $5 - never more.
        assert!(rate.micros_for(lamports) <= 5_000_000);
        assert!(5_000_000 - rate.micros_for(lamports) <= 1);
        // A lamport is worth less than a micro-USD at this price.
        assert_eq!(rate.micros_for(1), 0);
    }

    #[test]
    fn a_withdrawal_is_quoted_at_the_configured_rate() {
        let quote = terms().quote(5_000_000, &wallet_address()).unwrap();
        assert_eq!(quote.lamports, 35_714_285);
        assert_eq!(quote.amount, MicroUsd(5_000_000));
    }

    #[test]
    fn a_bad_withdrawal_is_refused_before_it_reaches_the_ledger() {
        let t = terms();
        assert!(
            t.quote(4_999_999, &wallet_address()).is_err(),
            "below the minimum"
        );
        assert!(t.quote(5_000_000, "not an address").is_err());
        assert!(
            t.quote(5_000_000, "abc").is_err(),
            "base58, but not 32 bytes"
        );
        assert!(
            t.quote(5_000_000, &t.treasury.to_string()).is_err(),
            "to ourselves"
        );

        let mut closed = terms();
        closed.withdrawals_open = false;
        assert!(closed.quote(5_000_000, &wallet_address()).is_err());
    }

    #[test]
    fn an_address_nobody_holds_a_key_for_is_refused() {
        // About half of all y coordinates have no point on the curve. Which
        // ones is arithmetic, so the test finds one rather than restating it.
        let off = (2u8..=255)
            .map(|y| {
                let mut bytes = [0u8; 32];
                bytes[0] = y;
                bytes
            })
            .find(|bytes| ed25519_dalek::VerifyingKey::from_bytes(bytes).is_err())
            .expect("half of all y coordinates are off the curve");
        let text = Address(off).to_string();
        assert!(terms().quote(5_000_000, &text).is_err());
    }

    #[test]
    fn a_memo_finds_its_player_among_other_words() {
        let id = Uuid::new_v4();
        assert_eq!(memo_player(&id.to_string()), Some(id));
        assert_eq!(memo_player(&format!("  {id}\n")), Some(id));
        assert_eq!(memo_player(&format!("solatel {id}")), Some(id));
        assert_eq!(memo_player(&id.simple().to_string()), Some(id));
        assert_eq!(memo_player("hello"), None);
        assert_eq!(memo_player(""), None);
    }

    #[test]
    fn the_offer_names_the_player_as_the_memo() {
        let player = PlayerId::new();
        let offer = terms().offer(player);
        assert_eq!(offer.deposit_memo, player.to_string());
        assert_eq!(offer.network, "devnet");
        assert_eq!(offer.micro_usd_per_sol, 140_000_000);
    }
}
