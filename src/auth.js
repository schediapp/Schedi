import crypto from 'node:crypto';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 32).toString('base64url');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'base64url');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function signSession(sessionId, secret) {
  const mac = crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
  return `${sessionId}.${mac}`;
}

export function readSession(signed, secret) {
  if (!signed || !secret) return null;
  const index = signed.lastIndexOf('.');
  if (index <= 0) return null;
  const sessionId = signed.slice(0, index);
  const mac = signed.slice(index + 1);
  const expected = crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  return sessionId;
}

export function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index === -1) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}
