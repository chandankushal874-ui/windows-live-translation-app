/**
 * main.ts — UI bootstrap, dual-mode Landing & In-Call flow, instant 1:1 join.
 */
import { invoke, listen, isNativeTauri } from './bridge';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { CallController } from './call';
import { CaptionsView } from './captions';

interface AudioDeviceList {
  inputs: string[];
  outputs: string[];
  default_input?: string | null;
  default_output?: string | null;
}

interface SessionCredentials {
  token: string;
  wsUrl: string;
  expiresAt: number;
  sessionId: string;
}

interface UserPrefs {
  version: number;
  displayName: string;
  relayUrl: string;
  sourceLang: string;
  targetLang: string;
  voicePersona?: string;
  voiceTone?: string;
  inputDevice: string | null;
  outputDevice: string | null;
  inputVolume: number;
}

interface PeerInfo {
  name: string;
  sourceLang?: string;
  targetLang?: string;
}

async function main() {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el as T;
  };

  // ---------- DOM Elements ----------
  // Views
  const landingView = $('landing-view');
  const callView = $('call-view');

  // Header & Status
  const connStatus = $('conn-status');

  // Landing Setup
  const displayName = $<HTMLInputElement>('display-name');
  const sourceLang = $<HTMLSelectElement>('source-lang');
  const targetLang = $<HTMLSelectElement>('target-lang');
  const voicePersona = $<HTMLSelectElement>('voice-persona');
  const voiceTone = $<HTMLSelectElement>('voice-tone');
  const inputDevice = $<HTMLSelectElement>('input-device');
  const outputDevice = $<HTMLSelectElement>('output-device');
  const relayUrl = $<HTMLInputElement>('relay-url');
  const captionsOn = $<HTMLInputElement>('captions-on');

  // Hero Actions & Dedicated Name Inputs
  const hostNameInput = $<HTMLInputElement>('host-name-input');
  const joinNameInput = $<HTMLInputElement>('join-name-input');
  const btnHost = $<HTMLButtonElement>('btn-host');
  const btnJoin = $<HTMLButtonElement>('btn-join');
  const roomCodeInput = $<HTMLInputElement>('room-code-input');
  const btnPasteCode = $<HTMLButtonElement>('btn-paste-code');
  const joinHint = $('join-hint');
  const hostHint = $('host-hint');
  const landingErrorBanner = $('landing-error-banner');

  // In-Call View Elements
  const activeRoomDisplay = $('active-room-display');
  const btnCopyCode = $<HTMLButtonElement>('btn-copy-code');
  const btnCopyInvite = $<HTMLButtonElement>('btn-copy-invite');
  const copyToast = $('copy-toast');
  const btnEnd = $<HTMLButtonElement>('btn-end');
  const peerStatusBox = $('peer-status-box');
  const peerStatusText = $('peer-status-text');

  // Mid-Call Controls
  const midcallSourceLang = $<HTMLSelectElement>('midcall-source-lang');
  const midcallTargetLang = $<HTMLSelectElement>('midcall-target-lang');
  const midcallVoicePersona = $<HTMLSelectElement>('midcall-voice-persona');
  const midcallVoiceTone = $<HTMLSelectElement>('midcall-voice-tone');
  const midcallCaptionsOn = document.getElementById('midcall-captions-on') as HTMLInputElement | null;
  const inputGain = $<HTMLInputElement>('input-gain');
  const gainReadout = $('gain-readout');
  const vuFill = $('vu-fill');
  const participantsUl = $('participants');
  const captionsScroll = document.getElementById('captions-scroll');
  // Neural Voice Stream Visualizer Elements
  const outboundWaveform = document.getElementById('outbound-waveform');
  const inboundWaveform = document.getElementById('inbound-waveform');
  const outboundVadBadge = document.getElementById('outbound-vad-badge');
  const inboundVadBadge = document.getElementById('inbound-vad-badge');
  const abrStatusPill = document.getElementById('abr-status-pill');
  const abrStatusText = document.getElementById('abr-status-text');
  const abrLatencyText = document.getElementById('abr-latency-text');
  const statLatency = document.getElementById('stat-latency');
  const statVad = document.getElementById('stat-vad');
  const outboundLangLabel = document.getElementById('outbound-lang-label');
  const inboundLangLabel = document.getElementById('inbound-lang-label');

  // Voice Reconfiguration Loader Helper
  const voiceSwitchLoader = document.getElementById('voice-switch-loader');
  const voiceSwitchText = document.getElementById('voice-switch-text');

  function showVoiceUpdating(msg: string = 'Updating Neural Voice...') {
    if (voiceSwitchLoader && voiceSwitchText) {
      voiceSwitchLoader.className = 'voice-switch-loader';
      voiceSwitchText.textContent = msg;
      voiceSwitchLoader.style.display = 'inline-flex';
    }
  }

  function showVoiceUpdated(msg: string = 'Voice Ready') {
    if (voiceSwitchLoader && voiceSwitchText) {
      voiceSwitchLoader.className = 'voice-switch-loader ready';
      voiceSwitchText.textContent = `✅ ${msg}`;
      setTimeout(() => {
        if (voiceSwitchLoader.classList.contains('ready')) {
          voiceSwitchLoader.style.display = 'none';
        }
      }, 1800);
    }
  }

  // Call Role and State Tracking
  let isCurrentCallHost = false;
  let currentRoom = '';
  let selfSessionId = '';
  let isConnecting = false;
  let currentPeerInfo: PeerInfo | null = null;
  const participantNames = new Map<string, string>();

  // Default initial random username
  const defaultRandomName = `user-${Math.random().toString(36).slice(2, 6)}`;
  displayName.value = defaultRandomName;
  hostNameInput.value = defaultRandomName;
  joinNameInput.value = ''; // Leave guest empty so user explicitly types their name

  if (!isNativeTauri) {
    console.info('[Browser Preview] Running outside Tauri desktop wrapper. Direct Relay bridge enabled.');
    setStatus('idle', 'idle (browser)');
    relayUrl.value = window.location.origin;
  }

  // ---------- Load persisted preferences ----------
  try {
    const prefs = await invoke<UserPrefs>('load_prefs');
    if (prefs.displayName) {
      displayName.value = prefs.displayName;
      hostNameInput.value = prefs.displayName;
      joinNameInput.value = prefs.displayName;
    }
    if (!isNativeTauri) {
      relayUrl.value = window.location.origin;
    } else if (prefs.relayUrl && !prefs.relayUrl.includes('localhost') && !prefs.relayUrl.includes('127.0.0.1')) {
      relayUrl.value = prefs.relayUrl;
    } else {
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
    (window as any).__pendingPrefDevices = {
      input: prefs.inputDevice,
      output: prefs.outputDevice,
    };
  } catch (err) {
    console.warn('load_prefs failed (using defaults):', err);
  }

  const captions = new CaptionsView(captionsScroll);
  const controller = new CallController(invoke, listen);

  // ---------- Relay Health Monitor ----------
  async function probeRelayHealth() {
    if (controller.isActive() || isConnecting) return;
    const base = relayUrl.value.replace(/^ws(s)?:/, 'http$1:').replace(/\/call\/?$/, '');
    try {
      let isOk = false;
      if (isNativeTauri) {
        try {
          isOk = await invoke<boolean>('check_relay_health', { relayUrl: base });
        } catch {
          isOk = false;
        }
      }
      if (!isOk) {
        const fetchUrl = (!isNativeTauri && (base.includes('onrender.com') || base.includes('localhost:1420'))) ? '/api/health' : `${base}/api/health`;
        const res = await fetch(fetchUrl, { method: 'GET', signal: AbortSignal.timeout(6000) });
        isOk = res.ok;
      }

      if (isOk) {
        landingErrorBanner.style.display = 'none';
        if (!controller.isActive() && !isConnecting) {
          setStatus('idle', '🟢 relay online');
        }
      } else {
        showRelayOfflineWarning(base);
      }
    } catch {
      showRelayOfflineWarning(base);
    }
  }

  function showRelayOfflineWarning(base: string) {
    if (controller.isActive() || isConnecting) return;
    setStatus('err', '🔴 relay offline');
    landingErrorBanner.style.display = 'flex';
    landingErrorBanner.innerHTML = `⚠️ <strong>Relay Server is unreachable</strong> at <code>${base}</code>.<br><span style="font-size:12px;opacity:0.85;">If waking up from cold sleep on Render, please wait ~20s.</span>`;
  }

  probeRelayHealth();
  setInterval(probeRelayHealth, 4000);

  // ---------- Microphone Discovery & Hardware Enumeration ----------
  const btnDiscoverMic = $<HTMLButtonElement>('btn-discover-mic');
  const micStatusDot = $('mic-status-dot');
  const micStatusLabel = $('mic-status-label');

  async function discoverAndTestMicrophones() {
    if (btnDiscoverMic) btnDiscoverMic.textContent = '⏳ Discovering...';
    try {
      if (!isNativeTauri && navigator?.mediaDevices?.getUserMedia) {
        // Request explicit permission so mobile browsers pop the permission dialog
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      }
      const devices = await invoke<AudioDeviceList>('list_audio_devices');
      for (const sel of [inputDevice, outputDevice]) sel.innerHTML = '';
      for (const name of devices.inputs) {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        inputDevice.appendChild(opt);
      }
      for (const name of devices.outputs) {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        outputDevice.appendChild(opt);
      }
      if (devices.default_input) inputDevice.value = devices.default_input;
      if (devices.default_output) outputDevice.value = devices.default_output;

      if (micStatusDot) micStatusDot.style.background = '#10b981';
      if (micStatusLabel) {
        micStatusLabel.textContent = `✅ Microphone Ready: ${devices.inputs[0] || 'Default'}`;
        micStatusLabel.style.color = '#34d399';
      }
      if (btnDiscoverMic) {
        btnDiscoverMic.textContent = '✅ Discovered';
        btnDiscoverMic.style.background = '#059669';
      }
    } catch (err: any) {
      console.warn('Microphone discovery failed:', err);
      if (micStatusDot) micStatusDot.style.background = '#ef4444';
      if (micStatusLabel) {
        micStatusLabel.textContent = '❌ Microphone access denied or not found';
        micStatusLabel.style.color = '#f87171';
      }
      if (btnDiscoverMic) {
        btnDiscoverMic.textContent = '⚠️ Retry Mic';
        btnDiscoverMic.style.background = '#dc2626';
      }
    }
  }

  if (btnDiscoverMic) {
    btnDiscoverMic.addEventListener('click', discoverAndTestMicrophones);
  }

  // ---------- Audio Devices ----------
  try {
    const devices = await invoke<AudioDeviceList>('list_audio_devices');
    for (const sel of [inputDevice, outputDevice]) sel.innerHTML = '';
    for (const name of devices.inputs) {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      inputDevice.appendChild(opt);
    }
    for (const name of devices.outputs) {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      outputDevice.appendChild(opt);
    }
    if (devices.default_input) inputDevice.value = devices.default_input;
    if (devices.default_output) outputDevice.value = devices.default_output;

    const pending = (window as any).__pendingPrefDevices;
    if (pending) {
      if (pending.input && devices.inputs.includes(pending.input)) inputDevice.value = pending.input;
      if (pending.output && devices.outputs.includes(pending.output)) outputDevice.value = pending.output;
      delete (window as any).__pendingPrefDevices;
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
  } catch (err) {
    console.warn('list_audio_devices failed:', err);
  }

  // ---------- Sync Preferences & Name Inputs ----------
  const persistPrefs = debounce(async () => {
    const prefs: UserPrefs = {
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
    try { await invoke('save_prefs', { prefs }); } catch (e) { console.warn('save_prefs:', e); }
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
  function switchToCallView(room: string, isHost: boolean) {
    updateDiagLangPill();
    currentRoom = room;
    isCurrentCallHost = isHost;
    activeRoomDisplay.textContent = room;
    landingView.style.display = 'none';
    callView.style.display = 'flex';

    if (isHost) {
      setWaitingPeerStatus();
    } else {
      if (currentPeerInfo) {
        setConnectedPeerStatus(currentPeerInfo.name, currentPeerInfo.sourceLang, currentPeerInfo.targetLang);
      } else {
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

  function setConnectedPeerStatus(peerName: string, sourceLangCode?: string, targetLangCode?: string) {
    peerStatusBox.className = 'peer-status-box connected';
    const langInfo = sourceLangCode && targetLangCode ? ` (${sourceLangCode} ➔ ${targetLangCode})` : '';
    if (isCurrentCallHost) {
      peerStatusText.textContent = `🟢 Partner ${peerName} joined! In 1:1 call${langInfo}`;
    } else {
      peerStatusText.textContent = `🟢 Successfully joined room ${currentRoom}! In 1:1 call with ${peerName}${langInfo}`;
    }
    if (outboundLangLabel) outboundLangLabel.textContent = `Speaking: ${sourceLang.value.toUpperCase()}`;
    if (inboundLangLabel) inboundLangLabel.textContent = `Hearing: ${targetLang.value.toUpperCase()} (Translated)`;
  }

  async function startCallSession(requestedRoomCode: string | null) {
    if (isConnecting || controller.isActive()) return;
    isConnecting = true;
    btnHost.disabled = true;
    btnJoin.disabled = true;

    const isHost = !requestedRoomCode;
    isCurrentCallHost = isHost;

    const chosenName = (isHost ? hostNameInput.value : joinNameInput.value).trim() || displayName.value.trim() || (isHost ? 'Host' : 'Guest');
    displayName.value = chosenName;

    setStatus('busy', requestedRoomCode ? `joining ${requestedRoomCode}…` : 'hosting room…');

    try {
      const creds = await invoke<SessionCredentials>('mint_session', {
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
    } catch (err: any) {
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
      } else {
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
    } else {
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
    } else if (clean.length > 0) {
      joinHint.textContent = `${6 - clean.length} more character${6 - clean.length === 1 ? '' : 's'}…`;
      joinHint.style.color = '';
    } else {
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
      } else {
        roomCodeInput.focus();
      }
    }
  });

  // 3b. NATIVE PASTE (Ctrl+V) WITH AUTO-EXTRACT
  roomCodeInput.addEventListener('paste', (e: ClipboardEvent) => {
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
    } catch (e) {
      console.warn('Clipboard read failed:', e);
      roomCodeInput.focus();
    }
  });

  // ---------- In-Call Banner Actions ----------
  let toastTimer: any = null;
  function showCopyFeedback(msg: string) {
    if (toastTimer) clearTimeout(toastTimer);
    copyToast.textContent = msg;
    toastTimer = setTimeout(() => {
      copyToast.textContent = '';
    }, 2200);
  }

  btnCopyCode.addEventListener('click', async () => {
    if (!currentRoom) return;
    try {
      await navigator.clipboard.writeText(currentRoom);
      showCopyFeedback('Code copied! 📋');
    } catch {
      showCopyFeedback(currentRoom);
    }
  });

  btnCopyInvite.addEventListener('click', async () => {
    if (!currentRoom) return;
    const invite = `Join my 1:1 Ollalink voice translation call! Room code: ${currentRoom}`;
    try {
      await navigator.clipboard.writeText(invite);
      showCopyFeedback('Invite copied! ✉️');
    } catch {
      showCopyFeedback(currentRoom);
    }
  });

  btnEnd.addEventListener('click', async () => {
    btnEnd.disabled = true;
    try {
      await controller.endCall();
    } finally {
      btnEnd.disabled = false;
      switchToLandingView();
    }
  });

  // ---------- In-Call Controls ----------
  const setVolumeDebounced = debounce(async (v: number) => {
    try { await invoke('set_input_volume', { volume: v }); } catch (e) { console.warn(e); }
  }, 60);

  inputGain.addEventListener('input', () => {
    const v = parseFloat(inputGain.value);
    gainReadout.textContent = v.toFixed(2);
    setVolumeDebounced(v);
  });

  if (midcallCaptionsOn) {
    midcallCaptionsOn.addEventListener('change', async () => {
      if (controller.isActive()) {
        try { await controller.setCaptions(midcallCaptionsOn.checked); }
        catch (e) { console.warn('setCaptions:', e); }
      }
      captionsOn.checked = midcallCaptionsOn.checked;
      persistPrefs();
    });
  }

  midcallSourceLang.addEventListener('change', async () => {
    sourceLang.value = midcallSourceLang.value;
    showVoiceUpdating('Reconfiguring Speech Recognition...');
    if (controller.isActive()) {
      try { await controller.changeLanguages(midcallSourceLang.value, undefined); }
      catch (e) { console.warn('changeLanguages:', e); }
    }
    persistPrefs();
  });

  midcallVoicePersona.addEventListener('change', async () => {
    voicePersona.value = midcallVoicePersona.value;
    showVoiceUpdating('Switching Neural Voice Persona...');
    if (controller.isActive()) {
      try {
        await controller.updateVoiceSettings(midcallVoicePersona.value, midcallVoiceTone.value);
        showVoiceUpdated('Voice Persona Applied');
      } catch (e) {
        console.warn('updateVoiceSettings:', e);
        showVoiceUpdated('Voice Ready');
      }
    } else {
      showVoiceUpdated('Voice Persona Selected');
    }
    persistPrefs();
  });

  midcallVoiceTone.addEventListener('change', async () => {
    voiceTone.value = midcallVoiceTone.value;
    showVoiceUpdating('Applying Delivery Tone...');
    if (controller.isActive()) {
      try {
        await controller.updateVoiceSettings(midcallVoicePersona.value, midcallVoiceTone.value);
        showVoiceUpdated('Delivery Tone Applied');
      } catch (e) {
        console.warn('updateVoiceSettings:', e);
        showVoiceUpdated('Voice Ready');
      }
    } else {
      showVoiceUpdated('Delivery Tone Selected');
    }
    persistPrefs();
  });

  midcallTargetLang.addEventListener('change', async () => {
    targetLang.value = midcallTargetLang.value;
    showVoiceUpdating('Re-routing Target Language Lane...');
    updateDiagLangPill();
    resetPipelineStageBoxes();
    applyDiagnosis('idle', 'LANG CHANGED', `Switched to ${midcallSourceLang.value.toUpperCase()} ➔ ${midcallTargetLang.value.toUpperCase()}. Ready for speech trace.`);
    if (controller.isActive()) {
      try {
        await controller.changeLanguages(undefined, midcallTargetLang.value);
        showVoiceUpdated('Language Lane Re-routed');
      } catch (e) {
        console.warn('changeLanguages:', e);
        showVoiceUpdated('Language Lane Ready');
      }
    } else {
      showVoiceUpdated('Target Language Set');
    }
    persistPrefs();
  });

  // ---------- Tauri & Relay Subscriptions ----------
  const unlistens: UnlistenFn[] = [];
  unlistens.push(await listen<string>('call-state', (e) => {
    const s = e.payload;
    if (s === 'active') setStatus('active', connStatus.textContent ?? 'active');
    else if (s === 'failed') setStatus('err', 'failed');
    else setStatus('idle', s);
  }));

  unlistens.push(await listen<number>('vu-meter', (e) => {
    const peak = e.payload;
    const pct = Math.min(100, peak * 100);
    vuFill.style.width = `${pct.toFixed(1)}%`;
    if (pct > 80) vuFill.style.background = 'var(--err)';
    else if (pct > 50) vuFill.style.background = 'var(--warn)';
    else vuFill.style.background = 'var(--ok)';

    if (outboundWaveform) {
      const bars = outboundWaveform.querySelectorAll<HTMLElement>('.bar');
      if (peak >= 0.015) {
        const amp = Math.min(1.0, Math.sqrt(peak) * 1.85);
        bars.forEach((bar, idx) => {
          const factor = Math.sin((idx + 1) * 0.75) * 0.45 + 0.55;
          const height = Math.max(6, Math.min(48, Math.round(amp * 42 * factor + 6)));
          bar.style.height = `${height}px`;
        });
      } else {
        // Listening / idle mode: gentle breathing wave
        const t = Date.now() / 320;
        bars.forEach((bar, idx) => {
          const wave = Math.sin(t + idx * 0.55) * 2.5 + 6.5;
          bar.style.height = `${Math.round(wave)}px`;
        });
      }
    }
  }));

  unlistens.push(await listen<{ speaking: boolean; rms: number }>('vad-state', (e) => {
    const { speaking } = e.payload;
    if (outboundVadBadge) {
      outboundVadBadge.className = speaking ? 'activity-badge speaking' : 'activity-badge idle';
      outboundVadBadge.textContent = speaking ? '⚡ Speaking' : '🎙️ Listening';
    }
    if (statVad) {
      statVad.textContent = speaking ? 'Speaking (Live Audio)' : 'Active (350ms Pause)';
    }
  }));

  unlistens.push(await listen<number>('inbound-audio-energy', (e) => {
    const peak = e.payload;
    if (inboundWaveform) {
      const bars = inboundWaveform.querySelectorAll<HTMLElement>('.bar');
      if (peak >= 0.012) {
        const amp = Math.min(1.0, Math.sqrt(peak) * 2.1);
        bars.forEach((bar, idx) => {
          const factor = Math.cos((idx + 2) * 0.7) * 0.45 + 0.55;
          const height = Math.max(6, Math.min(48, Math.round(amp * 42 * factor + 6)));
          bar.style.height = `${height}px`;
        });
      } else {
        bars.forEach((bar) => { bar.style.height = '4px'; });
      }
    }
    if (inboundVadBadge) {
      if (peak > 0.015) {
        inboundVadBadge.className = 'activity-badge translating';
        inboundVadBadge.textContent = '🔊 Translating';
      } else {
        inboundVadBadge.className = 'activity-badge idle';
        inboundVadBadge.textContent = 'Connected';
      }
    }
  }));

  unlistens.push(await listen<{ rttMs: number; congested: boolean; mode: string }>('abr-metrics', (e) => {
    const { rttMs, congested, mode } = e.payload;
    if (abrStatusText) abrStatusText.textContent = mode;
    if (abrLatencyText) {
      abrLatencyText.textContent = `${rttMs}ms`;
      abrLatencyText.style.color = congested ? '#f59e0b' : 'var(--ok)';
    }
    if (abrStatusPill) {
      const ind = abrStatusPill.querySelector('.abr-indicator');
      if (ind) ind.className = `abr-indicator ${congested ? 'congested' : 'optimal'}`;
    }
    if (statLatency) {
      statLatency.textContent = `${rttMs}ms (${congested ? 'Buffered' : 'Ultra-Low'})`;
    }
  }));

  unlistens.push(await listen<any>('pipeline-checkpoint', (e) => handlePipelineCheckpoint(e.payload)));
  unlistens.push(await listen<any>('audio-stream-stats', (e) => {
    const { chunks, bytes, jitterMs, intervalMs, isAudioComing } = e.payload || {};
    if (stageRecvSub && isAudioComing) {
      stageRecvSub.textContent = `Audio Active (${chunks} chunks / ${Math.round(bytes / 1024)} KB)`;
    }
    if (stagePlaySub && !stagePlaySub.textContent?.includes('Buffer Underrun')) {
      stagePlaySub.textContent = `Jitter: ${jitterMs}ms (${intervalMs}ms spacing)`;
    }
    const statLatency = document.getElementById('stat-latency');
    if (statLatency && isAudioComing) {
      statLatency.textContent = `Pacing: ${intervalMs}ms | Jitter: ${jitterMs}ms`;
    }
  }));
  unlistens.push(await listen<any>('relay-event', (e) => handleRelayEvent(e.payload)));
  unlistens.push(await listen<string>('relay-error', (e) => setStatus('err', e.payload)));
  unlistens.push(await listen<string>('audio-error', (e) => setStatus('err', e.payload)));
  unlistens.push(await listen<any>('audio-device-lost', async (e) => {
    const kind = e.payload?.kind || 'device';
    console.warn(`[audio-device-lost] ${kind} disconnected:`, e.payload?.error);
    setStatus('busy', `Audio ${kind} unplugged — auto-switching to default...`);
    setTimeout(async () => {
      try {
        if (kind === 'input') {
          await invoke('swap_input_device', { name: null });
        } else if (kind === 'output') {
          await invoke('swap_output_device', { name: null });
        }
      } catch (err: any) {
        console.warn(`Auto-recovery fallback failed for ${kind}:`, err);
      }
    }, 600);
  }));
  unlistens.push(await listen<any>('device-swapped', (e) => {
    const kind = e.payload?.kind || 'device';
    const name = e.payload?.name || 'Default';
    setStatus('active', `Active ${kind}: ${name}`);
  }));
  unlistens.push(await listen<any>('call-error', (e) => {
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

  unlistens.push(await listen<any>('relay-reconnecting', (e) => {
    setStatus('busy', `reconnecting… attempt ${e.payload?.attempt ?? '?'}`);
  }));
  unlistens.push(await listen<any>('relay-reconnected', () => {
    setStatus('active', 'reconnected');
  }));
  unlistens.push(await listen<any>('relay-closed', () => {
    if (controller.isActive()) setStatus('busy', 'connection lost — retrying');
  }));

  unlistens.push(await listen<any>('session-expiring', () => {
    captions.addSystem('session expiring soon — refreshing…');
  }));
  unlistens.push(await listen<any>('session-refreshed', () => {
    captions.addSystem('session renewed');
  }));
  unlistens.push(await listen<any>('device-swapped', (e) => {
    captions.addSystem(`${e.payload?.kind} device changed`);
  }));
  unlistens.push(await listen<any>('call-ended', () => {
    switchToLandingView();
  }));


  // ---------- Pipeline Latency & 4s Watchdog Diagnostics Controller ----------
  const diagWatchdogBadge = document.getElementById('diag-watchdog-badge');
  const diagLangPill = document.getElementById('diag-lang-pill');
  const btnDiagTrace = document.getElementById('btn-diag-trace') as HTMLButtonElement | null;

  const stageBoxMic = document.getElementById('stage-box-mic');
  const stageMicTimer = document.getElementById('stage-mic-timer');
  const stageMicFill = document.getElementById('stage-mic-fill');
  const stageMicSub = document.getElementById('stage-mic-sub');

  const stageBoxSend = document.getElementById('stage-box-send');
  const stageSendTimer = document.getElementById('stage-send-timer');
  const stageSendFill = document.getElementById('stage-send-fill');
  const stageSendSub = document.getElementById('stage-send-sub');

  const stageBoxRecv = document.getElementById('stage-box-recv');
  const stageRecvTimer = document.getElementById('stage-recv-timer');
  const stageRecvFill = document.getElementById('stage-recv-fill');
  const stageRecvSub = document.getElementById('stage-recv-sub');

  const stageBoxPlay = document.getElementById('stage-box-play');
  const stagePlayTimer = document.getElementById('stage-play-timer');
  const stagePlayFill = document.getElementById('stage-play-fill');
  const stagePlaySub = document.getElementById('stage-play-sub');

  const diagFlagPill = document.getElementById('diag-flag-pill');
  const diagSummaryText = document.getElementById('diag-summary-text');
  const diagRoundtripVal = document.getElementById('diag-roundtrip-val');

  interface PipelineState {
    activeStage: 'idle' | 'mic' | 'send' | 'recv' | 'play';
    tMic: number;
    tSend: number;
    tRecv: number;
    tPlay: number;
    deltaMicToSend: number;
    deltaSendToRecv: number;
    deltaRecvToPlay: number;
    totalTurnaround: number;
    watchdogInterval: any;
    watchdogDeadline: number;
    isCutAudio: boolean;
    isChoppy: boolean;
    turnDurations: number[];
  }

  const pipelineState: PipelineState = {
    activeStage: 'idle',
    tMic: 0,
    tSend: 0,
    tRecv: 0,
    tPlay: 0,
    deltaMicToSend: 0,
    deltaSendToRecv: 0,
    deltaRecvToPlay: 0,
    totalTurnaround: 0,
    watchdogInterval: null,
    watchdogDeadline: 0,
    isCutAudio: false,
    isChoppy: false,
    turnDurations: [],
  };

  function updateDiagLangPill() {
    if (diagLangPill) {
      const src = (midcallSourceLang.value || sourceLang.value || 'en').toUpperCase();
      const tgt = (midcallTargetLang.value || targetLang.value || 'hi').toUpperCase();
      diagLangPill.textContent = `${src} ➔ ${tgt}`;
    }
  }

  function resetPipelineStageBoxes() {
    [stageBoxMic, stageBoxSend, stageBoxRecv, stageBoxPlay].forEach((box) => {
      if (box) box.className = 'diag-stage-box';
    });
    [stageMicFill, stageSendFill, stageRecvFill, stagePlayFill].forEach((fill) => {
      if (fill) fill.style.width = '0%';
    });
  }

  function startWatchdog(stageLabel: string) {
    if (pipelineState.watchdogInterval) {
      clearInterval(pipelineState.watchdogInterval);
      pipelineState.watchdogInterval = null;
    }
    const WATCHDOG_MAX_MS = 4000;
    pipelineState.watchdogDeadline = performance.now() + WATCHDOG_MAX_MS;

    if (diagWatchdogBadge) {
      diagWatchdogBadge.className = 'diag-badge-watchdog running';
      diagWatchdogBadge.textContent = `⏱️ Watchdog: 4.0s (${stageLabel})`;
    }

    pipelineState.watchdogInterval = setInterval(() => {
      const now = performance.now();
      const remainingMs = Math.max(0, pipelineState.watchdogDeadline - now);
      const remainingSec = (remainingMs / 1000).toFixed(1);

      if (diagWatchdogBadge) {
        diagWatchdogBadge.textContent = `⏱️ Watchdog: ${remainingSec}s (${stageLabel})`;
      }

      if (remainingMs <= 0) {
        clearInterval(pipelineState.watchdogInterval);
        pipelineState.watchdogInterval = null;
        triggerWatchdogTimeout();
      }
    }, 50);
  }

  function stopWatchdog(passed: boolean = true) {
    if (pipelineState.watchdogInterval) {
      clearInterval(pipelineState.watchdogInterval);
      pipelineState.watchdogInterval = null;
    }
    if (diagWatchdogBadge) {
      if (passed) {
        diagWatchdogBadge.className = 'diag-badge-watchdog success';
        diagWatchdogBadge.textContent = '✅ Watchdog: Passed (<4.0s)';
      } else {
        diagWatchdogBadge.className = 'diag-badge-watchdog timeout';
        diagWatchdogBadge.textContent = '⚠️ Watchdog: Timeout (>4.0s)';
      }
    }
  }

  function triggerWatchdogTimeout() {
    if (diagWatchdogBadge) {
      diagWatchdogBadge.className = 'diag-badge-watchdog timeout';
      diagWatchdogBadge.textContent = '⚠️ Watchdog Exceeded (>4.0s)';
    }

    // Determine exact root-cause based on stuck stage
    if (pipelineState.activeStage === 'mic') {
      if (stageBoxMic) stageBoxMic.classList.add('delayed');
      if (stageMicSub) stageMicSub.textContent = 'Capture Stalled';
      applyDiagnosis('our-app', '🟢 our app', 'Mic → API send is delayed (>4s). Local speech capture / VAD buffer delayed.');
    } else if (pipelineState.activeStage === 'send') {
      if (stageBoxSend) stageBoxSend.classList.add('delayed');
      if (stageSendSub) stageSendSub.textContent = 'API Stalled';
      applyDiagnosis('api-net', '🔴 API/network', 'API send → response is delayed (>4s). Ollalink cloud translation or network bottleneck.');
    } else if (pipelineState.activeStage === 'recv') {
      if (stageBoxRecv) stageBoxRecv.classList.add('delayed');
      if (stageRecvSub) stageRecvSub.textContent = 'Playout Stalled';
      applyDiagnosis('our-playback', '🟢 our playback/buffering', 'Response arrives smoothly but speaker is choppy / buffer starved (>4s).');
    }
  }

  function applyDiagnosis(cls: string, badge: string, detail: string, roundtrip?: number) {
    if (diagFlagPill) {
      diagFlagPill.className = `diag-flag-pill ${cls}`;
      diagFlagPill.textContent = badge;
    }
    if (diagSummaryText) {
      diagSummaryText.textContent = detail;
    }
    if (diagRoundtripVal && typeof roundtrip === 'number') {
      diagRoundtripVal.textContent = `${roundtrip} ms`;
      diagRoundtripVal.style.color = cls === 'optimal' ? '#34d399' : '#f87171';
    }
  }

  function handlePipelineCheckpoint(payload: any) {
    if (!payload || !payload.stage) return;
    const { stage, deltaMs, totalMs, bytes, isCutAudio, isChoppy } = payload;

    switch (stage) {
      case 'mic': {
        pipelineState.activeStage = 'mic';
        pipelineState.tMic = payload.timestamp || performance.now();
        resetPipelineStageBoxes();
        if (stageBoxMic) stageBoxMic.className = 'diag-stage-box active';
        if (stageMicTimer) stageMicTimer.textContent = 'Active';
        if (stageMicFill) stageMicFill.style.width = '35%';
        if (stageMicSub) stageMicSub.textContent = 'Speech Detected';
        startWatchdog('Mic→API');
        applyDiagnosis('idle', 'SPEECH DETECTED', 'Microphone capturing conversational utterance...');
        break;
      }

      case 'send': {
        pipelineState.activeStage = 'send';
        pipelineState.deltaMicToSend = deltaMs || Math.round(performance.now() - pipelineState.tMic);
        if (stageBoxMic) {
          stageBoxMic.className = 'diag-stage-box completed';
          if (stageMicTimer) stageMicTimer.textContent = `${pipelineState.deltaMicToSend} ms`;
          if (stageMicFill) stageMicFill.style.width = '100%';
          if (stageMicSub) stageMicSub.textContent = 'Buffer Committed';
        }
        if (stageBoxSend) {
          stageBoxSend.className = 'diag-stage-box active';
          if (stageSendTimer) stageSendTimer.textContent = 'Transmitting';
          if (stageSendFill) stageSendFill.style.width = '45%';
          if (stageSendSub) stageSendSub.textContent = 'Streaming Upstream';
        }
        startWatchdog('API Wait');

        // Check if Mic -> Send was delayed
        if (pipelineState.deltaMicToSend > 4000) {
          stopWatchdog(false);
          applyDiagnosis('our-app', '🟢 our app', `Mic → API send is delayed (${pipelineState.deltaMicToSend}ms). Audio queue backlog.`);
        }
        break;
      }

      case 'recv': {
        pipelineState.activeStage = 'recv';
        pipelineState.deltaSendToRecv = deltaMs || 150;
        pipelineState.isCutAudio = !!isCutAudio;

        if (stageBoxSend) {
          stageBoxSend.className = 'diag-stage-box completed';
          if (stageSendTimer) stageSendTimer.textContent = `${pipelineState.deltaSendToRecv} ms`;
          if (stageSendFill) stageSendFill.style.width = '100%';
          if (stageSendSub) stageSendSub.textContent = 'Frame Delivered';
        }
        if (stageBoxRecv) {
          stageBoxRecv.className = isCutAudio ? 'diag-stage-box delayed' : 'diag-stage-box active';
          if (stageRecvTimer) stageRecvTimer.textContent = `${bytes || 0} bytes`;
          if (stageRecvFill) stageRecvFill.style.width = isCutAudio ? '30%' : '75%';
          if (stageRecvSub) stageRecvSub.textContent = isCutAudio ? 'Cut Audio Detected' : 'Decoding Audio';
        }
        startWatchdog('Playout');

        // Check for cut audio or delayed response
        if (isCutAudio) {
          stopWatchdog(false);
          applyDiagnosis('api-cut', '🔴 API', 'API response itself contains missing/cut audio (<44 bytes or broken header).');
        } else if (pipelineState.deltaSendToRecv > 4000) {
          stopWatchdog(false);
          applyDiagnosis('api-net', '🔴 API/network', `API send → response is delayed (${pipelineState.deltaSendToRecv}ms). Upstream translation lag.`);
        }
        break;
      }

      case 'play': {
        pipelineState.activeStage = 'play';
        pipelineState.deltaRecvToPlay = deltaMs || 15;
        pipelineState.totalTurnaround = totalMs || (pipelineState.deltaMicToSend + pipelineState.deltaSendToRecv + pipelineState.deltaRecvToPlay);
        pipelineState.isChoppy = !!isChoppy;
        stopWatchdog(true);

        if (stageBoxRecv) {
          stageBoxRecv.className = 'diag-stage-box completed';
          if (stageRecvFill) stageRecvFill.style.width = '100%';
          if (stageRecvSub) stageRecvSub.textContent = 'PCM Ready';
        }
        if (stageBoxPlay) {
          stageBoxPlay.className = isChoppy ? 'diag-stage-box delayed' : 'diag-stage-box completed';
          if (stagePlayTimer) stagePlayTimer.textContent = `${pipelineState.deltaRecvToPlay} ms`;
          if (stagePlayFill) stagePlayFill.style.width = '100%';
          if (stagePlaySub) stagePlaySub.textContent = isChoppy ? 'Buffer Underrun' : 'Audio Out Smooth';
        }

        pipelineState.turnDurations.push(pipelineState.totalTurnaround);
        if (pipelineState.turnDurations.length > 6) pipelineState.turnDurations.shift();

        // Calculate variance / jitter across turns
        let isHighJitter = false;
        if (pipelineState.turnDurations.length >= 3) {
          const maxTurn = Math.max(...pipelineState.turnDurations);
          const minTurn = Math.min(...pipelineState.turnDurations);
          if (maxTurn - minTurn > 800) isHighJitter = true;
        }

        // Full comparison evaluation
        if (pipelineState.isCutAudio) {
          applyDiagnosis('api-cut', '🔴 API', 'API response itself contains missing/cut audio.', pipelineState.totalTurnaround);
        } else if (pipelineState.deltaMicToSend > 4000) {
          applyDiagnosis('our-app', '🟢 our app', 'Mic → API send is delayed.', pipelineState.totalTurnaround);
        } else if (pipelineState.deltaSendToRecv > 4000) {
          applyDiagnosis('api-net', '🔴 API/network', 'API send → response is delayed (>4s).', pipelineState.totalTurnaround);
        } else if (isChoppy) {
          applyDiagnosis('our-playback', '🟢 our playback/buffering', 'Response arrives smoothly but speaker is choppy / buffer starved.', pipelineState.totalTurnaround);
        } else if (isHighJitter) {
          applyDiagnosis('net-inconsistent', '🟡 network + client buffering', 'Everything is fast but inconsistent across utterances.', pipelineState.totalTurnaround);
        } else {
          applyDiagnosis('optimal', '⚡ OPTIMAL', `Pipeline verified: Mic➔Send➔API➔Speaker in ${pipelineState.totalTurnaround}ms.`, pipelineState.totalTurnaround);
        }
        break;
      }
    }
  }

  // Interactive Test 4s Trace Simulation Button
  if (btnDiagTrace) {
    btnDiagTrace.addEventListener('click', async () => {
      btnDiagTrace.disabled = true;
      btnDiagTrace.textContent = 'Tracing...';
      updateDiagLangPill();

      handlePipelineCheckpoint({ stage: 'mic', timestamp: performance.now() });
      await new Promise((r) => setTimeout(r, 120));

      handlePipelineCheckpoint({ stage: 'send', deltaMs: 120, timestamp: performance.now() });
      await new Promise((r) => setTimeout(r, 680));

      handlePipelineCheckpoint({ stage: 'recv', deltaMs: 680, bytes: 3840, isCutAudio: false, timestamp: performance.now() });
      await new Promise((r) => setTimeout(r, 45));

      handlePipelineCheckpoint({ stage: 'play', deltaMs: 45, totalMs: 845, isChoppy: false, timestamp: performance.now() });
      btnDiagTrace.disabled = false;
      btnDiagTrace.textContent = 'Test 4s Trace';
    });
  }

  function handleRelayEvent(ev: any) {
    switch (ev?.type) {
      case 'joined': {
        const participants = ev.participants ?? [];
        participantNames.clear();
        for (const p of participants) {
          if (p?.sessionId) participantNames.set(p.sessionId, p.displayName || 'Partner');
        }

        const myChosenName = (isCurrentCallHost ? hostNameInput.value : joinNameInput.value).trim() || displayName.value || 'You';
        if (ev.self?.sessionId) {
          participantNames.set(ev.self.sessionId, `${myChosenName} (You)`);
        }

        renderParticipants(participants, ev.self?.sessionId);
        captions.addSystem(`joined room ${ev.room}`);
        
        // Check if there's already a peer in the room
        const peer = participants.find((p: any) => p.sessionId !== ev.self?.sessionId);
        if (peer) {
          currentPeerInfo = {
            name: peer.displayName || 'Partner',
            sourceLang: peer.sourceLang,
            targetLang: peer.targetLang,
          };
          setConnectedPeerStatus(currentPeerInfo.name, currentPeerInfo.sourceLang, currentPeerInfo.targetLang);
        } else {
          currentPeerInfo = null;
          if (isCurrentCallHost) {
            setWaitingPeerStatus();
          } else {
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
        if (ev.sessionId) participantNames.delete(ev.sessionId);
        removeParticipant(ev.sessionId);
        currentPeerInfo = null;
        if (isCurrentCallHost) {
          setWaitingPeerStatus();
        } else {
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
          } catch (e) {
            console.warn('caption failed:', e);
          }
        }
        break;

      case 'pong':
        break;

      case 'voice.settings.updated':
      case 'lang.changed': {
        showVoiceUpdated('Voice & Language Synchronized');
        break;
      }

      case 'error':
        setStatus('err', `${ev.code}: ${ev.message}`);
        break;

      default:
        console.debug('unhandled relay-event', ev);
    }
  }

  function renderParticipants(list: any[], selfId?: string) {
    participantsUl.innerHTML = '';
    for (const p of list) appendParticipant(p, p.sessionId === selfId);
  }

  function appendParticipant(p: any, isMe: boolean = false) {
    if (!p) return;
    const li = document.createElement('li');
    if (isMe) li.classList.add('me');
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
  const addParticipant = (p: any) => appendParticipant(p, p?.sessionId === selfSessionId);

  function removeParticipant(sessionId: string) {
    const el = participantsUl.querySelector(`li[data-session-id="${sessionId}"]`);
    if (el) el.remove();
  }

  function setStatus(kind: 'idle' | 'busy' | 'active' | 'err', text: string) {
    connStatus.textContent = text;
    connStatus.className = `pill pill-${kind}`;
  }
}

function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
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
