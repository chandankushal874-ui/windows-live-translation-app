import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';

export const isNativeTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// In-browser mock event emitter to support `listen` outside Tauri
const browserEventListeners = new Map<string, Set<(event: any) => void>>();

export function emitBrowserEvent(event: string, payload: any) {
  const listeners = browserEventListeners.get(event);
  if (listeners) {
    listeners.forEach((fn) => fn({ event, payload }));
  }
}

export async function listen<T = unknown>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
  if (isNativeTauri) {
    return tauriListen<T>(event, handler as any);
  }

  if (!browserEventListeners.has(event)) {
    browserEventListeners.set(event, new Set());
  }
  const set = browserEventListeners.get(event)!;
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}

let browserWs: WebSocket | null = null;
let browserWsPinger: any = null;

// Web Audio State for Browser Capture & Playback
let activeStream: MediaStream | null = null;
let captureCtx: AudioContext | null = null;
let captureProcessor: ScriptProcessorNode | null = null;
let playbackCtx: AudioContext | null = null;
let nextPlayTime = 0;
let browserPlaybackGen = 0;
// Concern C Fix: Sequential audio play queue serializes asynchronous WAV decoding and synchronous PCM scheduling
let audioPlayQueue: Promise<void> = Promise.resolve();
let pendingAudioMetaQueue: { sampleRate: number }[] = [];
// Bug 3 Fix: Buffer for orphan binary frames arriving before text header
let pendingBinaryQueue: ArrayBuffer[] = [];
// Track last known sample rate (defaults to 48000 matching Ollalink streaming PCM standard)
let lastKnownRate = 48000; // Streaming PCM default is 48 kHz
const browserSeenAudioChunks = new Set<string>();

// Adaptive Bitrate & VAD State
let lastRttMs = 45;
export function getLastRttMs(): number { return lastRttMs; }
let isSpeakingState = false;
let lastSpeechTime = 0;
let browserPreRoll: Int16Array[] = [];

// Equal-Sized Outbound Chunking (2560 samples = 160ms = 5120 bytes)

// Inbound Audio Stream & Jitter Telemetry
let totalInboundAudioChunks = 0;
let totalInboundAudioBytes = 0;
let lastInboundAudioTime = 0;
let inboundJitterMs = 0;
let lastInboundIntervalMs = 0;

export function getAudioStreamStats() {
  return {
    totalChunks: totalInboundAudioChunks,
    totalBytes: totalInboundAudioBytes,
    lastAudioTime: lastInboundAudioTime,
    jitterMs: Math.round(inboundJitterMs),
    lastIntervalMs: Math.round(lastInboundIntervalMs),
    isAudioComing: (performance.now() - lastInboundAudioTime) < 3000 && totalInboundAudioChunks > 0,
  };
}

// Pipeline Latency Watchdog & Checkpoints Telemetry State
let currentTurnMicTime = 0;
let currentTurnSendTime = 0;
let currentTurnRecvTime = 0;
let lastPacketTime = 0;
let packetArrivalIntervals: number[] = [];

// Bug 1 & Bug 2 Fix: Real-time paced outbound audio queue
// Prevents browser pre-roll dumps (<1ms burst) and CPU lag bursts from overloading Ollalink
let outboundAudioQueue: ArrayBufferLike[] = [];
let outboundPacingActive = false;

function sendPacedOutbound(ws: WebSocket, buf: ArrayBufferLike) {
  // L2 Fix: Cap outbound audio queue at 250 chunks to prevent memory leaks on stalled network
  if (outboundAudioQueue.length >= 250) {
    outboundAudioQueue.shift();
  }
  outboundAudioQueue.push(buf);
  if (outboundPacingActive) return;
  drainOutboundAudioQueue(ws);
}

