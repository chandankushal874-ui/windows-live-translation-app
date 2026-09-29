/**
 * server.js â€” relay entrypoint.
 *
 * Surfaces:
 *   POST /api/session        â€” mint a session token (JSON body)
 *   GET  /api/health         â€” liveness
 *   GET  /api/stats          â€” room/participant counts
 *   WS   /call               â€” the call data plane (binary + JSON frames)
 *
 * Client WS frame protocol (JSON or Binary):
 *   { "type": "join", "token": "...", "room": "ABC12", "displayName": "Alice" }
 *       â†’ server replies { type: "joined", room, self, participants[] }
 *   { "type": "leave" }
 *   <binary PCM frame> â€” forwarded upstream to Ollalink
 *   { "type": "ping" } â†’ { type: "pong" }
 *
 * Server â†’ client frames:
 *   { type: "joined", ... } | { type: "peer-joined", ... } | { type: "peer-left", ... }
 *   { type: "audio", "from": sessionId } + binary frame (next message carries PCM)
 *   { type: "caption", "kind": "partial"|"final"|"translation", ...payload }
 *   { type: "error", "code": ..., "message": ... }
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config, log } from './config.js';
import { mintSession, verifySession } from './auth.js';
import { createRoom, getRoom, joinRoom, leaveRoom, others, roomStats, isValidRoomCode, startRoomSweeper } from './rooms.js';
import { openOllalinkStream, probeOllalinkLanguage } from './ollalink.js';
import { normalizeLang, hasProductionVoice, SOUND_STREAM_SOURCES, SOUND_STREAM_TARGETS, CAPTION_TARGETS_22, VOICE_PERSONAS, VOICE_TONES, normalizeVoice, normalizeTone } from './langs.js';

// ---------- HTTP ----------

const server = http.createServer((req, res) => {
  let url;
  try {
    // Validate host header format: allowed hostname chars, port, and IPv6 brackets (SRV-02 fix)
    const rawHost = req.headers.host;
    const safeHost = (typeof rawHost === 'string' && /^[\w.:\-[\]]+$/.test(rawHost))
      ? rawHost
      : 'localhost';
    url = new URL(req.url, `http://${safeHost}`);
  } catch {
    // Malformed request URL or host header -> Return 400 Bad Request immediately without crashing
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'invalid_request', message: 'Malformed request URL or Host header' }));
  }

  // Universal CORS for desktop WebView2, Tauri clients, and web browsers
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-requested-with');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Security headers on all HTTP responses
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method === 'GET' && url.pathname === '/api/ready') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ready: true,
      uptimeSeconds: Math.floor(process.uptime()),
      activeRooms: roomStats().activeRooms,
      totalParticipants: roomStats().totalParticipants,
      memory: {
        rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
      },
    }));
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
    const isHtml = (req.headers.accept || '').includes('text/html');
    if (isHtml) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html>
<html>
<head><title>Ollalink Translate Relay — Online</title>
<style>
body { font-family: system-ui, -apple-system, sans-serif; background: #0c0e14; color: #e2e8f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
.card { background: #171b26; border: 1px solid #2d3748; padding: 2.5rem; border-radius: 1rem; text-align: center; max-width: 480px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
.badge { display: inline-flex; align-items: center; gap: 0.5rem; background: #064e3b; color: #34d399; padding: 0.35rem 0.85rem; border-radius: 9999px; font-weight: 600; font-size: 0.875rem; margin-bottom: 1rem; }
.dot { width: 8px; height: 8px; background: #10b981; border-radius: 50%; display: inline-block; box-shadow: 0 0 8px #10b981; }
h1 { margin: 0 0 0.5rem 0; font-size: 1.5rem; font-weight: 700; color: #fff; }
p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin: 0 0 1.5rem 0; }
.hint { background: #0f172a; border: 1px solid #1e293b; padding: 0.75rem; border-radius: 0.5rem; font-family: monospace; font-size: 0.85rem; color: #38bdf8; word-break: break-all; }
</style>
</head>
<body>
<div class="card">
  <div class="badge"><span class="dot"></span> Relay Server Online</div>
  <h1>Ollalink Translate</h1>
  <p>This public relay is healthy and ready for live 1:1 voice translation calls.</p>
  <div class="hint">Paste this URL into your Ollalink Translate Desktop App</div>
</div>
</body>
</html>`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'Ollalink Translate Relay', status: 'online' }));
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(roomStats()));
  }

  // Public language catalog â€” the UI consumes this so it doesn't drift from server.
  if (req.method === 'GET' && url.pathname === '/api/langs') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      sources: Array.from(SOUND_STREAM_SOURCES),
      targets: Array.from(SOUND_STREAM_TARGETS),
      captions: Array.from(CAPTION_TARGETS_22),
      productionVoices: Array.from(SOUND_STREAM_TARGETS).filter(hasProductionVoice),
      voices: Array.from(VOICE_PERSONAS),
      tones: Array.from(VOICE_TONES),
    }));
  }

  // Language Health Probe endpoint for dynamic UI validation
  if (req.method === 'POST' && url.pathname === '/api/probe-language') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const result = await probeOllalinkLanguage(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/session') {
    let body = '';
    let bodyBytes = 0;
    const MAX_BODY = 64 * 1024;
    req.on('data', (c) => {
      bodyBytes += c.length;
      if (bodyBytes > MAX_BODY) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        req.destroy();
        return;
      }
      body += c;
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const { userId, sourceLang, targetLang, captionsOn, voice, tone } = parsed;
        if (!userId || !sourceLang || !targetLang) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'userId, sourceLang, targetLang required' }));
        }
        if (userId.length > 128) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'userId too long' }));
        }
        // Validate languages against the server-side catalog. Defaults reject
        // unsupported pairs early â€” cheaper than learning at WS-open time.
        const src = normalizeLang(sourceLang, 'source');
        const tgt = normalizeLang(targetLang, 'target');
        if (!src) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: `unsupported sourceLang: ${sourceLang}`, allowed: Array.from(SOUND_STREAM_SOURCES) }));
        }
        if (!tgt) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: `unsupported targetLang: ${targetLang}`, allowed: Array.from(SOUND_STREAM_TARGETS) }));
        }
        const chosenVoice = normalizeVoice(voice);
        const chosenTone = normalizeTone(tone);
        const session = mintSession({ userId, sourceLang: src, targetLang: tgt, voice: chosenVoice, tone: chosenTone });
        const reqHost = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        const reqProtoHeader = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
        const reqProto = reqProtoHeader || (req.socket.encrypted ? 'https' : 'http');
        let wsEndpoint;
        if (reqHost && !reqHost.includes('localhost') && !reqHost.includes('127.0.0.1')) {
          const wsProto = (reqProto.includes('http') && !reqProto.includes('https')) ? 'ws' : 'wss';
          wsEndpoint = `${wsProto}://${reqHost}/call`;
        } else {
          wsEndpoint = `${config.publicBase.replace(/^http(s)?:/i, 'ws$1:')}/call`;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          token: session.token,
          expiresAt: session.expiresAt,
          sessionId: session.sessionId,
          wsUrl: wsEndpoint,
          captionsOn: captionsOn !== false,       // default true
          productionVoice: hasProductionVoice(tgt), // heads-up for the UI
          voice: chosenVoice,
          tone: chosenTone,
        }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `invalid json: ${err.message}` }));
      }
    });
    return;
  }

  // Explicit token refresh endpoint. Body: { token } â€” must be valid, returns a
  // new token for the same user with a fresh expiry.
  if (req.method === 'POST' && url.pathname === '/api/session/refresh') {
    let body = '';
    let bodyBytes = 0;
    const MAX_BODY = 16 * 1024;
    req.on('data', (c) => {
      bodyBytes += c.length;
      if (bodyBytes > MAX_BODY) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        req.destroy();
        return;
      }
      body += c;
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const payload = verifySession(parsed.token);
        if (!payload) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid or expired token' }));
        }
        const session = mintSession({
          userId: payload.sub,
          sourceLang: payload.src,
          targetLang: payload.tgt,
          voice: payload.voice,
          tone: payload.tone,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          token: session.token,
          expiresAt: session.expiresAt,
          sessionId: session.sessionId,
          voice: session.voice,
          tone: session.tone,
        }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `invalid json: ${err.message}` }));
      }
    });
    return;
  }

  // Convenience: create a room code. Supports optional maxParticipants (2-4).
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let maxPart = undefined;
      try {
        const parsed = JSON.parse(body || '{}');
        if (parsed && typeof parsed.maxParticipants === 'number') {
          maxPart = parsed.maxParticipants;
        }
      } catch {}
      const room = createRoom(maxPart);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: room.code, maxParticipants: room.maxParticipants }));
    });
    return;
  }

  // Validate a room code without joining. Lets the UI check before dial.
  if (req.method === 'GET' && url.pathname.startsWith('/api/rooms/')) {
    const code = url.pathname.slice('/api/rooms/'.length).toUpperCase();
    if (!isValidRoomCode(code)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ valid: false, reason: 'malformed' }));
    }
    const room = getRoom(code);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      valid: true,
      exists: !!room,
      seatsAvailable: room ? room.maxParticipants - room.participants.size : 0,
      maxParticipants: room?.maxParticipants ?? 0,
    }));
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

// ---------- WS /call ----------

const wss = new WebSocketServer({ server, path: '/call', maxPayload: 8 * 1024 * 1024 });

// Map<ws, client> so we can reach into a peer's client object to re-open
// their upstream when the room's target-language set changes.
const clientRegistry = new Map();

wss.on('connection', (ws, req) => {
  const client = {
    ws,
    // populated after "join"
    session: null,
    room: null,
    upstream: null, // Ollalink stream handle
    isAlive: true,
  };
  clientRegistry.set(ws, client);

  ws.on('pong', () => { client.isAlive = true; });

  ws.on('message', async (data, isBinary) => {
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        return;
      }

      if (msg.type === 'session.refresh') {
        // Client pushed a new token mid-call. Verify and adopt.
        const newPayload = verifySession(msg.token);
        if (!newPayload) return sendErr(ws, 'bad-token', 'invalid refreshed token');
        if (!client.session)  return sendErr(ws, 'not-joined', 'not in a call');
        // Require the refresh to be for the SAME user.
        if (newPayload.sub !== client.session.userId) {
          return sendErr(ws, 'token-mismatch', 'refresh must be for same user');
        }
        const oldSid = client.session.sessionId;
        client.session.sessionId = newPayload.sid;
        if (newPayload.voice && newPayload.voice !== 'nh-m01') client.session.voice = newPayload.voice;
        if (newPayload.tone && newPayload.tone !== 'natural') client.session.tone = newPayload.tone;
        // Also update the room's participant map so others() sees the new sid.
        if (client.room) {
          const p = client.room.participants.get(oldSid);
          if (p) {
            client.room.participants.delete(oldSid);
            p.sessionId = newPayload.sid;
            client.room.participants.set(newPayload.sid, p);
          }
        }
        // Tell peers so their "from" mapping tracks the rotation.
        broadcastToOthers(client, {
          type: 'peer-session-rotated',
          oldSessionId: oldSid,
          newSessionId: newPayload.sid,
        });
        log.info(`session rotated for ${newPayload.sub} ${oldSid} â†’ ${newPayload.sid}`);
        ws.send(JSON.stringify({
          type: 'session.refreshed',
          sessionId: newPayload.sid,
        }));
        return;
      }

      if (msg.type === 'join') {
        if (client.session) return sendErr(ws, 'already-joined', 'already joined');

        const sessionPayload = verifySession(msg.token);
        if (!sessionPayload) return sendErr(ws, 'bad-token', 'invalid or expired token');

        const room = msg.room ? getRoom(msg.room) : createRoom();
        if (!room) return sendErr(ws, 'no-room', 'room not found');

        // Dedupe: if this userId is already seated (e.g. an earlier WS that didn't
        // cleanly close), remove the stale entry before joining again.
        for (const [sid, p] of room.participants) {
          if (p.userId === sessionPayload.sub) {
            log.warn(`reconnect/dedupe: replacing earlier participant for userId=${p.userId} (sid ${sid}, isSameSid=${sid === sessionPayload.sid})`);
            const oldClient = clientRegistry.get(p.ws);
            if (oldClient) {
              oldClient._replacedByNewConnection = true;
            }
            try { p.ws?.terminate(); } catch { /* ignore */ }
            if (sid !== sessionPayload.sid) {
              room.participants.delete(sid);
              broadcastToOthers(client, { type: 'peer-left', sessionId: sid });
            }
          }
        }

        const participant = {
          sessionId: sessionPayload.sid,
          userId: sessionPayload.sub,
          sourceLang: sessionPayload.src,
          targetLang: sessionPayload.tgt,
          voice: normalizeVoice(msg.voice || sessionPayload.voice),
          tone: normalizeTone(msg.tone || sessionPayload.tone),
          displayName: (msg.displayName || 'anon').slice(0, 64),
          captionsOn: msg.captionsOn !== false,  // default true
          ws,
          joinedAt: Date.now(),
        };

        const joined = joinRoom(room.code, participant);
        if (!joined) return sendErr(ws, 'room-full', `room ${room.code} is full`);

        client.session = participant;
        client.room = room;

        // Open upstream Ollalink stream for THIS participant. Sound-stream
        // supports multi-target fanout: one session can render the speaker's
        // voice into every other participant's target language simultaneously.
        // Compute the union of all OTHER participants' target languages, plus
        // any future joiners will be added via session refresh (sound-stream
        // doesn't yet support adding targets mid-session, so we re-open when
        // the peer set changes â€” see broadcastToOthers for lang recompute).
        const initialTargets = computeTargets(room, sessionPayload.sid, sessionPayload.tgt);
        client.upstream = bindUpstream(client,
          {
            sourceLang: participant.sourceLang,
            targetLangs: initialTargets,
            sessionToken: msg.token,
            voice: participant.voice,
            tone: participant.tone,
          },
          {
            onEvent: (evt) => forwardOllalinkToRoom(client, evt),
            onClose: (code, reasonStr, wasOverloaded) => handleUpstreamClose(client, code, reasonStr, wasOverloaded),
            onError: (err) => sendErr(ws, 'upstream-error', err.message),
          },
        );

        ws.send(JSON.stringify({
          type: 'joined',
          room: room.code,
          self: publicParticipant(participant),
          participants: Array.from(room.participants.values()).map(publicParticipant),
        }));
        broadcastToOthers(client, { type: 'peer-joined', peer: publicParticipant(participant) });

        // Re-open each existing peer's upstream only if their multi-target set changed (Bug 10 Fix)
        for (const [sid, p] of room.participants) {
          if (sid === sessionPayload.sid) continue;
          const peerClient = clientRegistry.get(p.ws);
          if (!peerClient) continue;
          const peerTargets = computeTargets(room, sid, peerClient.session.targetLang);
          reopenUpstreamIfTargetsChanged(peerClient, peerTargets);
        }
        return;
      }

      if (msg.type === 'leave') {
        try { client.upstream?.commit(); } catch { /* ignore */ }
        cleanup(client, 'client-left');
        return;
      }

      if (msg.type === 'audio.commit') {
        try { client.upstream?.commit(); } catch { /* ignore */ }
        return;
      }

      // Toggle captions on/off for THIS participant. Affects only whether caption
      // events are echoed back to them â€” peers still get their own captions per
      // their own setting.
      // Bug 25 Fix: Accept both captions.set and captions-toggle
      if (msg.type === 'captions.set' || msg.type === 'captions-toggle') {
        if (!client.session) return sendErr(ws, 'not-joined', 'not in a call');
        const on = msg.on !== false;
        client.session.captionsOn = on;
        try { ws.send(JSON.stringify({ type: 'captions.set', on })); } catch { /* ignore */ }
        return;
      }

      // Mid-call language change. Closes the current upstream (with a clean close)
      // and re-opens with new languages. Also triggers other speakers' upstreams
      // to re-open so they include this participant's new targetLang.
      if (msg.type === 'lang.change') {
        if (!client.session) return sendErr(ws, 'not-joined', 'not in a call');
        const src = msg.sourceLang ? normalizeLang(msg.sourceLang, 'source') : client.session.sourceLang;
        const tgt = msg.targetLang ? normalizeLang(msg.targetLang, 'target') : client.session.targetLang;
        if (!src) return sendErr(ws, 'bad-lang', `unsupported sourceLang: ${msg.sourceLang}`);
        if (!tgt) return sendErr(ws, 'bad-lang', `unsupported targetLang: ${msg.targetLang}`);
        if (src === client.session.sourceLang && tgt === client.session.targetLang) {
          return; // No-op
        }
        const oldTgt = client.session.targetLang;
        client.session.sourceLang = src;
        client.session.targetLang = tgt;
        log.info(`${client.session.userId} changed langs ${src} â†’ ${tgt}`);

        // Re-open THIS participant's upstream with the new multi-target set.
        try { client.upstream?.close(); } catch { /* ignore */ }
        const newTargets = computeTargets(client.room, client.session.sessionId, tgt);
        if (msg.voice) client.session.voice = normalizeVoice(msg.voice);
        if (msg.tone) client.session.tone = normalizeTone(msg.tone);

        client.upstream = bindUpstream(client,
          {
            sourceLang: src,
            targetLangs: newTargets,
            sessionToken: msg.token ?? '',
            silenceMs: 1500,
            voice: client.session.voice,
            tone: client.session.tone,
          },
          {
            onEvent: (evt) => forwardOllalinkToRoom(client, evt),
            onClose: (code, reasonStr, wasOverloaded) => handleUpstreamClose(client, code, reasonStr, wasOverloaded),
            onError: (err) => sendErr(ws, 'upstream-error', err.message),
          },
        );

        // If this participant's targetLang changed, OTHER speakers' upstreams
        // need to include the new target. Re-open only if targets changed (Bug 10 Fix).
        if (oldTgt !== tgt) {
          for (const [sid, p] of client.room.participants) {
            if (sid === client.session.sessionId) continue;
            const peerClient = clientRegistry.get(p.ws);
            if (!peerClient) continue;
            const peerTargets = computeTargets(client.room, sid, peerClient.session.targetLang);
            reopenUpstreamIfTargetsChanged(peerClient, peerTargets);
          }
        }

        // Notify peers so their UI can update the "from" mapping.
        broadcastToOthers(client, {
          type: 'peer-lang-changed',
          sessionId: client.session.sessionId,
          sourceLang: src,
          targetLang: tgt,
        });
        try {
          ws.send(JSON.stringify({ type: 'lang.changed', sourceLang: src, targetLang: tgt }));
        } catch { /* ignore */ }
        return;
      }

    if (msg.type === 'update-voice-settings') {
        if (!client.session || !client.room) return sendErr(ws, 'not-joined', 'not in a call');
        const newVoice = normalizeVoice(msg.voice || client.session.voice);
        const newTone = normalizeTone(msg.tone || client.session.tone);
        if (newVoice === client.session.voice && newTone === client.session.tone && client.upstream?.isOpen()) {
          return;
        }
        client.session.voice = newVoice;
        client.session.tone = newTone;

        // Re-open upstream Ollalink stream with the updated voice and tone
        if (client.upstream) {
          try { client.upstream.close(); } catch { /* ignore */ }
        }
        const currentTargets = computeTargets(client.room, client.session.sessionId, client.session.targetLang);
        client.upstream = bindUpstream(client, 
          {
            sourceLang: client.session.sourceLang,
            targetLangs: currentTargets,
            sessionToken: client.session.sessionId,
            voice: newVoice,
            tone: newTone,
          },
          {
            onEvent: (evt) => forwardOllalinkToRoom(client, evt),
            onClose: (code, reasonStr, wasOverloaded) => handleUpstreamClose(client, code, reasonStr, wasOverloaded),
            onError: (err) => sendErr(client.ws, 'upstream-error', err.message),
          }
        );
        log.info(`voice settings updated for ${client.session.displayName}: voice=${newVoice} tone=${newTone}`);
        ws.send(JSON.stringify({ type: 'voice.settings.updated', voice: newVoice, tone: newTone }));
        broadcastToOthers(client, {
          type: 'peer-voice-updated',
          sessionId: client.session.sessionId,
          voice: newVoice,
          tone: newTone,
        });
        return;
      }

      return; // unknown JSON frame; ignore
    }

    // Binary PCM from client -> forward immediately to Ollalink.
    // Client already paces at real time (0.5s chunks per Ollalink docs). No server-side queue needed.
    if (!client.upstream?.isOpen()) return;
    try { client.upstream.send(data); } catch { /* ignore */ }
  });

  ws.on('close', () => {
    cleanup(client, 'socket-closed');
    clientRegistry.delete(ws);
  });
  ws.on('error', (err) => {
    log.error('client ws error:', err.message);
    cleanup(client, 'socket-error');
    clientRegistry.delete(ws);
  });

  // Heartbeat: terminate stale clients
  client.heartbeat = setInterval(() => {
    if (!client.isAlive) {
      clearInterval(client.heartbeat);
      if (client.reconnectTimer) {
        clearTimeout(client.reconnectTimer);
        client.reconnectTimer = null;
      }
      cleanup(client, 'heartbeat-timeout');
      return;
    }
    client.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }, 20_000);
  client.heartbeat.unref?.();  // Don't keep the process alive just for pings
});

