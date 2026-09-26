//! Moving money, and the one place that does it.
//!
//! Every rule that protects the books lives in the database, not here: entries
//! are append-only, a transaction's legs must sum to zero, a balance cannot go
//! negative, and an idempotency key can only be used once. `./x ledger` proves
//! all of that against a real Postgres. This module's job is narrower and
//! entirely mechanical - turn a thing that happened in a match into the right
//! legs, inside one explicit transaction, under a key that could be replayed
//! safely.
//!
//! # Why this is a separate task from the world
//!
//! The world is a synchronous loop stepping sixty-four times a second. A
//! database round trip is tens of milliseconds. Doing one inside the tick
//! would stall every player in the match while one player's balance was read.
//!
//! So money is asked for, not taken: the world sends a [`LedgerRequest`] and
//! carries on, and the answer comes back later as a `GameCommand`. That
//! ordering is also what makes the rules honest. **Nobody is put on the map
//! until their stake has been paid**, never before with a promise to charge
//! later, because "later" is a window in which a player can be shot while
//! standing in a match nobody paid for.
//!
//! # What an idempotency key is for
//!
//! Every request carries one, built from the thing that happened rather than
//! from a counter: a kill is keyed by the victim's stake in that match, a
//! purchase by the match, a deposit by the chain's signature for it and a
//! withdrawal by its own id. If the world retries - and it will, because a
//! task can restart - the database refuses the duplicate and the retry is a
//! no-op rather than a second payout.
//!
//! # Money that crosses the chain
//!
//! Deposits and withdrawals are posted here too, because this is the one
//! place that posts. The chain side - reading the treasury's history, signing
//! and following transfers - is `wallet.rs`, and it calls the functions at the
//! bottom of this file to put what it finds into the books.

use crate::{
    game::{GameCommand, GameHandle},
    wallet::Quote,
};
use anyhow::{Context, Result, bail};
use solatel_protocol::{
    Stakes,
    ids::{MatchId, PlayerId, WithdrawalId},
    money::MicroUsd,
    net::ServerMsg,
};
use sqlx::postgres::{PgPool, Postgres};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{Notify, mpsc};
use uuid::Uuid;

/// One player's stake in one match.
///
/// Money is keyed on this pair rather than on a player, because a player
/// enters many matches and each stake is separately settled. A `MatchId` is a
/// fresh UUID every time, so a key built from one is never reused and a
/// replayed request is refused by the database rather than paid twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EntryId {
    pub match_id: MatchId,
    pub player_id: PlayerId,
}

impl EntryId {
    fn key(&self, what: &str) -> String {
        format!("{what}:{}:{}", self.match_id, self.player_id)
    }
}

/// The key under which a whole match's entry fees were taken.
///
/// One match, one purchase, one journal entry - see [`buy_match`].
fn match_key(match_id: MatchId) -> String {
    format!("entry:{match_id}")
}

/// Longer than this and a money event is worth complaining about: it is
/// time a player spends dead, waiting for a database on the other side of
/// the internet to say they may come back.
const SLOW_EVENT_MS: u128 = 1500;

/// Work for the ledger task.
///
/// An entry fee goes into escrow and leaves it exactly once, by one of the
/// three routes below. Which route it takes is the whole of the economy:
/// somebody killed you, nobody did, or you walked away from the table.
///
/// What never moves is a player's *winnings*. A kill pays the killer
/// the reward out of the victim's entry fee and nothing else - it does not
/// reach into what the victim had already earned. Every kill settles as it
/// happens, so by the time a player dies their winnings are in their wallet
/// and cannot be taken off them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerRequest {
    /// Charge a whole match's entry fees, in one transaction.
    ///
    /// One match, one purchase. Charging player by player is the obvious
    /// shape and is the wrong one: every purchase is a database round trip,
    /// and thirteen of them in a row took longer than the match was willing
    /// to wait to form, so a thirteen player match started with six. A
    /// match's buy-in is one event and the journal now says so.
    ///
    /// It is also the only request that names a stake. Every settlement
    /// below reads what was actually taken out of the player's balance and
    /// splits *that*, so a settlement cannot disagree with its own purchase
    /// however many tables are running at once.
    BuyMatch {
        match_id: MatchId,
        stakes: Stakes,
        players: Vec<PlayerId>,
    },
    /// The player was killed. Their stake goes to whoever did it.
    SettleKill { entry: EntryId, killer: PlayerId },
    /// The player left the table with the match still running - they
    /// disconnected and did not come back inside the resume window, or fell
    /// out of the world with nobody to credit.
    ///
    /// They get the reward back and we keep the rake: the same split as a
    /// kill, with the player themself standing in the killer's place. It is
    /// not a free exit - walking out of a losing fight costs the rake - and
    /// it is not a confiscation either, because nobody won that stake.
    ///
    /// Anybody who shoots them inside the window claims it properly instead,
    /// and that is settled as a kill.
    AbandonEntry { entry: EntryId },
    /// The player was still alive when the clock ran out. Nobody won their
    /// stake, so they keep it.
    RefundEntry { entry: EntryId },
    /// What has this player got? Moves no money.
    ///
    /// Asked when somebody arrives, so the wallet in their menu is a figure
    /// rather than a dash. It is a read on the same queue as the writes,
    /// which keeps it behind anything already settling for them - a balance
    /// that answered ahead of a payout would be a balance that was briefly
    /// wrong in the player's favour.
    ///
    /// Their recent withdrawals go with it, so one in flight across a reload
    /// is shown for what it is rather than as a balance that went down.
    ReadBalance { player_id: PlayerId },
    /// Take money out of a player's wallet, to go on chain.
    ///
    /// On this queue, in line with every other money event, rather than
    /// posted by the wallet task directly. A withdrawal and a match buy-in
    /// both check a balance and then spend it, and two of those racing is a
    /// whole match's buy-in failing on one player's overdraft.
    ///
    /// The quote has already passed every rule that does not need the
    /// database. The balance is checked here.
    Withdraw {
        id: WithdrawalId,
        player_id: PlayerId,
        quote: Quote,
    },
}

impl LedgerRequest {
    fn describe(&self) -> &'static str {
        match self {
            Self::BuyMatch { .. } => "buy",
            Self::SettleKill { .. } => "kill",
            Self::AbandonEntry { .. } => "abandon",
            Self::RefundEntry { .. } => "refund",
            Self::ReadBalance { .. } => "balance",
            Self::Withdraw { .. } => "withdraw",
        }
    }
}

#[derive(Clone)]
pub struct LedgerHandle {
    requests: mpsc::Sender<LedgerRequest>,
}

impl LedgerHandle {
    /// Queues work. Returns false only if the ledger task is gone, which is
    /// worth logging where it happens rather than swallowing here.
    pub fn send(&self, request: LedgerRequest) -> bool {
        match self.requests.try_send(request) {
            Ok(()) => true,
            Err(err) => {
                tracing::error!(%err, "ledger queue full or closed; money event dropped");
                false
            }
        }
    }
}

