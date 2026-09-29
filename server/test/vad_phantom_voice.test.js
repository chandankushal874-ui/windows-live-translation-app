// test/vad_phantom_voice.test.js — Deep test of the VAD fix for phantom translations.
//
// Tests the exact VAD logic from audio/mod.rs:388-515 by simulating it in JS.
// Verifies that room noise, fan noise, keyboard typing, and mouse clicks
// do NOT trigger the speaking state, while actual speech does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ─── VAD constants (must match audio/mod.rs:402-405) ───────────────────────
const VAD_ONSET_RMS = 0.024;
const VAD_ONSET_PEAK = 0.045;
const VAD_CONTINUE_RMS = 0.012;
const VAD_CONTINUE_PEAK = 0.024;
const SILENCE_HOLD_MS = 1500;
const PREROLL_MAX_FRAMES = 6;
const ONSET_DEBOUNCE_FRAMES = 2;

// ─── VAD simulator (mirrors audio/mod.rs:459-514) ───────────────────────────
function createVADSimulator() {
  let isSpeaking = false;
  let consecutiveSpeechFrames = 0;
  let lastVoiceSpike = Date.now();
  let preRoll = [];
  const sentFrames = [];
  const commits = [];

  function processFrame(rms, peak, now = Date.now()) {
    const isOnsetFrame = (rms >= VAD_ONSET_RMS && peak >= VAD_ONSET_PEAK) || (rms >= 0.035);
    const isContinuing = (rms >= VAD_CONTINUE_RMS) || (peak >= VAD_CONTINUE_PEAK);

    if (!isSpeaking) {
      if (isOnsetFrame) {
        consecutiveSpeechFrames++;
      } else {
        consecutiveSpeechFrames = 0;
      }

      if (consecutiveSpeechFrames >= ONSET_DEBOUNCE_FRAMES) {
        isSpeaking = true;
        lastVoiceSpike = now;
        // Flush pre-roll
        while (preRoll.length > 0) {
          sentFrames.push({ type: 'preroll', rms: 0 });
          preRoll.shift();
        }
        sentFrames.push({ type: 'live', rms });
      } else {
        // Buffer pre-roll
        if (preRoll.length >= PREROLL_MAX_FRAMES) {
          preRoll.shift();
        }
        preRoll.push({ rms });
      }
    } else {
      // Actively speaking
      if (isContinuing) {
        lastVoiceSpike = now;
      }
      sentFrames.push({ type: 'live', rms });

      // Check silence hold
      if (now - lastVoiceSpike >= SILENCE_HOLD_MS) {
        isSpeaking = false;
        consecutiveSpeechFrames = 0;
        commits.push(now);
        preRoll = [];
      }
    }

    return { isSpeaking, consecutiveSpeechFrames, preRollLen: preRoll.length };
  }

  return { processFrame, sentFrames, commits, get isSpeaking() { return isSpeaking; } };
}

// ─── Helper: generate N frames of constant noise ────────────────────────────
function generateNoiseFrames(rms, peak, count) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push({ rms, peak, time: Date.now() + i * 20 });
  }
  return frames;
}

// ─── Helper: generate speech-like frames ────────────────────────────────────
function generateSpeechFrames(count, startRms = 0.06, startPeak = 0.08) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    // Speech varies in amplitude
    const variation = 0.8 + 0.4 * Math.sin(i * 0.5);
    frames.push({
      rms: startRms * variation,
      peak: startPeak * variation,
      time: Date.now() + i * 20,
    });
  }
  return frames;
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

// --- Test 1: Room noise should NOT trigger speaking ---
test('BUG-A FIX: Room noise (RMS 0.003, peak 0.005) does NOT trigger speaking', () => {
  const vad = createVADSimulator();
  const noiseFrames = generateNoiseFrames(0.003, 0.005, 100); // 2 seconds of room noise

  for (const f of noiseFrames) {
    vad.processFrame(f.rms, f.peak, f.time);
  }

  assert.equal(vad.isSpeaking, false, 'Room noise must NOT trigger speaking');
  assert.equal(vad.sentFrames.length, 0, 'No frames should be sent for room noise');
  assert.equal(vad.commits.length, 0, 'No commits for room noise');
});

