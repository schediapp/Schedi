/**
 * Schedi booking email Worker — Resend bridge + same-day reminder cron + Twilio SMS
 *
 * POST (webhook): same JSON as SiteForge — { to, subject, text, html, replyTo, fromName }
 *   Booking confirmations may also include type:"booking_confirmation" and sms:{tenantId,phone,...}.
 *   SMS is sent only if the tenant doc has smsEnabled and Twilio secrets are set.
 *   Missing Twilio secrets skip SMS and do not fail the email.
 * Auth: no shared secret in page code. Each send needs the booking's manage token or the owner session
 *   (see booking-mail.js). WEBHOOK_SECRET is only a server-side maintenance Bearer for run_reminders.
 *
 * Cron: hourly (0 * * * *). Per tenant: skip if remindersEnabled === false;
 *   send when local hour === reminderHour (default 8) in tenant timezone.
 *   If smsEnabled and the booking has a phone, also send one same-day reminder SMS.
 * Force/dry-run: POST { "action": "run_reminders", "dryRun": true } with the maintenance Bearer or an agency session
 *
 * Bookings live in Worker KV (privateAppts:{tenantId}).
 * Firestore tenant docs keep the public profile only.
 * Open/closed times are slot docs under tenants/{tenantId}/slots/{bookingId}.
 * Email dedup: booking.reminderSentAt OR bookingReminders sentAt/emailId
 * SMS reminder dedup: booking.smsReminderSentAt OR bookingReminders.smsReminderSentAt
 * SMS confirm dedup: bookingReminders.smsConfirmSentAt (same doc)
 */

import { handleAuthRequest, saveOwnerSecret, authReady, readSession, readLogoWriteSession, passwordMatches } from './owner-auth.js';
import { requireAgency } from './agency-session.js';
import { runUnpaidDigest } from './unpaid-digest.js';
import { runDepositFollowups, runSignupReminders, isAwaitingDeposit, signupAwaitingCheckout } from './flow-gaps.js';
import { resolveOwnerNotifyAddress } from './owner-notify.js';
import { handleOwnerResetRequest } from './owner-reset.js';
import { planFromStripePrice } from './entitlements.js';
import { catalogChargeDollars, ownerQuotedDollars } from './card-quote-link.js';
import { hydrateTenantBookings, persistTenantAppointments, handlePrivateBookingHttp, loadPrivateAppointments } from './private-bookings.js';
import { handleClientsHttp, runClientsBackfillOnce } from './private-clients.js';
import { adminAuthHeaders } from './firebase-admin.js';
import { handleProfileRequest } from './profile-store.js';
import { handleLogoUpload } from './logo-upload.js';
import { handlePushTokenHttp, handlePushTestHttp } from './owner-push.js';
import { applyCancellationFee, cancellationFeeSentence } from './cancellation-fee.js';
import { handleOpsSnapshotHttp, runOpsSnapshotCron } from './ops-snapshot.js';
import { handleDefaultPasswordAudit } from './default-password-audit.js';
import { handleResendEventsHttp } from './email-events.js';
import { notifyOwnerOfNewBooking, notifyOwnerOfCancellation, ownerNotifyEnabledForTenant } from './owner-notify.js';
import { handleBookingIcs, publicBusinessAddress, googleCalendarDatesParam } from './booking-ics.js';
import { handleCalendarFeeds, handleCalendarBusy, handleOwnerFeed, syncAllCalendarFeeds } from './calendar-sync.js';
import { handleBookingMailPost } from './booking-mail.js';
import { rateLimitOk } from './rate-limit.js';
import { handleOwnerBillingSchedule, ownerBillingScheduleAction, subscriptionScheduleFromStripe } from './owner-billing-schedule.js';
import {
  shapePublicBookingFields,
  shapePublicPatch,
  mergePrivateInto,
  getPrivateTenant,
  listPrivateTenants,
  patchPrivateTenant,
} from './tenant-private.js';
import { handleSquareHttp, runSquareReconcile } from './square.js';
import { applyCardCheckoutPayment, centsByBooking } from './card-payment.js';
import { handleConnectBookingPaid } from './connect-booking-paid.js';
import { handleConnectHandoff, handleConnectPlan } from './connect-handoff.js';
import { handlePageVisitsRequest } from '../../../worker/page-visits.ts';

const ALLOWED_ORIGINS = new Set([
  'https://schedi.app',
  'https://www.schedi.app',
  'https://schedi.pages.dev',
]);

const FROM_ADDRESS = 'bookings@schedi.app';
const ONBOARDING_FROM = 'onboarding@schedi.app';
const HELLO_FROM = 'hello@schedi.app';
const ALLOWED_FROM_ADDRESSES = new Set([ONBOARDING_FROM, FROM_ADDRESS, HELLO_FROM]);
const DEFAULT_FROM_NAME = 'Schedi';
const DEFAULT_TZ = 'America/New_York';

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:' && u.hostname.endsWith('.schedi.pages.dev')) {
      return true;
    }
  } catch (_) {}
  return false;
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

function canonicalFromAddress(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return { ok: true, address: FROM_ADDRESS, explicit: false };
  if (!ALLOWED_FROM_ADDRESSES.has(raw)) return { ok: false, error: 'from_not_allowed', explicit: true };
  return { ok: true, address: raw, explicit: true };
}

// Public booking calls cannot pick a From. hello@ is only for product outreach
// callers inside this worker. onboarding@ is only for signup and agency mail.
function publicBookingFrom(value) {
  const decision = canonicalFromAddress(value);
  if (!decision.ok) return decision;
  if (decision.explicit && decision.address !== FROM_ADDRESS) {
    return { ok: false, error: 'from_not_allowed', explicit: true };
  }
  return { ok: true, address: FROM_ADDRESS, explicit: decision.explicit };
}

function buildFrom(fromName, fromAddress) {
  const decision = canonicalFromAddress(fromAddress);
  if (!decision.ok) return '';
  const address = decision.address;
  const raw = String(fromName || '').trim();
  const name = raw || DEFAULT_FROM_NAME;
  const lower = name.toLowerCase();
  if (lower === 'schedi') {
    return `Schedi <${address}>`;
  }
  if (lower.includes('via schedi')) {
    return `${name} <${address}>`;
  }
  return `${name} via Schedi <${address}>`;
}

function normalizeTo(to) {
  if (Array.isArray(to)) {
    return to.map((t) => String(t || '').trim()).filter(Boolean);
  }
  const s = String(to || '').trim();
  return s ? [s] : [];
}

function extractBearer(req) {
  const h = req.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  if (aa.byteLength !== bb.byteLength) return false;
  let out = 0;
  for (let i = 0; i < aa.byteLength; i++) out |= aa[i] ^ bb[i];
  return out === 0;
}

async function sendResend(env, { to, subject, html, text, replyTo, fromName, fromAddress }) {
  const toList = normalizeTo(to);
  const fromDecision = canonicalFromAddress(fromAddress);
  if (!fromDecision.ok) return { ok: false, error: 'from_not_allowed' };
  const resendKey = String(env.RESEND_API_KEY || '').trim();
  if (!resendKey) {
    return { ok: false, error: 'RESEND_API_KEY not set' };
  }
  if (!toList.length || !subject || (!html && !text)) {
    return { ok: false, error: 'validation_failed' };
  }
  const fromHeader = buildFrom(fromName, fromDecision.address);
  if (!fromHeader) return { ok: false, error: 'from_not_allowed' };
  const resendBody = {
    from: fromHeader,
    to: toList.length === 1 ? toList[0] : toList,
    subject,
  };
  if (html) resendBody.html = html;
  if (text) resendBody.text = text;
  if (replyTo) resendBody.reply_to = replyTo;

  let resendRes;
  try {
    resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: JSON.stringify(resendBody),
    });
  } catch (err) {
    return { ok: false, error: 'resend_network', detail: String(err && err.message ? err.message : err) };
  }

  let resendJson = null;
  try {
    resendJson = await resendRes.json();
  } catch (_) {
    resendJson = null;
  }

  if (!resendRes.ok) {
    return {
      ok: false,
      error: 'resend_error',
      status: resendRes.status,
      detail: resendJson,
    };
  }
  return { ok: true, id: resendJson && resendJson.id ? resendJson.id : undefined };
}


/* ---------------- Twilio SMS (optional; secrets absent => skip) ---------------- */

function twilioConfig(env) {
  const sid = String((env && env.TWILIO_ACCOUNT_SID) || '').trim();
  const token = String((env && env.TWILIO_AUTH_TOKEN) || '').trim();
  const from = String((env && env.TWILIO_FROM) || '').trim();
  if (!sid || !token || !from) return null;
  return { sid, token, from };
}

/** Best-effort E.164. Returns '' if it does not look dialable. */
function normalizeSmsPhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const hasPlus = s.charAt(0) === '+';
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (hasPlus && digits.length >= 8 && digits.length <= 15) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
  if (digits.length >= 8 && digits.length <= 15) return '+' + digits;
  return '';
}

function clipSms(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= 320) return s;
  return s.slice(0, 317) + '...';
}

function smsPieces(tenant, booking) {
  const biz = String((tenant && tenant.name) || 'Schedi').trim() || 'Schedi';
  const service = String((booking && (booking.serviceName || booking.service)) || 'Appointment').trim() || 'Appointment';
  const date = String((booking && booking.date) || '').trim();
  const time = String((booking && booking.time) || '').trim();
  return { biz, service, date, time };
}

function buildConfirmationSms(tenant, booking) {
  const p = smsPieces(tenant, booking);
  const when = p.date && p.time ? `${p.date} at ${p.time}` : (p.date || p.time);
  const msg = when
    ? `${p.biz}: You're booked for ${p.service} on ${when}.`
    : `${p.biz}: You're booked for ${p.service}.`;
  return clipSms(msg);
}

function buildReminderSms(tenant, booking) {
  const p = smsPieces(tenant, booking);
  let when = 'today';
  if (p.time && p.date) when = `today, ${p.date} at ${p.time}`;
  else if (p.time) when = `today at ${p.time}`;
  else if (p.date) when = `today (${p.date})`;
  return clipSms(`${p.biz}: Reminder — ${p.service} ${when}.`);
}

function tenantSmsEnabled(tenant) {
  return !!(tenant && tenant.smsEnabled === true);
}

function bookingPhone(booking) {
  if (!booking) return '';
  return String(booking.clientPhone || booking.phone || '').trim();
}

async function sendTwilioSms(env, { to, body }) {
  const cfg = twilioConfig(env);
  if (!cfg) return { ok: false, skipped: true, reason: 'twilio_not_configured' };
  const phone = normalizeSmsPhone(to);
  if (!phone) return { ok: false, skipped: true, reason: 'invalid_phone' };
  const text = clipSms(body);
  if (!text) return { ok: false, skipped: true, reason: 'empty_body' };
  const params = new URLSearchParams();
  params.set('To', phone);
  params.set('From', cfg.from);
  params.set('Body', text);
  let basic;
  try {
    basic = btoa(`${cfg.sid}:${cfg.token}`);
  } catch (_) {
    return { ok: false, skipped: true, reason: 'twilio_not_configured' };
  }
  let res;
  try {
    res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      }
    );
  } catch (err) {
    return { ok: false, error: 'twilio_network', detail: String(err && err.message ? err.message : err) };
  }
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  if (!res.ok) {
    return {
      ok: false,
      error: 'twilio_error',
      status: res.status,
      detail: data && (data.message || data.code) ? { message: data.message, code: data.code } : undefined,
    };
  }
  return { ok: true, sid: data && data.sid ? data.sid : undefined };
}

/* ---------------- Firestore (anonymous auth, same as public booking page) ---------------- */

function decodeFirestoreValue(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeFirestoreValue);
  if ('mapValue' in v) {
    const o = {};
    const f = v.mapValue.fields || {};
    for (const k of Object.keys(f)) o[k] = decodeFirestoreValue(f[k]);
    return o;
  }
  return null;
}

function encodeFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(encodeFirestoreValue) } };
  }
  if (typeof v === 'object') {
    const fields = {};
    for (const k of Object.keys(v)) {
      if (v[k] !== undefined) fields[k] = encodeFirestoreValue(v[k]);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function firebaseConfig(env) {
  return {
    apiKey: String(env.FIREBASE_API_KEY || '').trim(),
    projectId: String(env.FIREBASE_PROJECT_ID || 'siteforge-97699').trim(),
    appId: String(env.FIREBASE_APP_ID || 'siteforge-97699').trim(),
  };
}

async function firebaseAnonymousToken(env) {
  const { apiKey } = firebaseConfig(env);
  if (!apiKey) throw new Error('FIREBASE_API_KEY not set');
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    }
  );
  const data = await res.json();
  if (!res.ok || !data.idToken) {
    throw new Error('firebase_anon_auth_failed: ' + JSON.stringify(data));
  }
  return data.idToken;
}