#[cfg(test)]
impl LedgerHandle {
    /// A ledger that posts nothing and only records what it was asked for.
    ///
    /// The world's half of the money story is worth proving without a
    /// database: what it asks for, when it asks, and what it does with the
    /// answer. The database's half - that the legs balance, that a key
    /// cannot be spent twice, that a balance cannot go negative - is proved
    /// by `./x ledger` against a real Postgres, which is the only place it
    /// can be proved, because those rules are the database's and not this
    /// module's.
    pub fn recording() -> (Self, mpsc::Receiver<LedgerRequest>) {
        let (tx, rx) = mpsc::channel(64);
        (Self { requests: tx }, rx)
    }
}

/// Account ids, looked up once and then remembered.
///
/// The system accounts are created by the migration and never change; a
/// balance account is created the first time its player is seen and never
/// changes either. Looking either one up is a database round trip, and
/// against a managed Postgres the round trips *are* the cost: one player's
/// buy-in took ten of them and three and a half seconds measured, which is three
/// and a half seconds between a player dying and being allowed back in.
///
/// No balance is cached here, only ids. A balance is the thing that changes.
#[derive(Default)]
pub(crate) struct Accounts {
    system: HashMap<&'static str, Uuid>,
    players: HashMap<PlayerId, Uuid>,
}

/// Money the server will give a brand new player, for development only.
///
/// Off unless `SOLATEL_DEV_GRANT` is set to an amount in whole dollars. There
/// is no sign-up, no deposit and no wallet yet, so without this every player
/// joins with nothing and cannot spawn - which is correct behaviour and an
/// unplayable game. It posts a real `deposit` against the `external` account,
/// so the books still balance and the grant is visible as exactly what it is.
pub(crate) fn dev_grant() -> Option<MicroUsd> {
    let raw = std::env::var("SOLATEL_DEV_GRANT").ok()?;
    let dollars: i64 = raw.trim().parse().ok()?;
    (dollars > 0).then(|| MicroUsd::from_usd(dollars))
}

/// Starts the ledger task.
///
/// `wallet` is poked when a withdrawal has been taken out of somebody's
/// balance, so the chain side signs it now rather than on its next pass.
pub fn spawn(
    pool: PgPool,
    game: GameHandle,
    tiers: Vec<Stakes>,
    wallet: Option<Arc<Notify>>,
) -> LedgerHandle {
    let (tx, mut rx) = mpsc::channel::<LedgerRequest>(1024);
    let grant = dev_grant();
    for stakes in &tiers {
        tracing::info!(
            entry = %stakes.entry(),
            reward = %stakes.reward(),
            rake = %stakes.rake(),
            "table open: ${}",
            stakes.dollars()
        );
    }
    if let Some(amount) = grant {
        tracing::warn!(
            amount = %amount,
            "SOLATEL_DEV_GRANT is set; every new player is funded. Never set this in production."
        );
    }

    tokio::spawn(async move {
        let mut accounts = Accounts::default();

        // Before anything else, because until it has run, escrow holds
        // stakes belonging to matches that are over.
        if let Err(err) = settle_orphaned_entries(&pool, &mut accounts).await {
            tracing::error!(
                ?err,
                "could not settle entries left in escrow by a previous run"
            );
        }

        while let Some(request) = rx.recv().await {
            // Timed, because this is the wait between a player dying and
            // being allowed back in, and it is a wait over the internet to a
            // managed database rather than anything this process controls.
            // A number in the log is the difference between knowing that and
            // guessing at it.
            let started = std::time::Instant::now();
            let what = request.describe();
            let outcome = handle(
                &pool,
                &game,
                &mut accounts,
                grant,
                wallet.as_deref(),
                request,
            )
            .await;
            // Escrow is deliberately not read back here. Several matches run
            // at once, so the one number a player cares about is what is
            // staked on *their* match - which the lobby knows exactly, from
            // who is still in it holding a stake. A server-wide escrow total
            // would be the sum over every table and would mean nothing on a
            // scoreboard. `reconcile` still watches the account for drift,
            // which is what that figure is actually for, and this is one
            // fewer round trip on the path between a player dying and being
            // let back in.
            let elapsed_ms = started.elapsed().as_millis();
            if elapsed_ms > SLOW_EVENT_MS {
                tracing::warn!(what, elapsed_ms, "a money event was slow");
            } else {
                tracing::debug!(what, elapsed_ms, "money event settled");
            }
            if let Err(err) = outcome {
                // Logged loudly and not retried here. A retry loop against a
                // database that is refusing us would hammer it; the keys make
                // a later replay safe, and the reconciliation check on
                // `/health` is what notices if something never landed.
                tracing::error!(?err, "a money event failed to post");
            }
        }
    });

    LedgerHandle { requests: tx }
}

async fn handle(
    pool: &PgPool,
    game: &GameHandle,
    accounts: &mut Accounts,
    grant: Option<MicroUsd>,
    wallet: Option<&Notify>,
    request: LedgerRequest,
) -> Result<()> {
    match request {
        LedgerRequest::BuyMatch {
            match_id,
            stakes,
            players,
        } => {
            let funded = buy_match(pool, accounts, stakes, match_id, &players, grant).await?;
            game.send(GameCommand::MatchFunded {
                match_id,
                paid: funded.paid,
                balances: funded.balances,
            })
            .await;
            Ok(())
        }
        LedgerRequest::SettleKill { entry, killer } => {
            settle_kill(pool, accounts, entry, killer).await?;
            // The killer has just been paid, and being told so is most of the
            // point of playing. One extra read, on an event that happens a
            // handful of times a match rather than sixty-four times a second.
            let balance = balance(pool, killer).await.unwrap_or(MicroUsd::ZERO);
            game.send(GameCommand::BalanceChanged {
                player_id: killer,
                balance_micro_usd: balance.micros(),
            })
            .await;
            Ok(())
        }
        LedgerRequest::ReadBalance { player_id } => {
            // Creates the account if this is the first time we have seen
            // them, so a brand new player is told zero rather than nothing.
            let (balance, withdrawals) = read_wallet(pool, accounts, player_id).await?;
            game.send(GameCommand::BalanceChanged {
                player_id,
                balance_micro_usd: balance.micros(),
            })
            .await;
            for row in withdrawals {
                game.send(GameCommand::Tell {
                    player_id,
                    message: row.message(),
                })
                .await;
            }
            Ok(())
        }
        LedgerRequest::Withdraw {
            id,
            player_id,
            quote,
        } => {
            match request_withdrawal(pool, accounts, id, player_id, &quote).await? {
                Ok((row, left)) => {
                    tracing::info!(
                        %id, %player_id, amount = %quote.amount, to = %quote.destination,
                        "withdrawal taken out of the wallet"
                    );
                    game.send(GameCommand::BalanceChanged {
                        player_id,
                        balance_micro_usd: left.micros(),
                    })
                    .await;
                    game.send(GameCommand::Tell {
                        player_id,
                        message: row.message(),
                    })
                    .await;
                    if let Some(wallet) = wallet {
                        wallet.notify_one();
                    }
                }
                Err(reason) => {
                    game.send(GameCommand::Tell {
                        player_id,
                        message: ServerMsg::WithdrawalRefused { reason },
                    })
                    .await;
                }
            }
            Ok(())
        }
        LedgerRequest::AbandonEntry { entry } => {
            abandon_entry(pool, accounts, entry).await?;
            let balance = balance(pool, entry.player_id)
                .await
                .unwrap_or(MicroUsd::ZERO);
            game.send(GameCommand::BalanceChanged {
                player_id: entry.player_id,
                balance_micro_usd: balance.micros(),
            })
            .await;
            Ok(())
        }
        LedgerRequest::RefundEntry { entry } => {
            refund_entry(pool, accounts, entry).await?;
            let balance = balance(pool, entry.player_id)
                .await
                .unwrap_or(MicroUsd::ZERO);
            game.send(GameCommand::BalanceChanged {
                player_id: entry.player_id,
                balance_micro_usd: balance.micros(),
            })
            .await;
            Ok(())
        }
    }
}

