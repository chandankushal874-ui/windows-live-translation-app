# Architecture

## High level

```
┌─────────────────────┐                              ┌─────────────────────┐
│  Windows app A      │                              │  Windows app B      │
│  (Tauri + Rust)     │                              │  (Tauri + Rust)     │
│                     │                              │                     │
│  mic → cpal         │                              │  cpal → speaker     │
│    ↓ 16 kHz PCM     │                              │    ↑ 48 kHz PCM     │
│  resampler          │                              │  jitter buffer      │
│    ↓                │                              │    ↑                │
│  tokio-tungstenite ─┼─► WSS ─► relay (Node.js) ──►─┼─► tokio-tungstenite │
│       (binary PCM)  │       │         │            │                     │
│                     │       │         └─► WSS ──► Ollalink GPU           │
│                     │       │              (sound-stream, translated    │
│                     │       │               audio + captions)           │
└─────────────────────┘       │                       └─────────────────────┘
                              │                              ▲
                              └──────────── WSS ─────────────┘
```

- Apps never talk to Ollalink directly — keys stay on the relay.
- Audio flows bidirectionally; both directions open simultaneously.
- Captions travel the same socket, mixed in with the binary audio.

## Why Tauri + Rust

| Concern | Why Rust |
|---|---|
| Real-time audio callback | No GC pauses; cpal callbacks run on dedicated threads |
| WSS I/O in the same process | tokio's zero-cost await; no contention with audio threads |
| Memory safety in hot paths | Bounds-checked, no data races |
| Bundle size | ~10 MB installer vs ~150 MB Electron |
| OS integration | Native installer (MSI/NSIS), tray, auto-updater |

The WebView only renders UI. No audio or network code paths cross it.

## Why a Node.js relay instead of a Rust one

The relay is I/O-bound, not CPU-bound. Node/WS is sufficient at this scale,
has faster iteration velocity, and lets you redeploy without rebuilding the
Windows app. If it becomes a bottleneck it can be swapped for a Rust axum
relay without changing the app — protocol is the contract.

## Modules at a glance

### Server (`server/src/`)

| File | Role |
|---|---|
| `server.js` | HTTP routes + WS server, orchestration |
| `config.js` | env loading, validation, logging |
| `auth.js` | HMAC-SHA256 session token mint/verify |
| `rooms.js` | in-memory room registry (v1: 2 seats) |
| `ollalink.js` | upstream WS connection to Ollalink, protocol adapter |

### App (`app/src-tauri/src/`)

| File | Role |
|---|---|
| `main.rs` | Tauri entrypoint, command registration |
| `state.rs` | CallState machine, AppState singleton |
| `audio/mod.rs` | cpal capture + playback, threading |
| `audio/resample.rs` | rubato-based PCM resampler |
| `audio/jitter.rs` | playback jitter buffer |
| `ws/mod.rs` | relay WS client, reader/writer tasks |
| `ws/session.rs` | session token minting via HTTP |
| `protocol/mod.rs` | typed frame definitions |
| `protocol/sound_stream.rs` | **Ollalink schema adapter — the only file that changes on approval** |

### UI (`app/ui/src/`)

| File | Role |
|---|---|
| `main.ts` | Bootstrap, command wiring, event subscriptions |
| `call.ts` | UI-side call state machine |
| `captions.ts` | Live captions view (with partial-update coalescing) |
| `ui.css` | Dark theme, no framework |

## Hot-path performance notes

- Audio capture callback: `try_push` to a lock-free ring. Never blocks. Overflow drops samples.
- Sender task: drains ring every 1 ms, resamples to 16 kHz, chunks to 20 ms frames.
- Jitter buffer: pre-buffers 120 ms before playing. Underrun → silence.
- No allocation in the capture callback. Sender allocates once per frame batch.
- WebView does no audio. All audio I/O lives in Rust threads.
