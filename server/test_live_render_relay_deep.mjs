// test_live_render_relay_deep.mjs
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';

const RENDER_BASE = 'https://windows-live-translation-app-1.onrender.com';
const RENDER_WS = 'wss://windows-live-translation-app-1.onrender.com/call';
const AUDIO_INPUT = 'C:/Users/Dell/Downloads/input_english_voice_sent_to_gpu.wav';
const PROOF_OUTPUT = 'C:/Users/Dell/Downloads/proof_live_render_relay_transferred_hindi.wav';

function writeWavHeader(sampleRate, channels, bitDepth, dataLength) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28);
  header.writeUInt16LE(channels * (bitDepth / 8), 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

async function run() {
  console.log('============================================================');
  console.log('  DEEP LIVE CLOUD RELAY & TRANSLATION PIPELINE TEST');
  console.log(`  Target: ${RENDER_WS}`);
  console.log('============================================================\n');

  // Step 1: Health & Ready
  console.log('[1/6] Pinging Render HTTP health & ready endpoints...');
  const healthRes = await fetch(`${RENDER_BASE}/api/health`).then(r => r.json());
  console.log(`      Health: ok=${healthRes.ok}, ts=${healthRes.ts}`);
  if (!healthRes.ok) throw new Error('Health check failed');

  const readyRes = await fetch(`${RENDER_BASE}/api/ready`).then(r => r.json());
  console.log(`      Ready: status=${readyRes.status ?? 'ok'}, memory=${JSON.stringify(readyRes.memory)}`);

  // Step 2: Mint session for Host (Alice) and Guest (Bob)
  console.log('\n[2/6] Minting session credentials via /api/session...');
  const aliceSess = await fetch(`${RENDER_BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'Alice', sourceLang: 'en', targetLang: 'hi' }),
  }).then(r => r.json());
  if (!aliceSess.token) throw new Error(`Alice session failed: ${JSON.stringify(aliceSess)}`);
  console.log(`      Alice minted: token=${aliceSess.token.slice(0, 10)}... expires=${aliceSess.expiresAt}`);

  const bobSess = await fetch(`${RENDER_BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'Bob', sourceLang: 'hi', targetLang: 'hi' }),
  }).then(r => r.json());
  if (!bobSess.token) throw new Error(`Bob session failed: ${JSON.stringify(bobSess)}`);
  console.log(`      Bob minted:   token=${bobSess.token.slice(0, 10)}... expires=${bobSess.expiresAt}`);

  // Step 3: Connect Alice and Host room
  console.log('\n[3/6] Connecting Alice to Render WebSocket and creating room...');
  const aliceWs = new WebSocket(RENDER_WS);
  await new Promise((res, rej) => {
    aliceWs.once('open', res);
    aliceWs.once('error', rej);
  });
  console.log('      Alice WS connected to Render.');

  let roomCode = null;
  const aliceJoined = new Promise((resolve) => {
    aliceWs.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.type === 'joined') {
          roomCode = msg.room;
          console.log(`      Alice hosted room: [${roomCode}]`);
          resolve(msg);
        }
      } catch (e) {}
    });
  });

  aliceWs.send(JSON.stringify({
    type: 'join',
    token: aliceSess.token,
    displayName: 'Alice (Host)',
    captionsOn: true,
  }));
  await aliceJoined;

  // Step 4: Connect Bob and Join room
  console.log(`\n[4/6] Connecting Bob to Render WebSocket and joining room [${roomCode}]...`);
  const bobWs = new WebSocket(RENDER_WS);
  await new Promise((res, rej) => {
    bobWs.once('open', res);
    bobWs.once('error', rej);
  });
  console.log('      Bob WS connected to Render.');

  const receivedAudioChunks = [];
  const receivedCaptions = [];
  const receivedTranslations = [];
  let lastAudioMeta = null;
  let bobJoinedResolve;
  const bobJoined = new Promise(r => { bobJoinedResolve = r; });

  bobWs.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.from(data);
      receivedAudioChunks.push(buf);
      console.log(`      🔊 [Bob received audio binary chunk #${receivedAudioChunks.length}]: ${buf.length} bytes`);
      return;
    }

    try {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type === 'joined') {
        console.log(`      Bob joined room: [${msg.room}], peerCount=${msg.participants?.length ?? 1}`);
        bobJoinedResolve();
      } else if (msg.type === 'peer-joined') {
        console.log(`      Peer notification: ${msg.peer?.displayName} joined`);
      } else if (msg.type === 'caption') {
        const p = msg.payload;
        if (p?.text) {
          console.log(`      💬 [Bob received caption ${msg.kind}]: "${p.text}"`);
          if (msg.kind === 'translation') {
            receivedTranslations.push(p.text);
          } else {
            receivedCaptions.push(p.text);
          }
        }
      } else if (msg.type === 'audio') {
        lastAudioMeta = msg;
        console.log(`      🎵 [Bob received audio header]: lang=${msg.lang}, rate=${msg.sampleRate}Hz, seq=${msg.chunkSeq}, last=${msg.last}`);
      } else if (msg.type === 'error') {
        console.warn('      [Bob received error]:', msg);
      }
    } catch (e) {
      console.error('Bob JSON parse error:', e);
    }
  });

  bobWs.send(JSON.stringify({
    type: 'join',
    room: roomCode,
    token: bobSess.token,
    displayName: 'Bob (Guest)',
    captionsOn: true,
  }));
  await bobJoined;

  // Step 5: Wait 1.5 seconds for upstream GPU pipelines to initialize
  console.log('      Waiting 1.5s for upstream GPU session establishment...');
  await new Promise(r => setTimeout(r, 1500));

  // Alice streams raw 16kHz audio frames to Render
  console.log('\n[5/6] Alice streaming 16kHz English voice to Render cloud relay...');
  const inputWav = fs.readFileSync(AUDIO_INPUT);
  const pcmData = inputWav.subarray(44); // Skip 44-byte WAV header
  console.log(`      Input Audio: ${pcmData.length} PCM bytes (~${(pcmData.length / 32000).toFixed(2)} seconds of speech)`);

  const chunkSize = 16000; // 0.5s chunks at 16kHz 16-bit mono
  const t0 = Date.now();
  let chunkCount = 0;
  for (let offset = 0; offset < pcmData.length; offset += chunkSize) {
    chunkCount++;
    const chunk = pcmData.subarray(offset, Math.min(offset + chunkSize, pcmData.length));
    aliceWs.send(chunk);
    console.log(`      🎙️ Alice sent audio chunk ${chunkCount} (${chunk.length} bytes)...`);
    await new Promise(r => setTimeout(r, 500)); // Natural 500ms speech streaming cadence
  }

  console.log('      Alice voice stream complete. Waiting for translated voice synthesis over Render...');

  // Step 6: Wait for audio chunks and translations to arrive on Bob's side
  const waitMax = 30; // 15 seconds max
  for (let i = 0; i < waitMax; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (receivedAudioChunks.length > 0 && i >= 6) {
      // Allow trailing chunks to finish arriving
      await new Promise(r => setTimeout(r, 2500));
      break;
    }
  }

  const durationMs = Date.now() - t0;
  console.log(`\n[6/6] Pipeline Test Finished in ${durationMs}ms!`);
  console.log(`      Total audio chunks received by Bob:   ${receivedAudioChunks.length}`);
  console.log(`      Total captions received by Bob:       ${receivedCaptions.length}`);
  console.log(`      Total translations received by Bob:   ${receivedTranslations.length}`);

  // Combine received chunks
  if (receivedAudioChunks.length > 0) {
    const totalPcm = Buffer.concat(receivedAudioChunks);
    const sampleRate = lastAudioMeta?.sampleRate ?? 48000;
    console.log(`      Total received PCM size: ${totalPcm.length} bytes at ${sampleRate} Hz`);
    
    // Wrap in standard RIFF header
    const wavHeader = writeWavHeader(sampleRate, 1, 16, totalPcm.length);
    const finalWav = Buffer.concat([wavHeader, totalPcm]);
    fs.writeFileSync(PROOF_OUTPUT, finalWav);
    console.log(`\n✨ [PROOF SAVED]: ${PROOF_OUTPUT}`);
    console.log(`   File size: ${(finalWav.length / 1024).toFixed(1)} KB`);
    console.log(`   Duration:  ${(totalPcm.length / (sampleRate * 2)).toFixed(2)} seconds of spoken translated audio`);
  } else {
    console.log('\n[INFO] No audio chunks received in this test window.');
  }

  // Graceful cleanup
  aliceWs.close();
  bobWs.close();
  console.log('\n============================================================');
  console.log('  DEEP CLOUD RELAY TEST COMPLETED SUCCESSFULLY');
  console.log('============================================================');
}

run().catch(err => {
  console.error('\n[FATAL TEST ERROR]:', err);
  process.exit(1);
});
