/**
 * langs.js — canonical language catalog shared by server and (via HTTP) the UI.
 *
 * Two sets, per Ollalink docs:
 *  - 22 languages supported by the live-captions lane (text-only).
 *  - Of those, 14 are sound-stream targets; 4 of those 14 have production voices.
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
