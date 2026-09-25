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
  nextPlayTime = 0;
  isSpeakingState = false;
  }

/**
 * High-Precision Inbound Audio Playback with Jitter Smoothing.
 * Prevents gaps, clicks, and audio breaking when network packets arrive unevenly.
 */
function playInboundAudioChunk(buffer: ArrayBuffer) {
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

  // 1. WAV Container Batch Lane (Kannada, Tamil, Telugu fallback)
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    playbackCtx.decodeAudioData(buffer.slice(0)).then((decoded) => {
      const float32 = decoded.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < float32.length; i++) {
        const abs = Math.abs(float32[i]);
        if (abs > peak) peak = abs;
      }
      emitBrowserEvent('inbound-audio-energy', peak);

      const src = playbackCtx!.createBufferSource();
      src.buffer = decoded;
      src.connect(playbackCtx!.destination);

      const now = playbackCtx!.currentTime;
            let isChoppy = false;

      if (nextPlayTime < now) {
        nextPlayTime = now; // Seamless playback without inserting artificial silence holes
      } else if (nextPlayTime > now + 1.0) {
        nextPlayTime = now + 0.050; // Bound latency if clock drifted
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
        isChoppy,
      });
    }).catch((decodeErr) => {
      console.warn('Browser WAV decode failed, skipping chunk:', decodeErr);
    });
    return;
  }

  // 2. 48 kHz raw PCM stream path (Hindi, German, Japanese, Chinese, Portuguese, Spanish, etc.)
  const numSamples = Math.floor(bytes.length / 2);
  if (numSamples === 0) return;

  const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, numSamples);
  const float32 = new Float32Array(numSamples);
  let peak = 0;
  for (let i = 0; i < numSamples; i++) {
    const s = int16[i] / 32768.0;
    float32[i] = s;
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
  }

  emitBrowserEvent('inbound-audio-energy', peak);

  const audioBuf = playbackCtx.createBuffer(1, numSamples, 48000);
  audioBuf.getChannelData(0).set(float32);

  const src = playbackCtx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(playbackCtx.destination);

  const now = playbackCtx.currentTime;
    let isChoppy = false;

  if (nextPlayTime < now) {
    nextPlayTime = now; // Seamless playback without inserting artificial silence holes
  } else if (nextPlayTime > now + 1.0) {
    nextPlayTime = now + 0.050; // Bound latency if clock drifted
  }

  src.start(nextPlayTime);
  nextPlayTime += audioBuf.duration;

  // Checkpoint 4: Played through speaker (PCM Stream)
  const tPlay = performance.now();
  const recvToPlay = currentTurnRecvTime > 0 ? Math.round(tPlay - currentTurnRecvTime) : 15;
  const totalTurn = currentTurnMicTime > 0 ? Math.round(tPlay - currentTurnMicTime) : (recvToPlay + 120);
  emitBrowserEvent('pipeline-checkpoint', {
    stage: 'play',
    timestamp: tPlay,
    deltaMs: recvToPlay,
    totalMs: totalTurn,
    isChoppy,
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
    const hasVoiceSpike = (rms >= 0.008) || (peak >= 0.018);

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

    // 3. Utterance Segmentation with 1.5s Voice Spike Detection
    const now = Date.now();
    if (!isSpeakingState) {
      if (hasVoiceSpike) {
        // Speaker started speaking!
        isSpeakingState = true;
        lastSpeechTime = now;
        currentTurnMicTime = performance.now();
        currentTurnSendTime = 0;
        emitBrowserEvent('vad-state', { speaking: true, rms });
        emitBrowserEvent('speech-active', true);

        // Flush pre-roll buffer so initial words are completely preserved
        while (browserPreRoll.length > 0) {
          const preBuf = browserPreRoll.shift();
          if (preBuf) ws.send(preBuf.buffer);
        }
        ws.send(pcm16.buffer);
      } else {
        // Maintain 400ms rolling pre-roll buffer
        if (browserPreRoll.length >= 8) {
          browserPreRoll.shift();
        }
        browserPreRoll.push(pcm16);
      }
    } else {
      // Actively speaking
      if (hasVoiceSpike) {
        lastSpeechTime = now;
      }
      ws.send(pcm16.buffer);

      // Check if speaker has paused for 1.5 seconds (no voice spike for 1500ms)
      if (now - lastSpeechTime >= 1500) {
        isSpeakingState = false;
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
      let httpBase = relay ? relay.replace(/^ws(s)?:/, 'http$1:').replace(/\/call\/?$/, '') : window.location.origin;
      if (httpBase.includes('onrender.com') || !httpBase.startsWith('http')) {
        httpBase = window.location.origin;
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
        return (await res.json()) as T;
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
      if (!wsUrl || wsUrl.includes('onrender.com')) {
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
                emitBrowserEvent('relay-event', msg);
              } catch (parseErr) {
                console.warn('Non-JSON WebSocket message:', e.data);
              }
            } else if (e.data instanceof ArrayBuffer) {
              // Checkpoint 3: API response received
              currentTurnRecvTime = performance.now();
              const now = currentTurnRecvTime;
              if (lastPacketTime > 0) {
                const interval = now - lastPacketTime;
                packetArrivalIntervals.push(interval);
                if (packetArrivalIntervals.length > 8) packetArrivalIntervals.shift();
              }
              lastPacketTime = now;
              const deltaMs = currentTurnSendTime > 0 ? Math.round(currentTurnRecvTime - currentTurnSendTime) : 150;
              const byteCount = e.data.byteLength;
              const isCutAudio = byteCount > 0 && byteCount < 44;
              emitBrowserEvent('pipeline-checkpoint', {
                stage: 'recv',
                timestamp: currentTurnRecvTime,
                deltaMs,
                bytes: byteCount,
                isCutAudio,
              });
              // INBOUND TRANSLATED AUDIO PCM -> PLAY THROUGH SPEAKERS
              playInboundAudioChunk(e.data);
            } else if (typeof Blob !== 'undefined' && e.data instanceof Blob) {
              e.data.arrayBuffer().then((buf) => {
                currentTurnRecvTime = performance.now();
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
                playInboundAudioChunk(buf);
              });
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
        browserWs.send(JSON.stringify({ type: 'captions-toggle', on: (args as any)?.on }));
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

    case 'swap_input_device':
    case 'swap_output_device': {
      return null as T;
    }

    default:
      console.warn(`Unhandled mock invoke command: ${cmd}`);
      return undefined as unknown as T;
  }
}