function publicParticipant(p) {
  return {
    sessionId: p.sessionId,
    displayName: p.displayName,
    sourceLang: p.sourceLang,
    targetLang: p.targetLang,
    voice: p.voice || 'nh-m01',
    tone: p.tone || 'natural',
    captionsOn: p.captionsOn !== false,
    joinedAt: p.joinedAt,
  };
}

/**
 * Compute the target languages a speaker's upstream should produce.
 * The speaker hears nothing (they are the source); everyone else wants the
 * speaker's voice in THEIR target language. Deduplicated.
 */

function areTargetsEqual(arr1, arr2) {
  if (!arr1 || !arr2) return false;
  const a = Array.isArray(arr1) ? arr1 : Array.from(arr1);
  const b = Array.isArray(arr2) ? arr2 : Array.from(arr2);
  if (a.length !== b.length) return false;
  const sA = Array.from(new Set(a)).sort();
  const sB = Array.from(new Set(b)).sort();
  if (sA.length !== sB.length) return false;
  return sA.every((v, i) => v === sB[i]);
}

function reopenUpstreamIfTargetsChanged(peerClient, newTargets) {
  if (!peerClient || !peerClient.session) return false;
  if (areTargetsEqual(peerClient.currentTargetLangs, newTargets) && (peerClient.upstream?.isOpen() || peerClient.upstream?.isConfigured?.())) {
    return false; // Target languages have not changed; avoid dropping audio or wasting concurrency
  }

  log.info(`Updating upstream targets for ${peerClient.session.sessionId}: [${peerClient.currentTargetLangs || ''}] -> [${newTargets}]`);
  try { peerClient.upstream?.close(); } catch { /* ignore */ }
  peerClient.upstream = bindUpstream(peerClient,
    {
      sourceLang: peerClient.session.sourceLang,
      targetLangs: newTargets,
      sessionToken: peerClient.session.sessionId || '',
      voice: peerClient.session.voice,
      tone: peerClient.session.tone,
    },
    {
      onEvent: (evt) => forwardOllalinkToRoom(peerClient, evt),
      onClose: (code, reasonStr, wasOverloaded) => handleUpstreamClose(peerClient, code, reasonStr, wasOverloaded),
      onError: (err) => sendErr(peerClient.ws, 'upstream-error', err.message),
    },
  );
  return true;
}

