//! Websocket session handling.
//!
//! A session owns one connection and translates it into [`GameCommand`]s. It
//! holds no game state of its own: the world is authoritative and lives in one
//! place.
//!
//! Every connection begins with a [`ClientMsg::Hello`] carrying the protocol
//! version. A mismatch is rejected outright rather than tolerated: a stale
//! cached wasm bundle that half-understands the protocol is exactly the kind of
//! thing that produces "the server said I missed" bug reports.

use crate::{AppState, game::GameCommand};
use anyhow::{Context, Result, anyhow, bail};
use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, Utf8Bytes, WebSocket},
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use solatel_protocol::{
    ClientMsg, PROTOCOL_VERSION, ServerMsg, SessionId,
    ids::{PlayerId, ResumeToken},
    net::{MAX_INPUTS_PER_MESSAGE, SNAPSHOT_HZ, TICK_HZ, decode, encode},
    sim::{
        map::{self, MAP_VERSION},
        sanitise_name,
    },
};
use std::{sync::atomic::Ordering, time::Duration};
use tokio::sync::{mpsc, oneshot};

/// A client that connects but never completes the handshake is dropped rather
/// than being allowed to hold a connection slot indefinitely.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Nothing the client sends is large. Anything bigger is either a bug or an
/// attempt to exhaust server memory.
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// Queue depth for messages heading to one client. Dropping is preferable to
/// letting a slow client apply back pressure to the world.
const OUTBOUND_CAPACITY: usize = 128;

/// How often the server measures this connection's round-trip time.
const RTT_PROBE_INTERVAL: Duration = Duration::from_secs(1);

pub async fn handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let session_id = SessionId::new();
            state.sessions.fetch_add(1, Ordering::Relaxed);

            match run_session(socket, &state, session_id).await {
                Ok(()) => tracing::info!(%session_id, "session closed cleanly"),
                Err(err) => tracing::info!(%session_id, error = %err, "session ended"),
            }

            state.sessions.fetch_sub(1, Ordering::Relaxed);
        })
}

async fn run_session(mut socket: WebSocket, state: &AppState, session_id: SessionId) -> Result<()> {
    let hello = read_hello(&mut socket, session_id).await?;

    // Who this is, before the lobby hears of them. A database round trip,
    // which is why it happens here in the connection's own task and not in
    // the lobby's loop, which must never wait on anything.
    let signed_in = match crate::account::sign_in(&state.pool, hello.account.as_deref()).await {
        Ok(signed_in) => signed_in,
        Err(err) => {
            reject(
                &mut socket,
                "the server could not sign you in; try again shortly",
            )
            .await;
            return Err(err);
        }
    };

    // The channel is made before the socket is split, because the world
    // starts writing into it the moment it accepts the join.
    let (outbound_tx, outbound_rx) = mpsc::channel::<ServerMsg>(OUTBOUND_CAPACITY);
    let (reply_tx, reply_rx) = oneshot::channel();
    // The world takes the name and uses it as given, including on a resume,
    // so this copy is what it settled on rather than a guess at it.
    let name = hello.name.clone();

    let joined = state
        .game
        .send(GameCommand::Join {
            session_id,
            account: Some(signed_in.player_id),
            name: hello.name,
            resume: hello.resume,
            outbound: outbound_tx,
            reply: reply_tx,
        })
        .await;
    if !joined {
        bail!("game world is not running");
    }
    let outcome = reply_rx.await.context("world dropped the join")?;
    let player_id = outcome.player_id;

    // Written straight down the socket rather than through the outbound
    // queue, and before the writer is started. The world may already have
    // pushed a snapshot in there - it inserted this player a moment ago -
    // and a client that received a snapshot before its welcome would be
    // drawing a world it has not been told the rules of.
    send(
        &mut socket,
        &ServerMsg::Welcome {
            session_id,
            player_id,
            name,
            resume_token: outcome.resume_token,
            resumed: outcome.resumed,
            tick_hz: TICK_HZ,
            snapshot_hz: SNAPSHOT_HZ,
            maps: map::MAPS
                .iter()
                .map(|m| solatel_protocol::net::MapInfo {
                    name: m.name.to_string(),
                    seats: m.max_players as u32,
                })
                .collect(),
            map_version: MAP_VERSION,
            server_time_ms: state.uptime_ms(),
            tiers: state
                .tiers
                .iter()
                .map(|stakes| solatel_protocol::net::Tier {
                    dollars: stakes.dollars(),
                    entry_fee_micro_usd: stakes.entry().micros(),
                    kill_reward_micro_usd: stakes.reward().micros(),
                })
                .collect(),
            account_key: signed_in.new_key,
            wallet: state.wallet.as_ref().map(|terms| terms.offer(player_id)),
        },
    )
    .await?;

    let (sink, mut stream) = socket.split();
    let writer = tokio::spawn(write_loop(sink, outbound_rx, state.clone()));

    let result = read_loop(&mut stream, state, session_id, player_id).await;

    state
        .game
        .send(GameCommand::Leave {
            player_id,
            session_id,
        })
        .await;
    writer.abort();

    result
}

