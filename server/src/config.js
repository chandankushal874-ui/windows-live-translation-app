/**
 * config.js — environment loading and validation.
 *
 * Fails fast on startup if any required variable is missing. All config used
 * elsewhere in the relay goes through this module — never read process.env
 * directly outside of this file.
 */

const REQUIRED = [
  'PORT',
  'PUBLIC_BASE',
  'OLLALINK_DASHBOARD_KEY',
  'OLLALINK_WS_URL',
  'SESSION_SECRET',
];

const OPTIONAL_DEFAULTS = {
  SESSION_TTL_SECONDS: '1800',
  ALLOWED_ORIGINS: '',
  LOG_LEVEL: 'info',
};

for (const [key, fallback] of Object.entries(OPTIONAL_DEFAULTS)) {
  if (!process.env[key]) process.env[key] = fallback;
}

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`[config] missing required env vars: ${missing.join(', ')}`);
  console.error(`[config] copy .env.example to .env and fill it in.`);
  process.exit(1);
}

if (process.env.SESSION_SECRET === 'replace_me_with_random_32_byte_hex') {
  console.error('[config] SESSION_SECRET is still the placeholder. Rotate before deploying.');
  if (process.env.NODE_ENV === 'production') process.exit(1);
}

export const config = Object.freeze({
  port: parseInt(process.env.PORT, 10),
  publicBase: process.env.PUBLIC_BASE,
  ollalinkKey: process.env.OLLALINK_DASHBOARD_KEY,
  ollalinkWsUrl: process.env.OLLALINK_WS_URL,
  sessionSecret: process.env.SESSION_SECRET,
  sessionTtlSeconds: parseInt(process.env.SESSION_TTL_SECONDS, 10),
  allowedOrigins: process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  logLevel: process.env.LOG_LEVEL,
});

// ---- minimal logger with levels ------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

export const log = {
  debug: (...args) => threshold <= LEVELS.debug && console.log('[dbg]', ...args),
  info:  (...args) => threshold <= LEVELS.info  && console.log('[inf]', ...args),
  warn:  (...args) => threshold <= LEVELS.warn  && console.warn('[wrn]', ...args),
  error: (...args) => threshold <= LEVELS.error && console.error('[err]', ...args),
};