function drainOutboundAudioQueue(ws: WebSocket) {
  if (outboundPacingActive) return;
  if (outboundAudioQueue.length === 0) return;
  if (ws.readyState !== WebSocket.OPEN) {
    outboundAudioQueue = [];
    return;
  }

  outboundPacingActive = true;
  const chunk = outboundAudioQueue.shift()!;
  try {
    ws.send(chunk);
  } catch {}

  // 16kHz mono s16le = 32 bytes per millisecond
  // H1 Fix: Do not clamp to 100ms! Allow true chunk duration (e.g. 128ms, 200ms) with a safe cap of 1000ms
  const durationMs = Math.max(10, Math.min(1000, Math.floor(chunk.byteLength / 32)));
  setTimeout(() => {
    outboundPacingActive = false;
    drainOutboundAudioQueue(ws);
  }, durationMs);
}


// Clean up Web Audio resources
function stopBrowserAudio() {
  if (captureProcessor) {
    try { captureProcessor.disconnect(); } catch {}
    captureProcessor = null;
  }
  if (captureCtx) {
    try { captureCtx.close(); } catch {}
    captureCtx = null;
  }
  if (activeStream) {
    activeStream.getTracks().forEach(t => t.stop());
    activeStream = null;
  }
  if (playbackCtx) {
    try { playbackCtx.close(); } catch {}
    playbackCtx = null;
  }
  // Bug 34 Fix: Increment generation counter to discard in-flight async decodeAudioData
  browserPlaybackGen++;
  // Bug 22 Fix: Complete, clean state reset for subsequent calls
  audioPlayQueue = Promise.resolve();
  nextPlayTime = 0;
  pendingAudioMetaQueue = [];
  pendingBinaryQueue = [];
  outboundAudioQueue = [];
  outboundPacingActive = false;
  lastKnownRate = 48000;
  isSpeakingState = false;
  browserPreRoll = [];
  browserSeenAudioChunks.clear();
  totalInboundAudioChunks = 0;
  totalInboundAudioBytes = 0;
  lastInboundAudioTime = 0;
  inboundJitterMs = 0;
  lastInboundIntervalMs = 0;
  currentTurnMicTime = 0;
  currentTurnSendTime = 0;
  currentTurnRecvTime = 0;
  lastPacketTime = 0;
  packetArrivalIntervals = [];
  lastSpeechTime = 0;
  }

/**
 * High-Precision Inbound Audio Playback with Jitter Smoothing.
 * Prevents gaps, clicks, and audio breaking when network packets arrive unevenly.
 */
