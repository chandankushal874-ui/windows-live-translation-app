/**
 * ollalink.js â€” broker for the Ollalink sound-stream WebSocket.
 *
 * Real docs: https://voices.networkershome.com/docs/realtime-speech/
 *
 * Connection
 * ----------
 * URL:  wss://sound-stream.ollalink.com/v1/speech/stream
 * Auth: dashboard sk_ key, supplied inside the `session.configure.api_key`
 *       field (no header needed). The X-NH-GPU-Key header is also acceptable
 *       to send â€” the edge looks at either.
 *
 * Config (send once, first message after handshake; anything non-conforming
 *        is rejected with `bad_configure` and the socket closes):
 *
 *   {
 *     type: "session.configure",
 *     api_key: "sk_...",
 *     audio:       { sample_rate: 16000, channels: 1, encoding: "pcm_s16le" },
 *     recognition: { language: sourceLang === 'auto' ? undefined : sourceLang, punctuation: true },
    endpointing: { mode: "auto", silence_ms: 600 },
 *     translation: { enabled: true, targets: ["hi"] },
 *     tts:         { enabled: true, voice: "nh-m01" }     // nh-m01 = default
 *   }
 *
 * Server then sends `session.ready` with a `config_applied` block. Always
 * read `config_applied.tts.lanes` to determine, per target language, whether
 * audio will arrive as 48 kHz streaming PCM ("stream") or 24 kHz batched WAV
 * ("batch"). Never assume a codec.
 *
 * Inbound frames we emit (after translateEvent normalization):
 *
 *   { kind: 'ready',           payload: sessionReadyEvt }
 *   { kind: 'caption-partial', payload: transcript.partial }
 *   { kind: 'caption-final',   payload: transcript.final (with utterance_id) }
 *   { kind: 'translation',     payload: translation.final (per target) }
 *   { kind: 'translation-delta', payload: translation.delta }      â† live
 *   { kind: 'speech-started'|'speech-ended', payload: {...} }
 *   { kind: 'audio',           payload: { pcm, codec, sampleRate, language, chunkSeq, last } }
 *   { kind: 'warning',         payload: warningEvt }
 *   { kind: 'error',           payload: errorEvt }
 *   { kind: 'usage',           payload: usageEvt }
 *   { kind: 'session-closed',  payload: sessionClosedEvt }
 *   { kind: 'unknown',         payload: rawValue }
 *
 * IMPORTANT:
 *   - Upstream audio arrives as base64 (`audio_b64`) inside `translation.audio`
 *     JSON events, NOT as WS binary frames. We decode to a Buffer here so the
 *     rest of the relay only handles raw PCM.
 *   - Outbound audio (from app) is raw binary PCM frames at 16 kHz mono s16le.
 *     We send at real-time cadence; the lane closes the socket with `overloaded`
 *     if we run fast.
 *   - One session can serve multiple translation targets â€” we only need one
 *     upstream per active speaker, not one per listener.
 */

import WebSocket from 'ws';
import { config, log } from './config.js';

/**
 * Build the config message that opens the upstream session.
 * `targets` may be a single-element array for a 1:1 call, or multi-element
 * for a broadcast. Voice is selected per session, not per target.
 */
