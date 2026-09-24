import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';

process.env.PORT = '33890';
process.env.PUBLIC_BASE = 'ws://localhost:33890';
process.env.OLLALINK_DASHBOARD_KEY = 'sk_f439f7e7394139022af3b458a76008e86e1ba0b93e497207';
process.env.OLLALINK_WS_URL = 'ws://127.0.0.1:33891/v1/speech/stream';
process.env.SESSION_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_TTL_SECONDS = '1800';
process.env.ALLOWED_ORIGINS = 'http://localhost:1420,tauri://localhost';
process.env.LOG_LEVEL = 'error';

const { startServer } = await import('../src/server.js');

let relayHandle;
let mockOllalinkWss;
const upstreamSessions = [];

before(async () => {
  mockOllalinkWss = new WebSocketServer({ port: 33891, path: '/v1/speech/stream' });
  mockOllalinkWss.on('connection', (ws, req) => {
    const session = { ws, req, received: [], config: null };
    upstreamSessions.push(session);
    ws.on('message', (data, isBinary) => {
      session.received.push({ data, isBinary });
      if (!isBinary) {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'session.configure') {
            session.config = parsed;
            ws.send(JSON.stringify({ type: 'session.created' }));
            ws.send(JSON.stringify({
              type: 'session.ready',
              capabilities: ['transcription', 'translation', 'tts'],
              translation_targets: parsed.translation?.targets ?? [],
              tts_voice: parsed.tts?.voice ?? 'nh-m01',
              config_applied: { tts: { lanes: { hi: 'stream', en: 'stream', es: 'stream', fr: 'stream' } } },
            }));
          }
        } catch {}
      }
    });
  });

  relayHandle = startServer();
  await new Promise((r) => setTimeout(r, 200));
});

