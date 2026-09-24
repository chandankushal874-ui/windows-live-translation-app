// test/server.test.js — integration tests for the relay server.
// Boots a real instance on a random port and exercises HTTP + WS paths.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

let PORT;
let BASE;
let serverHandle;

before(async () => {
  PORT = 20000 + Math.floor(Math.random() * 20000);
  BASE = `http://localhost:${PORT}`;
  process.env.PORT = String(PORT);
  process.env.PUBLIC_BASE = `ws://localhost:${PORT}`;
  process.env.OLLALINK_DASHBOARD_KEY = 'sk_test';
  process.env.OLLALINK_WS_URL = 'wss://example.com';
  process.env.SESSION_SECRET = randomBytes(32).toString('hex');
  process.env.LOG_LEVEL = 'error';

  const { startServer } = await import('../src/server.js');
  serverHandle = startServer();
  // Wait for listener.
  await new Promise(r => setTimeout(r, 400));
});

after(async () => {
  await serverHandle.close();
});

test('GET /api/health returns ok', async () => {
  const r = await fetch(`${BASE}/api/health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
});

test('POST /api/session mints a token', async () => {
  const r = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'alice', sourceLang: 'en', targetLang: 'hi' }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.token);
  assert.ok(body.wsUrl);
  assert.equal(typeof body.expiresAt, 'number');
});

test('POST /api/session rejects missing fields', async () => {
  const r = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'alice' }),
  });
  assert.equal(r.status, 400);
});

test('POST /api/session/refresh rotates a token', async () => {
  const mint = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'alice', sourceLang: 'en', targetLang: 'hi' }),
  });
  const { token } = await mint.json();

  const r = await fetch(`${BASE}/api/session/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.token);
  assert.notEqual(body.token, token);
});

test('POST /api/session/refresh rejects bad token', async () => {
  const r = await fetch(`${BASE}/api/session/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'not.a.real.token' }),
  });
  assert.equal(r.status, 401);
});

test('POST /api/rooms creates a code', async () => {
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST' });
  assert.equal(r.status, 200);
  const { code } = await r.json();
  assert.match(code, /^[A-Z2-9]{6}$/);
});

test('GET /api/stats returns counts', async () => {
  const r = await fetch(`${BASE}/api/stats`);
  const body = await r.json();
  assert.equal(typeof body.activeRooms, 'number');
  assert.equal(typeof body.totalParticipants, 'number');
});

test('GET unknown returns 404', async () => {
  const r = await fetch(`${BASE}/nope`);
  assert.equal(r.status, 404);
});

test('WS: join + peer-joined + ping/pong flow', async () => {
  const room = await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json();
  const aliceSess = await (await fetch(`${BASE}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'alice', sourceLang: 'en', targetLang: 'hi' }),
  })).json();
  const bobSess = await (await fetch(`${BASE}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'bob', sourceLang: 'hi', targetLang: 'en' }),
  })).json();

  const wsA = new WebSocket(aliceSess.wsUrl);
  const wsB = new WebSocket(bobSess.wsUrl);

  const joinA = waitForType(wsA, 'joined');
  const joinB = waitForType(wsB, 'joined');
  const peerAJoined = waitForType(wsA, 'peer-joined');
  const pongP = waitForType(wsA, 'pong');

  await Promise.all([open(wsA), open(wsB)]);
  wsA.send(JSON.stringify({ type: 'join', token: aliceSess.token, room: room.code, displayName: 'Alice' }));
  wsB.send(JSON.stringify({ type: 'join', token: bobSess.token, room: room.code, displayName: 'Bob' }));

  const [joinedA, joinedB, peerA] = await Promise.all([joinA, joinB, peerAJoined]);
  assert.equal(joinedA.room, room.code);
  assert.equal(joinedB.room, room.code);
  assert.equal(peerA.peer.displayName, 'Bob');

  wsA.send(JSON.stringify({ type: 'ping' }));
  const pong = await pongP;
  assert.ok(pong.ts > 0);

  wsA.close();
  wsB.close();
});

test('WS: join with bad token is rejected', { timeout: 5000 }, async () => {
  const ws = new WebSocket(`ws://localhost:${PORT}/call`);
  await open(ws);
  ws.send(JSON.stringify({
    type: 'join', token: 'not.a.token', room: 'ZZZZZZ', displayName: 'hax',
  }));
  const err = await waitForType(ws, 'error');
  assert.equal(err.code, 'bad-token');
  ws.close();
});

// helpers

function open(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function waitForType(ws, type, timeoutMs = 3000) {
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
      } catch { /* ignore */ }
    };
    ws.on('message', handler);
  });
}