function tenantsCollectionUrl(env) {
  const { projectId, appId } = firebaseConfig(env);
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/artifacts/${appId}/public/data/tenants`;
}

function reminderDocUrl(env, tenantId, bookingId) {
  const { projectId, appId } = firebaseConfig(env);
  const docId = `${tenantId}__${bookingId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/artifacts/${appId}/public/data/bookingReminders/${docId}`;
}

// true = public tenant doc exists, false = definitely gone (404), null = could not tell.
async function tenantExists(env, tenantId) {
  try {
    const res = await fetch(tenantDocUrl(env, tenantId) + '?mask.fieldPaths=name');
    if (res.status === 404) return false;
    if (res.ok) return true;
  } catch (_) {}
  return null;
}

function tenantDocUrl(env, tenantId) {
  return `${tenantsCollectionUrl(env)}/${encodeURIComponent(tenantId)}`;
}

async function listAllTenants(env, idToken) {
  const tenants = [];
  let privateMap = null;
  try {
    privateMap = await listPrivateTenants(env);
  } catch (err) {
    console.warn('private tenant list failed', err && err.message ? err.message : err);
    privateMap = null;
  }
  let pageToken = '';
  do {
    const url =
      tenantsCollectionUrl(env) +
      '?pageSize=100' +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
    const data = await res.json();
    if (!res.ok) throw new Error('firestore_list_failed: ' + JSON.stringify(data));
    for (const doc of data.documents || []) {
      const fields = doc.fields || {};
      const tenant = {};
      for (const k of Object.keys(fields)) tenant[k] = decodeFirestoreValue(fields[k]);
      const docId = String(doc.name || '').split('/').pop();
      if (!tenant.id) {
        tenant.id = docId;
      }
      if (privateMap && privateMap[docId]) mergePrivateInto(tenant, privateMap[docId]);
      if (!privateMap) tenant.__privateLoadFailed = true;
      tenants.push(await hydrateTenantBookings(env, idToken, tenant));
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return tenants;
}

// Public tenant doc only (name/timezone) for owner reset emails. No private merge, no bookings.
async function getTenantBasics(env, tenantId) {
  const idToken = await firebaseAnonymousToken(env);
  const res = await fetch(tenantDocUrl(env, tenantId), { headers: { Authorization: `Bearer ${idToken}` } });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const fields = (data && data.fields) || {};
  return {
    name: fields.name ? decodeFirestoreValue(fields.name) : '',
    timezone: fields.timezone ? decodeFirestoreValue(fields.timezone) : (fields.timeZone ? decodeFirestoreValue(fields.timeZone) : ''),
  };
}

// Plan checks for Stripe setup. One public doc and one private doc. No booking list
// and no scan of every private tenant.
async function getTenantPlanRecord(env, tenantId) {
  const id = String(tenantId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  const idToken = await firebaseAnonymousToken(env);
  const res = await fetch(tenantDocUrl(env, id), {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error('firestore_get_tenant_failed');
  const fields = (data && data.fields) || {};
  const tenant = {};
  for (const k of Object.keys(fields)) tenant[k] = decodeFirestoreValue(fields[k]);
  if (!tenant.id) tenant.id = id;
  if (!tenant.slug) tenant.slug = id;
  try {
    const priv = await getPrivateTenant(env, id);
    if (priv) mergePrivateInto(tenant, priv);
  } catch (err) {
    console.warn('private tenant read failed', err && err.message ? err.message : err);
    tenant.__privateLoadFailed = true;
  }
  return tenant;
}

async function getTenantById(env, idToken, tenantId) {
  const res = await fetch(tenantDocUrl(env, tenantId), {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error('firestore_get_tenant_failed: ' + JSON.stringify(data));
  }
  const fields = (data && data.fields) || {};
  const tenant = {};
  for (const k of Object.keys(fields)) tenant[k] = decodeFirestoreValue(fields[k]);
  if (!tenant.id) tenant.id = tenantId;
  // Owner contact + billing fields live in the private doc (Admin-only). Merge them back for worker use.
  try {
    const priv = await getPrivateTenant(env, String(tenantId));
    if (priv) mergePrivateInto(tenant, priv);
  } catch (err) {
    console.warn('private tenant read failed', err && err.message ? err.message : err);
    tenant.__privateLoadFailed = true;
  }
  return hydrateTenantBookings(env, idToken, tenant);
}

async function getReminderDoc(env, idToken, tenantId, bookingId) {
  const url = reminderDocUrl(env, tenantId, bookingId);
  let res;
  try {
    const admin = await adminAuthHeaders(env);
    res = await fetch(url, { headers: { Authorization: admin.Authorization } });
  } catch (err) {
    console.warn('reminder dedup check failed', err);
    return { exists: false, fields: null, error: true };
  }
  if (res.status === 404) return { exists: false, fields: null, error: false };
  if (!res.ok) {
    console.warn('reminder dedup check failed', res.status);
    return { exists: false, fields: null, error: true, status: res.status };
  }
  const data = await res.json().catch(() => null);
  const raw = (data && data.fields) || {};
  const fields = {};
  for (const k of Object.keys(raw)) fields[k] = decodeFirestoreValue(raw[k]);
  return { exists: true, fields, error: false };
}

/** Email reminder already sent. Legacy docs (no smsReminderSentAt) still count. */
function emailReminderAlreadySent(booking, rec) {
  if (booking && booking.reminderSentAt) return true;
  if (!rec || rec.error || !rec.exists) return false;
  const f = rec.fields || {};
  if (f.sentAt || f.emailId) return true;
  if (!f.smsReminderSentAt && !f.smsConfirmSentAt) return true;
  return false;
}

function smsReminderAlreadySent(booking, rec) {
  if (booking && booking.smsReminderSentAt) return true;
  if (rec && rec.exists && rec.fields && rec.fields.smsReminderSentAt) return true;
  return false;
}

async function mergeReminderDoc(env, idToken, tenantId, booking, patch) {
  const url = reminderDocUrl(env, tenantId, booking.id);
  const admin = await adminAuthHeaders(env);
  let existing = {};
  try {
    const res = await fetch(url, { headers: { Authorization: admin.Authorization } });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const raw = (data && data.fields) || {};
      for (const k of Object.keys(raw)) existing[k] = decodeFirestoreValue(raw[k]);
    }
  } catch (_) {}
  const merged = Object.assign({}, existing, patch, {
    tenantId: tenantId,
    bookingId: booking.id,
    date: booking.date || existing.date || '',
  });
  const fields = {};
  for (const k of Object.keys(merged)) {
    if (merged[k] !== undefined) fields[k] = encodeFirestoreValue(merged[k]);
  }
  const init = {
    method: 'PATCH',
    headers: admin,
    body: JSON.stringify({ fields }),
  };
  let res = await fetch(url, init);
  if (res.status === 404) {
    const parent = url.slice(0, url.lastIndexOf('/'));
    const docId = url.slice(url.lastIndexOf('/') + 1);
    res = await fetch(parent + '?documentId=' + encodeURIComponent(docId), {
      method: 'POST',
      headers: init.headers,
      body: init.body,
    });
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.warn('reminder doc write failed', res.status, t.slice(0, 300));
  }
}

async function stampAppointment(env, idToken, tenant, bookingId, patch) {
  const appts = Array.isArray(tenant.appointments) ? tenant.appointments.slice() : [];
  let changed = false;
  for (let i = 0; i < appts.length; i++) {
    if (appts[i] && appts[i].id === bookingId) {
      appts[i] = Object.assign({}, appts[i], patch);
      changed = true;
      break;
    }
  }
  if (!changed) return;
  tenant.appointments = appts;
  await persistTenantAppointments(env, idToken, tenant.id, appts);
}

async function markReminderSent(env, idToken, tenant, booking, meta) {
  const sentAt = new Date().toISOString();
  await mergeReminderDoc(env, idToken, tenant.id, booking, {
    sentAt: sentAt,
    emailId: meta && meta.emailId ? meta.emailId : '',
  });
  try {
    await stampAppointment(env, idToken, tenant, booking.id, { reminderSentAt: sentAt });
  } catch (err) {
    console.warn('appointment reminderSentAt stamp failed', err);
  }
}

async function markSmsReminderSent(env, idToken, tenant, booking, meta) {
  const sentAt = new Date().toISOString();
  await mergeReminderDoc(env, idToken, tenant.id, booking, {
    smsReminderSentAt: sentAt,
    smsSid: meta && meta.sid ? meta.sid : '',
  });
  try {
    await stampAppointment(env, idToken, tenant, booking.id, { smsReminderSentAt: sentAt });
  } catch (err) {
    console.warn('appointment smsReminderSentAt stamp failed', err);
  }
}

async function markSmsConfirmSent(env, idToken, tenant, booking, meta) {
  if (!booking || !booking.id) return;
  const sentAt = new Date().toISOString();
  await mergeReminderDoc(env, idToken, tenant.id, booking, {
    smsConfirmSentAt: sentAt,
    smsConfirmSid: meta && meta.sid ? meta.sid : '',
  });
  try {
    await stampAppointment(env, idToken, tenant, booking.id, { smsConfirmSentAt: sentAt });
  } catch (err) {
    console.warn('appointment smsConfirmSentAt stamp failed', err);
  }
}

/**
 * Booking-confirmation SMS. Never throws. Skips when secrets, flag, or phone are missing.
 * hint: { tenantId, bookingId, phone, businessName, serviceName, date, time }
 */
async function sendBookingConfirmationSms(env, hint) {
  hint = hint || {};
  if (!twilioConfig(env)) return { ok: false, skipped: true, reason: 'twilio_not_configured' };
  const tenantId = String(hint.tenantId || '').trim();
  if (!tenantId) return { ok: false, skipped: true, reason: 'no_tenant' };
  let idToken;
  let tenant;
  try {
    idToken = await firebaseAnonymousToken(env);
    tenant = await getTenantById(env, idToken, tenantId);
  } catch (err) {
    console.warn('sms tenant lookup failed', err && err.message ? err.message : err);
    return { ok: false, skipped: true, reason: 'tenant_lookup_failed' };
  }
  if (!tenant || !tenantSmsEnabled(tenant)) {
    return { ok: false, skipped: true, reason: 'sms_disabled' };
  }
  const bookingId = String(hint.bookingId || '').trim();
  let booking = null;
  if (bookingId && Array.isArray(tenant.appointments)) {
    booking = tenant.appointments.find((b) => b && b.id === bookingId) || null;
  }
  // Phone always comes from the stored booking; a browser-supplied number is never texted.
  const phone = bookingPhone(booking);
  if (!phone) return { ok: false, skipped: true, reason: 'no_phone' };
  const src = booking || {
    id: bookingId,
    clientPhone: phone,
    serviceName: hint.serviceName || '',
    date: hint.date || '',
    time: hint.time || '',
  };
  if (booking && booking.smsConfirmSentAt) {
    return { ok: false, skipped: true, reason: 'already_sent' };
  }
  if (bookingId) {
    const rec = await getReminderDoc(env, idToken, tenantId, bookingId);
    if (rec.error) return { ok: false, skipped: true, reason: 'dedup_check_failed' };
    if (rec.exists && rec.fields && rec.fields.smsConfirmSentAt) {
      return { ok: false, skipped: true, reason: 'already_sent' };
    }
  }
  const result = await sendTwilioSms(env, { to: phone, body: buildConfirmationSms(tenant, src) });
  if (result.ok && bookingId) {
    try {
      await markSmsConfirmSent(env, idToken, tenant, src, { sid: result.sid });
    } catch (err) {
      console.warn('sms confirm dedup write failed', err);
    }
  }
  return result;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function todayInTimeZone(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || DEFAULT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA → YYYY-MM-DD
  return fmt.format(new Date());
}

function hourInTimeZone(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || DEFAULT_TZ,
    hour: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const hourPart = parts.find((p) => p.type === 'hour');
  let h = parseInt(hourPart && hourPart.value ? hourPart.value : '0', 10);
  if (h === 24) h = 0;
  return h;
}

function tenantTimezone(tenant) {
  return String((tenant && (tenant.timezone || tenant.timeZone)) || DEFAULT_TZ).trim() || DEFAULT_TZ;
}

/** Default ON when unset (matches prior always-send behavior). */
function tenantRemindersEnabled(tenant) {
  if (!tenant || tenant.remindersEnabled === undefined || tenant.remindersEnabled === null) {
    return true;
  }
  return tenant.remindersEnabled !== false;
}

/** Local hour 0–23; default 8. */
function tenantReminderHour(tenant) {
  let h = tenant && tenant.reminderHour;
  h = parseInt(h, 10);
  if (isNaN(h) || h < 0 || h > 23) return 8;
  return h;
}

function isCancelledBooking(booking) {
  const status = String((booking && (booking.status || booking.state)) || '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled' || status === 'deleted') return true;
  if (booking && booking.cancelled === true) return true;
  return false;
}

function buildReminderEmail(tenant, booking) {
  const biz = (tenant && tenant.name) || 'your appointment';
  const service = (booking && booking.serviceName) || 'Appointment';
  const when = `${booking.date || ''} at ${booking.time || ''}`.trim();
  const replyTo =
    (tenant.notifications && tenant.notifications.replyTo) || tenant.ownerEmail || '';
  const subject = `Reminder: ${service} today — ${biz}`;
  const text =
    `Hi ${booking.clientName || 'there'},\n\n` +
    `This is a friendly reminder that you have an appointment with ${biz} today.\n\n` +
    `Service: ${service}\n` +
    `When: ${when}\n` +
    `Reference: #${booking.id || ''}\n\n` +
    `Need to cancel or reschedule? Reply to this email` +
    (tenant.ownerPhone ? ` or call ${tenant.ownerPhone}` : '') +
    `.\n\n— ${biz}`;
  const html =
    `<div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#0f172a">` +
    `<h2 style="margin:0 0 12px;color:#0ea5e9">Appointment reminder</h2>` +
    `<p>Hi ${escapeHtml(booking.clientName || 'there')},</p>` +
    `<p>This is a friendly reminder that you have an appointment with <strong>${escapeHtml(biz)}</strong> today.</p>` +
    `<table style="border-collapse:collapse;margin:16px 0">` +
    `<tr><td style="padding:4px 12px 4px 0;color:#64748b">Service</td><td style="padding:4px 0;font-weight:600">${escapeHtml(service)}</td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0;color:#64748b">When</td><td style="padding:4px 0;font-weight:600">${escapeHtml(when)}</td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0;color:#64748b">Reference</td><td style="padding:4px 0;font-weight:600">#${escapeHtml(booking.id || '')}</td></tr>` +
    `</table>` +
    `<p style="color:#64748b;font-size:13px">Need to cancel or reschedule? Reply to this email` +
    (tenant.ownerPhone ? ` or call ${escapeHtml(tenant.ownerPhone)}` : '') +
    `.</p>` +
    `<p>— ${escapeHtml(biz)}</p></div>`;
  return { subject, text, html, replyTo, fromName: biz };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {object} env
 * @param {{ force?: boolean, dryRun?: boolean }} opts
 * force: ignore per-tenant reminderHour gate (for manual test)
 */
async function runSameDayReminders(env, opts) {
  opts = opts || {};
  const defaultTz = String(env.DEFAULT_TIMEZONE || DEFAULT_TZ).trim() || DEFAULT_TZ;

  const idToken = await firebaseAnonymousToken(env);
  const tenants = await listAllTenants(env, idToken);
  const results = [];
  let sent = 0;
  let smsSent = 0;
  let skipped = 0;
  let tenantsDisabled = 0;
  let tenantsWrongHour = 0;

  for (const tenant of tenants) {
    if (!tenantRemindersEnabled(tenant)) {
      tenantsDisabled++;
      skipped++;
      continue;
    }

    const tz = tenantTimezone(tenant);
    const localHour = hourInTimeZone(tz);
    const wantHour = tenantReminderHour(tenant);

    if (!opts.force && localHour !== wantHour) {
      tenantsWrongHour++;
      continue;
    }

    const today = todayInTimeZone(tz);
    const appts = Array.isArray(tenant.appointments) ? tenant.appointments : [];
    const smsOn = tenantSmsEnabled(tenant);
    for (const booking of appts) {
      if (!booking || !booking.id) continue;
      if (isCancelledBooking(booking)) {
        skipped++;
        continue;
      }
      if (String(booking.date || '') !== today) continue;
      // Walk-ins are already in the chair: never send them a same-day reminder.
      if (booking.walkIn === true) { skipped++; continue; }
      const email = String(booking.clientEmail || '').trim();
      const phone = bookingPhone(booking);
      const wantEmail = !!email;
      const wantSms = smsOn && !!phone;
      if (!wantEmail && !wantSms) {
        skipped++;
        continue;
      }

      const rec = await getReminderDoc(env, idToken, tenant.id, booking.id);

      if (wantEmail) {
        if (emailReminderAlreadySent(booking, rec)) {
          skipped++;
          results.push({ tenantId: tenant.id, bookingId: booking.id, status: 'already_sent', channel: 'email' });
        } else if (opts.dryRun) {
          results.push({
            tenantId: tenant.id,
            bookingId: booking.id,
            to: email,
            status: 'dry_run',
            channel: 'email',
            date: booking.date,
            time: booking.time,
            localHour,
            reminderHour: wantHour,
            timezone: tz,
          });
        } else {
          const content = buildReminderEmail(tenant, booking);
          const sendResult = await sendResend(env, {
            to: email,
            subject: content.subject,
            text: content.text,
            html: content.html,
            replyTo: content.replyTo,
            fromName: content.fromName,
          });

          if (sendResult.ok) {
            await markReminderSent(env, idToken, tenant, booking, { emailId: sendResult.id });
            sent++;
            results.push({
              tenantId: tenant.id,
              bookingId: booking.id,
              to: email,
              status: 'sent',
              channel: 'email',
              id: sendResult.id,
            });
          } else {
            results.push({
              tenantId: tenant.id,
              bookingId: booking.id,
              to: email,
              status: 'error',
              channel: 'email',
              error: sendResult,
            });
          }
        }
      }

      if (wantSms) {
        if (rec.error) {
          results.push({
            tenantId: tenant.id,
            bookingId: booking.id,
            status: 'sms_skipped',
            reason: 'dedup_check_failed',
          });
        } else if (smsReminderAlreadySent(booking, rec)) {
          results.push({
            tenantId: tenant.id,
            bookingId: booking.id,
            status: 'sms_already_sent',
          });
        } else if (!twilioConfig(env)) {
          results.push({
            tenantId: tenant.id,
            bookingId: booking.id,
            status: 'sms_skipped',
            reason: 'twilio_not_configured',
          });
        } else if (opts.dryRun) {
          results.push({
            tenantId: tenant.id,
            bookingId: booking.id,
            to: phone,
            status: 'sms_dry_run',
            date: booking.date,
            time: booking.time,
            localHour,
            reminderHour: wantHour,
            timezone: tz,
          });
        } else {
          const smsResult = await sendTwilioSms(env, {
            to: phone,
            body: buildReminderSms(tenant, booking),
          });
          if (smsResult.ok) {
            await markSmsReminderSent(env, idToken, tenant, booking, { sid: smsResult.sid });
            smsSent++;
            results.push({
              tenantId: tenant.id,
              bookingId: booking.id,
              status: 'sms_sent',
              sid: smsResult.sid,
            });
          } else {
            results.push({
              tenantId: tenant.id,
              bookingId: booking.id,
              status: smsResult.skipped ? 'sms_skipped' : 'sms_error',
              reason: smsResult.reason || smsResult.error,
              detail: smsResult.detail,
            });
          }
        }
      }
    }
  }

  return {
    ok: true,
    sent,
    smsSent,
    skipped,
    dryRun: !!opts.dryRun,
    force: !!opts.force,
    defaultTimezone: defaultTz,
    tenantsScanned: tenants.length,
    tenantsDisabled,
    tenantsWrongHour,
    results,
  };
}

/* ---------------- Owner address resolution for browser-built booking emails ----------------
 * The public booking page no longer knows the owner's email/phone (they're in the private tenant doc).
 * The browser sends ownerTenantId plus:
 *   toOwner: true        -> worker sets `to` to the owner's notify address (notifications.replyTo || ownerEmail)
 *   replyToOwner: true   -> worker sets reply-to to that address
 *   {{schedi_owner_contact}} in text/html -> "Name at email or phone"
 * Reply-to and contact text reveal the owner's address, so they're only filled when the single recipient
 * is the owner or a client with a booking at that business. Otherwise they're left blank.
 */
const OWNER_CONTACT_TOKEN = '{{schedi_owner_contact}}';

function mailHasOwnerToken(data) {
  return ['subject', 'text', 'html'].some((k) => typeof data[k] === 'string' && data[k].indexOf(OWNER_CONTACT_TOKEN) !== -1);
}

function fillOwnerToken(data, textValue, htmlValue) {
  if (typeof data.text === 'string') data.text = data.text.split(OWNER_CONTACT_TOKEN).join(textValue);
  if (typeof data.html === 'string') data.html = data.html.split(OWNER_CONTACT_TOKEN).join(htmlValue);
  if (typeof data.subject === 'string') data.subject = data.subject.split(OWNER_CONTACT_TOKEN).join('');
}

function tenantHasClientEmail(tenant, email) {
  const want = String(email || '').trim().toLowerCase();
  if (!want) return false;
  return (Array.isArray(tenant && tenant.appointments) ? tenant.appointments : []).some(
    (a) => a && String(a.clientEmail || '').trim().toLowerCase() === want
  );
}

async function resolveOwnerMailFields(env, data, deps) {
  deps = deps || {};
  const loadTenant = deps.getTenantById || getTenantById;
  const anonToken = deps.firebaseAnonymousToken || firebaseAnonymousToken;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const wantsTo = data.toOwner === true;
  const wantsReply = data.replyToOwner === true;
  const wantsContact = mailHasOwnerToken(data);
  if (!wantsTo && !wantsReply && !wantsContact) return { ok: true };
  const tenantId = safeTenantId(data.ownerTenantId || data.tenantId);
  if (!tenantId) {
    if (wantsTo) return { ok: false, status: 400, error: 'owner_tenant_required' };
    fillOwnerToken(data, 'us', 'us');
    if (wantsReply) data.replyTo = '';
    return { ok: true };
  }
  let idToken;
  let tenant;
  try {
    idToken = await anonToken(env);
    tenant = await loadTenant(env, idToken, tenantId);
  } catch (_) {
    return { ok: false, status: 502, error: 'tenant_lookup_failed' };
  }
  if (!tenant) return { ok: false, status: 404, error: 'tenant_not_found' };
  const ownerEmail = String(tenant.ownerEmail || '').trim();
  const notifyTo = String((tenant.notifications && tenant.notifications.replyTo) || ownerEmail || '').trim();
  if (wantsTo) {
    if (!notifyTo || notifyTo.indexOf('@') < 1) return { ok: false, status: 400, error: 'owner_email_missing' };
    data.to = notifyTo;
  }
  let allowed = wantsTo;
  if (!allowed && (wantsReply || wantsContact)) {
    const rcpts = normalizeTo(data.to).map((x) => x.toLowerCase());
    if (rcpts.length === 1) {
      const r = rcpts[0];
      if (r && ((ownerEmail && r === ownerEmail.toLowerCase()) || (notifyTo && r === notifyTo.toLowerCase()))) {
        allowed = true;
      } else {
        // The booking save and the email are sent at the same moment from the page; give the save a moment.
        allowed = tenantHasClientEmail(tenant, r);
        for (let i = 0; !allowed && i < 3; i++) {
          await sleep(900);
          try {
            const again = await loadTenant(env, idToken, tenantId);
            allowed = tenantHasClientEmail(again, r);
          } catch (_) {}
        }
      }
    }
  }
  if (wantsReply) data.replyTo = allowed ? notifyTo : '';
  if (wantsContact) {
    if (allowed) {
      const name = String(tenant.ownerName || '').trim() || 'us';
      const phone = String(tenant.ownerPhone || '').trim();
      const text = name + (ownerEmail ? ' at ' + ownerEmail : '') + (phone ? ' or ' + phone : '');
      const html = escapeHtml(name) + (ownerEmail ? ' at ' + escapeHtml(ownerEmail) : '') + (phone ? ' or ' + escapeHtml(phone) : '');
      fillOwnerToken(data, text, html);
    } else {
      fillOwnerToken(data, 'us', 'us');
    }
  }
  return { ok: true, allowed };
}

/* ---------------- Schedi owner billing (Stripe secret stays on the worker) ---------------- */

const BILLING_PRICES = {
  starter: { price: 'price_1UMH8jGh1H5O3dkraHpGvCEN', amount: 29 },
  pro: { price: 'price_1UMH8jGh1H5O3dkr3fNrA90v', amount: 49 },
};
const BILLING_PORTAL_CONFIGURATION = 'bpc_1ULDvXGh1H5O3dkrbEG83H3f';
const BILLING_APP_ORIGIN = 'https://schedi.app';
const STRIPE_WEBHOOK_TOLERANCE_SEC = 300;

function billingReturnUrl(kind, tenantId) {
  const u = new URL(BILLING_APP_ORIGIN + '/');
  u.searchParams.set('billing', kind);
  u.searchParams.set('tenantId', tenantId);
  return u.toString();
}

function feeNumber(tenant) {
  const n = Number(tenant && tenant.monthlyPrice);
  return Number.isFinite(n) ? n : 0;
}

function safeTenantId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return '';
  return id;
}

async function stripeRequest(env, path, { method, params, extraHeaders } = {}) {
  const key = String((env && env.STRIPE_SECRET_KEY) || '').trim();
  if (!key) return { ok: false, status: 500, error: 'stripe_not_configured' };
  const headers = { Authorization: 'Bearer ' + key };
  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const hk of Object.keys(extraHeaders)) {
      if (extraHeaders[hk]) headers[hk] = String(extraHeaders[hk]);
    }
  }
  let body;
  const m = method || (params ? 'POST' : 'GET');
  if (params) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = params.toString();
  }
  let res;
  try {
    res = await fetch('https://api.stripe.com' + path, { method: m, headers, body });
  } catch (err) {
    return { ok: false, status: 502, error: 'stripe_network' };
  }
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  if (!res.ok) {
    const err = data && data.error ? data.error : {};
    return {
      ok: false,
      status: res.status,
      error: err.message || 'stripe_error',
      code: err.code || err.type || '',
    };
  }
  return { ok: true, status: res.status, data };
}

