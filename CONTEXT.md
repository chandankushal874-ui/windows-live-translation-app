# CONTEXT.md — Project State for AI Agents, Senior Engineers & Network Admins

Dense technical reference for the Ollalink Translate project. For beginner conceptual explanations, see `EBOOK.md`.

---

## 1. Executive Summary

Ollalink Translate is a production-grade, zero-latency 1:1 and multi-peer voice-to-voice translation system for Windows x64.
- **Client**: Native Tauri 2 (Rust 1.77+ & Webview2) desktop client (`ollalink-translate.exe`, 9.57 MB release binary).
- **Relay Server**: High-performance Node.js 20+ ESM relay (`server/src/server.js`, 140 KB dependencies), orchestrating authentication, room brokering, SFU multi-target fanout, and upstream Ollalink Sound-Stream GPU custody.
- **Cloud Translation Engine**: Ollalink Sound-Stream GPU WebSocket cluster (`wss://sound-stream.ollalink.com/v1/speech/stream`).
- **Live API Key**: Verified active & authenticating (`sk_f439f7e7394139022af3b458a76008e86e1ba0b93e497207`).
- **Test Coverage**: **111 / 111 PASSING (0 FAILURES)** across unit, integration, and E2E suites.

---

## 2. Senior Networking & Relay Architecture

```
[Peer 1: Host]        [Peer 2: Guest]       [Peer 3: Guest]       [Peer 4: Guest]
  (English)              (Hindi)               (Spanish)              (French)
      │                     │                     │                     │
      └─────────────────────┼─────────────────────┴─────────────────────┘
                            │ (WSS binary PCM frames @ 16kHz)
                            ▼
              ┌─────────────────────────────┐
              │    CENTRAL CLOUD RELAY      │
              │  Node.js 20 ESM / Port 8787 │
              │  - Reverse Proxy Compliant  │
              │  - Security Headers Active  │
              │  - SFU Multi-Target Fanout  │
              └─────────────┬───────────────┘
                            │ (WSS Upstream, session.configure)
                            ▼
              ┌─────────────────────────────┐
              │    OLLALINK CLOUD GPU       │
              │  - Whisper Speech ASR       │
              │  - Realtime Multi-Translate │
              │  - Neural Voice TTS (48kHz) │
              └─────────────────────────────┘
```

### 2.1 SFU Multi-Target Fanout Architecture
When scaling from 1:1 to multi-peer groups (up to 4+ participants per room):
1. **Single Ingress Stream**: The active speaker uploads their microphone voice **only once** to the relay server as 16kHz mono `pcm_s16le` binary frames (1,280 bytes = 40ms packets).
2. **Union Language Set Computation (`computeTargets`)**: The relay dynamically computes the union of all *other* participants' selected target languages (e.g. `targets: ['hi', 'es', 'fr']`).
3. **GPU Multi-Synthesis**: Ollalink Cloud GPU synthesizes the translated speech streams concurrently.
4. **Selective Forwarding**: The relay routes the Hindi TTS stream exclusively to Peer 2, the Spanish stream to Peer 3, and the French stream to Peer 4. Bandwidth on all client connections remains minimal ($O(1)$ instead of $O(N^2)$).

### 2.2 Networking Hardening & Best Practices
- **Reverse Proxy Support**: Extracts true client IPs and schemes via `X-Forwarded-For` and `X-Forwarded-Proto` for deployment behind Cloudflare, Nginx, AWS ALB, Render, or Railway.
- **Security Headers**: Standard on all HTTP responses:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
- **Liveness & Readiness Probes**:
  - `GET /api/health`: Instant liveness probe for Kubernetes / cloud orchestrators (`{ ok: true, ts: ... }`).
  - `GET /api/ready`: Readiness probe returning server uptime, active room counts, total participants, and memory metrics (`rssMb`, `heapUsedMb`).
  - `GET /`: Styled responsive HTML status landing page and JSON status (`{ ok: true, status: "online" }`).
- **WebSocket Keep-Alive & Dead Socket Reaper**:
  - Sends WS ping every 25 seconds to prevent NAT firewall and proxy timeouts.
  - Automatically terminates sockets that fail to return `pong` within 10 seconds, releasing room seats immediately.
- **Graceful Termination**:
  - Intercepts `SIGTERM` and `SIGINT`.
  - Broadcasts `{ type: "server-shutdown", reason: "restarting" }` to clients.
  - Closes upstream GPU connections and terminates HTTP sockets cleanly before exit.

---

## 3. Production Deployment Guides

### Option A: Render (Zero-Cost 1-Click Deployment)
The repository includes `server/render.yaml` configured for Render Blueprint deployment:
1. Connect repository to Render.
2. Render detects `server/render.yaml` and provisions a Web Service with WebSockets enabled.
3. Permanent URL: `https://your-app.onrender.com` / `wss://your-app.onrender.com/call`.

### Option B: Docker Containerization
The repository includes a production multi-stage Alpine Dockerfile (`server/Dockerfile`):
```bash
cd C:\ollalink-translate\server
docker build -t ollalink-relay:latest .
docker run -d -p 8787:8787 --env-file .env --name ollalink-relay ollalink-relay:latest
```
- **Image Size**: ~130 MB (minimal Alpine Linux).
- **User**: Runs as non-root `node` user.
- **Healthcheck**: Built-in `HEALTHCHECK` monitoring `/api/health`.

### Option C: 1-Click Internet Tunnel (Local Host Mode)
For hosting directly from a Windows PC without public cloud accounts:
- Double-click `C:\ollalink-translate\host-internet.bat`.
- Automatically starts local relay, establishes secure Cloudflare tunnel, copies public HTTPS/WSS URL to clipboard, and opens the desktop app.

---

## 4. Environment Variables Reference

| Variable | Type | Default | Description |
|---|:---:|:---:|---|
| `PORT` | Integer | `8787` | HTTP & WebSocket listening port. |
| `NODE_ENV` | String | `development` | Runtime environment (`production` enables optimizations). |
| `OLLALINK_KEY` | String | *Required* | API key for `sound-stream.ollalink.com`. |
| `OLLALINK_WS_URL` | String | `wss://sound-stream...` | Upstream GPU endpoint. |
| `MAX_PARTICIPANTS` | Integer | `2` | Default room seat limit (configurable up to `8`). |
| `ALLOWED_ORIGINS` | CSV | `http://localhost:*` | CORS origin whitelist. |

---

## 5. Test Suite Verification

Run all test suites locally:
```powershell
cd C:\ollalink-translate\server
npm test
```
**Results:** **111 passed, 0 failed** across 15 test files:
- Unit tests: `auth.test.js`, `rooms.test.js`, `audio_chunks.test.js`, `captions_routing.test.js`, `realtime_protocol.test.js`, `regressions.test.js`.
- Integration tests: `server.test.js`, `receive_path.test.js`, `rooms_deep.test.js`, `multi_target.test.js`, `landing_flow_e2e.test.js`, `host_joining_deep.test.js`.
- End-to-end traversal: `deep_e2e_pipeline.test.js`, `deep_e2e_advanced.test.js`.
