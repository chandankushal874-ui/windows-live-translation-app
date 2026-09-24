// test/regressions.test.js — regression tests for audit findings.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

let PORT;
let BASE;
let serverHandle;

before(async () => {
  PORT = 24000 + Math.floor(Math.random() * 10000);
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

after(async () => {
  await serverHandle.close();
});

// F12: oversized POST rejected
test('F12: POST /api/session with >64KB body returns 413', async () => {
  const controller = new AbortController();
  const bigBody = JSON.stringify({
    userId: 'a'.repeat(200_000),
    sourceLang: 'en',
    targetLang: 'hi',
  });
  const r = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bigBody,
    signal: controller.signal,
  }).catch((e) => e);
  // Either we got 413 back, or the request errored as the connection was destroyed.
  if (r instanceof Error) {
    assert.match(String(r.cause?.code ?? r.message), /(UND_ERR|ECONNRESET|socket|abort)/i);
  } else {
    assert.equal(r.status, 413);
  }
});

// F12b: individually-long fields rejected even within body cap
test('F12b: POST /api/session with very long userId returns 400', async () => {
  const r = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: 'a'.repeat(500),  // exceeds 128 char sanity limit
      sourceLang: 'en',
      targetLang: 'hi',
    }),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /too long/i);
});

// F5: session refresh with mismatched userId rejected
test('F5: session.refresh with wrong userId is rejected', async () => {
  const sessAlice = await mintSess('alice', 'en', 'hi');
  const sessBob = await mintSess('bob', 'en', 'hi');
  const room = await createRoom();

  const wsA = new WebSocket(sessAlice.wsUrl);
  await openWs(wsA);
  wsA.send(JSON.stringify({
    type: 'join', token: sessAlice.token, room: room.code, displayName: 'Alice',
  }));
  await waitForType(wsA, 'joined');

  // Alice tries to refresh using Bob's token — must be rejected.
  wsA.send(JSON.stringify({ type: 'session.refresh', token: sessBob.token }));
  const err = await waitForType(wsA, 'error');
  assert.equal(err.code, 'token-mismatch');
  wsA.close();
});

// Reconnect / dedupe: same userId joining twice removes the stale entry
test('Dedupe: same userId joining twice is allowed and evicts stale', async () => {
  const sess1 = await mintSess('alice', 'en', 'hi');
  const sess2 = await mintSess('alice', 'en', 'hi');
  const room = await createRoom();

  const ws1 = new WebSocket(sess1.wsUrl);
  await openWs(ws1);
  ws1.send(JSON.stringify({ type: 'join', token: sess1.token, room: room.code, displayName: 'alice-1' }));
  const joined1 = await waitForType(ws1, 'joined');
  const sid1 = joined1.self.sessionId;

  // Wait — server-side dedupe is only invoked when *another* client joins.
  // Manually simulate by having Bob join, which evicts stale alice-1 if present.
  // Actually, our dedupe runs on join: if the same userId is already seated,
  // the SEATED one is removed. So ws2 with the same userId should evict ws1
  // at the moment ws2 joins.

  const ws2 = new WebSocket(sess2.wsUrl);
  await openWs(ws2);
  ws2.send(JSON.stringify({ type: 'join', token: sess2.token, room: room.code, displayName: 'alice-2' }));
  const joined2 = await waitForType(ws2, 'joined');

  assert.notEqual(joined2.self.sessionId, sid1);

  // After ws2 joins, ws1 should be disconnected or its removal broadcast.
  // We can verify by checking that the participants list sent to ws2 only has one.
  assert.equal(joined2.participants.length, 1);
  assert.equal(joined2.participants[0].sessionId, joined2.self.sessionId);

  ws1.close();
  ws2.close();
});

// Helpers

async function mintSess(userId, sourceLang, targetLang) {
  const r = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, sourceLang, targetLang }),
  });
  return r.json();
}

async function createRoom() {
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST' });
  return r.json();
}

function openWs(ws) {
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
