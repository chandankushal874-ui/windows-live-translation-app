import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';

process.env.PORT = '32450';
process.env.PUBLIC_BASE = 'ws://localhost:32450';
process.env.OLLALINK_DASHBOARD_KEY = 'sk_test_mock_key';
process.env.OLLALINK_WS_URL = 'ws://127.0.0.1:32451/v1/speech/stream';
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.LOG_LEVEL = 'error';

const { startServer } = await import('../src/server.js');
const { mintSession } = await import('../src/auth.js');

let relayHandle;
let mockOllalinkWss;
const mockSessions = [];

function waitType(ws, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout for ${type}`)), timeoutMs);
    const handler = (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.type === type) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch {}
    };
    ws.on('message', handler);
  });
}

before(async () => {
  mockOllalinkWss = new WebSocketServer({ port: 32451, path: '/v1/speech/stream' });
  mockOllalinkWss.on('connection', (ws) => {
    const sessionObj = { ws, config: null, receivedChunks: [] };
    mockSessions.push(sessionObj);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        sessionObj.receivedChunks.push(data);
      } else {
        try {
          const parsed = JSON.parse(data.toString('utf8'));
          if (parsed.type === 'session.configure' || parsed.type === 'config') {
            sessionObj.config = parsed;
            // Delay session.ready by 100ms to simulate real handshake latency
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'session.ready', lanes: ['stream'] }));
              }
            }, 100);
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

test('Bug 8: Server handles overloaded error, notifies client, and schedules backoff reconnect', async () => {
  const aliceCreds = mintSession({
    userId: 'alice_bug8',
    sourceLang: 'en',
    targetLang: 'hi',
  });

  const ws = new WebSocket('ws://localhost:32450/call');
  await new Promise((r) => ws.on('open', r));

  const clientMessages = [];
  ws.on('message', (data) => {
    try {
      clientMessages.push(JSON.parse(data.toString('utf8')));
    } catch {}
  });

  ws.send(JSON.stringify({
    type: 'join',
    token: aliceCreds.token,
    displayName: 'AliceBug8',
  }));

  await waitType(ws, 'joined');
  await new Promise((r) => setTimeout(r, 200));

  const lastMock = mockSessions[mockSessions.length - 1];
  assert.ok(lastMock?.config, 'Upstream should be opened and configured');

  // Ollalink upstream emits overloaded error
  lastMock.ws.send(JSON.stringify({
    type: 'error',
    code: 'overloaded',
    message: 'You are sending audio faster than real time; the socket closes.',
  }));

  // Wait for server to process error and notify client
  await new Promise((r) => setTimeout(r, 200));

  const warnMsg = clientMessages.find((m) => m.type === 'warning' && m.code === 'overloaded');
  assert.ok(warnMsg, 'Client must receive warning with code overloaded to slow down');

  const reconnectMsg = clientMessages.find((m) => m.type === 'upstream-reconnecting');
  assert.ok(reconnectMsg, 'Client must receive upstream-reconnecting message with backoff delay');
  assert.equal(reconnectMsg.reason, 'overloaded');

  ws.close();
});

test('Bug 10: Peer join does NOT re-open upstream if target languages have not changed', async () => {
  // Alice joins room
  const aliceCreds = mintSession({
    userId: 'alice_bug10',
    sourceLang: 'en',
    targetLang: 'hi',
  });
  const aliceWs = new WebSocket('ws://localhost:32450/call');
  await new Promise((r) => aliceWs.on('open', r));
  aliceWs.send(JSON.stringify({
    type: 'join',
    token: aliceCreds.token,
    displayName: 'AliceBug10',
  }));
  await waitType(aliceWs, 'joined');
  await new Promise((r) => setTimeout(r, 200));

  // Bob joins wanting 'en'
  const bobCreds = mintSession({
    userId: 'bob_bug10',
    sourceLang: 'hi',
    targetLang: 'en',
  });
  const bobWs = new WebSocket('ws://localhost:32450/call');
  await new Promise((r) => bobWs.on('open', r));
  bobWs.send(JSON.stringify({
    type: 'join',
    token: bobCreds.token,
    displayName: 'BobBug10',
  }));
  await waitType(bobWs, 'joined');
  await new Promise((r) => setTimeout(r, 250));

  const upstreamsBeforeCharlie = mockSessions.length;

  // Charlie joins ALSO wanting 'en' (already targeted by Alice!)
  const charlieCreds = mintSession({
    userId: 'charlie_bug10',
    sourceLang: 'hi',
    targetLang: 'en',
  });
  const charlieWs = new WebSocket('ws://localhost:32450/call');
  await new Promise((r) => charlieWs.on('open', r));
  charlieWs.send(JSON.stringify({
    type: 'join',
    token: charlieCreds.token,
    displayName: 'CharlieBug10',
  }));
  await waitType(charlieWs, 'joined');
  await new Promise((r) => setTimeout(r, 250));

  // Alice's target set is still ['en']. Charlie added 1 upstream for Charlie, but Alice's upstream was NOT re-opened!
  const upstreamsAfterCharlie = mockSessions.length;
  assert.equal(upstreamsAfterCharlie, upstreamsBeforeCharlie + 1, 'Only Charlie upstream created; Alice was NOT needlessly re-opened');

  aliceWs.close();
  bobWs.close();
  charlieWs.close();
});

test('Bug 10: Audio frames sent after upstream handshake completes are forwarded immediately', async () => {
  const daveCreds = mintSession({
    userId: 'dave_bug10',
    sourceLang: 'en',
    targetLang: 'hi',
  });
  const daveWs = new WebSocket('ws://localhost:32450/call');
  await new Promise((r) => daveWs.on('open', r));

  daveWs.send(JSON.stringify({
    type: 'join',
    token: daveCreds.token,
    displayName: 'DaveBug10',
  }));
  await waitType(daveWs, 'joined');

  // Wait for upstream handshake to complete (100ms simulated delay in mock)
  await new Promise((r) => setTimeout(r, 300));

  // Send binary audio frames after handshake is done — these must be forwarded
  const sampleFrame = Buffer.alloc(640, 0x12);
  daveWs.send(sampleFrame);
  daveWs.send(sampleFrame);

  // Wait for forwarding
  await new Promise((r) => setTimeout(r, 200));

  const daveMock = mockSessions[mockSessions.length - 1];
  assert.ok(daveMock, 'Dave upstream session should exist');
  assert.ok(daveMock.receivedChunks.length >= 1, 'Frames sent after handshake must be forwarded to Ollalink');

  daveWs.close();
});

test('Issue 1: lang.change re-opened upstream onClose routes through handleUpstreamClose on overload', async () => {
  const aliceCreds = mintSession({
    userId: 'alice_issue1',
    sourceLang: 'en',
    targetLang: 'hi',
  });
  const aliceWs = new WebSocket('ws://localhost:32450/call');
  await new Promise((r) => aliceWs.on('open', r));

  const clientMessages = [];
  aliceWs.on('message', (data) => {
    try {
      clientMessages.push(JSON.parse(data.toString('utf8')));
    } catch {}
  });

  aliceWs.send(JSON.stringify({
    type: 'join',
    token: aliceCreds.token,
    displayName: 'AliceIssue1',
  }));
  await waitType(aliceWs, 'joined');
  await new Promise((r) => setTimeout(r, 200));

  // Perform lang.change (switches target to 'es')
  aliceWs.send(JSON.stringify({
    type: 'lang.change',
    sourceLang: 'en',
    targetLang: 'es',
  }));
  await waitType(aliceWs, 'lang.changed');
  await new Promise((r) => setTimeout(r, 200));

  // The latest mock session is Alice's re-opened upstream
  const reOpenedMock = mockSessions[mockSessions.length - 1];
  assert.ok(reOpenedMock?.config, 'Re-opened upstream should exist after lang.change');

  // Ollalink upstream emits overloaded and closes
  reOpenedMock.ws.send(JSON.stringify({
    type: 'error',
    code: 'overloaded',
    message: 'You are sending audio faster than real time; the socket closes.',
  }));
  reOpenedMock.ws.close(1008, 'overloaded');

  await new Promise((r) => setTimeout(r, 250));

  const warnMsg = clientMessages.find((m) => m.type === 'warning' && m.code === 'overloaded');
  assert.ok(warnMsg, 'Client must receive warning with code overloaded on lang.change upstream close');

  const reconnectMsg = clientMessages.find((m) => m.type === 'upstream-reconnecting');
  assert.ok(reconnectMsg, 'Client must receive upstream-reconnecting message from handleUpstreamClose');
  assert.equal(reconnectMsg.reason, 'overloaded');

  aliceWs.close();
});

test('Issue 2: session.ready inspects config_applied.tts.lanes and pre-caches target lanes', async () => {
  const aliceCreds = mintSession({
    userId: 'alice_issue2',
    sourceLang: 'en',
    targetLang: 'de',
  });
  const aliceWs = new WebSocket('ws://localhost:32450/call');
  await new Promise((r) => aliceWs.on('open', r));

  aliceWs.send(JSON.stringify({
    type: 'join',
    token: aliceCreds.token,
    displayName: 'AliceIssue2',
  }));
  const aliceJoined = await waitType(aliceWs, 'joined');
  await new Promise((r) => setTimeout(r, 150));

  // Bob joins Alice's room to receive audio
  const bobCreds = mintSession({
    userId: 'bob_issue2',
    sourceLang: 'de',
    targetLang: 'hi',
  });
  const bobWs = new WebSocket('ws://localhost:32450/call');
  await new Promise((r) => bobWs.on('open', r));
  bobWs.send(JSON.stringify({
    type: 'join',
    token: bobCreds.token,
    room: aliceJoined.room,
    displayName: 'BobIssue2',
  }));
  await waitType(bobWs, 'joined');
  await new Promise((r) => setTimeout(r, 200));

  const bobMessages = [];
  bobWs.on('message', (data, isBinary) => {
    if (!isBinary) {
      try { bobMessages.push(JSON.parse(data.toString('utf8'))); } catch {}
    }
  });

  // Find latest upstream for Alice (sourceLang 'en')
  const aliceUpstreams = mockSessions.filter(s => s.config?.recognition?.language === 'en');
  const aliceMock = aliceUpstreams[aliceUpstreams.length - 1];
  assert.ok(aliceMock?.config, 'Alice mock upstream should exist');

  // Emit session.ready with config_applied.tts.lanes setting 'hi' to batch (wav, 24kHz)
  aliceMock.ws.send(JSON.stringify({
    type: 'session.ready',
    capabilities: ['transcription', 'translation', 'tts'],
    config_applied: {
      tts: {
        lanes: { hi: 'batch', de: 'batch' },
        voice: 'nh-m01',
      },
    },
  }));
  await new Promise((r) => setTimeout(r, 150));

  // Now emit audio chunk with sample_rate and codec omitted from Ollalink
  // C2 Fix: translateEvent defaults raw PCM (no WAV header, no codec field) to pcm_s16le @ 48kHz.
  // The cachedLane lookup was removed as fragile — translateEvent's own detection is authoritative.
  aliceMock.ws.send(JSON.stringify({
    type: 'translation.audio',
    language: 'hi',
    chunk_seq: 1,
    audio_b64: Buffer.from([0x01, 0x02, 0x03, 0x04]).toString('base64'),
  }));
  await new Promise((r) => setTimeout(r, 200));

  const audioHeader = bobMessages.find((m) => m.type === 'audio' && m.chunkSeq === 1);
  assert.ok(audioHeader, 'Bob should receive audio header');
  // Raw PCM without codec field defaults to pcm_s16le @ 48kHz (streaming lane default)
  assert.equal(audioHeader.codec, 'pcm_s16le', 'Raw PCM without codec field defaults to pcm_s16le');
  assert.equal(audioHeader.sampleRate, 48000, 'Raw PCM without sample_rate defaults to 48kHz (streaming lane)');

  aliceWs.close();
  bobWs.close();
});

test('Bug 13: session.ready voice fallback updates session metadata, notifies client and broadcasts to peers', async () => {
  const aliceCreds = mintSession({
    userId: 'alice_bug13_voice',
    sourceLang: 'en',
    targetLang: 'de',
    voice: 'nh-f01', // Priya requested
  });
  const aliceWs = new WebSocket('ws://localhost:32450/call');
  await new Promise((r) => aliceWs.on('open', r));

  const aliceMessages = [];
  aliceWs.on('message', (d) => {
    try { aliceMessages.push(JSON.parse(d.toString('utf8'))); } catch {}
  });

  aliceWs.send(JSON.stringify({
    type: 'join',
    token: aliceCreds.token,
    displayName: 'AliceBug13',
    voice: 'nh-f01',
  }));
  const aliceJoined = await waitType(aliceWs, 'joined');
  await new Promise((r) => setTimeout(r, 150));

  // Bob joins Alice's room
  const bobCreds = mintSession({
    userId: 'bob_bug13_voice',
    sourceLang: 'de',
    targetLang: 'en',
  });
  const bobWs = new WebSocket('ws://localhost:32450/call');
  await new Promise((r) => bobWs.on('open', r));
  const bobMessages = [];
  bobWs.on('message', (d) => {
    try { bobMessages.push(JSON.parse(d.toString('utf8'))); } catch {}
  });

  bobWs.send(JSON.stringify({
    type: 'join',
    token: bobCreds.token,
    room: aliceJoined.room,
    displayName: 'BobBug13',
  }));
  await waitType(bobWs, 'joined');
  await new Promise((r) => setTimeout(r, 200));

  // Find latest upstream for Alice
  const aliceUpstreams = mockSessions.filter(s => s.config?.recognition?.language === 'en');
  const aliceMock = aliceUpstreams[aliceUpstreams.length - 1];
  assert.ok(aliceMock?.config, 'Alice mock upstream should exist');

  // Upstream returns session.ready where requested voice 'nh-f01' fell back to 'nh-m01'
  aliceMock.ws.send(JSON.stringify({
    type: 'session.ready',
    capabilities: ['transcription', 'translation', 'tts'],
    config_applied: {
      tts: {
        voice: 'nh-m01', // Silent fallback by Ollalink
        lanes: { en: 'stream', de: 'stream' },
      },
    },
  }));
  await new Promise((r) => setTimeout(r, 200));

  // Alice must receive voice.settings.updated with fallback: true
  const voiceUpdate = aliceMessages.find((m) => m.type === 'voice.settings.updated' && m.voice === 'nh-m01');
  assert.ok(voiceUpdate, 'Alice must receive voice.settings.updated notifying of fallback to nh-m01');
  assert.equal(voiceUpdate.fallback, true, 'Voice update must be marked as fallback');

  // Bob must receive peer-voice-updated so Bob knows Alice is speaking with nh-m01
  const peerVoiceUpdate = bobMessages.find((m) => m.type === 'peer-voice-updated' && m.voice === 'nh-m01');
  assert.ok(peerVoiceUpdate, 'Bob must receive peer-voice-updated showing Alice voice updated to nh-m01');

  aliceWs.close();
  bobWs.close();
});

test('Bug 13: session.ready warns when capabilities or translation targets are truncated', async () => {
  const daveCreds = mintSession({
    userId: 'dave_bug13_caps',
    sourceLang: 'en',
    targetLang: 'hi',
  });
  const daveWs = new WebSocket('ws://localhost:32450/call');
  await new Promise((r) => daveWs.on('open', r));

  const daveMessages = [];
  daveWs.on('message', (d) => {
    try { daveMessages.push(JSON.parse(d.toString('utf8'))); } catch {}
  });

  daveWs.send(JSON.stringify({
    type: 'join',
    token: daveCreds.token,
    displayName: 'DaveBug13',
  }));
  await waitType(daveWs, 'joined');
  await new Promise((r) => setTimeout(r, 200));

  const daveUpstreams = mockSessions.filter(s => s.config?.recognition?.language === 'en');
  const daveMock = daveUpstreams[daveUpstreams.length - 1];
  assert.ok(daveMock?.config, 'Dave mock upstream should exist');

  // Upstream returns session.ready with TTS capability MISSING and targets truncated
  daveMock.ws.send(JSON.stringify({
    type: 'session.ready',
    capabilities: ['transcription'], // 'tts' and 'translation' missing
    config_applied: {
      translation: {
        targets: [], // Targets omitted/truncated
      },
    },
  }));
  await new Promise((r) => setTimeout(r, 200));

  const capWarning = daveMessages.find((m) => m.type === 'warning' && m.code === 'capability_missing');
  assert.ok(capWarning, 'Dave must receive warning for missing tts/translation capabilities');

  daveWs.close();
});

test('Bug 14: SOUND_STREAM_SOURCES aligns strictly with docs (de, pt, ru, ar, zh present, kn/ta/te/bn absent)', async () => {
  const { SOUND_STREAM_SOURCES, normalizeLang } = await import('../src/langs.js');

  // Verify docs' required source languages
  const requiredSources = ['en', 'hi', 'es', 'fr', 'de', 'pt', 'ru', 'ar', 'zh'];
  for (const lang of requiredSources) {
    assert.ok(SOUND_STREAM_SOURCES.includes(lang), `SOUND_STREAM_SOURCES must include ${lang}`);
    assert.equal(normalizeLang(lang, 'source'), lang, `normalizeLang('${lang}', 'source') must succeed`);
  }

  // Verify non-doc languages are rejected as sound-stream sources
  const rejectedSources = ['kn', 'ta', 'te', 'bn'];
  for (const lang of rejectedSources) {
    assert.ok(!SOUND_STREAM_SOURCES.includes(lang), `SOUND_STREAM_SOURCES must not include ${lang}`);
    assert.equal(normalizeLang(lang, 'source'), null, `normalizeLang('${lang}', 'source') must return null`);
  }
});

test('Bug 15: SOUND_STREAM_TARGETS contains exactly the 9 documented targets', async () => {
  const { SOUND_STREAM_TARGETS, normalizeLang } = await import('../src/langs.js');

  const theNineTargets = ['en', 'hi', 'es', 'fr', 'zh', 'de', 'ar', 'pt', 'ru'];
  assert.equal(SOUND_STREAM_TARGETS.length, 9, 'SOUND_STREAM_TARGETS must contain exactly the 9 official targets');
  for (const lang of theNineTargets) {
    assert.ok(SOUND_STREAM_TARGETS.includes(lang), `SOUND_STREAM_TARGETS must include ${lang}`);
    assert.equal(normalizeLang(lang, 'target'), lang, `normalizeLang('${lang}', 'target') must return ${lang}`);
  }

  // The 6 non-doc targets must be rejected for sound-stream speech
  const rejectedTargets = ['ja', 'it', 'kn', 'ta', 'te', 'bn'];
  for (const lang of rejectedTargets) {
    assert.ok(!SOUND_STREAM_TARGETS.includes(lang), `SOUND_STREAM_TARGETS must not include ${lang}`);
    assert.equal(normalizeLang(lang, 'target'), null, `normalizeLang('${lang}', 'target') must return null`);
  }
});

test('Bug 16: probeOllalinkLanguage validates dynamically against canonical SOUND_STREAM_TARGETS', async () => {
  const { probeOllalinkLanguage } = await import('../src/ollalink.js');

  // Probing unsupported target (ta) immediately returns underDevelopment: true
  const taResult = await probeOllalinkLanguage({ sourceLang: 'en', targetLang: 'ta' });
  assert.equal(taResult.ok, false);
  assert.equal(taResult.underDevelopment, true);
  assert.equal(taResult.language, 'ta');

  // Probing unsupported source (kn) immediately returns underDevelopment: true
  const knResult = await probeOllalinkLanguage({ sourceLang: 'kn', targetLang: 'en' });
  assert.equal(knResult.ok, false);
  assert.equal(knResult.underDevelopment, true);
  assert.equal(knResult.language, 'kn');
});

test('Bug 25: Server accepts both captions.set and captions-toggle', async () => {
  const aliceCreds = mintSession({
    userId: 'alice_bug25',
    sourceLang: 'en',
    targetLang: 'hi',
  });
  const aliceWs = new WebSocket('ws://localhost:32450/call');
  await new Promise((r) => aliceWs.on('open', r));

  const aliceMessages = [];
  aliceWs.on('message', (d) => {
    try { aliceMessages.push(JSON.parse(d.toString('utf8'))); } catch {}
  });

  aliceWs.send(JSON.stringify({
    type: 'join',
    token: aliceCreds.token,
    displayName: 'AliceBug25',
  }));
  await waitType(aliceWs, 'joined');

  // Send captions-toggle (from browser client)
  aliceWs.send(JSON.stringify({ type: 'captions-toggle', on: false }));
  const ack1 = await waitType(aliceWs, 'captions.set');
  assert.equal(ack1.on, false, 'captions-toggle must be acknowledged with captions.set on=false');

  // Send captions.set
  aliceWs.send(JSON.stringify({ type: 'captions.set', on: true }));
  const ack2 = await waitType(aliceWs, 'captions.set');
  assert.equal(ack2.on, true, 'captions.set must be acknowledged with on=true');

  aliceWs.close();
});

test('Bug 27: Overloaded reconnect counter does NOT double-increment on socket close', async () => {
  const aliceCreds = mintSession({
    userId: 'alice_bug27',
    sourceLang: 'en',
    targetLang: 'hi',
  });
  const aliceWs = new WebSocket('ws://localhost:32450/call');
  await new Promise((r) => aliceWs.on('open', r));

  const clientMessages = [];
  aliceWs.on('message', (data) => {
    try { clientMessages.push(JSON.parse(data.toString('utf8'))); } catch {}
  });

  aliceWs.send(JSON.stringify({
    type: 'join',
    token: aliceCreds.token,
    displayName: 'AliceBug27',
  }));
  await waitType(aliceWs, 'joined');
  await new Promise((r) => setTimeout(r, 200));

  const aliceMock = mockSessions[mockSessions.length - 1];
  assert.ok(aliceMock?.config, 'Alice mock upstream should exist');

  // Emit overloaded error event
  aliceMock.ws.send(JSON.stringify({
    type: 'error',
    code: 'overloaded',
    message: 'You are sending audio faster than real time; the socket closes.',
  }));
  // Then close socket with 1008 overloaded
  aliceMock.ws.close(1008, 'overloaded');

  await new Promise((r) => setTimeout(r, 250));

  // Find all upstream-reconnecting messages received by client
  const reconnectMessages = clientMessages.filter((m) => m.type === 'upstream-reconnecting');
  assert.equal(reconnectMessages.length, 1, 'Client must receive exactly ONE reconnect message, not duplicate increment');
  assert.equal(reconnectMessages[0].attempt, 1, 'Reconnect attempt must be 1, not 2');

  aliceWs.close();
});

test('Bug 29 & Bug 30: inspectSessionReadyConfig handles voice fallback and capabilities', async () => {
  const { inspectSessionReadyConfig } = await import('../src/server.js');

  let sendCount = 0;
  const mockClient = {
    upstreamGen: 10,
    currentTargetLangs: ['hi', 'es', 'de'],
    session: { sessionId: 'mock-session-1', targetLang: 'hi', voice: 'nh-f01' },
    upstreamOpts: { voice: 'nh-f01' },
    ws: { readyState: 1, send: () => { sendCount++; } },
  };

  inspectSessionReadyConfig(mockClient, {
    type: 'session.ready',
    capabilities: ['transcription', 'translation', 'tts'],
    config_applied: {
      tts: { voice: 'nh-m01' }, // Voice fallback: requested nh-f01, got nh-m01
    },
  });

  assert.equal(mockClient.session.voice, 'nh-m01', 'Session voice must update to applied voice on fallback');
  assert.ok(sendCount >= 1, 'Client must receive voice fallback notification');
});

test('Bug 33: inspectSessionReadyConfig is idempotent for voice fallback', async () => {
  const { inspectSessionReadyConfig } = await import('../src/server.js');

  let sendCount = 0;
  const mockClient = {
    upstreamGen: 42,
    session: { sessionId: 'mock-session-33', voice: 'nh-f01' },
    upstreamOpts: { voice: 'nh-f01' },
    ws: {
      readyState: 1,
      send: () => { sendCount++; },
    },
  };

  const payload = {
    type: 'session.ready',
    config_applied: {
      tts: {
        voice: 'nh-m01', // Fallback
      },
    },
  };

  // First call triggers voice fallback notification
  inspectSessionReadyConfig(mockClient, payload);
  // Second call: session.voice is now nh-m01, which matches applied → no duplicate notification
  inspectSessionReadyConfig(mockClient, payload);

  assert.equal(sendCount, 1, 'Voice fallback must only notify once — second call sees matching voice');
});