/// Serialises outbound messages and probes the link's round-trip time.
///
/// The probe uses websocket-level ping frames, which browsers answer
/// automatically. That matters: the round-trip time decides how far the server
/// rewinds this player's shots, so it must be something the server measures
/// rather than something the client reports. A client that could inflate it
/// would be buying itself extra lag compensation.
async fn write_loop(
    mut sink: SplitSink<WebSocket, Message>,
    mut outbound: mpsc::Receiver<ServerMsg>,
    state: AppState,
) {
    let mut probe = tokio::time::interval(RTT_PROBE_INTERVAL);
    probe.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            message = outbound.recv() => {
                let Some(message) = message else { break };
                let Ok(wire) = encode(&message) else {
                    tracing::error!("failed to encode an outbound message");
                    continue;
                };
                if sink.send(Message::Text(Utf8Bytes::from(wire))).await.is_err() {
                    break;
                }
            }
            _ = probe.tick() => {
                // The send time travels in the payload, so a late reply is
                // measured correctly instead of against the newest probe.
                let now = state.uptime_ms().to_le_bytes().to_vec();
                if sink.send(Message::Ping(now.into())).await.is_err() {
                    break;
                }
            }
        }
    }
}

async fn read_loop(
    stream: &mut futures_util::stream::SplitStream<WebSocket>,
    state: &AppState,
    session_id: SessionId,
    player_id: PlayerId,
) -> Result<()> {
    while let Some(frame) = stream.next().await {
        let frame = frame.context("websocket receive failed")?;

        let text = match frame {
            Message::Text(text) => text,
            Message::Close(_) => break,
            Message::Pong(payload) => {
                if let Some(rtt_ms) = rtt_from_pong(&payload, state.uptime_ms()) {
                    state
                        .game
                        .send(GameCommand::RttSample { player_id, rtt_ms })
                        .await;
                }
                continue;
            }
            // Answered by the websocket layer.
            Message::Ping(_) => continue,
            // The protocol is text-only; see `solatel_protocol::net`.
            Message::Binary(_) => {
                tracing::debug!(%session_id, "binary frame from client");
                break;
            }
        };

        let msg = match decode::<ClientMsg>(text.as_str()) {
            Ok(msg) => msg,
            Err(err) => {
                tracing::debug!(%session_id, %err, "undecodable message");
                break;
            }
        };

        match msg {
            ClientMsg::Inputs { commands } => {
                if commands.len() > MAX_INPUTS_PER_MESSAGE {
                    tracing::debug!(
                        %session_id,
                        count = commands.len(),
                        "oversized input batch, truncating"
                    );
                }
                state
                    .game
                    .send(GameCommand::Inputs {
                        player_id,
                        session_id,
                        commands,
                    })
                    .await;
            }
            ClientMsg::Queue { map, tier_dollars } => {
                state
                    .game
                    .send(GameCommand::Queue {
                        player_id,
                        session_id,
                        map,
                        tier_dollars,
                    })
                    .await;
            }
            ClientMsg::LeaveQueue => {
                state
                    .game
                    .send(GameCommand::LeaveQueue {
                        player_id,
                        session_id,
                    })
                    .await;
            }
            ClientMsg::Withdraw {
                amount_micro_usd,
                destination,
            } => {
                state
                    .game
                    .send(GameCommand::Withdraw {
                        player_id,
                        session_id,
                        amount_micro_usd,
                        destination,
                    })
                    .await;
            }
            ClientMsg::Ping { .. } | ClientMsg::Echo { .. } => {
                // These are diagnostics that need a direct reply, which the
                // world task has no reason to be involved in.
                handle_diagnostic(state, player_id, msg).await;
            }
            ClientMsg::Hello { .. } => {
                tracing::debug!(%session_id, "duplicate hello");
                break;
            }
        }
    }

    Ok(())
}

