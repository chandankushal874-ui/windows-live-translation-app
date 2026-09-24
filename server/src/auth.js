/**
 * auth.js — session token minting and verification.
 *
 * Tokens are HMAC-SHA256 signed JSON blobs. They map an authenticated
 * app install to a specific user identity, language pair, voice persona,
 * and delivery tone, without ever exposing the Ollalink key.
 *
 * Token payload:
 *   {
 *     "sub":   userId (string),
 *     "src":   source language code (e.g. "en"),
 *     "tgt":   target language code (e.g. "hi"),
 *     "voice": voice persona ID (e.g. "nh-m01"),
 *     "tone":  delivery tone (e.g. "natural"),
 *     "iat":   issued-at unix seconds,
 *     "exp":   expiry unix seconds
 *   }
 *
 * Wire format: base64url(json) + "." + base64url(hmac)
 */

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { config } from './config.js';

const B64URL = {
  encode(buf) {
    return Buffer.from(buf).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const pad = '='.repeat((4 - (str.length % 4)) % 4);
    const s = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
    return Buffer.from(s, 'base64');
  },
};

function hmac(data) {
  return createHmac('sha256', config.sessionSecret).update(data).digest();
}

/**
 * Mint a new session token for a user.
 * @param {{ userId: string, sourceLang: string, targetLang: string, voice?: string, tone?: string }} args
 * @returns {{ token: string, expiresAt: number, sessionId: string, voice: string, tone: string }}
 */
export function mintSession({ userId, sourceLang, targetLang, voice = 'nh-m01', tone = 'natural' }) {
  if (!userId || !sourceLang || !targetLang) {
    throw new Error('mintSession: missing userId/sourceLang/targetLang');
  }
  const now = Math.floor(Date.now() / 1000);
  const v = (typeof voice === 'string' && voice.trim()) ? voice.trim() : 'nh-m01';
  const t = (typeof tone === 'string' && tone.trim()) ? tone.trim() : 'natural';

  const payload = {
    sub: userId,
    src: sourceLang,
    tgt: targetLang,
    voice: v,
    tone: t,
    sid: randomUUID(),
    iat: now,
    exp: now + config.sessionTtlSeconds,
  };
  const body = B64URL.encode(JSON.stringify(payload));
  const sig = B64URL.encode(hmac(body));
  return {
    token: `${body}.${sig}`,
    expiresAt: payload.exp * 1000,
    sessionId: payload.sid,
    voice: v,
    tone: t,
  };
}

/**
 * Verify a token. Returns the payload on success, null on any failure.
 * Uses timing-safe comparison on the signature.
 * @param {string} token
 * @returns {{ sub: string, src: string, tgt: string, voice: string, tone: string, sid: string, iat: number, exp: number } | null}
 */
export function verifySession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const dotIdx = token.lastIndexOf('.');
  const body = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expected = B64URL.encode(hmac(body));

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(B64URL.decode(body).toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) return null;
    if (!payload.sub || !payload.src || !payload.tgt || !payload.sid) return null;
    if (!payload.voice) payload.voice = 'nh-m01';
    if (!payload.tone) payload.tone = 'natural';
    return payload;
  } catch {
    return null;
  }
}
