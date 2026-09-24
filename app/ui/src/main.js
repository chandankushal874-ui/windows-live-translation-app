/**
 * main.ts — UI bootstrap, dual-mode Landing & In-Call flow, instant 1:1 join.
 */
import { invoke, listen, isNativeTauri } from './bridge';
import { CallController } from './call';
import { CaptionsView } from './captions';
async function main() {
    const $ = (id) => {
        const el = document.getElementById(id);
        if (!el)
            throw new Error(`missing element #${id}`);
        return el;
    };
    // ---------- DOM Elements ----------
    // Views
    const landingView = $('landing-view');
    const callView = $('call-view');
    // Header & Status
    const connStatus = $('conn-status');
    // Landing Setup
    const displayName = $('display-name');
    const sourceLang = $('source-lang');
    const targetLang = $('target-lang');
    const voicePersona = $('voice-persona');
    const voiceTone = $('voice-tone');
    const inputDevice = $('input-device');
    const outputDevice = $('output-device');
    const relayUrl = $('relay-url');
    const captionsOn = $('captions-on');
    // Hero Actions & Dedicated Name Inputs
    const hostNameInput = $('host-name-input');
    const joinNameInput = $('join-name-input');
    const btnHost = $('btn-host');
    const btnJoin = $('btn-join');
    const roomCodeInput = $('room-code-input');
    const btnPasteCode = $('btn-paste-code');
    const joinHint = $('join-hint');
    const hostHint = $('host-hint');
    const landingErrorBanner = $('landing-error-banner');
    // In-Call View Elements
    const activeRoomDisplay = $('active-room-display');
    const btnCopyCode = $('btn-copy-code');
    const btnCopyInvite = $('btn-copy-invite');
    const copyToast = $('copy-toast');
    const btnEnd = $('btn-end');
    const peerStatusBox = $('peer-status-box');
    const peerStatusText = $('peer-status-text');
    // Mid-Call Controls
    const midcallSourceLang = $('midcall-source-lang');
    const midcallTargetLang = $('midcall-target-lang');
    const midcallVoicePersona = $('midcall-voice-persona');
    const midcallVoiceTone = $('midcall-voice-tone');
    const midcallCaptionsOn = $('midcall-captions-on');
    const inputGain = $('input-gain');
    const gainReadout = $('gain-readout');
    const vuFill = $('vu-fill');
    const participantsUl = $('participants');
    const captionsScroll = $('captions-scroll');
    // Call Role and State Tracking
    let isCurrentCallHost = false;
    let currentRoom = '';
    let selfSessionId = '';
    let isConnecting = false;
    let currentPeerInfo = null;
    const participantNames = new Map();
    // Default initial random username
    const defaultRandomName = `user-${Math.random().toString(36).slice(2, 6)}`;
    displayName.value = defaultRandomName;
    hostNameInput.value = defaultRandomName;
    joinNameInput.value = ''; // Leave guest empty so user explicitly types their name
    if (!isNativeTauri) {
        console.info('[Browser Preview] Running outside Tauri desktop wrapper. Direct Relay bridge enabled.');
        setStatus('idle', 'idle (browser)');
    }
    // ---------- Load persisted preferences ----------
    try {
        const prefs = await invoke('load_prefs');
        if (prefs.displayName) {
            displayName.value = prefs.displayName;
            hostNameInput.value = prefs.displayName;
            joinNameInput.value = prefs.displayName;
        }
        if (prefs.relayUrl && !prefs.relayUrl.includes('localhost') && !prefs.relayUrl.includes('127.0.0.1')) {
            relayUrl.value = prefs.relayUrl;
        }
        else {
            relayUrl.value = 'https://windows-live-translation-app-1.onrender.com';
        }
        if (prefs.sourceLang) {
            sourceLang.value = prefs.sourceLang;
            midcallSourceLang.value = prefs.sourceLang;
        }
        if (prefs.targetLang) {
            targetLang.value = prefs.targetLang;
            midcallTargetLang.value = prefs.targetLang;
        }
        if (prefs.voicePersona) {
            voicePersona.value = prefs.voicePersona;
            midcallVoicePersona.value = prefs.voicePersona;
        }
        if (prefs.voiceTone) {
            voiceTone.value = prefs.voiceTone;
            midcallVoiceTone.value = prefs.voiceTone;
        }
        if (prefs.inputVolume != null) {
            inputGain.value = String(prefs.inputVolume);
            gainReadout.textContent = prefs.inputVolume.toFixed(2);
        }
        window.__pendingPrefDevices = {
            input: prefs.inputDevice,
            output: prefs.outputDevice,
        };
    }
    catch (err) {
        console.warn('load_prefs failed (using defaults):', err);
    }
    const captions = new CaptionsView(captionsScroll);
    const controller = new CallController(invoke, listen);
    // ---------- Relay Health Monitor ----------
    async function probeRelayHealth() {
        if (controller.isActive() || isConnecting)
            return;
        const base = relayUrl.value.replace(/^ws(s)?:/, 'http$1:').replace(/\/call\/?$/, '');
        try {
            const res = await fetch(`${base}/api/health`, { method: 'GET', signal: AbortSignal.timeout(1800) });
            if (res.ok) {
                landingErrorBanner.style.display = 'none';
                if (!controller.isActive() && !isConnecting) {
                    setStatus('idle', '🟢 relay online');
                }
            }
            else {
                showRelayOfflineWarning(base);
            }
        }
        catch {
            showRelayOfflineWarning(base);
        }
    }
    function showRelayOfflineWarning(base) {
        if (controller.isActive() || isConnecting)
            return;
        setStatus('err', '🔴 relay offline');
        landingErrorBanner.style.display = 'flex';
        landingErrorBanner.innerHTML = `⚠️ <strong>Relay Server is unreachable</strong> at <code>${base}</code>.<br><span style="font-size:12px;opacity:0.85;">If waking up from cold sleep on Render, please wait ~20s.</span>`;
    }
    probeRelayHealth();
    setInterval(probeRelayHealth, 4000);
    // ---------- Audio Devices ----------
    try {
        const devices = await invoke('list_audio_devices');
        for (const sel of [inputDevice, outputDevice])
            sel.innerHTML = '';
        for (const name of devices.inputs) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            inputDevice.appendChild(opt);
        }
        for (const name of devices.outputs) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            outputDevice.appendChild(opt);
        }
        if (devices.default_input)
            inputDevice.value = devices.default_input;
        if (devices.default_output)
            outputDevice.value = devices.default_output;
        const pending = window.__pendingPrefDevices;
        if (pending) {
            if (pending.input && devices.inputs.includes(pending.input))
                inputDevice.value = pending.input;
            if (pending.output && devices.outputs.includes(pending.output))
                outputDevice.value = pending.output;
            delete window.__pendingPrefDevices;
        }
        inputDevice.addEventListener('change', async () => {
            if (controller.isActive()) {
                await invoke('swap_input_device', { name: inputDevice.value }).catch(console.error);
            }
        });
        outputDevice.addEventListener('change', async () => {
            if (controller.isActive()) {
                await invoke('swap_output_device', { name: outputDevice.value }).catch(console.error);
            }
        });
    }
    catch (err) {
        console.warn('list_audio_devices failed:', err);
    }
    // ---------- Sync Preferences & Name Inputs ----------
    const persistPrefs = debounce(async () => {
        const prefs = {
            version: 1,
            displayName: displayName.value,
            relayUrl: relayUrl.value,
            sourceLang: sourceLang.value,
            targetLang: targetLang.value,
            voicePersona: voicePersona.value,
            voiceTone: voiceTone.value,
            inputDevice: inputDevice.value || null,
            outputDevice: outputDevice.value || null,
            inputVolume: parseFloat(inputGain.value),
        };
        try {
            await invoke('save_prefs', { prefs });
        }
        catch (e) {
            console.warn('save_prefs:', e);
        }
    }, 500);
    // Synchronize Host & Guest name inputs with main display name
    hostNameInput.addEventListener('input', () => {
        hostNameInput.classList.remove('input-error');
        hostHint.textContent = '';
        displayName.value = hostNameInput.value;
        joinNameInput.value = hostNameInput.value;
        persistPrefs();
    });
    joinNameInput.addEventListener('input', () => {
        joinNameInput.classList.remove('input-error');
        joinHint.textContent = '';
        displayName.value = joinNameInput.value;
        hostNameInput.value = joinNameInput.value;
        persistPrefs();
    });
    displayName.addEventListener('input', () => {
        hostNameInput.value = displayName.value;
        joinNameInput.value = displayName.value;
        persistPrefs();
    });
    for (const el of [relayUrl, sourceLang, targetLang, voicePersona, voiceTone, inputDevice, outputDevice, inputGain]) {
        el.addEventListener('change', persistPrefs);
        el.addEventListener('input', persistPrefs);
    }
    // Keep landing and mid-call language dropdowns synchronized
    sourceLang.addEventListener('change', () => {
        midcallSourceLang.value = sourceLang.value;
    });
    targetLang.addEventListener('change', () => {
        midcallTargetLang.value = targetLang.value;
    });
    voicePersona.addEventListener('change', () => {
        midcallVoicePersona.value = voicePersona.value;
    });
    voiceTone.addEventListener('change', () => {
        midcallVoiceTone.value = voiceTone.value;
    });
    // ---------- Call Orchestration & Role-Aware Banners ----------
    function switchToCallView(room, isHost) {
        currentRoom = room;
        isCurrentCallHost = isHost;
        activeRoomDisplay.textContent = room;
        landingView.style.display = 'none';
        callView.style.display = 'flex';
        if (isHost) {
            setWaitingPeerStatus();
        }
        else {
            if (currentPeerInfo) {
                setConnectedPeerStatus(currentPeerInfo.name, currentPeerInfo.sourceLang, currentPeerInfo.targetLang);
            }
            else {
                setJoinedGuestStatus();
            }
        }
    }
    function switchToLandingView() {
        currentRoom = '';
        selfSessionId = '';
        isCurrentCallHost = false;
        currentPeerInfo = null;
        participantNames.clear();
        isConnecting = false;
        btnHost.disabled = false;
        btnJoin.disabled = false;
        callView.style.display = 'none';
        landingView.style.display = 'flex';
        participantsUl.innerHTML = '';
        captions.clear();
        setStatus('idle', 'idle');
        roomCodeInput.value = '';
        joinHint.textContent = 'Auto-connects when 6-char code is entered';
        joinHint.style.color = '';
        hostHint.textContent = '';
        hostHint.style.color = '';
        probeRelayHealth();
    }
    // Status Banners: Strictly separated by Host vs Joined Guest
    function setWaitingPeerStatus() {
        peerStatusBox.className = 'peer-status-box waiting';
        peerStatusText.textContent = `Waiting for your partner to join... Share room code: ${currentRoom}`;
    }
    function setJoinedGuestStatus() {
        peerStatusBox.className = 'peer-status-box connected';
        peerStatusText.textContent = `🟢 Successfully joined room ${currentRoom}! Connecting with host...`;
    }
    function setConnectedPeerStatus(peerName, sourceLangCode, targetLangCode) {
        peerStatusBox.className = 'peer-status-box connected';
        const langInfo = sourceLangCode && targetLangCode ? ` (${sourceLangCode} ➔ ${targetLangCode})` : '';
        if (isCurrentCallHost) {
            peerStatusText.textContent = `🟢 Partner ${peerName} joined! In 1:1 call${langInfo}`;
        }
        else {
            peerStatusText.textContent = `🟢 Successfully joined room ${currentRoom}! In 1:1 call with ${peerName}${langInfo}`;
        }
    }
    async function startCallSession(requestedRoomCode) {
        if (isConnecting || controller.isActive())
            return;
        isConnecting = true;
        btnHost.disabled = true;
        btnJoin.disabled = true;
        const isHost = !requestedRoomCode;
        isCurrentCallHost = isHost;
        const chosenName = (isHost ? hostNameInput.value : joinNameInput.value).trim() || displayName.value.trim() || (isHost ? 'Host' : 'Guest');
        displayName.value = chosenName;
        setStatus('busy', requestedRoomCode ? `joining ${requestedRoomCode}…` : 'hosting room…');
        try {
            const creds = await invoke('mint_session', {
                relayUrl: relayUrl.value,
                userId: chosenName,
                sourceLang: sourceLang.value,
                targetLang: targetLang.value,
                voice: voicePersona.value,
                tone: voiceTone.value,
            });
            const joined = await controller.startCall({
                relayUrl: relayUrl.value,
                roomCode: requestedRoomCode,
                displayName: chosenName,
                sourceLang: sourceLang.value,
                targetLang: targetLang.value,
                inputDevice: inputDevice.value || null,
                outputDevice: outputDevice.value || null,
                captionsOn: captionsOn.checked,
                credentials: creds,
            });
            selfSessionId = joined.selfSessionId;
            switchToCallView(joined.room, isHost);
            setStatus('active', `room ${joined.room}`);
        }
        catch (err) {
            console.error('startCallSession error:', err);
            const msg = String(err?.message ?? err);
            setStatus('err', msg);
            isConnecting = false;
            btnHost.disabled = false;
            btnJoin.disabled = false;
            const isRelayOffline = msg.includes('offline') || msg.includes('Failed to fetch') || msg.includes('refused');
            if (isRelayOffline) {
                landingErrorBanner.style.display = 'flex';
                landingErrorBanner.innerHTML = `⚠️ <strong>Relay Server is unreachable</strong>. If waking up from cold sleep on Render, please retry in a few seconds.`;
            }
            if (requestedRoomCode) {
                joinHint.textContent = `Failed: ${msg}`;
                joinHint.style.color = '#ef4444';
            }
            else {
                hostHint.textContent = `Failed: ${msg}`;
                hostHint.style.color = '#ef4444';
            }
        }
    }
    // ---------- Landing Actions: Host & Join ----------
    // 1. HOST ACTION WITH NAME VALIDATION
    btnHost.addEventListener('click', () => {
        const hostName = hostNameInput.value.trim() || displayName.value.trim();
        if (!hostName) {
            hostNameInput.classList.add('input-error');
            hostNameInput.focus();
            hostHint.textContent = 'Please enter your name before hosting!';
            hostHint.style.color = '#f59e0b';
            return;
        }
        startCallSession(null);
    });
    hostNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            btnHost.click();
        }
    });
    // 2. JOIN ACTION WITH PROMPT FOR NAME
    function validateAndTriggerJoin() {
        const guestName = joinNameInput.value.trim() || displayName.value.trim();
        if (!guestName) {
            joinNameInput.classList.add('input-error');
            joinNameInput.focus();
            joinHint.textContent = '⚠️ Please enter your name first so the host knows who joined!';
            joinHint.style.color = '#f59e0b';
            return;
        }
        const raw = roomCodeInput.value.trim().toUpperCase();
        if (raw.length === 6) {
            startCallSession(raw);
        }
        else {
            roomCodeInput.focus();
            joinHint.textContent = 'Please enter a valid 6-character room code';
            joinHint.style.color = '#f59e0b';
        }
    }
    btnJoin.addEventListener('click', validateAndTriggerJoin);
    // 3. AUTO-START CALL ON ENTERING 6 CHARACTERS (CHECKS NAME FIRST)
    roomCodeInput.addEventListener('input', () => {
        // Sanitize to alphanumeric uppercase only
        const clean = roomCodeInput.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        roomCodeInput.value = clean;
        if (clean.length === 6) {
            const guestName = joinNameInput.value.trim() || displayName.value.trim();
            if (!guestName) {
                joinNameInput.classList.add('input-error');
                joinNameInput.focus();
                joinHint.textContent = '⚠️ Please enter your name so the host knows who joined!';
                joinHint.style.color = '#f59e0b';
                return;
            }
            joinHint.textContent = `Connecting to room ${clean}…`;
            joinHint.style.color = '#60a5fa';
            startCallSession(clean);
        }
        else if (clean.length > 0) {
            joinHint.textContent = `${6 - clean.length} more character${6 - clean.length === 1 ? '' : 's'}…`;
            joinHint.style.color = '';
        }
        else {
            joinHint.textContent = 'Auto-connects when 6-char code is entered';
            joinHint.style.color = '';
        }
    });
    roomCodeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            validateAndTriggerJoin();
        }
    });
    joinNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            if (roomCodeInput.value.trim().length === 6) {
                validateAndTriggerJoin();
            }
            else {
                roomCodeInput.focus();
            }
        }
    });
    // 3b. NATIVE PASTE (Ctrl+V) WITH AUTO-EXTRACT
    roomCodeInput.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = e.clipboardData?.getData('text') || '';
        const match = pasted.match(/\b([A-Za-z0-9]{6})\b/);
        const code = match ? match[1].toUpperCase() : pasted.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
        if (code) {
            roomCodeInput.value = code;
            roomCodeInput.dispatchEvent(new Event('input'));
        }
    });
    // 4. PASTE BUTTON WITH AUTO-EXTRACT
    btnPasteCode.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            const match = text.match(/\b([A-Za-z0-9]{6})\b/);
            const code = match ? match[1].toUpperCase() : text.trim().slice(0, 6).toUpperCase();
            if (code) {
                roomCodeInput.value = code;
                roomCodeInput.dispatchEvent(new Event('input'));
            }
        }
        catch (e) {
            console.warn('Clipboard read failed:', e);
            roomCodeInput.focus();
        }
    });
    // ---------- In-Call Banner Actions ----------
    let toastTimer = null;
    function showCopyFeedback(msg) {
        if (toastTimer)
            clearTimeout(toastTimer);
        copyToast.textContent = msg;
        toastTimer = setTimeout(() => {
            copyToast.textContent = '';
        }, 2200);
    }
    btnCopyCode.addEventListener('click', async () => {
        if (!currentRoom)
            return;
        try {
            await navigator.clipboard.writeText(currentRoom);
            showCopyFeedback('Code copied! 📋');
        }
        catch {
            showCopyFeedback(currentRoom);
        }
    });
    btnCopyInvite.addEventListener('click', async () => {
        if (!currentRoom)
            return;
        const invite = `Join my 1:1 Ollalink voice translation call! Room code: ${currentRoom}`;
        try {
            await navigator.clipboard.writeText(invite);
            showCopyFeedback('Invite copied! ✉️');
        }
        catch {
            showCopyFeedback(currentRoom);
        }
    });
    btnEnd.addEventListener('click', async () => {
        btnEnd.disabled = true;
        try {
            await controller.endCall();
        }
        finally {
            btnEnd.disabled = false;
            switchToLandingView();
        }
    });
    // ---------- In-Call Controls ----------
    const setVolumeDebounced = debounce(async (v) => {
        try {
            await invoke('set_input_volume', { volume: v });
        }
        catch (e) {
            console.warn(e);
        }
    }, 60);
    inputGain.addEventListener('input', () => {
        const v = parseFloat(inputGain.value);
        gainReadout.textContent = v.toFixed(2);
        setVolumeDebounced(v);
    });
    midcallCaptionsOn.addEventListener('change', async () => {
        if (controller.isActive()) {
            try {
                await controller.setCaptions(midcallCaptionsOn.checked);
            }
            catch (e) {
                console.warn('setCaptions:', e);
            }
        }
        captionsOn.checked = midcallCaptionsOn.checked;
        persistPrefs();
    });
    midcallSourceLang.addEventListener('change', async () => {
        sourceLang.value = midcallSourceLang.value;
        if (controller.isActive()) {
            try {
                await controller.changeLanguages(midcallSourceLang.value, undefined);
            }
            catch (e) {
                console.warn('changeLanguages:', e);
            }
        }
        persistPrefs();
    });
    midcallVoicePersona.addEventListener('change', async () => {
        voicePersona.value = midcallVoicePersona.value;
        if (controller.isActive()) {
            try {
                await controller.updateVoiceSettings(midcallVoicePersona.value, midcallVoiceTone.value);
            }
            catch (e) {
                console.warn('updateVoiceSettings:', e);
            }
        }
        persistPrefs();
    });
    midcallVoiceTone.addEventListener('change', async () => {
        voiceTone.value = midcallVoiceTone.value;
        if (controller.isActive()) {
            try {
                await controller.updateVoiceSettings(midcallVoicePersona.value, midcallVoiceTone.value);
            }
            catch (e) {
                console.warn('updateVoiceSettings:', e);
            }
        }
        persistPrefs();
    });
    midcallTargetLang.addEventListener('change', async () => {
        targetLang.value = midcallTargetLang.value;
        if (controller.isActive()) {
            try {
                await controller.changeLanguages(undefined, midcallTargetLang.value);
            }
            catch (e) {
                console.warn('changeLanguages:', e);
            }
        }
        persistPrefs();
    });
    // ---------- Tauri & Relay Subscriptions ----------
    const unlistens = [];
    unlistens.push(await listen('call-state', (e) => {
        const s = e.payload;
        if (s === 'active')
            setStatus('active', connStatus.textContent ?? 'active');
        else if (s === 'failed')
            setStatus('err', 'failed');
        else
            setStatus('idle', s);
    }));
    unlistens.push(await listen('vu-meter', (e) => {
        const pct = Math.min(100, e.payload * 100);
        vuFill.style.width = `${pct.toFixed(1)}%`;
    }));
    unlistens.push(await listen('relay-event', (e) => handleRelayEvent(e.payload)));
    unlistens.push(await listen('relay-error', (e) => setStatus('err', e.payload)));
    unlistens.push(await listen('audio-error', (e) => setStatus('err', e.payload)));
    unlistens.push(await listen('call-error', (e) => {
        console.error('call-error:', e.payload);
        const msg = e.payload?.message ?? 'error';
        setStatus('err', msg);
        if (isConnecting) {
            isConnecting = false;
            btnHost.disabled = false;
            btnJoin.disabled = false;
            joinHint.textContent = 'Failed: ' + msg;
            joinHint.style.color = '#ef4444';
        }
    }));
    unlistens.push(await listen('relay-reconnecting', (e) => {
        setStatus('busy', `reconnecting… attempt ${e.payload?.attempt ?? '?'}`);
    }));
    unlistens.push(await listen('relay-reconnected', () => {
        setStatus('active', 'reconnected');
    }));
    unlistens.push(await listen('relay-closed', () => {
        if (controller.isActive())
            setStatus('busy', 'connection lost — retrying');
    }));
    unlistens.push(await listen('session-expiring', () => {
        captions.addSystem('session expiring soon — refreshing…');
    }));
    unlistens.push(await listen('session-refreshed', () => {
        captions.addSystem('session renewed');
    }));
    unlistens.push(await listen('device-swapped', (e) => {
        captions.addSystem(`${e.payload?.kind} device changed`);
    }));
    unlistens.push(await listen('call-ended', () => {
        switchToLandingView();
    }));
    function handleRelayEvent(ev) {
        switch (ev?.type) {
            case 'joined': {
                const participants = ev.participants ?? [];
                participantNames.clear();
                for (const p of participants) {
                    if (p?.sessionId)
                        participantNames.set(p.sessionId, p.displayName || 'Partner');
                }
                const myChosenName = (isCurrentCallHost ? hostNameInput.value : joinNameInput.value).trim() || displayName.value || 'You';
                if (ev.self?.sessionId) {
                    participantNames.set(ev.self.sessionId, `${myChosenName} (You)`);
                }
                renderParticipants(participants, ev.self?.sessionId);
                captions.addSystem(`joined room ${ev.room}`);
                // Check if there's already a peer in the room
                const peer = participants.find((p) => p.sessionId !== ev.self?.sessionId);
                if (peer) {
                    currentPeerInfo = {
                        name: peer.displayName || 'Partner',
                        sourceLang: peer.sourceLang,
                        targetLang: peer.targetLang,
                    };
                    setConnectedPeerStatus(currentPeerInfo.name, currentPeerInfo.sourceLang, currentPeerInfo.targetLang);
                }
                else {
                    currentPeerInfo = null;
                    if (isCurrentCallHost) {
                        setWaitingPeerStatus();
                    }
                    else {
                        setJoinedGuestStatus();
                    }
                }
                break;
            }
            case 'peer-joined': {
                const peer = ev.peer;
                if (peer?.sessionId) {
                    participantNames.set(peer.sessionId, peer.displayName || 'Partner');
                }
                currentPeerInfo = {
                    name: peer?.displayName || 'Partner',
                    sourceLang: peer?.sourceLang,
                    targetLang: peer?.targetLang,
                };
                captions.addSystem(`${currentPeerInfo.name} joined`);
                addParticipant(peer);
                setConnectedPeerStatus(currentPeerInfo.name, currentPeerInfo.sourceLang, currentPeerInfo.targetLang);
                break;
            }
            case 'peer-left': {
                const leftName = (ev.sessionId && participantNames.get(ev.sessionId)) || 'Partner';
                captions.addSystem(`${leftName} left the room`);
                if (ev.sessionId)
                    participantNames.delete(ev.sessionId);
                removeParticipant(ev.sessionId);
                currentPeerInfo = null;
                if (isCurrentCallHost) {
                    setWaitingPeerStatus();
                }
                else {
                    peerStatusBox.className = 'peer-status-box waiting';
                    peerStatusText.textContent = `Host left the room. Waiting for host to reconnect or share room code: ${currentRoom}`;
                }
                break;
            }
            case 'caption':
                if (ev && typeof ev === 'object') {
                    try {
                        const senderDisplayName = participantNames.get(ev.from);
                        captions.add(ev, senderDisplayName);
                    }
                    catch (e) {
                        console.warn('caption failed:', e);
                    }
                }
                break;
            case 'pong':
                break;
            case 'error':
                setStatus('err', `${ev.code}: ${ev.message}`);
                break;
            default:
                console.debug('unhandled relay-event', ev);
        }
    }
    function renderParticipants(list, selfId) {
        participantsUl.innerHTML = '';
        for (const p of list)
            appendParticipant(p, p.sessionId === selfId);
    }
    function appendParticipant(p, isMe = false) {
        if (!p)
            return;
        const li = document.createElement('li');
        if (isMe)
            li.classList.add('me');
        li.dataset.sessionId = String(p.sessionId ?? '');
        const nameDiv = document.createElement('div');
        nameDiv.className = 'p-name';
        nameDiv.textContent = `${p.displayName ?? 'anon'}${isMe ? ' (You)' : ''}`;
        const langDiv = document.createElement('div');
        langDiv.className = 'p-langs';
        langDiv.textContent = `Speaks: ${p.sourceLang ?? 'auto'} ➔ Hears: ${p.targetLang ?? 'en'}`;
        li.appendChild(nameDiv);
        li.appendChild(langDiv);
        participantsUl.appendChild(li);
    }
    const addParticipant = (p) => appendParticipant(p, p?.sessionId === selfSessionId);
    function removeParticipant(sessionId) {
        const el = participantsUl.querySelector(`li[data-session-id="${sessionId}"]`);
        if (el)
            el.remove();
    }
    function setStatus(kind, text) {
        connStatus.textContent = text;
        connStatus.className = `pill pill-${kind}`;
    }
}
function debounce(fn, ms) {
    let timer = null;
    return ((...args) => {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    });
}
window.addEventListener('DOMContentLoaded', () => {
    main().catch((err) => {
        console.error('bootstrap failed:', err);
        document.body.innerHTML = `
      <pre style="padding:20px;color:#ff5c5c;background:#111;">
Bootstrap failed:
${String(err?.stack ?? err)}
      </pre>`;
    });
});
