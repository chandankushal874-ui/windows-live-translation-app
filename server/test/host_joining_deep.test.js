import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';

const TEST_PORT = 33910;
const MOCK_OLLALINK_PORT = 33911;

process.env.PORT = String(TEST_PORT);
process.env.PUBLIC_BASE = `ws://localhost:${TEST_PORT}`;
process.env.OLLALINK_DASHBOARD_KEY = 'sk_f439f7e7394139022af3b458a76008e86e1ba0b93e497207';
process.env.OLLALINK_WS_URL = `ws://127.0.0.1:${MOCK_OLLALINK_PORT}/v1/speech/stream`;
process.env.SESSION_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_TTL_SECONDS = '1800';
process.env.ALLOWED_ORIGINS = 'http://localhost:1420,tauri://localhost';
process.env.LOG_LEVEL = 'error';

const { startServer } = await import('../src/server.js');
const { isValidRoomCode, getRoom } = await import('../src/rooms.js');

let relayHandle;
let mockOllalinkWss;
const upstreamConfigs = [];

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
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

function waitType(ws, expectedType, timeoutMs = 2500) {
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

function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

before(async () => {
  mockOllalinkWss = new WebSocketServer({ port: MOCK_OLLALINK_PORT, path: '/v1/speech/stream' });
  mockOllalinkWss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'config') {
            upstreamConfigs.push(parsed);
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

test('DEEP TEST 1: Room Code Validation Logic', () => {
  assert.equal(isValidRoomCode('ABC234'), true);
  assert.equal(isValidRoomCode('TD6DPX'), true);
  assert.equal(isValidRoomCode('td6dpx'), true, 'Lowercase should normalize to uppercase');

  assert.equal(isValidRoomCode('ABC123'), false, '1 is excluded from alphabet');
  assert.equal(isValidRoomCode('ABCD0E'), false, '0 is excluded from alphabet');
  assert.equal(isValidRoomCode('ABCOEE'), false, 'O is excluded from alphabet');
  assert.equal(isValidRoomCode('ABCIEE'), false, 'I is excluded from alphabet');

  assert.equal(isValidRoomCode(''), false);
  assert.equal(isValidRoomCode('ABC'), false);
  assert.equal(isValidRoomCode('TOOLONG123'), false);
  assert.equal(isValidRoomCode(null), false);
});

test('DEEP TEST 2: Host Creates Room -> In Waiting State with Generated Code', async () => {
  const hostSess = await httpPost('/api/session', {
    userId: 'host-user-1',
    sourceLang: 'en',
    targetLang: 'hi',
  });
  assert.equal(hostSess.status, 200);

  const hostWs = await connectWs(hostSess.data.wsUrl);

  hostWs.send(JSON.stringify({
    type: 'join',
    token: hostSess.data.token,
    room: null,
    displayName: 'Alex (Host)',
    sourceLang: 'en',
    targetLang: 'hi',
    captionsOn: true,
  }));

  const joined = await waitType(hostWs, 'joined');
  assert.ok(joined.room, 'Host received generated room code');
  assert.equal(joined.room.length, 6);
  assert.equal(isValidRoomCode(joined.room), true);
  assert.equal(joined.self.displayName, 'Alex (Host)');
  assert.equal(joined.participants.length, 1);
  assert.equal(joined.participants[0].displayName, 'Alex (Host)');

  const peer = joined.participants.find((p) => p.sessionId !== joined.self.sessionId);
  assert.equal(peer, undefined, 'Host is initially alone in waiting state');

  hostWs.close();
});

test('DEEP TEST 3: Guest Joins with Code and Name -> Discovers Host Immediately', async () => {
  const hostSess = await httpPost('/api/session', {
    userId: 'host-user-2',
    sourceLang: 'en',
    targetLang: 'hi',
  });
  const hostWs = await connectWs(hostSess.data.wsUrl);
  hostWs.send(JSON.stringify({
    type: 'join',
    token: hostSess.data.token,
    room: null,
    displayName: 'Host Alice',
    sourceLang: 'en',
    targetLang: 'hi',
  }));
  const hostJoined = await waitType(hostWs, 'joined');
  const roomCode = hostJoined.room;

  const guestSess = await httpPost('/api/session', {
    userId: 'guest-user-2',
    sourceLang: 'hi',
    targetLang: 'en',
  });
  const guestWs = await connectWs(guestSess.data.wsUrl);

  const hostReceivesPeerJoinedPromise = waitType(hostWs, 'peer-joined');

  guestWs.send(JSON.stringify({
    type: 'join',
    token: guestSess.data.token,
    room: roomCode.toLowerCase(),
    displayName: 'Guest Rahul',
    sourceLang: 'hi',
    targetLang: 'en',
  }));

  const guestJoined = await waitType(guestWs, 'joined');
  assert.equal(guestJoined.room, roomCode);
  assert.equal(guestJoined.participants.length, 2, 'Guest sees both participants on arrival');

  const hostPeer = guestJoined.participants.find((p) => p.sessionId !== guestJoined.self.sessionId);
  assert.ok(hostPeer, 'Guest immediately discovers Host');
  assert.equal(hostPeer.displayName, 'Host Alice');
  assert.equal(hostPeer.sourceLang, 'en');
  assert.equal(hostPeer.targetLang, 'hi');

  const hostPeerEvent = await hostReceivesPeerJoinedPromise;
  assert.equal(hostPeerEvent.peer.displayName, 'Guest Rahul');
  assert.equal(hostPeerEvent.peer.sourceLang, 'hi');
  assert.equal(hostPeerEvent.peer.targetLang, 'en');

  hostWs.close();
  guestWs.close();
});

test('DEEP TEST 4: Non-Existent Room Code Join Rejection', async () => {
  const guestSess = await httpPost('/api/session', {
    userId: 'guest-user-4',
    sourceLang: 'en',
    targetLang: 'hi',
  });
  const guestWs = await connectWs(guestSess.data.wsUrl);

  guestWs.send(JSON.stringify({
    type: 'join',
    token: guestSess.data.token,
    room: 'XX99ZZ',
    displayName: 'Lost Guest',
  }));

  const err = await waitType(guestWs, 'error');
  assert.equal(err.code, 'no-room');
  assert.ok(err.message.includes('not found') || err.message.includes('XX99ZZ') || err.message.includes('no room'));

  guestWs.close();
});

test('DEEP TEST 5: Full Room Seat Enforcement (Max 2 Participants)', async () => {
  const hostSess = await httpPost('/api/session', {
    userId: 'host-5',
    sourceLang: 'en',
    targetLang: 'hi',
  });
  assert.equal(hostSess.status, 200);
  const hostWs = await connectWs(hostSess.data.wsUrl);
  hostWs.send(JSON.stringify({
    type: 'join',
    token: hostSess.data.token,
    room: null,
    displayName: 'Host 5',
  }));
  const hostJoined = await waitType(hostWs, 'joined');
  const code = hostJoined.room;

  const g1Sess = await httpPost('/api/session', {
    userId: 'g1-5',
    sourceLang: 'hi',
    targetLang: 'en',
  });
  assert.equal(g1Sess.status, 200);
  const g1Ws = await connectWs(g1Sess.data.wsUrl);
  g1Ws.send(JSON.stringify({
    type: 'join',
    token: g1Sess.data.token,
    room: code,
    displayName: 'Guest 1',
  }));
  await waitType(g1Ws, 'joined');

  const g2Sess = await httpPost('/api/session', {
    userId: 'g2-5',
    sourceLang: 'es',
    targetLang: 'en',
  });
  assert.equal(g2Sess.status, 200);
  const g2Ws = await connectWs(g2Sess.data.wsUrl);
  g2Ws.send(JSON.stringify({
    type: 'join',
    token: g2Sess.data.token,
    room: code,
    displayName: 'Guest 2',
  }));

  const err = await waitType(g2Ws, 'error');
  assert.equal(err.code, 'room-full');
  assert.ok(err.message.includes('full'));

  hostWs.close();
  g1Ws.close();
  g2Ws.close();
});

test('DEEP TEST 6: Participant Disconnection & Role-Aware Peer Left', async () => {
  const hostSess = await httpPost('/api/session', {
    userId: 'host-6',
    sourceLang: 'en',
    targetLang: 'hi',
  });
  assert.equal(hostSess.status, 200);
  const hostWs = await connectWs(hostSess.data.wsUrl);
  hostWs.send(JSON.stringify({
    type: 'join',
    token: hostSess.data.token,
    room: null,
    displayName: 'Host 6',
  }));
  const { room } = await waitType(hostWs, 'joined');

  const guestSess = await httpPost('/api/session', {
    userId: 'guest-6',
    sourceLang: 'hi',
    targetLang: 'en',
  });
  assert.equal(guestSess.status, 200);
  const guestWs = await connectWs(guestSess.data.wsUrl);
  guestWs.send(JSON.stringify({
    type: 'join',
    token: guestSess.data.token,
    room,
    displayName: 'Guest 6',
  }));
  await waitType(guestWs, 'joined');

  const hostReceivesLeft = waitType(hostWs, 'peer-left');
  guestWs.close();

  const leftMsg = await hostReceivesLeft;
  assert.equal(leftMsg.sessionId, guestSess.data.sessionId);

  const roomObj = getRoom(room);
  assert.ok(roomObj);
  assert.equal(roomObj.participants.size, 1);

  hostWs.close();
  await new Promise((r) => setTimeout(r, 60));

  const deadRoom = getRoom(room);
  assert.equal(deadRoom, null, 'Room garbage-collected after all participants leave');
});