export function buildConfig({ sourceLang, targetLangs, sessionToken, voice = 'nh-m01', tone = 'natural', silenceMs = 600, wsUrl }) {
  const url = wsUrl || config.ollalinkWsUrl || '';
  const arr = Array.isArray(targetLangs) ? targetLangs : [targetLangs];

  // 1. Live-translation endpoint (gpu-live.ollalink.com / translate/stream):
  // Format per https://ollalink.com/docs/live-translation/
  if (url.includes('gpu-live') || url.includes('/translate/stream')) {
    const payload = {
      source_lang: (sourceLang === 'auto' || !sourceLang) ? undefined : sourceLang,
      target_lang: arr[0] || 'hi',
      sample_rate: 16000,
    };
    if (config.ollalinkKey) payload.api_key = config.ollalinkKey;
    return JSON.stringify(payload);
  }

  // 2. Realtime speech endpoint (sound-stream.ollalink.com):
  // Format per https://ollalink.com/docs/realtime-speech/
  const chosenVoice = (typeof voice === 'string' && voice.trim()) ? voice.trim() : 'nh-m01';
  const chosenTone = (typeof tone === 'string' && tone.trim()) ? tone.trim() : 'natural';

  return JSON.stringify({
    type: 'session.configure',
    api_key: config.ollalinkKey,
    audio:       { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le' },
    recognition: { language: sourceLang === 'auto' ? undefined : sourceLang, punctuation: true },
    endpointing: { mode: 'auto', silence_ms: silenceMs },
    translation: { enabled: true, targets: arr },
    tts:         chosenTone && chosenTone !== 'natural'
                   ? { enabled: true, voice: chosenVoice, tone: chosenTone }
                   : { enabled: true, voice: chosenVoice },
    _meta: { session_token: sessionToken },
  });
}

/**
 * Open an upstream sound-stream socket for a participant.
 *
 * `targetLangs` is the *array* of languages this speaker's voice should be
 * rendered into â€” typically one entry per other participant's preference.
 *
 * Handlers:
 *   onEvent(evt)   â€” normalized event from translateEvent
 *   onClose()      â€” upstream closed (clean or error)
 *   onError(err)   â€” transport-level error
 */

/**
 * Parse an upstream event into a normalized form. Returns null to drop.
 *
 * Distinguishes TEXT events from AUDIO events (which carry audio_b64). Audio
 * events are decoded into a Buffer here so downstream code stays binary-native.
 */
export function translateEvent(raw) {
  if (Buffer.isBuffer(raw)) {
    return { kind: 'unknown', payload: raw };
  }
  let parsed;
  try { parsed = JSON.parse(raw.toString()); }
  catch { return { kind: 'unknown', payload: raw.toString() }; }

  const t = parsed?.type;
  switch (t) {
    case 'session.created':    return { kind: 'session-created', payload: parsed };
    case 'session.ready':
    case 'ready':              return { kind: 'ready',           payload: parsed };
    case 'transcript.partial':
    case 'partial':            return { kind: 'caption-partial', payload: parsed };
    case 'transcript.final':
    case 'final':              return { kind: 'caption-final',   payload: parsed };
    case 'translation.started':return { kind: 'translation-started', payload: parsed };
    case 'translation.delta':  return { kind: 'translation-delta',   payload: parsed };
    case 'translation.final':
    case 'translation':        return { kind: 'translation',     payload: parsed };
    case 'speech.started':     return { kind: 'speech-started',  payload: parsed };
    case 'speech.ended':       return { kind: 'speech-ended',    payload: parsed };
    case 'translation.audio': {
      const b64 = parsed.audio_b64;
      let pcm = null;
      if (typeof b64 === 'string' && b64.length > 0) {
        try { pcm = Buffer.from(b64, 'base64'); } catch { pcm = null; }
      }
      return {
        kind: 'audio',
        payload: {
          pcm,
          codec: parsed.codec ?? 'pcm_s16le',
          sampleRate: parsed.sample_rate ?? 48000,
          language: parsed.language ?? parsed.lang ?? '',
          chunkSeq: parsed.chunk_seq ?? 0,
          last: parsed.last === true,
          utteranceId: parsed.utterance_id,
        },
      };
    }
    case 'warning':            return { kind: 'warning',         payload: parsed };
    case 'error':              return { kind: 'error',           payload: parsed };
    case 'usage':              return { kind: 'usage',           payload: parsed };
    case 'session.closed':     return { kind: 'session-closed',  payload: parsed };
    default:                   return { kind: 'unknown',         payload: parsed };
  }
}

export function openOllalinkStream(args, handlers) {
  const url = config.ollalinkWsUrl;
  const targetArr = Array.isArray(args.targetLangs) ? args.targetLangs : [args.targetLangs];
  log.info(`ollalink ws â†’ ${url} (src=${args.sourceLang} targets=[${targetArr.join(',')}] voice=${args.voice ?? 'nh-m01'})`);

  const upstream = new WebSocket(url, {
    headers: {
      // Defensive: also set the header in case the edge checks it.
      'X-NH-GPU-Key': config.ollalinkKey,
      'User-Agent': 'ollalink-translate-relay/0.1 (+https://ollalink.com)',
    },
    perMessageDeflate: false,
    maxPayload: 64 * 1024 * 1024,
  });

  const state = { opened: false, configured: false, closing: false };

  upstream.on('open', () => {
    state.opened = true;
    log.info('ollalink ws open');
    upstream.send(buildConfig(args), (err) => {
      if (err) handlers.onError(err);
      else state.configured = true;
    });
  });

  upstream.on('message', (data, isBinary) => {
    const evt = translateEvent(isBinary ? data : data.toString('utf8'));
    handlers.onEvent(evt);
  });

  upstream.on('close', (code, reason) => {
    state.opened = false;
    log.warn(`ollalink ws closed code=${code} reason=${reason.toString()}`);
    if (!state.closing) handlers.onClose();
  });

  upstream.on('error', (err) => {
    log.error('ollalink ws error:', err.message);
    handlers.onError(err);
  });

  return {
    /** Send a binary PCM frame upstream (16 kHz mono s16le). Drop when not open. */
    send(pcmFrame) {
      if (state.opened && upstream.readyState === WebSocket.OPEN) {
        upstream.send(pcmFrame, { binary: true });
      }
    },
    /** Flush any partial utterance mid-call. */
    commit() {
      if (state.opened && upstream.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify({ type: 'audio.commit' }));
      }
    },
    /** End the upstream session. */
    close() {
      state.closing = true;
      try {
        upstream.close(1000, 'client hangup');
        setTimeout(() => {
          if (upstream.readyState !== WebSocket.CLOSED) {
            try { upstream.terminate(); } catch { /* ignore */ }
          }
        }, 100).unref?.();
      } catch { /* ignore */ }
    },
    isOpen: () => state.opened && upstream.readyState === WebSocket.OPEN,
    isConfigured: () => state.configured,
  };
}



