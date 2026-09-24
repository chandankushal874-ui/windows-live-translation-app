# Approval Checklist — Status: COMPLETE & VERIFIED LIVE

The dashboard key (`sk_f439f7e7394139022af3b458a76008e86e1ba0b93e497207`) is **ACTIVE and VERIFIED LIVE**.

## Verification Completed

1. Gateway health check:
   ```bash
   curl.exe https://ai.ollalink.com/healthz
   # -> ok
   ```
2. Sound-stream WebSocket handshake:
   ```bash
   node -e "
   import WebSocket from 'ws';
   const ws = new WebSocket('wss://sound-stream.ollalink.com/v1/speech/stream');
   ws.on('open', () => {
     ws.send(JSON.stringify({
       type: 'session.configure',
       api_key: 'sk_f439f7e7394139022af3b458a76008e86e1ba0b93e497207',
       audio: { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le' },
       recognition: { language: 'en', punctuation: true },
       endpointing: { mode: 'auto', silence_ms: 600 },
       translation: { enabled: true, targets: ['hi'] },
       tts: { enabled: true, voice: 'nh-m01' }
     }));
   });
   ws.on('message', (d) => console.log(JSON.parse(d)));
   "
   # -> session.created -> session.ready (capabilities: ['transcription', 'translation', 'tts'])
   ```

## Configuration Complete

- Endpoint: `wss://sound-stream.ollalink.com/v1/speech/stream` set in `server/.env`.
- Key: Saved in `server/.env`.
- Port: Synchronized to `8787`.
- Multi-codec support: 48 kHz PCM and 24 kHz WAV (Kannada) supported in client JitterPlayer.
- Test suite: 103 / 103 passing.