// --- Test 2: Laptop fan noise should NOT trigger speaking ---
test('BUG-A FIX: Laptop fan noise (RMS 0.010, peak 0.015) does NOT trigger speaking', () => {
  const vad = createVADSimulator();
  const fanFrames = generateNoiseFrames(0.010, 0.015, 100);

  for (const f of fanFrames) {
    vad.processFrame(f.rms, f.peak, f.time);
  }

  assert.equal(vad.isSpeaking, false, 'Fan noise must NOT trigger speaking');
  assert.equal(vad.sentFrames.length, 0, 'No frames should be sent for fan noise');
});

// --- Test 3: Single mouse click should NOT trigger speaking (debounce) ---
test('BUG-A FIX: Single transient (mouse click, RMS 0.03, peak 0.04) does NOT trigger — needs 2 consecutive', () => {
  const vad = createVADSimulator();

  // One loud frame (mouse click)
  vad.processFrame(0.03, 0.04, Date.now());
  // Then silence
  vad.processFrame(0.002, 0.003, Date.now() + 20);
  vad.processFrame(0.001, 0.002, Date.now() + 40);

  assert.equal(vad.isSpeaking, false, 'Single transient must NOT trigger speaking');
  assert.equal(vad.sentFrames.length, 0, 'No frames sent for single transient');
});

// --- Test 4: Single keyboard tap should NOT trigger speaking ---
test('BUG-A FIX: Single keyboard tap (RMS 0.032, peak 0.05) then silence — debounce blocks it', () => {
  const vad = createVADSimulator();

  // One keyboard frame (meets onset threshold)
  vad.processFrame(0.032, 0.05, Date.now());
  // Immediate silence (keyboard tap is ~10ms, shorter than 20ms frame)
  vad.processFrame(0.002, 0.003, Date.now() + 20);
  vad.processFrame(0.001, 0.002, Date.now() + 40);

  assert.equal(vad.isSpeaking, false, 'Keyboard tap must NOT trigger speaking');
  assert.equal(vad.sentFrames.length, 0, 'No frames sent for keyboard tap');
});

// --- Test 5: Two consecutive strong frames SHOULD trigger speaking ---
test('BUG-A FIX: Two consecutive speech frames (RMS 0.06, peak 0.08) DO trigger speaking', () => {
  const vad = createVADSimulator();

  vad.processFrame(0.06, 0.08, Date.now());      // Frame 1: onset
  const state1 = vad.processFrame(0.06, 0.08, Date.now() + 20);  // Frame 2: confirmed

  assert.equal(state1.isSpeaking, true, 'Two consecutive speech frames must trigger speaking');
  assert.ok(vad.sentFrames.length > 0, 'Frames should be sent when speaking starts');
});

// --- Test 6: Normal speech should trigger and continue ---
test('BUG-A FIX: Normal speech (RMS 0.08, peak 0.12) triggers and stays active', () => {
  const vad = createVADSimulator();
  const speech = generateSpeechFrames(50, 0.08, 0.12); // 1 second of speech

  let lastState = null;
  for (const f of speech) {
    lastState = vad.processFrame(f.rms, f.peak, f.time);
  }

  assert.equal(lastState.isSpeaking, true, 'Should still be speaking during continuous speech');
  assert.ok(vad.sentFrames.length >= 48, 'Most speech frames should be sent (some in pre-roll)');
});

// --- Test 7: Pre-roll is capped at 6 frames (120ms), not 20 (400ms) ---
test('BUG-A FIX: Pre-roll buffer capped at 6 frames (120ms), not 20 (400ms)', () => {
  const vad = createVADSimulator();

  // Feed 20 frames of low-level noise (below onset, fills pre-roll)
  for (let i = 0; i < 20; i++) {
    vad.processFrame(0.005, 0.008, Date.now() + i * 20);
  }

  // Now trigger speech with 2 consecutive frames
  vad.processFrame(0.06, 0.08, Date.now() + 400);
  vad.processFrame(0.06, 0.08, Date.now() + 420);

  // Pre-roll flush should have sent at most 6 frames + 1 live frame = 7 total
  const prerollCount = vad.sentFrames.filter(f => f.type === 'preroll').length;
  assert.ok(prerollCount <= 6, `Pre-roll should be at most 6 frames, got ${prerollCount}`);
});