function handleUpstreamOverloaded(client, evt) {
  log.warn(`[OLLALINK OVERLOADED] Upstream overloaded for session=${client.session?.sessionId || 'anon'}:`, evt.payload);
  
  // Bug 8 Fix: Notify client to slow down / pace frames
  if (client.ws?.readyState === 1) {
    try {
      client.ws.send(JSON.stringify({
        type: 'warning',
        code: 'overloaded',
        message: 'Audio sent faster than real time. Please pace frames at real-time rate.',
      }));
    } catch {}
  }

  // Clear backlogged queue so we don't immediately burst into the new stream
  if (client.upstreamQueue) {
    client.upstreamQueue = client.upstreamQueue.slice(-2);
    client.upstreamPacingActive = false;
  }

  client._lastOverloaded = Date.now();
  scheduleUpstreamReconnect(client, { reason: 'overloaded', backoff: true });
}

function scheduleUpstreamReconnect(client, { reason = 'error', backoff = true } = {}) {
  if (client._cleaned || !client.room || !client.session || client.ws?.readyState !== 1) {
    return;
  }

  // Bug 26 & 28 Fix: Cancel any active pacing timer and trim stale queue on all reconnect paths
  if (client.upstreamPacingTimer) {
    clearTimeout(client.upstreamPacingTimer);
    client.upstreamPacingTimer = null;
  }
  client.upstreamPacingActive = false;
  if (client.upstreamQueue) {
    client.upstreamQueue = client.upstreamQueue.slice(-2);
  }

  if (client.reconnectTimer) {
    clearTimeout(client.reconnectTimer);
    client.reconnectTimer = null;
  }

  client.reconnectAttempts = (client.reconnectAttempts || 0) + 1;
  if (client.reconnectAttempts > 5) {
    log.error(`[RECONNECT GAVE UP] session=${client.session.sessionId} after ${client.reconnectAttempts} attempts`);
    sendErr(client.ws, 'upstream-reconnect-failed', 'Failed to reconnect Ollalink stream after multiple attempts');
    broadcastToOthers(client, { type: 'peer-upstream-closed', from: client.session.sessionId });
    return;
  }

  const delayMs = backoff
    ? Math.min(3000, Math.floor(300 * Math.pow(1.5, client.reconnectAttempts - 1)))
    : 100;

  log.warn(`[RECONNECT SCHEDULED] session=${client.session.sessionId} reason=${reason} attempt=${client.reconnectAttempts} delay=${delayMs}ms`);

  try {
    client.ws.send(JSON.stringify({
      type: 'upstream-reconnecting',
      reason,
      attempt: client.reconnectAttempts,
      delayMs,
    }));
  } catch {}

  client.reconnectTimer = setTimeout(() => {
    client.reconnectTimer = null;
    if (client._cleaned || !client.room || !client.session || client.ws?.readyState !== 1) return;

    try { client.upstream?.close(); } catch {}

    const targets = computeTargets(client.room, client.session.sessionId, client.session.targetLang);
    client.upstream = bindUpstream(client, {
      sourceLang: client.session.sourceLang,
      targetLangs: targets,
      sessionToken: client.session.sessionId || '',
      voice: client.session.voice,
      tone: client.session.tone,
    }, {
      onEvent: (evt) => forwardOllalinkToRoom(client, evt),
      onClose: (code, reasonStr, wasOverloaded) => handleUpstreamClose(client, code, reasonStr, wasOverloaded),
      onError: (err) => sendErr(client.ws, 'upstream-error', err.message),
    });
  }, delayMs);
}

