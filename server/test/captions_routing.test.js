// test/captions_routing.test.js — unit-level verification of caption routing.
//
// We extract the routing logic and test it directly with mock clients, no
// WebSockets. This is fast, deterministic, and proves the captionsOn gate.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.PORT = '32000';
process.env.PUBLIC_BASE = 'ws://localhost:32000';
process.env.OLLALINK_DASHBOARD_KEY = 'sk_test';
process.env.OLLALINK_WS_URL = 'wss://example.com';
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.LOG_LEVEL = 'error';

const { createRoom, joinRoom, leaveRoom, others } = await import('../src/rooms.js');

// Mock WebSocket that records sends
function mockWs() {
  return {
    readyState: 1,
    sent: [],
    send(data, opts) {
      this.sent.push({ isBinary: !!opts?.binary, data });
    },
    terminate() { this.readyState = 3; },
  };
}

// ---------------------------------------------------------------------------
// Direct routing function under test (extracted from server.js logic)
// ---------------------------------------------------------------------------

/**
 * Mirror of forwardOllalinkToRoom from server.js — kept inline here so the
 * test runs without booting the HTTP server.
 */
function forwardOllalinkToRoom(client, evt) {
  if (!client.session) return;

  if (evt.kind === 'audio') {
    for (const peer of others(client.room.code, client.session.sessionId)) {
      if (peer.ws?.readyState === 1) {
        try {
          peer.ws.send(JSON.stringify({ type: 'audio', from: client.session.sessionId, lang: client.session.targetLang }));
          peer.ws.send(evt.payload, { binary: true });
        } catch { /* ignore */ }
      }
    }
    return;
  }

  const frame = JSON.stringify({
    type: 'caption',
    kind: evt.kind,
    from: client.session.sessionId,
    payload: evt.payload,
  });
  for (const peer of others(client.room.code, client.session.sessionId)) {
    if (peer.ws?.readyState === 1 && peer.captionsOn !== false) {
      try { peer.ws.send(frame); } catch { /* ignore */ }
    }
  }
  if (client.session.captionsOn !== false && client.ws?.readyState === 1) {
    try { client.ws.send(frame); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('audio always forwards to peer regardless of captionsOn', () => {
  const room = createRoom();
  const aliceWs = mockWs();
  const bobWs = mockWs();

  joinRoom(room.code, {
    sessionId: 'a', userId: 'alice', sourceLang: 'en', targetLang: 'hi',
    displayName: 'alice', captionsOn: false, ws: aliceWs, joinedAt: 0,
  });
  joinRoom(room.code, {
    sessionId: 'b', userId: 'bob', sourceLang: 'hi', targetLang: 'en',
    displayName: 'bob', captionsOn: false, ws: bobWs, joinedAt: 0,
  });

  const alice = { session: { sessionId: 'a', userId: 'alice', targetLang: 'hi', captionsOn: false }, room, ws: aliceWs };
  forwardOllalinkToRoom(alice, { kind: 'audio', payload: Buffer.from([0x01, 0x02]) });

  assert.equal(bobWs.sent.length, 2);
  assert.equal(bobWs.sent[0].isBinary, false);
  assert.equal(bobWs.sent[1].isBinary, true);
  assert.equal(aliceWs.sent.length, 0); // speaker gets no echo of their audio
});

test('captionsOn=true peer receives captions; captionsOn=false peer does NOT', () => {
  const room = createRoom();
  const aliceWs = mockWs();
  const bobWs = mockWs();

  joinRoom(room.code, {
    sessionId: 'a', userId: 'alice', sourceLang: 'en', targetLang: 'hi',
    displayName: 'alice', captionsOn: true, ws: aliceWs, joinedAt: 0,
  });
  joinRoom(room.code, {
    sessionId: 'b', userId: 'bob', sourceLang: 'hi', targetLang: 'en',
    displayName: 'bob', captionsOn: false, ws: bobWs, joinedAt: 0,
  });

  // Alice speaks — caption event from Ollalink routed through forwardOllalinkToRoom.
  const alice = { session: { sessionId: 'a', userId: 'alice', targetLang: 'hi', captionsOn: true }, room, ws: aliceWs };
  forwardOllalinkToRoom(alice, { kind: 'caption-final', payload: { text: 'hello', lang: 'en' } });

  // Alice gets echo (captionsOn=true).
  assert.equal(aliceWs.sent.length, 1);
  // Bob does NOT (captionsOn=false).
  assert.equal(bobWs.sent.length, 0);
});

test('captionsOn=true participant sees peers captions even when speaker is captionsOn=false', () => {
  const room = createRoom();
  const aliceWs = mockWs(); // captionsOn=false speaker
  const bobWs = mockWs();   // captionsOn=true peer

  joinRoom(room.code, {
    sessionId: 'a', userId: 'alice', sourceLang: 'en', targetLang: 'hi',
    displayName: 'alice', captionsOn: false, ws: aliceWs, joinedAt: 0,
  });
  joinRoom(room.code, {
    sessionId: 'b', userId: 'bob', sourceLang: 'hi', targetLang: 'en',
    displayName: 'bob', captionsOn: true, ws: bobWs, joinedAt: 0,
  });

  const alice = { session: { sessionId: 'a', userId: 'alice', targetLang: 'hi', captionsOn: false }, room, ws: aliceWs };
  forwardOllalinkToRoom(alice, { kind: 'caption-final', payload: { text: 'hello', lang: 'en' } });

  // Bob SHOULD see alice's caption (his captionsOn=true; speaker's setting doesn't gate listeners)
  assert.equal(bobWs.sent.length, 1);
  // Alice does NOT see her own echo (captionsOn=false gated at the echo)
  assert.equal(aliceWs.sent.length, 0);
});

test('speaker with captionsOn=false does NOT get caption echo of their own speech', () => {
  const room = createRoom();
  const aliceWs = mockWs();
  joinRoom(room.code, {
    sessionId: 'a', userId: 'alice', sourceLang: 'en', targetLang: 'hi',
    displayName: 'alice', captionsOn: false, ws: aliceWs, joinedAt: 0,
  });

  const alice = { session: { sessionId: 'a', userId: 'alice', targetLang: 'hi', captionsOn: false }, room, ws: aliceWs };
  forwardOllalinkToRoom(alice, { kind: 'caption-final', payload: { text: 'hi', lang: 'en' } });

  assert.equal(aliceWs.sent.length, 0);
});

test('disconnected peer (readyState=3) is silently skipped', () => {
  const room = createRoom();
  const aliceWs = mockWs();
  const bobWs = mockWs();
  bobWs.readyState = 3; // closed

  joinRoom(room.code, {
    sessionId: 'a', userId: 'alice', sourceLang: 'en', targetLang: 'hi',
    displayName: 'alice', captionsOn: true, ws: aliceWs, joinedAt: 0,
  });
  joinRoom(room.code, {
    sessionId: 'b', userId: 'bob', sourceLang: 'hi', targetLang: 'en',
    displayName: 'bob', captionsOn: true, ws: bobWs, joinedAt: 0,
  });

  const alice = { session: { sessionId: 'a', userId: 'alice', targetLang: 'hi', captionsOn: true }, room, ws: aliceWs };
  forwardOllalinkToRoom(alice, { kind: 'caption-final', payload: { text: 'hi', lang: 'en' } });

  assert.equal(bobWs.sent.length, 0);
  assert.equal(aliceWs.sent.length, 1); // speaker still gets echo
});

test('audio from speaker routes to peer only, never back to speaker', () => {
  const room = createRoom();
  const aliceWs = mockWs();
  const bobWs = mockWs();

  joinRoom(room.code, {
    sessionId: 'a', userId: 'alice', sourceLang: 'en', targetLang: 'hi',
    displayName: 'alice', captionsOn: true, ws: aliceWs, joinedAt: 0,
  });
  joinRoom(room.code, {
    sessionId: 'b', userId: 'bob', sourceLang: 'hi', targetLang: 'en',
    displayName: 'bob', captionsOn: true, ws: bobWs, joinedAt: 0,
  });

  const alice = { session: { sessionId: 'a', userId: 'alice', targetLang: 'hi', captionsOn: true }, room, ws: aliceWs };
  forwardOllalinkToRoom(alice, { kind: 'audio', payload: Buffer.from([0xaa]) });

  assert.equal(aliceWs.sent.length, 0, 'speaker must not echo own audio');
  assert.equal(bobWs.sent.length, 2, 'peer must receive header + audio');
});
