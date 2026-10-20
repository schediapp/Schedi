/**
 * Owner self-service password reset + change (additive; reuses owner-auth.js storage).
 *
 * Routes (all POST JSON, under the existing schedi.app/auth/* route):
 *   /auth/forgot        { identifier }                    -> always { ok:true } (neutral); emails a reset link if it matches
 *   /auth/reset-check   { token }                         -> { ok, valid, business? }
 *   /auth/reset         { token, newPassword }            -> sets password, signs out owner sessions, sends notice
 *   /auth/change        { session, currentPassword, newPassword } -> owner session only; signs out other owner sessions
 *
 * KV (AUTH_KV) keys:
 *   reset:<sha256(token)>       { tenantId, email, exp }   TTL = RESET_TTL_SECONDS (token itself is never stored)
 *   resetfor:<tenantId>         { hash }                   latest outstanding token hash (older one is deleted)
 *   rl:<bucket>:<key>:<window>  count                      short TTL rate-limit counters
 */
import { saveOwnerSecret, authReady, readSession, passwordMatches } from './owner-auth.js';
import { authRateLimit } from './rate-limit.js';

const RESET_TTL_SECONDS = 60 * 60; // link valid 60 minutes
const RESET_FROM = 'onboarding@schedi.app';
const RESET_REPLY_TO = 'admin@schedi.app';
const NEUTRAL_MESSAGE = 'If that matches a Schedi business, we sent a reset link to the owner email on file. The link works for 60 minutes.';
const MARK_URL = 'https://schedi.app/assets/homescreen-icon.png';

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function readJson(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function clientIp(request) {
  return String(request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown').split(',')[0].trim();
}

// Fixed-window counter. Returns true when the call is allowed.
async function rateLimit(env, bucket, key, limit, windowSeconds) {
  const windowId = Math.floor(Date.now() / 1000 / windowSeconds);
  const k = 'rl:' + bucket + ':' + (await sha256Hex(key)).slice(0, 32) + ':' + windowId;
  const current = Number((await env.AUTH_KV.get(k)) || 0);
  if (current >= limit) return false;
  await env.AUTH_KV.put(k, String(current + 1), { expirationTtl: Math.max(60, windowSeconds + 60) });
  return true;
}

// Failure-only counter (e.g. wrong current password): peek before, bump on failure.
async function failCounterKey(bucket, key, windowSeconds) {
  return 'rl:' + bucket + ':' + (await sha256Hex(key)).slice(0, 32) + ':' + Math.floor(Date.now() / 1000 / windowSeconds);
}

function safeTenantId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,79}$/.test(id) ? id : '';
}

