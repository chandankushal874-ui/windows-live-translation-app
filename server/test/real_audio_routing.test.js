// test/real_audio_routing.test.js — verifies the ACTUAL forwardOllalinkToRoom in server.js
// specifically proving that peers receive audio and the generator .length bug is permanently fixed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.PORT = '32100';
process.env.PUBLIC_BASE = 'ws://localhost:32100';
process.env.OLLALINK_DASHBOARD_KEY = 'sk_test_key_12345';
process.env.OLLALINK_WS_URL = 'wss://example.com';
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.LOG_LEVEL = 'error';

const { createRoom, joinRoom } = await import('../src/rooms.js');
const { forwardOllalinkToRoom } = await import('../src/server.js');

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

test('SRV-01 FIX: translated audio IS delivered to peers (generator .length bug eliminated)', () => {
  const room = createRoom();
  const aliceWs = mockWs();
  const bobWs = mockWs();

  joinRoom(room.code, {
    sessionId: 'sess_alice', userId: 'alice', sourceLang: 'en', targetLang: 'hi',
    displayName: 'Alice', captionsOn: false, ws: aliceWs, joinedAt: 0,
  });
  joinRoom(room.code, {
    sessionId: 'sess_bob', userId: 'bob', sourceLang: 'hi', targetLang: 'hi',
    displayName: 'Bob', captionsOn: false, ws: bobWs, joinedAt: 0,
  });

  const aliceClient = {
    session: { sessionId: 'sess_alice', userId: 'alice', targetLang: 'hi', ws: aliceWs },
    room,
    ws: aliceWs,
  };

  const audioPayload = {
    pcm: Buffer.from([0x01, 0x02, 0x03, 0x04]),
    codec: 'pcm_s16le',
    sampleRate: 48000,
    language: 'hi',
    chunkSeq: 1,
    last: false,
  };

  // Route translated Hindi audio from Alice's speech
  forwardOllalinkToRoom(aliceClient, { kind: 'audio', payload: audioPayload });

  // Bob MUST receive the audio header AND binary frame!
  assert.equal(bobWs.sent.length, 2, 'Peer (Bob) must receive exactly 2 messages (header + binary)');
  assert.equal(bobWs.sent[0].isBinary, false, 'Message 0 must be JSON header');
  assert.equal(bobWs.sent[1].isBinary, true, 'Message 1 must be binary PCM');

  const header = JSON.parse(bobWs.sent[0].data);
  assert.equal(header.type, 'audio');
  assert.equal(header.from, 'sess_alice');
  assert.equal(header.lang, 'hi');
  assert.equal(header.sampleRate, 48000);

  // Alice (the speaker) MUST NOT receive her own audio echoed back
  assert.equal(aliceWs.sent.length, 0, 'Speaker (Alice) must NOT receive her own audio echo');
});

test('SRV-01 SOLO TEST: when alone in room, speaker receives audio for local debugging', () => {
  const room = createRoom();
  const aliceWs = mockWs();

  joinRoom(room.code, {
    sessionId: 'sess_alice', userId: 'alice', sourceLang: 'en', targetLang: 'hi',
    displayName: 'Alice', captionsOn: false, ws: aliceWs, joinedAt: 0,
  });

  const aliceClient = {
    session: { sessionId: 'sess_alice', userId: 'alice', targetLang: 'hi' },
    room,
    ws: aliceWs,
  };

  const audioPayload = {
    pcm: Buffer.from([0xAA, 0xBB]),
    codec: 'pcm_s16le',
    sampleRate: 48000,
    language: 'hi',
    chunkSeq: 1,
    last: false,
  };

  // Solo speaker
  forwardOllalinkToRoom(aliceClient, { kind: 'audio', payload: audioPayload });

  // In solo room, Alice receives the echo
  assert.equal(aliceWs.sent.length, 2, 'Solo speaker receives audio echo for testing');
});
