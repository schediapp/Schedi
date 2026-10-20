/**
 * Rate limits: Cloudflare Workers rate-limit bindings (see wrangler.toml unsafe.bindings) plus a small
 * per-isolate window. The binding is per-location and eventually consistent (it lets a short burst through
 * before it starts returning 429), so the local window catches fast bursts that land on one isolate.
 * Missing binding => only the local window applies (logged once per isolate).
 */
const WINDOW_MS = 60 * 1000;
const local = new Map();
let warnedNoLimiter = false;

function localOk(key, limit, windowMs) {
  if (!limit || limit < 1) return true;
  const span = Math.max(1000, Number(windowMs) || WINDOW_MS);
  const now = Date.now();
  if (local.size > 5000) {
    for (const [k, entry] of local) {
      if (!entry.times.length || now - entry.times[entry.times.length - 1] > entry.span) local.delete(k);
    }
  }
  const entry = local.get(key) || { times: [], span };
  entry.span = span;
  const list = entry.times.filter((t) => now - t < span);
  if (list.length >= limit) {
    entry.times = list;
    local.set(key, entry);
    return false;
  }
  list.push(now);
  entry.times = list;
  local.set(key, entry);
  return true;
}

export function resetLocalLimits() {
  local.clear();
}

export function clientIp(request) {
  const raw = request && request.headers
    ? (request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '')
    : '';
  return String(raw || 'unknown').split(',')[0].trim().slice(0, 64) || 'unknown';
}

/**
 * windowMs defaults to 60s. Cloudflare ratelimit bindings only allow a period of
 * 10 or 60. Sign-in does not use these bindings; see auth-rate-limit.js.
 */
export async function rateLimitOk(binding, key, localLimit, scope, windowMs) {
  const k = String(key).slice(0, 200);
  if (!localOk(String(scope || 'rl') + '|' + k, localLimit, windowMs)) return false;
  if (!binding || typeof binding.limit !== 'function') {
    if (!warnedNoLimiter) { warnedNoLimiter = true; console.warn('rate limiter binding missing'); }
    return true;
  }
  try {
    const out = await binding.limit({ key: k });
    return !!(out && out.success);
  } catch (err) {
    console.warn('rate limiter error', err && err.message ? err.message : err);
    return true;
  }
}

export { authRateLimit, rejectIfAuthLimited, withRetryAfter } from './auth-rate-limit.js';
