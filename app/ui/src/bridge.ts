/**
 * bridge.ts — Unified IPC bridge for both Tauri Native App and Web Browser preview.
 *
 * When running inside the Tauri native app (Webview2), calls delegate directly to
 * @tauri-apps/api/core (invoke) and @tauri-apps/api/event (listen).
 *
 * When running inside a normal web browser (e.g. Chrome, Edge at http://localhost:1420),
 * provides a browser-native fallback:
 *   - LocalStorage for user preferences
 *   - Direct fetch() to Relay Server for mint_session (/api/session)
 *   - Direct WebSocket connection to Relay Server (/call) for room joining and live events
 *   - Navigator.mediaDevices for audio device listing
 */

import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';

export const isNativeTauri = isTauri();

type EventHandler = (event: { payload: any }) => void;
const browserListeners: Map<string, Set<EventHandler>> = new Map();

export function emitBrowserEvent(name: string, payload: any) {
  const set = browserListeners.get(name);
  if (set) {
    for (const fn of set) {
      try {
        fn({ payload });
      } catch (err) {
        console.error(`Error in browser event handler for "${name}":`, err);
      }
    }
  }
}

let browserWs: WebSocket | null = null;
let browserWsPinger: any = null;

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
        relayUrl: 'ws://localhost:8787',
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
      const relay = String(args?.relayUrl || 'ws://localhost:8787');
      const httpBase = relay.replace(/^ws(s)?:/, 'http$1:');
      try {
        const res = await fetch(`${httpBase}/api/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userId: args?.userId,
            sourceLang: args?.sourceLang,
            targetLang: args?.targetLang,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`mint_session failed (${res.status}): ${text}`);
        }
        return (await res.json()) as T;
      } catch (err: any) {
        if (err?.message && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('refused'))) {
          throw new Error(`Relay server offline at ${httpBase}. Please start it with 'cd server && npm start'.`);
        }
        throw err;
      }
    }

    case 'start_call': {
      const callArgs = (args as any)?.args || {};
      const relay = String(callArgs.relayUrl || 'ws://localhost:8787');
      const wsUrl = relay.replace(/\/call\/?$/, '') + '/call';

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
          browserWs = ws;
          let joinedResolved = false;

          ws.onopen = () => {
            const joinMsg = {
              type: 'join',
              room: callArgs.roomCode || null,
              token: callArgs.credentials?.token,
              displayName: callArgs.displayName,
              sourceLang: callArgs.sourceLang,
              targetLang: callArgs.targetLang,
              captionsOn: !!callArgs.captionsOn,
            };
            ws.send(JSON.stringify(joinMsg));

            browserWsPinger = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
              }
            }, 10000);
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

    case 'change_languages': {
      if (browserWs && browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(
          JSON.stringify({
            type: 'language-change',
            sourceLang: (args as any)?.sourceLang,
            targetLang: (args as any)?.targetLang,
          }),
        );
      }
      return undefined as unknown as T;
    }

    case 'set_input_volume':
    case 'swap_input_device':
    case 'swap_output_device':
      return undefined as unknown as T;

    default:
      console.warn(`[Browser Bridge] Unhandled invoke command: "${cmd}"`);
      return undefined as unknown as T;
  }
}

export async function listen<T = unknown>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  if (isNativeTauri) {
    return tauriListen<T>(event, handler);
  }

  let set = browserListeners.get(event);
  if (!set) {
    set = new Set();
    browserListeners.set(event, set);
  }
  set.add(handler as EventHandler);

  return () => {
    const s = browserListeners.get(event);
    if (s) {
      s.delete(handler as EventHandler);
    }
  };
}
