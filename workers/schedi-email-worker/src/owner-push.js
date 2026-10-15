/**
 * Owner push notifications over FCM HTTP v1: the Schedi Android app and web browsers
 * (desktop, Android, iOS home-screen web app).
 * Tokens: artifacts/{appId}/private/data/pushTokens/{tenantId} (admin-only, rules deny all).
 *   tokens:    every registered token for the business (app + browsers), newest last.
 *   webTokens: the subset registered from a browser (platform 'web'). Android app tokens
 *              are the rest, so docs written before web push still read correctly.
 * Uses FIREBASE_SERVICE_ACCOUNT_JSON via firebase-admin.js. Never log tokens or keys.
 */
import { adminAccessToken, adminAuthHeaders } from './firebase-admin.js';
import { readSession } from './owner-auth.js';
import { privateTenantsUrl, decodeDoc, encodeValue } from './tenant-private.js';

const MAX_TOKENS = 20;
const PORTAL_URL = 'https://schedi.app/login';
const ICON_URL = 'https://schedi.app/assets/homescreen-icon.png';
const TEST_COOLDOWN_SEC = 60;

function clip(v, n) { return String(v == null ? '' : v).trim().slice(0, n || 160); }
function safeId(v) { const s = clip(v, 80); return /^[A-Za-z0-9_-]{1,80}$/.test(s) ? s : ''; }
function tokensUrl(env, tenantId) {
  return privateTenantsUrl(env).replace(/\/tenants$/, '/pushTokens') + '/' + encodeURIComponent(tenantId);
}

function strList(v) { return Array.isArray(v) ? v.filter((t) => typeof t === 'string' && t) : []; }

/** { tokens, webTokens }. webTokens is always a subset of tokens. */
export async function loadPushDoc(env, tenantId) {
  const id = safeId(tenantId);
  if (!id) return { tokens: [], webTokens: [] };
  const h = await adminAuthHeaders(env);
  const res = await fetch(tokensUrl(env, id), { headers: { Authorization: h.Authorization } });
  if (res.status === 404) return { tokens: [], webTokens: [] };
  if (!res.ok) throw new Error('push_tokens_read_failed:' + res.status);
  const doc = decodeDoc(await res.json().catch(() => null)) || {};
  const tokens = strList(doc.tokens);
  return { tokens, webTokens: strList(doc.webTokens).filter((t) => tokens.includes(t)) };
}

export async function loadPushTokens(env, tenantId) {
  return (await loadPushDoc(env, tenantId)).tokens;
}

/** Applies add/remove to the stored lists. Keeps the newest MAX_TOKENS, de-duplicated. */
export function nextPushDoc(cur, { add, remove, platform }) {
  const drop = new Set([].concat(remove || [], add ? [add] : []));
  let tokens = strList(cur && cur.tokens).filter((t) => !drop.has(t));
  let web = strList(cur && cur.webTokens).filter((t) => !drop.has(t));
  if (add) {
    tokens = tokens.concat([add]);
    if (platform === 'web') web = web.concat([add]);
  }
  tokens = Array.from(new Set(tokens)).slice(-MAX_TOKENS);
  web = Array.from(new Set(web)).filter((t) => tokens.includes(t));
  return { tokens, webTokens: web };
}

async function savePushDoc(env, tenantId, doc) {
  const h = await adminAuthHeaders(env);
  const qs = 'updateMask.fieldPaths=tokens&updateMask.fieldPaths=webTokens&updateMask.fieldPaths=updatedAt';
  const res = await fetch(tokensUrl(env, tenantId) + '?' + qs, {
    method: 'PATCH',
    headers: h,
    body: JSON.stringify({ fields: {
      tokens: encodeValue(doc.tokens),
      webTokens: encodeValue(doc.webTokens),
      updatedAt: encodeValue(new Date().toISOString()),
    } }),
  });
  if (!res.ok) throw new Error('push_tokens_write_failed:' + res.status);
}

