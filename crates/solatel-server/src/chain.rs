//! What a page needs from the chain to build a deposit, asked of the server.
//!
//! A deposit from a connected wallet is a transaction the page builds and the
//! wallet signs and sends, and it needs a recent blockhash to be built on.
//! The page asks here rather than asking the cluster, so the cluster's
//! endpoint stays the server's: a production RPC is a paid one with a key in
//! its address, and a key in the page is a key in everybody's hands.
//!
//! Cached for a few seconds, so a room full of players depositing at once
//! costs the RPC one call rather than one each.

use crate::{
    AppState,
    solana::{self, Address, Rpc},
};
use std::collections::HashMap;
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

/// How long one answer is handed out.
const FRESH_FOR: Duration = Duration::from_secs(4);

/// The RPC, and the last blockhash it gave.
#[derive(Clone)]
pub struct Chain {
    rpc: Arc<Rpc>,
    cached: Arc<Mutex<Option<(Instant, Value)>>>,
}

impl Chain {
    pub fn new(rpc: Rpc) -> Self {
        Self {
            rpc: Arc::new(rpc),
            cached: Arc::default(),
        }
    }
}

/// `GET /chain/blockhash`: `{ blockhash, last_valid_block_height }`.
pub async fn blockhash(State(state): State<AppState>) -> Response {
    let Some(chain) = &state.chain else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut cached = chain.cached.lock().await;
    if let Some((at, value)) = cached.as_ref()
        && at.elapsed() < FRESH_FOR
    {
        return Json(value.clone()).into_response();
    }
    match chain.rpc.confirmed_blockhash().await {
        Ok((hash, last_valid)) => {
            let value = json!({
                "blockhash": bs58::encode(hash).into_string(),
                "last_valid_block_height": last_valid,
            });
            *cached = Some((Instant::now(), value.clone()));
            Json(value).into_response()
        }
        Err(err) => {
            tracing::warn!(?err, "no blockhash from the cluster");
            StatusCode::BAD_GATEWAY.into_response()
        }
    }
}

/// `GET /chain/usdc-account?owner=<address>`: the account that wallet holds
/// USDC in, which a USDC deposit is paid from. Derived here, where the curve
/// arithmetic already lives, rather than in the page.
pub async fn usdc_account(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if state.chain.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(owner) = params.get("owner").and_then(|o| Address::parse(o).ok()) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let derived = Address::parse(solana::USDC_DEVNET)
        .and_then(|mint| solana::associated_token_address(owner, mint));
    match derived {
        Ok(account) => Json(json!({ "address": account.to_string() })).into_response(),
        Err(err) => {
            tracing::warn!(?err, "no USDC account for an owner");
            StatusCode::BAD_REQUEST.into_response()
        }
    }
}
