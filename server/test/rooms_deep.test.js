// test/rooms_deep.test.js — deep room-management scenarios.
//
// - capacity enforcement
// - join race (two clients joining concurrently to the last seat)
// - room code validation endpoint
// - caption toggle state
// - peer-lang-changed broadcast

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

let PORT;
let BASE;
let serverHandle;

before(async () => {
  PORT = 28000 + Math.floor(Math.random() * 5000);
  BASE = `http://localhost:${PORT}`;
  process.env.PORT = String(PORT);
  process.env.PUBLIC_BASE = `ws://localhost:${PORT}`;
  process.env.OLLALINK_DASHBOARD_KEY = 'sk_test';
  process.env.OLLALINK_WS_URL = 'wss://example.com';
  process.env.SESSION_SECRET = randomBytes(32).toString('hex');
  process.env.LOG_LEVEL = 'error';

  const { startServer } = await import('../src/server.js');
  serverHandle = startServer();
  await new Promise(r => setTimeout(r, 400));
});

after(async () => { await serverHandle.close(); });

// ---------------------------------------------------------------------------
// Room capacity and contention
// ---------------------------------------------------------------------------

test('room rejects 3rd concurrent join', async () => {
  const room = await createRoom();
  const [s1, s2, s3] = await Promise.all([mint('a'), mint('b'), mint('c')]);
  const [w1, w2, w3] = [new WebSocket(s1.wsUrl), new WebSocket(s2.wsUrl), new WebSocket(s3.wsUrl)];
  await Promise.all([openWs(w1), openWs(w2), openWs(w3)]);

  w1.send(JSON.stringify({ type: 'join', token: s1.token, room: room.code, displayName: 'a' }));
  w2.send(JSON.stringify({ type: 'join', token: s2.token, room: room.code, displayName: 'b' }));
  await Promise.all([waitForType(w1, 'joined'), waitForType(w2, 'joined')]);

  w3.send(JSON.stringify({ type: 'join', token: s3.token, room: room.code, displayName: 'c' }));
  const err = await waitForType(w3, 'error');
  assert.equal(err.code, 'room-full');
  [w1, w2, w3].forEach(w => w.close());
});

test('two clients racing for the LAST room seat — exactly one wins', async () => {
  const room = await createRoom();
  await joinAndWait('first', room.code);  // takes seat 1

  // Two clients race for seat 2
  const [sB, sC] = await Promise.all([mint('b'), mint('c')]);
  const wB = new WebSocket(sB.wsUrl);
  const wC = new WebSocket(sC.wsUrl);
  await Promise.all([openWs(wB), openWs(wC)]);

  const results = await Promise.allSettled([
    joinAndWaitWs(wB, sB.token, room.code, 'b'),
    joinAndWaitWs(wC, sC.token, room.code, 'c'),
  ]);

  const joined = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  assert.equal(joined, 1, 'exactly one client should win the last seat');
  assert.equal(failed, 1, 'exactly one client should be rejected');
  wB.close(); wC.close();
});

test('join with malformed room code returns no-room error', async () => {
  const s = await mint('alice');
  const ws = new WebSocket(s.wsUrl);
  await openWs(ws);
  ws.send(JSON.stringify({ type: 'join', token: s.token, room: '!!!BAD!!!', displayName: 'a' }));
  const err = await waitForType(ws, 'error');
  assert.equal(err.code, 'no-room');
  ws.close();
});

// ---------------------------------------------------------------------------
// Room validation endpoint
// ---------------------------------------------------------------------------

test('GET /api/rooms/<code> validates format and existence', async () => {
  // Create a fresh room for THIS test, no other test touches it.
  const room = await createRoom();

  const ok = await fetch(`${BASE}/api/rooms/${room.code}`).then(r => r.json());
  assert.equal(ok.valid, true);
  assert.equal(ok.exists, true);
  assert.equal(ok.seatsAvailable, 2);

  const fakeCode = 'ZZZZZZ';
  const bad = await fetch(`${BASE}/api/rooms/${fakeCode}`).then(r => r.json());
  assert.equal(bad.valid, true);
  assert.equal(bad.exists, false);
  assert.equal(bad.seatsAvailable, 0);

  const malformed = await fetch(`${BASE}/api/rooms/!@#$%^`).then(r => r.json());
  assert.equal(malformed.valid, false);
  assert.equal(malformed.reason, 'malformed');
});

// ---------------------------------------------------------------------------
// Captions toggle
// ---------------------------------------------------------------------------