function handleUpstreamClose(client, code, reasonStr, wasOverloaded) {
  // Always broadcast peer-upstream-closed to peers so they immediately know upstream closed
  if (client.room && client.session) {
    broadcastToOthers(client, { type: 'peer-upstream-closed', from: client.session.sessionId });
  }

  if (client._cleaned || !client.room || !client.session || client.ws?.readyState !== 1) {
    return;
  }

  const isOverloadClose = wasOverloaded || (Date.now() - (client._lastOverloaded || 0) < 2000);
  if (isOverloadClose) {
    log.warn(`[UPSTREAM OVERLOAD CLOSE] code=${code} reason=${reasonStr} for session=${client.session.sessionId}`);
    // Bug 27 Fix: If reconnect was already scheduled on overload event, do not double-increment
    if (client.reconnectTimer) {
      log.info(`[UPSTREAM OVERLOAD CLOSE] Reconnect already scheduled for session=${client.session.sessionId}`);
      return;
    }
    scheduleUpstreamReconnect(client, { reason: 'overloaded', backoff: true });
    return;
  }

  if (code && code !== 1000) {
    log.info(`[UPSTREAM ABNORMAL CLOSE] code=${code} for session=${client.session.sessionId}, attempting reconnect`);
    scheduleUpstreamReconnect(client, { reason: 'abnormal-close', backoff: true });
    return;
  }
}


