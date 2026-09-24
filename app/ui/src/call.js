export class CallController {
    invoke;
    active = false;
    constructor(invoke, _listen) {
        this.invoke = invoke;
    }
    isActive() {
        return this.active;
    }
    async startCall(args) {
        const payload = await this.invoke('start_call', {
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
    async endCall() {
        try {
            await this.invoke('end_call');
        }
        finally {
            this.active = false;
        }
    }
    /** Toggle captions mid-call. Pushed via a Tauri command that sends over the relay. */
    async setCaptions(on) {
        if (!this.active)
            return;
        await this.invoke('set_captions', { on });
    }
    /** Change language mid-call. Re-opens upstream with new langs. */
    async changeLanguages(sourceLang, targetLang) {
        if (!this.active)
            return;
        await this.invoke('change_languages', { sourceLang, targetLang });
    }
}
