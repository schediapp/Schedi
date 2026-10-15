/**
 * One-time maintenance: which tenant logins still use the old default provision password.
 *
 * GET|POST /api/ops-default-passwords
 *   Agency session (X-Schedi-Session, schedi_hq cookie, or JSON session)
 *   AND Authorization: Bearer <OPS_SNAPSHOT_TOKEN>
 *
 * Read-only. For each AUTH_KV `tenant:*` password record, hashes that default
 * with the record's salt and AUTH_PEPPER via passwordMatches (existing PBKDF2
 * hash, then a constant-time compare). Returns matching tenant ids only.
 * Never returns hashes, salts, or the password. Does not write KV.
 */

import { authReady, passwordMatches, readSession } from './owner-auth.js';

const LEGACY_DEFAULT_PASSWORD = 'vance123';
const AGENCY_COOKIE = 'schedi_hq';

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  if (aa.byteLength !== bb.byteLength) return false;
  let out = 0;
  for (let i = 0; i < aa.byteLength; i++) out |= aa[i] ^ bb[i];
  return out === 0;
}

function auditJson(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}

function bearerMatches(request, env) {
  const expected = String(env.OPS_SNAPSHOT_TOKEN || '').trim();
  const auth = String(request.headers.get('Authorization') || '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return !!(expected && given && timingSafeEqualStr(given, expected));
}

function cookieToken(request) {
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
  return '';
}

function sessionTokenFromRequest(request, body) {
  const header = String((request && request.headers && request.headers.get('X-Schedi-Session')) || '').trim();
  if (header) return header.slice(0, 256);
  const fromCookie = cookieToken(request);
  if (fromCookie) return fromCookie;
  if (body && body.session) return String(body.session).trim().slice(0, 256);
  return '';
}

async function requireAgency(env, request, body) {
  const token = sessionTokenFromRequest(request, body || {});
  if (!token) return { ok: false, status: 401, error: 'session_required' };
  const session = await readSession(env, token);
  if (!session) return { ok: false, status: 401, error: 'session_required' };
  if (session.role !== 'agency') return { ok: false, status: 403, error: 'forbidden' };
  return { ok: true, session };
}

function tenantIdFromKey(name) {
  if (typeof name !== 'string' || name.indexOf('tenant:') !== 0) return '';
  const id = name.slice('tenant:'.length);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return '';
  return id;
}

async function listTenantKeys(kv) {
  const names = [];
  let cursor;
  let pages = 0;
  do {
    const page = await kv.list({ prefix: 'tenant:', cursor, limit: 1000 });
    for (const key of page.keys || []) {
      if (key && key.name) names.push(key.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
    pages += 1;
  } while (cursor && pages < 50);
  return names;
}

async function readPasswordRecord(kv, name) {
  let raw;
  try { raw = await kv.get(name); } catch (_) { return null; }
  if (!raw || typeof raw !== 'string') return null;
  try {
    const record = JSON.parse(raw);
    if (!record || typeof record !== 'object') return null;
    if (!record.salt || !record.hash) return null;
    return record;
  } catch (_) {
    return null;
  }
}

export async function handleDefaultPasswordAudit(request, env) {
  if (!request || (request.method !== 'GET' && request.method !== 'POST')) {
    return auditJson({ ok: false, error: 'method_not_allowed' }, 405);
  }
  if (!bearerMatches(request, env || {})) return auditJson({ ok: false, error: 'unauthorized' }, 401);
  let body = {};
  if (request.method === 'POST') {
    try { body = await request.clone().json(); } catch (_) { body = {}; }
  }
  const gate = await requireAgency(env, request, body);
  if (!gate.ok) return auditJson({ ok: false, error: gate.error }, gate.status);
  if (!authReady(env) || typeof env.AUTH_KV.list !== 'function') {
    return auditJson({ ok: false, error: 'auth_not_configured' }, 500);
  }
  try {
    const names = await listTenantKeys(env.AUTH_KV);
    const matches = [];
    for (const name of names) {
      const tenantId = tenantIdFromKey(name);
      if (!tenantId) continue;
      const record = await readPasswordRecord(env.AUTH_KV, name);
      if (!record) continue;
      // Hashes LEGACY_DEFAULT_PASSWORD with record.salt and AUTH_PEPPER, then compares in constant time.
      if (await passwordMatches(LEGACY_DEFAULT_PASSWORD, record, env.AUTH_PEPPER)) matches.push(tenantId);
    }
    matches.sort();
    return auditJson({ ok: true, tenantIds: matches }, 200);
  } catch (_) {
    return auditJson({ ok: false, error: 'audit_failed' }, 500);
  }
}
