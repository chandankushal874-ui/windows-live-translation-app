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
import { openOllalinkStream } from './ollalink.js';
import { normalizeLang, hasProductionVoice, SOUND_STREAM_SOURCES, SOUND_STREAM_TARGETS, CAPTION_TARGETS_22, VOICE_PERSONAS, VOICE_TONES, normalizeVoice, normalizeTone } from './langs.js';

// ---------- HTTP ----------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

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
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          token: session.token,
          expiresAt: session.expiresAt,
          sessionId: session.sessionId,
          wsUrl: `${config.publicBase.replace(/^http(s)?:/i, 'ws$1:')}/call`,
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
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          token: session.token,
          expiresAt: session.expiresAt,
          sessionId: session.sessionId,
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
          if (p.userId === sessionPayload.sub && sid !== sessionPayload.sid) {
            log.warn(`removing stale participant for userId=${p.userId} (old sid ${sid})`);
            try { p.ws?.terminate(); } catch { /* ignore */ }
            room.participants.delete(sid);
            broadcastToOthers(client, { type: 'peer-left', sessionId: sid });
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
        client.upstream = openOllalinkStream(
          {
            sourceLang: participant.sourceLang,
            targetLangs: initialTargets,
            sessionToken: msg.token,
            voice: participant.voice,
            tone: participant.tone,
          },
          {
            onEvent: (evt) => forwardOllalinkToRoom(client, evt),
            onClose: () => broadcastToOthers(client, { type: 'peer-upstream-closed', from: participant.sessionId }),
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

        // Re-open each existing peer's upstream to include the new participant's
        // targetLang in the multi-target set. Without this, alice's upstream
        // (opened when she was alone) only produces her own fallback target;
        // bob's targetLang would be missing.
        for (const [sid, p] of room.participants) {
          if (sid === sessionPayload.sid) continue;
          const peerClient = clientRegistry.get(p.ws);
          if (!peerClient || !peerClient.upstream) continue;
          const peerTargets = computeTargets(room, sid, peerClient.session.targetLang);
          try { peerClient.upstream?.close(); } catch { /* ignore */ }
          peerClient.upstream = openOllalinkStream(
            {
              sourceLang: peerClient.session.sourceLang,
              targetLangs: peerTargets,
              sessionToken: peerClient.session.sessionId || '',
              voice: peerClient.session.voice,
              tone: peerClient.session.tone,
            },
            {
              onEvent: (evt) => forwardOllalinkToRoom(peerClient, evt),
              onClose: () => broadcastToOthers(peerClient, { type: 'peer-upstream-closed', from: peerClient.session.sessionId }),
              onError: (err) => sendErr(peerClient.ws, 'upstream-error', err.message),
            },
          );
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
      if (msg.type === 'captions.set') {
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
        client.upstream = openOllalinkStream(
          { sourceLang: src, targetLangs: newTargets, sessionToken: msg.token ?? '' },
          {
            onEvent: (evt) => forwardOllalinkToRoom(client, evt),
            onClose: () => broadcastToOthers(client, { type: 'peer-upstream-closed', from: client.session.sessionId }),
            onError: (err) => sendErr(ws, 'upstream-error', err.message),
          },
        );

        // If this participant's targetLang changed, OTHER speakers' upstreams
        // need to include the new target. Re-open each peer's upstream.
        if (oldTgt !== tgt) {
          for (const [sid, p] of client.room.participants) {
            if (sid === client.session.sessionId) continue;
            const peerClient = clientRegistry.get(p.ws);
            if (!peerClient || !peerClient.upstream) continue;
            const peerTargets = computeTargets(client.room, sid, peerClient.session.targetLang);
            try { peerClient.upstream?.close(); } catch { /* ignore */ }
            peerClient.upstream = openOllalinkStream(
              {
                sourceLang: peerClient.session.sourceLang,
                targetLangs: peerTargets,
                sessionToken: '',
                voice: peerClient.session.voice,
                tone: peerClient.session.tone,
              },
              {
                onEvent: (evt) => forwardOllalinkToRoom(peerClient, evt),
                onClose: () => broadcastToOthers(peerClient, { type: 'peer-upstream-closed', from: peerClient.session.sessionId }),
                onError: (err) => sendErr(peerClient.ws, 'upstream-error', err.message),
              },
            );
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
        client.session.voice = newVoice;
        client.session.tone = newTone;

        // Re-open upstream Ollalink stream with the updated voice and tone
        if (client.upstream) {
          try { client.upstream.close(); } catch { /* ignore */ }
        }
        const currentTargets = computeTargets(client.room, client.session.sessionId, client.session.targetLang);
        client.upstream = openOllalinkStream(
          {
            sourceLang: client.session.sourceLang,
            targetLangs: currentTargets,
            sessionToken: client.session.sessionId,
            voice: newVoice,
            tone: newTone,
          },
          {
            onEvent: (evt) => forwardOllalinkToRoom(client, evt),
            onClose: () => broadcastToOthers(client, { type: 'peer-upstream-closed', from: client.session.sessionId }),
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

    // Binary PCM from app â†’ forward to Ollalink for this participant.
    if (!client.upstream?.isOpen()) return;
    client.upstream.send(data);
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
      cleanup(client, 'heartbeat-timeout');
      return;
    }
    client.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }, 5_000);
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
function forwardOllalinkToRoom(client, evt) {
  if (!client.session || !client.room) return;

  // -------- AUDIO (spoken translated voice) --------
  if (evt.kind === 'audio') {
    const p = evt.payload;
    // End-of-utterance marker has pcm=null. Skip binary forward, but emit a
    // marker so peers can flush their playback.
    const marker = p.last === true && !p.pcm;

    const peers = others(client.room.code, client.session.sessionId);
    const recipients = peers.length > 0 ? peers : [client.session];

    for (const peer of recipients) {
      if (peer.ws?.readyState !== 1) continue;
      
      // Check target language match (supports ISO prefixes like 'hi-IN' matching 'hi'):
      if (p.language && peer.targetLang) {
        const pBase = p.language.split(/[-_]/)[0].toLowerCase().trim();
        const peerBase = peer.targetLang.split(/[-_]/)[0].toLowerCase().trim();
        if (pBase !== peerBase) continue;
      }

      try {
        peer.ws.send(JSON.stringify({
          type: 'audio',
          from: client.session.sessionId,
          lang: p.language,
          codec: p.codec,
          sampleRate: p.sampleRate,
          chunkSeq: p.chunkSeq,
          last: p.last,
          endOfUtterance: marker,
          hasBinary: !!p.pcm,
          utteranceId: p.utteranceId,
        }));
        if (p.pcm) peer.ws.send(p.pcm, { binary: true });
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
    broadcastToOthers(client, { type: 'peer-left', sessionId: client.session.sessionId });
    leaveRoom(client.room.code, client.session.sessionId);
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