/// The player's balance account, creating the player and the account if this
/// is the first time we have seen them.
///
/// `ON CONFLICT DO NOTHING` rather than a read-then-write: two connections for
/// the same player can race here, and the unique index on one balance account
/// per player is what decides it rather than whichever read happened first.
async fn balance_account(
    pool: &PgPool,
    accounts: &mut Accounts,
    player_id: PlayerId,
) -> Result<Uuid> {
    // Known already means created already, and - because the grant is issued
    // on the way through here the first time - granted already too.
    if let Some(account) = accounts.players.get(&player_id) {
        return Ok(*account);
    }
    let id = player_id.as_uuid();
    sqlx::query("INSERT INTO players (id) VALUES ($1) ON CONFLICT (id) DO NOTHING")
        .bind(id)
        .execute(pool)
        .await
        .context("creating the player row")?;

    sqlx::query(
        "INSERT INTO ledger_accounts (kind, player_id) VALUES ('player_balance', $1)
         ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .execute(pool)
    .await
    .context("creating the player's balance account")?;

    let account: Uuid = sqlx::query_scalar(
        "SELECT id FROM ledger_accounts WHERE kind = 'player_balance' AND player_id = $1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .context("finding the player's balance account")?;

    accounts.players.insert(player_id, account);
    Ok(account)
}

/// Development only. Funds everybody in a forming match who has never been
/// funded before, in one transaction.
///
/// Keyed on the match, because that is what makes it one transaction. Who it
/// covers is decided by asking which of these players has never had a grant
/// posted for them, which is the check that keeps it once per player.
///
/// Two matches forming at the same instant could in principle each decide to
/// fund the same brand new player and grant them twice. That is development
/// money on a development server and the log says so loudly; it is called out
/// here so nobody mistakes it for a rule that holds.
async fn grant_match(
    pool: &PgPool,
    accounts: &mut Accounts,
    match_id: MatchId,
    ids: &[Uuid],
    amount: MicroUsd,
) -> Result<()> {
    let fresh: Vec<Uuid> = sqlx::query_scalar(
        "SELECT a.player_id
           FROM ledger_accounts a
          WHERE a.kind = 'player_balance'
            AND a.player_id = ANY($1::uuid[])
            AND NOT EXISTS (
                SELECT 1 FROM ledger_entries e
                 WHERE e.account_id = a.id AND e.amount_micro_usd > 0
            )",
    )
    .bind(ids)
    .fetch_all(pool)
    .await
    .context("looking for players who have never been funded")?;

    if fresh.is_empty() {
        return Ok(());
    }
    let external = system_account(pool, accounts, "external").await?;
    let accounts_of: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM ledger_accounts
          WHERE kind = 'player_balance' AND player_id = ANY($1::uuid[])",
    )
    .bind(&fresh)
    .fetch_all(pool)
    .await
    .context("finding accounts to fund")?;

    let mut legs: Vec<(Uuid, i64)> = accounts_of
        .iter()
        .map(|account| (*account, amount.micros()))
        .collect();
    legs.push((external, -amount.micros() * accounts_of.len() as i64));

    if post(pool, "deposit", &format!("dev-grant:{match_id}"), &legs).await? {
        tracing::info!(count = accounts_of.len(), %amount, "development grants issued");
    }
    Ok(())
}

async fn system_account(
    pool: &PgPool,
    accounts: &mut Accounts,
    kind: &'static str,
) -> Result<Uuid> {
    if let Some(id) = accounts.system.get(kind) {
        return Ok(*id);
    }
    let id: Uuid =
        sqlx::query_scalar("SELECT id FROM ledger_accounts WHERE kind = $1::ledger_account_kind")
            .bind(kind)
            .fetch_one(pool)
            .await
            .with_context(|| format!("finding the {kind} account"))?;
    accounts.system.insert(kind, id);
    Ok(id)
}

/// Post one transaction, all legs, inside one explicit database transaction.
///
/// Returns false when the key has already been used, which is a success: it
/// means this exact money event has already happened and must not happen
/// again. Any other failure is an error.
///
/// Takes any executor rather than the pool, so a withdrawal can post its legs
/// and update its own row inside one database transaction: the books and the
/// work queue then cannot disagree about where a withdrawal has got to. The
/// statement is the same either way, and it is the statement `./x ledger`
/// tests.
async fn post<'e, E>(executor: E, kind: &str, key: &str, legs: &[(Uuid, i64)]) -> Result<bool>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    // One statement, and therefore one transaction. Every leg is inside it,
    // which is what the deferred sum-to-zero check requires: a leg posted on
    // its own is its own transaction, and the database rejects it.
    //
    // It used to be a `BEGIN`, a row per leg and a `COMMIT`, which is the
    // same guarantee and four more round trips. That reads as a
    // micro-optimisation and is not: measured against a managed Postgres,
    // a money event took six seconds, essentially all of it latency, and
    // those six seconds are a player sitting dead waiting to be told they
    // may come back. What is under test here is the books, and the books do
    // not care how many packets it took.
    //
    // If the key has been used, the `t` CTE returns no row, the `SELECT`
    // that feeds the entries has nothing to join against, and nothing is
    // inserted - which is the replay being ignored rather than a second
    // payout.
    let transaction_id: Uuid = Uuid::new_v4();
    let accounts: Vec<Uuid> = legs.iter().map(|(account, _)| *account).collect();
    let amounts: Vec<i64> = legs.iter().map(|(_, amount)| *amount).collect();

    let posted = sqlx::query(
        "WITH t AS (
             INSERT INTO ledger_transactions (id, kind, idempotency_key)
             VALUES ($1, $2::ledger_transaction_kind, $3)
             ON CONFLICT (idempotency_key) DO NOTHING
             RETURNING id
         )
         INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_usd)
         SELECT t.id, leg.account, leg.amount
           FROM t, UNNEST($4::uuid[], $5::bigint[]) AS leg(account, amount)",
    )
    .bind(transaction_id)
    .bind(kind)
    .bind(key)
    .bind(&accounts)
    .bind(&amounts)
    .execute(executor)
    .await
    .context("posting a money event")?;

    if posted.rows_affected() == 0 {
        tracing::debug!(key, "money event already posted; ignoring the replay");
        return Ok(false);
    }
    Ok(true)
}