// Issue 2 & Bug 13 Fix: Inspect config_applied.tts.lanes, capabilities, voice fallback, and translation targets on session.ready
export function inspectSessionReadyConfig(client, payload) {
  if (!client || !payload) return;

  const configApplied = payload.config_applied || payload.config || {};
  const tts = configApplied.tts || {};
  const rawLanes = tts.lanes || payload.lanes;

  if (!client.targetLanes) {
    client.targetLanes = {};
  }

  // Bug 29 & 30 Fix: Map array of strings to target languages correctly and normalize keys
  if (rawLanes && typeof rawLanes === 'object') {
    if (Array.isArray(rawLanes)) {
      const targetLangs = client.currentTargetLangs || (client.session?.targetLang ? [client.session.targetLang] : ['default']);
      rawLanes.forEach((item, idx) => {
        if (typeof item === 'string') {
          const isStream = item.toLowerCase() === 'stream' || item.toLowerCase() === 'pcm';
          const rawLang = targetLangs[idx] || targetLangs[0] || 'default';
          const lang = rawLang.toLowerCase().split(/[-_]/)[0];
          client.targetLanes[lang] = {
            lane: item,
            codec: isStream ? 'pcm_s16le' : 'wav',
            sampleRate: isStream ? 48000 : 24000,
          };
        } else if (item && typeof item === 'object' && item.language) {
          const isStream = String(item.lane).toLowerCase() === 'stream';
          const lang = item.language.toLowerCase().split(/[-_]/)[0];
          client.targetLanes[lang] = {
            lane: item.lane,
            codec: isStream ? 'pcm_s16le' : 'wav',
            sampleRate: isStream ? 48000 : 24000,
          };
        }
      });
    } else {
      for (const [langKey, lane] of Object.entries(rawLanes)) {
        const isStream = String(lane).toLowerCase() === 'stream' || String(lane).toLowerCase() === 'pcm';
        const lang = langKey.toLowerCase().split(/[-_]/)[0];
        client.targetLanes[lang] = {
          lane,
          codec: isStream ? 'pcm_s16le' : 'wav',
          sampleRate: isStream ? 48000 : 24000,
        };
      }
    }
  }

  // 2. Verify capabilities includes "tts" and "translation" (Bug 13 Fix)
  const capabilities = payload.capabilities || configApplied.capabilities || [];
  if (Array.isArray(capabilities) && capabilities.length > 0) {
    const missingCaps = [];
    if (!capabilities.includes('tts')) missingCaps.push('tts');
    if (!capabilities.includes('translation')) missingCaps.push('translation');

    if (missingCaps.length > 0) {
      log.warn(`[OLLALINK READY] Warning: session=${client.session?.sessionId || 'anon'} missing capabilities: [${missingCaps.join(', ')}]. Granted: [${capabilities.join(', ')}]`);
      if (client.ws?.readyState === 1) {
        try {
          client.ws.send(JSON.stringify({
            type: 'warning',
            code: 'capability_missing',
            message: `Upstream did not enable capabilities: ${missingCaps.join(', ')}`,
            missingCapabilities: missingCaps,
            grantedCapabilities: capabilities,
          }));
        } catch {}
      }
    }
  }

  // 3. Verify tts_voice matches requested voice and update session metadata on fallback (Bug 13 Fix)
  const requestedVoice = client.upstreamOpts?.voice || client.session?.voice || 'nh-m01';
  const appliedVoice = tts.voice || payload.tts_voice || payload.voice;
  if (appliedVoice && appliedVoice !== requestedVoice) {
    log.warn(`[OLLALINK READY] Voice fallback detected for session=${client.session?.sessionId || 'anon'}: requested=${requestedVoice}, applied=${appliedVoice}`);
    if (client.session) {
      client.session.voice = appliedVoice;
    }
    if (client.upstreamOpts) {
      client.upstreamOpts.voice = appliedVoice;
    }
    if (client.ws?.readyState === 1) {
      try {
        client.ws.send(JSON.stringify({
          type: 'voice.settings.updated',
          voice: appliedVoice,
          requestedVoice,
          fallback: true,
          message: `Requested voice '${requestedVoice}' was rejected or unavailable; fell back to '${appliedVoice}'.`,
        }));
      } catch {}
    }
    if (client.room && client.session) {
      broadcastToOthers(client, {
        type: 'peer-voice-updated',
        sessionId: client.session.sessionId,
        voice: appliedVoice,
      });
    }
  }

  // 4. Verify config_applied.translation.targets matches requested targets (Bug 13 Fix)
  const translationApplied = configApplied.translation || payload.translation || {};
  const appliedTargets = translationApplied.targets || payload.targets;
  if (Array.isArray(appliedTargets) && client.currentTargetLangs) {
    const requestedTargets = client.currentTargetLangs;
    const missingTargets = requestedTargets.filter(t => !appliedTargets.includes(t));
    if (missingTargets.length > 0) {
      log.warn(`[OLLALINK READY] Translation targets mismatch for session=${client.session?.sessionId || 'anon'}: requested=[${requestedTargets.join(', ')}], applied=[${appliedTargets.join(', ')}], missing=[${missingTargets.join(', ')}]`);
      client.currentTargetLangs = appliedTargets.slice();
      if (client.ws?.readyState === 1) {
        try {
          client.ws.send(JSON.stringify({
            type: 'warning',
            code: 'targets_truncated',
            message: `Upstream did not enable translation targets: ${missingTargets.join(', ')}`,
            appliedTargets,
            missingTargets,
          }));
        } catch {}
      }
    }
  }

  log.info(`[OLLALINK READY] session=${client.session?.sessionId || 'anon'} pre-cached lanes:`, client.targetLanes);
}

