/**
 * run-tests.mjs â€” runs each test file in a SEPARATE child process.
 *
 * Why: tests that boot a relay server set process.env at import time. Node's
 * --test runner loads all files into one process, so the second file's env
 * overrides the first's. Running each in a child process gives full isolation.
 *
 * Unit tests (no server) are batched into one process for speed.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, '..', 'test');

// Split into unit (no server boot) and integration (server + fake upstream).
const UNIT = ['auth.test.js', 'rooms.test.js', 'audio_chunks.test.js',
              'captions_routing.test.js', 'realtime_protocol.test.js',
              'regressions.test.js', 'voice_tones.test.js'];
const INTEGRATION = ['server.test.js', 'receive_path.test.js',
                     'rooms_deep.test.js', 'multi_target.test.js', 'deep_e2e_pipeline.test.js', 'deep_e2e_advanced.test.js', 'landing_flow_e2e.test.js', 'host_joining_deep.test.js'];

let totalPass = 0;
let totalFail = 0;
const failures = [];

function runBatch(label, files) {
  const args = ['--test', '--test-force-exit', ...files.map(f => join('test', f))];
  console.log(`\n--- ${label} (${files.length} files) ---`);
  const r = spawnSync('node', args, {
    cwd: join(here, '..'),
    encoding: 'utf8',
    timeout: 60000,
  });
  // Parse summary
  const passMatch = r.stdout.match(/pass (\d+)/);
  const failMatch = r.stdout.match(/fail (\d+)/);
  const pass = passMatch ? parseInt(passMatch[1]) : 0;
  const fail = failMatch ? parseInt(failMatch[1]) : 0;
  totalPass += pass;
  totalFail += fail;

  // Show failures
  const failLines = r.stdout.split('\n').filter(l => l.startsWith('âœ–'));
  for (const line of failLines) {
    failures.push(`${label}: ${line}`);
  }

  // Show test names
  const passLines = r.stdout.split('\n').filter(l => l.includes('âœ”')).length;
  console.log(`  pass=${pass} fail=${fail}`);
  if (fail > 0) {
    console.log('  FAILURES:');
    for (const line of failLines) console.log('  ' + line);
  }
}

// Run unit tests in one batch (they don't boot servers, so no env conflicts)
runBatch('UNIT', UNIT);

// Run each integration test in isolation
for (const f of INTEGRATION) {
  runBatch('INTEGRATION: ' + f, [f]);
}

console.log(`\n=== TOTAL: pass=${totalPass} fail=${totalFail} ===`);
if (totalFail > 0) {
  console.log('\nAll failures:');
  for (const f of failures) console.log(f);
  process.exit(1);
}

