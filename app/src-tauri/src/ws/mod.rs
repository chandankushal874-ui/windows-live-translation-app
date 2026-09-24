//! ws/mod.rs Ã¢â‚¬â€ relay WebSocket client.
//!
//! One socket per call, to our own relay. Frames:
//!
//!   Client Ã¢â€ â€™ server
//!     { "type": "join", "token": "...", "room": "ABC12", "displayName": "..." }
//!     <binary PCM frame> Ã¢â‚¬â€ 16kHz mono s16le
//!     { "type": "leave" } | { "type": "ping" }
//!
//!   Server Ã¢â€ â€™ client
//!     { "type": "joined", ... } | { "type": "peer-joined", ... } | ...
//!     { "type": "audio", from, lang }  then a binary frame with the audio
//!     { "type": "caption", kind, from, payload }
//!     { "type": "error", code, message }
//!
//! Outbound writes go through an unbounded mpsc Ã¢â€ â€™ single writer task, so the
//! audio capture callback never awaits the network.
//!
//! Auto-reconnect with exponential backoff. The audio RX channel is owned
//! by RelaySocket and stays stable across reconnects Ã¢â‚¬â€ the read task writes
//! into it; the playback task reads from it.

pub mod session;
pub use session::mint_session_via_relay;

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex, Notify};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::protocol::{resolve_joined_waiter, reject_joined_waiter, ServerEvent};

const MAX_RECONNECT_ATTEMPTS: u32 = 8;
const INITIAL_BACKOFF_MS: u64 = 250;

#[derive(Debug, Clone)]
pub struct RelaySocketConfig {
    pub ws_url: String,
    pub token: String,
    pub room_code: Option<String>,
    pub display_name: String,
    pub captions_on: bool,
}

#[derive(Clone)]
pub struct RelaySocket {
    inner: Arc<RelayInner>,
}

struct RelayInner {
    cfg: RelaySocketConfig,
    app: AppHandle,
    /// Outbound queue. Replaced on reconnect; send_pcm clones the current sender.
    out_tx: Mutex<mpsc::UnboundedSender<Message>>,
    /// Stable inbound-audio queue. Sender is swapped on reconnect; receiver lives forever.
    audio_in_tx: Mutex<mpsc::UnboundedSender<Vec<u8>>>,
    audio_out_rx: Mutex<mpsc::UnboundedReceiver<Vec<u8>>>,
    shutdown: AtomicBool,
    reconnecting: AtomicBool,
    reconnect_notify: Notify,
}

impl RelaySocket {
    pub async fn connect(cfg: RelaySocketConfig, app: AppHandle) -> Result<Self> {
        // Stable audio channel: receiver lives for the lifetime of the socket handle.
        let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        // Provisional out_tx; replaced after first open_socket call.
        let (out_tx, _drop_rx) = mpsc::unbounded_channel::<Message>();

        let inner = Arc::new(RelayInner {
            cfg,
            app,
            out_tx: Mutex::new(out_tx),
            audio_in_tx: Mutex::new(audio_tx),
            audio_out_rx: Mutex::new(audio_rx),
            shutdown: AtomicBool::new(false),
            reconnecting: AtomicBool::new(false),
            reconnect_notify: Notify::new(),
        });

        Self::open_socket(inner.clone())
            .await
            .context("initial relay connect")?;

        Ok(Self { inner })
    }