/// Who got into a match, and what they have left.
pub struct Funded {
    /// Everybody whose stake is now in escrow. The lobby puts exactly these
    /// players on the map.
    pub paid: Vec<PlayerId>,
    /// Every player who was asked about, and their balance afterwards.
    pub balances: Vec<(PlayerId, i64)>,
}

/// Take a whole match's entry fees and hold them in escrow, in one
/// transaction.
///
/// Three round trips for a match of any size, rather than ten per player.
/// That is not a micro-optimisation: measured against a managed Postgres, a
/// thirteen player match could not collect its fees inside the time it was
/// willing to wait to form, and started with six.
///
/// Players who cannot afford it are left out and the rest still play. The
/// alternative - failing the whole transaction - would let one broke player
/// stop a match for everybody else.
async fn buy_match(
    pool: &PgPool,
    accounts: &mut Accounts,
    stakes: Stakes,
    match_id: MatchId,
    players: &[PlayerId],
    grant: Option<MicroUsd>,
) -> Result<Funded> {
    let escrow = system_account(pool, accounts, "match_escrow").await?;
    let ids: Vec<Uuid> = players.iter().map(|p| p.as_uuid()).collect();

    // One statement each rather than one per player. The `players` insert has
    // to land before the accounts one, because the account references it.
    sqlx::query("INSERT INTO players (id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING")
        .bind(&ids)
        .execute(pool)
        .await
        .context("creating player rows")?;
    sqlx::query(
        "INSERT INTO ledger_accounts (kind, player_id)
         SELECT 'player_balance', unnest($1::uuid[]) ON CONFLICT DO NOTHING",
    )
    .bind(&ids)
    .execute(pool)
    .await
    .context("creating balance accounts")?;

    if let Some(amount) = grant {
        grant_match(pool, accounts, match_id, &ids, amount).await?;
    }

    // Account id and balance together, for everybody at once.
    let rows: Vec<(Uuid, Uuid, i64)> = sqlx::query_as(
        "SELECT a.player_id, a.id, COALESCE(b.balance_micro_usd, 0)
           FROM ledger_accounts a
           LEFT JOIN ledger_account_balances b ON b.account_id = a.id
          WHERE a.kind = 'player_balance' AND a.player_id = ANY($1::uuid[])",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await
    .context("reading balances")?;

    // Checked before posting rather than letting the overdraw constraint
    // refuse it. The constraint is the guarantee; this is so that "you cannot
    // afford this table" comes back as an answer the game can act on instead
    // of an error indistinguishable from the database being down.
    let fee = stakes.entry().micros();
    let mut legs: Vec<(Uuid, i64)> = Vec::with_capacity(rows.len() + 1);
    let mut paid = Vec::new();
    let mut balances = Vec::new();
    let mut taken = 0i64;
    for (player, account, held) in &rows {
        let player_id = PlayerId::from(*player);
        accounts.players.insert(player_id, *account);
        if *held >= fee {
            legs.push((*account, -fee));
            paid.push(player_id);
            taken += fee;
            balances.push((player_id, held - fee));
        } else {
            balances.push((player_id, *held));
        }
    }

    if paid.is_empty() {
        return Ok(Funded { paid, balances });
    }
    legs.push((escrow, taken));

    // The transaction kind stays `life_purchase`: it is what the migration
    // named the escrow-in leg, and renaming a value in an enum the journal
    // already references is a migration to buy nothing. The key names the
    // match, and the key is what the code reads back.
    post(pool, "life_purchase", &match_key(match_id), &legs).await?;
    tracing::info!(
        %match_id, players = paid.len(), stake = %stakes.entry(), "match entry fees taken"
    );
    Ok(Funded { paid, balances })
}

/// Whether this entry fee is actually in escrow.
///
/// Settling an entry that was never bought would take a fee out of escrow
/// that somebody else put there. It can happen honestly: a player whose
/// purchase was refused for want of funds is still a player, and the world
/// still asks for them to be settled when they leave. The purchase and the
/// settlement go through the same queue in order, so by the time this is
/// asked the purchase has already succeeded or failed, and the journal is
/// the record of which.
async fn escrowed_for(pool: &PgPool, entry: EntryId) -> Result<Option<Stakes>> {
    // The player's own leg of their match's purchase: negative, because it
    // came out of their balance. Reading it rather than being told the tier
    // is what stops a settlement disagreeing with its own purchase.
    let micros: Option<i64> = sqlx::query_scalar(
        "SELECT -e.amount_micro_usd
           FROM ledger_transactions t
           JOIN ledger_entries e ON e.transaction_id = t.id
           JOIN ledger_accounts a ON a.id = e.account_id
          WHERE t.idempotency_key = $1
            AND a.kind = 'player_balance'
            AND a.player_id = $2",
    )
    .bind(match_key(entry.match_id))
    .bind(entry.player_id.as_uuid())
    .fetch_optional(pool)
    .await
    .context("looking up a stake in a match")?;

    let Some(micros) = micros else {
        return Ok(None);
    };
    match Stakes::from_micros(micros) {
        Some(stakes) => Ok(Some(stakes)),
        None => {
            // A stake that does not divide into a reward and a rake. It
            // cannot have been posted by this code, so it is left alone
            // rather than guessed at: the one thing worse than money stuck in
            // escrow is money taken out of it for the wrong reason.
            tracing::error!(
                player = %entry.player_id, micros,
                "an escrowed stake this server cannot split; leaving it alone"
            );
            Ok(None)
        }
    }
}

/// The player was killed, and the player who killed them gets paid.
async fn settle_kill(
    pool: &PgPool,
    accounts: &mut Accounts,
    entry: EntryId,
    killer: PlayerId,
) -> Result<()> {
    let Some(stakes) = escrowed_for(pool, entry).await? else {
        tracing::warn!(player = %entry.player_id, "a kill on an entry nobody paid for; nothing to settle");
        return Ok(());
    };
    let escrow = system_account(pool, accounts, "match_escrow").await?;
    let platform = system_account(pool, accounts, "platform_revenue").await?;
    // No grant here. A killer being paid is not a new player being funded,
    // and a grant issued at settlement time would be money appearing in the
    // middle of somebody else's transaction.
    let winner = balance_account(pool, accounts, killer).await?;

    if !post(
        pool,
        "kill_settlement",
        &entry.key("kill"),
        &[
            (escrow, -stakes.entry().micros()),
            (winner, stakes.reward().micros()),
            (platform, stakes.rake().micros()),
        ],
    )
    .await?
    {
        return Ok(());
    }
    tracing::info!(
        victim = %entry.player_id, %killer, reward = %stakes.reward(), "kill settled"
    );
    Ok(())
}

/// The player left the table with nobody to credit.
///
/// They get the reward back and we keep the rake - the same split a kill
/// makes, with the player themself in the killer's place. Anybody who shot
/// them before the resume window closed would have claimed the stake
/// properly, and that settles as a kill instead.
///
/// Not a refund and not a confiscation. Taking the whole stake would punish a
/// dropped connection far harder than losing a fight does; returning the
/// whole stake would make pulling the cable a free exit from a fight that is
/// going badly.
async fn abandon_entry(pool: &PgPool, accounts: &mut Accounts, entry: EntryId) -> Result<()> {
    let Some(stakes) = escrowed_for(pool, entry).await? else {
        // Never paid for - the purchase was refused and the player left.
        // There is nothing of theirs in escrow, and taking a fee out of it
        // would be taking somebody else's.
        tracing::debug!(player = %entry.player_id, "nothing in escrow to settle");
        return Ok(());
    };
    let escrow = system_account(pool, accounts, "match_escrow").await?;
    let platform = system_account(pool, accounts, "platform_revenue").await?;
    let account = balance_account(pool, accounts, entry.player_id).await?;

    if !post(
        pool,
        "forfeit_settlement",
        &entry.key("forfeit"),
        &[
            (escrow, -stakes.entry().micros()),
            (account, stakes.reward().micros()),
            (platform, stakes.rake().micros()),
        ],
    )
    .await?
    {
        return Ok(());
    }
    tracing::info!(
        player = %entry.player_id,
        returned = %stakes.reward(),
        "left the match; stake returned less the rake"
    );
    Ok(())
}

/// The player was still standing when the clock ran out, so they keep their
/// stake.
///
/// Not the same event as a forfeit and deliberately not the same kind in the
/// journal. A forfeit is somebody leaving the table; this is the table
/// closing with them still at it, and nobody having won their dollar.
async fn refund_entry(pool: &PgPool, accounts: &mut Accounts, entry: EntryId) -> Result<()> {
    let Some(stakes) = escrowed_for(pool, entry).await? else {
        tracing::debug!(player = %entry.player_id, "nothing in escrow to refund");
        return Ok(());
    };
    let escrow = system_account(pool, accounts, "match_escrow").await?;
    let account = balance_account(pool, accounts, entry.player_id).await?;

    if !post(
        pool,
        "entry_refund",
        &entry.key("refund"),
        &[
            (escrow, -stakes.entry().micros()),
            (account, stakes.entry().micros()),
        ],
    )
    .await?
    {
        return Ok(());
    }
    tracing::info!(player = %entry.player_id, "survived the match; entry returned");
    Ok(())
}

/// Settle every entry left in escrow by a server that is no longer running.
///
/// Escrow holds one entry fee per player in a running match, and a match
/// belongs to a running process. When that process stops - a deploy, a crash,
/// a container killed - the match goes with it and the stakes stay behind: a
/// dollar per player who happened to be alive at the time, sitting in an
/// account that is supposed to empty as fast as it fills.
///
/// They are settled the way a player who walks away is settled - the reward
/// back to them, the rake to us - because that is what a server going away
/// is from the player's side: everybody disconnected at once. A full refund
/// is what surviving to the whistle earns, and a match cut short did not
/// reach one.
///
/// **This assumes one server owns the escrow account.** A second instance
/// starting up would sweep the first one's live escrow out from under it and
/// forfeit entries that are still being played. Running more than one will
/// need an escrow account per instance, or a lease on this sweep; until then,
/// the check is that there is one.
async fn settle_orphaned_entries(pool: &PgPool, accounts: &mut Accounts) -> Result<()> {
    // A match's purchase is keyed `entry:<match>`, and it has one leg per
    // player who bought in. The three things that can end one player's stake
    // are keyed `kill:`, `forfeit:` and `refund:` on `<match>:<player>`. So
    // an outstanding stake is a purchase leg with none of its endings posted.
    //
    // Per leg rather than per transaction, because a match settles player by
    // player: by the time a process dies, some of its stakes have been won
    // and some have not.
    //
    // `substr(key, 7)` drops the six characters of `entry:`.
    //
    // Only keys of exactly that shape - `entry:` and one match id. Two
    // earlier generations of this code bought one life at a time, as
    // `life:<player>:<n>` and then `entry:<player>:<n>`, and settled each
    // under the same `<player>:<n>`. Those are not this sweep's to judge:
    // read as `entry:<match>` they name no match, and every one of them was
    // reported on every startup as an unrecognised stake, when all but one
    // had long since been settled.
    let outstanding: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT substr(t.idempotency_key, 7), a.player_id
           FROM ledger_transactions t
           JOIN ledger_entries e ON e.transaction_id = t.id
           JOIN ledger_accounts a ON a.id = e.account_id
          WHERE t.kind = 'life_purchase'
            AND t.idempotency_key ~ '^entry:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND a.kind = 'player_balance'
            AND NOT EXISTS (
                SELECT 1 FROM ledger_transactions s
                 WHERE s.idempotency_key IN (
                    'kill:'    || substr(t.idempotency_key, 7) || ':' || a.player_id,
                    'forfeit:' || substr(t.idempotency_key, 7) || ':' || a.player_id,
                    'refund:'  || substr(t.idempotency_key, 7) || ':' || a.player_id
                 )
            )",
    )
    .fetch_all(pool)
    .await
    .context("looking for stakes left in escrow")?;

    if outstanding.is_empty() {
        return Ok(());
    }
    tracing::warn!(
        count = outstanding.len(),
        "settling stakes left in escrow by a previous run"
    );

    for (match_key, player) in outstanding {
        let Ok(match_id) = Uuid::parse_str(&match_key) else {
            // A key this server did not write. Left alone rather than
            // guessed at: the one thing worse than money stuck in escrow is
            // money taken out of it for the wrong reason.
            tracing::error!(key = %match_key, "an escrowed stake with a key this server does not recognise");
            continue;
        };
        abandon_entry(
            pool,
            accounts,
            EntryId {
                match_id: MatchId::from(match_id),
                player_id: PlayerId::from(player),
            },
        )
        .await?;
    }
    Ok(())
}

