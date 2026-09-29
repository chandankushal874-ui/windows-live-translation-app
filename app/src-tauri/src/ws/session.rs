//! ws/session.rs — session-token minting against the relay.

use crate::state::SessionCredentials;
use anyhow::{Context, Result};

/// Mint a session token by calling the relay's HTTP `/api/session`.
pub async fn mint_session_via_relay(
    relay_url: &str,
    user_id: &str,
    source_lang: &str,
    target_lang: &str,
    voice: Option<&str>,
    tone: Option<&str>,
) -> Result<SessionCredentials> {
    let mut base = relay_url.trim().to_string();
    if !base.starts_with("http://") && !base.starts_with("https://") && !base.starts_with("ws://") && !base.starts_with("wss://") {
        if base.starts_with("localhost") || base.starts_with("127.0.0.1") {
            base = format!("http://{}", base);
        } else {
            base = format!("https://{}", base);
        }
    }
    let http_base = base.replace("wss://", "https://").replace("ws://", "http://");
    let url = format!("{}/api/session", http_base.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let mut payload = serde_json::json!({
        "userId": user_id,
        "sourceLang": source_lang,
        "targetLang": target_lang,
    });
    if let Some(v) = voice {
        payload["voice"] = serde_json::json!(v);
    }
    if let Some(t) = tone {
        payload["tone"] = serde_json::json!(t);
    }
    let resp = client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .context("POST /api/session")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("session mint failed: {status} {body}");
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MintResp {
        token: String,
        ws_url: String,
        expires_at: u64,
        session_id: String,
    }
    let r: MintResp = resp.json().await.context("parse mint response")?;
    let is_server_local = r.ws_url.contains("localhost") || r.ws_url.contains("127.0.0.1");
    let is_base_local = base.contains("localhost") || base.contains("127.0.0.1");
    let ws_url = if is_server_local && !is_base_local {
        let base_ws = base
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        format!("{}/call", base_ws.trim_end_matches('/'))
    } else {
        r.ws_url
            .replace("https://", "wss://")
            .replace("http://", "ws://")
    };
    Ok(SessionCredentials {
        token: r.token,
        ws_url,
        expires_at: r.expires_at,
        session_id: r.session_id,
    })
}