function bindUpstream(clientOwner, opts, handlers = {}) {
  clientOwner.upstreamGen = (clientOwner.upstreamGen || 0) + 1;
  const currentGen = clientOwner.upstreamGen;
  if (clientOwner.upstreamPacingTimer) {
    clearTimeout(clientOwner.upstreamPacingTimer);
    clientOwner.upstreamPacingTimer = null;
  }
  clientOwner.upstreamPacingActive = false;
  clientOwner.currentTargetLangs = Array.isArray(opts.targetLangs)
    ? opts.targetLangs.slice()
    : Array.from(opts.targetLangs);
  clientOwner.upstreamOpts = { ...opts };

  return openOllalinkStream(opts, {
    ...handlers,
    onReady: (readyPayload) => {
      if (clientOwner.upstreamGen !== currentGen) return;
      clientOwner.reconnectAttempts = 0;
      if (readyPayload) inspectSessionReadyConfig(clientOwner, readyPayload);
      schedulePacedUpstreamSend(clientOwner);
      if (handlers.onReady) handlers.onReady(readyPayload);
    },
    onEvent: (evt) => {
      if (clientOwner.upstreamGen !== currentGen) return;
      if (evt.kind === 'overloaded' || (evt.kind === 'error' && evt.isOverloaded)) {
        handleUpstreamOverloaded(clientOwner, evt);
        return;
      }
      if (handlers.onEvent) handlers.onEvent(evt);
      else forwardOllalinkToRoom(clientOwner, evt);
    },
    onClose: (code, reasonStr, wasOverloaded) => {
      if (clientOwner.upstreamGen !== currentGen) return;
      if (handlers.onClose) handlers.onClose(code, reasonStr, wasOverloaded);
      else handleUpstreamClose(clientOwner, code, reasonStr, wasOverloaded);
    },
    onError: (err) => {
      if (clientOwner.upstreamGen !== currentGen) return;
      if (handlers.onError) handlers.onError(err);
    },
  });
}