/// A player's balance, and the status of any review that holds their
/// withdrawals - open or confirmed - in one round trip.
pub(crate) async fn balance_and_review(
    pool: &PgPool,
    player_id: PlayerId,
) -> Result<(MicroUsd, Option<String>)> {
    let (micros, review): (Option<i64>, Option<String>) = sqlx::query_as(
        "SELECT (SELECT b.balance_micro_usd
                   FROM ledger_accounts a
                   JOIN ledger_account_balances b ON b.account_id = a.id
                  WHERE a.kind = 'player_balance' AND a.player_id = $1),
                (SELECT r.status::text
                   FROM reviews r
                  WHERE r.player_id = $1 AND r.status IN ('open', 'confirmed')
                  ORDER BY r.status = 'confirmed' DESC
                  LIMIT 1)",
    )
    .bind(player_id.as_uuid())
    .fetch_one(pool)
    .await
    .context("reading a balance and any review")?;
    Ok((MicroUsd(micros.unwrap_or(0)), review))
}

/// What a player could withdraw right now.
pub async fn balance(pool: &PgPool, player_id: PlayerId) -> Result<MicroUsd> {
    let micros: Option<i64> = sqlx::query_scalar(
        "SELECT b.balance_micro_usd
           FROM ledger_accounts a
           JOIN ledger_account_balances b ON b.account_id = a.id
          WHERE a.kind = 'player_balance' AND a.player_id = $1",
    )
    .bind(player_id.as_uuid())
    .fetch_optional(pool)
    .await
    .context("reading a balance")?;
    Ok(MicroUsd(micros.unwrap_or(0)))
}

