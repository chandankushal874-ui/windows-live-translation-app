/**
 * config.js — environment loading and validation.
 *
 * Senior Engineering & Cloud-Native Hardened Configuration:
 * - Auto-resolves Render / Railway / Cloud environment variables
 * - Auto-generates cryptographically secure session secrets if omitted
 * - Bridges OLLALINK_KEY and OLLALINK_DASHBOARD_KEY aliases
 */

import { randomBytes } from 'node:crypto';

// 1. Alias Resolution: support OLLALINK_KEY as alias for OLLALINK_DASHBOARD_KEY
if (!process.env.OLLALINK_DASHBOARD_KEY && process.env.OLLALINK_KEY) {
  process.env.OLLALINK_DASHBOARD_KEY = process.env.OLLALINK_KEY;
}

// 2. Cloud-native Port resolution (Render passes PORT=10000, Railway passes PORT)
if (!process.env.PORT) {
  process.env.PORT = '8787';
}

// 3. Upstream WebSocket URL default
if (!process.env.OLLALINK_WS_URL) {
  process.env.OLLALINK_WS_URL = 'wss://sound-stream.ollalink.com/v1/speech/stream';
}

// 4. Auto-detect Cloud Public Hostname (Render injects RENDER_EXTERNAL_HOSTNAME)
if (!process.env.PUBLIC_BASE) {
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    process.env.PUBLIC_BASE = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
  } else if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    process.env.PUBLIC_BASE = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  } else {
    process.env.PUBLIC_BASE = `http://localhost:${process.env.PORT}`;
  }
}

// 5. Auto-generate secure 32-byte SESSION_SECRET if missing or placeholder
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'replace_me_with_random_32_byte_hex') {
  process.env.SESSION_SECRET = randomBytes(32).toString('hex');
}

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
