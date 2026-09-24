// test/voice_tones.test.js — unit tests for voice personas and delivery tones

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Set required env BEFORE importing config-using modules
process.env.PORT = '8787';
process.env.PUBLIC_BASE = 'ws://localhost:8787';
process.env.OLLALINK_DASHBOARD_KEY = 'sk_test';
process.env.OLLALINK_WS_URL = 'wss://example.com';
process.env.SESSION_SECRET = 'test-secret-32-bytes-long-padded!!';
process.env.LOG_LEVEL = 'error';

const { normalizeVoice, normalizeTone, VOICE_PERSONAS, VOICE_TONES } = await import('../src/langs.js');
const { mintSession, verifySession } = await import('../src/auth.js');
const { buildConfig } = await import('../src/ollalink.js');

test('VOICE & TONE: catalog normalization and fallbacks', () => {
  assert.equal(VOICE_PERSONAS.length, 5);
  assert.equal(VOICE_TONES.length, 5);

  // Normalization matches
  assert.equal(normalizeVoice('nh-f01'), 'nh-f01');
  assert.equal(normalizeVoice('dhvaani-ramesh'), 'dhvaani-ramesh');
  assert.equal(normalizeVoice('DHVAANI-MALE'), 'dhvaani-male');
  assert.equal(normalizeVoice('invalid-voice-id'), 'nh-m01'); // fallback

  assert.equal(normalizeTone('formal'), 'formal');
  assert.equal(normalizeTone('CHEERFUL'), 'cheerful');
  assert.equal(normalizeTone('calm'), 'calm');
  assert.equal(normalizeTone('dynamic'), 'dynamic');
  assert.equal(normalizeTone('unknown-tone'), 'natural'); // fallback
});

test('VOICE & TONE: session token roundtrip preserves voice and tone', () => {
  const session = mintSession({
    userId: 'TestUser',
    sourceLang: 'en',
    targetLang: 'hi',
    voice: 'nh-f01',
    tone: 'cheerful',
  });

  assert.equal(session.voice, 'nh-f01');
  assert.equal(session.tone, 'cheerful');

  const verified = verifySession(session.token);
  assert.ok(verified);
  assert.equal(verified.sub, 'TestUser');
  assert.equal(verified.src, 'en');
  assert.equal(verified.tgt, 'hi');
  assert.equal(verified.voice, 'nh-f01');
  assert.equal(verified.tone, 'cheerful');
});

test('VOICE & TONE: buildConfig translates persona and tone into session.configure', () => {
  const cfgStr = buildConfig({
    sourceLang: 'en',
    targetLangs: ['hi', 'kn'],
    sessionToken: 'test-session-123',
    voice: 'dhvaani-ramesh',
    tone: 'formal',
  });

  const parsed = JSON.parse(cfgStr);
  assert.equal(parsed.type, 'session.configure');
  assert.equal(parsed.tts.enabled, true);
  assert.equal(parsed.tts.voice, 'dhvaani-ramesh');
  assert.equal(parsed.tts.tone, 'formal');
});

test('VOICE & TONE: buildConfig omits tone field when natural (default)', () => {
  const cfgStr = buildConfig({
    sourceLang: 'en',
    targetLangs: ['hi'],
    sessionToken: 'test-session-456',
    voice: 'nh-m01',
    tone: 'natural',
  });

  const parsed = JSON.parse(cfgStr);
  assert.equal(parsed.tts.voice, 'nh-m01');
  assert.equal(parsed.tts.tone, undefined); // natural tone keeps default clean schema
});