/// Everything the platform owes somebody: every player balance, every stake
/// in escrow, and every withdrawal taken out of a wallet and not yet final.
///
/// Set against the treasury on `/health`. Not a reconciliation - the rate is
/// configured, not real - but a treasury that falls below this is one that
/// could not pay everybody out at the price it is quoting.
pub async fn owed(pool: &PgPool) -> Result<MicroUsd> {
    let micros: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(b.balance_micro_usd), 0)::bigint
           FROM ledger_accounts a
           JOIN ledger_account_balances b ON b.account_id = a.id
          WHERE a.kind IN ('player_balance', 'match_escrow', 'treasury')",
    )
    .fetch_one(pool)
    .await
    .context("adding up what is owed")?;
    Ok(MicroUsd(micros))
}

/// Everything currently staked in matches in progress.
///
/// This is the pot, and it is a sum over the ledger rather than a count of
/// players times the entry fee. Those agree only while every player has
/// exactly one stake in and nothing has been settled, which stops being true
/// the moment somebody dies.
pub async fn escrow_total(pool: &PgPool) -> Result<MicroUsd> {
    let micros: i64 = sqlx::query_scalar(
        "SELECT COALESCE(b.balance_micro_usd, 0)
           FROM ledger_accounts a
           LEFT JOIN ledger_account_balances b ON b.account_id = a.id
          WHERE a.kind = 'match_escrow'",
    )
    .fetch_one(pool)
    .await
    .context("reading the pot")?;
    if micros < 0 {
        bail!("escrow is negative, which means a stake was settled twice");
    }
    Ok(MicroUsd(micros))
}

// ---------------------------------------------------------------------------
// The chain's half of the books.
//
// Everything below is called by `wallet.rs`, except `request_withdrawal`,
// which runs on this module's own queue. Each posts its legs and records what
// it did inside one database transaction, and each is keyed so that doing it
// twice does it once.
// ---------------------------------------------------------------------------

/// What the wallet made of one transaction touching the treasury.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReceiptOutcome {
    Credited,
    Unmatched,
    TooSmall,
    NotIncoming,
}

impl ReceiptOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Credited => "credited",
            Self::Unmatched => "unmatched",
            Self::TooSmall => "too_small",
            Self::NotIncoming => "not_incoming",
        }
    }
}

/// One transaction touching the treasury, judged.
#[derive(Debug, Clone)]
pub(crate) struct Receipt {
    pub signature: String,
    pub lamports: u64,
    pub memo: Option<String>,
    /// Who it was credited to. `Some` exactly when it was.
    pub player_id: Option<PlayerId>,
    pub micro_usd: i64,
    pub micro_usd_per_sol: i64,
    pub outcome: ReceiptOutcome,
    /// Seconds since the epoch, when the chain says.
    pub block_time: Option<i64>,
}

/// Record a judged transaction, crediting it if it is a deposit.
///
/// Answers whether money moved just now. A signature already credited - by an
/// earlier pass that died before recording it - posts nothing, because the
/// ledger key is the signature.
pub(crate) async fn record_receipt(
    pool: &PgPool,
    accounts: &mut Accounts,
    receipt: &Receipt,
) -> Result<bool> {
    let insert = sqlx::query(
        "INSERT INTO treasury_receipts
             (signature, lamports, memo, player_id, micro_usd, micro_usd_per_sol, outcome, block_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::bigint))
         ON CONFLICT (signature) DO NOTHING",
    )
    .bind(&receipt.signature)
    .bind(receipt.lamports as i64)
    .bind(&receipt.memo)
    .bind(receipt.player_id.map(PlayerId::as_uuid))
    .bind(receipt.micro_usd)
    .bind(receipt.micro_usd_per_sol)
    .bind(receipt.outcome.as_str())
    .bind(receipt.block_time);

    let (ReceiptOutcome::Credited, Some(player_id)) = (receipt.outcome, receipt.player_id) else {
        insert
            .execute(pool)
            .await
            .context("recording a treasury transaction")?;
        return Ok(false);
    };

    let account = balance_account(pool, accounts, player_id).await?;
    let external = system_account(pool, accounts, "external").await?;
    let mut tx = pool.begin().await.context("starting a deposit")?;
    let posted = post(
        &mut *tx,
        "deposit",
        &format!("deposit:{}", receipt.signature),
        &[(external, -receipt.micro_usd), (account, receipt.micro_usd)],
    )
    .await?;
    insert
        .execute(&mut *tx)
        .await
        .context("recording a deposit")?;
    tx.commit().await.context("committing a deposit")?;
    Ok(posted)
}

/// One withdrawal, as the work queue holds it.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct WithdrawalRow {
    pub id: Uuid,
    pub player_id: Uuid,
    pub destination: String,
    pub amount_micro_usd: i64,
    pub lamports: i64,
    pub status: String,
    pub signature: Option<String>,
    pub signed_transaction: Option<String>,
    pub last_valid_block_height: Option<i64>,
    pub reason: Option<String>,
}

/// A `SELECT` of every [`WithdrawalRow`] column, followed by the rest of the
/// query. A macro rather than `format!` so the statement stays a string
/// constant, which is what sqlx insists a query be.
macro_rules! select_withdrawals {
    ($rest:literal) => {
        concat!(
            "SELECT id, player_id, destination, amount_micro_usd, lamports, ",
            "status::text AS status, signature, signed_transaction, ",
            "last_valid_block_height, reason FROM withdrawals ",
            $rest
        )
    };
}

