const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

console.clear();
console.log('================================================================');
console.log('   OLLALINK TRANSLATE — 1-CLICK INTERNET HOST LAUNCHER          ');
console.log('================================================================\n');

const repoRoot = 'C:\\ollalink-translate';
const serverDir = path.join(repoRoot, 'server');
const cloudflaredExe = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';

function checkRelayHealth() {
  return new Promise(resolve => {
    http.get('http://localhost:8787/api/health', res => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

(async () => {
  // Step 1: Ensure Relay Server is running and up-to-date
  console.log('[1/3] Checking Local Relay Server on port 8787...');
  let isRunning = await checkRelayHealth();

  if (!isRunning) {
    console.log('[..] Starting Relay Server (node src/bootstrap.js)...');
    const srv = spawn('node', ['src/bootstrap.js'], {
      cwd: serverDir,
      detached: true,
      stdio: 'ignore',
    });
    srv.unref();

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await checkRelayHealth()) {
        isRunning = true;
        break;
      }
    }
  }

  if (isRunning) {
    console.log('✅ Local Relay Server is ONLINE on http://localhost:8787');
  } else {
    console.error('❌ Failed to start local relay server. Please check port 8787.');
    process.exit(1);
  }

  // Step 2: Start Cloudflare Tunnel
  console.log('\n[2/3] Establishing secure Public Internet Tunnel (Cloudflare)...');
  
  const cf = spawn(cloudflaredExe, ['tunnel', '--url', 'http://localhost:8787'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let publicUrl = null;

  cf.stderr.on('data', chunk => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !publicUrl) {
      publicUrl = match[0];
      onTunnelReady(publicUrl);
    }
  });

  cf.on('close', code => {
    console.log(`\n[Tunnel Process Exited with code ${code}]`);
    process.exit(code || 0);
  });

  function onTunnelReady(url) {
    // Try copying to clipboard
    try {
      execSync(`powershell -Command "Set-Clipboard -Value '${url}'"`, { stdio: 'ignore' });
    } catch {}

    console.log('\n================================================================');
    console.log('  🌐 YOUR PUBLIC INTERNET RELAY IS LIVE!                        ');
    console.log('================================================================\n');
    console.log('  PUBLIC INTERNET URL:');
    console.log(`  👉  ${url}`);
    console.log('  (Copied to your Windows Clipboard automatically!)\n');
    console.log('----------------------------------------------------------------');
    console.log('  HOW TO CONNECT WITH YOUR FRIEND:');
    console.log('----------------------------------------------------------------');
    console.log('  1. SEND THIS URL TO YOUR FRIEND:');
    console.log(`     ${url}\n`);
    console.log('  2. ON YOUR FRIEND\'S WINDOWS PC:');
    console.log('     - Open "ollalink-translate.exe"');
    console.log(`     - Paste this URL in the "Relay Server" box:`);
    console.log(`       ${url}`);
    console.log('     - Enter your Room Code & click "Join Room"\n');
    console.log('  3. ON YOUR PC:');
    console.log('     - Click "Create Room" on your Ollalink Translate app');
    console.log('     - Share the 6-character Room Code with your friend!\n');
    console.log('================================================================');
    console.log('  [Keep this window open while in call. Press Ctrl+C to stop]  ');
    console.log('================================================================\n');

    // Step 3: Launch desktop app for the host
    console.log('[3/3] Launching your Ollalink Translate Desktop App...');
    const exeCandidates = [
      path.join(repoRoot, 'ollalink-translate.exe'),
      path.join(repoRoot, 'dist-package', 'ollalink-translate.exe'),
      path.join(repoRoot, 'app', 'src-tauri', 'target', 'release', 'ollalink-translate.exe'),
    ];

    let targetExe = null;
    for (const c of exeCandidates) {
      if (fs.existsSync(c)) {
        targetExe = c;
        break;
      }
    }

    if (targetExe) {
      try {
        console.log(`[..] Starting ${targetExe}...`);
        execSync(`powershell -Command "Start-Process -FilePath '${targetExe}' -WorkingDirectory '${path.dirname(targetExe)}'"`, { stdio: 'ignore' });
        console.log('✅ Ollalink Translate Desktop App is now OPEN on your screen!\n');
      } catch (err) {
        console.warn('[WARN] Could not auto-launch app:', err.message);
        console.log(`👉 Please double-click: ${targetExe}\n`);
      }
    } else {
      console.error('❌ Could not locate ollalink-translate.exe.');
    }
  }
})();
