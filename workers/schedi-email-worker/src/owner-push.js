/**
 * Owner phone push notifications (Schedi Android app, FCM HTTP v1).
 * Tokens: artifacts/{appId}/private/data/pushTokens/{tenantId} (admin-only, rules deny all).
 * Uses FIREBASE_SERVICE_ACCOUNT_JSON via firebase-admin.js. Never log tokens or keys.
 */
import { adminAccessToken, adminAuthHeaders } from './firebase-admin.js';
import { readSession } from './owner-auth.js';
import { privateTenantsUrl, decodeDoc, encodeValue } from './tenant-private.js';

const MAX_TOKENS = 10;
const PORTAL_URL = 'https://schedi.app/login';

function clip(v, n) { return String(v == null ? '' : v).trim().slice(0, n || 160); }
function safeId(v) { const s = clip(v, 80); return /^[A-Za-z0-9_-]{1,80}$/.test(s) ? s : ''; }
function tokensUrl(env, tenantId) {
  return privateTenantsUrl(env).replace(/\/tenants$/, '/pushTokens') + '/' + encodeURIComponent(tenantId);
}

export async function loadPushTokens(env, tenantId) {
  const id = safeId(tenantId);
  if (!id) return [];
  const h = await adminAuthHeaders(env);
  const res = await fetch(tokensUrl(env, id), { headers: { Authorization: h.Authorization } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error('push_tokens_read_failed:' + res.status);
  const doc = decodeDoc(await res.json().catch(() => null)) || {};
  return Array.isArray(doc.tokens) ? doc.tokens.filter((t) => typeof t === 'string' && t) : [];
}

async function savePushTokens(env, tenantId, tokens) {
  const h = await adminAuthHeaders(env);
  const qs = 'updateMask.fieldPaths=tokens&updateMask.fieldPaths=updatedAt';
  const res = await fetch(tokensUrl(env, tenantId) + '?' + qs, {
    method: 'PATCH',
    headers: h,
    body: JSON.stringify({ fields: { tokens: encodeValue(tokens), updatedAt: encodeValue(new Date().toISOString()) } }),
  });
  if (!res.ok) throw new Error('push_tokens_write_failed:' + res.status);
}

function cors(origin, isAllowedOrigin) {
  const h = { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (origin && isAllowedOrigin(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

/** POST /api/push-token {action:'register'|'unregister', session, tenantId, token} */
export async function handlePushTokenHttp(request, env, origin, deps) {
  const ok = deps.isAllowedOrigin;
  const out = (body, status) => new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors(origin, ok)) });
  if (origin && !ok(origin)) return new Response(null, { status: 403 });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin, ok) });
  if (request.method !== 'POST') return out({ ok: false, error: 'method_not_allowed' }, 405);
  let body = {};
  try { const t = await request.text(); if (t.length > 8192) return out({ ok: false, error: 'too_large' }, 413); body = JSON.parse(t || '{}'); } catch (_) { body = {}; }
  const tenantId = safeId(body.tenantId);
  if (!tenantId) return out({ ok: false, error: 'invalid_tenant' }, 400);
  const token = clip(body.token, 4096);
  if (!/^[A-Za-z0-9_:\-.]{20,4096}$/.test(token)) return out({ ok: false, error: 'invalid_token' }, 400);
  const session = await readSession(env, body.session);
  if (!session) return out({ ok: false, error: 'session_required' }, 401);
  if (!(session.role === 'agency' || (session.role === 'owner' && session.tenantId === tenantId))) return out({ ok: false, error: 'forbidden' }, 403);
  try {
    const cur = await loadPushTokens(env, tenantId);
    let next = cur.filter((t) => t !== token);
    if (body.action !== 'unregister') next = next.concat([token]).slice(-MAX_TOKENS);
    await savePushTokens(env, tenantId, next);
    return out({ ok: true, count: next.length }, 200);
  } catch (err) {
    console.warn('push-token save failed', err && err.message ? err.message : err);
    return out({ ok: false, error: 'save_failed' }, 500);
  }
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

/** Best effort; never throws. kind: 'new' | 'cancel'. */
export async function sendOwnerPush(env, tenantId, booking, kind) {
  try {
    const id = safeId(tenantId);
    if (!id) return { ok: false, skipped: true };
    const tokens = await loadPushTokens(env, id);
    if (!tokens.length) return { ok: true, skipped: true, reason: 'no_tokens' };
    const projectId = String(env.FIREBASE_PROJECT_ID || 'siteforge-97699');
    const access = await adminAccessToken(env, 'https://www.googleapis.com/auth/firebase.messaging');
    const msg = buildPushText(kind, booking);
    const dead = [];
    let sent = 0;
    for (const token of tokens) {
      const res = await fetch('https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: {
          token,
          notification: { title: msg.title, body: msg.body },
          data: { kind: String(kind), tenantId: id, bookingId: clip(booking && booking.id, 40), url: PORTAL_URL },
          android: { priority: 'HIGH', notification: { sound: 'default', tag: 'booking-' + clip(booking && booking.id, 40) + '-' + kind } },
        } }),
      });
      if (res.ok) { sent++; continue; }
      const err = await res.json().catch(() => ({}));
      const code = JSON.stringify(err).match(/UNREGISTERED|INVALID_ARGUMENT|NOT_FOUND/);
      if (res.status === 404 || (code && res.status === 400)) dead.push(token);
      console.warn('owner-push send failed', res.status, code ? code[0] : '');
    }
    if (dead.length) { try { await savePushTokens(env, id, tokens.filter((t) => !dead.includes(t))); } catch (_) {} }
    console.log('owner-push', JSON.stringify({ tenantId: id, kind, sent, dead: dead.length }));
    return { ok: sent > 0, sent };
  } catch (err) {
    console.warn('owner-push exception', err && err.message ? err.message : err);
    return { ok: false, error: 'exception' };
  }
}
