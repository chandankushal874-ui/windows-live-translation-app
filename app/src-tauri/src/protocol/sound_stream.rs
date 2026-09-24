#![allow(dead_code)]
//! protocol/sound_stream.rs â€” Ollalink sound-stream lane adapter.
//!
//! Real docs: https://voices.networkershome.com/docs/realtime-speech/
//!
//! âš ï¸ Audio arrives as base64 in `translation.audio` JSON events, NOT as
//! raw WebSocket binary frames per the earlier draft protocol.
//!
//! This adapter is the only place that knows the wire format. UI/state/ws
//! code consumes the normalized types below and never sees the raw schema.

use serde::{Deserialize, Serialize};

/// Build the config message sent as the first frame after the handshake.
/// Real schema, per https://voices.networkershome.com/docs/realtime-speech/.
pub fn build_config_message(
    api_key: &str,
    source_lang: &str,
    target_langs: &[String],
    sample_rate: u32,
    voice: &str,
    silence_ms: u32,
) -> serde_json::Value {
    serde_json::json!({
        "type": "session.configure",
        "api_key": api_key,
        "audio":       { "sample_rate": sample_rate, "channels": 1, "encoding": "pcm_s16le" },
        "recognition": { "language": source_lang, "punctuation": true },
        "endpointing": { "mode": "auto", "silence_ms": silence_ms },
        "translation": { "enabled": true, "targets": target_langs },
        "tts":         { "enabled": true, "voice": voice },
    })
}

/// Typed upstream event from the sound-stream lane.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UpstreamEvent {
    /// `session.created` â€” socket accepted, before configuration.
    SessionCreated { raw: serde_json::Value },
    /// `session.ready` â€” config resolved. Inspect `config_applied.tts.lanes`
    /// per-target to know whether audio will stream (48k PCM) or batch (24k WAV).
    Ready { raw: serde_json::Value },
    /// `transcript.partial` â€” interim source caption.
    PartialCaption { text: String, lang: String, raw: serde_json::Value },
    /// `transcript.final` â€” finalized source phrase.
    FinalCaption { text: String, lang: String, utterance_id: String, raw: serde_json::Value },
    /// `translation.delta` â€” incremental target text (live).
    TranslationDelta { text: String, lang: String, raw: serde_json::Value },
    /// `translation.final` â€” final target text for the utterance.
    TranslationFinal { text: String, lang: String, utterance_id: String, raw: serde_json::Value },
    /// `translation.audio` â€” spoken translated voice.
    ///
    /// `pcm` is the decoded audio bytes; `None` when this is the end-of-utterance
    /// marker (`last: true` with no audio). `codec` is "pcm_s16le" @ 48 kHz
    /// (streaming lane) or "wav" @ 24 kHz (batch lane, used e.g. for Kannada).
    AudioChunk {
        pcm: Option<Vec<u8>>,
        codec: String,
        sample_rate: u32,
        language: String,
        chunk_seq: u64,
        last: bool,
        utterance_id: Option<String>,
        raw: serde_json::Value,
    },
    /// `speech.started` / `speech.ended` â€” utterance boundary markers.
    SpeechStarted { raw: serde_json::Value },
    SpeechEnded   { raw: serde_json::Value },
    /// `translation.started` â€” translation pipeline began for one target.
    TranslationStarted { raw: serde_json::Value },
    /// `warning` â€” non-fatal (e.g. "unknown_config_keys").
    Warning { code: Option<String>, detail: Option<String>, raw: serde_json::Value },
    /// `error` â€” fatal (most close the socket).
    ErrorEvent { code: Option<String>, detail: Option<String>, raw: serde_json::Value },
    /// `usage` â€” per-session accounting, emitted at close.
    Usage { raw: serde_json::Value },
    /// `session.closed` â€” clean shutdown.
    SessionClosed { raw: serde_json::Value },
    /// Anything we don't recognize yet.
    Unknown { raw: serde_json::Value },
}

