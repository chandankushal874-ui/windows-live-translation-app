//! state.rs — application state and the call state machine.
//!
//! One CallSession exists at a time (v1). All mutations go through `AppState`
//! so Tauri commands can safely serialize state transitions.
//!
//! Lifecycle:
//!   start_call
//!     → mint_session (HTTP)
//!     → RelaySocket::connect
//!     → wait_for_joined (or fail)
//!     → AudioPipeline::start
//!     → spawn session-refresh task (renews the token before expiry)
//!     → transition to Active
//!   end_call / drop
//!     → stop audio
//!     → close relay
//!     → abort refresh task
//!     → transition to Idle

use anyhow::{anyhow, Context, Result};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::audio::{AudioPipeline, AudioPipelineConfig};
use crate::ws::{session::mint_session_via_relay, RelaySocket, RelaySocketConfig};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CallState {
    Idle,
    MintingSession,
    JoiningRoom,
    Active,
    Ending,
    Failed,
}

impl Default for CallState {
    fn default() -> Self { Self::Idle }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCredentials {
    pub token: String,
    pub ws_url: String,
    pub expires_at: u64,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallArgs {
    pub relay_url: String,
    pub room_code: Option<String>,
    pub display_name: String,
    pub source_lang: String,
    pub target_lang: String,
    pub input_device: Option<String>,
    pub output_device: Option<String>,
    pub captions_on: bool,
    pub credentials: SessionCredentials,
    #[serde(default)]
    pub voice: Option<String>,
    #[serde(default)]
    pub tone: Option<String>,
}

/// The pieces that must be shut down when a call ends, in order.
struct ActiveCall {
    relay: RelaySocket,
    audio: Arc<AudioPipeline>,
    refresh_task: JoinHandle<()>,
    _args: CallArgs,
    voice: Arc<RwLock<Option<String>>>,
    tone: Arc<RwLock<Option<String>>>,
    source_lang: Arc<RwLock<String>>,
    target_lang: Arc<RwLock<String>>,
}

pub struct AppState {
    app_handle: AppHandle,
    state: Arc<RwLock<CallState>>,
    active: Arc<Mutex<Option<ActiveCall>>>,
    input_volume: Arc<AtomicU32>, // f32 bits; 1.0 default
    mic_muted: Arc<AtomicBool>,
}

impl AppState {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            state: Arc::new(RwLock::new(CallState::Idle)),
            active: Arc::new(Mutex::new(None)),
            input_volume: Arc::new(AtomicU32::new(1.0f32.to_bits())),
            mic_muted: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn status(&self) -> CallState {
        *self.state.read()
    }

    pub fn set_mic_muted(&self, muted: bool) {
        self.mic_muted.store(muted, Ordering::Relaxed);
        if let Ok(guard) = self.active.try_lock() {
            if let Some(call) = guard.as_ref() {
                call.audio.set_mic_muted(muted);
            }
        }
    }

    pub fn set_input_volume(&self, v: f32) {
        let clamped = v.clamp(0.0, 2.0);
        self.input_volume.store(clamped.to_bits(), Ordering::Relaxed);
        if let Ok(guard) = self.active.try_lock() {
            if let Some(call) = guard.as_ref() {
                call.audio.set_input_gain(clamped);
            }
        }
    }

    pub async fn swap_input_device(&self, name: Option<String>) -> Result<()> {
        let guard = self.active.lock().await;
        match guard.as_ref() {
            Some(call) => call.audio.swap_input_device(name).await,
            None => Err(anyhow!("no active call")),
        }
    }

    /// Update voice persona and delivery tone mid-call.
    pub async fn update_voice_settings(
        &self,
        voice: Option<String>,
        tone: Option<String>,
    ) -> Result<()> {
        let guard = self.active.lock().await;
        match guard.as_ref() {
            Some(call) => {
                if voice.is_some() {
                    *call.voice.write() = voice.clone();
                }
                if tone.is_some() {
                    *call.tone.write() = tone.clone();
                }
                call.relay
                    .send_json(serde_json::json!({
                        "type": "update-voice-settings",
                        "voice": voice,
                        "tone": tone,
                    }))
                    .await
                    .context("send update-voice-settings")
            }
            None => Err(anyhow!("no active call")),
        }
    }

    pub async fn swap_output_device(&self, name: Option<String>) -> Result<()> {
        let guard = self.active.lock().await;
        match guard.as_ref() {
            Some(call) => call.audio.swap_output_device(name).await,
            None => Err(anyhow!("no active call")),
        }
    }

    /// Toggle captions: push to relay, which forwards to Ollalink's
    /// `enable_captions` in its session config (and gates the routing).
    pub async fn set_captions(&self, on: bool) -> Result<()> {
        let guard = self.active.lock().await;
        match guard.as_ref() {
            Some(call) => {
                call.relay
                    .send_json(serde_json::json!({ "type": "captions.set", "on": on }))
                    .await
                    .context("send captions.set")
            }
            None => Err(anyhow!("no active call")),
        }
    }

    /// Change language pair mid-call. The relay will re-open the upstream
    /// with the new languages.
    pub async fn change_languages(
        &self,
        source_lang: Option<String>,
        target_lang: Option<String>,
    ) -> Result<()> {
        let guard = self.active.lock().await;
        match guard.as_ref() {
            Some(call) => {
                if let Some(ref s) = source_lang {
                    *call.source_lang.write() = s.clone();
                }
                if let Some(ref t) = target_lang {
                    *call.target_lang.write() = t.clone();
                }
                let cur_voice = call.voice.read().clone();
                let cur_tone = call.tone.read().clone();
                call.relay
                    .send_json(serde_json::json!({
                        "type": "lang.change",
                        "sourceLang": source_lang,
                        "targetLang": target_lang,
                        "voice": cur_voice,
                        "tone": cur_tone,
                    }))
                    .await
                    .context("send lang.change")
            }
            None => Err(anyhow!("no active call")),
        }
    }

    pub async fn start_call(&self, args: CallArgs) -> Result<serde_json::Value> {
        {
            let guard = self.active.lock().await;
            if guard.is_some() {
                return Err(anyhow!("call already active"));
            }
        }
        self.transition(CallState::JoiningRoom);

        match self.start_call_inner(args).await {
            Ok((active, joined_payload)) => {
                *self.active.lock().await = Some(active);
                self.transition(CallState::Active);
                Ok(joined_payload)
            }
            Err(e) => {
                self.transition(CallState::Failed);
                self.emit_err("start_call", &e);
                self.transition(CallState::Idle);
                Err(e)
            }
        }
    }

    async fn start_call_inner(&self, args: CallArgs) -> Result<(ActiveCall, serde_json::Value)> {
        // 1. Connect to relay WS; the first frame is "join" (captionsOn included).
        let relay_cfg = RelaySocketConfig {
            ws_url: args.credentials.ws_url.clone(),
            token: args.credentials.token.clone(),
            room_code: args.room_code.clone(),
            display_name: args.display_name.clone(),
            captions_on: args.captions_on,
        };
        let relay = RelaySocket::connect(relay_cfg, self.app_handle.clone())
            .await
            .context("connect to relay")?;

        // 2. Wait for the relay's "joined" response (timeout 5 s).
        let joined = relay
            .wait_for_joined(5_000)
            .await
            .context("wait for joined")?;

        // 3. Start audio pipeline.
        let audio_cfg = AudioPipelineConfig {
            input_device: args.input_device.clone(),
            output_device: args.output_device.clone(),
            sample_rate: 16_000,
            frame_ms: 20,
            jitter_buffer_ms: 200, // 200ms jitter buffer absorbs network packet arrival gaps cleanly
        };
        let audio = AudioPipeline::start(audio_cfg, relay.clone(), self.app_handle.clone())
            .context("start audio pipeline")?;

        audio.set_input_gain(f32::from_bits(self.input_volume.load(Ordering::Relaxed)));

        let voice_state = Arc::new(RwLock::new(args.voice.clone()));
        let tone_state = Arc::new(RwLock::new(args.tone.clone()));
        let source_lang_state = Arc::new(RwLock::new(args.source_lang.clone()));
        let target_lang_state = Arc::new(RwLock::new(args.target_lang.clone()));

        // 4. Spawn session refresh task. Renews the token at 80% of TTL.
        let refresh_task = spawn_session_refresh(
            args.relay_url.clone(),
            args.display_name.clone(),
            source_lang_state.clone(),
            target_lang_state.clone(),
            voice_state.clone(),
            tone_state.clone(),
            args.credentials.expires_at,
            relay.clone(),
            self.app_handle.clone(),
        );

        Ok((
            ActiveCall {
                relay,
                audio,
                refresh_task,
                _args: args,
                voice: voice_state,
                tone: tone_state,
                source_lang: source_lang_state,
                target_lang: target_lang_state,
            },
            joined,
        ))
    }

    pub async fn end_call(&self) -> Result<()> {
        self.transition(CallState::Ending);
        let mut guard = self.active.lock().await;
        if let Some(call) = guard.take() {
            // Stop the refresh task first so no new tokens race with shutdown.
            call.refresh_task.abort();

            // Stop audio (stops new frames from being captured/queued).
            call.audio.stop().await;

            // Send a "leave" and close the relay socket.
            call.relay.close().await;

            let _ = self.app_handle.emit("call-ended", serde_json::json!({}));
        }
        self.transition(CallState::Idle);
        Ok(())
    }

    fn transition(&self, next: CallState) {
        let prev = {
            let mut w = self.state.write();
            let p = *w;
            *w = next;
            p
        };
        tracing::info!(?prev, ?next, "call state transition");
        let _ = self.app_handle.emit("call-state", next);
    }

    fn emit_err(&self, op: &str, e: &anyhow::Error) {
        tracing::error!(op, error = %e, "call operation failed");
        let _ = self.app_handle.emit("call-error", serde_json::json!({
            "op": op,
            "message": e.to_string(),
        }));
    }
}

/// Refresh the session token at 80% of its TTL, then reschedule for the new
/// expiry. Loops until the call ends (task aborted) or refresh fails twice
/// in a row.
fn spawn_session_refresh(
    relay_url: String,
    user_id: String,
    source_lang: Arc<RwLock<String>>,
    target_lang: Arc<RwLock<String>>,
    voice: Arc<RwLock<Option<String>>>,
    tone: Arc<RwLock<Option<String>>>,
    expires_at_ms: u64,
    relay: RelaySocket,
    app: AppHandle,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut current_expiry = expires_at_ms;
        let mut failure_count = 0u32;

        loop {
            let now_ms = now_unix_ms();
            if current_expiry <= now_ms {
                tracing::warn!("session already expired; cannot refresh");
                let _ = app.emit("session-expired", serde_json::json!({}));
                return;
            }
            let ttl_ms = current_expiry.saturating_sub(now_ms);
            let refresh_at_ms = ttl_ms * 80 / 100;
            tokio::time::sleep(std::time::Duration::from_millis(refresh_at_ms)).await;

            let cur_src = source_lang.read().clone();
            let cur_tgt = target_lang.read().clone();
            let cur_voice = voice.read().clone();
            let cur_tone = tone.read().clone();

            match mint_session_via_relay(
                &relay_url,
                &user_id,
                &cur_src,
                &cur_tgt,
                cur_voice.as_deref(),
                cur_tone.as_deref(),
            ).await {
                Ok(new_creds) => {
                    failure_count = 0;
                    tracing::info!(new_session_id = %new_creds.session_id, "session refreshed");
                    current_expiry = new_creds.expires_at;

                    // Update token on the socket so future reconnect uses refreshed token (Bug A fix)
                    relay.update_token(new_creds.token.clone());

                    if let Err(e) = relay
                        .send_json(serde_json::json!({
                            "type": "session.refresh",
                            "token": new_creds.token,
                        }))
                        .await
                    {
                        tracing::warn!(error=%e, "failed to push refreshed token");
                        let _ = app.emit("session-expiring", serde_json::json!({}));
                    } else {
                        let _ = app.emit("session-refreshed", serde_json::json!({
                            "expiresAt": new_creds.expires_at,
                        }));
                    }
                    // Loop continues; next iteration schedules for the new expiry.
                }
                Err(e) => {
                    failure_count += 1;
                    tracing::warn!(error=%e, failure_count, "session refresh failed");
                    let _ = app.emit("session-expiring", serde_json::json!({
                        "message": e.to_string(),
                        "attempt": failure_count,
                    }));
                    if failure_count >= 3 {
                        tracing::error!("session refresh failed 3 times — giving up");
                        let _ = app.emit("session-expired", serde_json::json!({}));
                        return;
                    }
                    // Exponential backoff before retry.
                    let retry_ms = 5_000u64 * 2u64.pow(failure_count - 1);
                    tokio::time::sleep(std::time::Duration::from_millis(retry_ms)).await;
                }
            }
        }
    })
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