// Resolve slug or login email to owner auth records. Never reveals the result to the caller.
async function resolveOwnerRecords(env, identifier, deps) {
  const raw = String(identifier || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?schedi\.app\//, '').replace(/\/+$/, '');
  if (!raw || raw.length > 160) return [];
  const out = [];
  if (raw.indexOf('@') > 0) {
    const index = await readJson(env.AUTH_KV, 'email:' + raw);
    const ids = index && Array.isArray(index.tenantIds) ? index.tenantIds.slice(0, 5) : [];
    for (const id of ids) {
      const rec = await readJson(env.AUTH_KV, 'tenant:' + id);
      if (rec && rec.hash && rec.email === raw) out.push({ tenantId: id, email: rec.email });
    }
    if (out.length && deps && typeof deps.tenantExists === 'function') {
      // Skip logins left over from deleted businesses (no reset links for pages that are gone).
      const checks = await Promise.all(out.map((r) => deps.tenantExists(r.tenantId).catch(() => null)));
      return out.filter((r, i) => checks[i] !== false);
    }
  } else {
    // Accept a pasted link with extra path/query, or the business name typed as words.
    const first = raw.split(/[/?#]/)[0];
    const id = safeTenantId(first) || safeTenantId(first.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
    if (!id) return [];
    const rec = await readJson(env.AUTH_KV, 'tenant:' + id);
    if (rec && rec.hash && rec.email && rec.email.indexOf('@') > 0) out.push({ tenantId: id, email: rec.email });
  }
  return out;
}

const SESSION_TTL_SECONDS = 12 * 60 * 60;

// "Not before" marker: owner sessions for this tenant created before this time are invalid.
// Enforced by readSession in owner-auth.js once that check is enabled (see go-live notes).
async function markOwnerSessionsRevoked(env, tenantId) {
  await env.AUTH_KV.put('sessrevoke:' + tenantId, String(Date.now()), { expirationTtl: SESSION_TTL_SECONDS + 3600 });
}

// Same shape as owner-auth.js createSession.
async function createOwnerSession(env, email, tenantId) {
  const token = randomToken();
  const exp = Date.now() + SESSION_TTL_SECONDS * 1000;
  await env.AUTH_KV.put('session:' + token, JSON.stringify({ exp: exp, role: 'owner', email: email, tenantId: tenantId }), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

// Delete owner sessions for a tenant (optionally keeping one). Sessions are session:<token> with a 12h TTL.
// KV list is eventually consistent, so a session created in the last ~60s can be missed; the marker above covers that.
async function revokeOwnerSessions(env, tenantId, keepToken) {
  let cursor;
  let revoked = 0;
  let scanned = 0;
  do {
    const page = await env.AUTH_KV.list({ prefix: 'session:', cursor: cursor, limit: 1000 });
    for (const key of page.keys || []) {
      scanned += 1;
      if (keepToken && key.name === 'session:' + keepToken) continue;
      const s = await readJson(env.AUTH_KV, key.name);
      if (s && s.role === 'owner' && s.tenantId === tenantId) {
        await env.AUTH_KV.delete(key.name);
        revoked += 1;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && scanned < 5000);
  return revoked;
}

function emailShell(opts) {
  const accent = opts.accent || '#059669';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;background-color:#020617;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#020617;"><tr><td align="center" style="padding:24px 12px;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;width:100%;background-color:#0b1325;border:1px solid #334155;border-radius:24px;overflow:hidden;">'
    + '<tr><td align="center" bgcolor="' + accent + '" style="background-color:' + accent + ';padding:36px 28px 32px;">'
    + '<img src="' + MARK_URL + '" width="72" height="72" alt="" style="display:block;width:72px;height:72px;border:0;border-radius:20px;margin:0 auto 16px;">'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:28px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;line-height:1.2;">' + esc(opts.headline) + '</div>'
    + (opts.sub ? '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#ecfdf5;margin-top:8px;line-height:1.4;">' + esc(opts.sub) + '</div>' : '')
    + '</td></tr>'
    + opts.bodyHtml
    + '<tr><td style="padding:18px 28px 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
    + '<td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#64748b;vertical-align:middle;">Questions? Reply to this email.</td>'
    + '<td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#94a3b8;font-weight:600;vertical-align:middle;">'
    + '<img src="' + MARK_URL + '" width="16" height="16" alt="" style="display:inline-block;width:16px;height:16px;border:0;vertical-align:middle;margin-right:4px;">Schedi</td>'
    + '</tr></table></td></tr>'
    + '</table>'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#475569;padding:16px 8px 0;">Powered by Schedi</div>'
    + '</td></tr></table></body></html>';
}

function para(html) {
  return '<tr><td style="padding:14px 28px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#cbd5e1;line-height:1.55;">' + html + '</td></tr>';
}

export function buildResetEmail(info) {
  const business = info.businessName || info.tenantId;
  const url = info.resetUrl;
  const subject = 'Reset your Schedi password';
  const text = 'Reset your Schedi password\n\n'
    + 'Someone asked to reset the Business Portal password for ' + business + ' (schedi.app/' + info.tenantId + ').\n\n'
    + 'Set a new password here (works once, for 60 minutes):\n' + url + '\n\n'
    + 'If you did not ask for this, ignore this email. Your password stays the same.\n\n'
    + '— Schedi\n' + RESET_REPLY_TO;
  const body = para('Someone asked to reset the Business Portal password for <strong style="color:#ffffff;">' + esc(business) + '</strong> <span style="color:#94a3b8;">(schedi.app/' + esc(info.tenantId) + ')</span>.')
    + '<tr><td align="center" style="padding:22px 28px 6px;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
    + '<td align="center" bgcolor="#059669" style="background-color:#059669;border-radius:14px;">'
    + '<a href="' + esc(url) + '" style="display:block;padding:14px 18px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">Set a new password</a>'
    + '</td></tr></table>'
    + '<p style="margin:10px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#64748b;line-height:1.4;">The link works once and expires in 60 minutes.</p>'
    + '</td></tr>'
    + para('<span style="font-size:13px;color:#94a3b8;">If you did not ask for this, ignore this email. Your password stays the same.</span>');
  const html = emailShell({ headline: 'Reset your password', sub: 'Business Portal · ' + business, bodyHtml: body });
  return { subject, text, html };
}

export function buildChangedEmail(info) {
  const business = info.businessName || info.tenantId;
  const when = info.whenLabel;
  const how = info.how === 'reset' ? 'with a reset link' : 'from the Business Portal';
  const subject = 'Your Schedi password was changed';
  const text = 'Your Schedi password was changed\n\n'
    + 'The Business Portal password for ' + business + ' (schedi.app/' + info.tenantId + ') was changed ' + how + ' on ' + when + '.\n'
    + 'Other signed-in sessions were signed out.\n\n'
    + 'If this was not you, reset your password now at https://schedi.app/login (Forgot Password?) and reply to this email.\n\n'
    + '— Schedi\n' + RESET_REPLY_TO;
  const body = para('The Business Portal password for <strong style="color:#ffffff;">' + esc(business) + '</strong> <span style="color:#94a3b8;">(schedi.app/' + esc(info.tenantId) + ')</span> was changed ' + esc(how) + ' on <strong style="color:#ffffff;">' + esc(when) + '</strong>.')
    + para('<span style="font-size:13px;color:#94a3b8;">Other signed-in sessions were signed out.</span>')
    + para('<div style="padding:12px 14px;border-radius:10px;background-color:#111c33;border:1px solid #334155;font-size:13px;color:#cbd5e1;">If this was not you, reset your password now from the <a href="https://schedi.app/login" style="color:#34d399;font-weight:700;">Business Portal</a> (Forgot Password?) and reply to this email.</div>');
  const html = emailShell({ headline: 'Password changed', sub: 'Business Portal · ' + business, bodyHtml: body });
  return { subject, text, html };
}

function whenLabel(timeZone) {
  try {
    return new Date().toLocaleString('en-US', {
      timeZone: timeZone || 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
      year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  } catch (e) {
    return new Date().toISOString();
  }
}

function resetBaseUrl(origin, deps) {
  if (origin && deps.isAllowedOrigin && deps.isAllowedOrigin(origin)) {
    try {
      const u = new URL(origin);
      if (u.protocol === 'https:' && (u.hostname === 'schedi.app' || u.hostname.endsWith('.schedi.pages.dev'))) return u.origin;
    } catch (e) {}
  }
  return 'https://schedi.app';
}

async function sendMail(env, deps, to, msg) {
  return deps.sendResend(env, {
    to: to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    replyTo: RESET_REPLY_TO,
    fromName: 'Schedi',
    fromAddress: RESET_FROM,
  });
}

async function tenantInfo(env, deps, tenantId) {
  try {
    const t = deps.getTenantBasics ? await deps.getTenantBasics(env, tenantId) : null;
    return { name: (t && t.name) || tenantId, timezone: (t && (t.timezone || t.timeZone)) || 'America/New_York' };
  } catch (e) {
    return { name: tenantId, timezone: 'America/New_York' };
  }
}

async function issueReset(env, deps, origin, rec) {
  const allowed = await rateLimit(env, 'forgot-acct', rec.tenantId, 3, 60 * 60);
  if (!allowed) return { ok: false, reason: 'rate_limited' };
  const token = randomToken();
  const hash = await sha256Hex(token);
  const previous = await readJson(env.AUTH_KV, 'resetfor:' + rec.tenantId);
  if (previous && previous.hash) await env.AUTH_KV.delete('reset:' + previous.hash);
  await env.AUTH_KV.put('reset:' + hash, JSON.stringify({ tenantId: rec.tenantId, email: rec.email, exp: Date.now() + RESET_TTL_SECONDS * 1000 }), { expirationTtl: RESET_TTL_SECONDS });
  await env.AUTH_KV.put('resetfor:' + rec.tenantId, JSON.stringify({ hash: hash }), { expirationTtl: RESET_TTL_SECONDS });
  const info = await tenantInfo(env, deps, rec.tenantId);
  const msg = buildResetEmail({
    tenantId: rec.tenantId,
    businessName: info.name,
    resetUrl: resetBaseUrl(origin, deps) + '/reset?t=' + token,
  });
  const sent = await sendMail(env, deps, rec.email, msg);
  return { ok: !!sent.ok };
}

async function lookupResetToken(env, token) {
  const t = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(t)) return null;
  const hash = await sha256Hex(t);
  const rec = await readJson(env.AUTH_KV, 'reset:' + hash);
  if (!rec || Number(rec.exp || 0) < Date.now()) return null;
  const owner = await readJson(env.AUTH_KV, 'tenant:' + rec.tenantId);
  if (!owner || !owner.hash || owner.email !== rec.email) return null; // login email changed since: token is void
  return { hash, rec };
}

function validNewPassword(pw) {
  const s = String(pw || '');
  return s.length >= 8 && s.length <= 200;
}

export async function handleOwnerResetRequest(request, env, origin, path, json, deps, ctx) {
  if (!authReady(env)) return json({ ok: false, error: 'auth_not_configured' }, 500, origin);
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const ip = clientIp(request);

  if (path === '/auth/forgot') {
    const email = String(body.identifier || body.email || body.slug || '').trim().toLowerCase();
    if (!(await authRateLimit(env, { route: '/auth/forgot', ip, email }))) {
      return json({ ok: false, error: 'rate_limited' }, 429, origin);
    }
    const ipAllowed = await rateLimit(env, 'forgot-ip', ip, 5, 15 * 60);
    if (!ipAllowed) return json({ ok: false, error: 'too_many_requests', message: 'Too many requests. Try again in a few minutes.' }, 429, origin);
    const work = (async () => {
      try {
        const recs = await resolveOwnerRecords(env, body.identifier || body.email || body.slug, deps);
        for (const rec of recs.slice(0, 3)) await issueReset(env, deps, origin, rec);
      } catch (e) {
        console.warn('owner reset issue failed', e && e.message ? e.message : e);
      }
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work); else await work;
    return json({ ok: true, message: NEUTRAL_MESSAGE }, 200, origin);
  }

  if (path === '/auth/reset-check') {
    if (!(await authRateLimit(env, { route: '/auth/reset', ip, email: '' }))) {
      return json({ ok: false, error: 'rate_limited' }, 429, origin);
    }
    const ipAllowed = await rateLimit(env, 'reset-ip', ip, 30, 15 * 60);
    if (!ipAllowed) return json({ ok: false, error: 'too_many_requests' }, 429, origin);
    const found = await lookupResetToken(env, body.token);
    if (!found) return json({ ok: true, valid: false }, 200, origin);
    const info = await tenantInfo(env, deps, found.rec.tenantId);
    return json({ ok: true, valid: true, business: info.name, slug: found.rec.tenantId }, 200, origin);
  }

  if (path === '/auth/reset') {
    if (!(await authRateLimit(env, { route: '/auth/reset', ip, email: '' }))) {
      return json({ ok: false, error: 'rate_limited' }, 429, origin);
    }
    const ipAllowed = await rateLimit(env, 'reset-ip', ip, 30, 15 * 60);
    if (!ipAllowed) return json({ ok: false, error: 'too_many_requests' }, 429, origin);
    if (!validNewPassword(body.newPassword)) return json({ ok: false, error: 'invalid_password' }, 400, origin);
    const found = await lookupResetToken(env, body.token);
    if (!found) return json({ ok: false, error: 'invalid_or_expired' }, 400, origin);
    await env.AUTH_KV.delete('reset:' + found.hash); // single use
    await env.AUTH_KV.delete('resetfor:' + found.rec.tenantId);
    const saved = await saveOwnerSecret(env, found.rec.email, found.rec.tenantId, String(body.newPassword));
    if (!saved.ok) return json({ ok: false, error: 'password_store_failed' }, 500, origin);
    await markOwnerSessionsRevoked(env, found.rec.tenantId);
    const after = (async () => {
      try { await revokeOwnerSessions(env, found.rec.tenantId, ''); } catch (e) {}
      const info = await tenantInfo(env, deps, found.rec.tenantId);
      await sendMail(env, deps, found.rec.email, buildChangedEmail({ tenantId: found.rec.tenantId, businessName: info.name, how: 'reset', whenLabel: whenLabel(info.timezone) })).catch(() => null);
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(after); else await after;
    return json({ ok: true }, 200, origin);
  }

  if (path === '/auth/change') {
    const session = await readSession(env, body.session);
    const email = session && session.email ? String(session.email) : '';
    if (!(await authRateLimit(env, { route: '/auth/change', ip, email }))) {
      return json({ ok: false, error: 'rate_limited' }, 429, origin);
    }
    if (!session || session.role !== 'owner' || !session.tenantId) return json({ ok: false, error: 'session_required' }, 401, origin);
    if (!validNewPassword(body.newPassword)) return json({ ok: false, error: 'invalid_password' }, 400, origin);
    const failKey = await failCounterKey('change-fail', session.tenantId, 15 * 60);
    const failures = Number((await env.AUTH_KV.get(failKey)) || 0);
    if (failures >= 5) return json({ ok: false, error: 'too_many_attempts' }, 429, origin);
    const owner = await readJson(env.AUTH_KV, 'tenant:' + session.tenantId);
    if (!owner || !owner.hash || !(await passwordMatches(String(body.currentPassword || ''), owner, env.AUTH_PEPPER))) {
      await env.AUTH_KV.put(failKey, String(failures + 1), { expirationTtl: 16 * 60 });
      return json({ ok: false, error: 'wrong_password' }, 400, origin);
    }
    const saved = await saveOwnerSecret(env, owner.email, session.tenantId, String(body.newPassword));
    if (!saved.ok) return json({ ok: false, error: 'password_store_failed' }, 500, origin);
    // Sign out every owner session (this one included), then hand the caller a fresh session.
    await markOwnerSessionsRevoked(env, session.tenantId);
    const freshSession = await createOwnerSession(env, owner.email, session.tenantId);
    const after = (async () => {
      try { await revokeOwnerSessions(env, session.tenantId, freshSession); } catch (e) {}
      const info = await tenantInfo(env, deps, session.tenantId);
      await sendMail(env, deps, owner.email, buildChangedEmail({ tenantId: session.tenantId, businessName: info.name, how: 'change', whenLabel: whenLabel(info.timezone) })).catch(() => null);
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(after); else await after;
    return json({ ok: true, session: freshSession }, 200, origin);
  }

  return json({ ok: false, error: 'not_found' }, 404, origin);
}
