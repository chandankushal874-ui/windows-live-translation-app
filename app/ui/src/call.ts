/**
 * call.ts — call state machine on the UI side.
 *
 * Owns the Tauri-command orchestration: mint session → start_call → end_call,
 * plus mid-call toggles (captions, languages) pushed via `send_json` on the
 * active relay socket.
 */
import type { SessionCredentials } from './types';

export interface StartCallArgs {
  relayUrl: string;
  roomCode: string | null;
  displayName: string;
  sourceLang: string;
  targetLang: string;
  inputDevice: string | null;
  outputDevice: string | null;
  captionsOn: boolean;
  credentials: SessionCredentials;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type ListenFn = (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;

export class CallController {
  private active = false;

  constructor(
    private invoke: InvokeFn,
    _listen: ListenFn,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  async startCall(args: StartCallArgs): Promise<{ room: string; selfSessionId: string }> {
    const payload = await this.invoke<{ room: string; self: { sessionId: string } }>('start_call', {
      args: {
        relayUrl: args.relayUrl,
        roomCode: args.roomCode,
        displayName: args.displayName,
        sourceLang: args.sourceLang,
        targetLang: args.targetLang,
        inputDevice: args.inputDevice,
        outputDevice: args.outputDevice,
        captionsOn: args.captionsOn,
        credentials: args.credentials,
      },
    });
    this.active = true;
    return { room: payload.room, selfSessionId: payload.self.sessionId };
  }

  async endCall(): Promise<void> {
    try {
      await this.invoke('end_call');
    } finally {
      this.active = false;
    }
  }

  /** Toggle captions mid-call. Pushed via a Tauri command that sends over the relay. */
  async setCaptions(on: boolean): Promise<void> {
    if (!this.active) return;
    await this.invoke('set_captions', { on });
  }

  /** Change language mid-call. Re-opens upstream with new langs. */
  async changeLanguages(sourceLang?: string, targetLang?: string): Promise<void> {
    if (!this.active) return;
    await this.invoke('change_languages', { sourceLang, targetLang });
  }

  /** Update voice persona and tone mid-call. Pushed to relay server. */
  async updateVoiceSettings(voice?: string, tone?: string): Promise<void> {
    if (!this.active) return;
    await this.invoke('update_voice_settings', { voice, tone });
  }
}
