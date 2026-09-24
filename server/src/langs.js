/**
 * langs.js — canonical language catalog shared by server and (via HTTP) the UI.
 *
 * Two sets, per Ollalink docs:
 *  - 22 languages supported by the live-captions lane (text-only).
 *  - Of those, 14 are sound-stream targets; 4 of those 14 have production voices.
 *
 * Also catalogs available Voice Personas (Characters) and Delivery Tones.
 *
 * This module is the single source of truth for what the UI may offer and what
 * the server will accept.
 */

export const CAPTION_TARGETS_22 = Object.freeze([
  'en', 'hi', 'kn', 'ta', 'te', 'ml', 'bn', 'mr', 'gu', 'pa',
  'or', 'as', 'ur', 'fr', 'es', 'de', 'zh', 'ar', 'ja', 'ru', 'pt', 'it',
]);

export const SOUND_STREAM_SOURCES = Object.freeze(['en', 'hi', 'es', 'fr']);  // + 'auto'
export const SOUND_STREAM_TARGETS = Object.freeze([
  'en', 'hi', 'es', 'fr', 'de', 'zh', 'ar', 'ja', 'ru', 'pt', 'it', 'kn', 'ta', 'te',
]);
export const SOUND_STREAM_PRODUCTION_VOICES = Object.freeze(['en', 'hi', 'kn', 'ta']);

/**
 * Available voice personas / characters for neural TTS audio synthesis.
 */
export const VOICE_PERSONAS = Object.freeze([
  { id: 'nh-m01', name: 'Arnav', gender: 'male', character: 'Natural & Balanced', languages: ['en', 'hi', 'kn', 'ta'] },
  { id: 'nh-f01', name: 'Priya', gender: 'female', character: 'Warm & Expressive', languages: ['en', 'hi', 'kn', 'ta'] },
  { id: 'dhvaani-ramesh', name: 'Ramesh Babu', gender: 'male', character: 'Wise Indic Teacher', languages: ['kn', 'hi', 'ta'] },
  { id: 'dhvaani-male', name: 'Dev', gender: 'male', character: 'Deep & Authoritative', languages: ['hi', 'kn', 'ta'] },
  { id: 'dhvaani-female', name: 'Isha', gender: 'female', character: 'Cheerful & Friendly', languages: ['hi', 'kn', 'ta'] },
]);

/**
 * Available delivery tones / emotional moods for spoken audio.
 */
export const VOICE_TONES = Object.freeze([
  { id: 'natural', name: 'Natural & Conversational', description: 'Standard authentic speaking cadence' },
  { id: 'formal', name: 'Professional & Formal', description: 'Polite, clear business meeting tone' },
  { id: 'cheerful', name: 'Warm & Cheerful', description: 'Uplifting, friendly and positive delivery' },
  { id: 'calm', name: 'Calm & Empathetic', description: 'Gentle, reassuring, patient speech' },
  { id: 'dynamic', name: 'Dynamic & Energetic', description: 'Lively, animated and expressive cadence' },
]);

const ALIASES = new Map([
  ['auto', 'auto'],              // source-only
  // Common typo-tolerant aliases — keep narrow.
  ['EN', 'en'], ['HI', 'hi'], ['KN', 'kn'], ['TA', 'ta'],
]);

/** Normalize a language code. Returns null if not in the allowed set. */
export function normalizeLang(code, kind /* 'source' | 'target' | 'caption' */) {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const resolved = ALIASES.get(trimmed) ?? lower;

  switch (kind) {
    case 'source':
      if (resolved === 'auto') return 'auto';
      return SOUND_STREAM_SOURCES.includes(resolved) ? resolved : null;
    case 'target':
      return SOUND_STREAM_TARGETS.includes(resolved) ? resolved : null;
    case 'caption':
      return CAPTION_TARGETS_22.includes(resolved) ? resolved : null;
    default:
      return null;
  }
}

/** Convenience: which production voices are available for a target? */
export function hasProductionVoice(target) {
  return SOUND_STREAM_PRODUCTION_VOICES.includes(target);
}

/** Normalize a voice persona / character ID. Defaults to 'nh-m01'. */
export function normalizeVoice(voiceId) {
  if (typeof voiceId !== 'string') return 'nh-m01';
  const trimmed = voiceId.trim();
  const found = VOICE_PERSONAS.find(v => v.id.toLowerCase() === trimmed.toLowerCase());
  return found ? found.id : 'nh-m01';
}

/** Normalize a voice delivery tone. Defaults to 'natural'. */
export function normalizeTone(toneId) {
  if (typeof toneId !== 'string') return 'natural';
  const trimmed = toneId.trim();
  const found = VOICE_TONES.find(t => t.id.toLowerCase() === trimmed.toLowerCase());
  return found ? found.id : 'natural';
}
