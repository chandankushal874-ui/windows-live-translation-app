/**
 * rooms.js â€” in-memory room registry.
 *
 * Rooms are created when the first participant joins a room code, and destroyed
 * when empty. v1 caps at 2 participants; the Participant schema leaves room
 * for a v2 bump to 4 without migration.
 *
 * Rooms are NOT pre-provisioned. Anyone with the 6-letter code can join
 * while a seat is available. For v1 this is sufficient; authentication
 * hardening (user accounts) is a v2 concern.
 */

import { randomBytes } from 'node:crypto';
import { log } from './config.js';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // excludes 1,I,O,0
const ROOM_CODE_LEN = 6;
const MAX_PARTICIPANTS_DEFAULT = parseInt(process.env.MAX_PARTICIPANTS || '2', 10);
const ROOM_IDLE_TTL_MS = 2 * 60 * 1000;     // destroy an empty room after 2 min
const ROOM_ACTIVE_TTL_MS = 8 * 60 * 60 * 1000; // hard cap an active call at 8 hr

/**
 * @typedef {{
 *   sessionId: string,
 *   userId: string,
 *   sourceLang: string,
 *   targetLang: string,
 *   displayName: string,
 *   captionsOn: boolean,
 *   ws: import('ws').WebSocket | null,
 *   joinedAt: number
 * }} Participant
 *
 * @typedef {{
 *   code: string,
 *   participants: Map<string, Participant>,  // keyed by sessionId
 *   createdAt: number,
 *   lastActivityAt: number,
 *   maxParticipants: number
 * }} Room
 */

/** @type {Map<string, Room>} */
const rooms = new Map();

function generateRoomCode() {
  // Rejection-safe: extremely low collision rate at 6 chars from 31 alphabet
  // (~887M possibilities). Loop until unique.
  for (let attempt = 0; attempt < 32; attempt++) {
    const bytes = randomBytes(ROOM_CODE_LEN);
    let code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error('room code space exhausted (unlikely)');
}

export function createRoom(maxParticipants = MAX_PARTICIPANTS_DEFAULT) {
  const code = generateRoomCode();
  const now = Date.now();
  const room = {
    code,
    participants: new Map(),
    createdAt: now,
    lastActivityAt: now,
    maxParticipants: (typeof maxParticipants === 'number' && maxParticipants >= 2 && maxParticipants <= 8) ? maxParticipants : MAX_PARTICIPANTS_DEFAULT,
  };
  rooms.set(code, room);
  log.info(`room created: ${code}`);
  return room;
}

export function getRoom(code) {
  if (!code) return null;
  return rooms.get(code.toUpperCase()) ?? null;
}

export function isValidRoomCode(code) {
  if (typeof code !== 'string') return false;
  const trimmed = code.trim().toUpperCase();
  if (trimmed.length !== ROOM_CODE_LEN) return false;
  for (const c of trimmed) {
    if (!ROOM_CODE_ALPHABET.includes(c)) return false;
  }
  return true;
}

function touch(room) {
  room.lastActivityAt = Date.now();
}

/**
 * @returns {Participant | null} The new participant on success; null if room is full/missing.
 */
export function joinRoom(code, participant) {
  const room = getRoom(code);
  if (!room) return null;
  if (room.participants.size >= room.maxParticipants) return null;
  room.participants.set(participant.sessionId, participant);
  touch(room);
  log.info(`room ${room.code}: ${participant.displayName} joined (${room.participants.size}/${room.maxParticipants})`);
  return participant;
}

export function leaveRoom(code, sessionId) {
  const room = getRoom(code);
  if (!room) return false;
  const removed = room.participants.delete(sessionId);
  if (removed) {
    touch(room);
    log.info(`room ${room.code}: ${sessionId} left (${room.participants.size}/${room.maxParticipants})`);
  }
  if (room.participants.size === 0) {
    rooms.delete(room.code);
    log.info(`room destroyed: ${room.code}`);
  }
  return removed;
}

/** Iterate non-self participants in a room (for broadcasts). */
export function* others(roomCode, selfSessionId) {
  const room = getRoom(roomCode);
  if (!room) return;
  for (const p of room.participants.values()) {
    if (p.sessionId !== selfSessionId) yield p;
  }
}

export function roomStats() {
  return {
    activeRooms: rooms.size,
    totalParticipants: Array.from(rooms.values()).reduce((n, r) => n + r.participants.size, 0),
  };
}

/**
 * Periodic sweep: destroy rooms that have sat empty (paranoia â€” leaveRoom
 * normally does this) or have been running past a hard cap.
 */
export function startRoomSweeper() {
  const handle = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const emptyAndIdle = room.participants.size === 0 && now - room.lastActivityAt > ROOM_IDLE_TTL_MS;
      const tooOld = now - room.createdAt > ROOM_ACTIVE_TTL_MS;
      if (emptyAndIdle || tooOld) {
        log.warn(`sweeping room ${room.code} (${emptyAndIdle ? 'empty+idle' : 'too old'})`);
        for (const p of room.participants.values()) {
          try { p.ws?.terminate(); } catch { /* ignore */ }
        }
        rooms.delete(room.code);
      }
    }
  }, 60_000);
  handle.unref?.();
  return handle;
}

