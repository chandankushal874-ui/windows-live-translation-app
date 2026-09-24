import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';

process.env.PORT = '33895';
process.env.PUBLIC_BASE = 'ws://localhost:33895';
process.env.OLLALINK_DASHBOARD_KEY = 'sk_f439f7e7394139022af3b458a76008e86e1ba0b93e497207';
process.env.OLLALINK_WS_URL = 'ws://127.0.0.1:33896/v1/speech/stream';
process.env.SESSION_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_TTL_SECONDS = '1800';
process.env.ALLOWED_ORIGINS = 'http://localhost:1420,tauri://localhost';
process.env.LOG_LEVEL = 'error';

const { startServer } = await import('../src/server.js');

let relayHandle;
let mockOllalinkWss;
const upstreamSessions = [];

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: 33895,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function waitType(ws, expectedType, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for message type "${expectedType}"`));
    }, timeoutMs);

    const onMessage = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === expectedType) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(msg);
        }
      } catch {}
    };

    ws.on('message', onMessage);
  });
}

before(async () => {
  mockOllalinkWss = new WebSocketServer({ port: 33896, path: '/v1/speech/stream' });
  mockOllalinkWss.on('connection', (ws) => {
    const sess = { ws, config: null };
    upstreamSessions.push(sess);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'config') {
            sess.config = parsed;
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

test('Dual-Action Host & Join Flow E2E Simulation', async () => {
  // --- STEP 1: Host starts call with room: null ---
  const hostSess = await httpPost('/api/session', {
    userId: 'host-user',
    sourceLang: 'en',
    targetLang: 'hi',
  });
  assert.equal(hostSess.status, 200);

  const hostWs = new WebSocket(hostSess.data.wsUrl);
  await new Promise((r) => hostWs.on('open', r));

  hostWs.send(JSON.stringify({
    type: 'join',
    token: hostSess.data.token,
    room: null, // Host creates fresh room
    displayName: 'Host Alice',
    sourceLang: 'en',
    targetLang: 'hi',
    captionsOn: true,
  }));

  const hostJoined = await waitType(hostWs, 'joined');
  assert.ok(hostJoined.room, 'Room code was generated');
  assert.equal(hostJoined.room.length, 6, 'Room code is 6 characters');
  assert.equal(hostJoined.participants.length, 1, 'Host is alone initially');

  const generatedRoomCode = hostJoined.room;

  // --- STEP 2: Peer joins with the 6-character code ---
  const peerSess = await httpPost('/api/session', {
    userId: 'peer-user',
    sourceLang: 'hi',
    targetLang: 'en',
  });
  assert.equal(peerSess.status, 200);

  const peerWs = new WebSocket(peerSess.data.wsUrl);
  await new Promise((r) => peerWs.on('open', r));

  const hostReceivesPeerJoined = waitType(hostWs, 'peer-joined');

  peerWs.send(JSON.stringify({
    type: 'join',
    token: peerSess.data.token,
    room: generatedRoomCode,
    displayName: 'Peer Rahul',
    sourceLang: 'hi',
    targetLang: 'en',
    captionsOn: true,
  }));

  const peerJoined = await waitType(peerWs, 'joined');
  assert.equal(peerJoined.room, generatedRoomCode);
  assert.equal(peerJoined.participants.length, 2, 'Both participants present in room');

  const peerEventOnHost = await hostReceivesPeerJoined;
  assert.equal(peerEventOnHost.peer.displayName, 'Peer Rahul');
  assert.equal(peerEventOnHost.peer.sourceLang, 'hi');

  // --- STEP 3: 3rd User tries to join -> rejected immediately with room-full ---
  const intruderSess = await httpPost('/api/session', {
    userId: 'intruder-user',
    sourceLang: 'es',
    targetLang: 'es',
  });
  const intruderWs = new WebSocket(intruderSess.data.wsUrl);
  await new Promise((r) => intruderWs.on('open', r));

  intruderWs.send(JSON.stringify({
    type: 'join',
    token: intruderSess.data.token,
    room: generatedRoomCode,
    displayName: 'Intruder Eve',
  }));

  const errFrame = await waitType(intruderWs, 'error');
  assert.equal(errFrame.code, 'room-full');
  assert.ok(errFrame.message.includes('full'));
  intruderWs.close();

  // --- STEP 4: Peer leaves -> Host receives peer-left ---
  const hostReceivesPeerLeft = waitType(hostWs, 'peer-left');
  peerWs.close();

  const leftEvent = await hostReceivesPeerLeft;
  assert.equal(leftEvent.sessionId, peerSess.data.sessionId);

  // --- STEP 5: Peer reconnects with code -> Re-enters successfully ---
  const peerReconnectSess = await httpPost('/api/session', {
    userId: 'peer-user-2',
    sourceLang: 'hi',
    targetLang: 'en',
  });
  const peerReconnectWs = new WebSocket(peerReconnectSess.data.wsUrl);
  await new Promise((r) => peerReconnectWs.on('open', r));

  const hostReceivesSecondPeerJoined = waitType(hostWs, 'peer-joined');

  peerReconnectWs.send(JSON.stringify({
    type: 'join',
    token: peerReconnectSess.data.token,
    room: generatedRoomCode,
    displayName: 'Peer Rahul Reconnected',
    sourceLang: 'hi',
    targetLang: 'en',
  }));

  const peerRejoined = await waitType(peerReconnectWs, 'joined');
  assert.equal(peerRejoined.room, generatedRoomCode);
  assert.equal(peerRejoined.participants.length, 2);

  const secondJoinEvent = await hostReceivesSecondPeerJoined;
  assert.equal(secondJoinEvent.peer.displayName, 'Peer Rahul Reconnected');

  hostWs.close();
  peerReconnectWs.close();
});