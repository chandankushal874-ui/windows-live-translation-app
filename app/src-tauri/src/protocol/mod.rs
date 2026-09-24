//! protocol/mod.rs â€” typed frame definitions for the appâ†”relay protocol,
//! and the isolation shim where the Ollalink sound-stream schema lives.
//!
//! Everything else in the codebase depends only on the types in this file.
//! When Ollalink publishes the real sound-stream protocol (URL, config
//! schema, event schema), changes land in `sound_stream.rs` and (if the
//! relay forwards new event kinds) a new variant on `ServerEvent` here.

use serde::{Deserialize, Serialize};

// ---------- Client â†’ Server ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
#[allow(dead_code)]
pub enum ClientFrame {
    Join { token: String, room: Option<String>, #[serde(rename = "displayName")] display_name: String },
    Leave,
    Ping,
}

// ---------- Server â†’ Client events ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerEvent {
    Joined {
        room: String,
        #[serde(rename = "self")] self_participant: Participant,
        participants: Vec<Participant>,
    },
    PeerJoined { peer: Participant },
    PeerLeft { #[serde(rename = "sessionId")] session_id: String },
    /// Header frame for an incoming audio binary. Next WS frame is PCM.
    Audio {
        from: String,
        #[serde(default)]
        lang: String,
        #[serde(default)]
        codec: Option<String>,
        #[serde(rename = "sampleRate")]
        sample_rate: Option<u32>,
        #[serde(rename = "chunkSeq")]
        chunk_seq: Option<u64>,
        #[serde(default)]
        last: Option<bool>,
        #[serde(rename = "endOfUtterance")]
        end_of_utterance: Option<bool>,
        #[serde(rename = "hasBinary")]
        has_binary: Option<bool>,
        #[serde(rename = "utteranceId")]
        utterance_id: Option<String>,
    },
    Caption {
        kind: CaptionKind,
        from: String,
        payload: serde_json::Value,
    },
    Error { code: String, message: String },
    Pong { ts: u64 },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub display_name: String,
    pub source_lang: String,
    pub target_lang: String,
    pub joined_at: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptionKind {
    Ready,
    CaptionPartial,
    CaptionFinal,
    Translation,
    Error,
    Unknown,
}

// ---------- Joined-waiter registry (for sequenced start_call) ----------

mod joined_registry {
    use once_cell::sync::Lazy;
    use parking_lot::Mutex;
    use std::collections::HashMap;
    use tokio::sync::oneshot;

    static WAITERS: Lazy<Mutex<HashMap<String, oneshot::Sender<Result<serde_json::Value, String>>>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));

    pub fn register(id: &str, sender: oneshot::Sender<Result<serde_json::Value, String>>) {
        WAITERS.lock().insert(id.to_string(), sender);
    }

    pub fn resolve(id: &str, value: serde_json::Value) {
        if let Some(tx) = WAITERS.lock().remove(id) {
            let _ = tx.send(Ok(value));
        }
    }

    pub fn reject(id: &str, err: String) {
        if let Some(tx) = WAITERS.lock().remove(id) {
            let _ = tx.send(Err(err));
        }
    }

    /// Cancel a waiter without resolving — used when the socket dies before
    /// the joined event arrives. Prevents timeout-hanging on dead sockets.
    #[allow(dead_code)]
    pub fn cancel(id: &str) {
        WAITERS.lock().remove(id);
    }

    /// Cancel ALL waiters (used on socket close). Existing waiters get a
    /// dropped sender, which makes their receivers return Err — exactly the
    /// "early failure" semantics we want for start_call_inner.
    pub fn cancel_all() {
        let mut g = WAITERS.lock();
        g.clear();
    }
}

#[allow(unused_imports)]
pub use joined_registry::{
    register as register_joined_waiter,
    resolve as resolve_joined_waiter,
    reject as reject_joined_waiter,
    cancel as cancel_joined_waiter,
    cancel_all as cancel_all_joined_waiters,
};

// ---------- The sound-stream adapter lives in its own file ----------
pub mod sound_stream;

