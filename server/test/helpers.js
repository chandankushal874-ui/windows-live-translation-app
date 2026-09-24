// test/helpers.js — shared test utilities.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Build a temp .env file + return its directory. Caller must clean up. */
export function withEnv(overrides = {}, fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ollalink-test-'));
    const defaults = {
      PORT: String(20000 + Math.floor(Math.random() * 20000)),
      PUBLIC_BASE: 'ws://localhost:0',
      OLLALINK_DASHBOARD_KEY: 'sk_test',
      OLLALINK_WS_URL: 'wss://example.com',
      SESSION_SECRET: randomBytes(32).toString('hex'),
      SESSION_TTL_SECONDS: '1800',
      ALLOWED_ORIGINS: '',
      LOG_LEVEL: 'error',
    };
    const merged = { ...defaults, ...overrides };
    for (const [k, v] of Object.entries(merged)) process.env[k] = v;
    try {
      await fn(merged);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
