//! Solatel game server.
//!
//! Authoritative over movement, hits, and money. The client is treated as an
//! untrusted source of *inputs* and never as a source of *facts*.

mod account;
mod config;
mod db;
mod game;
mod ledger;
mod reconcile;
mod solana;
mod tick;
mod wallet;
mod ws;

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    response::IntoResponse,
    routing::get,
};
use config::Config;
use game::GameHandle;
use reconcile::LedgerHealthHandle;
use serde_json::json;
use solatel_protocol::{PROTOCOL_VERSION, TICK_HZ};
use sqlx::PgPool;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer, trace::TraceLayer};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    /// The tables this server runs. Sent in the handshake, because the
    /// price is the server's to state and not the client's to assume.
    pub tiers: Vec<solatel_protocol::Stakes>,
    /// Deposits and withdrawals, as offered in the handshake. `None` when no
    /// chain is configured.
    pub wallet: Option<wallet::Terms>,
    wallet_health: Option<wallet::WalletHealth>,
    started_at: Instant,
    sessions: Arc<AtomicU64>,
    ledger_health: LedgerHealthHandle,
    game: GameHandle,
}

impl AppState {
    /// Monotonic milliseconds since boot. Sent to clients as a shared reference
    /// point for latency estimation; deliberately not wall-clock time.
    pub fn uptime_ms(&self) -> f64 {
        self.started_at.elapsed().as_secs_f64() * 1000.0
    }