async function patchTenantFields(env, idToken, tenantId, rawPatch) {
  // Billing fields go to the private doc. The public doc keeps booking-page fields only.
  const shaped = shapePublicPatch(rawPatch || {});
  if (Object.keys(shaped.priv).length) await patchPrivateTenant(env, tenantId, shaped.priv);
  const keys = Object.keys(shaped.pub).filter((k) => shaped.pub[k] !== undefined);
  const mask = keys.concat(shaped.drop || []);
  if (!mask.length) return;
  const qs = mask.map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const fields = {};
  for (const k of keys) fields[k] = encodeFirestoreValue(shaped.pub[k]);
  const res = await fetch(tenantDocUrl(env, tenantId) + '?' + qs, {
    method: 'PATCH',
    headers: await adminAuthHeaders(env),
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('firestore_billing_patch_failed:' + res.status + ':' + t.slice(0, 240));
  }
}

async function resolveBillingTenantId(env, { tenantId, customerId, subscriptionId }) {
  const direct = safeTenantId(tenantId);
  if (direct) return direct;
  if (!customerId && !subscriptionId) return '';
  const idToken = await firebaseAnonymousToken(env);
  const tenants = await listAllTenants(env, idToken);
  const match = tenants.find((t) => {
    if (subscriptionId && t && t.stripeSubscriptionId === subscriptionId) return true;
    if (customerId && t && t.stripeCustomerId === customerId) return true;
    return false;
  });
  return match && match.id ? safeTenantId(match.id) : '';
}

async function markSubscriptionActive(env, { tenantId, customerId, subscriptionId, plan }) {
  const id = safeTenantId(tenantId);
  if (!id) return { ok: false, ignored: true, reason: 'no_tenant' };
  const idToken = await firebaseAnonymousToken(env);
  const tenant = await getTenantById(env, idToken, id);
  if (!tenant) return { ok: false, ignored: true, reason: 'tenant_not_found' };
  const patch = {
    subscriptionStatus: 'active',
    paymentForm: 'Stripe autopay',
  };
  if (customerId) patch.stripeCustomerId = String(customerId);
  if (subscriptionId) patch.stripeSubscriptionId = String(subscriptionId);
  if (tenant.complimentaryPro === true || tenant.billingExempt === true) {
    patch.plan = 'pro';
    patch.monthlyPrice = 0;
    patch.complimentaryPro = true;
    patch.subscriptionStatus = 'active';
  } else if (plan === 'starter' || plan === 'pro') {
    const previous = tenantPlanName(tenant);
    patch.plan = plan;
    patch.monthlyPrice = BILLING_PRICES[plan].amount;
    patch.complimentaryPro = false;
    patch.paymentForm = 'Stripe autopay';
    // Only touch feature settings when the plan actually changes (not on every monthly invoice),
    // and keep the owner's other payment options.
    if (previous !== plan) {
      const gw = Object.assign(
        { card: false, cashapp: false, zelle: false, venmo: false, paypal: false, later: true },
        (tenant.paymentGateways && typeof tenant.paymentGateways === 'object') ? tenant.paymentGateways : {}
      );
      if (plan === 'pro') {
        patch.allowRecurringBookings = true;
        gw.card = true;
      } else {
        // Starter: repeating appointments, card checkout and deposits are Pro-only.
        patch.allowRecurringBookings = false;
        gw.card = false;
        if (tenant.deposit && typeof tenant.deposit === 'object' && tenant.deposit.enabled) {
          patch.deposit = Object.assign({}, tenant.deposit, { enabled: false });
        }
      }
      patch.paymentGateways = gw;
    }
  }
  await patchTenantFields(env, idToken, id, patch);
  return { ok: true, tenantId: id };
}

async function markSubscriptionPaused(env, tenantId, subscriptionId) {
  const id = safeTenantId(tenantId);
  if (!id) return { ok: false, ignored: true, reason: 'no_tenant' };
  const idToken = await firebaseAnonymousToken(env);
  const tenant = await getTenantById(env, idToken, id);
  if (!tenant) return { ok: false, ignored: true, reason: 'tenant_not_found' };
  if (tenant.complimentaryPro === true || tenant.billingExempt === true) {
    return { ok: true, ignored: true, reason: 'complimentary' };
  }
  // A plan switch cancels the old subscription; its deletion must not pause the new one.
  const current = String(tenant.stripeSubscriptionId || '').trim();
  if (subscriptionId && current && current !== String(subscriptionId)) {
    return { ok: true, ignored: true, reason: 'not_current_subscription' };
  }
  await patchTenantFields(env, idToken, id, { subscriptionStatus: 'paused' });
  return { ok: true, tenantId: id };
}

async function saveSubscriptionSchedule(env, tenantId, sub) {
  const id = safeTenantId(tenantId);
  if (!id) return { ok: false, ignored: true, reason: 'no_tenant' };
  const idToken = await firebaseAnonymousToken(env);
  const tenant = await getTenantById(env, idToken, id);
  if (!tenant) return { ok: false, ignored: true, reason: 'tenant_not_found' };
  if (tenant.complimentaryPro === true || tenant.billingExempt === true) {
    return { ok: true, ignored: true, reason: 'complimentary' };
  }
  const current = String(tenant.stripeSubscriptionId || '').trim();
  const subId = String((sub && sub.id) || '');
  if (!current || current !== subId) return { ok: true, ignored: true, reason: 'not_current_subscription' };
  const schedule = subscriptionScheduleFromStripe(sub);
  const same =
    (tenant.cancelAtPeriodEnd === true) === schedule.cancelAtPeriodEnd &&
    String(tenant.currentPeriodEnd || '') === schedule.currentPeriodEnd;
  if (same) return { ok: true, tenantId: id, unchanged: true };
  await patchTenantFields(env, idToken, id, schedule);
  return { ok: true, tenantId: id, cancelAtPeriodEnd: schedule.cancelAtPeriodEnd };
}

function planFromMetadata(meta) {
  const plan = meta && meta.plan ? String(meta.plan).toLowerCase() : '';
  if (plan === 'free' || plan === 'starter' || plan === 'pro') return plan;
  return '';
}

function signupPlan(meta) {
  const plan = planFromMetadata(meta);
  return plan || 'starter';
}

async function subscriptionContext(env, subscriptionId) {
  if (!subscriptionId) return { metadata: {}, customer: '', id: '', status: '', plan: '', found: false };
  const result = await stripeRequest(env, '/v1/subscriptions/' + encodeURIComponent(subscriptionId));
  if (!result.ok || !result.data) {
    return { metadata: {}, customer: '', id: subscriptionId, status: '', plan: '', found: false, httpStatus: result.status || 0 };
  }
  return {
    metadata: result.data.metadata || {},
    customer: result.data.customer || '',
    id: result.data.id || subscriptionId,
    status: String(result.data.status || ''),
    plan: planFromStripePrice(result.data) || planFromMetadata(result.data.metadata || {}),
    cancelAtPeriodEnd: result.data.cancel_at_period_end === true,
    found: true,
  };
}

async function verifyStripeWebhook(rawBody, sigHeader, secret) {
  const header = String(sigHeader || '').trim();
  const keyMaterial = String(secret || '').trim();
  if (!header || !keyMaterial) return false;
  let timestamp = '';
  const signatures = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 't') timestamp = v;
    if (k === 'v1' && v) signatures.push(v);
  }
  if (!timestamp || !signatures.length) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > STRIPE_WEBHOOK_TOLERANCE_SEC) return false;
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(timestamp + '.' + rawBody));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return signatures.some((sig) => timingSafeEqual(sig, hex));
}


const SIGNUP_RESERVED_SLUGS = new Set(['signup', 'agency', 'admin', 'hq', 'hq-9h7p52', 'billing', 'api', 'auth', 'terms', 'privacy', 'help', 'index', 'www', 'schedi']);

function slugifyBusinessName(name) {
  let s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length < 2) s = 'business';
  if (s.length > 32) s = s.slice(0, 32).replace(/-+$/g, '');
  if (!/^[a-z0-9]/.test(s)) s = 'b-' + s;
  return s;
}

function temporaryOwnerPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function defaultSignupTenant(meta, billing) {
  const slug = safeTenantId(meta.slug || meta.tenantId);
  const plan = signupPlan(meta);
  const fee = plan === 'free' ? 0 : (BILLING_PRICES[plan] ? BILLING_PRICES[plan].amount : 29);
  const paid = plan !== 'free';
  const hours = { open: true, start: '09:00 AM', end: '05:00 PM' };
  const closed = { open: false, start: '10:00 AM', end: '03:00 PM' };
  return {
    id: slug,
    name: String(meta.businessName || slug),
    slug: slug,
    industry: 'Services',
    ownerName: String(meta.ownerName || ''),
    ownerPhone: '',
    ownerEmail: String(meta.ownerEmail || ''),
    plan: plan,
    monthlyPrice: fee,
    complimentaryPro: false,
    subscriptionStatus: 'active',
    paymentForm: paid ? 'Not subscribed' : 'Free',
    stripeCustomerId: billing && billing.customerId ? String(billing.customerId) : '',
    stripeSubscriptionId: billing && billing.subscriptionId ? String(billing.subscriptionId) : '',
    cashAppTag: '',
    services: [
      { id: 1, name: 'Standard appointment', duration: '45 mins', durationMins: 45, price: 60, desc: 'Core service appointment.', icon: 'fa-calendar-check' },
    ],
    operatingHours: { Mon: hours, Tue: hours, Wed: hours, Thu: hours, Fri: hours, Sat: closed, Sun: closed },
    blockedRules: [],
    blockedTimes: [],
    paymentGateways: paid
      ? { card: true, cashapp: false, zelle: false, venmo: false, paypal: false, later: true }
      : { card: false, cashapp: false, zelle: false, venmo: false, paypal: false, later: true },
    notifications: { emailConfirmations: true, replyTo: String(meta.ownerEmail || ''), extraNote: '' },
    allowRecurringBookings: paid,
    remindersEnabled: true,
    reminderHour: 8,
    timezone: 'America/New_York',
    smsEnabled: false,
    // Paid signups: when checkout started, so the hourly cron can send one "finish setting up" reminder.
    signupStartedAt: paid && !(billing && billing.subscriptionId) ? new Date().toISOString() : '',
  };
}

async function createTenantDocument(env, idToken, fullTenant) {
  // New signups: booking-page fields on the public doc, owner contact + billing on the private doc.
  const { pub: tenant, priv } = shapePublicBookingFields(fullTenant);
  tenant.id = fullTenant.id;
  const fields = {};
  for (const k of Object.keys(tenant)) {
    if (tenant[k] !== undefined) fields[k] = encodeFirestoreValue(tenant[k]);
  }
  const url = tenantsCollectionUrl(env) + '?documentId=' + encodeURIComponent(tenant.id);
  const res = await fetch(url, {
    method: 'POST',
    headers: await adminAuthHeaders(env),
    body: JSON.stringify({ fields }),
  });
  if (res.status === 409) return { ok: true, existed: true };
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('firestore_create_tenant_failed:' + res.status + ':' + t.slice(0, 180));
  }
  if (Object.keys(priv).length) await patchPrivateTenant(env, fullTenant.id, priv);
  return { ok: true, existed: false };
}

async function ensureSignupTenant(env, meta, billing) {
  const slug = safeTenantId(meta && (meta.slug || meta.tenantId));
  if (!slug || !meta || meta.signup !== '1') return { ok: false, ignored: true };
  const idToken = await firebaseAnonymousToken(env);
  const existing = await getTenantById(env, idToken, slug);
  if (existing) return { ok: true, existed: true };
  const tenant = defaultSignupTenant(meta, billing || {});
  delete tenant.ownerPassword;
  if (meta && meta.ownerPassword) {
    await saveOwnerSecret(env, tenant.ownerEmail, tenant.id, meta.ownerPassword);
  }
  await createTenantDocument(env, idToken, tenant);
  return { ok: true, existed: false };
}


const ONBOARDING_REPLY_TO = 'admin@schedi.app';

function escHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ownerFirstName(name) {
  const part = String(name || '').trim().split(/\s+/)[0];
  return part || 'there';
}

function visibleSchediUrl(url) {
  return String(url || '').replace(/^https:\/\//i, 'https&#58;//');
}

function billingSubscribeUrl(tenantId, plan) {
  const payPlan = plan === 'pro' ? 'pro' : 'starter';
  const u = new URL(BILLING_APP_ORIGIN + '/billing/subscribe');
  u.searchParams.set('tenantId', tenantId);
  u.searchParams.set('plan', payPlan);
  return u.toString();
}

function buildOnboardingMessage(info) {
  const slug = String(info.slug || '');
  const plan = info.plan === 'pro' ? 'pro' : info.plan === 'free' ? 'free' : 'starter';
  const payPlan = plan === 'pro' ? 'pro' : 'starter';
  const publicUrl = BILLING_APP_ORIGIN + '/' + slug + '/';
  const portalUrl = BILLING_APP_ORIGIN + '/';
  const paymentLink = billingSubscribeUrl(slug, payPlan);
  const amount = BILLING_PRICES[payPlan].amount;
  const first = ownerFirstName(info.ownerName);
  const business = String(info.businessName || slug);
  const email = String(info.ownerEmail || '');
  const password = String(info.password || '');
  let payText;
  let payHtml;
  if (plan === 'free') {
    payText = 'You are on the Free plan: one service, 5 bookings a week (Monday–Sunday), the Schedi badge, no recurring visits, and pay at the appointment. You can move to Starter at $' + amount + '/mo when you want: ' + paymentLink;
    payHtml = '<p>You are on the Free plan: one service, 5 bookings a week (Monday–Sunday), the Schedi badge, no recurring visits, and pay at the appointment. You can move to Starter at $' + amount + '/mo when you want: <a href="' + escHtml(paymentLink) + '">' + visibleSchediUrl(paymentLink) + '</a></p>';
  } else {
    const label = plan === 'pro' ? 'Pro' : 'Starter';
    payText = 'You chose ' + label + ' at $' + amount + '/mo. Nothing is charged until payment finishes. Pay for that subscription here: ' + paymentLink;
    payHtml = '<p>You chose ' + label + ' at $' + amount + '/mo. Nothing is charged until payment finishes. Pay for that subscription here: <a href="' + escHtml(paymentLink) + '">' + visibleSchediUrl(paymentLink) + '</a></p>';
  }
  const agency = info.agency === true;
  const textParts = [
    'Hi ' + first + ',',
    '',
    business + ' is ready on Schedi.',
    '',
    'Public booking page: ' + publicUrl,
  ];
  textParts.push(
    '',
    'Business portal: ' + portalUrl,
    'Owner email: ' + email,
    'Temporary password: ' + password,
    'Change the password after you log in.',
    '',
    'Hours start at 9:00 AM–5:00 PM Monday through Friday, and the first service is a standard appointment. You can change hours and services in the portal.',
    'Email confirmations are on. Same-day reminders are optional.',
    'Use the Share button on the booking page when you want to send the link.',
  );
  if (!agency) textParts.push('', payText);
  textParts.push('', 'Axel', 'Schedi', ONBOARDING_REPLY_TO);
  const text = textParts.join('\n');
  const htmlParts = [
    '<p>Hi ' + escHtml(first) + ',</p>',
    '<p>' + escHtml(business) + ' is ready on Schedi.</p>',
    '<p>Public booking page: <a href="' + escHtml(publicUrl) + '">' + visibleSchediUrl(publicUrl) + '</a></p>',
  ];
  htmlParts.push(
    '<p>Business portal: <a href="' + escHtml(portalUrl) + '">' + visibleSchediUrl(portalUrl) + '</a></p>',
    '<p>Owner email: ' + escHtml(email) + '</p>',
    '<p>Temporary password: ' + escHtml(password) + '</p>',
    '<p>Change the password after you log in.</p>',
    '<p>Hours start at 9:00 AM–5:00 PM Monday through Friday, and the first service is a standard appointment. You can change hours and services in the portal.</p>',
    '<p>Email confirmations are on. Same-day reminders are optional.</p>',
    '<p>Use the Share button on the booking page when you want to send the link.</p>',
  );
  if (!agency) htmlParts.push(payHtml);
  htmlParts.push('<p>Axel<br>Schedi<br>' + escHtml(ONBOARDING_REPLY_TO) + '</p>');
  const html = htmlParts.join('');
  return {
    from: 'Schedi <' + ONBOARDING_FROM + '>',
    replyTo: ONBOARDING_REPLY_TO,
    subject: 'Your Schedi booking page is ready',
    text: text,
    html: html,
    publicUrl: publicUrl,
    paymentLink: paymentLink,
  };
}

async function sendOnboardingEmail(env, info) {
  const message = buildOnboardingMessage(info);
  const sent = await sendResend(env, {
    to: info.ownerEmail,
    subject: message.subject,
    html: message.html,
    text: message.text,
    replyTo: message.replyTo,
    fromName: 'Schedi',
    fromAddress: ONBOARDING_FROM,
  });
  return { ok: !!sent.ok, error: sent.ok ? '' : (sent.error || 'email_failed'), message: message };
}

const AGENCY_CONFIRM_TO = 'admin@schedi.app';
const AGENCY_CONFIRM_SUBJECT = 'A new Schedi business was provisioned';

function buildAgencyConfirmMessage(info) {
  const slug = String(info.slug || '');
  const publicUrl = BILLING_APP_ORIGIN + '/' + slug + '/';
  const business = String(info.businessName || slug);
  const email = String(info.ownerEmail || '');
  const text = [
    'A new business was provisioned on Schedi.',
    '',
    'Business: ' + business,
    'Slug: ' + slug,
    'Public page: ' + publicUrl,
    'The welcome email was sent to: ' + email,
  ].join('\n');
  const html = [
    '<p>A new business was provisioned on Schedi.</p>',
    '<p>Business: ' + escHtml(business) + '</p>',
    '<p>Slug: ' + escHtml(slug) + '</p>',
    '<p>Public page: <a href="' + escHtml(publicUrl) + '">' + visibleSchediUrl(publicUrl) + '</a></p>',
    '<p>The welcome email was sent to: ' + escHtml(email) + '</p>',
  ].join('');
  return {
    subject: AGENCY_CONFIRM_SUBJECT,
    text: text,
    html: html,
    replyTo: ONBOARDING_REPLY_TO,
  };
}

async function sendAgencyProvisionEmails(env, info) {
  const owner = await sendOnboardingEmail(env, info);
  if (!owner.ok) {
    return { ok: false, ownerSent: false, confirmSent: false, error: owner.error || 'owner_email_failed' };
  }
  const confirm = buildAgencyConfirmMessage(info);
  const sent = await sendResend(env, {
    to: AGENCY_CONFIRM_TO,
    subject: confirm.subject,
    html: confirm.html,
    text: confirm.text,
    replyTo: confirm.replyTo,
    fromName: 'Schedi',
    fromAddress: ONBOARDING_FROM,
  });
  return {
    ok: !!sent.ok,
    ownerSent: true,
    confirmSent: !!sent.ok,
    error: sent.ok ? '' : (sent.error || 'confirm_email_failed'),
  };
}

async function handleAgencyProvisionMail(request, env, origin) {
  if (request.method === 'OPTIONS') {
    if (origin && !isAllowedOrigin(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
  let data = {};
  try { data = await request.json(); } catch (_) { data = {}; }
  const gate = await requireAgency(env, request, data);
  if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status, origin);
  const businessName = String(data.businessName || data.name || '').trim().slice(0, 80);
  const slug = String(data.slug || '').trim();
  const ownerName = String(data.ownerName || '').trim().slice(0, 80);
  const ownerEmail = String(data.ownerEmail || '').trim().slice(0, 160);
  const rotate = data.rotate === true;
  if (!businessName) return json({ ok: false, error: 'business_name_required' }, 400, origin);
  if (!safeTenantId(slug)) return json({ ok: false, error: 'invalid_slug' }, 400, origin);
  if (!ownerEmail || ownerEmail.indexOf('@') < 1) return json({ ok: false, error: 'owner_email_required' }, 400, origin);
  const password = rotate ? temporaryOwnerPassword() : String(data.password || '');
  if (String(password).length < 8) return json({ ok: false, error: 'invalid_password' }, 400, origin);
  if (!authReady(env)) return json({ ok: false, error: 'auth_not_configured' }, 500, origin);
  const saved = await saveOwnerSecret(env, ownerEmail, slug, password);
  if (!saved.ok) return json({ ok: false, error: 'password_store_failed' }, 500, origin);
  let result;
  try {
    result = await sendAgencyProvisionEmails(env, {
      agency: true,
      slug: slug,
      businessName: businessName,
      ownerName: ownerName,
      ownerEmail: ownerEmail,
      password: password,
    });
  } catch (_) {
    result = { ok: false, ownerSent: false, confirmSent: false, error: 'email_failed' };
  }
  return json({
    ok: !!(result.ownerSent && result.confirmSent),
    ownerSent: !!result.ownerSent,
    confirmSent: !!result.confirmSent,
    error: result.ownerSent && result.confirmSent ? '' : (result.error || 'email_failed'),
  }, result.ownerSent || result.confirmSent ? 200 : 502, origin);
}


function subscribeCheckoutAllowed(tenant, plan) {
  if (!tenant || (plan !== 'starter' && plan !== 'pro')) return false;
  if (tenant.complimentaryPro === true || tenant.billingExempt === true) return false;
  if (String(tenant.stripeSubscriptionId || '').trim()) return false;
  const stored = String(tenant.plan || '').toLowerCase();
  if (stored === 'starter' || stored === 'pro') return stored === plan;
  const n = feeNumber(tenant);
  if (n === 29 || n === 49) return plan === 'starter';
  if (n === 99) return plan === 'pro';
  if (n === 0) return true;
  return true;
}

async function handleBillingSignup(request, env, origin) {
  // Public signup: no static secret. Browser origin must be Schedi, and it is rate limited per IP and overall.
  if (!origin || !isAllowedOrigin(origin)) {
    return json({ ok: false, error: 'origin_not_allowed' }, 403, origin);
  }
  const signupIp = String(request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 64);
  if (!(await rateLimitOk(env.RL_SIGNUP, 'ip:' + signupIp, 3, 'signup')) || !(await rateLimitOk(env.RL_SIGNUP_GLOBAL, 'global', 20, 'signupg'))) {
    return json({ ok: false, error: 'Too many signups right now. Please wait a minute and try again.' }, 429, origin);
  }
  let data;
  try {
    data = JSON.parse((await request.text()) || '{}');
  } catch (_) {
    return json({ ok: false, error: 'invalid_json' }, 400, origin);
  }
  const businessName = String(data.businessName || data.name || '').trim().slice(0, 80);
  const ownerName = String(data.ownerName || '').trim().slice(0, 80);
  const ownerEmail = String(data.ownerEmail || data.email || '').trim().slice(0, 160);
  const plan = String(data.plan || '').trim().toLowerCase();
  if (!businessName || businessName.length < 2) return json({ ok: false, error: 'business_name_required' }, 400, origin);
  if (!ownerName) return json({ ok: false, error: 'owner_name_required' }, 400, origin);
  if (!ownerEmail || ownerEmail.indexOf('@') < 1) return json({ ok: false, error: 'owner_email_required' }, 400, origin);
  if (plan !== 'free' && plan !== 'starter' && plan !== 'pro') return json({ ok: false, error: 'invalid_plan' }, 400, origin);

  if (data.dryRun === true) {
    const preview = buildOnboardingMessage({
      slug: 'example-biz',
      plan: plan,
      businessName: businessName,
      ownerName: ownerName,
      ownerEmail: ownerEmail,
      password: '',
    });
    return json({
      ok: true,
      dryRun: true,
      from: preview.from,
      replyTo: preview.replyTo,
      subject: preview.subject,
      publicUrl: preview.publicUrl,
      paymentLink: preview.paymentLink,
      hasGoogleRedirect: preview.html.indexOf('google.com/url') !== -1,
    }, 200, origin);
  }

  // Real signups create a tenant and send mail: hard cap per IP per hour in KV (the edge limiter is permissive).
  if (env.AUTH_KV) {
    const capKey = 'rl:signup:' + signupIp + ':' + new Date().toISOString().slice(0, 13);
    const used = parseInt((await env.AUTH_KV.get(capKey)) || '0', 10) || 0;
    if (used >= 5) {
      return json({ ok: false, error: 'Too many signups right now. Please wait a minute and try again.' }, 429, origin);
    }
    await env.AUTH_KV.put(capKey, String(used + 1), { expirationTtl: 7200 });
  }

  let idToken;
  try {
    idToken = await firebaseAnonymousToken(env);
  } catch (_) {
    return json({ ok: false, error: 'tenant_lookup_failed' }, 502, origin);
  }
  let slug = slugifyBusinessName(businessName);
  if (SIGNUP_RESERVED_SLUGS.has(slug)) slug = slug + '-biz';
  for (let n = 0; n < 6; n++) {
    const candidate = n === 0 ? slug : (slug + '-' + (n + 1));
    const taken = await getTenantById(env, idToken, candidate);
    if (!taken && !SIGNUP_RESERVED_SLUGS.has(candidate)) {
      slug = candidate;
      break;
    }
    if (n === 5) slug = slug + '-' + Date.now().toString(36).slice(-4);
  }
  if (!safeTenantId(slug)) return json({ ok: false, error: 'invalid_slug' }, 400, origin);

  const ownerPassword = temporaryOwnerPassword();
  const meta = {
    signup: '1',
    slug: slug,
    tenantId: slug,
    plan: plan,
    businessName: businessName,
    ownerName: ownerName,
    ownerEmail: ownerEmail,
  };
  if (!authReady(env)) {
    return json({ ok: false, error: 'auth_not_configured' }, 500, origin);
  }
  const ownerSecret = await saveOwnerSecret(env, ownerEmail, slug, ownerPassword);
  if (!ownerSecret.ok) {
    return json({ ok: false, error: 'Could not store the owner login.' }, 500, origin);
  }
  try {
    await ensureSignupTenant(env, meta, {});
  } catch (_) {
    return json({ ok: false, error: 'tenant_create_failed' }, 502, origin);
  }
  const payPlan = plan === 'pro' ? 'pro' : 'starter';
  const paymentLink = billingSubscribeUrl(slug, payPlan);
  let emailSent = false;
  try {
    const mailed = await sendOnboardingEmail(env, {
      slug: slug,
      plan: plan,
      businessName: businessName,
      ownerName: ownerName,
      ownerEmail: ownerEmail,
      password: ownerPassword,
    });
    emailSent = mailed.ok;
  } catch (_) {
    emailSent = false;
  }
  if (plan === 'free') {
    return json({
      slug: slug,
      ownerEmail: ownerEmail,
      temporaryPassword: ownerPassword,
      plan: plan,
      paymentLink: paymentLink,
      publicUrl: BILLING_APP_ORIGIN + '/' + slug + '/',
      emailSent: emailSent,
    }, 200, origin);
  }

  const success = new URL(BILLING_APP_ORIGIN + '/signup');
  success.searchParams.set('billing', 'success');
  success.searchParams.set('slug', slug);
  const cancel = new URL(BILLING_APP_ORIGIN + '/signup');
  cancel.searchParams.set('billing', 'cancel');
  cancel.searchParams.set('slug', slug);

  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('line_items[0][price]', BILLING_PRICES[plan].price);
  params.set('line_items[0][quantity]', '1');
  params.set('customer_email', ownerEmail);
  params.set('success_url', success.toString());
  params.set('cancel_url', cancel.toString());
  params.set('client_reference_id', slug);
  params.set('metadata[signup]', '1');
  params.set('metadata[tenantId]', slug);
  params.set('metadata[slug]', slug);
  params.set('metadata[plan]', plan);
  params.set('metadata[businessName]', businessName);
  params.set('metadata[ownerName]', ownerName);
  params.set('metadata[ownerEmail]', ownerEmail);
  params.set('subscription_data[metadata][signup]', '1');
  params.set('subscription_data[metadata][tenantId]', slug);
  params.set('subscription_data[metadata][slug]', slug);
  params.set('subscription_data[metadata][plan]', plan);
  params.set('subscription_data[metadata][businessName]', businessName);
  params.set('subscription_data[metadata][ownerName]', ownerName);
  params.set('subscription_data[metadata][ownerEmail]', ownerEmail);

  const created = await stripeRequest(env, '/v1/checkout/sessions', { method: 'POST', params });
  const url = created.ok && created.data ? created.data.url : '';
  return json({
    url: url || paymentLink,
    slug: slug,
    ownerEmail: ownerEmail,
    temporaryPassword: ownerPassword,
    plan: plan,
    paymentLink: paymentLink,
    publicUrl: BILLING_APP_ORIGIN + '/' + slug + '/',
    emailSent: emailSent,
  }, 200, origin);
}

/**
 * Signed-in owner of this business, or the agency.
 * true = allowed, 'forbidden' = signed in as someone else, false = no session.
 * Boolean false stays a 401 so existing callers and test doubles keep working.
 */
async function billingSessionAllows(env, sessionToken, tenantId) {
  try {
    const session = await readSession(env, sessionToken);
    if (!session) return false;
    if (session.role === 'agency') return true;
    if (session.role === 'owner' && String(session.tenantId || '') === String(tenantId || '')) return true;
    return 'forbidden';
  } catch (_) {
    return false;
  }
}

function billingDenied(allowed) {
  if (allowed === true) return null;
  if (allowed === 'forbidden') return { status: 403, error: 'forbidden' };
  return { status: 401, error: 'session_required' };
}

const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);

/**
 * Self-serve checkout eligibility for an owner (or agency) session.
 * - No live subscription: Starter or Pro.
 * - Live subscription on the other plan: allowed as a plan switch; the webhook cancels the old
 *   subscription (with proration credit) only after the new one is paid.
 * - Live subscription on the same plan: already_subscribed (use Manage billing / Stripe portal).
 */
async function checkoutEligibility(env, tenant, plan) {
  if (!tenant) return { ok: false, error: 'tenant_not_found', status: 404 };
  if (tenant.complimentaryPro === true || tenant.billingExempt === true) {
    return { ok: false, error: 'complimentary_no_charge', status: 400 };
  }
  if (plan !== 'starter' && plan !== 'pro') return { ok: false, error: 'invalid_plan', status: 400 };
  const subId = String(tenant.stripeSubscriptionId || '').trim();
  if (!subId) return { ok: true, replaces: '' };
  const sub = await subscriptionContext(env, subId);
  if (!sub.found) {
    if (sub.httpStatus === 404) return { ok: true, replaces: '' };
    return { ok: false, error: 'subscription_lookup_failed', status: 502 };
  }
  if (!LIVE_SUBSCRIPTION_STATUSES.has(sub.status)) return { ok: true, replaces: '' };
  const currentPlan = sub.plan || String(tenant.plan || '').toLowerCase();
  if (currentPlan === plan) return { ok: false, error: 'already_subscribed', status: 409, manage: true };
  return { ok: true, replaces: sub.id, fromPlan: currentPlan };
}

async function cancelReplacedSubscription(env, { oldId, newId, customerId, tenantId }) {
  const old = String(oldId || '').trim();
  if (!old || old === newId) return { ok: false, ignored: true, reason: 'nothing_to_cancel' };
  const sub = await subscriptionContext(env, old);
  if (!sub.found) return { ok: false, ignored: true, reason: 'old_not_found' };
  if (customerId && sub.customer && sub.customer !== customerId) return { ok: false, ignored: true, reason: 'customer_mismatch' };
  if (sub.metadata && sub.metadata.tenantId && tenantId && sub.metadata.tenantId !== tenantId) {
    return { ok: false, ignored: true, reason: 'tenant_mismatch' };
  }
  if (!LIVE_SUBSCRIPTION_STATUSES.has(sub.status)) return { ok: true, ignored: true, reason: 'already_inactive' };
  // prorate=true credits unused time on the old plan to the customer's balance (applied to the next invoice).
  const del = await stripeRequest(env, '/v1/subscriptions/' + encodeURIComponent(old) + '?prorate=true', { method: 'DELETE' });
  if (!del.ok) {
    console.error('replaced subscription cancel failed', del.status);
    return { ok: false, error: 'cancel_failed' };
  }
  return { ok: true, canceled: old };
}

async function handleBillingCheckout(request, env, origin) {
  let data;
  try {
    data = JSON.parse((await request.text()) || '{}');
  } catch (_) {
    return json({ ok: false, error: 'invalid_json' }, 400, origin);
  }
  const tenantId = safeTenantId(data.tenantId || data.tenant_id);
  const plan = String(data.plan || '').trim().toLowerCase();
  if (!tenantId) return json({ ok: false, error: 'invalid_tenant' }, 400, origin);
  if (plan !== 'starter' && plan !== 'pro') return json({ ok: false, error: 'invalid_plan' }, 400, origin);
  const checkoutDenied = billingDenied(await billingSessionAllows(env, data.session, tenantId));
  if (checkoutDenied) return json({ ok: false, error: checkoutDenied.error }, checkoutDenied.status, origin);

  let tenant;
  try {
    const idToken = await firebaseAnonymousToken(env);
    tenant = await getTenantById(env, idToken, tenantId);
  } catch (err) {
    return json({ ok: false, error: 'tenant_lookup_failed' }, 502, origin);
  }
  if (!tenant) return json({ ok: false, error: 'tenant_not_found' }, 404, origin);
  // Owners pick Starter or Pro themselves; plan/status only change when the webhook sees the payment.
  const elig = await checkoutEligibility(env, tenant, plan);
  if (!elig.ok) {
    return json({ ok: false, error: elig.error, manage: elig.manage || undefined }, elig.status || 400, origin);
  }

  const ownerEmail = String(tenant.ownerEmail || '').trim();
  const claimed = String(data.ownerEmail || data.email || '').trim();
  if (!ownerEmail || ownerEmail.indexOf('@') < 0) {
    return json({ ok: false, error: 'owner_email_missing' }, 400, origin);
  }
  if (claimed && claimed.toLowerCase() !== ownerEmail.toLowerCase()) {
    return json({ ok: false, error: 'owner_email_mismatch' }, 400, origin);
  }

  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('line_items[0][price]', BILLING_PRICES[plan].price);
  params.set('line_items[0][quantity]', '1');
  params.set('success_url', billingReturnUrl('success', tenantId));
  params.set('cancel_url', billingReturnUrl('cancel', tenantId));
  params.set('client_reference_id', tenantId);
  params.set('metadata[tenantId]', tenantId);
  params.set('metadata[plan]', plan);
  params.set('metadata[slug]', String(tenant.slug || ''));
  params.set('subscription_data[metadata][tenantId]', tenantId);
  params.set('subscription_data[metadata][plan]', plan);
  params.set('subscription_data[metadata][slug]', String(tenant.slug || ''));
  if (elig.replaces) params.set('metadata[replacesSubscription]', elig.replaces);
  const existingCustomer = String(tenant.stripeCustomerId || '').trim();
  if (existingCustomer) params.set('customer', existingCustomer);
  else params.set('customer_email', ownerEmail);

  const created = await stripeRequest(env, '/v1/checkout/sessions', { method: 'POST', params });
  if (!created.ok) {
    return json({ ok: false, error: created.error, code: created.code || undefined }, created.status || 502, origin);
  }
  const url = created.data && created.data.url;
  if (!url) return json({ ok: false, error: 'checkout_url_missing' }, 502, origin);
  return json({ url }, 200, origin);
}

async function handleBillingPortal(request, env, origin) {
  let data;
  try {
    data = JSON.parse((await request.text()) || '{}');
  } catch (_) {
    return json({ ok: false, error: 'invalid_json' }, 400, origin);
  }
  const tenantId = safeTenantId(data.tenantId || data.tenant_id);
  if (!tenantId) return json({ ok: false, error: 'invalid_tenant' }, 400, origin);
  const portalDenied = billingDenied(await billingSessionAllows(env, data.session, tenantId));
  if (portalDenied) return json({ ok: false, error: portalDenied.error }, portalDenied.status, origin);
  let tenant;
  try {
    const idToken = await firebaseAnonymousToken(env);
    tenant = await getTenantById(env, idToken, tenantId);
  } catch (err) {
    return json({ ok: false, error: 'tenant_lookup_failed' }, 502, origin);
  }
  if (!tenant) return json({ ok: false, error: 'tenant_not_found' }, 404, origin);
  const customerId = String(tenant.stripeCustomerId || '').trim();
  if (!customerId) return json({ ok: false, error: 'no_stripe_customer' }, 400, origin);
  const params = new URLSearchParams();
  params.set('customer', customerId);
  params.set('return_url', billingReturnUrl('portal', tenantId));
  params.set('configuration', BILLING_PORTAL_CONFIGURATION);
  const created = await stripeRequest(env, '/v1/billing_portal/sessions', { method: 'POST', params });
  if (!created.ok) {
    return json({ ok: false, error: created.error, code: created.code || undefined }, created.status || 502, origin);
  }
  const url = created.data && created.data.url;
  if (!url) return json({ ok: false, error: 'portal_url_missing' }, 502, origin);
  return json({ url }, 200, origin);
}

async function handleBillingStatus(request, env, origin, url) {
  let body = {};
  if (request.method === 'POST') {
    try { body = JSON.parse((await request.text()) || '{}'); } catch (_) { body = {}; }
  }
  const tenantId = safeTenantId(body.tenantId || url.searchParams.get('tenantId') || url.searchParams.get('tenant_id'));
  if (!tenantId) return json({ ok: false, error: 'invalid_tenant' }, 400, origin);
  const signedIn = await billingSessionAllows(env, body.session, tenantId);
  let tenant;
  try {
    const idToken = await firebaseAnonymousToken(env);
    tenant = await getTenantById(env, idToken, tenantId);
  } catch (err) {
    return json({ ok: false, error: 'tenant_lookup_failed' }, 502, origin);
  }
  if (!tenant) return json({ ok: false, error: 'tenant_not_found' }, 404, origin);
  if (!signedIn) {
    // Without the owner's (or agency) session, only what the public page already shows.
    return json({ ok: true, tenantId, plan: tenant.plan || null, source: 'firestore', limited: true }, 200, origin);
  }
  return json(
    {
      ok: true,
      tenantId,
      subscriptionStatus: tenant.subscriptionStatus || null,
      stripeCustomerId: tenant.stripeCustomerId || null,
      stripeSubscriptionId: tenant.stripeSubscriptionId || null,
      plan: tenant.plan || null,
      monthlyPrice: feeNumber(tenant),
      paymentForm: tenant.paymentForm || null,
      cancelAtPeriodEnd: tenant.cancelAtPeriodEnd === true,
      currentPeriodEnd: tenant.currentPeriodEnd || null,
      source: 'firestore',
    },
    200,
    origin
  );
}

async function handleStripeWebhook(request, env) {
  const raw = await request.text();
  const secret = String((env && env.STRIPE_WEBHOOK_SECRET) || '').trim();
  if (!secret) return json({ ok: false, error: 'webhook_secret_missing' }, 500, '');
  const valid = await verifyStripeWebhook(raw, request.headers.get('Stripe-Signature'), secret);
  if (!valid) return json({ ok: false, error: 'invalid_signature' }, 400, '');
  let event;
  try {
    event = JSON.parse(raw || '{}');
  } catch (_) {
    return json({ ok: false, error: 'invalid_json' }, 400, '');
  }
  const type = String(event.type || '');
  const obj = (event.data && event.data.object) || {};
  try {
    if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
      const earlyMeta = obj.metadata || {};
      if (obj.mode === 'payment' && earlyMeta.kind === 'booking_payment') {
        if (obj.payment_status && obj.payment_status !== 'paid') {
          return json({ ok: true, ignored: true, reason: 'unpaid' }, 200, '');
        }
        let card = { stripeCustomerId: '', stripePaymentMethodId: '' };
        try { card = await cardFromCheckout(env, obj); } catch (_) { card = { stripeCustomerId: '', stripePaymentMethodId: '' }; }
        const intent = obj.payment_intent;
        const paid = await markBookingCheckoutPaid(env, {
          tenantId: earlyMeta.tenantId,
          bookingIds: earlyMeta.bookingIds,
          purpose: earlyMeta.purpose,
          card: card,
          amountCents: obj.amount_total,
          paymentIntentId: typeof intent === 'string' ? intent : (intent && intent.id) || '',
          splits: earlyMeta.splits,
        });
        return json({ ok: true, result: paid }, paid.ok || paid.duplicate || paid.ignored ? 200 : 500, '');
      }
    }
    if (type === 'checkout.session.completed') {
      if (obj.mode && obj.mode !== 'subscription') return json({ ok: true, ignored: true }, 200, '');
      if (obj.payment_status && obj.payment_status !== 'paid' && obj.payment_status !== 'no_payment_required') {
        return json({ ok: true, ignored: true, reason: 'unpaid' }, 200, '');
      }
      const meta = obj.metadata || {};
      if (meta.signup === '1') {
        await ensureSignupTenant(env, meta, {
          customerId: typeof obj.customer === 'string' ? obj.customer : '',
          subscriptionId: typeof obj.subscription === 'string' ? obj.subscription : '',
        });
      }
      const result = await markSubscriptionActive(env, {
        tenantId: meta.tenantId || obj.client_reference_id,
        customerId: obj.customer,
        subscriptionId: obj.subscription,
        plan: planFromMetadata(meta),
      });
      if (result.ok && meta.replacesSubscription) {
        result.replaced = await cancelReplacedSubscription(env, {
          oldId: meta.replacesSubscription,
          newId: typeof obj.subscription === 'string' ? obj.subscription : '',
          customerId: typeof obj.customer === 'string' ? obj.customer : '',
          tenantId: result.tenantId,
        });
      }
      return json({ ok: true, result }, result.ok || result.ignored ? 200 : 500, '');
    }
    if (type === 'invoice.paid' || type === 'invoice.payment_failed') {
      const subId = typeof obj.subscription === 'string' ? obj.subscription : (obj.subscription && obj.subscription.id) || '';
      let meta = {};
      if (obj.subscription_details && obj.subscription_details.metadata) meta = obj.subscription_details.metadata;
      else if (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.metadata) {
        meta = obj.parent.subscription_details.metadata;
      } else if (obj.lines && obj.lines.data && obj.lines.data[0] && obj.lines.data[0].metadata) {
        meta = obj.lines.data[0].metadata;
      }
      let customerId = typeof obj.customer === 'string' ? obj.customer : '';
      // Price id is authoritative (survives a plan switch); metadata is the fallback.
      let plan = planFromStripePrice(obj) || planFromMetadata(meta);
      let tenantHint = meta.tenantId || '';
      if ((!tenantHint || !plan) && subId) {
        const sub = await subscriptionContext(env, subId);
        meta = Object.assign({}, sub.metadata || {}, meta);
        if (!tenantHint) tenantHint = (sub.metadata && sub.metadata.tenantId) || '';
        if (!plan) plan = planFromMetadata(sub.metadata);
        if (!customerId) customerId = sub.customer || '';
      }
      if (type === 'invoice.paid' && meta && meta.signup === '1') {
        await ensureSignupTenant(env, meta, { customerId: customerId, subscriptionId: subId });
      }
      const tenantId = await resolveBillingTenantId(env, {
        tenantId: tenantHint,
        customerId,
        subscriptionId: subId,
      });
      const result =
        type === 'invoice.paid'
          ? await markSubscriptionActive(env, {
              tenantId,
              customerId,
              subscriptionId: subId,
              plan,
            })
          : await markSubscriptionPaused(env, tenantId, subId);
      return json({ ok: true, result }, result.ok || result.ignored ? 200 : 500, '');
    }
    if (type === 'customer.subscription.updated') {
      // Keeps "Active until" in the portal in sync when an owner cancels or resumes in Stripe's billing portal.
      const meta = obj.metadata || {};
      const tenantId = await resolveBillingTenantId(env, {
        tenantId: meta.tenantId,
        customerId: typeof obj.customer === 'string' ? obj.customer : '',
        subscriptionId: obj.id,
      });
      const result = await saveSubscriptionSchedule(env, tenantId, obj);
      return json({ ok: true, result }, result.ok || result.ignored ? 200 : 500, '');
    }
    if (type === 'customer.subscription.deleted') {
      const meta = obj.metadata || {};
      const tenantId = await resolveBillingTenantId(env, {
        tenantId: meta.tenantId,
        customerId: typeof obj.customer === 'string' ? obj.customer : '',
        subscriptionId: obj.id,
      });
      const result = await markSubscriptionPaused(env, tenantId, obj.id);
      if (result.ok && !result.ignored) {
        // The paid period ended; a scheduled cancel is no longer pending.
        try {
          const idToken = await firebaseAnonymousToken(env);
          await patchTenantFields(env, idToken, result.tenantId, { cancelAtPeriodEnd: false, currentPeriodEnd: '' });
        } catch (_) {
          console.warn('clear cancel schedule failed');
        }
      }
      return json({ ok: true, result }, result.ok || result.ignored ? 200 : 500, '');
    }
    return json({ ok: true, ignored: true }, 200, '');
  } catch (err) {
    console.error('billing webhook failed', type);
    return json({ ok: false, error: 'billing_update_failed' }, 500, '');
  }
}


async function handleBillingSubscribe(request, env) {
  const url = new URL(request.url);
  const tenantId = safeTenantId(url.searchParams.get('tenantId') || url.searchParams.get('tenant'));
  const plan = String(url.searchParams.get('plan') || '').trim().toLowerCase();
  if (!tenantId) return new Response('Unknown business.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (plan !== 'starter' && plan !== 'pro') return new Response('Unknown plan.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  let tenant;
  try {
    const idToken = await firebaseAnonymousToken(env);
    tenant = await getTenantById(env, idToken, tenantId);
  } catch (_) {
    return new Response('Could not open checkout.', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (!tenant) return new Response('Business not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (!subscribeCheckoutAllowed(tenant, plan)) {
    return new Response('This business cannot start that subscription.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const ownerEmail = String(tenant.ownerEmail || '').trim();
  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('line_items[0][price]', BILLING_PRICES[plan].price);
  params.set('line_items[0][quantity]', '1');
  params.set('success_url', billingReturnUrl('success', tenantId));
  params.set('cancel_url', billingReturnUrl('cancel', tenantId));
  params.set('client_reference_id', tenantId);
  params.set('metadata[tenantId]', tenantId);
  params.set('metadata[plan]', plan);
  params.set('metadata[slug]', String(tenant.slug || tenantId));
  params.set('subscription_data[metadata][tenantId]', tenantId);
  params.set('subscription_data[metadata][plan]', plan);
  params.set('subscription_data[metadata][slug]', String(tenant.slug || tenantId));
  // This link is unauthenticated (it's in the onboarding email), so the checkout page must not show
  // the owner's email or saved customer to whoever opens it. The webhook matches by metadata.tenantId.
  void ownerEmail;
  const created = await stripeRequest(env, '/v1/checkout/sessions', { method: 'POST', params });
  const checkout = created.ok && created.data ? created.data.url : '';
  if (!checkout) return new Response('Checkout is unavailable.', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return Response.redirect(checkout, 302);
}


// GET /api/manage/pay?t={slug}&k={manageToken}: pay link from the "Finish your booking" emails.
// Valid while the booking is still awaiting its deposit and the appointment day hasn't passed.
async function handleManagePay(request, env, url) {
  const tenantId = safeTenantId(url.searchParams.get('t'));
  const token = String(url.searchParams.get('k') || '');
  const home = BILLING_APP_ORIGIN + '/';
  if (!tenantId || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return Response.redirect(home, 302);
  const manage = BILLING_APP_ORIGIN + '/' + tenantId + '/manage/' + encodeURIComponent(token);
  let tenant;
  try {
    const idToken = await firebaseAnonymousToken(env);
    tenant = await getTenantById(env, idToken, tenantId);
  } catch (_) {
    return Response.redirect(manage, 302);
  }
  if (!tenant) return Response.redirect(home, 302);
  const appts = Array.isArray(tenant.appointments) ? tenant.appointments : [];
  const booking = appts.find((b) => b && b.manageToken && timingSafeEqual(String(b.manageToken), token));
  if (!booking) return Response.redirect(manage, 302);
  const today = todayInTimeZone(tenantTimezone(tenant));
  if (!isAwaitingDeposit(booking) || String(booking.date || '') < today) return Response.redirect(manage, 302);
  const ids = booking.seriesId
    ? appts.filter((b) => b && b.seriesId === booking.seriesId && isAwaitingDeposit(b)).map((b) => b.id)
    : [booking.id];
  const inner = new Request(BILLING_APP_ORIGIN + '/billing/booking-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, bookingIds: ids, email: booking.clientEmail || '' }),
  });
  const res = await handleBookingCheckout(inner, env, BILLING_APP_ORIGIN);
  const data = await res.json().catch(() => ({}));
  return Response.redirect(data && data.url ? data.url : manage, 302);
}

// GET /billing/signup-status?slug=: is this paid signup still waiting on checkout? (no PII returned)
async function handleSignupStatus(env, origin, url) {
  const slug = safeTenantId(url.searchParams.get('slug'));
  if (!slug) return json({ ok: false, error: 'invalid_slug' }, 400, origin);
  let tenant = null;
  try {
    tenant = await getTenantById(env, await firebaseAnonymousToken(env), slug);
  } catch (_) {
    return json({ ok: false, error: 'lookup_failed' }, 502, origin);
  }
  if (!tenant) return json({ ok: false, error: 'not_found' }, 404, origin);
  const awaiting = signupAwaitingCheckout(Object.assign({}, tenant, { signupStartedAt: tenant.signupStartedAt || new Date().toISOString() }), Date.now());
  const plan = String(tenant.plan || '').toLowerCase();
  return json({
    ok: true,
    awaitingCheckout: awaiting,
    plan: awaiting ? plan : '',
    resumeUrl: awaiting ? billingSubscribeUrl(slug, plan) : '',
  }, 200, origin);
}

// POST /billing/signup-free { slug, email, password }: an unfinished paid signup switches to Free.
// Requires the owner login from signup, so nobody else can change the plan.
async function handleSignupSwitchFree(request, env, origin) {
  if (!origin || !isAllowedOrigin(origin)) return json({ ok: false, error: 'origin_not_allowed' }, 403, origin);
  const ip = String(request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 64);
  if (!(await rateLimitOk(env.RL_SIGNUP, 'free:' + ip, 5, 'signupfree'))) {
    return json({ ok: false, error: 'Too many tries. Please wait a minute.' }, 429, origin);
  }
  let data = {};
  try { data = await request.json(); } catch (_) { data = {}; }
  const slug = safeTenantId(data.slug);
  const email = String(data.email || '').trim().toLowerCase();
  const password = String(data.password || '');
  if (!slug || !email || !password) return json({ ok: false, error: 'missing_fields' }, 400, origin);
  if (!authReady(env)) return json({ ok: false, error: 'auth_not_configured' }, 500, origin);
  let record = null;
  try { record = JSON.parse((await env.AUTH_KV.get('tenant:' + slug)) || 'null'); } catch (_) { record = null; }
  if (!record || String(record.email || '').toLowerCase() !== email || !(await passwordMatches(password, record, env.AUTH_PEPPER))) {
    return json({ ok: false, error: 'That email and password don\'t match this page.' }, 401, origin);
  }
  let idToken;
  let tenant;
  try {
    idToken = await firebaseAnonymousToken(env);
    tenant = await getTenantById(env, idToken, slug);
  } catch (_) {
    return json({ ok: false, error: 'lookup_failed' }, 502, origin);
  }
  if (!tenant) return json({ ok: false, error: 'not_found' }, 404, origin);
  const plan = String(tenant.plan || '').toLowerCase();
  if (plan === 'free') return json({ ok: true, plan: 'free', already: true }, 200, origin);
  if (String(tenant.stripeSubscriptionId || '').trim() || String(tenant.paymentForm || '') !== 'Not subscribed') {
    return json({ ok: false, error: 'This page already has an active plan.' }, 409, origin);
  }
  const gw = Object.assign({}, tenant.paymentGateways || {}, { card: false });
  const patch = {
    plan: 'free',
    monthlyPrice: 0,
    paymentForm: 'Free',
    paymentGateways: gw,
    allowRecurringBookings: false,
    signupReminderSentAt: new Date().toISOString(),
  };
  if (tenant.deposit && typeof tenant.deposit === 'object') patch.deposit = Object.assign({}, tenant.deposit, { enabled: false });
  try {
    await patchTenantFields(env, idToken, slug, patch);
  } catch (_) {
    return json({ ok: false, error: 'update_failed' }, 502, origin);
  }
  return json({ ok: true, plan: 'free', publicUrl: BILLING_APP_ORIGIN + '/' + slug + '/' }, 200, origin);
}

function roundMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function tenantPlanName(tenant) {
  if (tenant && (tenant.complimentaryPro === true || tenant.billingExempt === true)) return 'pro';
  const stored = String((tenant && tenant.plan) || '').toLowerCase();
  if (stored === 'free' || stored === 'starter' || stored === 'pro') return stored;
  const n = feeNumber(tenant);
  if (n === 29 || n === 49) return 'starter';
  if (n === 99) return 'pro';
  return 'free';
}

function readDepositSettings(tenant) {
  const d = tenant && tenant.deposit;
  if (!d || typeof d !== 'object') return { enabled: false, type: 'percent', percent: 0, amount: 0 };
  const type = d.type === 'fixed' ? 'fixed' : 'percent';
  const percent = Math.min(100, Math.max(0, Number(d.percent) || 0));
  const amount = Math.max(0, roundMoney(d.amount));
  return { enabled: !!d.enabled, type, percent, amount };
}

function depositRequiredForTenant(tenant) {
  if (tenantPlanName(tenant) !== 'pro') return false;
  const d = readDepositSettings(tenant);
  if (!d.enabled) return false;
  if (d.type === 'fixed') return d.amount >= 0.5;
  return d.percent > 0;
}

function hasPricedAmount(value) {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

function catalogServicePrice(tenant, serviceName) {
  const services = Array.isArray(tenant && tenant.services) ? tenant.services : [];
  const svc = services.find((s) => s && s.name === serviceName);
  if (!svc) return null;
  if (!hasPricedAmount(svc.price)) return null;
  return roundMoney(svc.price);
}

function quoteDepositForPrice(tenant, price) {
  const priced = hasPricedAmount(price);
  const p = priced ? roundMoney(price) : 0;
  if (!depositRequiredForTenant(tenant)) {
    return { required: false, price: priced ? p : null, deposit: 0, balance: priced ? p : null, priced };
  }
  const d = readDepositSettings(tenant);
  // Percent of an unset price cannot be charged — skip deposit for that service.
  if (d.type !== 'fixed' && !priced) {
    return { required: false, price: null, deposit: 0, balance: null, priced: false, skippedNoPrice: true };
  }
  let dep = d.type === 'fixed' ? d.amount : roundMoney((p * d.percent) / 100);
  if (priced && p > 0 && dep > p) dep = p;
  dep = roundMoney(dep);
  const required = dep >= 0.5;
  const deposit = required ? dep : 0;
  return {
    required,
    price: priced ? p : null,
    deposit,
    balance: priced ? roundMoney(Math.max(0, p - deposit)) : null,
    priced,
  };
}

function bookingPriceForCharge(tenant, booking) {
  // Multi-service booking: total of the business's own prices x quantity. Never the browser's amount.
  if (booking && Array.isArray(booking.items) && booking.items.length) {
    const services = Array.isArray(tenant && tenant.services) ? tenant.services : [];
    let total = 0;
    for (const item of booking.items) {
      const svc = services.find((s) => s && item && item.serviceId !== undefined && String(s.id) === String(item.serviceId))
        || services.find((s) => s && item && s.name === item.name);
      if (!svc || !hasPricedAmount(svc.price)) return null;
      const qty = Math.max(1, Math.min(10, Math.round(Number(item.qty) || 1)));
      total += roundMoney(svc.price) * qty;
    }
    return roundMoney(total);
  }
  const catalog = catalogServicePrice(tenant, booking && booking.serviceName);
  if (catalog !== null) return catalog;
  if (hasPricedAmount(booking && booking.amount)) return roundMoney(booking.amount);
  return null;
}

function safeBookingId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) return '';
  return id;
}

function publicBookingSlug(tenant, tenantId) {
  const slug = String((tenant && (tenant.slug || tenant.id)) || tenantId || '').trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9-]{0,40}$/.test(slug)) return slug;
  return safeTenantId(tenantId) || 'book';
}

function parseBookingIdList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const out = [];
  for (const item of raw) {
    const id = safeBookingId(item);
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 12) break;
  }
  return out;
}

async function cardFromCheckout(env, session) {
  let customerId = session && typeof session.customer === 'string' ? session.customer : '';
  const pi = session && session.payment_intent;
  let piId = typeof pi === 'string' ? pi : (pi && pi.id) || '';
  let pm = pi && typeof pi === 'object' && typeof pi.payment_method === 'string' ? pi.payment_method : '';
  if (pi && typeof pi === 'object' && !customerId && typeof pi.customer === 'string') customerId = pi.customer;
  if ((!pm || !customerId) && /^pi_[A-Za-z0-9]+$/.test(piId)) {
    const got = await stripeRequest(env, '/v1/payment_intents/' + encodeURIComponent(piId));
    if (got.ok && got.data) {
      if (!customerId && typeof got.data.customer === 'string') customerId = got.data.customer;
      if (typeof got.data.payment_method === 'string') pm = got.data.payment_method;
    }
  }
  return {
    stripeCustomerId: /^cus_[A-Za-z0-9]+$/.test(customerId) ? customerId : '',
    stripePaymentMethodId: /^pm_[A-Za-z0-9]+$/.test(pm) ? pm : '',
  };
}



function bookingIcsPublicUrl(tenant, booking) {
  const token = String((booking && booking.manageToken) || '').trim();
  const id = String((booking && booking.id) || '').trim();
  const slug = String((tenant && (tenant.slug || tenant.id)) || '').trim();
  if (!token || !id || !slug) return '';
  return 'https://schedi.app/api/booking-ics?tenant=' + encodeURIComponent(slug)
    + '&id=' + encodeURIComponent(id) + '&t=' + encodeURIComponent(token);
}

function googleCalendarUrlForBooking(tenant, booking) {
  try {
    const { buildIcsGoogleParts } = {}; // placeholder
  } catch (_) {}
  const tz = String((tenant && (tenant.timezone || tenant.timeZone)) || 'America/New_York');
  const service = String((booking && booking.serviceName) || 'Appointment');
  const biz = String((tenant && tenant.name) || 'Schedi');
  const summary = service + ' at ' + biz;
  const loc = publicBusinessAddress(tenant);
  // Prefer linking Google template with dates filled by client email builder on Pages;
  // worker deposit path builds a simple details-only fallback URL without times if helpers unavailable.
  let gUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(summary);
  if (loc) gUrl += '&location=' + encodeURIComponent(loc);
  const manageSlug = String((tenant && (tenant.slug || tenant.id)) || '').trim();
  const token = String((booking && booking.manageToken) || '').trim();
  let details = 'Reference: #' + String((booking && booking.id) || '');
  if (manageSlug && token) details += '\nManage: https://schedi.app/' + manageSlug + '/manage/' + token;
  gUrl += '&details=' + encodeURIComponent(details);
  // times: best-effort using same wall-clock → UTC as reminders
  try {
    const toMinutes = (label) => {
      const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*$/i.exec(String(label || ''));
      if (!m) return null;
      let h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const ampm = (m[3] || '').toUpperCase();
      if (ampm === 'PM' && h !== 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
      return h * 60 + min;
    };
    const pad2 = (n) => String(n).padStart(2, '0');
    // reuse cancellation-fee wallTime if available via global in bundle — inline minimal
    const wall = (dateStr, minutesOfDay, timeZone) => {
      const p = String(dateStr || '').split('-');
      if (p.length !== 3) return null;
      const y = parseInt(p[0], 10), mo = parseInt(p[1], 10), d = parseInt(p[2], 10);
      const h = Math.floor(minutesOfDay / 60), mi = minutesOfDay % 60;
      let utc = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
      for (let i = 0; i < 4; i++) {
        const parts = {};
        new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
          .formatToParts(utc).forEach((part) => { if (part.type !== 'literal') parts[part.type] = part.value; });
        let gotH = parseInt(parts.hour, 10); if (gotH === 24) gotH = 0;
        const want = Date.UTC(y, mo - 1, d, h, mi, 0);
        const got = Date.UTC(parseInt(parts.year, 10), parseInt(parts.month, 10) - 1, parseInt(parts.day, 10), gotH, parseInt(parts.minute, 10), 0);
        utc = new Date(utc.getTime() + (want - got));
      }
      return utc;
    };
    let startMins = toMinutes(booking && booking.time); if (startMins == null) startMins = 10 * 60;
    const dur = Math.max(5, Math.round(Number(booking && booking.durationMins) || 60));
    let endMins = startMins + dur;
    let dateStr = String((booking && booking.date) || '');
    let endDateStr = dateStr;
    if (endMins >= 1440) {
      endMins -= 1440;
      const p = dateStr.split('-');
      const dt = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
      dt.setDate(dt.getDate() + 1);
      endDateStr = dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
    }
    const startUtc = wall(dateStr, startMins, tz);
    const endUtc = wall(endDateStr, endMins, tz);
    const dates = googleCalendarDatesParam(startUtc, endUtc);
    if (dates) gUrl += '&dates=' + dates;
  } catch (_) {}
  return gUrl;
}

function emailCalendarButtonsHtml(tenant, booking) {
  const gUrl = googleCalendarUrlForBooking(tenant, booking);
  const icsUrl = bookingIcsPublicUrl(tenant, booking);
  if (!gUrl && !icsUrl) return '';
  let cells = '';
  if (gUrl) {
    cells += '<td align="center" style="padding:4px;" width="50%">'
      + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
      + '<td align="center" bgcolor="#059669" style="background-color:#059669;border-radius:14px;">'
      + '<a href="' + String(gUrl).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '" style="display:block;padding:13px 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:#ffffff;text-decoration:none;">Google Calendar</a>'
      + '</td></tr></table></td>';
  }
  if (icsUrl) {
    cells += '<td align="center" style="padding:4px;" width="50%">'
      + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
      + '<td align="center" style="border:1px solid #475569;border-radius:14px;">'
      + '<a href="' + String(icsUrl).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '" style="display:block;padding:13px 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:#e2e8f0;text-decoration:none;">Apple / Outlook (.ics)</a>'
      + '</td></tr></table></td>';
  }
  return '<tr><td style="padding:8px 28px 4px;">'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#94a3b8;margin-bottom:8px;text-align:center;">Add to calendar</div>'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' + cells + '</tr></table>'
    + '</td></tr>';
}

function formatFriendlyLocalDateEmail(dateStr) {
  const raw = String(dateStr || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return raw;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d);
  if (!Number.isFinite(dt.getTime()) || dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return raw;
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatConfirmEmailCalParts(dateStr) {
  const raw = String(dateStr || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { mon: '', day: '' };
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d);
  if (!Number.isFinite(dt.getTime())) return { mon: '', day: '' };
  return {
    mon: dt.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
    day: String(dt.getDate()),
  };
}


function paymentReceivedMessage(tenant, booking, purpose) {
  const biz = String((tenant && tenant.name) || 'Schedi');
  const service = String((booking && booking.serviceName) || 'Appointment');
  const deposit = purpose === 'deposit';
  const dollars = deposit ? roundMoney(booking && booking.depositAmount) : roundMoney(booking && booking.amount);
  const amount = Number.isFinite(dollars) && dollars > 0 ? ('$' + dollars.toFixed(2)) : '';
  const what = deposit ? 'card deposit' : 'card payment';
  const friendlyDate = formatFriendlyLocalDateEmail((booking && booking.date) || '');
  const balanceRaw = booking && booking.balanceDue;
  const balance = deposit && balanceRaw !== null && balanceRaw !== undefined && Number.isFinite(Number(balanceRaw))
    ? roundMoney(balanceRaw) : null;
  const subject = 'Payment received — ' + biz;
  let text = 'Payment received\n\n';
  text += 'We received your ' + (amount ? amount + ' ' : '') + what + ' for ' + service + ' with ' + biz + '.\n';
  if (friendlyDate) text += 'Date: ' + friendlyDate + '\n';
  if (booking && booking.time) text += 'Time: ' + booking.time + '\n';
  text += 'Booking ref: #' + ((booking && booking.id) || '') + '\n';
  if (balance !== null && balance > 0) text += 'The rest ($' + balance.toFixed(2) + ') is due at the appointment.\n';
  text += '\n— ' + biz;
  function row(label, value) {
    return '<tr><td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#94a3b8;">' + escapeHtml(label) + '</td>'
      + '<td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#f1f5f9;font-weight:600;text-align:right;">' + escapeHtml(value) + '</td></tr>';
  }
  let rows = row('Service', service);
  if (amount) rows += row(deposit ? 'Deposit' : 'Amount', amount);
  if (friendlyDate) rows += row('Date', friendlyDate);
  if (booking && booking.time) rows += row('Time', String(booking.time));
  rows += row('Booking ref', '#' + ((booking && booking.id) || ''));
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#020617;">'
    + '<div style="max-width:560px;margin:0 auto;background:#0b1325;border:1px solid #334155;border-radius:16px;padding:24px;font-family:Arial,Helvetica,sans-serif;">'
    + '<h1 style="margin:0 0 8px;font-size:22px;color:#fff;">Payment received</h1>'
    + '<p style="margin:0 0 16px;color:#c7d2fe;font-size:14px;line-height:1.5;">We received your ' + escapeHtml((amount ? amount + ' ' : '') + what) + ' for ' + escapeHtml(service) + '.</p>'
    + '<table role="presentation" width="100%">' + rows + '</table>'
    + (balance !== null && balance > 0 ? ('<p style="margin:16px 0 0;color:#94a3b8;font-size:13px;">The rest ($' + escapeHtml(balance.toFixed(2)) + ') is due at the appointment.</p>') : '')
    + '<p style="margin:16px 0 0;color:#64748b;font-size:12px;">— ' + escapeHtml(biz) + '</p>'
    + '</div></body></html>';
  return { subject: subject, text: text, html: html };
}

async function markBookingCheckoutPaid(env, { tenantId, bookingIds, purpose, card, amountCents, paymentIntentId, splits }) {
  const id = safeTenantId(tenantId);
  const ids = parseBookingIdList(bookingIds);
  if (!id || !ids.length) return { ok: false, ignored: true, reason: 'no_booking' };
  const idToken = await firebaseAnonymousToken(env);
  const tenant = await getTenantById(env, idToken, id);
  if (!tenant) return { ok: false, ignored: true, reason: 'tenant_not_found' };
  if (tenantPlanName(tenant) !== 'pro') return { ok: false, ignored: true, reason: 'not_pro' };
  const appts = Array.isArray(tenant.appointments) ? tenant.appointments.slice() : [];
  const payPurpose = purpose === 'card' ? 'card' : 'deposit';
  const amounts = centsByBooking(ids, amountCents, splits);
  let changed = false;
  let matched = 0;
  let duplicates = 0;
  const paidNow = [];
  for (let i = 0; i < appts.length; i++) {
    const booking = appts[i];
    if (!booking || !ids.includes(String(booking.id || ''))) continue;
    matched += 1;
    const price = bookingPriceForCharge(tenant, booking);
    const quote = quoteDepositForPrice(tenant, price);
    const cents = Object.prototype.hasOwnProperty.call(amounts, String(booking.id)) ? amounts[String(booking.id)] : null;
    const applied = applyCardCheckoutPayment(booking, {
      purpose: payPurpose,
      amountCents: cents,
      paymentIntentId: paymentIntentId,
      stripeCustomerId: card && card.stripeCustomerId,
      stripePaymentMethodId: card && card.stripePaymentMethodId,
      catalogPrice: price,
      quotedDeposit: quote.deposit,
    });
    if (applied.duplicate) {
      duplicates += 1;
      continue;
    }
    appts[i] = applied.booking;
    changed = true;
    paidNow.push(applied.booking);
  }
  if (!changed) {
    if (matched && duplicates === matched) return { ok: true, duplicate: true, tenantId: id, purpose: payPurpose };
    return { ok: false, ignored: true, reason: 'booking_not_found' };
  }
  tenant.appointments = appts;
  const cards = {};
  const intentId = typeof paymentIntentId === 'string' ? paymentIntentId : '';
  if (card && (card.stripeCustomerId || card.stripePaymentMethodId) || intentId) {
    for (const bid of ids) {
      cards[String(bid)] = Object.assign({}, card || {}, { stripePaymentIntentId: intentId });
    }
  }
  await persistTenantAppointments(env, idToken, id, appts, { cards: cards });
  const notes = tenant.notifications && typeof tenant.notifications === 'object' ? tenant.notifications : {};
  const emailOn = notes.emailConfirmations !== false;
  if (emailOn) {
    let mailed = false;
    for (const booking of paidNow) {
      if (booking.paymentReceivedSentAt || booking.depositConfirmSentAt) continue;
      const to = String(booking.clientEmail || '').trim();
      if (!to) continue;
      const message = paymentReceivedMessage(tenant, booking, payPurpose);
      const replyTo = String((notes.replyTo || tenant.ownerEmail || '')).trim();
      const sent = await sendResend(env, {
        to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: replyTo || undefined,
        fromName: String(tenant.name || 'Schedi'),
      });
      if (sent.ok) {
        const idx = appts.findIndex((b) => b && b.id === booking.id);
        if (idx >= 0) {
          appts[idx] = Object.assign({}, appts[idx], { paymentReceivedSentAt: new Date().toISOString() });
          mailed = true;
        }
      }
    }
    if (mailed) await persistTenantAppointments(env, idToken, id, appts);
  }
  return { ok: true, tenantId: id, purpose: payPurpose };
}

async function handleBookingCheckout(request, env, origin) {
  let data = {};
  try {
    data = await request.json();
  } catch (_) {
    data = {};
  }
  const tenantId = safeTenantId(data.tenantId || data.tenant_id);
  const bookingIds = parseBookingIdList(data.bookingIds || data.bookingId);
  if (!tenantId) return json({ ok: false, error: 'invalid_tenant' }, 400, origin);
  if (!bookingIds.length) return json({ ok: false, error: 'invalid_booking' }, 400, origin);
  let tenant;
  try {
    const idToken = await firebaseAnonymousToken(env);
    tenant = await getTenantById(env, idToken, tenantId);
  } catch (_) {
    return json({ ok: false, error: 'tenant_lookup_failed' }, 502, origin);
  }
  if (!tenant) return json({ ok: false, error: 'tenant_not_found' }, 404, origin);
  if (tenantPlanName(tenant) !== 'pro') return json({ ok: false, error: 'card_checkout_pro_only' }, 400, origin);
  const appts = Array.isArray(tenant.appointments) ? tenant.appointments : [];
  const selected = bookingIds.map((bid) => appts.find((b) => b && String(b.id) === bid)).filter(Boolean);
  if (selected.length !== bookingIds.length) return json({ ok: false, error: 'booking_not_found' }, 404, origin);
  const depositOn = depositRequiredForTenant(tenant);
  const gateways = tenant.paymentGateways && typeof tenant.paymentGateways === 'object' ? tenant.paymentGateways : {};
  const quotedFull = selected.length > 0 && selected.every((booking) => ownerQuotedDollars(booking, catalogChargeDollars(tenant, booking)) != null);
  let purpose = '';
  if (quotedFull) purpose = 'card';
  else if (depositOn) purpose = 'deposit';
  else if (gateways.card === true) purpose = 'card';
  else return json({ ok: false, error: 'card_checkout_off' }, 400, origin);
  const splits = [];
  let totalCents = 0;
  for (const booking of selected) {
    if (booking.cancelled === true) return json({ ok: false, error: 'booking_cancelled' }, 400, origin);
    const status = String(booking.status || '').toLowerCase();
    if (status === 'denied' || status === 'cancelled' || status === 'canceled') {
      return json({ ok: false, error: 'booking_cancelled' }, 400, origin);
    }
    let price = bookingPriceForCharge(tenant, booking);
    if (purpose === 'deposit') {
      if (booking.depositPaid === true) continue;
      const quote = quoteDepositForPrice(tenant, price);
      if (quote.skippedNoPrice) return json({ ok: false, error: 'service_has_no_price' }, 400, origin);
      const deposit = quote.required ? quote.deposit : 0;
      const cents = Math.round(deposit * 100);
      if (cents < 50) return json({ ok: false, error: 'deposit_too_small' }, 400, origin);
      splits.push(booking.id + ':' + cents);
      totalCents += cents;
    } else {
      const method = String(booking.paymentMethod || '').toLowerCase();
      const payStatus = String(booking.paymentStatus || '').toUpperCase();
      if (method !== 'card' && payStatus.indexOf('CARD') === -1) {
        return json({ ok: false, error: 'not_card_booking' }, 400, origin);
      }
      if (payStatus.indexOf('PAID') !== -1 && payStatus.indexOf('AWAITING') === -1) continue;
      const quoted = ownerQuotedDollars(booking, catalogChargeDollars(tenant, booking));
      if (quoted != null) price = quoted;
      if (price === null) return json({ ok: false, error: 'service_has_no_price' }, 400, origin);
      const cents = Math.round(price * 100);
      if (cents < 50) return json({ ok: false, error: 'amount_too_small' }, 400, origin);
      splits.push(booking.id + ':' + cents);
      totalCents += cents;
    }
  }
  if (!splits.length || totalCents < 50) return json({ ok: true, alreadyPaid: true }, 200, origin);
  if (tenant.stripeConnectReady !== true) {
    return json({
      ok: false,
      error: 'connect_not_ready',
      message: 'Card payments are not ready for this business. Nothing was charged.',
    }, 409, origin);
  }
  const email = String(selected[0].clientEmail || data.email || '').trim();
  const connectUrl = await connectCheckoutUrl({
    slug: publicBookingSlug(tenant, tenantId),
    tenantId,
    bookingIds,
    email,
    serviceName: selected[0].serviceName || 'Appointment',
    amountCents: totalCents,
    chargeKind: purpose === 'deposit' ? 'deposit' : 'full',
  });
  if (!stripeHostedPayUrl(connectUrl)) {
    return json({
      ok: false,
      error: 'connect_not_ready',
      message: 'Card payments are not ready for this business. Nothing was charged.',
    }, 409, origin);
  }
  return json({ ok: true, url: connectUrl, purpose, amountCents: totalCents, mode: 'connect' }, 200, origin);
}

const CONNECT_PUBLIC_CHECKOUT = 'https://schedi-connect-production.up.railway.app/api/public-checkout';

function stripeHostedPayUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'checkout.stripe.com' || host === 'buy.stripe.com' || host === 'pay.stripe.com');
  } catch (_) {
    return false;
  }
}

function cardPayPage(message, status) {
  const safe = String(message || 'This payment link did not open. Nothing was charged.')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Card payment</title></head>'
    + '<body style="margin:0;padding:32px 16px;background:#020617;color:#e2e8f0;font-family:Arial,Helvetica,sans-serif;">'
    + '<main style="max-width:28rem;margin:0 auto;padding:24px;border:1px solid #334155;border-radius:16px;background:#0b1325;">'
    + '<h1 style="margin:0 0 12px;font-size:20px;color:#fff;">Card payment</h1>'
    + '<p style="margin:0;line-height:1.5;">' + safe + '</p>'
    + '</main></body></html>';
  return new Response(html, {
    status: status || 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function stripePayRedirect(target) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function cardPayBookingOpen(booking) {
  if (!booking || booking.cancelled === true) return false;
  const status = String(booking.status || '').toLowerCase();
  return status !== 'denied' && status !== 'cancelled' && status !== 'canceled';
}

async function connectCheckoutUrl(input) {
  try {
    const res = await fetch(CONNECT_PUBLIC_CHECKOUT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://schedi.app' },
      body: JSON.stringify({
        slug: input.slug,
        tenantId: input.tenantId,
        bookingIds: input.bookingIds,
        email: input.email || '',
        serviceName: input.serviceName || 'Appointment',
        amountCents: input.amountCents,
        chargeKind: input.chargeKind === 'deposit' ? 'deposit' : 'full',
        returnOrigin: 'https://schedi.app',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data && data.mode === 'connect' && stripeHostedPayUrl(data.url)) return data.url;
  } catch (_) {}
  return '';
}

function cardPayIdsFor(appts, booking, bookingId, extraRaw) {
  const ids = [bookingId];
  if (!booking || !booking.seriesId) return ids;
  for (const extraId of parseBookingIdList(extraRaw)) {
    if (ids.includes(extraId)) continue;
    const other = appts.find((item) => item && String(item.id) === extraId && item.seriesId === booking.seriesId);
    if (!other || !cardPayBookingOpen(other)) continue;
    ids.push(extraId);
  }
  return ids;
}

// GET /billing/card-pay?t={slug}&b={bookingId}&k={manageToken}&kind=deposit|card
// The booking email and the confirmation Pay now button use this URL.
// It redirects only to a connected-account Stripe page. It never charges the platform account
// and never sends the client back to the booking form.
async function handleCardPay(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return cardPayPage('Open this payment link in your browser. Nothing was charged.', 405);
  }
  const tenantId = safeTenantId(url.searchParams.get('t'));
  const bookingId = safeBookingId(url.searchParams.get('b'));
  const token = String(url.searchParams.get('k') || '');
  const kindHint = String(url.searchParams.get('kind') || '');
  const tokenOk = /^[A-Za-z0-9_-]{16,128}$/.test(token);
  // k is the booking's manage token. A slug and booking id are not enough.
  if (!tenantId || !bookingId || !tokenOk) {
    return cardPayPage('This payment link is not valid. Nothing was charged.', 400);
  }
  if (kindHint && kindHint !== 'deposit' && kindHint !== 'card') {
    return cardPayPage('This payment link is not valid. Nothing was charged.', 400);
  }
  const ip = String(request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 64);
  if (!(await rateLimitOk(env && env.RL_MAIL, 'cardpay:' + ip, 30, 'cardpay'))) {
    return cardPayPage('Too many tries. Wait a minute and open the link again. Nothing was charged.', 429);
  }
  let tenant = null;
  let booking = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      tenant = await getTenantById(env, await firebaseAnonymousToken(env), tenantId);
    } catch (_) {
      tenant = null;
      if (attempt === 2) return cardPayPage('Card checkout is unavailable right now. Nothing was charged.', 502);
      continue;
    }
    if (!tenant) return cardPayPage('This payment link is not valid. Nothing was charged.', 404);
    const appts = Array.isArray(tenant.appointments) ? tenant.appointments : [];
    const sameId = appts.find((item) => item && String(item.id) === bookingId) || null;
    if (sameId && (!sameId.manageToken || !timingSafeEqual(String(sameId.manageToken), token))) {
      return cardPayPage('This payment link is not valid. Nothing was charged.', 400);
    }
    booking = sameId;
    if (booking) break;
  }
  if (!booking || !cardPayBookingOpen(booking)) {
    return cardPayPage('This booking is not ready to pay yet. Open the link again in a moment. Nothing was charged.', 404);
  }
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }
  const appts = Array.isArray(tenant.appointments) ? tenant.appointments : [];
  const ids = cardPayIdsFor(appts, booking, bookingId, url.searchParams.get('ids'));
  const inner = new Request(BILLING_APP_ORIGIN + '/billing/booking-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId,
      bookingIds: ids,
      email: booking.clientEmail || '',
    }),
  });
  const checkoutRes = await handleBookingCheckout(inner, env, BILLING_APP_ORIGIN);
  const data = await checkoutRes.json().catch(() => ({}));
  if (data && data.alreadyPaid) {
    return cardPayPage('This card payment is already paid. Nothing more was charged.', 200);
  }
  if (stripeHostedPayUrl(data && data.url)) return stripePayRedirect(data.url);
  if (data && data.error === 'connect_not_ready') {
    return cardPayPage('Card payments are not ready for this business. Nothing was charged.', 409);
  }
  if (data && data.error === 'booking_not_found') {
    return cardPayPage('This booking is not ready to pay yet. Open the link again in a moment. Nothing was charged.', 404);
  }
  const status = checkoutRes.status >= 400 ? checkoutRes.status : 502;
  return cardPayPage('Card checkout did not open. Nothing was charged. Open the payment link from your email again in a moment.', status);
}

function bookingCheckoutCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/** Wiring for POST /billing/cancel and /billing/resume (owner-billing-schedule.js). */
function ownerBillingScheduleDeps(env) {
  return {
    sessionAllows: (session, tenantId) => billingSessionAllows(env, session, tenantId),
    loadTenant: async (tenantId) => {
      const idToken = await firebaseAnonymousToken(env);
      return getTenantById(env, idToken, tenantId);
    },
    stripeForm: (path, init) => stripeRequest(env, path, init || {}),
    saveSchedule: async (tenantId, patch) => {
      const idToken = await firebaseAnonymousToken(env);
      await patchTenantFields(env, idToken, tenantId, {
        cancelAtPeriodEnd: patch.cancelAtPeriodEnd === true,
        currentPeriodEnd: String(patch.currentPeriodEnd || ''),
      });
    },
  };
}

async function handleConnectReady(request, env, origin) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
  const expected = String((env && env.SCHEDI_CONNECT_PAID_SECRET) || '');
  const header = String(request.headers.get('x-schedi-connect-secret') || '');
  if (!expected || !timingSafeEqual(expected, header)) {
    return json({ ok: false, error: 'unauthorized' }, 401, origin);
  }
  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: 'invalid_json' }, 400, origin);
  }
  const slug = safeTenantId(body && (body.slug || body.tenantId));
  const allowedStatus = body && (body.status === 'not_started' || body.status === 'in_progress' || body.status === 'ready');
  if (!slug || (typeof body.ready !== 'boolean' && !allowedStatus)) {
    return json({ ok: false, error: 'invalid_tenant' }, 400, origin);
  }
  let idToken = '';
  try {
    idToken = await firebaseAnonymousToken(env);
  } catch (_) {
    return json({ ok: false, error: 'tenant_lookup_failed' }, 502, origin);
  }
  const tenant = await getTenantById(env, idToken, slug);
  if (!tenant) return json({ ok: false, error: 'tenant_not_found' }, 404, origin);
  let status = allowedStatus ? body.status : (body.ready === true ? 'ready' : 'in_progress');
  if (body.ready === true) status = 'ready';
  if (status === 'ready') body.ready = true;
  const ready = status === 'ready';
  await patchTenantFields(env, idToken, slug, { stripeConnectReady: ready, stripeConnectStatus: status });
  return json({ ok: true, slug, stripeConnectReady: ready, stripeConnectStatus: status }, 200, origin);
}