/// Ping and Echo are answered through the player's own outbound queue, so they
/// stay ordered with respect to snapshots.
async fn handle_diagnostic(state: &AppState, player_id: PlayerId, msg: ClientMsg) {
    let reply = match msg {
        ClientMsg::Ping {
            seq,
            client_time_ms,
        } => ServerMsg::Pong {
            seq,
            client_time_ms,
            server_time_ms: state.uptime_ms(),
        },
        ClientMsg::Echo { payload } => ServerMsg::Echo { payload },
        _ => return,
    };
    state
        .game
        .send(GameCommand::Tell {
            player_id,
            message: reply,
        })
        .await;
}

fn rtt_from_pong(payload: &[u8], now_ms: f64) -> Option<f32> {
    let bytes: [u8; 8] = payload.try_into().ok()?;
    let sent_ms = f64::from_le_bytes(bytes);
    let rtt = now_ms - sent_ms;
    // A negative or absurd figure means the payload was not one of ours.
    (0.0..10_000.0).contains(&rtt).then_some(rtt as f32)
}

/// What the client asked for, once it has been checked and made safe.
struct Hello {
    name: String,
    resume: Option<ResumeToken>,
    account: Option<String>,
}

/// Reads and validates the opening message.
///
/// Does not reply. The `Welcome` cannot be written yet: it has to carry the
/// player id and the next resume token, and only the world knows whether this
/// connection is a new player or an old one coming back for their body.
async fn read_hello(socket: &mut WebSocket, session_id: SessionId) -> Result<Hello> {
    let frame = tokio::time::timeout(HANDSHAKE_TIMEOUT, socket.recv())
        .await
        .map_err(|_| anyhow!("handshake timed out"))?
        .ok_or_else(|| anyhow!("connection closed before handshake"))?
        .context("websocket receive failed")?;

    let Message::Text(text) = frame else {
        reject(socket, "expected a hello message").await;
        bail!("first frame was not text");
    };

    match decode::<ClientMsg>(text.as_str()) {
        Ok(ClientMsg::Hello {
            protocol_version,
            client_build,
            name,
            resume,
            account,
        }) => {
            if protocol_version != PROTOCOL_VERSION {
                let reason = format!(
                    "protocol version mismatch: server speaks {PROTOCOL_VERSION}, client sent {protocol_version}. Reload the page to pick up the current client."
                );
                reject(socket, &reason).await;
                bail!("{reason}");
            }

            // Sanitised at the edge, where the untrusted string arrives, so
            // nothing downstream ever holds a name that was not checked. The
            // fallback is derived from the session rather than being a
            // counter, because two connections racing to join would take the
            // same counter and appear as the same person.
            let fallback = format!("Player {:04x}", session_id.as_uuid().as_fields().0 & 0xffff);
            let name = sanitise_name(&name, &fallback);

            tracing::info!(%session_id, %client_build, %name, "hello accepted");
            Ok(Hello {
                name,
                resume,
                account,
            })
        }
        Ok(_) => {
            reject(socket, "expected hello as the first message").await;
            bail!("first message was not hello");
        }
        Err(err) => {
            reject(socket, "malformed hello").await;
            Err(err).context("decoding hello")
        }
    }
}

async fn send(socket: &mut WebSocket, msg: &ServerMsg) -> Result<()> {
    let wire = encode(msg).context("encoding server message")?;
    socket
        .send(Message::Text(Utf8Bytes::from(wire)))
        .await
        .context("websocket send failed")
}

/// Best-effort: tell the client why before hanging up. If the send fails the
/// connection is already gone, which is the same outcome.
async fn reject(socket: &mut WebSocket, reason: impl Into<String>) {
    let reason = reason.into();
    tracing::debug!(%reason, "rejecting session");
    let _ = send(socket, &ServerMsg::Rejected { reason }).await;
    let _ = socket.send(Message::Close(None)).await;
}
