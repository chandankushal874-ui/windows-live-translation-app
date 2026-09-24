# Protocol reference

This document describes the protocols at play, now verified against the
published Ollalink sound-stream docs at
https://voices.networkershome.com/docs/realtime-speech/

## 1. App ↔ Relay (our protocol)

Transport: WebSocket, JSON for control, binary for audio.

### Client → Server

```json
{ "type": "join", "token": "...", "room": "ABC123" | null, "displayName": "Alice", "captionsOn": true }
{ "type": "leave" }
{ "type": "ping" }
{ "type": "captions.set", "on": true | false }
{ "type": "lang.change", "sourceLang": "en", "targetLang": "hi" }
{ "type": "session.refresh", "token": "..." }
<binary>  PCM s16le 16 kHz mono (one 20 ms frame = 640 bytes)
```

### Server → Client

```json
{ "type": "joined", "room": "ABC123", "self": {...}, "participants": [...] }
{ "type": "peer-joined", "peer": {...} }
{ "type": "peer-left", "sessionId": "..." }
{ "type": "peer-lang-changed", "sessionId": "...", "sourceLang": "...", "targetLang": "..." }
{ "type": "peer-session-rotated", "oldSessionId": "...", "newSessionId": "..." }
{ "type": "peer-upstream-closed", "from": "..." }
{ "type": "audio", "from": "sess-uuid", "lang": "hi", "codec": "pcm_s16le", "sampleRate": 48000, "chunkSeq": 0, "last": false, "endOfUtterance": false }
   ← followed by a binary frame with the PCM/WAV bytes
{ "type": "caption", "kind": "caption-partial|caption-final|translation|translation-delta|...", "from": "...", "payload": {...} }
{ "type": "error", "code": "...", "message": "..." }
{ "type": "pong", "ts": 1234567890 }
{ "type": "session.refreshed", "sessionId": "..." }
{ "type": "captions.set", "on": true }
{ "type": "lang.changed", "sourceLang": "en", "targetLang": "hi" }
```

## 2. Relay ↔ Ollalink sound-stream (real, published)

```
WSS → wss://sound-stream.ollalink.com/v1/speech/stream
Auth: dashboard sk_ key inside session.configure.api_key
       (X-NH-GPU-Key header also accepted defensively)

First message (JSON):
{
  "type": "session.configure",
  "api_key": "sk_...",
  "audio":       { "sample_rate": 16000, "channels": 1, "encoding": "pcm_s16le" },
  "recognition": { "language": "en", "punctuation": true },
  "endpointing": { "mode": "auto", "silence_ms": 600 },
  "translation": { "enabled": true, "targets": ["hi", "kn", "ta"] },
  "tts":         { "enabled": true, "voice": "nh-m01" }
}

Then: 16 kHz mono s16le PCM binary frames at real-time cadence.
      Send {"type":"audio.commit"} to flush a partial utterance.

← Events (all JSON — audio arrives as base64 inside translation.audio):

  { "type": "session.created" }
  { "type": "session.ready", "capabilities": [...], "config_applied": { "tts": { "lanes": { "hi": "stream" } } } }
  { "type": "transcript.partial",  "text": "...", "language": "en" }
  { "type": "transcript.final",    "text": "...", "language": "en", "utterance_id": "u-1" }
  { "type": "speech.started" | "speech.ended" }
  { "type": "translation.started", "language": "hi" }
  { "type": "translation.delta",   "text": "...", "language": "hi" }
  { "type": "translation.final",   "text": "...", "language": "hi", "utterance_id": "u-1" }
  { "type": "translation.audio",
    "codec": "pcm_s16le" | "wav",
    "sample_rate": 48000 | 24000,
    "language": "hi",
    "chunk_seq": 0,
    "last": false,
    "audio_b64": "<base64-encoded PCM or WAV bytes>"
  }
  { "type": "translation.audio", "last": true, ... }  ← end-of-utterance marker (no audio_b64)
  { "type": "warning", "code": "...", "detail": "..." }
  { "type": "error", "code": "...", "detail": "..." }   ← fatal; socket closes
  { "type": "usage", ... }                              ← per-session accounting at close
  { "type": "session.closed" }
```

## 3. Two audio delivery lanes

| Lane | Codec | Sample rate | When used |
|---|---|---|---|
| `stream` | `pcm_s16le` | 48 000 Hz | Default. Many chunks per clause, `chunk_seq` increments, final chunk has `last: true` |
| `batch` | `wav` | 24 000 Hz | Used when target language is pinned to batch (Kannada today) or requested voice unavailable on stream lane |

**Never assume a codec.** Branch on `config_applied.tts.lanes[target]` from `session.ready`, or on the `codec` field of each `translation.audio` event.

## 4. Multi-target fanout

One upstream session can render the speaker's voice into **multiple target languages** simultaneously. The `translation.targets` array accepts up to 14 languages. Each `translation.audio` event carries a `language` field — the relay routes each chunk to the peer whose `targetLang` matches.

This means: **one upstream per speaker**, not one per listener. For a 4-person call, the relay opens at most 4 upstreams (one per speaker), each fanning out to the other 3 listeners' languages.

## 5. Concurrency & limits

| Limit | Value |
|---|---|
| Concurrent sessions per API key | **16** |
| Source languages | `en`, `hi`, `es`, `fr`, or `auto` |
| Translation targets (14) | `en`, `hi`, `es`, `fr`, `de`, `zh`, `ar`, `ja`, `ru`, `pt`, `it`, `kn`, `ta`, `te` |
| Production voices | `en`, `hi`, `kn`, `ta` |
| Audio input | 16 kHz mono s16le PCM only |
| Audio output | 48 kHz s16le (stream) or 24 kHz WAV (batch) |
| First audio latency | ~0.2 s after clause translation |

## 6. Error codes

| Code | Meaning |
|---|---|
| `unauthorized` | api_key missing or invalid |
| `not_approved` | Account still pending approval |
| `insufficient_scope` | Key not authorized for speech lane |
| `rate_limited` | Concurrency limit reached (16 sessions) |
| `quota_exceeded` | Monthly allowance exhausted |
| `bad_configure` | session.configure malformed or out of order |
| `unsupported_audio` | Input must be pcm_s16le 16 kHz mono |
| `unsupported_language` | Source language outside supported set |
| `unsupported_translation_target` | Target outside the 14 supported |
| `asr_connect_failed` / `asr_error` | Recognition backend unavailable |
| `translation_error` | Translation failed for one target (others continue) |
| `tts_error` | Synthesis failed for one clause (captions continue) |
| `tts_empty` | Translation produced nothing speakable |
| `overloaded` | Sending audio faster than real time; socket closes |
| `session_expired` | Key revoked or expired mid-session |
| `control_unavailable` | Authorization service temporarily unreachable |

`translation_error` and `tts_error` are **isolated by design** — a failure on one target or clause never stops captions or other targets.