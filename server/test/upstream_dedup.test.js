// test/upstream_dedup.test.js — Deep test of BUG-B fix (duplicate translations from upstream re-open).
//
// Tests three layers of the fix:
// 1. Message handler checks state.closing before forwarding events
// 2. close() calls removeAllListeners('message') to detach the handler
// 3. Relay deduplicates audio chunks by utteranceId + chunkSeq + language

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';

const TEST_PORT = 35100;
const MOCK_PORT = 35101;

process.env.PORT = String(TEST_PORT);
process.env.PUBLIC_BASE = `ws://localhost:${TEST_PORT}`;
process.env.OLLALINK_DASHBOARD_KEY = 'sk_test_dedup';
process.env.OLLALINK_WS_URL = `ws://127.0.0.1:${MOCK_PORT}/v1/speech/stream`;
process.env.SESSION_SECRET = 'a'.repeat(64);
process.env.LOG_LEVEL = 'error';

const { startServer } = await import('../src/server.js');
const { openOllalinkStream, translateEvent } = await import('../src/ollalink.js');

let relayHandle;
let mockOllalink;
const mockSessions = [];

before(async () => {
  // Mock Ollalink server
  mockOllalink = new WebSocketServer({ port: MOCK_PORT });
  mockOllalink.on('connection', (ws, req) => {
    const session = { ws, req, received: [], config: null, eventsSent: [] };
    mockSessions.push(session);
    ws.on('message', (data, isBinary) => {
      session.received.push({ isBinary, data });
      if (!isBinary) {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'session.configure') {
            session.config = parsed;
            ws.send(JSON.stringify({ type: 'session.created' }));
            ws.send(JSON.stringify({
              type: 'session.ready',
              capabilities: ['transcription', 'translation', 'tts'],
              config_applied: { tts: { lanes: { hi: 'stream', en: 'stream' } } },
            }));
          }
        } catch {}
      }
    });
  });

  relayHandle = startServer();
  await new Promise(r => setTimeout(r, 300));
});

after(async () => {
  for (const s of mockSessions) { try { s.ws.terminate(); } catch {} }
  await new Promise(r => mockOllalink.close(r));
  await relayHandle.close();
});

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`http://localhost:${TEST_PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(out || '{}') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function waitType(ws, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout for ${type}`)), timeoutMs);
    const handler = (data, isBinary) => {
      if (isBinary) return;
      try {
        const m = JSON.parse(data.toString());
        if (m.type === type) { clearTimeout(timer); ws.off('message', handler); resolve(m); }
      } catch {}
    };
    ws.on('message', handler);
  });
}

