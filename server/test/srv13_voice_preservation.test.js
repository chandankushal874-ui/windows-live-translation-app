// test/srv13_voice_preservation.test.js — verifies that voice & tone are preserved on lang.change and token refresh

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';

process.env.PORT = '32300';
process.env.PUBLIC_BASE = 'ws://localhost:32300';
process.env.OLLALINK_DASHBOARD_KEY = 'sk_test_mock_key';
process.env.OLLALINK_WS_URL = 'ws://127.0.0.1:32301/v1/speech/stream';
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.LOG_LEVEL = 'error';

const { startServer } = await import('../src/server.js');
const { mintSession } = await import('../src/auth.js');

let relayHandle;
let mockOllalinkWss;
const upstreamConfigs = [];

before(async () => {
  mockOllalinkWss = new WebSocketServer({ port: 32301, path: '/v1/speech/stream' });
  mockOllalinkWss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const parsed = JSON.parse(data.toString('utf8'));
          if (parsed.type === 'session.configure' || parsed.type === 'config') {
            upstreamConfigs.push(parsed);
            ws.send(JSON.stringify({ type: 'session.ready', lanes: ['stream'] }));
          }
        } catch {}
      }
    });
  });

  relayHandle = await startServer();
});

after(async () => {
  if (relayHandle) await relayHandle.close();
  if (mockOllalinkWss) await new Promise((r) => mockOllalinkWss.close(r));
});

test('SRV-13 FIX: lang.change preserves participant voice & tone on upstream re-open', async () => {
  // 1. Mint session with custom voice (nh-f01) and tone (cheerful)
  const sessionCreds = mintSession({
    userId: 'alice_user',
    sourceLang: 'en',
    targetLang: 'hi',
    voice: 'nh-f01',
    tone: 'cheerful',
  });

  const ws = new WebSocket('ws://localhost:32300/call');
  await new Promise((r) => ws.on('open', r));

  // Join room
  ws.send(JSON.stringify({
    type: 'join',
    token: sessionCreds.token,
    displayName: 'Alice',
  }));

  await new Promise((r) => setTimeout(r, 100));

  // Verify initial upstream config captured custom voice & tone
  assert.ok(upstreamConfigs.length >= 1, 'Initial stream opened');
  const initConfig = upstreamConfigs[upstreamConfigs.length - 1];
  assert.equal(initConfig.tts?.voice, 'nh-f01');
  assert.equal(initConfig.tts?.tone, 'cheerful');

  // 2. Perform lang.change (switch target to Spanish 'es')
  ws.send(JSON.stringify({
    type: 'lang.change',
    sourceLang: 'en',
    targetLang: 'es',
  }));

  await new Promise((r) => setTimeout(r, 150));

  // Verify re-opened stream STILL has Alice's custom voice (nh-f01) and tone (cheerful)
  assert.ok(upstreamConfigs.length >= 2, 'Stream re-opened on lang.change');
  const reOpenedConfig = upstreamConfigs[upstreamConfigs.length - 1];
  assert.equal(reOpenedConfig.tts?.voice, 'nh-f01', 'Self re-open MUST NOT revert to default nh-m01!');
  assert.equal(reOpenedConfig.tts?.tone, 'cheerful', 'Self re-open MUST NOT revert to default natural!');

  // 3. Test token refresh preserves voice & tone
  const refreshedCreds = mintSession({
    userId: 'alice_user',
    sourceLang: 'en',
    targetLang: 'es',
    voice: 'nh-f01',
    tone: 'cheerful',
  });

  ws.send(JSON.stringify({
    type: 'session.refresh',
    token: refreshedCreds.token,
  }));

  await new Promise((r) => setTimeout(r, 100));

  ws.close();
});

test('SRV-13 PATH 4 FIX: HTTP POST /api/session/refresh preserves custom voice & tone', async () => {
  const { verifySession } = await import('../src/auth.js');

  // 1. Mint initial token with custom voice (nh-f01) and delivery tone (cheerful)
  const mintRes = await fetch('http://localhost:32300/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: 'alice_http_user',
      sourceLang: 'en',
      targetLang: 'hi',
      voice: 'nh-f01',
      tone: 'cheerful',
    }),
  });
  assert.equal(mintRes.status, 200);
  const mintData = await mintRes.json();
  assert.equal(mintData.voice, 'nh-f01');
  assert.equal(mintData.tone, 'cheerful');

  // 2. Call HTTP refresh endpoint with the token
  const refreshRes = await fetch('http://localhost:32300/api/session/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: mintData.token }),
  });
  assert.equal(refreshRes.status, 200);
  const refreshData = await refreshRes.json();

  // 3. Verify refreshed token payload explicitly preserves voice and tone
  assert.equal(refreshData.voice, 'nh-f01', 'HTTP refresh MUST preserve custom voice nh-f01');
  assert.equal(refreshData.tone, 'cheerful', 'HTTP refresh MUST preserve custom tone cheerful');

  const verified = verifySession(refreshData.token);
  assert.ok(verified, 'Refreshed token must be verifiable');
  assert.equal(verified.voice, 'nh-f01', 'Decoded token payload must contain custom voice');
  assert.equal(verified.tone, 'cheerful', 'Decoded token payload must contain custom tone');
});
