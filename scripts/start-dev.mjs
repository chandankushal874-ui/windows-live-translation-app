import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('Starting Ollalink Translate Services...');
console.log('1. Starting Relay Server on http://localhost:8787 ...');

const relay = spawn('node', ['src/bootstrap.js'], {
  cwd: join(root, 'server'),
  stdio: 'inherit',
  shell: true,
});

setTimeout(() => {
  console.log('2. Starting Vite UI & Desktop App...');
  const app = spawn('npm', ['--prefix', 'app', 'run', 'tauri', 'dev'], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });

  const cleanup = () => {
    try { relay.kill(); } catch {}
    try { app.kill(); } catch {}
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}, 1500);