async function handleBillingRequest(request, env, origin, path, url) {
  if (request.method === 'OPTIONS' && path === '/billing/booking-checkout') {
    return new Response(null, { status: 204, headers: bookingCheckoutCorsHeaders() });
  }
  if (request.method === 'OPTIONS') {
    if (origin && !isAllowedOrigin(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (path === '/billing/webhook') {
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    return handleStripeWebhook(request, env);
  }
  if (path === '/billing/connect-booking-paid') {
    return handleConnectBookingPaid(request, env, {
      json: (body, status) => json(body, status, ''),
      markPaid: (payload) => markBookingCheckoutPaid(env, {
        tenantId: payload.tenantId,
        bookingIds: payload.bookingIds,
        purpose: payload.purpose,
        card: {
          stripeCustomerId: payload.stripeCustomerId || '',
          stripePaymentMethodId: payload.stripePaymentMethodId || '',
        },
        amountCents: payload.amountCents,
        paymentIntentId: payload.paymentIntentId,
        splits: payload.splits,
      }),
    });
  }
  if (path === '/billing/checkout') {
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    return handleBillingCheckout(request, env, origin);
  }
  if (path === '/billing/booking-checkout') {
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    const checkoutRes = await handleBookingCheckout(request, env, origin);
    const headers = new Headers(checkoutRes.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(checkoutRes.body, { status: checkoutRes.status, headers });
  }
  if (path === '/billing/card-pay') {
    return handleCardPay(request, env, url);
  }
  if (path === '/billing/connect-ready') {
    return handleConnectReady(request, env, origin);
  }
  if (path === '/billing/connect-handoff') {
    const handed = await handleConnectHandoff(request, env, {
      sessionAllows: (session, tenantId) => billingSessionAllows(env, session, tenantId),
      loadTenant: (tenantId) => getTenantPlanRecord(env, tenantId),
    });
    return json(handed.body, handed.status, origin);
  }
  if (path === '/billing/connect-plan') {
    const plan = await handleConnectPlan(request, env, {
      loadBySlug: (slug) => getTenantPlanRecord(env, slug),
    });
    return json(plan.body, plan.status, origin);
  }
  if (path === '/billing/subscribe') {
    if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    return handleBillingSubscribe(request, env);
  }
  if (path === '/billing/signup-status') {
    if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    return handleSignupStatus(env, origin, url);
  }
  if (path === '/billing/signup-free') {
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    return handleSignupSwitchFree(request, env, origin);
  }
  if (path === '/billing/signup') {
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    return handleBillingSignup(request, env, origin);
  }
  if (path === '/billing/portal') {
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    return handleBillingPortal(request, env, origin);
  }
  if (ownerBillingScheduleAction(path)) {
    const scheduled = await handleOwnerBillingSchedule(request, path, ownerBillingScheduleDeps(env));
    return json(scheduled.body, scheduled.status, origin);
  }
  if (path === '/billing/status') {
    if (request.method !== 'GET' && request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    return handleBillingStatus(request, env, origin, url);
  }
  if (path === '/billing' && request.method === 'GET') {
    return json({ ok: true, service: 'schedi-billing', endpoints: ['checkout', 'booking-checkout', 'card-pay', 'portal', 'status', 'cancel', 'resume', 'webhook'] }, 200, origin);
  }
  return json({ ok: false, error: 'not_found' }, 404, origin);
}

async function notifyOwnerOfNewBookings(env, tenant, bookings) {
  const list = Array.isArray(bookings) ? bookings : [];
  const results = [];
  for (const booking of list) {
    const out = await notifyOwnerOfNewBooking(env, tenant, booking, {
      sendResend,
      getReminderDoc,
      mergeReminderDoc,
      firebaseAnonymousToken,
    });
    results.push(out);
  }
  return results;
}

async function notifyOwnerOfCancellations(env, tenant, bookings) {
  const list = Array.isArray(bookings) ? bookings : [];
  const results = [];
  for (const booking of list) {
    const out = await notifyOwnerOfCancellation(env, tenant, booking, {
      sendResend,
      getReminderDoc,
      mergeReminderDoc,
      firebaseAnonymousToken,
    });
    results.push(out);
  }
  return results;
}

function workersDevAuthBlocked(url) {
  const host = String(url.hostname || '').toLowerCase();
  if (!host.endsWith('.workers.dev')) return false;
  const path = url.pathname || '/';
  if (path === '/auth' || path.startsWith('/auth/')) return true;
  // Live monitoring uses /api/ops-snapshot (bearer) and Resend uses
  // /api/resend-events (Svix). Only the default-password audit is blocked here.
  if (path === '/api/ops-default-passwords') return true;
  return false;
}

export { AuthRateLimit } from './auth-rate-limit.js';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    // Cron triggers call scheduled(), not this fetch handler. schedi.app routes stay open.
    if (workersDevAuthBlocked(url)) return json({ ok: false, error: 'not_found' }, 404, origin);
    if (path === '/api/ops-snapshot') {
      return handleOpsSnapshotHttp(request, env, { stripeRequest, adminAuthHeaders });
    }
    if (path === '/api/ops-default-passwords') {
      return handleDefaultPasswordAudit(request, env);
    }
    if (path === '/api/resend-events') {
      return handleResendEventsHttp(request, env);
    }
    if (path === '/api/booking-ics') {
      return handleBookingIcs(request, env, {
        json,
        firebaseAnonymousToken,
        getTenantById,
        listAllTenants,
      });
    }
    if (path === '/api/calendar-feeds') {
      return handleCalendarFeeds(request, env, origin, {
        json,
        isAllowedOrigin,
        readSession,
        getTenant: async (env2, id) => getTenantById(env2, await firebaseAnonymousToken(env2), id),
      });
    }
    if (path === '/api/calendar-busy') {
      return handleCalendarBusy(request, env);
    }
    const ownerFeedMatch = path.match(/^\/api\/owner-feed\/([a-f0-9]{32,128})\.ics$/i);
    if (ownerFeedMatch) {
      return handleOwnerFeed(request, env, ownerFeedMatch[1], {
        loadAppointments: (id) => loadPrivateAppointments(env, id),
        getTenantById,
        firebaseAnonymousToken,
      });
    }
    if (path === '/api/manage/pay') {
      if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
      return handleManagePay(request, env, url);
    }
    if (path === '/api/bookings' || path === '/api/manage') {
      return handlePrivateBookingHttp(request, env, origin, path, {
        json,
        isAllowedOrigin,
        getTenantById,
        listAllTenants,
        applyCancellationFee: (env2, tenant, booking) => applyCancellationFee(env2, tenant, booking, stripeRequest),
        notifyOwnerOfNewBookings,
        notifyOwnerOfCancellations,
        sendResend,
      }, ctx);
    }
    if (path === '/api/push-token') {
      return handlePushTokenHttp(request, env, origin, { isAllowedOrigin });
    }
    if (path === '/api/push-test') {
      return handlePushTestHttp(request, env, origin, { isAllowedOrigin, rateLimitOk });
    }
    if (path === '/api/page-visits') {
      if (request.method === 'OPTIONS') {
        if (origin && !isAllowedOrigin(origin)) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      if (origin && !isAllowedOrigin(origin)) return json({ ok: false, error: 'origin_not_allowed' }, 403, origin);
      return handlePageVisitsRequest(request, env, origin, json, readSession);
    }
    if (path === '/api/clients') {
      return handleClientsHttp(request, env, origin, { isAllowedOrigin });
    }
    if (path === '/api/profile') {
      if (request.method === 'OPTIONS') {
        if (origin && !isAllowedOrigin(origin)) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      return handleProfileRequest(request, env, origin, json);
    }
    if (path === '/api/logo-upload') {
      if (request.method === 'OPTIONS') {
        if (origin && !isAllowedOrigin(origin)) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      return handleLogoUpload(request, env, origin, {
        json,
        isAllowedOrigin,
        readSession: readLogoWriteSession,
        // Same businesses the agency private-profile action returns as data.tenants.
        agencyOwnsTenant: async (env2, tenantId) => {
          try { return !!(await getPrivateTenant(env2, tenantId)); } catch (_) { return false; }
        },
      });
    }
    if (path === '/api/webhooks/square' || path === '/api/square/callback' || path === '/api/square/checkout' || path === '/api/square/pay' || path === '/api/square/confirm' || path === '/api/square/connect' || path === '/api/square/status' || path === '/api/square/location' || path === '/api/square/disconnect' || path === '/api/square/refund') {
      return handleSquareHttp(request, env, origin, path, {
        json,
        isAllowedOrigin,
        getTenantById,
        firebaseAnonymousToken,
        planName: tenantPlanName,
        bookingPrice: bookingPriceForCharge,
        depositQuote: quoteDepositForPrice,
        depositOn: depositRequiredForTenant,
        slugFor: publicBookingSlug,
      });
    }

    if (path === '/auth/provision-mail') {
      return handleAgencyProvisionMail(request, env, origin);
    }

    if (path === '/auth/forgot' || path === '/auth/reset-check' || path === '/auth/reset' || path === '/auth/change') {
      if (request.method === 'OPTIONS') {
        if (origin && !isAllowedOrigin(origin)) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      return handleOwnerResetRequest(request, env, origin, path, json, {
        sendResend,
        isAllowedOrigin,
        getTenantBasics,
        tenantExists: (id) => tenantExists(env, id),
      }, ctx);
    }

    if (path === '/auth' || path.startsWith('/auth/')) {
      if (request.method === 'OPTIONS') {
        if (origin && !isAllowedOrigin(origin)) {
          return new Response(null, { status: 403 });
        }
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      return handleAuthRequest(request, env, origin, path, json, { tenantExists: (id) => tenantExists(env, id) });
    }

    if (path === '/billing' || path.startsWith('/billing/')) {
      return handleBillingRequest(request, env, origin, path, url);
    }

    if (request.method === 'OPTIONS') {
      if (origin && !isAllowedOrigin(origin)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === 'GET') {
      return json(
        {
          ok: true,
          service: 'schedi-email-worker',
          features: ['booking_email', 'same_day_reminders', 'sms_confirmations', 'sms_reminders', 'owner_billing', 'booking_deposits', 'cancellation_fees', 'owner_booking_notify'],
          rateLimits: ['RL_MAIL', 'RL_MAIL_TENANT', 'RL_SIGNUP', 'RL_SIGNUP_GLOBAL', 'RL_BOOKING_CREATE'].filter((k) => env[k] && typeof env[k].limit === 'function'),
        },
        200,
        origin
      );
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    }

    return handleBookingMailPost(request, env, origin, {
      json,
      isAllowedOrigin,
      getTenantById,
      firebaseAnonymousToken,
      sendResend,
      sendBookingConfirmationSms,
      runSameDayReminders,
      ownerNotifyEnabledForTenant,
      escapeHtml,
      safeTenantId,
    });
  },

  async scheduled(event, env, ctx) {
    if (event && event.cron === '*/12 * * * *') {
      ctx.waitUntil(
        syncAllCalendarFeeds(env, {
          getTenant: async (env2, id) => getTenantById(env2, await firebaseAnonymousToken(env2), id),
        })
          .then((r) => console.log('calendar sync', JSON.stringify({ synced: r && r.synced, errors: r && r.errors })))
          .catch((err) => console.error('calendar sync failed', err && err.message ? err.message : err))
      );
      return;
    }
    ctx.waitUntil(
      runSameDayReminders(env, { force: false, dryRun: false })
        .then((r) => console.log('reminder cron', JSON.stringify(r)))
        .catch((err) => console.error('reminder cron failed', err))
    );
    ctx.waitUntil(
      runOpsSnapshotCron(event, env, { stripeRequest, adminAuthHeaders })
        .then((r) => { if (r && !r.skipped) console.log('ops snapshot cron', JSON.stringify(r)); })
        .catch(() => console.error('ops snapshot cron failed'))
    );
    ctx.waitUntil(
      runClientsBackfillOnce(env, { firebaseAnonymousToken, listAllTenants })
        .then((r) => { if (r && !r.skipped) console.log('clients backfill', JSON.stringify({ tenants: r.tenants, added: r.added })); })
        .catch((err) => console.error('clients backfill failed', err && err.message ? err.message : err))
    );
    ctx.waitUntil(
      runDepositFollowups(env, {
        firebaseAnonymousToken, listAllTenants, persistTenantAppointments, sendResend, tenantPlanName, tenantTimezone,
        ownerAddress: (t) => resolveOwnerNotifyAddress(t, t),
      })
        .then((r) => { if (r.nudged || r.released || r.dayBefore || r.ownerWarned || r.errors) console.log('deposit followups', JSON.stringify({ nudged: r.nudged, dayBefore: r.dayBefore, ownerWarned: r.ownerWarned || 0, released: r.released, errors: r.errors })); })
        .catch((err) => console.error('deposit followups failed', err && err.message ? err.message : err))
    );
    ctx.waitUntil(
      runUnpaidDigest(env, {
        firebaseAnonymousToken, listAllTenants, patchTenantFields, sendResend, tenantTimezone,
        ownerAddress: (t) => resolveOwnerNotifyAddress(t, t), fromAddress: FROM_ADDRESS,
      })
        .then((r) => { if (r.sent || r.errors) console.log('unpaid digest', JSON.stringify({ sent: r.sent, skippedEmpty: r.skippedEmpty, errors: r.errors })); })
        .catch((err) => console.error('unpaid digest failed', err && err.message ? err.message : err))
    );
    ctx.waitUntil(
      runSignupReminders(env, { firebaseAnonymousToken, listAllTenants, patchTenantFields, sendResend, onboardingFrom: ONBOARDING_FROM })
        .then((r) => { if (r.sent || r.errors) console.log('signup reminders', JSON.stringify({ sent: r.sent, errors: r.errors })); })
        .catch((err) => console.error('signup reminders failed', err && err.message ? err.message : err))
    );
    ctx.waitUntil(
      runSquareReconcile(env)
        .then((r) => { if (r && (r.checked || r.errors)) console.log('square reconcile', JSON.stringify(r)); })
        .catch((err) => console.error('square reconcile failed', err && err.message ? err.message : err))
    );
  },
};
