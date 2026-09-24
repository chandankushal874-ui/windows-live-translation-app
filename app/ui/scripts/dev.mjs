#!/usr/bin/env node
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(__dirname, '..');
const PORT = 1420;

function isViteServing(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/`, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port);
  });
}

function killPortOwner(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = out.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1]?.trim();
        if (pid && pid !== '0' && pid !== String(process.pid)) {
          try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {}
        }
      }
    } else {
      execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' });
    }
  } catch {}
}

async function start() {
  // 1. If dev server is already running, reuse it gracefully for Tauri / child invocations
  const serving = await isViteServing(PORT);
  if (serving) {
    console.log(`[vite-dev] Dev server is already active on http://localhost:${PORT}/. Reusing instance.`);
    const timer = setInterval(() => {}, 30000);
    process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
    process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
    return;
  }

  // 2. If not serving but port is blocked, clear the stale process
  const free = await isPortFree(PORT);
  if (!free) {
    console.log(`[vite-dev] Port ${PORT} is occupied by an unresponsive process. Freeing port...`);
    killPortOwner(PORT);
    await new Promise((r) => setTimeout(r, 600));
  }

  // 3. Launch Vite directly
  const viteBin = path.join(uiDir, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin], {
    cwd: uiDir,
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });

  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

start().catch((err) => {
  console.error('[vite-dev] Error launching dev server:', err);
  process.exit(1);
});