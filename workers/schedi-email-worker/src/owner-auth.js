import { clientIp, rejectIfAuthLimited } from './rate-limit.js';

const PBKDF2_ITERATIONS = 100000;

function bytesToB64(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

function b64ToBytes(value) {
  const binary = atob(String(value || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function pbkdf2(password, saltB64, pepper) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password) + '\n' + String(pepper || '')),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(saltB64), iterations: PBKDF2_ITERATIONS },
    material,
    256
  );
  return bytesToB64(new Uint8Array(bits));
}

function timingSafeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function readJson(kv, key) {
  if (!kv) return null;
  const raw = await kv.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function authReady(env) {
  return !!(env && env.AUTH_KV && env.AUTH_PEPPER);
}

async function hashPassword(password, pepper) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const saltB64 = bytesToB64(salt);
  return { salt: saltB64, hash: await pbkdf2(password, saltB64, pepper), iterations: PBKDF2_ITERATIONS };
}

async function saveOwnerSecret(env, email, tenantId, password) {
  const normalized = String(email || '').trim().toLowerCase();
  const id = String(tenantId || '').trim();
  if (!authReady(env) || !normalized || !id || String(password || '').length < 8) {
    return { ok: false, error: 'invalid_password' };
  }
  const previous = await readJson(env.AUTH_KV, 'tenant:' + id);
  const record = await hashPassword(password, env.AUTH_PEPPER);
  record.email = normalized;
  record.tenantId = id;
  record.updatedAt = Date.now();
  await env.AUTH_KV.put('tenant:' + id, JSON.stringify(record));
  if (previous && previous.email && previous.email !== normalized) {
    await removeTenantFromEmailIndex(env, previous.email, id);
  }
  await addTenantToEmailIndex(env, normalized, id);
  return { ok: true };
}

async function removeTenantFromEmailIndex(env, email, tenantId) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return;
  const index = await readJson(env.AUTH_KV, 'email:' + normalized);
  if (!index || !Array.isArray(index.tenantIds)) return;
  const ids = index.tenantIds.filter((existing) => existing !== tenantId);
  if (!ids.length) await env.AUTH_KV.delete('email:' + normalized);
  else await env.AUTH_KV.put('email:' + normalized, JSON.stringify({ tenantIds: ids }));
}

async function addTenantToEmailIndex(env, email, tenantId) {
  const index = (await readJson(env.AUTH_KV, 'email:' + email)) || { tenantIds: [] };
  const ids = Array.isArray(index.tenantIds) ? index.tenantIds.slice() : [];
  if (!ids.includes(tenantId)) ids.push(tenantId);
  await env.AUTH_KV.put('email:' + email, JSON.stringify({ tenantIds: ids }));
}

async function rebindOwnerEmail(env, tenantId, nextEmail) {
  const id = String(tenantId || '').trim();
  const normalized = String(nextEmail || '').trim().toLowerCase();
  if (!id || !normalized || normalized.indexOf('@') < 1) return { ok: false, error: 'invalid_email' };
  const record = await readJson(env.AUTH_KV, 'tenant:' + id);
  if (!record || !record.hash) return { ok: false, error: 'no_password' };
  const previous = record.email;
  record.email = normalized;
  record.tenantId = id;
  await env.AUTH_KV.put('tenant:' + id, JSON.stringify(record));
  if (previous && previous !== normalized) await removeTenantFromEmailIndex(env, previous, id);
  await addTenantToEmailIndex(env, normalized, id);
  return { ok: true };
}

async function renameOwnerSecret(env, fromId, toId) {
  const source = String(fromId || '').trim();
  const dest = String(toId || '').trim();
  if (!source || !dest || source === dest) return { ok: true };
  const record = await readJson(env.AUTH_KV, 'tenant:' + source);
  if (!record || !record.hash) return { ok: true, missing: true };
  record.tenantId = dest;
  await env.AUTH_KV.put('tenant:' + dest, JSON.stringify(record));
  await env.AUTH_KV.delete('tenant:' + source);
  if (record.email) {
    await removeTenantFromEmailIndex(env, record.email, source);
    await addTenantToEmailIndex(env, record.email, dest);
  }
  return { ok: true };
}

async function saveAgencySecret(env, email, password) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!authReady(env) || !normalized || String(password || '').length < 8) {
    return { ok: false, error: 'invalid_password' };
  }
  const record = await hashPassword(password, env.AUTH_PEPPER);
  record.email = normalized;
  await env.AUTH_KV.put('agency:' + normalized, JSON.stringify(record));
  return { ok: true };
}

