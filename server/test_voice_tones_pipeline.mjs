// test_voice_tones_pipeline.mjs
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

async function run() {
  console.log('============================================================');
  console.log('  SANDBOX TEST: VOICE PERSONAS & TONES PIPELINE VERIFICATION');
  console.log('============================================================\n');

  // Step 1: Boot server instance on random port
  const PORT = 25000 + Math.floor(Math.random() * 10000);
  const baseUrl = `http://127.0.0.1:${PORT}`;
  const wsUrl = `ws://127.0.0.1:${PORT}/call`;

  process.env.PORT = String(PORT);
  process.env.PUBLIC_BASE = `ws://127.0.0.1:${PORT}`;
  process.env.OLLALINK_DASHBOARD_KEY = 'sk_test';
  process.env.OLLALINK_WS_URL = 'wss://example.com';
  process.env.SESSION_SECRET = randomBytes(32).toString('hex');
  process.env.LOG_LEVEL = 'error';

  const { startServer } = await import('./src/server.js');
  const serverHandle = startServer();
  await new Promise(r => setTimeout(r, 300));
  console.log(`[1/5] Relay server listening on port ${PORT}...`);

  // Step 2: Query /api/langs and verify voices & tones catalog
  console.log('\n[2/5] Querying /api/langs for voice and tone catalog...');
  const langsRes = await fetch(`${baseUrl}/api/langs`).then(r => r.json());
  assert.ok(Array.isArray(langsRes.voices), 'voices array exists');
  assert.ok(Array.isArray(langsRes.tones), 'tones array exists');
  console.log(`      Available Voice Personas (${langsRes.voices.length}):`);
  langsRes.voices.forEach(v => console.log(`        - [${v.id}] ${v.name} (${v.character}, languages: ${v.languages.join(',')})`));
  console.log(`      Available Delivery Tones (${langsRes.tones.length}):`);
  langsRes.tones.forEach(t => console.log(`        - [${t.id}] ${t.name}: ${t.description}`));

  // Step 3: Mint session with custom Voice Persona and Tone
  console.log('\n[3/5] Minting session with character "Ramesh Babu" (dhvaani-ramesh) and tone "formal"...');
  const aliceSess = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'Alice',
      sourceLang: 'en',
      targetLang: 'hi',
      voice: 'dhvaani-ramesh',
      tone: 'formal',
    }),
  }).then(r => r.json());

  assert.equal(aliceSess.voice, 'dhvaani-ramesh', 'Session returned requested voice persona');
  assert.equal(aliceSess.tone, 'formal', 'Session returned requested delivery tone');
  console.log(`      Alice minted session: voice=${aliceSess.voice}, tone=${aliceSess.tone}`);

  const bobSess = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'Bob',
      sourceLang: 'hi',
      targetLang: 'en',
      voice: 'nh-f01',
      tone: 'cheerful',
    }),
  }).then(r => r.json());
  assert.equal(bobSess.voice, 'nh-f01');
  assert.equal(bobSess.tone, 'cheerful');
  console.log(`      Bob minted session:   voice=${bobSess.voice}, tone=${bobSess.tone}`);

  // Step 4: Connect Alice and Bob to room
  console.log('\n[4/5] Connecting Alice and Bob over WebSocket...');
  const aliceWs = new WebSocket(wsUrl);
  await new Promise(r => aliceWs.once('open', r));

  let roomCode = null;
  const aliceJoined = new Promise(resolve => {
    aliceWs.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'joined') {
        roomCode = msg.room;
        console.log(`      Alice joined room: [${roomCode}] with voice=${msg.self.voice}, tone=${msg.self.tone}`);
        assert.equal(msg.self.voice, 'dhvaani-ramesh');
        assert.equal(msg.self.tone, 'formal');
        resolve(msg);
      }
    });
  });

  aliceWs.send(JSON.stringify({
    type: 'join',
    token: aliceSess.token,
    displayName: 'Alice (Host)',
  }));
  await aliceJoined;

  const bobWs = new WebSocket(wsUrl);
  await new Promise(r => bobWs.once('open', r));

  let bobVoiceUpdatedPromiseResolve;
  const bobVoiceUpdatedPromise = new Promise(r => { bobVoiceUpdatedPromiseResolve = r; });

  bobWs.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'joined') {
        console.log(`      Bob joined room: [${msg.room}], peerCount=${msg.participants?.length}`);
        const peerAlice = msg.participants.find(p => p.displayName === 'Alice (Host)');
        assert.ok(peerAlice, 'Bob sees Alice in participant list');
        assert.equal(peerAlice.voice, 'dhvaani-ramesh', 'Alice voice matches in room state');
        assert.equal(peerAlice.tone, 'formal', 'Alice tone matches in room state');
        console.log(`      Bob verified Alice's voice persona in room: ${peerAlice.voice} (${peerAlice.tone})`);
      } else if (msg.type === 'peer-voice-updated') {
        console.log(`      🔔 [Bob received peer-voice-updated]: from=${msg.sessionId} voice=${msg.voice} tone=${msg.tone}`);
        bobVoiceUpdatedPromiseResolve(msg);
      }
    } catch {}
  });

  bobWs.send(JSON.stringify({
    type: 'join',
    room: roomCode,
    token: bobSess.token,
    displayName: 'Bob (Guest)',
  }));

  await new Promise(r => setTimeout(r, 600));

  // Step 5: Alice dynamically switches voice persona to "Priya" (nh-f01) and tone to "cheerful" mid-call
  console.log('\n[5/5] Alice dynamically switching voice to "Priya" (nh-f01) and tone to "cheerful" mid-call...');
  
  let aliceAckResolve;
  const aliceAck = new Promise(r => { aliceAckResolve = r; });

  aliceWs.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'voice.settings.updated') {
        console.log(`      ⚡ [Alice received confirmation]: voice=${msg.voice}, tone=${msg.tone}`);
        assert.equal(msg.voice, 'nh-f01');
        assert.equal(msg.tone, 'cheerful');
        aliceAckResolve(msg);
      }
    } catch {}
  });

  aliceWs.send(JSON.stringify({
    type: 'update-voice-settings',
    voice: 'nh-f01',
    tone: 'cheerful',
  }));

  const [ack, peerEvt] = await Promise.all([aliceAck, bobVoiceUpdatedPromise]);
  assert.equal(peerEvt.voice, 'nh-f01', 'Bob received updated voice');
  assert.equal(peerEvt.tone, 'cheerful', 'Bob received updated tone');

  console.log('\n✨ [VERIFIED]: Mid-call voice persona and tone switching successfully propagated across peers!');

  // Cleanup
  aliceWs.close();
  bobWs.close();
  await serverHandle.close();

  console.log('\n============================================================');
  console.log('  VOICE PERSONAS & TONES SANDBOX TEST: 100% PASSED');
  console.log('============================================================');
  process.exit(0);
}

run().catch(err => {
  console.error('\n[TEST FAILURE]:', err);
  process.exit(1);
});