function computeTargets(room, selfSessionId, selfTargetLang) {
  const targets = new Set();
  for (const [sid, p] of room.participants) {
    if (sid === selfSessionId) continue;
    targets.add(p.targetLang);
  }
  // Defensive: if nobody else is here yet, still produce the speaker's own
  // target (acts as a self-monitor path). Sound-stream will just emit audio
  // nobody listens to until a peer joins.
  if (targets.size === 0) targets.add(selfTargetLang);
  return Array.from(targets);
}

function sendErr(ws, code, message) {
  try { ws.send(JSON.stringify({ type: 'error', code, message })); } catch { /* ignore */ }
}

function broadcastToOthers(client, msg) {
  if (!client.room || !client.session) return;
  const buf = JSON.stringify(msg);
  for (const peer of others(client.room.code, client.session.sessionId)) {
    if (peer.ws && peer.ws.readyState === 1) {
      try { peer.ws.send(buf); } catch { /* ignore */ }
    }
  }
}

/**
 * Route an upstream Ollalink event for `client` to the right listeners.
 *
 * Sound-stream can fan out one speaker to multiple target languages in a
 * single upstream session. Each `audio` event carries a `language` field â€”
 * route it to the peer whose targetLang matches.
 *
 * Captions similarly carry a `language` (target) for translation events and
 * the source language for transcript events. We honor `captionsOn` per peer.
 */

// Bug 6 & Bug 10 Fix: Real-time paced send queue per upstream Ollalink connection
// Prevents network jitter bursts from delivering audio faster than real-time to Ollalink (code 1006 / overloaded),
// and buffers frames without dropping while upstream connects/re-opens.
export function schedulePacedUpstreamSend(client) {
  if (client.upstreamPacingActive) return;
  if (!client.upstreamQueue || client.upstreamQueue.length === 0) return;
  if (!client.upstream) {
    client.upstreamQueue = [];
    return;
  }
  // If upstream is still establishing handshake (session.configure -> session.ready),
  // hold the audio in queue instead of dropping it (Bug 10 Fix: Eliminates 1s audio drop on re-open)
  if (!client.upstream.isOpen() || !client.upstream.isConfigured?.()) {
    return;
  }

  client.upstreamPacingActive = true;
  const chunk = client.upstreamQueue.shift();
  try {
    client.upstream.send(chunk);
  } catch (err) {
    log.error('upstream send error:', err);
    client.upstreamPacingActive = false;
    return;
  }

  // Calculate real-time duration of this PCM chunk (16kHz mono s16le = 32 bytes/ms)
  const durationMs = Math.max(10, Math.min(100, Math.floor(chunk.length / 32)));

  // Bug 28 Fix: Store timer handle to cancel on reconnect
  if (client.upstreamPacingTimer) {
    clearTimeout(client.upstreamPacingTimer);
  }
  client.upstreamPacingTimer = setTimeout(() => {
    client.upstreamPacingTimer = null;
    client.upstreamPacingActive = false;
    schedulePacedUpstreamSend(client);
  }, durationMs);
}

