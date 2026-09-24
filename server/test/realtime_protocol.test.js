// test/realtime_protocol.test.js â€” verify our adapter against the real
// sound-stream schema published at https://voices.networkershome.com/docs/realtime-speech/

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

process.env.PORT = '33400';
process.env.PUBLIC_BASE = 'ws://localhost:33400';
process.env.OLLALINK_DASHBOARD_KEY = 'sk_test_' + randomBytes(8).toString('hex');
process.env.OLLALINK_WS_URL = 'wss://example.com'; // not used in these unit tests
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.LOG_LEVEL = 'error';

const { buildConfig, translateEvent } = await import('../src/ollalink.js');

// ---------------------------------------------------------------------------
// buildConfig â€” matches the documented session.configure shape
// ---------------------------------------------------------------------------

test('buildConfig emits the documented session.configure schema', () => {
  const raw = buildConfig({
    sourceLang: 'en',
    targetLangs: ['hi'],
    sessionToken: 'abc',
    voice: 'nh-m01',
  });
  const cfg = JSON.parse(raw);
  assert.equal(cfg.type, 'session.configure');
  assert.equal(cfg.api_key, process.env.OLLALINK_DASHBOARD_KEY);
  assert.deepEqual(cfg.audio, { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le' });
  assert.equal(cfg.recognition.language, 'en');
  assert.equal(cfg.recognition.punctuation, true);
  assert.equal(cfg.endpointing.mode, 'auto');
  assert.equal(cfg.endpointing.silence_ms, 600);
  assert.deepEqual(cfg.translation, { enabled: true, targets: ['hi'] });
  assert.deepEqual(cfg.tts, { enabled: true, voice: 'nh-m01' });
});

test('buildConfig with multi-target fanout (3 listeners)', () => {
  const cfg = JSON.parse(buildConfig({
    sourceLang: 'en',
    targetLangs: ['hi', 'kn', 'ta'],
    sessionToken: 'x',
  }));
  assert.deepEqual(cfg.translation.targets, ['hi', 'kn', 'ta']);
});

test('buildConfig accepts "auto" source_lang (omitted per real docs)', () => {
  const cfg = JSON.parse(buildConfig({
    sourceLang: 'auto',
    targetLangs: ['en'],
    sessionToken: 'x',
  }));
  assert.equal(cfg.recognition.language, undefined);
});

// ---------------------------------------------------------------------------
// translateEvent â€” event kinds from the real docs
// ---------------------------------------------------------------------------

test('session.ready â†’ ready', () => {
  const evt = translateEvent(JSON.stringify({
    type: 'session.ready',
    capabilities: ['transcription', 'translation', 'tts'],
    translation_targets: ['hi'],
    tts_voice: 'nh-m01',
    config_applied: { tts: { lanes: { hi: 'stream' } } },
  }));
  assert.equal(evt.kind, 'ready');
  assert.equal(evt.payload.tts_voice, 'nh-m01');
});

test('transcript.partial â†’ caption-partial', () => {
  const evt = translateEvent(JSON.stringify({
    type: 'transcript.partial', text: 'hello', language: 'en',
  }));
  assert.equal(evt.kind, 'caption-partial');
  assert.equal(evt.payload.text, 'hello');
});

test('transcript.final â†’ caption-final with utterance_id', () => {
  const evt = translateEvent(JSON.stringify({
    type: 'transcript.final', text: 'hello world', language: 'en', utterance_id: 'u-42',
  }));
  assert.equal(evt.kind, 'caption-final');
  assert.equal(evt.payload.utterance_id, 'u-42');
});

test('translation.delta â†’ translation-delta', () => {
  const evt = translateEvent(JSON.stringify({
    type: 'translation.delta', text: 'à¤¨à¤®à¤¸à¥à¤¤à¥‡', language: 'hi',
  }));
  assert.equal(evt.kind, 'translation-delta');
});

test('translation.final â†’ translation', () => {
  const evt = translateEvent(JSON.stringify({
    type: 'translation.final', text: 'à¤¨à¤®à¤¸à¥à¤¤à¥‡, à¤¦à¥à¤¨à¤¿à¤¯à¤¾', language: 'hi', utterance_id: 'u-1',
  }));
  assert.equal(evt.kind, 'translation');
});

test('translation.audio with pcm: decodes audio_b64 to Buffer', () => {
  const pcmBytes = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
  const b64 = pcmBytes.toString('base64');
  const evt = translateEvent(JSON.stringify({
    type: 'translation.audio',
    codec: 'pcm_s16le',
    sample_rate: 48000,
    language: 'hi',
    chunk_seq: 7,
    last: false,
    audio_b64: b64,
  }));
  assert.equal(evt.kind, 'audio');
  assert.equal(evt.payload.codec, 'pcm_s16le');
  assert.equal(evt.payload.sampleRate, 48000);
  assert.equal(evt.payload.language, 'hi');
  assert.equal(evt.payload.chunkSeq, 7);
  assert.equal(evt.payload.last, false);
  assert.deepEqual(evt.payload.pcm, pcmBytes);
});

test('translation.audio end-of-utterance marker (last=true, no audio_b64)', () => {
  const evt = translateEvent(JSON.stringify({
    type: 'translation.audio',
    codec: 'pcm_s16le',
    sample_rate: 48000,
    language: 'hi',
    chunk_seq: 5,
    last: true,
  }));
  assert.equal(evt.kind, 'audio');
  assert.equal(evt.payload.last, true);
  assert.equal(evt.payload.pcm, null);
});

test('translation.audio on batch lane (wav codec @ 24 kHz)', () => {
  const evt = translateEvent(JSON.stringify({
    type: 'translation.audio',
    codec: 'wav',
    sample_rate: 24000,
    language: 'kn',
    chunk_seq: 0,
    last: true,
    audio_b64: Buffer.from('RIFF....').toString('base64'),
  }));
  assert.equal(evt.payload.codec, 'wav');
  assert.equal(evt.payload.sampleRate, 24000);
  assert.equal(evt.payload.language, 'kn');
});

test('error with documented code â†’ kind=error, code+detail preserved', () => {
  const evt = translateEvent(JSON.stringify({
    type: 'error',
    code: 'unsupported_translation_target',
    detail: "target 'en-US' not in supported list",
  }));
  assert.equal(evt.kind, 'error');
  assert.equal(evt.payload.code, 'unsupported_translation_target');
});

test('warning is non-fatal', () => {
  const evt = translateEvent(JSON.stringify({
    type: 'warning', code: 'unknown_config_keys', detail: 'ignored: foo,bar',
  }));
  assert.equal(evt.kind, 'warning');
});

test('usage / session.closed / session.created survive', () => {
  for (const t of ['usage', 'session.closed', 'session.created']) {
    const evt = translateEvent(JSON.stringify({ type: t, extra: 'fields', ok: true }));
    if (t === 'session.created') assert.equal(evt.kind, 'session-created');
    else if (t === 'session.closed') assert.equal(evt.kind, 'session-closed');
    else assert.equal(evt.kind, t);
  }
});

test('unknown type does not crash', () => {
  const evt = translateEvent(JSON.stringify({ type: 'new.future.event', data: 1 }));
  assert.equal(evt.kind, 'unknown');
});

test('non-JSON upstream string degrades to kind=unknown', () => {
  const evt = translateEvent('not json');
  assert.equal(evt.kind, 'unknown');
});

test('binary upstream data is treated as unknown (should not happen on this lane)', () => {
  const evt = translateEvent(Buffer.from([0x00, 0x01, 0x02]));
  assert.equal(evt.kind, 'unknown');
});

test('live-translation docs dialect: ready, partial, final, translation', () => {
  assert.equal(translateEvent(JSON.stringify({ type: 'ready' })).kind, 'ready');
  assert.equal(translateEvent(JSON.stringify({ type: 'partial', text: 'hi', lang: 'en' })).kind, 'caption-partial');
  assert.equal(translateEvent(JSON.stringify({ type: 'final', text: 'hi world', lang: 'en', segment_id: 1 })).kind, 'caption-final');
  assert.equal(translateEvent(JSON.stringify({ type: 'translation', text: 'नमस्ते दुनिया', lang: 'hi', segment_id: 1 })).kind, 'translation');
});
