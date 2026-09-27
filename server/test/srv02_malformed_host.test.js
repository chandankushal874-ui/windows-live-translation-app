// test/srv02_malformed_host.test.js — verifies that malformed Host headers cannot crash the relay.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

process.env.PORT = '32200';
process.env.PUBLIC_BASE = 'ws://localhost:32200';
process.env.OLLALINK_DASHBOARD_KEY = 'sk_test_mock_key';
process.env.OLLALINK_WS_URL = 'wss://example.com';
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.LOG_LEVEL = 'error';

const { startServer } = await import('../src/server.js');

let serverHandle;

before(async () => {
  serverHandle = await startServer();
});

after(async () => {
  if (serverHandle) await serverHandle.close();
});

function sendRawHttp(raw) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port: 32200, host: '127.0.0.1' }, () => {
      socket.write(raw);
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      socket.end();
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

test('SRV-02 FIX: malformed Host header "Host: a b" does not crash the relay', async () => {
  // 1. Send malformed request that would previously trigger: TypeError: Invalid URL -> process.exit(1)
  const rawRequest = 'GET /api/ready HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n';
  const response = await sendRawHttp(rawRequest);

  assert.ok(response.startsWith('HTTP/1.1 200 OK') || response.startsWith('HTTP/1.1 400 Bad Request'), 
    'Server must respond cleanly instead of terminating process');

  // 2. Verify server is still alive and serving subsequent valid requests
  const validRequest = 'GET /api/ready HTTP/1.1\r\nHost: localhost:32200\r\nConnection: close\r\n\r\n';
  const validResponse = await sendRawHttp(validRequest);
  assert.ok(validResponse.includes('200 OK'), 'Server must still be alive and handling requests');
});

test('SRV-02 FIX: completely malformed request URL does not crash the relay', async () => {
  // Invalid URI encoding in URL
  const rawRequest = 'GET /api/%99% HTTP/1.1\r\nHost: localhost:32200\r\nConnection: close\r\n\r\n';
  const response = await sendRawHttp(rawRequest);

  assert.ok(response.includes('HTTP/1.1'), 'Server responds to malformed URI cleanly');
});
