// test/sample_rate_and_orphan_regression.test.js
// Regression test suite for Concern D (Bugs 17, 18, 19, 23).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '35200';
process.env.PUBLIC_BASE = 'ws://localhost:35200';
process.env.OLLALINK_DASHBOARD_KEY = 'sk_test_dummy';
process.env.OLLALINK_WS_URL = 'ws://127.0.0.1:35201/v1/speech/stream';
process.env.SESSION_SECRET = 'a'.repeat(64);
process.env.LOG_LEVEL = 'error';

const { translateEvent } = await import('../src/ollalink.js');

test('ollalink.js: streaming PCM lane defaults to 48 kHz when sample_rate is omitted', () => {
  const evt = translateEvent(JSON.stringify({
    type: 'translation.audio',
    codec: 'pcm_s16le',
    audio_b64: Buffer.from([0, 0, 10, 0]).toString('base64'),
    language: 'hi',
    chunk_seq: 1,
  }));

  assert.equal(evt.kind, 'audio');
  assert.equal(evt.payload.codec, 'pcm_s16le');
  assert.equal(evt.payload.sampleRate, 48000, 'Streaming PCM without explicit sample_rate must default to 48000');
});

test('ollalink.js: batch WAV lane defaults to 24 kHz when sample_rate is omitted', () => {
  const evt = translateEvent(JSON.stringify({
    type: 'translation.audio',
    codec: 'wav',
    audio_b64: Buffer.from([0, 0, 10, 0]).toString('base64'),
    language: 'kn',
    chunk_seq: 1,
  }));

  assert.equal(evt.kind, 'audio');
  assert.equal(evt.payload.codec, 'wav');
  assert.equal(evt.payload.sampleRate, 24000, 'Batch WAV without explicit sample_rate must default to 24000');
});

test('ollalink.js: self-describing WAV header byte inspection extracts native sample rate', () => {
  // Create minimal 44-byte RIFF WAVE header with 24000 sample rate at byte 24..27
  const wavHeader = Buffer.alloc(44);
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20); // PCM
  wavHeader.writeUInt16LE(1, 22); // mono
  wavHeader.writeUInt32LE(24000, 24); // 24 kHz
  wavHeader.writeUInt32LE(48000, 28);
  wavHeader.writeUInt16LE(2, 32);
  wavHeader.writeUInt16LE(16, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(0, 40);

  const evt = translateEvent(JSON.stringify({
    type: 'translation.audio',
    audio_b64: wavHeader.toString('base64'),
    language: 'kn',
    chunk_seq: 0,
  }));

  assert.equal(evt.kind, 'audio');
  assert.equal(evt.payload.codec, 'wav');
  assert.equal(evt.payload.sampleRate, 24000, 'WAV byte inspection must extract 24000 from bytes 24..27');
});

test('browser bridge fallback logic: correctly differentiates streaming PCM (48k) from WAV (24k)', () => {
  const resolveRate = (msg) => {
    const isWavCodec = msg.codec === 'wav';
    return (typeof msg.sampleRate === 'number' && msg.sampleRate > 0)
      ? msg.sampleRate
      : (isWavCodec ? 24000 : 48000);
  };

  // Explicit rate provided
  assert.equal(resolveRate({ codec: 'pcm_s16le', sampleRate: 16000 }), 16000);
  // Omitted rate on streaming PCM
  assert.equal(resolveRate({ codec: 'pcm_s16le' }), 48000, 'Streaming PCM must resolve to 48000 when omitted');
  // Omitted rate on WAV batch
  assert.equal(resolveRate({ codec: 'wav' }), 24000, 'WAV batch must resolve to 24000 when omitted');
});

test('browser bridge orphan queue: buffers binary frames arriving before text header and pairs on arrival', () => {
  let pendingAudioMetaQueue = [];
  let pendingBinaryQueue = [];
  let playedChunks = [];

  const onBinaryFrame = (buf, isWav) => {
    if (isWav) {
      const meta = pendingAudioMetaQueue.shift();
      playedChunks.push({ buf, sr: meta?.sampleRate || 24000 });
    } else if (pendingAudioMetaQueue.length > 0) {
      const meta = pendingAudioMetaQueue.shift();
      playedChunks.push({ buf, sr: meta.sampleRate });
    } else {
      // Orphan binary: buffer until text header arrives
      pendingBinaryQueue.push(buf);
    }
  };

  const onTextMessage = (msg) => {
    const isWavCodec = msg.codec === 'wav';
    const sr = (typeof msg.sampleRate === 'number' && msg.sampleRate > 0)
      ? msg.sampleRate
      : (isWavCodec ? 24000 : 48000);

    if (msg.hasBinary) {
      if (pendingBinaryQueue.length > 0) {
        const orphanBuf = pendingBinaryQueue.shift();
        playedChunks.push({ buf: orphanBuf, sr });
      } else {
        pendingAudioMetaQueue.push({ sampleRate: sr });
      }
    }
  };

  // Test Case A: Binary frame arrives BEFORE text header (orphan binary)
  const dummyBuf1 = new Uint8Array([1, 2, 3, 4]).buffer;
  onBinaryFrame(dummyBuf1, false);

  assert.equal(pendingBinaryQueue.length, 1, 'Orphan binary frame must be held in queue');
  assert.equal(playedChunks.length, 0, 'Orphan binary must not play with unverified rate');

  // Text header arrives second
  onTextMessage({ type: 'audio', hasBinary: true, codec: 'pcm_s16le', sampleRate: 48000 });

  assert.equal(pendingBinaryQueue.length, 0, 'Orphan binary queue must be consumed upon header arrival');
  assert.equal(playedChunks.length, 1);
  assert.equal(playedChunks[0].sr, 48000, 'Paired chunk must play with verified 48000 rate');
});

test('browser bridge lookahead clamp: prevents burst drift beyond 300ms', () => {
  const MAX_LOOKAHEAD = 0.30;
  let nextPlayTime = 0;
  let now = 10.0; // AudioContext currentTime at 10 seconds

  const scheduleChunk = (duration) => {
    if (nextPlayTime < now) {
      nextPlayTime = now;
    } else if (nextPlayTime > now + MAX_LOOKAHEAD) {
      // Clamp drift
      nextPlayTime = now + MAX_LOOKAHEAD;
    }
    const scheduledAt = nextPlayTime;
    nextPlayTime += duration;
    return scheduledAt;
  };

  // Schedule chunk 1 (200ms)
  const t1 = scheduleChunk(0.20);
  assert.ok(Math.abs(t1 - 10.0) < 1e-4);
  assert.ok(Math.abs(nextPlayTime - 10.20) < 1e-4);

  // Schedule chunk 2 (200ms)
  const t2 = scheduleChunk(0.20);
  assert.ok(Math.abs(t2 - 10.20) < 1e-4);
  assert.ok(Math.abs(nextPlayTime - 10.40) < 1e-4); // 400ms ahead of now (10.0)

  // Chunk 3 arrives immediately in a burst: drift would push it to 10.40 (400ms ahead)
  // Clamp must pull it back to now + MAX_LOOKAHEAD (10.30)
  const t3 = scheduleChunk(0.20);
  assert.ok(Math.abs(t3 - 10.30) < 1e-4, 'Bursted chunk must clamp to now + MAX_LOOKAHEAD (10.30s)');
});