function cors(origin, isAllowedOrigin) {
  const h = { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (origin && isAllowedOrigin(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

/** Shared request parsing + owner check for /api/push-token and /api/push-test. */
async function readOwnerTokenRequest(request, env, origin, deps) {
  const ok = deps.isAllowedOrigin;
  const out = (body, status) => new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors(origin, ok)) });
  if (origin && !ok(origin)) return { res: new Response(null, { status: 403 }) };
  if (request.method === 'OPTIONS') return { res: new Response(null, { status: 204, headers: cors(origin, ok) }) };
  if (request.method !== 'POST') return { res: out({ ok: false, error: 'method_not_allowed' }, 405) };
  let body = {};
  try { const t = await request.text(); if (t.length > 8192) return { res: out({ ok: false, error: 'too_large' }, 413) }; body = JSON.parse(t || '{}'); } catch (_) { body = {}; }
  const tenantId = safeId(body.tenantId);
  if (!tenantId) return { res: out({ ok: false, error: 'invalid_tenant' }, 400) };
  const token = clip(body.token, 4096);
  if (!/^[A-Za-z0-9_:\-.]{20,4096}$/.test(token)) return { res: out({ ok: false, error: 'invalid_token' }, 400) };
  const session = await readSession(env, body.session);
  if (!session) return { res: out({ ok: false, error: 'session_required' }, 401) };
  if (!(session.role === 'agency' || (session.role === 'owner' && session.tenantId === tenantId))) return { res: out({ ok: false, error: 'forbidden' }, 403) };
  return { out, body, tenantId, token, session };
}

/** POST /api/push-token {action:'register'|'unregister', session, tenantId, token, platform?:'web'|'android'} */
export async function handlePushTokenHttp(request, env, origin, deps) {
  const r = await readOwnerTokenRequest(request, env, origin, deps);
  if (r.res) return r.res;
  const { out, body, tenantId, token } = r;
  const platform = body.platform === 'web' ? 'web' : 'android';
  try {
    const cur = await loadPushDoc(env, tenantId);
    const next = body.action === 'unregister'
      ? nextPushDoc(cur, { remove: [token] })
      : nextPushDoc(cur, { add: token, platform });
    await savePushDoc(env, tenantId, next);
    return out({ ok: true, count: next.tokens.length, registered: next.tokens.includes(token) }, 200);
  } catch (err) {
    console.warn('push-token save failed', err && err.message ? err.message : err);
    return out({ ok: false, error: 'save_failed' }, 500);
  }
}

/**
 * POST /api/push-test {session, tenantId, token}
 * Owner only. Sends one test alert to this device's token, and only if that token is already
 * registered for the business. One test per business per minute.
 */
export async function handlePushTestHttp(request, env, origin, deps) {
  const r = await readOwnerTokenRequest(request, env, origin, deps);
  if (r.res) return r.res;
  const { out, tenantId, token } = r;
  if (deps.rateLimitOk && !(await deps.rateLimitOk(null, 'pushtest:' + tenantId, 2, 'pushtest'))) {
    return out({ ok: false, error: 'rate_limited' }, 429);
  }
  const kv = env.AUTH_KV;
  const coolKey = 'pushtest:' + tenantId;
  try {
    if (kv && (await kv.get(coolKey))) return out({ ok: false, error: 'rate_limited' }, 429);
  } catch (_) {}
  let cur;
  try { cur = await loadPushDoc(env, tenantId); } catch (_) { return out({ ok: false, error: 'read_failed' }, 500); }
  if (!cur.tokens.includes(token)) return out({ ok: false, error: 'not_registered' }, 404);
  try { if (kv) await kv.put(coolKey, '1', { expirationTtl: TEST_COOLDOWN_SEC }); } catch (_) {}
  const result = await sendPushToTokens(env, tenantId, cur, [token], {
    title: 'Booking alerts are on',
    body: 'This is a test. New bookings will pop up on this device.',
  }, { kind: 'test', bookingId: '', tag: 'schedi-test' });
  return out({ ok: result.sent > 0, sent: result.sent, error: result.sent > 0 ? undefined : (result.dead ? 'token_expired' : 'send_failed') }, result.sent > 0 ? 200 : 502);
}

function whenText(booking) {
  const d = clip(booking && booking.date, 20);
  let date = '';
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) {
    const [y, m, day] = d.slice(0, 10).split('-').map(Number);
    const dt = new Date(y, m - 1, day);
    if (Number.isFinite(dt.getTime())) date = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  if (!date && d) date = d;
  return [date, clip(booking && booking.time, 20)].filter(Boolean).join(' ');
}

export function buildPushText(kind, booking) {
  const client = clip(booking && booking.clientName, 80) || 'A client';
  const service = clip(booking && booking.serviceName, 80) || 'Appointment';
  const when = whenText(booking);
  const detail = [client, service, when].filter(Boolean).join(', ');
  const pending = String((booking && booking.status) || '').toLowerCase() === 'pending';
  if (kind === 'cancel') return { title: 'Booking cancelled', body: detail };
  return { title: pending ? 'New booking request' : 'New booking', body: detail };
}

/** Portal link for an alert. With a booking id the portal opens right at that booking (after sign-in if needed). */
export function portalLink(bookingId) {
  const id = safeId(bookingId);
  return id ? PORTAL_URL + '?booking=' + encodeURIComponent(id) : PORTAL_URL;
}

/** FCM v1 message for one token. Web tokens get a webpush block the browser can show as-is. */
export function buildFcmMessage(token, isWeb, msg, meta) {
  const bookingId = safeId(meta.bookingId);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(clip(meta.date, 10)) ? clip(meta.date, 10) : '';
  const link = portalLink(bookingId);
  const data = { kind: String(meta.kind), tenantId: String(meta.tenantId), bookingId, date, url: link };
  if (isWeb) {
    return {
      token,
      data,
      webpush: {
        headers: { Urgency: 'high', TTL: '86400' },
        notification: { title: msg.title, body: msg.body, icon: ICON_URL, tag: meta.tag, renotify: true },
        fcm_options: { link },
      },
    };
  }
  return {
    token,
    notification: { title: msg.title, body: msg.body },
    data,
    android: { priority: 'HIGH', notification: { sound: 'default', tag: meta.tag } },
  };
}

/** True when FCM says the token will never work again. */
export function isDeadTokenError(status, errBody) {
  const s = JSON.stringify(errBody || {});
  if (status === 404 || /UNREGISTERED/.test(s)) return true;
  // INVALID_ARGUMENT is also used for a bad payload; only treat it as dead when FCM points at the token.
  return status === 400 && /INVALID_ARGUMENT/.test(s) && /registration token|message\.token|not a valid FCM/i.test(s);
}

async function sendPushToTokens(env, tenantId, doc, targets, msg, meta) {
  const projectId = String(env.FIREBASE_PROJECT_ID || 'siteforge-97699');
  const access = await adminAccessToken(env, 'https://www.googleapis.com/auth/firebase.messaging');
  const dead = [];
  let sent = 0;
  for (const token of targets) {
    const isWeb = doc.webTokens.includes(token);
    const res = await fetch('https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: buildFcmMessage(token, isWeb, msg, Object.assign({ tenantId }, meta)) }),
    });
    if (res.ok) { sent++; continue; }
    const err = await res.json().catch(() => ({}));
    const isDead = isDeadTokenError(res.status, err);
    if (isDead) dead.push(token);
    const code = JSON.stringify(err).match(/UNREGISTERED|INVALID_ARGUMENT|NOT_FOUND|SENDER_ID_MISMATCH|QUOTA_EXCEEDED|UNAVAILABLE/);
    console.warn('owner-push send failed', res.status, code ? code[0] : '', isWeb ? 'web' : 'app');
  }
  if (dead.length) {
    try {
      // Re-read so a token registered during the send is not lost.
      const fresh = await loadPushDoc(env, tenantId);
      await savePushDoc(env, tenantId, nextPushDoc(fresh, { remove: dead }));
    } catch (_) {}
  }
  console.log('owner-push', JSON.stringify({ tenantId, kind: meta.kind, bookingId: safeId(meta.bookingId), sent, dead: dead.length, web: targets.filter((t) => doc.webTokens.includes(t)).length }));
  return { sent, dead: dead.length };
}

/** Best effort; never throws. kind: 'new' | 'cancel'. */
export async function sendOwnerPush(env, tenantId, booking, kind) {
  try {
    const id = safeId(tenantId);
    if (!id) return { ok: false, skipped: true };
    const doc = await loadPushDoc(env, id);
    if (!doc.tokens.length) return { ok: true, skipped: true, reason: 'no_tokens' };
    const bookingId = clip(booking && booking.id, 40);
    const r = await sendPushToTokens(env, id, doc, doc.tokens, buildPushText(kind, booking), {
      kind, bookingId, date: clip(booking && booking.date, 10), tag: 'booking-' + bookingId + '-' + kind,
    });
    return { ok: r.sent > 0, sent: r.sent };
  } catch (err) {
    console.warn('owner-push exception', err && err.message ? err.message : err);
    return { ok: false, error: 'exception' };
  }
}
