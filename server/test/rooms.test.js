// test/rooms.test.js — unit tests for rooms.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '8787';
process.env.PUBLIC_BASE = 'ws://localhost:8787';
process.env.OLLALINK_DASHBOARD_KEY = 'sk_test';
process.env.OLLALINK_WS_URL = 'wss://example.com';
process.env.SESSION_SECRET = 'test-secret-32-bytes-long-padded!!';
process.env.LOG_LEVEL = 'error';

const { createRoom, getRoom, joinRoom, leaveRoom, others, roomStats } = await import('../src/rooms.js');

function mkParticipant(sid, name = sid) {
  return {
    sessionId: sid, userId: sid, sourceLang: 'en', targetLang: 'hi',
    displayName: name, ws: null, joinedAt: Date.now(),
  };
}

test('createRoom returns 6-char codes that are unique', () => {
  const a = createRoom();
  const b = createRoom();
  assert.equal(a.code.length, 6);
  assert.equal(b.code.length, 6);
  assert.notEqual(a.code, b.code);
  // Alphabet excludes ambiguous chars (0,1,I,O)
  assert.match(a.code, /^[A-HJ-KM-NP-Z2-9]{6}$/);
  leaveRoom(a.code, 'noop'); // touch
});

test('getRoom is case-insensitive', () => {
  const r = createRoom();
  assert.ok(getRoom(r.code.toLowerCase()));
  assert.ok(getRoom(r.code.toUpperCase()));
});

test('join admits up to MAX then rejects', () => {
  const r = createRoom();
  assert.ok(joinRoom(r.code, mkParticipant('s1')));
  assert.ok(joinRoom(r.code, mkParticipant('s2')));
  assert.equal(joinRoom(r.code, mkParticipant('s3')), null);
});

test('join to non-existent room returns null', () => {
  assert.equal(joinRoom('NOTREAL', mkParticipant('s1')), null);
});

test('leave removes participant and destroys empty room', () => {
  const r = createRoom();
  joinRoom(r.code, mkParticipant('s1'));
  joinRoom(r.code, mkParticipant('s2'));
  assert.equal(r.participants.size, 2);
  leaveRoom(r.code, 's1');
  assert.equal(r.participants.size, 1);
  assert.ok(getRoom(r.code));
  leaveRoom(r.code, 's2');
  assert.equal(getRoom(r.code), null);
});

test('others excludes self', () => {
  const r = createRoom();
  joinRoom(r.code, mkParticipant('alice'));
  joinRoom(r.code, mkParticipant('bob'));
  const names = Array.from(others(r.code, 'alice')).map(p => p.userId);
  assert.deepEqual(names, ['bob']);
});

test('roomStats aggregates', () => {
  const before = roomStats();
  const r = createRoom();
  joinRoom(r.code, mkParticipant('x'));
  const after = roomStats();
  assert.equal(after.activeRooms, before.activeRooms + 1);
  assert.equal(after.totalParticipants, before.totalParticipants + 1);
});