async function passwordMatches(password, record, pepper) {
  if (!record || !record.salt || !record.hash) return false;
  const actual = await pbkdf2(password, record.salt, pepper);
  return timingSafeEqual(actual, record.hash);
}

async function createSession(env, payload) {
  const token = randomToken();
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  await env.AUTH_KV.put('session:' + token, JSON.stringify(Object.assign({ exp: exp }, payload)), {
    expirationTtl: 12 * 60 * 60,
  });
  return { token: token, expiresAt: exp };
}

async function readLogoWriteSession(env, token) {
  const value = String(token || '').trim();
  if (!value || !env || !env.AUTH_KV) return null;
  const session = await readJson(env.AUTH_KV, 'session:' + value);
  if (!session) return null;
  if (Number(session.exp || 0) < Date.now()) {
    if (session.role === 'owner') return { role: 'owner', tenantId: session.tenantId, expired: true };
    return null;
  }
  if (session.role === 'owner' && session.tenantId) {
    // Set by owner password reset/change (owner-reset.js): sessions created before it are signed out.
    const notBefore = Number((await env.AUTH_KV.get('sessrevoke:' + session.tenantId)) || 0);
    const createdAt = Number(session.exp || 0) - 12 * 60 * 60 * 1000;
    if (notBefore && createdAt < notBefore) return null;
  }
  return session;
}

async function readSession(env, token) {
  const session = await readLogoWriteSession(env, token);
  if (!session || session.expired) return null;
  return session;
}

// Remove a business's owner login (business deleted). Leaves other businesses on that email alone.
async function deleteOwnerSecret(env, tenantId) {
  const id = String(tenantId || '').trim();
  if (!env || !env.AUTH_KV || !id) return { ok: false };
  const record = await readJson(env.AUTH_KV, 'tenant:' + id);
  await env.AUTH_KV.delete('tenant:' + id);
  if (record && record.email) await removeTenantFromEmailIndex(env, record.email, id);
  return { ok: true };
}

// Drop logins whose business no longer exists (deleted earlier without cleanup). Unknown = keep.
async function liveTenantIds(ids, deps) {
  if (!deps || typeof deps.tenantExists !== 'function' || ids.length < 2) return ids;
  const checks = await Promise.all(ids.map((id) => deps.tenantExists(id).catch(() => null)));
  return ids.filter((id, i) => checks[i] !== false);
}

const AGENCY_COOKIE = 'schedi_hq';

function agencySessionCookie(token, clear) {
  const value = clear ? '' : encodeURIComponent(String(token || ''));
  const maxAge = clear ? '0' : String(12 * 60 * 60);
  return AGENCY_COOKIE + '=' + value + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + maxAge;
}

function withSetCookie(response, cookie) {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cookie);
  return new Response(response.body, { status: response.status, headers });
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
    try { return decodeURIComponent(raw).slice(0, 256); } catch (e) { return raw.slice(0, 256); }
  }
  return '';
}