    /// Establish the WebSocket and spawn read/write tasks.
    /// Called once at connect() and again from the reconnect loop.
    async fn open_socket(inner: Arc<RelayInner>) -> Result<()> {
        let url = url::Url::parse(&inner.cfg.ws_url).context("parse relay ws url")?;
        tracing::info!(%url, "connecting to relay");

        let (ws_stream, _resp) = connect_async(url.as_str())
            .await
            .context("relay ws handshake")?;

        let (mut write_half, mut read_half) = ws_stream.split();

        // Swap outbound sender so any buffered frames drain into the new socket.
        let (new_out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
        *inner.out_tx.lock().await = new_out_tx.clone();

        // Initial join frame Ã¢â‚¬â€ written directly, not via queue.
        let join = serde_json::json!({
            "type": "join",
            "token": inner.cfg.token,
            "room": inner.cfg.room_code,
            "displayName": inner.cfg.display_name,
            "captionsOn": inner.cfg.captions_on,
        });
        write_half
            .send(Message::Text(join.to_string()))
            .await
            .context("send join frame")?;

        // Writer task Ã¢â‚¬â€ drains out_rx into the new write_half.
        let inner_w = inner.clone();
        tokio::spawn(async move {
            while let Some(msg) = out_rx.recv().await {
                if inner_w.shutdown.load(Ordering::Relaxed) { break; }
                if write_half.send(msg).await.is_err() {
                    tracing::warn!("relay ws write failed");
                    break;
                }
            }
            tracing::debug!("writer task exited");
        });

        // Reader task. Uses the *stable* audio_in_tx so playback is undisturbed.
        let inner_r = inner.clone();
        tokio::spawn(async move {
            let mut expect_audio = false;
            while let Some(msg) = read_half.next().await {
                let msg = match msg {
                    Ok(m) => m,
                    Err(e) => {
                        let _ = inner_r.app.emit("relay-error", e.to_string());
                        break;
                    }
                };
                match msg {
                    Message::Binary(b) => {
                        if expect_audio {
                            expect_audio = false;
                            let tx = inner_r.audio_in_tx.lock().await;
                            let _ = tx.send(b);
                        } else {
                            tracing::debug!("binary w/o header Ã¢â‚¬â€ dropped");
                        }
                    }
                    Message::Text(t) => {
                        match serde_json::from_str::<ServerEvent>(&t) {
                            Ok(ev @ ServerEvent::Audio { end_of_utterance, has_binary, .. }) => {
                                let is_marker = end_of_utterance.unwrap_or(false);
                                let carries_binary = has_binary.unwrap_or(!is_marker);
                                if carries_binary {
                                    expect_audio = true;
                                }
                                let _ = inner_r.app.emit("relay-event", ev);
                            }
                            Ok(ev @ ServerEvent::Joined { .. }) => {
                                resolve_joined_waiter(
                                    "joined",
                                    serde_json::to_value(&ev).unwrap_or(serde_json::Value::Null),
                                );
                                let _ = inner_r.app.emit("relay-event", ev);
                            }
                            Ok(ServerEvent::Error { code, message }) => {
                                reject_joined_waiter("joined", format!("{code}: {message}"));
                                let _ = inner_r.app.emit("relay-event", ServerEvent::Error { code, message });
                            }
                            Ok(ev) => {
                                let _ = inner_r.app.emit("relay-event", ev);
                            }
                            Err(_) => {
                                tracing::debug!(text=%t, "unrecognised frame");
                            }
                        }
                    }
                    Message::Ping(_) | Message::Pong(_) => {}
                    Message::Close(frame) => {
                        let _ = inner_r.app.emit(
                            "relay-closed",
                            serde_json::json!({ "frame": frame.map(|f| f.reason.to_string()) }),
                        );
                        // Cancel any pending joined waiters so start_call fails fast
                        // instead of timing out at 5 s (F22).
                        crate::protocol::cancel_all_joined_waiters();
                        break;
                    }
                    _ => {}
                }
            }
            tracing::debug!("reader task exited");

            // Reader exited = connection is gone. Trigger reconnect if not deliberate.
            if !inner_r.shutdown.load(Ordering::Relaxed) {
                Self::spawn_reconnect(inner_r.clone());
            }
        });

        Ok(())
    }

    /// Spawns a reconnect task if one isn't already running (guarded by `reconnecting`).
    fn spawn_reconnect(inner: Arc<RelayInner>) {
        // Guard: only one reconnect loop at a time.
        if inner.reconnecting.swap(true, Ordering::SeqCst) {
            return;
        }
        tokio::spawn(async move {
            let mut attempt = 0u32;
            loop {
                if inner.shutdown.load(Ordering::Relaxed) {
                    inner.reconnecting.store(false, Ordering::SeqCst);
                    return;
                }
                attempt += 1;
                if attempt > MAX_RECONNECT_ATTEMPTS {
                    let _ = inner.app.emit(
                        "relay-error",
                        format!("reconnect failed after {MAX_RECONNECT_ATTEMPTS} attempts"),
                    );
                    inner.reconnecting.store(false, Ordering::SeqCst);
                    return;
                }
                let backoff_ms = INITIAL_BACKOFF_MS * 2u64.pow((attempt - 1).min(6));
                tracing::info!(backoff_ms, attempt, "reconnecting to relay");
                let _ = inner.app.emit(
                    "relay-reconnecting",
                    serde_json::json!({ "attempt": attempt, "backoff_ms": backoff_ms }),
                );
                tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;

                match Self::open_socket(inner.clone()).await {
                    Ok(()) => {
                        tracing::info!("reconnected to relay");
                        let _ = inner.app.emit("relay-reconnected", serde_json::json!({}));
                        inner.reconnect_notify.notify_waiters();
                        inner.reconnecting.store(false, Ordering::SeqCst);
                        return;
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, attempt, "reconnect attempt failed");
                    }
                }
            }
        });
    }

    pub async fn send_pcm(&self, bytes: &[u8]) -> Result<()> {
        let tx = self.inner.out_tx.lock().await.clone();
        tx.send(Message::Binary(bytes.to_vec()))
            .map_err(|e| anyhow!("relay send closed: {e}"))
    }

    pub async fn send_json(&self, v: serde_json::Value) -> Result<()> {
        let tx = self.inner.out_tx.lock().await.clone();
        tx.send(Message::Text(v.to_string()))
            .map_err(|e| anyhow!("relay send closed: {e}"))
    }

    pub async fn close(&self) {
        self.inner.shutdown.store(true, Ordering::Relaxed);
        let tx = self.inner.out_tx.lock().await.clone();
        let _ = tx.send(Message::Text(
            serde_json::json!({ "type": "leave" }).to_string(),
        ));
        let _ = tx.send(Message::Close(None));
    }

    /// Await the next inbound audio frame.
    pub async fn next_inbound_audio(&self) -> Option<Vec<u8>> {
        let mut guard = self.inner.audio_out_rx.lock().await;
        guard.recv().await
    }

    #[allow(dead_code)]
    pub async fn wait_reconnect(&self) {
        self.inner.reconnect_notify.notified().await;
    }

    pub async fn wait_for_joined(&self, timeout_ms: u64) -> Result<serde_json::Value> {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<serde_json::Value, String>>();
        crate::protocol::register_joined_waiter("joined", tx);

        let timeout = tokio::time::sleep(std::time::Duration::from_millis(timeout_ms));
        tokio::select! {
            _ = timeout => Err(anyhow!("wait_for_joined timed out after {timeout_ms} ms")),
            res = rx => match res {
                Ok(Ok(val)) => Ok(val),
                Ok(Err(err_msg)) => Err(anyhow!("{err_msg}")),
                Err(_) => Err(anyhow!("wait_for_joined waiter dropped")),
            },
        }
    }
}

