//! ws/session.rs — session-token minting against the relay.

use crate::state::SessionCredentials;
use anyhow::{Context, Result};

/// Mint a session token by calling the relay's HTTP `/api/session`.
pub async fn mint_session_via_relay(
    relay_url: &str,
    user_id: &str,
    source_lang: &str,
    target_lang: &str,
) -> Result<SessionCredentials> {
    let url = format!("{}/api/session", relay_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&serde_json::json!({
            "userId": user_id,
            "sourceLang": source_lang,
            "targetLang": target_lang,
        }))
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
    Ok(SessionCredentials {
        token: r.token,
        ws_url: r.ws_url,
        expires_at: r.expires_at,
        session_id: r.session_id,
    })
}