export async function handleAuthRequest(request, env, origin, path, json, deps) {
  if (path === '/auth/logout') {
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    }
    let body = {};
    try { body = await request.json(); } catch (e) { body = {}; }
    const token = String((body && body.session) || cookieToken(request) || '').trim().slice(0, 256);
    if (token && env && env.AUTH_KV) {
      try { await env.AUTH_KV.delete('session:' + token); } catch (e) {}
    }
    return withSetCookie(json({ ok: true }, 200, origin), agencySessionCookie('', true));
  }
  if (!authReady(env)) {
    return json({ ok: false, error: 'auth_not_configured' }, 500, origin);
  }
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
  }
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const email = String(body.email || body.ownerEmail || '').trim().toLowerCase();
  const password = String(body.password || body.ownerPassword || '');

  // Before the password check. The counter is shared across data centres.
  if (path === '/auth/agency' || path === '/auth/tenant') {
    const limited = await rejectIfAuthLimited(env, json, origin, { route: path, ip: clientIp(request), email });
    if (limited) return limited;
  }

  if (path === '/auth/agency') {
    const record = await readJson(env.AUTH_KV, 'agency:' + email);
    if (!(await passwordMatches(password, record, env.AUTH_PEPPER))) {
      return json({ ok: false, error: 'invalid_login' }, 401, origin);
    }
    const session = await createSession(env, { role: 'agency', email: email });
    return withSetCookie(
      json({ ok: true, role: 'agency', email: email, session: session.token, expiresAt: session.expiresAt }, 200, origin),
      agencySessionCookie(session.token, false)
    );
  }

  if (path === '/auth/tenant') {
    const index = await readJson(env.AUTH_KV, 'email:' + email);
    const ids = index && Array.isArray(index.tenantIds) ? index.tenantIds : [];
    const matches = [];
    for (const id of ids) {
      const record = await readJson(env.AUTH_KV, 'tenant:' + id);
      if (record && record.email === email && await passwordMatches(password, record, env.AUTH_PEPPER)) {
        matches.push(id);
      }
    }
    const live = matches.length > 1 ? await liveTenantIds(matches.slice(), deps) : matches.slice();
    if (live.length !== 1) {
      return json({ ok: false, error: live.length > 1 ? 'ambiguous_login' : 'invalid_login' }, 401, origin);
    }
    const session = await createSession(env, { role: 'owner', email: email, tenantId: live[0] });
    return json({ ok: true, role: 'owner', email: email, tenantId: live[0], session: session.token, expiresAt: session.expiresAt }, 200, origin);
  }

  if (path === '/auth/password') {
    const session = await readSession(env, body.session);
    if (!session) return json({ ok: false, error: 'session_required' }, 401, origin);
    const tenantId = String(body.tenantId || '').trim();
    const nextEmail = String(body.ownerEmail || body.email || '').trim().toLowerCase();
    const nextPassword = String(body.newPassword || body.password || '');
    if (!tenantId || !nextEmail || nextPassword.length < 8) {
      return json({ ok: false, error: 'invalid_password' }, 400, origin);
    }
    if (session.role === 'owner' && session.tenantId !== tenantId) {
      return json({ ok: false, error: 'forbidden' }, 403, origin);
    }
    if (session.role !== 'owner' && session.role !== 'agency') {
      return json({ ok: false, error: 'forbidden' }, 403, origin);
    }
    const saved = await saveOwnerSecret(env, nextEmail, tenantId, nextPassword);
    if (!saved.ok) return json(saved, 400, origin);
    return json({ ok: true }, 200, origin);
  }

  if (path === '/auth/email') {
    const session = await readSession(env, body.session);
    if (!session) return json({ ok: false, error: 'session_required' }, 401, origin);
    const tenantId = String(body.tenantId || '').trim();
    const nextEmail = String(body.ownerEmail || body.email || '').trim().toLowerCase();
    if (session.role === 'owner' && session.tenantId !== tenantId) {
      return json({ ok: false, error: 'forbidden' }, 403, origin);
    }
    if (session.role !== 'owner' && session.role !== 'agency') {
      return json({ ok: false, error: 'forbidden' }, 403, origin);
    }
    const moved = await rebindOwnerEmail(env, tenantId, nextEmail);
    if (!moved.ok) return json(moved, 400, origin);
    return json({ ok: true }, 200, origin);
  }

  if (path === '/auth/rename') {
    const session = await readSession(env, body.session);
    if (!session) return json({ ok: false, error: 'session_required' }, 401, origin);
    const fromId = String(body.fromId || '').trim();
    const toId = String(body.toId || '').trim();
    if (session.role === 'owner' && session.tenantId !== fromId) {
      return json({ ok: false, error: 'forbidden' }, 403, origin);
    }
    if (session.role !== 'owner' && session.role !== 'agency') {
      return json({ ok: false, error: 'forbidden' }, 403, origin);
    }
    const renamed = await renameOwnerSecret(env, fromId, toId);
    if (!renamed.ok) return json(renamed, 400, origin);
    return json({ ok: true }, 200, origin);
  }

  return json({ ok: false, error: 'not_found' }, 404, origin);
}

export async function ensureAgencySecret(env, email, password) {
  if (!authReady(env)) return { ok: false, error: 'auth_not_configured' };
  const normalized = String(email || '').trim().toLowerCase();
  const existing = await readJson(env.AUTH_KV, 'agency:' + normalized);
  if (existing && existing.hash) return { ok: true, existed: true };
  return saveAgencySecret(env, normalized, password);
}

export { saveOwnerSecret, deleteOwnerSecret, authReady, readSession, readLogoWriteSession, passwordMatches };