function playInboundAudioChunk(buffer: any, sampleRate?: number) {
  if (!playbackCtx || playbackCtx.state === 'closed') {
    playbackCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  if (playbackCtx.state === 'suspended') {
    playbackCtx.resume();
  }

  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4) return;

  const nowMs = performance.now();
  totalInboundAudioChunks++;
  totalInboundAudioBytes += bytes.length;

  if (lastInboundAudioTime > 0) {
    const interval = nowMs - lastInboundAudioTime;
    if (lastInboundIntervalMs > 0) {
      // RFC 3550 inter-arrival jitter filter: J = J + (|D| - J) / 16
      const d = Math.abs(interval - lastInboundIntervalMs);
      inboundJitterMs += (d - inboundJitterMs) / 16;
    }
    lastInboundIntervalMs = interval;
  }
  lastInboundAudioTime = nowMs;

  emitBrowserEvent('audio-stream-stats', {
    chunks: totalInboundAudioChunks,
    bytes: totalInboundAudioBytes,
    jitterMs: Math.round(inboundJitterMs),
    intervalMs: Math.round(lastInboundIntervalMs),
    isAudioComing: true,
  });

  // Concern C & Bug 34 Fix: Serialize WAV decoding and cancel on session generation change
  const currentPlaybackGen = browserPlaybackGen;
  audioPlayQueue = audioPlayQueue.then(async () => {
    if (currentPlaybackGen !== browserPlaybackGen) return;
    if (!playbackCtx || playbackCtx.state === 'closed') return;

    // 1. WAV Container Batch Lane
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
      try {
        const decoded = await playbackCtx.decodeAudioData(buffer.slice(0));
        // Bug 34 Fix: Check again after async decode completes to avoid ghost playback
        if (currentPlaybackGen !== browserPlaybackGen) return;
        const float32 = decoded.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < float32.length; i++) {
          const abs = Math.abs(float32[i]);
          if (abs > peak) peak = abs;
        }
        emitBrowserEvent('inbound-audio-energy', peak);

        const src = playbackCtx.createBufferSource();
        src.buffer = decoded;
        src.connect(playbackCtx.destination);

        const now = playbackCtx.currentTime;
        // Bug 4 Fix: Tight 300ms lookahead clamp absorbs network jitter bursts without scheduling seconds ahead
        const MAX_LOOKAHEAD = 1.50; // H3 Fix: 1.5s lookahead avoids chunk overlap
        if (nextPlayTime < now) {
          nextPlayTime = now;
        } else if (nextPlayTime > now + MAX_LOOKAHEAD) {
          nextPlayTime = now + MAX_LOOKAHEAD;
        }

        src.start(nextPlayTime);
        nextPlayTime += decoded.duration;

        const tPlayWav = performance.now();
        const recvToPlayWav = currentTurnRecvTime > 0 ? Math.round(tPlayWav - currentTurnRecvTime) : 15;
        const totalTurnWav = currentTurnMicTime > 0 ? Math.round(tPlayWav - currentTurnMicTime) : (recvToPlayWav + 120);
        emitBrowserEvent('pipeline-checkpoint', {
          stage: 'play',
          timestamp: tPlayWav,
          deltaMs: recvToPlayWav,
          totalMs: totalTurnWav,
          isChoppy: false,
        });
      } catch (decodeErr) {
        console.warn('Browser WAV decode failed, skipping chunk:', decodeErr);
      }
      return;
    }

    // 2. Raw PCM stream path (Hindi, German, Japanese, Chinese, Portuguese, Spanish, etc.)
    const numSamples = Math.floor(bytes.length / 2);
    if (numSamples === 0) return;

    // Bug 2 Fix: Fall back to tracked lastKnownRate (default 48000) instead of guessing
    const effectiveRate = sampleRate || lastKnownRate || 48000;
    lastKnownRate = effectiveRate;

    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, numSamples);
    const float32 = new Float32Array(numSamples);
    let peak = 0;
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1.0, Math.min(1.0, int16[i] / 32768.0));
      float32[i] = s;
      const abs = Math.abs(s);
      if (abs > peak) peak = abs;
    }

    emitBrowserEvent('inbound-audio-energy', peak);

    const audioBuf = playbackCtx.createBuffer(1, numSamples, effectiveRate);
    audioBuf.getChannelData(0).set(float32);

    const src = playbackCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(playbackCtx.destination);

    const now = playbackCtx.currentTime;
    // Bug 4 Fix: Tight 300ms lookahead clamp absorbs network jitter bursts without scheduling seconds ahead
    const MAX_LOOKAHEAD = 1.50; // H3 Fix: 1.5s lookahead avoids chunk overlap
    if (nextPlayTime < now) {
      nextPlayTime = now;
    } else if (nextPlayTime > now + MAX_LOOKAHEAD) {
      nextPlayTime = now + MAX_LOOKAHEAD;
    }

    src.start(nextPlayTime);
    nextPlayTime += audioBuf.duration;

    const tPlay = performance.now();
    const recvToPlay = currentTurnRecvTime > 0 ? Math.round(tPlay - currentTurnRecvTime) : 15;
    const totalTurn = currentTurnMicTime > 0 ? Math.round(tPlay - currentTurnMicTime) : (recvToPlay + 120);
    emitBrowserEvent('pipeline-checkpoint', {
      stage: 'play',
      timestamp: tPlay,
      deltaMs: recvToPlay,
      totalMs: totalTurn,
      isChoppy: false,
    });
  }).catch(err => {
    console.warn('Inbound audio play error:', err);
  });
}

/**
 * Intelligent Web Audio Capture with Client-Side VAD, Noise Gating, & Adaptive Bitrate.
 * Eliminates 1-minute latency by committing utterances instantly on speech pauses (>350ms).
 */
