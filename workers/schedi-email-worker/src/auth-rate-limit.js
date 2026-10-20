/**
 * Sign-in limits for /auth/tenant and /auth/agency (also the reset routes that
 * call the same helper). One Durable Object named "auth" holds every counter,
 * so the counts are the same in every data centre. The Workers ratelimit
 * binding is per location and was returning success for every attempt.
 *
 * Keys: route + IP (10 / 60s) and route + sha256(normalized email) (5 / 60s).
 * The email itself is never stored or logged. If the object is missing or
 * throws, the check fails open and logs a fixed line.
 */
const WINDOW_MS = 60 * 1000;
const AUTH_IP_LIMIT = 10;
const AUTH_EMAIL_LIMIT = 5;
const OBJECT_NAME = 'auth';

function normalizeChecks(checks) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(checks) ? checks : [];
  for (const check of list) {
    const dimension = check && check.dimension === 'email' ? 'email' : (check && check.dimension === 'ip' ? 'ip' : '');
    if (!dimension) continue;
    const key = String(check.key || '').slice(0, 200);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      dimension,
      limit: dimension === 'email' ? AUTH_EMAIL_LIMIT : AUTH_IP_LIMIT,
    });
  }
  return out.slice(0, 4);
}

function freshTimes(raw, nowMs) {
  const prev = Array.isArray(raw) ? raw : [];
  return prev.filter((t) => {
    const n = Number(t);
    return Number.isFinite(n) && nowMs - n < WINDOW_MS;
  });
}

export async function hitAuthLimits(storage, checks, now) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const run = async (txn) => {
    const blocked = [];
    let retryAfter = 1;
    for (const check of normalizeChecks(checks)) {
      const prev = await txn.get(check.key);
      const times = freshTimes(prev, nowMs);
      if (times.length >= check.limit) {
        const oldest = times.reduce((min, t) => Math.min(min, Number(t)), nowMs);
        const wait = Math.min(60, Math.max(1, Math.ceil((oldest + WINDOW_MS - nowMs) / 1000)));
        if (wait > retryAfter) retryAfter = wait;
        blocked.push(check.dimension);
        if (times.length) await txn.put(check.key, times);
        else await txn.delete(check.key);
      } else {
        times.push(nowMs);
        await txn.put(check.key, times);
      }
    }
    if (blocked.length) return { ok: false, retryAfter, limits: blocked };
    return { ok: true };
  };
  if (storage && typeof storage.transaction === 'function') return storage.transaction(run);
  return run(storage);
}

async function pruneExpired(storage, nowMs) {
  if (!storage || typeof storage.list !== 'function') return;
  let cursor = '';
  try {
    const saved = await storage.get('pruneCursor');
    cursor = typeof saved === 'string' ? saved : '';
  } catch (e) {
    return;
  }
  let listed;
  try {
    const opts = { limit: 100 };
    if (cursor) opts.startAfter = cursor;
    listed = await storage.list(opts);
  } catch (e) {
    return;
  }
  if (!listed || typeof listed[Symbol.iterator] !== 'function') return;
  const entries = [];
  for (const entry of listed) entries.push(entry);
  let last = '';
  for (const entry of entries) {
    const key = entry && entry[0];
    const value = entry && entry[1];
    if (!key || key === 'pruneCursor') continue;
    last = String(key);
    if (!freshTimes(value, nowMs).length) {
      try { await storage.delete(key); } catch (e) { /* keep going */ }
    }
  }
  try {
    if (entries.length < 100) await storage.put('pruneCursor', '');
    else if (last) await storage.put('pruneCursor', last);
  } catch (e) { /* ignore */ }
}

export class AuthRateLimit {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const storage = this.ctx && this.ctx.storage;
    const now = Date.now();
    await pruneExpired(storage, now);
    let body = {};
    try { body = await request.json(); } catch (e) { body = {}; }
    const result = await hitAuthLimits(storage, body && body.checks, now);
    return Response.json(result);
  }
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function routeScope(route) {
  return String(route || 'auth').replace(/[^a-z0-9/_-]/gi, '').slice(0, 40) || 'auth';
}

export function withRetryAfter(response, retryAfter) {
  const headers = new Headers(response.headers);
  const seconds = Math.min(60, Math.max(1, Math.round(Number(retryAfter) || 60)));
  headers.set('Retry-After', String(seconds));
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Returns { ok: true } or { ok: false, retryAfter }. Fails open when the
 * Durable Object binding is missing or the call throws. Callers must not
 * log the email or the password.
 */
export async function authRateLimit(env, { route, ip, email }) {
  const scope = routeScope(route);
  const ns = env && env.AUTH_RATE_LIMIT;
  if (!ns || typeof ns.getByName !== 'function') {
    console.warn('auth rate limit unavailable');
    return { ok: true };
  }
  const checks = [{
    key: scope + '|ip:' + String(ip || 'unknown').slice(0, 64),
    dimension: 'ip',
  }];
  const normalized = String(email || '').trim().toLowerCase();
  if (normalized) {
    const hash = await sha256Hex(normalized);
    checks.push({ key: scope + '|email:' + hash, dimension: 'email' });
  }
  try {
    const stub = ns.getByName(OBJECT_NAME);
    const response = await stub.fetch('https://auth-rate-limit/hit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checks }),
    });
    if (!response || !response.ok) {
      console.warn('auth rate limit unavailable');
      return { ok: true };
    }
    const result = await response.json();
    if (!result || typeof result.ok !== 'boolean') {
      console.warn('auth rate limit unavailable');
      return { ok: true };
    }
    if (result.ok) return { ok: true };
    const dimensions = Array.isArray(result.limits)
      ? result.limits.filter((dimension) => dimension === 'ip' || dimension === 'email')
      : [];
    if (!dimensions.length) console.log('auth rate limit ' + scope);
    for (const dimension of dimensions) console.log('auth rate limit ' + scope + ' ' + dimension);
    const retryAfter = Math.min(60, Math.max(1, Math.round(Number(result.retryAfter) || 60)));
    return { ok: false, retryAfter };
  } catch (e) {
    console.warn('auth rate limit unavailable');
    return { ok: true };
  }
}

export async function rejectIfAuthLimited(env, json, origin, input) {
  const decision = await authRateLimit(env, input);
  if (decision.ok) return null;
  return withRetryAfter(json({ ok: false, error: 'rate_limited' }, 429, origin), decision.retryAfter);
}