after(async () => {
  for (const s of upstreamSessions) {
    try { s.ws.terminate(); } catch {}
  }
  if (mockOllalinkWss) await new Promise((r) => mockOllalinkWss.close(r));
  if (relayHandle) await relayHandle.close();
});

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `http://localhost:33890${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let out = '';
        res.on('data', (d) => (out += d));
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(out || '{}') }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function waitType(ws, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const handler = (data, isBinary) => {
      if (!isBinary) {
        try {
          const m = JSON.parse(data.toString());
          if (m.type === type) {
            clearTimeout(timer);
            ws.off('message', handler);
            resolve(m);
          }
        } catch {}
      }
    };
    ws.on('message', handler);
  });
}

function waitAudioPair(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let pendingHeader = null;
    const timer = setTimeout(() => reject(new Error('timeout waiting for audio pair')), timeoutMs);
    const handler = (data, isBinary) => {
      if (!isBinary) {
        try {
          const m = JSON.parse(data.toString());
          if (m.type === 'audio') {
            if (m.hasBinary === false || m.endOfUtterance === true) {
              clearTimeout(timer);
              ws.off('message', handler);
              resolve({ header: m, body: null });
            } else {
              pendingHeader = m;
            }
          }
        } catch {}
      } else if (pendingHeader) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve({ header: pendingHeader, body: Buffer.from(data) });
      }
    };
    ws.on('message', handler);
  });
}

// ---------------------------------------------------------------------------
// TEST 1: Full-Duplex Simultaneous Speech (Double-Talk)
// ---------------------------------------------------------------------------
test('Full-Duplex Double-Talk: Alice and Bob speaking concurrently without interference', async () => {
  const roomRes = await httpPost('/api/rooms', {});
  const code = roomRes.data.code;

  const aliceSess = await httpPost('/api/session', { userId: 'alice', sourceLang: 'en', targetLang: 'en' });
  const bobSess = await httpPost('/api/session', { userId: 'bob', sourceLang: 'hi', targetLang: 'hi' });

  const aliceWs = new WebSocket(aliceSess.data.wsUrl);
  const bobWs = new WebSocket(bobSess.data.wsUrl);
  await Promise.all([new Promise((r) => aliceWs.on('open', r)), new Promise((r) => bobWs.on('open', r))]);

  aliceWs.send(JSON.stringify({ type: 'join', token: aliceSess.data.token, room: code, displayName: 'Alice' }));
  await waitType(aliceWs, 'joined');
  bobWs.send(JSON.stringify({ type: 'join', token: bobSess.data.token, room: code, displayName: 'Bob' }));
  await waitType(bobWs, 'joined');

  await new Promise((r) => setTimeout(r, 200));

  const aliceUpstream = upstreamSessions.filter((s) => s.config?.recognition?.language === 'en').pop();
  const bobUpstream = upstreamSessions.filter((s) => s.config?.recognition?.language === 'hi').pop();
  assert.ok(aliceUpstream && bobUpstream);

  // Both speak concurrently at the same instant
  const aliceMicData = Buffer.alloc(640, 0x11);
  const bobMicData = Buffer.alloc(640, 0x22);
  aliceWs.send(aliceMicData);
  bobWs.send(bobMicData);

  await new Promise((r) => setTimeout(r, 100));

  // Both upstreams deliver translated audio back concurrently
  const bobReceivesAudio = waitAudioPair(bobWs);
  const aliceReceivesAudio = waitAudioPair(aliceWs);

  const hindiAudio = Buffer.from([0xaa, 0xbb]);
  const englishAudio = Buffer.from([0xcc, 0xdd]);

  aliceUpstream.ws.send(JSON.stringify({
    type: 'translation.audio',
    codec: 'pcm_s16le',
    sample_rate: 48000,
    language: 'hi',
    chunk_seq: 1,
    last: false,
    audio_b64: hindiAudio.toString('base64'),
  }));

  bobUpstream.ws.send(JSON.stringify({
    type: 'translation.audio',
    codec: 'pcm_s16le',
    sample_rate: 48000,
    language: 'en',
    chunk_seq: 1,
    last: false,
    audio_b64: englishAudio.toString('base64'),
  }));

  const [toBob, toAlice] = await Promise.all([bobReceivesAudio, aliceReceivesAudio]);

  assert.equal(toBob.header.lang, 'hi');
  assert.deepEqual(toBob.body, hindiAudio);

  assert.equal(toAlice.header.lang, 'en');
  assert.deepEqual(toAlice.body, englishAudio);

  aliceWs.close();
  bobWs.close();
});

// ---------------------------------------------------------------------------
// TEST 2: Multi-Party 4-Seat Room with 3-Way Target Language Fanout
// ---------------------------------------------------------------------------
test('Multi-Party Room (4 seats): Alice speaks EN -> Bob hears HI, Carlos hears ES', async () => {
  // Create room with capacity for up to 4
  const roomRes = await httpPost('/api/rooms', { maxParticipants: 4 });
  assert.equal(roomRes.data.maxParticipants, 4);
  const code = roomRes.data.code;

  const aliceSess = await httpPost('/api/session', { userId: 'alice', sourceLang: 'en', targetLang: 'en' });
  const bobSess = await httpPost('/api/session', { userId: 'bob', sourceLang: 'hi', targetLang: 'hi' });
  const carlosSess = await httpPost('/api/session', { userId: 'carlos', sourceLang: 'es', targetLang: 'es' });

  const aliceWs = new WebSocket(aliceSess.data.wsUrl);
  const bobWs = new WebSocket(bobSess.data.wsUrl);
  const carlosWs = new WebSocket(carlosSess.data.wsUrl);

  await Promise.all([
    new Promise((r) => aliceWs.on('open', r)),
    new Promise((r) => bobWs.on('open', r)),
    new Promise((r) => carlosWs.on('open', r)),
  ]);

  aliceWs.send(JSON.stringify({ type: 'join', token: aliceSess.data.token, room: code, displayName: 'Alice' }));
  await waitType(aliceWs, 'joined');

  bobWs.send(JSON.stringify({ type: 'join', token: bobSess.data.token, room: code, displayName: 'Bob' }));
  await waitType(bobWs, 'joined');

  carlosWs.send(JSON.stringify({ type: 'join', token: carlosSess.data.token, room: code, displayName: 'Carlos' }));
  await waitType(carlosWs, 'joined');

  await new Promise((r) => setTimeout(r, 200));

  // Alice's active upstream must now have BOTH 'hi' and 'es' in translation.targets!
  const aliceUpstream = upstreamSessions.filter((s) => s.config?.recognition?.language === 'en').pop();
  assert.ok(aliceUpstream);
  assert.ok(aliceUpstream.config.translation.targets.includes('hi'), 'Targets include hi');
  assert.ok(aliceUpstream.config.translation.targets.includes('es'), 'Targets include es');

  // Upstream emits Hindi audio (for Bob) and Spanish audio (for Carlos)
  const bobAudioPromise = waitAudioPair(bobWs);
  const carlosAudioPromise = waitAudioPair(carlosWs);

  const hindiPcm = Buffer.from([0x11, 0x22]);
  const spanishPcm = Buffer.from([0x33, 0x44]);

  aliceUpstream.ws.send(JSON.stringify({
    type: 'translation.audio',
    codec: 'pcm_s16le',
    sample_rate: 48000,
    language: 'hi',
    chunk_seq: 1,
    last: false,
    audio_b64: hindiPcm.toString('base64'),
  }));

  aliceUpstream.ws.send(JSON.stringify({
    type: 'translation.audio',
    codec: 'pcm_s16le',
    sample_rate: 48000,
    language: 'es',
    chunk_seq: 1,
    last: false,
    audio_b64: spanishPcm.toString('base64'),
  }));

  const [bobAudio, carlosAudio] = await Promise.all([bobAudioPromise, carlosAudioPromise]);

  // Bob gets only Hindi
  assert.equal(bobAudio.header.lang, 'hi');
  assert.deepEqual(bobAudio.body, hindiPcm);

  // Carlos gets only Spanish
  assert.equal(carlosAudio.header.lang, 'es');
  assert.deepEqual(carlosAudio.body, spanishPcm);

  // 4th participant joins (David) -> succeeds
  const davidSess = await httpPost('/api/session', { userId: 'david', sourceLang: 'fr', targetLang: 'fr' });
  const davidWs = new WebSocket(davidSess.data.wsUrl);
  await new Promise((r) => davidWs.on('open', r));
  davidWs.send(JSON.stringify({ type: 'join', token: davidSess.data.token, room: code, displayName: 'David' }));
  const davidJoined = await waitType(davidWs, 'joined');
  assert.equal(davidJoined.room, code);

  // 5th participant tries to join 4-seat room -> rejected with room-full
  const eveSess = await httpPost('/api/session', { userId: 'eve', sourceLang: 'en', targetLang: 'de' });
  const eveWs = new WebSocket(eveSess.data.wsUrl);
  await new Promise((r) => eveWs.on('open', r));
  eveWs.send(JSON.stringify({ type: 'join', token: eveSess.data.token, room: code, displayName: 'Eve' }));
  const errEve = await waitType(eveWs, 'error');
  assert.equal(errEve.code, 'room-full');

  aliceWs.close();
  bobWs.close();
  carlosWs.close();
  davidWs.close();
  eveWs.close();
});

// ---------------------------------------------------------------------------
// TEST 3: Mid-Call Session Refresh & Re-Authentication
// ---------------------------------------------------------------------------
test('Session Refresh: Rotate token mid-call without interrupting connection', async () => {
  const roomRes = await httpPost('/api/rooms', {});
  const code = roomRes.data.code;

  const aliceSess1 = await httpPost('/api/session', { userId: 'alice', sourceLang: 'en', targetLang: 'hi' });
  const ws = new WebSocket(aliceSess1.data.wsUrl);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', token: aliceSess1.data.token, room: code, displayName: 'Alice' }));
  const joined = await waitType(ws, 'joined');
  assert.equal(joined.self.sessionId, aliceSess1.data.sessionId);

  // Mint refreshed token for the same user
  const aliceSess2 = await httpPost('/api/session/refresh', { token: aliceSess1.data.token });
  assert.equal(aliceSess2.status, 200);

  // Push new token via WS
  ws.send(JSON.stringify({ type: 'session.refresh', token: aliceSess2.data.token }));
  const refreshed = await waitType(ws, 'session.refreshed');
  assert.equal(refreshed.sessionId, aliceSess2.data.sessionId);

  ws.close();
});

// ---------------------------------------------------------------------------
// TEST 4: Stale Participant Deduplication on Reconnect
// ---------------------------------------------------------------------------
test('Stale Deduplication: Rejoining with same userId replaces stale seat cleanly', async () => {
  const roomRes = await httpPost('/api/rooms', {});
  const code = roomRes.data.code;

  const sess1 = await httpPost('/api/session', { userId: 'alice', sourceLang: 'en', targetLang: 'hi' });
  const ws1 = new WebSocket(sess1.data.wsUrl);
  await new Promise((r) => ws1.on('open', r));
  ws1.send(JSON.stringify({ type: 'join', token: sess1.data.token, room: code, displayName: 'Alice' }));
  await waitType(ws1, 'joined');

  // Second connection for same userId (simulating reconnect after network blip)
  const sess2 = await httpPost('/api/session', { userId: 'alice', sourceLang: 'en', targetLang: 'hi' });
  const ws2 = new WebSocket(sess2.data.wsUrl);
  await new Promise((r) => ws2.on('open', r));
  ws2.send(JSON.stringify({ type: 'join', token: sess2.data.token, room: code, displayName: 'Alice' }));
  const joined2 = await waitType(ws2, 'joined');

  assert.equal(joined2.room, code);
  assert.equal(joined2.self.sessionId, sess2.data.sessionId);

  ws1.close();
  ws2.close();
});