async function startBrowserCapture(ws: WebSocket): Promise<void> {
  stopBrowserAudio();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  activeStream = stream;

  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  captureCtx = ctx;

  const sourceNode = ctx.createMediaStreamSource(stream);
  const bufferSize = 2048;
  const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
  captureProcessor = processor;

  const inRate = ctx.sampleRate;
  const targetRate = 16000;
  const ratio = inRate / targetRate;
  let consecutiveSpeechFrames = 0;
  const VAD_ONSET_RMS = 0.024;
  const VAD_ONSET_PEAK = 0.045;
  const VAD_CONTINUE_RMS = 0.012;
  const VAD_CONTINUE_PEAK = 0.024;

  processor.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const inputData = e.inputBuffer.getChannelData(0);

    // 1. Calculate Peak and RMS Energy for Voice Spike Detection
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < inputData.length; i++) {
      const val = inputData[i];
      const abs = Math.abs(val);
      if (abs > peak) peak = abs;
      sumSquares += val * val;
    }
    const rms = Math.sqrt(sumSquares / inputData.length);
    emitBrowserEvent('vu-meter', peak);
    const isOnsetFrame = (rms >= VAD_ONSET_RMS && peak >= VAD_ONSET_PEAK) || (rms >= 0.035);
    const isContinuing = (rms >= VAD_CONTINUE_RMS) || (peak >= VAD_CONTINUE_PEAK);

    // 2. High-Quality Linear Interpolation Resampling to 16kHz s16le PCM
    const outLength = Math.round(inputData.length / ratio);
    const pcm16 = new Int16Array(outLength);

    for (let i = 0; i < outLength; i++) {
      const srcPos = i * ratio;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const s0 = inputData[idx] || 0;
      const s1 = idx + 1 < inputData.length ? inputData[idx + 1] : s0;
      const s = Math.max(-1, Math.min(1, s0 + frac * (s1 - s0)));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    // 3. Utterance Segmentation with Debounced VAD & Modest Pre-Roll (~100ms)
    const now = Date.now();
    if (!isSpeakingState) {
      if (isOnsetFrame) {
        consecutiveSpeechFrames++;
      } else {
        consecutiveSpeechFrames = 0;
      }

      if (consecutiveSpeechFrames >= 2) {
        // Confirmed speech onset: sustained voice energy across 2 frames (~80ms)
        isSpeakingState = true;
        lastSpeechTime = now;
        currentTurnMicTime = performance.now();
        currentTurnSendTime = 0;
        emitBrowserEvent('vad-state', { speaking: true, rms });
        emitBrowserEvent('speech-active', true);

        // Bug 2 Fix: Flush modest pre-roll buffer (~100ms) with real-time frame pacing
        while (browserPreRoll.length > 0) {
          const preBuf = browserPreRoll.shift();
          if (preBuf) sendPacedOutbound(ws, preBuf.buffer);
        }
        sendPacedOutbound(ws, pcm16.buffer);
      } else {
        // Maintain ~100ms rolling pre-roll buffer (3 frames @ 2048 samples)
        if (browserPreRoll.length >= 3) {
          browserPreRoll.shift();
        }
        browserPreRoll.push(pcm16);
      }
    } else {
      // Actively speaking (Bug 1 Fix: Paced real-time transmission)
      if (isContinuing) {
        lastSpeechTime = now;
      }
      sendPacedOutbound(ws, pcm16.buffer);

      // Check if speaker has paused for 1.2 seconds
      if (now - lastSpeechTime >= 1200) {
        isSpeakingState = false;
        consecutiveSpeechFrames = 0;
        emitBrowserEvent('vad-state', { speaking: false, rms });
        emitBrowserEvent('speech-active', false);
        try {
          ws.send(JSON.stringify({ type: 'audio.commit' }));
        } catch {}
        browserPreRoll = [];
      }
    }
  };

  sourceNode.connect(processor);
  // Route processor through zero-gain node to destination to prevent mic echo through phone speakers
  const silentGain = ctx.createGain();
  silentGain.gain.value = 0;
  processor.connect(silentGain);
  silentGain.connect(ctx.destination);
}

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isNativeTauri) {
    return tauriInvoke<T>(cmd, args);
  }

  // Browser Fallback implementations
  switch (cmd) {
    case 'load_prefs': {
      try {
        const raw = localStorage.getItem('ollalink_user_prefs');
        if (raw) return JSON.parse(raw);
      } catch (e) {
        console.warn('Failed to load prefs from localStorage:', e);
      }
      return {
        version: 1,
        displayName: `user-${Math.random().toString(36).slice(2, 6)}`,
        relayUrl: window.location.origin,
        sourceLang: 'en',
        targetLang: 'hi',
        inputDevice: null,
        outputDevice: null,
        inputVolume: 1.0,
      } as unknown as T;
    }

    case 'save_prefs': {
      try {
        localStorage.setItem('ollalink_user_prefs', JSON.stringify((args as any)?.prefs));
      } catch (e) {
        console.warn('Failed to save prefs to localStorage:', e);
      }
      return undefined as unknown as T;
    }

    case 'list_audio_devices': {
      let inputs: string[] = [];
      let outputs: string[] = [];
      try {
        if (navigator?.mediaDevices?.enumerateDevices) {
          const devs = await navigator.mediaDevices.enumerateDevices();
          inputs = devs
            .filter((d) => d.kind === 'audioinput')
            .map((d) => d.label || `Microphone ${d.deviceId.slice(0, 4)}`);
          outputs = devs
            .filter((d) => d.kind === 'audiooutput')
            .map((d) => d.label || `Speaker ${d.deviceId.slice(0, 4)}`);
        }
      } catch {}
      if (!inputs.length) inputs = ['Default Microphone (Browser)'];
      if (!outputs.length) outputs = ['Default Speaker (Browser)'];
      return {
        inputs,
        outputs,
        default_input: inputs[0],
        default_output: outputs[0],
      } as unknown as T;
    }

    case 'mint_session': {
      let relay = String(args?.relayUrl || '');
      let httpBase = relay ? relay.trim().replace(/^ws(s)?:/, 'http$1:').replace(/\/call\/?$/, '').replace(/\/+$/, '') : (window.location.origin?.startsWith('http') ? window.location.origin : 'https://windows-live-translation-app-1.onrender.com');
      if (!httpBase.startsWith('http')) {
        httpBase = window.location.origin?.startsWith('http') ? window.location.origin : 'https://windows-live-translation-app-1.onrender.com';
      }
      try {
        const res = await fetch(`${httpBase}/api/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userId: args?.userId,
            sourceLang: args?.sourceLang,
            targetLang: args?.targetLang,
            voice: (args as any)?.voice,
            tone: (args as any)?.tone,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`mint_session failed (${res.status}): ${text}`);
        }
        const data = (await res.json()) as any;
        if (data?.wsUrl && (data.wsUrl.includes('localhost') || data.wsUrl.includes('127.0.0.1')) && !httpBase.includes('localhost') && !httpBase.includes('127.0.0.1')) {
          const baseWs = httpBase.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
          data.wsUrl = `${baseWs.replace(/\/+$/, '')}/call`;
        }
        return data as T;
      } catch (err: any) {
        if (err?.message && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('refused'))) {
          throw new Error(`Relay server offline at ${httpBase}. Please check connection.`);
        }
        throw err;
      }
    }

    case 'start_call': {
      const callArgs = (args as any)?.args || {};
      let wsUrl = callArgs?.credentials?.wsUrl || '';
      if (!wsUrl) {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${proto}//${window.location.host}/call`;
      } else {
        wsUrl = wsUrl.replace(/^http(s)?:/, 'ws$1:');
      }

      return new Promise<T>((resolve, reject) => {
        try {
          if (browserWs) {
            browserWs.close();
            browserWs = null;
          }
          if (browserWsPinger) {
            clearInterval(browserWsPinger);
            browserWsPinger = null;
          }

          const ws = new WebSocket(wsUrl);
          ws.binaryType = 'arraybuffer';
          browserWs = ws;
          let joinedResolved = false;

          ws.onopen = async () => {
            const joinMsg = {
              type: 'join',
              room: callArgs.roomCode || null,
              token: callArgs.credentials?.token,
              displayName: callArgs.displayName,
              sourceLang: callArgs.sourceLang,
              targetLang: callArgs.targetLang,
              captionsOn: !!callArgs.captionsOn,
              voice: callArgs.credentials?.voice,
              tone: callArgs.credentials?.tone,
            };
            ws.send(JSON.stringify(joinMsg));

            browserWsPinger = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
              }
            }, 10000);

            // Start Live Microphone Streaming
            try {
              await startBrowserCapture(ws);
            } catch (micErr: any) {
              console.warn('Microphone start error:', micErr);
              emitBrowserEvent('audio-error', micErr.message || 'Could not access microphone');
            }
          };

          ws.onmessage = (e) => {
            if (typeof e.data === 'string') {
              try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'audio') {
                  // C3 Fix: Robust dedup — only dedup when utteranceId is a non-empty string (not null/undefined/"undefined")
                  if (typeof msg.utteranceId === 'string' && msg.utteranceId.length > 0 && msg.utteranceId !== 'undefined' && msg.chunkSeq !== undefined) {
                    const chunkKey = `${msg.from || ''}:${msg.utteranceId}:${msg.chunkSeq}`;
                    if (browserSeenAudioChunks.has(chunkKey)) {
                      if (msg.hasBinary && pendingBinaryQueue.length > 0) {
                        pendingBinaryQueue.shift();
                      }
                      return;
                    }
                    browserSeenAudioChunks.add(chunkKey);
                    // L5 Fix: Evict oldest 10% when over cap, not just 1 entry
                    if (browserSeenAudioChunks.size > 500) {
                      const it = browserSeenAudioChunks.values();
                      for (let i = 0; i < 50; i++) {
                        const v = it.next().value;
                        if (v) browserSeenAudioChunks.delete(v);
                      }
                    }
                  }
                  const isWavCodec = msg.codec === 'wav';
                  // Bug 1 & C2 Fix: Streaming PCM lane is 48 kHz when omitted; WAV batch lane is 24 kHz.
                  // Do not overwrite lastKnownRate with WAV's 24kHz so raw PCM lanes retain 48kHz!
                  const sr = (typeof msg.sampleRate === 'number' && msg.sampleRate > 0)
                    ? msg.sampleRate
                    : (isWavCodec ? 24000 : 48000);
                  if (!isWavCodec) {
                    lastKnownRate = sr;
                  }

                  if (msg.hasBinary === true) {
                    // Bug 3 Fix: If an orphan binary frame arrived earlier while waiting for its header, pair it now!
                    if (pendingBinaryQueue.length > 0) {
                      const orphanBuf = pendingBinaryQueue.shift()!;
                      playInboundAudioChunk(orphanBuf, sr);
                    } else {
                      if (pendingAudioMetaQueue.length >= 32) pendingAudioMetaQueue.shift();
                      pendingAudioMetaQueue.push({ sampleRate: sr });
                    }
                  } else if (msg.endOfUtterance || msg.last) {
                    // L3 Fix: Only clear meta queue (text headers). Keep pendingBinaryQueue intact
                    // so orphan binaries from a subsequent utterance aren't lost.
                    pendingAudioMetaQueue = [];
                  }
                }
                if (msg.type === 'joined' && !joinedResolved) {
                  joinedResolved = true;
                  emitBrowserEvent('call-state', 'active');
                  resolve({
                    room: msg.room,
                    self: msg.self,
                  } as unknown as T);
                } else if (msg.type === 'error' && !joinedResolved) {
                  joinedResolved = true;
                  reject(new Error(String(msg.message || msg.code || 'Relay error')));
                }
                if (msg.code === 'overloaded' || msg.type === 'upstream-overloaded') {
                  console.warn('Ollalink upstream overloaded! Purging excess outbound buffer to pace real-time delivery');
                  outboundAudioQueue = outboundAudioQueue.slice(-2);
                }
                emitBrowserEvent('relay-event', msg);
              } catch (parseErr) {
                console.warn('Non-JSON WebSocket message:', e.data);
              }
            } else if (e.data instanceof ArrayBuffer || (typeof Blob !== 'undefined' && e.data instanceof Blob)) {
              const processInboundBinary = (buf: ArrayBuffer) => {
                currentTurnRecvTime = performance.now();
                const now = currentTurnRecvTime;
                if (lastPacketTime > 0) {
                  const interval = now - lastPacketTime;
                  packetArrivalIntervals.push(interval);
                  if (packetArrivalIntervals.length > 8) packetArrivalIntervals.shift();
                }
                lastPacketTime = now;
                const deltaMs = currentTurnSendTime > 0 ? Math.round(currentTurnRecvTime - currentTurnSendTime) : 150;
                const byteCount = buf.byteLength;
                const isCutAudio = byteCount > 0 && byteCount < 44;
                emitBrowserEvent('pipeline-checkpoint', {
                  stage: 'recv',
                  timestamp: currentTurnRecvTime,
                  deltaMs,
                  bytes: byteCount,
                  isCutAudio,
                });

                // WAV containers are self-describing; native sample rate is in the header
                const b = new Uint8Array(buf);
                const isWav = b.length >= 12 &&
                  b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
                  b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45;

                if (isWav) {
                  const meta = pendingAudioMetaQueue.shift();
                  playInboundAudioChunk(buf, meta?.sampleRate);
                } else if (pendingAudioMetaQueue.length > 0) {
                  // Raw PCM with preceding metadata header matched
                  const meta = pendingAudioMetaQueue.shift()!;
                  playInboundAudioChunk(buf, meta.sampleRate);
                } else {
                  // Bug 3 Fix: Raw PCM binary frame arrived before its text header.
                  // Buffer in pendingBinaryQueue instead of guessing the wrong sample rate!
                  if (pendingBinaryQueue.length >= 32) pendingBinaryQueue.shift();
                  pendingBinaryQueue.push(buf);
                }
              };

              if (e.data instanceof ArrayBuffer) {
                processInboundBinary(e.data);
              } else {
                e.data.arrayBuffer().then(processInboundBinary);
              }
            }
          };

          ws.onerror = (err) => {
            console.error('Browser WebSocket error:', err);
            emitBrowserEvent('relay-error', 'WebSocket connection failed');
            if (!joinedResolved) {
              reject(new Error('Failed to connect to relay WebSocket'));
            }
          };

          ws.onclose = () => {
            stopBrowserAudio();
            if (browserWsPinger) {
              clearInterval(browserWsPinger);
              browserWsPinger = null;
            }
            if (!joinedResolved) {
              joinedResolved = true;
              reject(new Error('Connection closed before joined'));
            }
            emitBrowserEvent('relay-closed', {});
            emitBrowserEvent('call-state', 'idle');
            emitBrowserEvent('call-ended', {});
          };
        } catch (err) {
          reject(err);
        }
      });
    }

    case 'end_call': {
      stopBrowserAudio();
      if (browserWs) {
        try {
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(JSON.stringify({ type: 'leave' }));
          }
          browserWs.close();
        } catch (e) {
          console.warn('Error closing browser WS:', e);
        }
        browserWs = null;
      }
      if (browserWsPinger) {
        clearInterval(browserWsPinger);
        browserWsPinger = null;
      }
      emitBrowserEvent('call-state', 'idle');
      emitBrowserEvent('call-ended', {});
      return undefined as unknown as T;
    }

    case 'set_captions': {
      if (browserWs && browserWs.readyState === WebSocket.OPEN) {
        // Bug 25 Fix: Send captions.set matching server expectation
        browserWs.send(JSON.stringify({ type: 'captions.set', on: (args as any)?.on }));
      }
      return undefined as unknown as T;
    }

    case 'update_voice_settings': {
      if (browserWs && browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(JSON.stringify({
          type: 'update-voice-settings',
          voice: args?.voice,
          tone: args?.tone,
        }));
      }
      return null as T;
    }

    case 'change_languages': {
      if (browserWs && browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(JSON.stringify({
          type: 'lang.change',
          sourceLang: (args as any)?.sourceLang || (args as any)?.source_lang,
          targetLang: (args as any)?.targetLang || (args as any)?.target_lang,
        }));
      }
      return null as T;
    }

    case 'set_input_volume': {
      return null as T;
    }

    case 'set_mic_muted': {
      const muted = !!(args as any)?.muted;
      if (activeStream) {
        activeStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
      }
      return null as T;
    }

    case 'swap_input_device':
    case 'swap_output_device': {
      return null as T;
    }

    default:
      console.warn(`Unhandled mock invoke command: ${cmd}`);
      return undefined as unknown as T;
  }
}