    pub fn session_count(&self) -> u64 {
        self.sessions.load(Ordering::Relaxed)
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "solatel_server=debug,tower_http=info,info".into()),
        )
        .init();

    // `solatel-server treasury` sets the chain side up and then stops. It is
    // a subcommand rather than a second binary because everything it needs -
    // the keypair, the cluster, the RPC - is this crate's, and a second
    // binary would mean making the server a library to share them.
    match std::env::args().nth(1).as_deref() {
        Some("treasury") => return treasury_setup().await,
        Some("pay") => {
            let args: Vec<String> = std::env::args().skip(2).collect();
            return dev_pay(&args).await;
        }
        _ => {}
    }

    let config = Config::from_env()?;

    // Every map, all the time. There is no server-wide map any more: a match
    // carries its own, several run at once on different ground, and which one
    // a player ends up on is the table they picked in the menu.
    let maps: Vec<&str> = solatel_protocol::sim::map::MAPS
        .iter()
        .map(|map| map.name)
        .collect();

    tracing::info!(
        ?config.bind_addr,
        web_dir = ?config.web_dir,
        ?maps,
        "starting solatel-server"
    );
    for map in solatel_protocol::sim::map::MAPS {
        tracing::info!(
            map = map.name,
            brushes = map.brushes.len(),
            spawns = map.spawns.len(),
            seats = map.max_players,
            "map ready"
        );
    }

    let pool = db::connect(&config.database_url).await?;
    db::migrate(&pool).await?;

    let ledger_health = reconcile::spawn(pool.clone());

    // Which tables this server runs. All of them by default: one process
    // holds every match, at every stake, which is what keeps the escrow
    // sweep's "one server owns escrow" assumption true. `SOLATEL_TIERS`
    // narrows it, which is useful for a test server that should only offer
    // the cheap table.
    let tiers: Vec<solatel_protocol::Stakes> = match std::env::var("SOLATEL_TIERS") {
        Ok(raw) => {
            let mut chosen = Vec::new();
            for field in raw.split(',').map(str::trim).filter(|f| !f.is_empty()) {
                let dollars: i64 = field
                    .parse()
                    .with_context(|| format!("SOLATEL_TIERS {field:?} is not a whole number"))?;
                let stakes = solatel_protocol::Stakes::from_usd(dollars).with_context(|| {
                    format!("${dollars} does not divide into a reward and a rake")
                })?;
                if !solatel_protocol::TIERS.contains(&dollars) {
                    anyhow::bail!(
                        "SOLATEL_TIERS names ${dollars}; this build runs {:?}",
                        solatel_protocol::TIERS
                    );
                }
                chosen.push(stakes);
            }
            if chosen.is_empty() {
                anyhow::bail!("SOLATEL_TIERS is set but names no tables");
            }
            chosen
        }
        Err(_) => solatel_protocol::TIERS
            .iter()
            .map(|dollars| {
                solatel_protocol::Stakes::from_usd(*dollars)
                    .expect("a listed tier is buildable, which is asserted at compile time")
            })
            .collect(),
    };

    // Fewest players a match will start with once its window is up. Four by
    // default; below that a match is one or two people on a map built for
    // twenty or thirty. One is for a server being tested by one person, and
    // says so in the log.
    let floor: usize = match std::env::var("SOLATEL_MATCH_FLOOR") {
        Ok(raw) => raw
            .trim()
            .parse()
            .with_context(|| format!("SOLATEL_MATCH_FLOOR {raw:?} is not a number"))?,
        Err(_) => 4,
    };
    if floor < 2 {
        tracing::warn!(
            "SOLATEL_MATCH_FLOOR is {floor}; matches will start with nobody to play against"
        );
    }

    // How long a line waits before starting short of a full table.
    let wait: f32 = match std::env::var("SOLATEL_QUEUE_WAIT") {
        Ok(raw) => raw
            .trim()
            .parse()
            .with_context(|| format!("SOLATEL_QUEUE_WAIT {raw:?} is not a number of seconds"))?,
        Err(_) => 120.0,
    };
    tracing::info!(
        floor,
        wait_seconds = wait,
        "a match starts when the table fills, or after the window with at least the floor"
    );

    // Paid unless asked otherwise. A server that quietly ran for free would
    // look exactly like one that was working, right up until somebody asked
    // where their money went, so free play has to be stated out loud.
    let free_play = std::env::var("SOLATEL_FREE_PLAY").as_deref() == Ok("1");

    // The chain side of the wallet: both halves configured or neither, and
    // nothing at all in free play, where there is no money to move.
    let wallet = if free_play {
        None
    } else {
        wallet::Wallet::from_env(ledger::dev_grant().is_some())?
    };
    if wallet.is_none() {
        tracing::info!("no wallet configured; deposits and withdrawals are off");
        // Somebody's money is parked in `treasury` waiting for a chain this
        // server can no longer see. It is safe there, and it is not moving.
        match ledger::withdrawals_in_flight(&pool).await {
            Ok(0) => {}
            Ok(count) => tracing::warn!(
                count,
                "withdrawals are waiting for the chain and this server has no wallet to send them"
            ),
            Err(err) => tracing::warn!(?err, "could not count withdrawals in flight"),
        }
    }

    let (game, commands) = game::channel();
    let wake = std::sync::Arc::new(tokio::sync::Notify::new());
    let ledger = if free_play {
        tracing::warn!(
            "SOLATEL_FREE_PLAY is set; lives cost nothing and kills pay nothing. Never set this in production."
        );
        None
    } else {
        Some(ledger::spawn(
            pool.clone(),
            game.clone(),
            tiers.clone(),
            wallet.as_ref().map(|_| wake.clone()),
        ))
    };
    let terms = wallet.as_ref().map(|w| w.terms.clone());
    game::spawn(commands, ledger, terms.clone(), tiers.clone(), floor, wait);
    let wallet_health = wallet.map(|w| wallet::spawn(w, pool.clone(), game.clone(), wake));

    let state = AppState {
        pool,
        tiers,
        wallet: terms,
        wallet_health,
        started_at: Instant::now(),
        sessions: Arc::new(AtomicU64::new(0)),
        ledger_health,
        game,
    };

    tick::spawn(state.clone());

    // The client is served from this same origin, so the websocket needs no
    // CORS handling and no cross-origin cookie story.
    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws::handler))
        .fallback_service(ServeDir::new(&config.web_dir).append_index_html_on_directories(true))
        // The client bundle is tens of megabytes and changes on every build.
        // Without this the browser happily serves a cached copy after a
        // rebuild, which turns "did that fix land?" into a guessing game.
        // Launch will want real cache busting via content-hashed filenames;
        // until then, correctness beats the round trip.
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store, must-revalidate"),
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(config.bind_addr)
        .await
        .with_context(|| format!("binding {}", config.bind_addr))?;

    tracing::info!("listening on http://{}", config.bind_addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let db_ok = db::ping(&state.pool).await.is_ok();
    // Reconciliation scans the whole journal, so this reports the result of the
    // background check rather than running one per request.
    let ledger = state.ledger_health.get();
    // What is staked across every table right now.
    //
    // An operator's number rather than a player's: a player is shown what is
    // on their own match, which the lobby knows exactly. This is the sum over
    // all of them, and an escrow account that stops emptying is the first
    // sign that a settlement has stopped happening.
    let escrow = ledger::escrow_total(&state.pool).await.ok();

    // The treasury against what is owed, as of the wallet's last pass.
    let wallet = state
        .wallet_health
        .as_ref()
        .map(|health| match health.get() {
            Some(s) => json!({
                "treasury_lamports": s.treasury_lamports,
                "treasury_micro_usd": s.treasury_micro_usd,
                "owed_micro_usd": s.owed_micro_usd,
                "micro_usd_per_sol": s.micro_usd_per_sol,
            }),
            None => json!({ "checked": false }),
        });

    let healthy = db_ok && ledger.reconciles;
    let status = if healthy {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (
        status,
        Json(json!({
            "status": if healthy { "ok" } else { "degraded" },
            "database": db_ok,
            "ledger_reconciles": ledger.reconciles,
            "ledger_checked_seconds_ago": ledger.checked_seconds_ago(),
            "ledger_error": ledger.error,
            "escrow_micro_usd": escrow.map(|amount| amount.micros()),
            "wallet": wallet,
            "tiers": state.tiers.iter().map(|s| s.dollars()).collect::<Vec<_>>(),
            "protocol_version": PROTOCOL_VERSION,
            "tick_hz": TICK_HZ,
            "sessions": state.session_count(),
            "uptime_ms": state.uptime_ms(),
        })),
    )
}

/// Set up, or look at, the devnet treasury.
///
/// Prints the secret exactly once, when it makes one. There is nowhere safe
/// for this server to put a secret on its own - not the repository, not the
/// database it is the custodian of - so it hands it over and says where it
/// goes. On devnet the money is free; the habit is what matters.
async fn treasury_setup() -> Result<()> {
    let rpc = solana::Rpc::new(solana::Cluster::devnet())?;

    let treasury = match std::env::var("SOLATEL_TREASURY_KEY") {
        Ok(secret) if !secret.trim().is_empty() => {
            let treasury = solana::Treasury::from_base58(&secret)?;
            println!("treasury: {} (from SOLATEL_TREASURY_KEY)", treasury.address);
            treasury
        }
        _ => {
            let (treasury, secret) = solana::Treasury::generate()?;
            println!("A new devnet treasury. Put this in .env and keep it out of git:");
            println!();
            println!("SOLATEL_TREASURY_KEY={secret}");
            println!();
            println!("treasury: {}", treasury.address);
            treasury
        }
    };

    let before = rpc.balance(treasury.address).await?;
    println!(
        "balance:  {} SOL",
        before as f64 / solana::LAMPORTS_PER_SOL as f64
    );

    // Two SOL is what the devnet faucet will part with in one go on a good
    // day, and it is plenty: a withdrawal on a dollar table is a fraction of
    // one. A refusal here is the faucet being rate limited, not a fault.
    if before < solana::LAMPORTS_PER_SOL {
        println!("asking the devnet faucet for 2 SOL…");
        match rpc
            .airdrop(treasury.address, 2 * solana::LAMPORTS_PER_SOL)
            .await
        {
            Ok(signature) => {
                println!("  {signature}");
                for _ in 0..30 {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    let now = rpc.balance(treasury.address).await.unwrap_or(before);
                    if now > before {
                        println!(
                            "balance:  {} SOL",
                            now as f64 / solana::LAMPORTS_PER_SOL as f64
                        );
                        return Ok(());
                    }
                }
                println!("  the airdrop has not landed yet; check again in a minute");
            }
            Err(err) => println!("  the faucet refused: {err}"),
        }
    }
    Ok(())
}

/// Send SOL to the treasury from a development payer, with a memo.
///
/// `./x pay` with no arguments sets the payer up. `./x pay <memo> <sol>`
/// sends a deposit, which is the thing most consumer wallets cannot do: a
/// memo is how this server knows whose money arrived, and the usual send
/// screen has nowhere to type one.
///
/// Devnet only, like everything here, and deliberately a separate key from
/// the treasury - a deposit the treasury paid itself would gain it nothing
/// but the fee, and the watcher would rightly credit nobody.
async fn dev_pay(args: &[String]) -> Result<()> {
    let rpc = solana::Rpc::new(solana::Cluster::devnet())?;

    let payer = match std::env::var("SOLATEL_DEV_PAYER_KEY") {
        Ok(secret) if !secret.trim().is_empty() => solana::Treasury::from_base58(&secret)?,
        _ => {
            let (payer, secret) = solana::Treasury::generate()?;
            println!("A new devnet payer. Put this in .env and keep it out of git:");
            println!();
            println!("SOLATEL_DEV_PAYER_KEY={secret}");
            println!();
            println!("payer: {}", payer.address);
            println!(
                "Fund it at https://faucet.solana.com (devnet), then run ./x pay <memo> <sol>."
            );
            match rpc.airdrop(payer.address, solana::LAMPORTS_PER_SOL).await {
                Ok(signature) => println!("asked the faucet for 1 SOL: {signature}"),
                Err(err) => println!("the faucet refused: {err}"),
            }
            return Ok(());
        }
    };

    let balance = rpc.balance(payer.address).await?;
    println!(
        "payer:   {} ({} SOL)",
        payer.address,
        wallet::sol_text(balance)
    );

    let [memo, sol] = args else {
        println!("usage: ./x pay <memo> <sol>   - the memo is the player id the menu shows");
        return Ok(());
    };
    let lamports = wallet::parse_decimal(sol, 9)
        .and_then(|n| u64::try_from(n).ok())
        .filter(|n| *n > 0)
        .with_context(|| format!("{sol:?} is not an amount of SOL"))?;

    let secret = std::env::var("SOLATEL_TREASURY_KEY")
        .context("SOLATEL_TREASURY_KEY is not set, so there is no treasury to pay")?;
    let treasury = solana::Treasury::from_base58(&secret)?.address;

    let signed = rpc
        .sign_transfer(&payer, treasury, lamports, Some(memo))
        .await?;
    rpc.send(&signed.wire_base64).await?;
    println!(
        "sent {} SOL to {treasury} with memo {memo:?}",
        wallet::sol_text(lamports)
    );
    println!("  {}", signed.signature);
    println!(
        "  https://explorer.solana.com/tx/{}?cluster=devnet",
        signed.signature
    );
    println!("The server credits it once it is final - about fifteen seconds.");
    Ok(())
}

async fn shutdown_signal() {
    if let Err(err) = tokio::signal::ctrl_c().await {
        tracing::error!(%err, "failed to listen for shutdown signal");
        return;
    }
    tracing::info!("shutdown signal received");
}