export function forwardOllalinkToRoom(client, evt) {
  if (!client.session || !client.room) return;

  // -------- AUDIO (spoken translated voice) --------
  if (evt.kind === 'audio') {
    const p = evt.payload;
    // End-of-utterance marker has pcm=null. Skip binary forward, but emit a
    // marker so peers can flush their playback.
    const marker = p.last === true && !p.pcm;

    const peers = Array.from(others(client.room.code, client.session.sessionId));
    // Self-monitor audio return is disabled when alone (prevents acoustic feedback loop and self-echo)
    if (peers.length === 0) {
      return;
    }

    for (const peer of peers) {
      const targetWs = peer.ws;
      // Do not send if target is missing, not ready, or pointing to client (speaker)
      if (!targetWs || targetWs === client.ws || targetWs.readyState !== 1) continue;
      
      // Check target language match (supports ISO prefixes like 'hi-IN' matching 'hi'):
      if (p.language && peer.targetLang) {
        const pBase = p.language.split(/[-_]/)[0].toLowerCase().trim();
        const peerBase = peer.targetLang.split(/[-_]/)[0].toLowerCase().trim();
        if (pBase !== peerBase) continue;
      }
      // Bug 30 Fix: Match targetLanes with or without region tag (e.g. 'hi-IN' matches 'hi')
      const langBase = (p.language || '').toLowerCase().split(/[-_]/)[0].trim();
      const cachedLane = client.targetLanes?.[langBase] || client.targetLanes?.[(p.language || '').toLowerCase().trim()];
      const finalCodec = (p.explicitCodec ? p.codec : (cachedLane?.codec || p.codec)) || 'pcm_s16le';
      const finalRate = (p.explicitSampleRate ? p.sampleRate : (cachedLane?.sampleRate || p.sampleRate)) || (finalCodec === 'wav' ? 24000 : 48000);

      try {
        targetWs.send(JSON.stringify({
          type: 'audio',
          from: client.session.sessionId,
          lang: p.language,
          codec: finalCodec,
          sampleRate: finalRate,
          chunkSeq: p.chunkSeq,
          last: p.last,
          endOfUtterance: marker,
          hasBinary: !!p.pcm,
          utteranceId: p.utteranceId,
        }));
        if (p.pcm) targetWs.send(p.pcm, { binary: true });
      } catch { /* ignore */ }
    }
    return;
  }

  // -------- CAPTIONS / TRANSLATION / SPEECH BOUNDARIES / WARNINGS / ERRORS --------
  const frame = JSON.stringify({
    type: 'caption',
    kind: evt.kind,
    from: client.session.sessionId,
    payload: evt.payload,
  });

  // Peer captions: route to those who want them.
  for (const peer of others(client.room.code, client.session.sessionId)) {
    if (peer.ws?.readyState !== 1) continue;
    if (peer.captionsOn === false) continue;
    // Translations target a specific language; only send the matching one.
    if (evt.kind === 'translation' || evt.kind === 'translation-delta') {
      const t = evt.payload?.language ?? evt.payload?.lang;
      if (t && peer.targetLang !== t) continue;
    }
    try { peer.ws.send(frame); } catch { /* ignore */ }
  }

  // Speaker echo: transcripts/finals in their own source lang + translation rows
  // in their own target, so they can debug what they said vs what came out.
  if (client.session.captionsOn !== false && client.ws?.readyState === 1) {
    try { client.ws.send(frame); } catch { /* ignore */ }
  }
}

function cleanup(client, reason) {
  if (client._cleaned) return;
  client._cleaned = true;
  log.info(`cleanup (${reason}) session=${client.session?.sessionId ?? 'anon'}`);

  clearInterval(client.heartbeat);
  try { client.upstream?.commit(); } catch { /* ignore */ }
  try { client.upstream?.close(); } catch { /* ignore */ }

  if (client.room && client.session) {
    // Bug C fix: If this client connection was replaced by a newer connection for the same session/user,
    // do NOT broadcast peer-left and do NOT evict the new participant from the room!
    if (!client._replacedByNewConnection) {
      const active = client.room.participants.get(client.session.sessionId);
      if (!active || active.ws === client.ws) {
        broadcastToOthers(client, { type: 'peer-left', sessionId: client.session.sessionId });
        leaveRoom(client.room.code, client.session.sessionId, client.ws);
      } else {
        log.info(`cleanup: skipping peer-left & leaveRoom for ${client.session.sessionId} (newer connection is active)`);
      }
    } else {
      log.info(`cleanup: skipping peer-left & leaveRoom for ${client.session.sessionId} (marked replaced by newer connection)`);
    }
  }
  try { client.ws.terminate(); } catch { /* ignore */ }
}

// ---------- boot ----------

export function startServer() {
  server.listen(config.port, () => {
    log.info(`ollalink-translate relay listening on http://localhost:${config.port}`);
    log.info(`ws endpoint: ${config.publicBase}/call`);
    log.info(`upstream ollalink: ${config.ollalinkWsUrl} (key ending â€¦${config.ollalinkKey.slice(-6)})`);
  });
  return {
    async close() {
      // Terminate all WS clients (client-initiated cleanup runs inside the close handler)
      for (const ws of wss.clients) {
        try { ws.terminate(); } catch { /* ignore */ }
      }
      await new Promise((resolve) => wss.close(resolve));
      // Track + close any pending HTTP sockets (Node 18+)
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Only auto-start when run as the main module, NOT when imported by tests.
const isMain = process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  startServer();
  startRoomSweeper();
}

// In tests, `startServer` is invoked directly â€” `startRoomSweeper` is exported
// so the test driver controls whether the sweeper runs. This keeps test
// processes from hanging on a long-lived interval.

process.on('unhandledRejection', (err) => {
  log.error('unhandledRejection:', err);
});
process.on('uncaughtException', (err) => {
  log.error('uncaughtException:', err);
  process.exit(1);
});



// Graceful termination for production Docker / Kubernetes / Cloud instances
const handleSignal = async (signal) => {
  log.info(`Received ${signal}, initiating graceful shutdown...`);
  for (const ws of wss.clients) {
    try {
      ws.send(JSON.stringify({ type: 'server-shutdown', reason: 'restarting' }));
      ws.close(1001, 'server shutting down');
    } catch {}
  }
  setTimeout(() => process.exit(0), 1000);
};
process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT', () => handleSignal('SIGINT'));
