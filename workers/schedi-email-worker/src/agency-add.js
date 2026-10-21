/**
 * One-time HQ login add. POST /admin/agency-add
 * Requires an agency session AND Authorization: Bearer <MIGRATION_TOKEN>.
 * ensureAgencySecret writes agency:<email> only when that key has no hash.
 */
import { requireAgency } from './agency-session.js';
import { ensureAgencySecret } from './owner-auth.js';

const AGENCY_PASSWORD_MIN = 8;
const EMAIL_RE = /^[^\s@<>()[\],;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function timingSafeEqualStr(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  let diff = left.length ^ right.length;
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return diff === 0;
}

function migrationBearerOk(request, env) {
  const expected = String((env && env.MIGRATION_TOKEN) || '').trim();
  const auth = String((request.headers && request.headers.get('Authorization')) || '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!expected || expected.length < 32 || !given) return false;
  return timingSafeEqualStr(given, expected);
}

export async function handleAgencyAdd(request, env, origin, json) {
  let body = {};
  if (request.method === 'POST') {
    try { body = await request.json(); } catch (_) { body = {}; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
  }

  const gate = await requireAgency(env, request, body);
  if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status, origin);
  if (!migrationBearerOk(request, env)) return json({ ok: false, error: 'unauthorized' }, 401, origin);
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);

  const email = String(body.email || '').trim().toLowerCase();
  const password = body.password;
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'invalid_email' }, 400, origin);
  if (typeof password !== 'string' || password.length < AGENCY_PASSWORD_MIN) {
    return json({ ok: false, error: 'invalid_password' }, 400, origin);
  }

  const saved = await ensureAgencySecret(env, email, password);
  if (!saved || !saved.ok) {
    const error = (saved && saved.error) || 'agency_add_failed';
    const status = error === 'auth_not_configured' ? 500 : 400;
    return json({ ok: false, error }, status, origin);
  }
  return json({ ok: true, created: !saved.existed }, 200, origin);
}