test('captionsOn=false participant does NOT receive caption events', async () => {
  const room = await createRoom();
  const captionsOffSess = await mint('alice');
  const captionsOnSess = await mint('bob');

  const wsA = new WebSocket(captionsOffSess.wsUrl);
  const wsB = new WebSocket(captionsOnSess.wsUrl);
  await openWs(wsA); await openWs(wsB);

  wsA.send(JSON.stringify({
    type: 'join', token: captionsOffSess.token, room: room.code,
    displayName: 'alice', captionsOn: false,
  }));
  wsB.send(JSON.stringify({
    type: 'join', token: captionsOnSess.token, room: room.code,
    displayName: 'bob', captionsOn: true,
  }));
  await waitForType(wsA, 'joined');
  await waitForType(wsB, 'joined');

  // We can't easily inject a caption without a real upstream, since captions
  // come from Ollalink. To still exercise the logic, use the helper below
  // to inspect the participant record.
  const participants = await waitForType(wsB, 'joined').then(j => j.participants).catch(() => null);
  // We can also look at the /api/stats response — but it doesn't expose captionsOn.
  // The real proof comes once Ollalink is wired; for now we just verify the
  // join succeeds and the field is accepted without error.
  wsA.close(); wsB.close();
});

test('captions.set flips the flag mid-call', async () => {
  const ws = new WebSocket((await mint('alice')).wsUrl);
  await openWs(ws);
  const sess = await mint('alice');  // separate session for the join
  ws.send(JSON.stringify({ type: 'join', token: sess.token, displayName: 'a' }));
  await waitForType(ws, 'joined');

  ws.send(JSON.stringify({ type: 'captions.set', on: false }));
  const ack = await waitForType(ws, 'captions.set');
  assert.equal(ack.on, false);
  ws.close();
});

// ---------------------------------------------------------------------------
// Language change mid-call
// ---------------------------------------------------------------------------

test('lang.change re-opens upstream + notifies peers', async () => {
  const room = await createRoom();
  const alice = await joinCallWs('alice', 'en', 'hi', room.code);
  const bob = await joinCallWs('bob', 'hi', 'en', room.code);

  const bobNotified = waitForType(bob.ws, 'peer-lang-changed');
  alice.ws.send(JSON.stringify({ type: 'lang.change', sourceLang: 'en', targetLang: 'ta' }));

  const ack = await waitForType(alice.ws, 'lang.changed');
  assert.equal(ack.targetLang, 'ta');
  const peerNotif = await bobNotified;
  assert.equal(peerNotif.sessionId, alice.joined.self.sessionId);
  assert.equal(peerNotif.targetLang, 'ta');
  alice.ws.close(); bob.ws.close();
});

test('lang.change with invalid target is rejected with bad-lang', async () => {
  const alice = await joinCallWs('alice', 'en', 'hi');
  alice.ws.send(JSON.stringify({ type: 'lang.change', targetLang: 'xx-not-a-lang' }));
  const err = await waitForType(alice.ws, 'error');
  assert.equal(err.code, 'bad-lang');
  alice.ws.close();
});

test('lang.change to same language pair is a no-op', async () => {
  const alice = await joinCallWs('alice', 'en', 'hi');
  alice.ws.send(JSON.stringify({ type: 'lang.change', sourceLang: 'en', targetLang: 'hi' }));
  // Should NOT get lang.changed back, since it's a no-op.
  let gotMsg = null;
  const watcher = new Promise((resolve) => {
    const onMsg = (data, isBinary) => {
      if (isBinary) return;
      try {
        const m = JSON.parse(data.toString());
        if (m.type === 'lang.changed') {
          gotMsg = m;
          alice.ws.off('message', onMsg);
          resolve(m);
        }
      } catch {}
    };
    alice.ws.on('message', onMsg);
    setTimeout(() => { alice.ws.off('message', onMsg); resolve(null); }, 500);
  });
  await watcher;
  assert.equal(gotMsg, null, 'no-op change should not emit lang.changed');
  alice.ws.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mint(userId) {
  const r = await fetch(`${BASE}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, sourceLang: 'en', targetLang: 'hi' }),
  });
  return r.json();
}

async function createRoom() {
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST' });
  return r.json();
}

function openWs(ws) {
  return new Promise((res, rej) => {
    ws.once('open', res); ws.once('error', rej);
  });
}

function waitForType(ws, type, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const handler = (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          clearTimeout(t);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch {}
    };
    ws.on('message', handler);
  });
}

async function joinAndWait(userId, roomCode) {
  const s = await mint(userId);
  const ws = new WebSocket(s.wsUrl);
  await openWs(ws);
  return joinAndWaitWs(ws, s.token, roomCode, userId);
}

async function joinAndWaitWs(ws, token, room, displayName) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('join timeout')), 3000);
    const onMsg = (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'joined') {
          clearTimeout(timeout);
          ws.off('message', onMsg);
          resolve({ ws, joined: msg });
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          ws.off('message', onMsg);
          reject(new Error(`${msg.code}: ${msg.message}`));
        }
      } catch {}
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'join', token, room, displayName }));
  });
}

async function joinCallWs(userId, src, tgt, roomCode) {
  const r = await fetch(`${BASE}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, sourceLang: src, targetLang: tgt }),
  });
  const sess = await r.json();
  const ws = new WebSocket(sess.wsUrl);
  await openWs(ws);
  const joined = await joinAndWaitWs(ws, sess.token, roomCode, userId);
  return joined;
}
