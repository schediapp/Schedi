/**
 * Rate limits: Cloudflare Workers rate-limit bindings (see wrangler.toml unsafe.bindings) plus a small
 * per-isolate window. The binding is per-location and eventually consistent (it lets a short burst through
 * before it starts returning 429), so the local window catches fast bursts that land on one isolate.
 * Missing binding => only the local window applies (logged once per isolate).
 */
const WINDOW_MS = 60 * 1000;
const local = new Map();
let warnedNoLimiter = false;

function localOk(key, limit) {
  if (!limit || limit < 1) return true;
  const now = Date.now();
  if (local.size > 5000) {
    for (const [k, list] of local) {
      if (!list.length || now - list[list.length - 1] > WINDOW_MS) local.delete(k);
    }
  }
  const list = (local.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= limit) {
    local.set(key, list);
    return false;
  }
  list.push(now);
  local.set(key, list);
  return true;
}

export async function rateLimitOk(binding, key, localLimit, scope) {
  const k = String(key).slice(0, 200);
  if (!localOk(String(scope || 'rl') + '|' + k, localLimit)) return false;
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