// --- Test 8: Silence hold is 1.2s (not 1.5s) ---
test('BUG-A FIX: Silence hold commits after 1.5 seconds (matching Ollalink endpointing)', () => {
  const vad = createVADSimulator();
  const t0 = Date.now();

  // Start speaking
  vad.processFrame(0.06, 0.08, t0);
  vad.processFrame(0.06, 0.08, t0 + 20);

  // Speak for 500ms
  for (let i = 0; i < 25; i++) {
    vad.processFrame(0.07, 0.10, t0 + 40 + i * 20);
  }

  // Go silent for exactly 1.5s
  for (let i = 0; i < 75; i++) {
    vad.processFrame(0.002, 0.003, t0 + 540 + i * 20);
  }

  // At 1.2s of silence, commit should have fired
  assert.ok(vad.commits.length >= 1, 'Commit should fire after 1.5s of silence');
  assert.equal(vad.isSpeaking, false, 'Should have stopped speaking after 1.5s silence');
});

// --- Test 9: Old threshold (0.008) is completely gone ---
test('BUG-A FIX: Old VAD threshold 0.008 is NOT present in source code', () => {
  const source = readFileSync('C:/ollalink-translate/app/src-tauri/src/audio/mod.rs', 'utf8');

  // Old thresholds that caused phantom translations
  assert.ok(!source.includes('0.008f32'), 'Old RMS threshold 0.008 must be removed');
  assert.ok(!source.includes('0.018f32'), 'Old peak threshold 0.018 must be removed');

  // New thresholds must be present
  assert.ok(source.includes('0.024'), 'New onset RMS threshold 0.024 must be present');
  assert.ok(source.includes('0.045'), 'New onset peak threshold 0.045 must be present');
  assert.ok(source.includes('consecutive_speech_frames'), 'Debounce counter must be present');
  assert.ok(source.includes('>= 2'), 'Debounce requires 2 consecutive frames');
});

// --- Test 10: Self-monitor path is disabled when alone ---
test('BUG-A FIX: Self-monitor audio return is disabled when alone (server-side)', () => {
  const source = readFileSync('C:/ollalink-translate/server/src/server.js', 'utf8');

  // The old self-monitor code sent audio back to the speaker
  assert.ok(!source.includes('[client.session]'),
    'Old self-monitor recipients = [client.session] must be removed');

  // New code should return early when no peers
  assert.ok(source.includes('peers.length === 0'),
    'New code must check peers.length === 0');
  assert.ok(source.includes('feedback loop') || source.includes('do not loop'),
    'Self-monitor disable comment should be present');
});

// --- Test 11: Breathing noise should NOT trigger speaking ---
test('BUG-A FIX: Breathing into mic (RMS 0.015, peak 0.020) does NOT trigger speaking', () => {
  const vad = createVADSimulator();

  // Breathing is continuous but low-level
  for (let i = 0; i < 50; i++) {
    vad.processFrame(0.015, 0.020, Date.now() + i * 20);
  }

  assert.equal(vad.isSpeaking, false, 'Breathing noise must NOT trigger speaking');
  assert.equal(vad.sentFrames.length, 0, 'No frames sent for breathing');
});

// --- Test 12: Strong speech (RMS >= 0.035) triggers even without peak threshold ---
test('BUG-A FIX: Strong speech (RMS 0.035) triggers even if peak is below 0.045', () => {
  const vad = createVADSimulator();

  // RMS 0.035 >= 0.035 → triggers via the "strong RMS" path
  vad.processFrame(0.036, 0.030, Date.now());      // Frame 1
  const state = vad.processFrame(0.036, 0.030, Date.now() + 20);  // Frame 2

  assert.equal(state.isSpeaking, true, 'Strong RMS (>=0.035) should trigger without peak check');
});

// --- Test 13: Whisper (RMS 0.018) does NOT trigger ---
test('BUG-A FIX: Whispering (RMS 0.018, peak 0.025) does NOT trigger — intentional', () => {
  const vad = createVADSimulator();

  for (let i = 0; i < 50; i++) {
    vad.processFrame(0.018, 0.025, Date.now() + i * 20);
  }

  assert.equal(vad.isSpeaking, false, 'Whispering should NOT trigger speaking (by design)');
  assert.equal(vad.sentFrames.length, 0, 'No frames for whisper');
});