// bootstrap.js — loads .env then starts server. For dev convenience.
// In production, set env vars via your process manager (no file needed).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env');

if (existsSync(envPath)) {
  let env = readFileSync(envPath, 'utf8');
  // strip UTF-8 BOM if present (PowerShell Out-File adds it)
  if (env.charCodeAt(0) === 0xFEFF) env = env.slice(1);
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const { startServer } = await import('./server.js');
startServer();
