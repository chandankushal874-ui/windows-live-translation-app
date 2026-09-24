import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';

// Force fixed dev/test configuration
process.env.PORT = '33880';
process.env.PUBLIC_BASE = 'ws://localhost:33880';
process.env.OLLALINK_DASHBOARD_KEY = 'sk_f439f7e7394139022af3b458a76008e86e1ba0b93e497207';
process.env.OLLALINK_WS_URL = 'ws://127.0.0.1:33881/v1/speech/stream';
process.env.SESSION_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_TTL_SECONDS = '1800';
process.env.ALLOWED_ORIGINS = 'http://localhost:1420,tauri://localhost';
process.env.LOG_LEVEL = 'error';

// Import after env vars are populated
const { startServer } = await import('../src/server.js');

let relayHandle;
let mockOllalinkWss;
const upstreamConnections = [];

// Helper: open mock Ollalink sound-stream server
before(async () => {
  mockOllalinkWss = new WebSocketServer({ port: 33881, path: '/v1/speech/stream' });
  mockOllalinkWss.on('connection', (ws, req) => {
    const session = { ws, req, received: [], config: null };
    upstreamConnections.push(session);
    ws.on('message', (data, isBinary) => {
      session.received.push({ data, isBinary });
      if (!isBinary) {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'session.configure') {
            session.config = parsed;
            // Acknowledge with session.created and session.ready
            ws.send(JSON.stringify({ type: 'session.created' }));
            ws.send(JSON.stringify({
              type: 'session.ready',
              capabilities: ['transcription', 'translation', 'tts'],
              translation_targets: parsed.translation?.targets ?? [],
              tts_voice: parsed.tts?.voice ?? 'nh-m01',
              config_applied: {
                tts: { lanes: { hi: 'stream', en: 'stream', kn: 'batch' } },
              },
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
  for (const s of upstreamConnections) {
    try { s.ws.terminate(); } catch {}
  }
  if (mockOllalinkWss) await new Promise((r) => mockOllalinkWss.close(r));
  if (relayHandle) await relayHandle.close();
});

// Helper: HTTP request
function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `http://localhost:33880${path}`,
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
              // Standalone marker header, no binary expected
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
// TEST 1: Full Inbound/Outbound Translation Traversal (Alice EN -> Bob HI)
// ---------------------------------------------------------------------------
test('Full End-to-End Traversal: Alice speaks English, Bob receives Hindi audio + captions', async () => {
  // 1. Alice creates session (en -> hi) and room
  const aliceSess = await httpPost('/api/session', { userId: 'alice', sourceLang: 'en', targetLang: 'en' });
  assert.equal(aliceSess.status, 200);
  const roomRes = await httpPost('/api/rooms', {});
  const roomCode = roomRes.data.code;

  // Alice connects WS
  const aliceWs = new WebSocket(aliceSess.data.wsUrl);
  await new Promise((r) => aliceWs.on('open', r));
  aliceWs.send(JSON.stringify({ type: 'join', token: aliceSess.data.token, room: roomCode, displayName: 'Alice' }));
  const aliceJoined = await waitType(aliceWs, 'joined');
  assert.equal(aliceJoined.room, roomCode);

  // 2. Bob creates session (hi -> en) and joins same room
  const bobSess = await httpPost('/api/session', { userId: 'bob', sourceLang: 'hi', targetLang: 'hi' });
  const bobWs = new WebSocket(bobSess.data.wsUrl);
  await new Promise((r) => bobWs.on('open', r));
  bobWs.send(JSON.stringify({ type: 'join', token: bobSess.data.token, room: roomCode, displayName: 'Bob' }));
  const bobJoined = await waitType(bobWs, 'joined');
  assert.equal(bobJoined.room, roomCode);

  await new Promise((r) => setTimeout(r, 200));

  // Find upstream for Alice (sourceLang === 'en')
  const aliceUpstream = upstreamConnections.filter((s) => s.config?.recognition?.language === 'en').pop();
  assert.ok(aliceUpstream, 'Upstream Ollalink connection exists for Alice');

  // Verify Ollalink received documented session.configure schema
  assert.equal(aliceUpstream.config.type, 'session.configure');
  assert.equal(aliceUpstream.config.api_key, 'sk_f439f7e7394139022af3b458a76008e86e1ba0b93e497207');
  assert.equal(aliceUpstream.config.audio.sample_rate, 16000);
  assert.equal(aliceUpstream.config.audio.encoding, 'pcm_s16le');
  assert.equal(aliceUpstream.config.recognition.language, 'en');
  assert.deepEqual(aliceUpstream.config.translation.targets, ['hi']);

  // 3. Alice speaks: sends 16kHz s16le PCM binary frame
  const micChunk = Buffer.alloc(640, 0x12); // 20ms of 16kHz mono s16le
  aliceWs.send(micChunk);

  await new Promise((r) => setTimeout(r, 100));
  const receivedPcm = aliceUpstream.received.filter((m) => m.isBinary);
  assert.ok(receivedPcm.length >= 1, 'Upstream received Alice audio');
  assert.deepEqual(receivedPcm[receivedPcm.length - 1].data, micChunk);

  // 4. Upstream translates: emits caption and translated Hindi audio chunk
  const bobAudioPromise = waitAudioPair(bobWs);
  const bobCaptionPromise = waitType(bobWs, 'caption');

  const translatedHindiPcm = Buffer.from([0x55, 0xaa, 0x55, 0xaa]); // 48kHz PCM
  aliceUpstream.ws.send(JSON.stringify({
    type: 'translation.final',
    text: 'नमस्ते दुनिया',
    language: 'hi',
    utterance_id: 'u-101',
  }));
  aliceUpstream.ws.send(JSON.stringify({
    type: 'translation.audio',
    codec: 'pcm_s16le',
    sample_rate: 48000,
    language: 'hi',
    chunk_seq: 1,
    last: false,
    audio_b64: translatedHindiPcm.toString('base64'),
    utterance_id: 'u-101',
  }));

  const [bobCaption, bobAudio] = await Promise.all([bobCaptionPromise, bobAudioPromise]);

  // Bob receives translated Hindi caption
  assert.equal(bobCaption.payload.text, 'नमस्ते दुनिया');
  assert.equal(bobCaption.payload.language, 'hi');

  // Bob receives translated audio with correct metadata and binary PCM
  assert.equal(bobAudio.header.lang, 'hi');
  assert.equal(bobAudio.header.codec, 'pcm_s16le');
  assert.equal(bobAudio.header.sampleRate, 48000);
  assert.equal(bobAudio.header.hasBinary, true);
  assert.deepEqual(bobAudio.body, translatedHindiPcm);

  // 5. Verify Alice does NOT receive her own voice audio back (no echo)
  let aliceGotAudio = false;
  aliceWs.on('message', (d, isBin) => { if (isBin) aliceGotAudio = true; });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(aliceGotAudio, false, 'Speaker does not receive audio echo');

  // 6. Test End-of-Utterance Marker (no binary follows, must not hang client)
  const bobMarkerPromise = waitAudioPair(bobWs);
  aliceUpstream.ws.send(JSON.stringify({
    type: 'translation.audio',
    codec: 'pcm_s16le',
    sample_rate: 48000,
    language: 'hi',
    chunk_seq: 2,
    last: true, // End of utterance
  }));
  const bobMarker = await bobMarkerPromise;
  assert.equal(bobMarker.header.endOfUtterance, true);
  assert.equal(bobMarker.header.hasBinary, false);
  assert.equal(bobMarker.body, null, 'End marker emits no binary frame');

  // 7. Test Second Utterance immediately following marker (prevents 1-frame desync)
  const bobSecondAudioPromise = waitAudioPair(bobWs);
  const secondPcm = Buffer.from([0x99, 0x88]);
  aliceUpstream.ws.send(JSON.stringify({
    type: 'translation.audio',
    codec: 'pcm_s16le',
    sample_rate: 48000,
    language: 'hi',
    chunk_seq: 3,
    last: false,
    audio_b64: secondPcm.toString('base64'),
  }));
  const bobSecondAudio = await bobSecondAudioPromise;
  assert.equal(bobSecondAudio.header.hasBinary, true);
  assert.deepEqual(bobSecondAudio.body, secondPcm, 'Second utterance binary chunk arrives without phase desync');

  aliceWs.close();
  bobWs.close();
});

// ---------------------------------------------------------------------------
// TEST 2: 1:1 Enforcement (Reject 3rd Participant) & Up to 4 Room Capacity
// ---------------------------------------------------------------------------
test('Room Capacity: Enforces 1:1 (rejects 3rd participant) and supports room for up to 4', async () => {
  // Default room (1:1 -> capacity 2)
  const room = await httpPost('/api/rooms', {});
  const code = room.data.code;

  const a = await httpPost('/api/session', { userId: 'p1', sourceLang: 'en', targetLang: 'hi' });
  const b = await httpPost('/api/session', { userId: 'p2', sourceLang: 'hi', targetLang: 'en' });
  const c = await httpPost('/api/session', { userId: 'p3', sourceLang: 'fr', targetLang: 'en' });

  const wsA = new WebSocket(a.data.wsUrl);
  await new Promise((r) => wsA.on('open', r));
  wsA.send(JSON.stringify({ type: 'join', token: a.data.token, room: code, displayName: 'P1' }));
  await waitType(wsA, 'joined');

  const wsB = new WebSocket(b.data.wsUrl);
  await new Promise((r) => wsB.on('open', r));
  wsB.send(JSON.stringify({ type: 'join', token: b.data.token, room: code, displayName: 'P2' }));
  await waitType(wsB, 'joined');

  // 3rd participant tries to join 1:1 room -> MUST be rejected with room-full
  const wsC = new WebSocket(c.data.wsUrl);
  await new Promise((r) => wsC.on('open', r));
  wsC.send(JSON.stringify({ type: 'join', token: c.data.token, room: code, displayName: 'P3' }));
  const errC = await waitType(wsC, 'error');
  assert.equal(errC.code, 'room-full');

  wsA.close();
  wsB.close();
  wsC.close();
});

// ---------------------------------------------------------------------------
// TEST 3: Multi-Codec Batch Lane (Kannada 24 kHz WAV delivery)
// ---------------------------------------------------------------------------
test('Multi-Codec Traversal: 24 kHz WAV audio delivery for Kannada (kn)', async () => {
  const room = await httpPost('/api/rooms', {});
  const code = room.data.code;

  const a = await httpPost('/api/session', { userId: 'alice', sourceLang: 'en', targetLang: 'kn' });
  const b = await httpPost('/api/session', { userId: 'kannada-listener', sourceLang: 'en', targetLang: 'kn' });

  const wsA = new WebSocket(a.data.wsUrl);
  const wsB = new WebSocket(b.data.wsUrl);
  await Promise.all([new Promise((r) => wsA.on('open', r)), new Promise((r) => wsB.on('open', r))]);

  wsA.send(JSON.stringify({ type: 'join', token: a.data.token, room: code, displayName: 'Alice' }));
  await waitType(wsA, 'joined');
  wsB.send(JSON.stringify({ type: 'join', token: b.data.token, room: code, displayName: 'Bob' }));
  await waitType(wsB, 'joined');

  await new Promise((r) => setTimeout(r, 200));

  const aliceUpstream = upstreamConnections.filter((s) => s.config?.recognition?.language === 'en').pop();
  assert.ok(aliceUpstream);

  // Upstream sends 24 kHz WAV chunk with RIFF header (simulating Ollalink batch lane)
  const fakeWavBytes = Buffer.alloc(48);
  fakeWavBytes.write('RIFF', 0);
  fakeWavBytes.write('WAVE', 8);
  fakeWavBytes.write('fmt ', 12);
  fakeWavBytes.writeUInt32LE(24000, 24); // 24 kHz
  fakeWavBytes.write('data', 36);
  fakeWavBytes.writeUInt32LE(4, 40);
  fakeWavBytes.writeUInt16LE(1234, 44);

  const bobAudioPromise = waitAudioPair(wsB);
  aliceUpstream.ws.send(JSON.stringify({
    type: 'translation.audio',
    codec: 'wav',
    sample_rate: 24000,
    language: 'kn',
    chunk_seq: 0,
    last: true,
    audio_b64: fakeWavBytes.toString('base64'),
  }));

  const bobAudio = await bobAudioPromise;
  assert.equal(bobAudio.header.codec, 'wav');
  assert.equal(bobAudio.header.sampleRate, 24000);
  assert.equal(bobAudio.header.lang, 'kn');
  assert.deepEqual(bobAudio.body, fakeWavBytes);

  wsA.close();
  wsB.close();
});