/// Map a raw upstream JSON frame to a typed event.
/// The relay decodes `audio_b64` itself before forwarding; this function only
/// handles the JSON control plane.
pub fn classify_event(raw_json: &serde_json::Value) -> UpstreamEvent {
    let ty = raw_json.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match ty {
        "session.created" => UpstreamEvent::SessionCreated { raw: raw_json.clone() },
        "session.ready" => UpstreamEvent::Ready { raw: raw_json.clone() },
        "transcript.partial" => UpstreamEvent::PartialCaption {
            text: get_str(raw_json, "text"),
            lang: get_lang(raw_json),
            raw: raw_json.clone(),
        },
        "transcript.final" => UpstreamEvent::FinalCaption {
            text: get_str(raw_json, "text"),
            lang: get_lang(raw_json),
            utterance_id: get_str(raw_json, "utterance_id"),
            raw: raw_json.clone(),
        },
        "translation.started" => UpstreamEvent::TranslationStarted { raw: raw_json.clone() },
        "translation.delta" => UpstreamEvent::TranslationDelta {
            text: get_str(raw_json, "text"),
            lang: get_lang(raw_json),
            raw: raw_json.clone(),
        },
        "translation.final" => UpstreamEvent::TranslationFinal {
            text: get_str(raw_json, "text"),
            lang: get_lang(raw_json),
            utterance_id: get_str(raw_json, "utterance_id"),
            raw: raw_json.clone(),
        },
        "translation.audio" => {
            let pcm = raw_json
                .get("audio_b64")
                .and_then(|v| v.as_str())
                .and_then(|b64| base64_decode(b64).ok());
            UpstreamEvent::AudioChunk {
                pcm,
                codec: get_str(raw_json, "codec"),
                sample_rate: raw_json.get("sample_rate").and_then(|v| v.as_u64()).unwrap_or(48_000) as u32,
                language: get_lang(raw_json),
                chunk_seq: raw_json.get("chunk_seq").and_then(|v| v.as_u64()).unwrap_or(0),
                last: raw_json.get("last").and_then(|v| v.as_bool()).unwrap_or(false),
                utterance_id: raw_json.get("utterance_id").and_then(|v| v.as_str()).map(|s| s.to_string()),
                raw: raw_json.clone(),
            }
        }
        "speech.started" => UpstreamEvent::SpeechStarted { raw: raw_json.clone() },
        "speech.ended" => UpstreamEvent::SpeechEnded { raw: raw_json.clone() },
        "warning" => UpstreamEvent::Warning {
            code: raw_json.get("code").and_then(|v| v.as_str()).map(String::from),
            detail: raw_json.get("detail").and_then(|v| v.as_str()).map(String::from),
            raw: raw_json.clone(),
        },
        "error" => UpstreamEvent::ErrorEvent {
            code: raw_json.get("code").and_then(|v| v.as_str()).map(String::from),
            detail: raw_json.get("detail").and_then(|v| v.as_str()).map(String::from),
            raw: raw_json.clone(),
        },
        "usage" => UpstreamEvent::Usage { raw: raw_json.clone() },
        "session.closed" => UpstreamEvent::SessionClosed { raw: raw_json.clone() },
        _ => UpstreamEvent::Unknown { raw: raw_json.clone() },
    }
}

fn get_lang(v: &serde_json::Value) -> String {
    let l = get_str(v, "language");
    if !l.is_empty() { l } else { get_str(v, "lang") }
}

fn get_str(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// Minimal base64 decoder (standard alphabet, with padding tolerant).
/// We avoid pulling a base64 crate just for this â€” it's ~30 lines.
fn base64_decode(input: &str) -> Result<Vec<u8>, ()> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut table = [255u8; 256];
    for (i, &c) in ALPHABET.iter().enumerate() {
        table[c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for &b in input.as_bytes() {
        if b == b'=' || b == b'\r' || b == b'\n' { continue; }
        let v = table[b as usize];
        if v == 255 { return Err(()); }
        buf = (buf << 6) | (v as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_final_caption() {
        let raw = serde_json::json!({
            "type": "transcript.final",
            "text": "hello",
            "language": "en",
            "utterance_id": "u-1"
        });
        match classify_event(&raw) {
            UpstreamEvent::FinalCaption { text, lang, utterance_id, .. } => {
                assert_eq!(text, "hello");
                assert_eq!(lang, "en");
                assert_eq!(utterance_id, "u-1");
            }
            _ => panic!("expected FinalCaption"),
        }
    }

    #[test]
    fn classify_translation_audio_decodes_base64() {
        // 4 bytes: [0x48, 0x65, 0x6c, 0x6c] = "Hell"
        let raw = serde_json::json!({
            "type": "translation.audio",
            "codec": "pcm_s16le",
            "sample_rate": 48000,
            "language": "hi",
            "chunk_seq": 0,
            "last": false,
            "audio_b64": "SGVsbA=="
        });
        match classify_event(&raw) {
            UpstreamEvent::AudioChunk { pcm, codec, language, chunk_seq, .. } => {
                assert_eq!(codec, "pcm_s16le");
                assert_eq!(language, "hi");
                assert_eq!(chunk_seq, 0);
                assert_eq!(pcm, Some(b"Hell".to_vec()));
            }
            _ => panic!("expected AudioChunk"),
        }
    }

    #[test]
    fn classify_translation_audio_end_marker() {
        let raw = serde_json::json!({
            "type": "translation.audio",
            "codec": "pcm_s16le",
            "sample_rate": 48000,
            "language": "hi",
            "chunk_seq": 5,
            "last": true
            // no audio_b64
        });
        match classify_event(&raw) {
            UpstreamEvent::AudioChunk { pcm, last, .. } => {
                assert!(last);
                assert!(pcm.is_none());
            }
            _ => panic!("expected AudioChunk end-marker"),
        }
    }

    #[test]
    fn classify_error() {
        let raw = serde_json::json!({"type":"error","code":"unsupported_translation_target"});
        match classify_event(&raw) {
            UpstreamEvent::ErrorEvent { code, .. } => {
                assert_eq!(code.as_deref(), Some("unsupported_translation_target"));
            }
            _ => panic!("expected ErrorEvent"),
        }
    }
}
