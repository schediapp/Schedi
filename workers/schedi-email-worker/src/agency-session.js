/**
 * Agency / HQ session gate.
 * Cookie name is shared with the public-site worker (worker/public-shell.ts).
 */
import { readSession } from './owner-auth.js';

export const AGENCY_COOKIE = 'schedi_hq';

export function sessionTokenFromRequest(request, body) {
  const header = String((request && request.headers && request.headers.get('X-Schedi-Session')) || '').trim();
  if (header) return header.slice(0, 256);
  const cookie = String((request && request.headers && request.headers.get('Cookie')) || '');
  const parts = cookie.split(';');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== AGENCY_COOKIE) continue;
    const raw = part.slice(idx + 1).trim();
    try { return decodeURIComponent(raw).slice(0, 256); } catch (_) { return raw.slice(0, 256); }
  }
  if (body && body.session) return String(body.session).trim().slice(0, 256);
  return '';
}

/** @returns {{ ok: true, session: object, token: string } | { ok: false, status: number, error: string }} */
export async function requireAgency(env, request, body) {
  const token = sessionTokenFromRequest(request, body || {});
  if (!token) return { ok: false, status: 401, error: 'session_required' };
  const session = await readSession(env, token);
  if (!session) return { ok: false, status: 401, error: 'session_required' };
  if (session.role !== 'agency') return { ok: false, status: 403, error: 'forbidden' };
  return { ok: true, session, token };
}

/**
 * Ops routes that accept a server bearer OR an agency session.
 * A presented session is checked first: unknown → 401, owner → 403, agency → allowed
 * (bearer optional). With no session, only bearerOk is allowed; anything else is 401.
 * @returns {{ ok: true, session: object|null, token: string } | { ok: false, status: number, error: string }}
 */
export async function authorizeBearerOrAgency(env, request, body, bearerOk) {
  const token = sessionTokenFromRequest(request, body || {});
  if (token) {
    const session = await readSession(env, token);
    if (!session) return { ok: false, status: 401, error: 'session_required' };
    if (session.role !== 'agency') return { ok: false, status: 403, error: 'forbidden' };
    return { ok: true, session, token };
  }
  if (bearerOk) return { ok: true, session: null, token: '' };
  return { ok: false, status: 401, error: 'unauthorized' };
}
