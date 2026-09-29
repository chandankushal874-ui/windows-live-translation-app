import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';

const TEST_PORT = 33920;
const MOCK_OLLALINK_PORT = 33921;

process.env.PORT = String(TEST_PORT);
process.env.PUBLIC_BASE = `ws://localhost:${TEST_PORT}`;
process.env.OLLALINK_DASHBOARD_KEY = 'sk_test_mock_dummy_key_00000000000000000000';
process.env.OLLALINK_WS_URL = `ws://127.0.0.1:${MOCK_OLLALINK_PORT}/v1/speech/stream`;
process.env.SESSION_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_TTL_SECONDS = '1800';

const { startServer } = await import('../src/server.js');
const { mintSession } = await import('../src/auth.js');
const { getRoom } = await import('../src/rooms.js');

let relayHandle;
let mockOllalinkWss;

before(async () => {
  mockOllalinkWss = new WebSocketServer({ port: MOCK_OLLALINK_PORT, path: '/v1/speech/stream' });
  mockOllalinkWss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'config') {
            ws.send(JSON.stringify({ type: 'session.ready', lanes: ['stream', 'batch'] }));
          }
        } catch {}
      }
    });
  });

  relayHandle = await startServer();
});

after(async () => {
  if (relayHandle) await relayHandle.close();
  if (mockOllalinkWss) await new Promise((r) => mockOllalinkWss.close(r));
});

function openClient(token, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/call`);
    const events = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'join',
        token,
        room,
        displayName: 'TestUser',
      }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        events.push(msg);
        console.log('CLIENT MSG:', msg.type, msg.error || msg.code || '');
        if (msg.type === 'joined') resolve({ ws, events, joined: msg });
      } catch {}
    });
    ws.on('error', reject);
  });
}

test('Bug C Fix: Reconnection with same token/session does NOT evict the new connection when old socket cleans up', async () => {
  const credsA = mintSession({ userId: 'userA', sourceLang: 'en', targetLang: 'hi', voice: 'nh-m01', tone: 'natural' });
  const credsB = mintSession({ userId: 'userB', sourceLang: 'hi', targetLang: 'en', voice: 'nh-f01', tone: 'natural' });

  console.log('--- 1. Client A joins ---');
  const clientA1 = await openClient(credsA.token);
  const roomCode = clientA1.joined.room;
  assert.ok(roomCode);

  console.log('--- 2. Client B joins ---');
  const clientB = await openClient(credsB.token, roomCode);
  assert.equal(clientB.joined.room, roomCode);

  const room = getRoom(roomCode);
  assert.equal(room.participants.size, 2);

  console.log('--- 3. Client A reconnects ---');
  const clientA2 = await openClient(credsA.token, roomCode);
  assert.equal(clientA2.joined.self.sessionId, credsA.sessionId);

  console.log('--- 4. Client A1 terminates ---');
  clientA1.ws.terminate();
  await new Promise((r) => setTimeout(r, 150));

  console.log('--- 5. Room participants check ---');
  console.log('Room size:', room.participants.size, 'keys:', Array.from(room.participants.keys()));
  const participantA = room.participants.get(credsA.sessionId);
  assert.ok(participantA, 'Participant A must not be evicted from room');
  assert.ok(participantA.ws, 'Room must hold active socket for participant A');

  clientA2.ws.terminate();
  clientB.ws.terminate();
});
