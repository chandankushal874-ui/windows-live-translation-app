// test/receive_path.test.js — deep verification of the Ollalink → relay → app path.
//
// Single relay + fake Ollalink shared across all tests. Each test gets its
// own room to isolate state.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

let PORT;
let BASE;
let FAKE_PORT;
let serverHandle;
let fakeUpstream;

// Track each test's connections for cleanup
const fakeSessions = [];
const appsClients = []; // app-side WebSockets we need to close

/** Wait for the next fake upstream connection. */
function nextFakeSession(timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const startIdx = fakeSessions.length;
    const start = Date.now();
    const t = setInterval(() => {
      if (fakeSessions.length > startIdx) {
        clearInterval(t);
        resolve(fakeSessions[fakeSessions.length - 1]);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(t);
        reject(new Error('no fake session arrived'));
      }
    }, 5);
    t.unref?.();
  });
}

before(async () => {
  PORT = 31000 + Math.floor(Math.random() * 500);
  FAKE_PORT = PORT + 1000;
  BASE = `http://localhost:${PORT}`;

  fakeUpstream = new WebSocketServer({ port: FAKE_PORT });
  fakeUpstream.on('connection', (ws, req) => {
    const sess = { ws, req, received: [], closed: false };
    ws.on('message', (data, isBinary) => sess.received.push({ isBinary, data }));
    ws.on('close', () => { sess.closed = true; });
    fakeSessions.push(sess);
  });

  process.env.PORT = String(PORT);
  process.env.PUBLIC_BASE = `ws://localhost:${PORT}`;
  process.env.OLLALINK_DASHBOARD_KEY = 'sk_test_' + randomBytes(8).toString('hex');
  process.env.OLLALINK_WS_URL = `ws://localhost:${FAKE_PORT}`;
  process.env.SESSION_SECRET = randomBytes(32).toString('hex');
  process.env.LOG_LEVEL = 'error';

  const { startServer } = await import('../src/server.js');
  serverHandle = startServer();
  await new Promise(r => setTimeout(r, 300));
});

after(async () => {
  // Close any open app-side websockets first
  for (const ws of appsClients) {
    try { ws.terminate(); } catch {}
  }
  appsClients.length = 0;

  // Force-close upstream connections
  for (const s of fakeSessions) {
    try { s.ws.terminate(); } catch {}
  }
  await new Promise(r => fakeUpstream.close(r));
  await serverHandle.close();
});

