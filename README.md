# Ollalink Live Translate — Windows App

Real-time voice-to-voice translation for Windows, powered by the Ollalink sound-stream lane.
Speaker picks a language they speak; listener picks a language they want to hear.
All translation happens server-side on Ollalink GPU; this repo contains the Windows
client (Tauri + Rust) and a tiny auth/room relay server (Node.js).

## Status

**Pre-approval build.** The sound-stream lane on Ollalink requires workspace approval.
Code is complete and ready to compile/run as soon as:
1. The Ollalink dashboard key is activated (currently pending).
2. The final WSS path / config schema / event schema is dropped into
   `app/src-tauri/src/protocol/sound_stream.rs`.

## Quick start

```
# 1. Start the relay server (rooms, auth, key custody)
cd server
copy .env.example .env          # paste your Ollalink dashboard key into .env
npm install
npm run dev                     # listens on ws://localhost:8787

# 2. Launch the app
cd ../app
npm install                     # installs Tauri CLI + UI deps
npm run tauri dev               # requires Rust toolchain (rustup)
```

## Structure

```
ollalink-translate/
├── server/                  # Node.js ESM relay (rooms / auth / brokering)
│   ├── src/
│   │   ├── server.js        # entrypoint, HTTP + WS upgrade
│   │   ├── rooms.js         # in-memory Room registry
│   │   ├── auth.js          # session tokens, HMAC-signed
│   │   ├── ollalink.js      # Ollalink session broker
│   │   └── config.js        # env loading, validated
│   ├── package.json
│   └── .env.example
│
├── app/                     # Tauri 2 Windows app
│   ├── src-tauri/
│   │   ├── src/
│   │   │   ├── main.rs      # Tauri entrypoint, command registration
│   │   │   ├── audio/       # cpal capture + playback, jitter buffer
│   │   │   ├── ws/          # tokio-tungstenite Ollalink connection
│   │   │   ├── protocol/    # sound-stream schema adapter (isolated)
│   │   │   └── state.rs     # AppState, CallSession
│   │   ├── Cargo.toml
│   │   ├── tauri.conf.json
│   │   └── capabilities/
│   └── ui/                  # Vanilla TS frontend (Vite)
│       ├── src/
│       │   ├── main.ts      # bootstrap, command wiring
│       │   ├── call.ts      # call state machine
│       │   ├── captions.ts  # live subtitle renderer
│       │   └── ui.css
│       ├── index.html
│       ├── package.json
│       └── vite.config.ts
│
└── docs/
    ├── PROTOCOL.md          # sound-stream schema, fill in after approval
    ├── APPROVAL-TODO.md     # exact things to flip when key activates
    └── ARCHITECTURE.md
```

## Security model

- The Ollalink `sk_*` dashboard key lives **only** in `server/.env`. It never ships with the app.
- The app holds a short-lived session token issued by the relay (HMAC-signed, 30 min TTL).
- All Ollalink traffic from the app is routed via the relay's WebSocket, which adds the
  dashboard key server-side.

## License

Internal / Networkers Home project — not for public redistribution.