function waitAudioPair(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let pending = null;
    const timer = setTimeout(() => reject(new Error('timeout for audio pair')), timeoutMs);
    const handler = (data, isBinary) => {
      if (!isBinary) {
        try {
          const m = JSON.parse(data.toString());
          if (m.type === 'audio') {
            if (m.hasBinary === false || m.endOfUtterance === true) {
              clearTimeout(timer); ws.off('message', handler); resolve({ header: m, body: null });
            } else { pending = m; }
          }
        } catch {}
      } else if (pending) {
        clearTimeout(timer); ws.off('message', handler); resolve({ header: pending, body: Buffer.from(data) });
      }
    };
    ws.on('message', handler);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1: Source code static analysis — message handler checks state.closing
// ═══════════════════════════════════════════════════════════════════════════

test('BUG-B FIX L1: Message handler checks state.closing before forwarding', () => {
  const source = readFileSync(new URL('../src/ollalink.js', import.meta.url), 'utf8');

  // The message handler must check state.closing
  assert.ok(source.includes("if (state.closing) return;"),
    'Message handler must check state.closing');

  // The check should appear in the message handler (not just the close handler)
  const msgHandlerStart = source.indexOf("upstream.on('message'");
  const msgHandlerEnd = source.indexOf('});', msgHandlerStart);
  const msgHandler = source.substring(msgHandlerStart, msgHandlerEnd + 3);
  assert.ok(msgHandler.includes('state.closing'),
    'state.closing check must be inside the message handler');
});

test('BUG-B FIX L1: close() calls removeAllListeners to detach message handler', () => {
  const source = readFileSync(new URL('../src/ollalink.js', import.meta.url), 'utf8');

  assert.ok(source.includes("removeAllListeners('message')"),
    'close() must call removeAllListeners("message") to fully detach the handler');
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2: Unit test — openOllalinkStream suppresses events after close()
// ═══════════════════════════════════════════════════════════════════════════

test('BUG-B FIX L2: openOllalinkStream does NOT forward events after close()', async () => {
  // We need to test against the real mock Ollalink
  // Open a stream, then close it, then send an event from the mock
  // and verify the event is NOT forwarded

  const events = [];
  const handlers = {
    onEvent: (evt) => events.push(evt),
    onClose: () => {},
    onError: () => {},
  };

  // Open stream
  const stream = openOllalinkStream({
    sourceLang: 'en',
    targetLangs: ['hi'],
    sessionToken: 'test',
  }, handlers);

  // Wait for connection + config
  await new Promise(r => setTimeout(r, 300));

  // Find the mock session for this stream
  const mockSession = mockSessions[mockSessions.length - 1];
  assert.ok(mockSession, 'Mock session should exist');
  assert.ok(mockSession.config, 'Config should be received');

  // Send a translation event BEFORE close — should be forwarded
  mockSession.ws.send(JSON.stringify({
    type: 'translation.final',
    text: 'hello',
    language: 'hi',
    utterance_id: 'u-test-1',
  }));
  await new Promise(r => setTimeout(r, 100));

  const eventsBeforeClose = events.length;
  assert.ok(eventsBeforeClose > 0, 'Events before close should be forwarded');

  // Now close the stream
  stream.close();
  await new Promise(r => setTimeout(r, 50));

  // Send another event AFTER close — should NOT be forwarded
  mockSession.ws.send(JSON.stringify({
    type: 'translation.final',
    text: 'world',
    language: 'hi',
    utterance_id: 'u-test-2',
  }));

  // Wait and check
  await new Promise(r => setTimeout(r, 200));

  const eventsAfterClose = events.length;
  assert.equal(eventsAfterClose, eventsBeforeClose,
    'Events after close must NOT be forwarded — no new events should arrive');
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 3: Relay deduplicates audio chunks by utteranceId + chunkSeq
// ═══════════════════════════════════════════════════════════════════════════

test('BUG-B FIX L3: Relay has utterance_id + chunkSeq deduplication', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

  assert.ok(source.includes('seenAudioChunks'),
    'Relay must track seen audio chunks');
  assert.ok(source.includes('utteranceId') && source.includes('chunkSeq'),
    'Dedup key must use utteranceId and chunkSeq');
  assert.ok(source.includes('chunkKey'),
    'A composite chunk key must be constructed');
  assert.ok(source.includes('has(chunkKey)'),
    'Must check if chunk was already seen');
  assert.ok(source.includes('return;') && source.includes('Suppress duplicate'),
    'Must suppress duplicate chunks');
  assert.ok(source.includes('size > 500'),
    'Must have a cap on the dedup set to prevent memory leak');
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 4: End-to-end — peer join does NOT produce duplicate translations
// ═══════════════════════════════════════════════════════════════════════════

test('BUG-B FIX L4: Peer join does NOT produce duplicate audio chunks', async () => {
  // Alice joins alone, then Bob joins.
  // Alice's upstream is re-opened on Bob's join.
  // If the old upstream delivers events after close, they should be suppressed.

  const roomRes = await httpPost('/api/rooms', {});
  const code = roomRes.data.code;

  const aliceSess = await httpPost('/api/session', { userId: 'alice', sourceLang: 'en', targetLang: 'hi' });
  const bobSess = await httpPost('/api/session', { userId: 'bob', sourceLang: 'hi', targetLang: 'en' });

  const aliceWs = new WebSocket(aliceSess.data.wsUrl);
  await new Promise(r => aliceWs.on('open', r));
  aliceWs.send(JSON.stringify({ type: 'join', token: aliceSess.data.token, room: code, displayName: 'Alice' }));
  await waitType(aliceWs, 'joined');

  // Wait for Alice's upstream to be ready
  await new Promise(r => setTimeout(r, 300));
  const aliceUpstream1 = mockSessions[mockSessions.length - 1];
  assert.ok(aliceUpstream1?.config, 'Alice upstream 1 should be configured');

  // Bob joins — this triggers Alice's upstream re-open
  const bobWs = new WebSocket(bobSess.data.wsUrl);
  await new Promise(r => bobWs.on('open', r));
  bobWs.send(JSON.stringify({ type: 'join', token: bobSess.data.token, room: code, displayName: 'Bob' }));
  await waitType(bobWs, 'joined');

  // Wait for Alice's upstream to be re-opened
  await new Promise(r => setTimeout(r, 400));

  // Find Alice's NEW upstream (the latest one with recognition.language === 'en')
  const aliceUpstreams = mockSessions.filter(s => s.config?.recognition?.language === 'en');
  const aliceUpstream2 = aliceUpstreams[aliceUpstreams.length - 1];
  assert.ok(aliceUpstream2, 'Alice should have a new upstream after Bob joined');

  // Try to send a duplicate event from the OLD upstream
  // Use a unique utterance_id that the new upstream will also send
  const duplicateEvent = {
    type: 'translation.audio',
    codec: 'pcm_s16le',
    sample_rate: 48000,
    language: 'hi',
    chunk_seq: 1,
    last: false,
    audio_b64: Buffer.from([0x01, 0x02]).toString('base64'),
    utterance_id: 'u-dup-test-001',
  };

  // Send from OLD upstream (should be suppressed by state.closing check)
  if (aliceUpstream1.ws.readyState === WebSocket.OPEN) {
    aliceUpstream1.ws.send(JSON.stringify(duplicateEvent));
  }

  // Send the SAME event from NEW upstream (should be forwarded, then deduplicated)
  aliceUpstream2.ws.send(JSON.stringify(duplicateEvent));

  // Bob should receive at most 1 audio chunk (not 2)
  let bobAudioCount = 0;
  const audioPromise = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(bobAudioCount), 1000);
    bobWs.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const m = JSON.parse(data.toString());
          if (m.type === 'audio' && m.hasBinary !== false) {
            bobAudioCount++;
          }
        } catch {}
      } else {
        bobAudioCount++;
      }
    });
  });

  await audioPromise;
  assert.ok(bobAudioCount <= 1,
    `Bob should receive at most 1 audio chunk, got ${bobAudioCount} — duplicate suppression`);

  aliceWs.close();
  bobWs.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 5: Dedup set is per-client and bounded
// ═══════════════════════════════════════════════════════════════════════════

test('BUG-B FIX L5: Dedup set is per-client and bounded at 500 entries', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

  // The dedup set must be on the client object (not global)
  assert.ok(source.includes('client.seenAudioChunks'),
    'Dedup set must be per-client');

  // Must have a size cap
  assert.ok(source.includes('size > 500'),
    'Dedup set must be capped at 500 entries');

  // Must evict oldest when cap is exceeded
  assert.ok(source.includes('delete') && source.includes('values().next()'),
    'Must evict oldest entry when cap exceeded');
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 6: Terminate timeout reduced from 100ms to 50ms
// ═══════════════════════════════════════════════════════════════════════════

test('BUG-B FIX L6: Terminate timeout reduced from 100ms to 50ms', () => {
  const source = readFileSync(new URL('../src/ollalink.js', import.meta.url), 'utf8');

  // The old timeout was 100ms; the new one should be 50ms or less
  const closeSection = source.substring(source.indexOf('close()'), source.indexOf('isOpen'));
  assert.ok(closeSection.includes('50'),
    'Terminate timeout should be 50ms (reduced from 100ms)');
});