/// Withdrawals at one step of their way out, oldest first.
pub(crate) async fn withdrawals_in(pool: &PgPool, status: &str) -> Result<Vec<WithdrawalRow>> {
    sqlx::query_as(select_withdrawals!(
        "WHERE status = $1::withdrawal_status ORDER BY created_at LIMIT 50"
    ))
    .bind(status)
    .fetch_all(pool)
    .await
    .with_context(|| format!("reading {status} withdrawals"))
}

/// A player's last few withdrawals, oldest first, for the menu.
async fn recent_withdrawals(pool: &PgPool, player_id: PlayerId) -> Result<Vec<WithdrawalRow>> {
    let mut rows: Vec<WithdrawalRow> = sqlx::query_as(select_withdrawals!(
        "WHERE player_id = $1 ORDER BY created_at DESC LIMIT 5"
    ))
    .bind(player_id.as_uuid())
    .fetch_all(pool)
    .await
    .context("reading a player's withdrawals")?;
    rows.reverse();
    Ok(rows)
}

/// Everything the menu shows about a player's wallet, in one statement: their
/// balance account (made if this is the first time we have seen them), the
/// balance, and their last few withdrawals, oldest first.
///
/// One statement because every player who arrives asks for this, on the
/// ledger's one sequential queue, and every statement is round trips. Against
/// a database half a second away the five separate statements this replaced
/// held the queue for five to seven seconds per arrival, so thirteen people
/// arriving together kept a match's buy-in waiting past `FORMING_TIMEOUT` and
/// the match dissolved with nobody in it.
///
/// A data-modifying CTE does not see its own inserts, so the account comes
/// from `made` when it is new and from the table when it is not. The one case
/// where neither answers is a concurrent insert of the same account committing
/// mid-statement; that falls back to the step-by-step path, which sees it.
async fn read_wallet(
    pool: &PgPool,
    accounts: &mut Accounts,
    player_id: PlayerId,
) -> Result<(MicroUsd, Vec<WithdrawalRow>)> {
    use sqlx::Row;

    let rows = sqlx::query(
        "WITH player AS (
             INSERT INTO players (id) VALUES ($1) ON CONFLICT (id) DO NOTHING
         ),
         made AS (
             INSERT INTO ledger_accounts (kind, player_id) VALUES ('player_balance', $1)
             ON CONFLICT DO NOTHING
             RETURNING id
         ),
         account AS (
             SELECT id FROM made
             UNION ALL
             SELECT id FROM ledger_accounts WHERE kind = 'player_balance' AND player_id = $1
         )
         SELECT a.id AS account_id,
                COALESCE(b.balance_micro_usd, 0)::bigint AS balance_micro_usd,
                w.id, w.player_id, w.destination, w.amount_micro_usd, w.lamports,
                w.status, w.signature, w.signed_transaction,
                w.last_valid_block_height, w.reason
           FROM account a
           LEFT JOIN ledger_account_balances b ON b.account_id = a.id
           LEFT JOIN LATERAL (
               SELECT id, player_id, destination, amount_micro_usd, lamports,
                      status::text AS status, signature, signed_transaction,
                      last_valid_block_height, reason, created_at
                 FROM withdrawals
                WHERE player_id = $1
                ORDER BY created_at DESC
                LIMIT 5
           ) w ON true
          ORDER BY w.created_at",
    )
    .bind(player_id.as_uuid())
    .fetch_all(pool)
    .await
    .context("reading a player's wallet")?;

    let Some(first) = rows.first() else {
        balance_account(pool, accounts, player_id).await?;
        let balance = balance(pool, player_id).await?;
        return Ok((balance, recent_withdrawals(pool, player_id).await?));
    };
    accounts
        .players
        .insert(player_id, first.try_get("account_id")?);
    let balance = MicroUsd(first.try_get("balance_micro_usd")?);

    let mut withdrawals = Vec::new();
    for row in &rows {
        let Some(id) = row.try_get::<Option<Uuid>, _>("id")? else {
            continue;
        };
        withdrawals.push(WithdrawalRow {
            id,
            player_id: row.try_get("player_id")?,
            destination: row.try_get("destination")?,
            amount_micro_usd: row.try_get("amount_micro_usd")?,
            lamports: row.try_get("lamports")?,
            status: row.try_get("status")?,
            signature: row.try_get("signature")?,
            signed_transaction: row.try_get("signed_transaction")?,
            last_valid_block_height: row.try_get("last_valid_block_height")?,
            reason: row.try_get("reason")?,
        });
    }
    Ok((balance, withdrawals))
}

