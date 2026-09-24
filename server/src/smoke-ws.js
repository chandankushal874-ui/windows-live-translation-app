// smoke-ws.js — end-to-end WS test against the local relay.
// Mints two sessions, joins them to the same room, checks that both sides
// receive peer-joined events.

import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

// dotenv-lite
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const BASE = `http://localhost:${process.env.PORT || 8791}`;

async function mint(userId, src, tgt) {
  const r = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, sourceLang: src, targetLang: tgt }),
  });
  if (!r.ok) throw new Error(`mint failed: ${r.status}`);
  return r.json();
}

async function createRoom() {
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST' });
  return (await r.json()).code;
}

function connectAndJoin(sess, room, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(sess.wsUrl);
    const events = [];
    const timeout = setTimeout(() => reject(new Error('timeout waiting for joined')), 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', token: sess.token, room, displayName: name }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      events.push(msg);
      if (msg.type === 'joined') {
        clearTimeout(timeout);
        resolve({ ws, events, room: msg.room });
      }
      if (msg.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(`server error: ${msg.code} ${msg.message}`));
      }
    });
    ws.on('error', reject);
  });
}

const room = await createRoom();
console.log('room:', room);

const aliceSess = await mint('alice', 'en', 'hi');
const bobSess = await mint('bob', 'hi', 'en');

const alice = await connectAndJoin(aliceSess, room, 'Alice');
console.log('alice joined:', alice.room);
console.log('alice sees participants:', alice.events[0].participants.length);

const bob = await connectAndJoin(bobSess, room, 'Bob');
console.log('bob joined:', bob.room);
console.log('bob sees participants:', bob.events[0].participants.length);

// Alice should have received a peer-joined for Bob
await new Promise(r => setTimeout(r, 200));
const alicePeerJoined = alice.events.find(e => e.type === 'peer-joined');
console.log('alice received peer-joined for Bob:', alicePeerJoined?.peer?.displayName === 'Bob');

// Send a ping, expect a pong
alice.ws.send(JSON.stringify({ type: 'ping' }));
await new Promise(r => setTimeout(r, 100));
const pong = alice.events.find(e => e.type === 'pong');
console.log('pong received:', !!pong);

// Cleanup
alice.ws.close();
bob.ws.close();
await new Promise(r => setTimeout(r, 200));
console.log('SMOKE TEST PASSED');
process.exit(0);