async function mintSess(userId, src, tgt) {
  const r = await fetch(`${BASE}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, sourceLang: src, targetLang: tgt }),
  });
  return r.json();
}

async function createRoomHttp() {
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST' });
  return r.json();
}

function openWs(ws) {
  return new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
}

function waitForType(ws, type, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const handler = (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          clearTimeout(t); ws.off('message', handler); resolve(msg);
        }
      } catch {}
    };
    ws.on('message', handler);
  });
}

async function joinCall(userId, src, tgt, roomCode = null) {
  const sess = await mintSess(userId, src, tgt);
  const ws = new WebSocket(sess.wsUrl);
  appsClients.push(ws);  // track for cleanup
  const fakeP = nextFakeSession();
  await openWs(ws);
  ws.send(JSON.stringify({ type: 'join', token: sess.token, room: roomCode, displayName: userId }));
  const joined = await waitForType(ws, 'joined');
  const fake = await fakeP;
  return { ws, sess, joined, fake, roomCode: joined.room };
}

/**
 * After a peer joins and triggers upstream re-opens, find the LATEST fake
 * session for a given speaker by matching recognition.language to their
 * sourceLang. The initial upstream gets closed/replaced on peer-join.
 */
function findLatestFakeForSpeaker(sourceLang) {
  for (let i = fakeSessions.length - 1; i >= 0; i--) {
    const s = fakeSessions[i];
    const cfgRaw = s.received.find(m => !m.isBinary)?.data?.toString();
    if (!cfgRaw) continue;
    try {
      const cfg = JSON.parse(cfgRaw);
      if (cfg.recognition?.language === sourceLang) return s;
    } catch {}
  }
  return null;
}

/**
 * Convenience: after two participants join, get the CURRENT fake for the
 * speaker (re-opened after peer join). Waits for re-open to settle.
 */
async function currentFakeFor(speaker) {
  await new Promise(r => setTimeout(r, 200));
  return findLatestFakeForSpeaker(speaker);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('upstream connection carries dashboard key header', async () => {
  const { fake } = await joinCall('alice', 'en', 'hi');
  assert.equal(fake.req.headers['x-nh-gpu-key'], process.env.OLLALINK_DASHBOARD_KEY);
});

test('upstream receives config first, then app\'s binary PCM flows through', async () => {
  const alice = await joinCall('alice', 'en', 'hi');
  await new Promise(r => setTimeout(r, 100));
  const first = alice.fake.received[0];
  assert.equal(first.isBinary, false);
  const cfg = JSON.parse(first.data.toString());
  // New schema — nested fields, not flat
  assert.equal(cfg.type, 'session.configure');
  assert.equal(cfg.audio.sample_rate, 16000);
  assert.equal(cfg.audio.encoding, 'pcm_s16le');
  assert.equal(cfg.recognition.language, 'en');
  assert.deepEqual(cfg.translation.targets, ['hi']);
  assert.equal(cfg.tts.enabled, true);

  const pcm = Buffer.alloc(640, 0x42);
  alice.ws.send(pcm);
  await new Promise(r => setTimeout(r, 100));
  const binFrames = alice.fake.received.filter(m => m.isBinary);
  assert.ok(binFrames.length >= 1);
  assert.deepEqual(binFrames[binFrames.length - 1].data, pcm);
});

test('"final" event from upstream: peer + speaker both get caption', async () => {
  const room = await createRoomHttp();
  const alice = await joinCall('alice', 'en', 'hi', room.code);
  const bob = await joinCall('bob', 'hi', 'en', room.code);
  const aliceFake = await currentFakeFor('en');

  const aliceCaption = waitForType(alice.ws, 'caption');
  const bobCaption = waitForType(bob.ws, 'caption');
  aliceFake.ws.send(JSON.stringify({
    type: 'transcript.final', text: 'hi', language: 'en', utterance_id: 'u-1',
  }));
  const [aC, bC] = await Promise.all([aliceCaption, bobCaption]);
  assert.equal(aC.kind, 'caption-final');
  assert.equal(bC.from, alice.joined.self.sessionId);
});

test('upstream binary audio: routed to peers only, not the speaker', async () => {
  const room = await createRoomHttp();
  const alice = await joinCall('alice', 'en', 'hi', room.code);
  const bob = await joinCall('bob', 'hi', 'en', room.code);
  const aliceFake = await currentFakeFor('en');

  let aliceGotAudio = false;
  alice.ws.on('message', (_, isBinary) => { if (isBinary) aliceGotAudio = true; });

  const pairPromise = new Promise((resolve) => {
    let pending = null;
    bob.ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const m = JSON.parse(data.toString());
          if (m.type === 'audio') pending = m;
        } catch {}
      } else if (pending) {
        resolve({ header: pending, body: data });
      }
    });
  });

  const audioPcm = Buffer.from([0xaa, 0xbb, 0xcc]);
  aliceFake.ws.send(JSON.stringify({
    type: 'translation.audio',
    codec: 'pcm_s16le',
    sample_rate: 48000,
    language: 'en',
    chunk_seq: 0,
    last: false,
    audio_b64: audioPcm.toString('base64'),
  }));
  const { body } = await pairPromise;
  assert.deepEqual(body, audioPcm);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(aliceGotAudio, false);
});

test('back-to-back audio chunks preserve order', async () => {
  const room = await createRoomHttp();
  const alice = await joinCall('alice', 'en', 'hi', room.code);
  const bob = await joinCall('bob', 'hi', 'en', room.code);
  const aliceFake = await currentFakeFor('en');

  const orderedBins = [];
  let pending = null;
  bob.ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try { const m = JSON.parse(data.toString()); if (m.type === 'audio') pending = m; } catch {}
    } else if (pending) {
      orderedBins.push(Buffer.from(data));
      pending = null;
    }
  });

  const chunks = [Buffer.from([0x01]), Buffer.from([0x02]), Buffer.from([0x03])];
  for (let i = 0; i < chunks.length; i++) {
    aliceFake.ws.send(JSON.stringify({
      type: 'translation.audio',
      codec: 'pcm_s16le',
      sample_rate: 48000,
      language: 'en',
      chunk_seq: i,
      last: i === chunks.length - 1,
      audio_b64: chunks[i].toString('base64'),
    }));
  }
  await new Promise(r => setTimeout(r, 200));
  assert.equal(orderedBins.length, 3);
  assert.deepEqual(orderedBins[0], chunks[0]);
  assert.deepEqual(orderedBins[1], chunks[1]);
  assert.deepEqual(orderedBins[2], chunks[2]);
});

test('error event from upstream becomes caption kind=error', async () => {
  const alice = await joinCall('alice', 'en', 'hi');
  const p = waitForType(alice.ws, 'caption');
  alice.fake.ws.send(JSON.stringify({ type: 'error', code: 'test_error' }));
  const cap = await p;
  assert.equal(cap.kind, 'error');
});

test('malformed upstream JSON does not crash relay', async () => {
  const alice = await joinCall('alice', 'en', 'hi');
  const p = waitForType(alice.ws, 'caption');
  alice.fake.ws.send('garbage {{ not json');
  const cap = await p;
  assert.equal(cap.kind, 'unknown');
});

test('audio routed to peer with different targetLang is dropped silently', async () => {
  const room = await createRoomHttp();
  const alice = await joinCall('alice', 'en', 'hi', room.code);
  const bob = await joinCall('bob', 'hi', 'en', room.code);
  const aliceFake = await currentFakeFor('en');

  let bobGotAudio = false;
  bob.ws.on('message', (data, isBinary) => { if (isBinary) bobGotAudio = true; });

  aliceFake.ws.send(JSON.stringify({
    type: 'translation.audio',
    codec: 'pcm_s16le',
    sample_rate: 48000,
    language: 'fr',
    chunk_seq: 0,
    last: false,
    audio_b64: Buffer.from([0x01]).toString('base64'),
  }));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(bobGotAudio, false);
});

test('upstream close broadcasts peer-upstream-closed', async () => {
  const room = await createRoomHttp();
  const alice = await joinCall('alice', 'en', 'hi', room.code);
  const bob = await joinCall('bob', 'hi', 'en', room.code);
  const aliceFake = await currentFakeFor('en');

  const notif = waitForType(bob.ws, 'peer-upstream-closed');
  aliceFake.ws.close();
  const n = await notif;
  assert.equal(n.from, alice.joined.self.sessionId);
});

// Note: captionsOn gating logic is verified at the unit level in rooms_deep.test.js
// ("captions.set flips the flag mid-call") plus the explicit captionsOn=false join
// test. A full integration test here would require two fake upstreams and is too
// brittle for routine CI. The wire-level verification for "captions don't reach
// captionsOn=false subscribers" is:
//   forwardOllalinkToRoom checks peer.captionsOn !== false before sending.
// That single line is exercised by the caption echo tests above (which use default
// captionsOn=true and pass), and by the manual "captions.set" toggle test.