/// Take a withdrawal out of the player's balance and put it on the queue.
///
/// The money leaves their reach here, before anything is signed: it cannot
/// be staked or withdrawn a second time while the transfer is in flight.
/// `treasury` holds it until the chain answers.
///
/// The outer `Result` is the database; the inner one is the player's answer.
async fn request_withdrawal(
    pool: &PgPool,
    accounts: &mut Accounts,
    id: WithdrawalId,
    player_id: PlayerId,
    quote: &Quote,
) -> Result<std::result::Result<(WithdrawalRow, MicroUsd), String>> {
    let account = balance_account(pool, accounts, player_id).await?;
    let treasury = system_account(pool, accounts, "treasury").await?;

    // Checked first, as a buy-in is, so "not enough" is an answer the player
    // can read rather than an overdraw error from the trigger. The trigger is
    // still the guarantee.
    //
    // A review is read in the same statement. While one is open the
    // anti-cheat has asked a person to look at this player's record, and a
    // payout is exactly what that look is meant to come before; once one is
    // confirmed, the answer was cheating. Either way nothing leaves for the
    // chain, and nothing leaves the balance either - it stays playable.
    let (held, review) = balance_and_review(pool, player_id).await?;
    if let Some(status) = review {
        return Ok(Err(match status.as_str() {
            "confirmed" => "withdrawals are closed on this account after a review".to_string(),
            _ => "your recent matches are being reviewed; withdrawals open again when that \
                  is done, and your balance is untouched meanwhile"
                .to_string(),
        }));
    }
    if held < quote.amount {
        return Ok(Err(format!(
            "you have {held}, which is less than {}",
            quote.amount
        )));
    }

    let row = WithdrawalRow {
        id: id.as_uuid(),
        player_id: player_id.as_uuid(),
        destination: quote.destination.to_string(),
        amount_micro_usd: quote.amount.micros(),
        lamports: quote.lamports as i64,
        status: "requested".to_string(),
        signature: None,
        signed_transaction: None,
        last_valid_block_height: None,
        reason: None,
    };

    let mut tx = pool.begin().await.context("starting a withdrawal")?;
    sqlx::query(
        "INSERT INTO withdrawals
             (id, player_id, destination, amount_micro_usd, lamports, micro_usd_per_sol)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(row.id)
    .bind(row.player_id)
    .bind(&row.destination)
    .bind(row.amount_micro_usd)
    .bind(row.lamports)
    .bind(quote.rate.micro_usd())
    .execute(&mut *tx)
    .await
    .context("queueing a withdrawal")?;
    if !post(
        &mut *tx,
        "withdrawal",
        &format!("withdraw:{id}"),
        &[
            (account, -quote.amount.micros()),
            (treasury, quote.amount.micros()),
        ],
    )
    .await?
    {
        bail!("withdrawal {id} was already posted");
    }
    tx.commit().await.context("committing a withdrawal")?;
    Ok(Ok((row, held - quote.amount)))
}

/// A withdrawal is final on chain: the money has left us.
///
/// Answers false if it had already been settled or returned, in which case
/// nothing is posted.
pub(crate) async fn settle_withdrawal(
    pool: &PgPool,
    accounts: &mut Accounts,
    row: &WithdrawalRow,
) -> Result<bool> {
    let treasury = system_account(pool, accounts, "treasury").await?;
    let external = system_account(pool, accounts, "external").await?;
    let mut tx = pool.begin().await.context("starting a settlement")?;
    let moved = sqlx::query(
        "UPDATE withdrawals SET status = 'settled', updated_at = now()
          WHERE id = $1 AND status = 'sent'",
    )
    .bind(row.id)
    .execute(&mut *tx)
    .await
    .context("settling a withdrawal")?;
    if moved.rows_affected() == 0 {
        return Ok(false);
    }
    post(
        &mut *tx,
        "withdrawal_sent",
        &format!("withdrawn:{}", row.id),
        &[
            (treasury, -row.amount_micro_usd),
            (external, row.amount_micro_usd),
        ],
    )
    .await?;
    tx.commit().await.context("committing a settlement")?;
    Ok(true)
}

/// A withdrawal will never land: the money goes back to the player.
///
/// Answers false if it had already been settled or returned.
pub(crate) async fn return_withdrawal(
    pool: &PgPool,
    accounts: &mut Accounts,
    row: &WithdrawalRow,
    reason: &str,
) -> Result<bool> {
    let account = balance_account(pool, accounts, PlayerId::from(row.player_id)).await?;
    let treasury = system_account(pool, accounts, "treasury").await?;
    let mut tx = pool.begin().await.context("starting a return")?;
    let moved = sqlx::query(
        "UPDATE withdrawals SET status = 'returned', reason = $2, updated_at = now()
          WHERE id = $1 AND status IN ('requested', 'sent')",
    )
    .bind(row.id)
    .bind(reason)
    .execute(&mut *tx)
    .await
    .context("returning a withdrawal")?;
    if moved.rows_affected() == 0 {
        return Ok(false);
    }
    post(
        &mut *tx,
        "withdrawal_returned",
        &format!("withdraw-returned:{}", row.id),
        &[
            (treasury, -row.amount_micro_usd),
            (account, row.amount_micro_usd),
        ],
    )
    .await?;
    tx.commit().await.context("committing a return")?;
    Ok(true)
}

/// How many withdrawals are between the wallet and the chain.
///
/// Asked at startup, so a server that has lost its wallet configuration says
/// that it is sitting on somebody's money rather than quietly holding it.
pub async fn withdrawals_in_flight(pool: &PgPool) -> Result<i64> {
    sqlx::query_scalar("SELECT count(*) FROM withdrawals WHERE status IN ('requested', 'sent')")
        .fetch_one(pool)
        .await
        .context("counting withdrawals in flight")
}

#[cfg(test)]
mod review_hold {
    use super::*;
    use crate::wallet::{Quote, SolUsd};
    use solatel_protocol::ids::WithdrawalId;

    /// Against a real Postgres: an open review refuses a withdrawal and
    /// leaves the balance where it was, a cleared one lets it through, and a
    /// confirmed one shuts it again.
    ///
    /// Ignored by default because it needs a database. Run it with
    /// `DATABASE_URL=... cargo test -p solatel-server -- --ignored review_hold`.
    /// It posts a test deposit to a player of its own and returns the one
    /// withdrawal it makes, so it leaves nothing in flight.
    #[tokio::test]
    #[ignore = "needs a Postgres at DATABASE_URL"]
    async fn a_review_holds_a_withdrawal_and_nothing_else() {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let pool = crate::db::connect(&url).await.unwrap();
        crate::db::migrate(&pool).await.unwrap();
        let mut accounts = Accounts::default();

        let player = PlayerId::new();
        let account = balance_account(&pool, &mut accounts, player).await.unwrap();
        let external = system_account(&pool, &mut accounts, "external").await.unwrap();
        let ten = MicroUsd::from_usd(10).micros();
        assert!(
            post(
                &pool,
                "deposit",
                &format!("test-deposit:{player}"),
                &[(external, -ten), (account, ten)],
            )
            .await
            .unwrap()
        );

        let rate = SolUsd::parse("140").unwrap();
        let quote = Quote {
            amount: MicroUsd::from_usd(5),
            lamports: rate.lamports_for(MicroUsd::from_usd(5).micros()),
            destination: crate::solana::Address::parse(
                "5du3i7LTZa3dNPdG6Hthzo5v2ACL9yDKkpAgKe2CuUk2",
            )
            .unwrap(),
            rate,
        };

        sqlx::query(
            "INSERT INTO reviews (player_id, reasons, evidence)
             VALUES ($1, ARRAY['accuracy'], '{}'::jsonb)",
        )
        .bind(player.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
        let refused =
            request_withdrawal(&pool, &mut accounts, WithdrawalId::new(), player, &quote)
                .await
                .unwrap();
        assert!(
            matches!(&refused, Err(reason) if reason.contains("reviewed")),
            "an open review should refuse the withdrawal: {refused:?}"
        );
        assert_eq!(
            balance(&pool, player).await.unwrap(),
            MicroUsd::from_usd(10),
            "a held withdrawal takes nothing out of the balance"
        );

        sqlx::query(
            "UPDATE reviews SET status = 'cleared', decided_by = 'test',
                    note = 'nothing wrong', decided_at = now()
              WHERE player_id = $1",
        )
        .bind(player.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
        let (row, left) =
            request_withdrawal(&pool, &mut accounts, WithdrawalId::new(), player, &quote)
                .await
                .unwrap()
                .expect("a cleared review should let the withdrawal through");
        assert_eq!(left, MicroUsd::from_usd(5));
        assert!(return_withdrawal(&pool, &mut accounts, &row, "test").await.unwrap());
        assert_eq!(balance(&pool, player).await.unwrap(), MicroUsd::from_usd(10));

        sqlx::query(
            "INSERT INTO reviews (player_id, reasons, evidence, status, decided_by, note, decided_at)
             VALUES ($1, ARRAY['snaps'], '{}'::jsonb, 'confirmed', 'test', 'aimbot', now())",
        )
        .bind(player.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
        let shut = request_withdrawal(&pool, &mut accounts, WithdrawalId::new(), player, &quote)
            .await
            .unwrap();
        assert!(
            matches!(&shut, Err(reason) if reason.contains("closed")),
            "a confirmed review should keep withdrawals shut: {shut:?}"
        );
    }
}
