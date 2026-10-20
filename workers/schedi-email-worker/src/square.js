/**
 * Square OAuth, Payment Links, webhooks, and owner refunds.
 *
 * Each business connects its own Square account. Schedi does not set app_fee_money
 * and does not request PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS. Access and refresh
 * tokens are AES-256-GCM ciphertext on the private tenant doc (squareConnection).
 * AUTH_KV holds the OAuth state and short lookup keys, never the tokens.
 */
import { readSession } from './owner-auth.js';
import { loadPrivateAppointments, persistTenantAppointments } from './private-bookings.js';
import { rateLimitOk } from './rate-limit.js';
import {
  SQUARE_CONNECTION_KEY,
  deletePrivateFields,
  getPrivateTenant,
  patchPrivateTenant,
  patchPublicFields,
} from './tenant-private.js';

export const SQUARE_SCOPES = [
  'MERCHANT_PROFILE_READ',
  'PAYMENTS_READ',
  'PAYMENTS_WRITE',
  'ORDERS_READ',
  'ORDERS_WRITE',
];

export const SQUARE_VERSION = '2024-10-17';
const STATE_PREFIX = 'sqstate:';
const ORDER_PREFIX = 'sqord:';
const BOOKING_ORDER_PREFIX = 'sqbk:';
const PAYMENT_PREFIX = 'sqpay:';
const REFUND_PREFIX = 'sqref:';
const RECONCILE_CURSOR_KEY = 'sqrecon:after';
const EVENT_PREFIX = 'sqevt:';
const RECONCILE_CAP = 20;
const AWAITING_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const APPT_PREFIX = 'privateAppts:';
const STATE_TTL_SECONDS = 600;
const REDIRECT_DEFAULT = 'https://schedi.app/api/square/callback';
const WEBHOOK_URL_DEFAULT = 'https://schedi.app/api/webhooks/square';
const APP_ORIGIN = 'https://schedi.app';

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

function bytesToB64Url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function timingSafeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function timingSafeEqualBytes(a, b) {
  const left = a instanceof Uint8Array ? a : new Uint8Array();
  const right = b instanceof Uint8Array ? b : new Uint8Array();
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] || 0) ^ (right[i] || 0);
  }
  return diff === 0;
}

export function squareEnvironment(env) {
  return String((env && env.SQUARE_ENVIRONMENT) || '').trim().toLowerCase() === 'production'
    ? 'production'
    : 'sandbox';
}

export function squareHosts(env) {
  const production = squareEnvironment(env) === 'production';
  const host = production ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
  return { connect: host, api: host };
}

export function squareRedirectUrl(env) {
  const configured = String((env && env.SQUARE_REDIRECT_URL) || '').trim();
  return configured || REDIRECT_DEFAULT;
}

export function squareWebhookUrl(env) {
  const configured = String((env && env.SQUARE_WEBHOOK_NOTIFICATION_URL) || '').trim();
  return configured || WEBHOOK_URL_DEFAULT;
}

export function squareTokenKeyBytes(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  try {
    const bytes = b64ToBytes(text);
    if (bytes.length === 32) return bytes;
  } catch (_) {}
  return null;
}

export async function encryptSquareTokens(keyBytes, tokens) {
  if (!keyBytes || keyBytes.length !== 32) throw new Error('square_token_key_invalid');
  const accessToken = String((tokens && tokens.accessToken) || '');
  const refreshToken = String((tokens && tokens.refreshToken) || '');
  if (!accessToken || !refreshToken) throw new Error('square_token_missing');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const plain = new TextEncoder().encode(JSON.stringify({ accessToken, refreshToken }));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return bytesToB64(packed);
}

export async function decryptSquareTokens(keyBytes, packedB64) {
  if (!keyBytes || keyBytes.length !== 32) throw new Error('square_token_key_invalid');
  const packed = b64ToBytes(packedB64);
  if (packed.length < 12 + 16) throw new Error('square_cipher_invalid');
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  if (!parsed || !parsed.accessToken || !parsed.refreshToken) throw new Error('square_cipher_invalid');
  return { accessToken: String(parsed.accessToken), refreshToken: String(parsed.refreshToken) };
}

export function newOauthState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToB64Url(bytes);
}

export function validateOauthState(record, state, now) {
  const given = String(state || '');
  if (!record || !given) return { ok: false, reason: 'missing' };
  if (!timingSafeEqual(String(record.state || ''), given)) return { ok: false, reason: 'mismatch' };
  const tenantId = String(record.tenantId || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(tenantId)) return { ok: false, reason: 'missing' };
  if (!(Number(record.expiresAt) > Number(now || Date.now()))) return { ok: false, reason: 'expired' };
  return { ok: true, tenantId, session: String(record.session || '') };
}

export function buildAuthorizeUrl(env, state) {
  const hosts = squareHosts(env);
  const clientId = String((env && env.SQUARE_APPLICATION_ID) || '').trim();
  const url = new URL(hosts.connect + '/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', SQUARE_SCOPES.join(' '));
  url.searchParams.set('session', 'false');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', squareRedirectUrl(env));
  return url.toString();
}

export function squareIdempotencyKey(bookingId, kind) {
  const prefix = kind === 'deposit' ? 'sqd_' : 'sqf_';
  return (prefix + String(bookingId || '').replace(/[^A-Za-z0-9_-]/g, '')).slice(0, 45);
}

export function squareRefundIdempotencyKey(bookingId, amountCents) {
  return ('sqr_' + String(bookingId || '').replace(/[^A-Za-z0-9_-]/g, '') + '_' + String(amountCents || 0)).slice(0, 45);
}

export function squarePaymentNote(tenantId, bookingIds, kind) {
  const ids = (Array.isArray(bookingIds) ? bookingIds : [bookingIds]).filter(Boolean).join(',');
  return ('schedi|' + tenantId + '|' + ids + '|' + (kind === 'deposit' ? 'deposit' : 'full')).slice(0, 500);
}

export function parseSquarePaymentNote(note) {
  const text = String(note || '');
  const match = text.match(/schedi\|([A-Za-z0-9_-]{1,80})\|([A-Za-z0-9_-]{4,40}(?:,[A-Za-z0-9_-]{4,40})*)\|(deposit|full)\b/);
  if (!match) return null;
  const ids = match[2].split(',').map((id) => id.trim()).filter((id) => /^[A-Za-z0-9_-]{4,40}$/.test(id));
  if (!ids.length) return null;
  return { tenantId: match[1], bookingIds: ids, kind: match[3] === 'deposit' ? 'deposit' : 'full' };
}

export function buildPaymentLinkBody(input) {
  const kind = input.chargeKind === 'deposit' ? 'deposit' : 'full';
  const bookingId = input.bookingIds[0];
  const note = squarePaymentNote(input.tenantId, input.bookingIds, kind);
  const name = String(input.itemName || 'Appointment').slice(0, 512);
  const body = {
    idempotency_key: squareIdempotencyKey(bookingId, kind),
    description: String(input.description || name).slice(0, 4096),
    order: {
      location_id: String(input.locationId),
      reference_id: String(bookingId).slice(0, 40),
      line_items: [
        {
          name,
          quantity: '1',
          base_price_money: {
            amount: Math.round(Number(input.amountCents)),
            currency: String(input.currency || 'USD').toUpperCase(),
          },
          note: note.slice(0, 500),
        },
      ],
    },
    checkout_options: {
      redirect_url: String(input.redirectUrl),
      ask_for_shipping_address: false,
    },
    payment_note: note,
  };
  return body;
}

export function buildRefundBody(input) {
  return {
    idempotency_key: squareRefundIdempotencyKey(input.bookingId, input.amountCents),
    payment_id: String(input.paymentId),
    amount_money: {
      amount: Math.round(Number(input.amountCents)),
      currency: String(input.currency || 'USD').toUpperCase(),
    },
    reason: 'Refund from the business in Schedi',
  };
}

function paidAlready(booking, paymentId) {
  if (!booking) return false;
  if (booking.paidMethod !== 'square' || String(booking.squarePaymentId || '') !== String(paymentId || '')) return false;
  const status = String(booking.paymentStatus || '').toUpperCase();
  if (status.indexOf('REFUND') !== -1) return true;
  return status.indexOf('PAID') !== -1 && status.indexOf('AWAITING') === -1;
}

function squarePaymentStatus(payment) {
  return String((payment && payment.status) || '').trim().toUpperCase();
}

function bookingPaidState(booking) {
  if (!booking || booking.paidMethod !== 'square') return false;
  const status = String(booking.paymentStatus || '').toUpperCase();
  if (!status || status.indexOf('AWAITING') !== -1) return false;
  if (status.indexOf('UNPAID') !== -1 || status.indexOf('NOT PAID') !== -1) return false;
  if (status.indexOf('REFUND') !== -1) return false;
  return status.indexOf('PAID') !== -1;
}

export function applySquarePaymentUpdate(booking, payment, kind) {
  if (!booking || !payment) return { booking, changed: false, duplicate: false };
  const status = squarePaymentStatus(payment);
  if (status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED') {
    return { booking, changed: false, duplicate: false };
  }
  if (status !== 'COMPLETED') return { booking, changed: false, duplicate: false };
  const paymentId = String(payment.id || '');
  if (paidAlready(booking, paymentId)) return { booking, changed: false, duplicate: true };
  const next = Object.assign({}, booking);
  const chargeKind = kind === 'deposit'
    ? 'deposit'
    : (kind === 'full'
      ? 'full'
      : (Number(booking.depositAmount) > 0 && booking.depositPaid !== true ? 'deposit' : 'full'));
  if (chargeKind === 'deposit' && Number(booking.depositAmount) > 0) {
    next.depositPaid = true;
    next.paymentStatus = 'DEPOSIT PAID';
    next.paymentOptionLabel = next.paymentOptionLabel || 'Square deposit';
  } else {
    next.paymentStatus = 'PAID';
    next.paymentOptionLabel = next.paymentOptionLabel || 'Square';
  }
  next.paidMethod = 'square';
  next.paymentMethod = 'square';
  if (paymentId) next.squarePaymentId = paymentId;
  if (payment.order_id) next.squareOrderId = String(payment.order_id);
  const money = payment.amount_money || {};
  if (Number.isFinite(Number(money.amount))) next.squareAmountCents = Math.round(Number(money.amount));
  if (money.currency) next.squareCurrency = String(money.currency).toUpperCase();
  return { booking: next, changed: true, duplicate: false };
}

export function applySquareRefundUpdate(booking, refund) {
  if (!booking || !refund) return { booking, changed: false, duplicate: false };
  if (String(refund.status || '') !== 'COMPLETED') return { booking, changed: false, duplicate: false, pending: true };
  const refundId = String(refund.id || '');
  if (booking.squareRefundId === refundId && booking.squareRefundStatus === 'COMPLETED') {
    return { booking, changed: false, duplicate: true };
  }
  const next = Object.assign({}, booking);
  next.squareRefundId = refundId;
  next.squareRefundStatus = 'COMPLETED';
  const cents = refund.amount_money && refund.amount_money.amount;
  if (Number.isFinite(Number(cents))) next.squareRefundedCents = Math.round(Number(cents));
  const paid = Number(next.squareAmountCents || 0);
  if (paid > 0 && Number(next.squareRefundedCents) >= paid) next.paymentStatus = 'REFUNDED';
  return { booking: next, changed: true, duplicate: false };
}

function squareRefundStatusOf(refund) {
  return String((refund && refund.status) || '').trim().toUpperCase();
}

function refundStatusIsFinal(status) {
  const value = String(status || '').trim().toUpperCase();
  return value === 'COMPLETED' || value === 'FAILED' || value === 'REJECTED' || value === 'CANCELED' || value === 'CANCELLED';
}

/** Remember a refund that Square has not finished. Does not mark the visit refunded or store an amount. */
export function recordSquareRefundProgress(booking, refund) {
  const refundId = String((refund && refund.id) || '');
  const status = squareRefundStatusOf(refund);
  if (!booking || !refundId || !status || status === 'COMPLETED') return { booking, changed: false };
  if (String(booking.squareRefundId || '') === refundId && String(booking.squareRefundStatus || '').toUpperCase() === status) {
    return { booking, changed: false, duplicate: true, pending: status === 'PENDING' };
  }
  const next = Object.assign({}, booking);
  next.squareRefundId = refundId;
  next.squareRefundStatus = status;
  return { booking: next, changed: true, pending: status === 'PENDING' };
}

/** A failed Square refund leaves the appointment as it was. A PENDING refund keeps its id. */
export function applyRefundApiResult(booking, apiResult) {
  if (!apiResult || apiResult.ok !== true || !apiResult.refund) {
    return { booking, changed: false, error: (apiResult && apiResult.error) || 'refund_failed' };
  }
  const status = squareRefundStatusOf(apiResult.refund);
  if (status === 'PENDING') return recordSquareRefundProgress(booking, apiResult.refund);
  if (status !== 'COMPLETED') return { booking, changed: false, pending: true };
  return applySquareRefundUpdate(booking, apiResult.refund);
}

export async function squareWebhookSignature(signatureKey, notificationUrl, rawBody) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(signatureKey || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const data = new TextEncoder().encode(String(notificationUrl || '') + String(rawBody || ''));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  return bytesToB64(mac);
}

export async function readVerifiedSquareEvent(rawBody, signatureHeader, env) {
  const signatureKey = String((env && env.SQUARE_WEBHOOK_SIGNATURE_KEY) || '').trim();
  if (!signatureKey) return { ok: false, status: 500, error: 'not_configured' };
  let expected = '';
  try {
    expected = await squareWebhookSignature(signatureKey, squareWebhookUrl(env), rawBody);
  } catch (_) {
    return { ok: false, status: 500, error: 'not_configured' };
  }
  let headerBytes;
  let expectedBytes;
  try {
    headerBytes = b64ToBytes(signatureHeader || '');
    expectedBytes = b64ToBytes(expected);
  } catch (_) {
    return { ok: false, status: 403, error: 'bad_signature' };
  }
  if (!headerBytes.length || !timingSafeEqualBytes(headerBytes, expectedBytes)) {
    return { ok: false, status: 403, error: 'bad_signature' };
  }
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (_) {
    return { ok: false, status: 400, error: 'bad_json' };
  }
  return { ok: true, event };
}

function paymentFromSquareEvent(event) {
  const object = event && event.data && event.data.object;
  if (!object || typeof object !== 'object') return null;
  if (object.payment && typeof object.payment === 'object') return object.payment;
  if (object.id && (object.status || object.order_id || object.orderId || object.amount_money)) return object;
  return null;
}

function orderUpdateFromEvent(event) {
  const object = event && event.data && event.data.object;
  if (!object || typeof object !== 'object') return null;
  if (object.order_updated && typeof object.order_updated === 'object') return object.order_updated;
  return object;
}

export async function processSquareNotification(event, store) {
  const type = String((event && event.type) || '');
  const eventId = String((event && event.event_id) || '');
  if (eventId && store.seenEvent && await store.seenEvent(eventId)) return { ok: true, duplicate: true };
  if (type === 'payment.updated' || type === 'payment.created') {
    const payment = paymentFromSquareEvent(event);
    // A Payment Link card charge is often created already COMPLETED. Sandbox
    // sometimes delivers that as payment.created and never sends payment.updated.
    if (!payment || squarePaymentStatus(payment) !== 'COMPLETED') return { ok: true, ignored: true };
    const found = await store.findPaymentBooking(payment);
    if (!found || !found.bookings || !found.bookings.length) return { ok: true, ignored: true };
    let changed = false;
    let duplicate = true;
    for (const booking of found.bookings) {
      const applied = applySquarePaymentUpdate(booking, payment, found.kind);
      if (applied.duplicate) continue;
      duplicate = false;
      if (applied.changed) {
        changed = true;
        await store.saveBooking(found.tenantId, applied.booking);
      }
    }
    if (eventId && store.markEvent) await store.markEvent(eventId);
    return { ok: true, changed, duplicate: duplicate && !changed };
  }
  if (type === 'order.updated') {
    const info = orderUpdateFromEvent(event);
    const state = String((info && info.state) || '').toUpperCase();
    const orderId = info && (info.order_id || info.id);
    if (!orderId || (state && state !== 'COMPLETED')) return { ok: true, ignored: true };
    if (!store.reconcileCompletedOrder) return { ok: true, ignored: true };
    const result = await store.reconcileCompletedOrder(String(orderId));
    if (result && result.retry) return result;
    if (eventId && store.markEvent && result && (result.changed || result.duplicate)) await store.markEvent(eventId);
    return result || { ok: true, ignored: true };
  }
  if (type === 'refund.updated') {
    const refund = event && event.data && event.data.object && event.data.object.refund;
    if (!refund || String(refund.status || '') !== 'COMPLETED') return { ok: true, ignored: true };
    const found = await store.findRefundBooking(refund);
    if (!found) return { ok: true, ignored: true };
    const applied = applySquareRefundUpdate(found.booking, refund);
    if (applied.changed) await store.saveBooking(found.tenantId, applied.booking);
    if (eventId && store.markEvent) await store.markEvent(eventId);
    return { ok: true, changed: applied.changed, duplicate: applied.duplicate === true };
  }
  return { ok: true, ignored: true };
}

function jsonResponse(deps, body, status, origin) {
  if (deps && typeof deps.json === 'function') return deps.json(body, status, origin);
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function portalRedirect(reason, extra) {
  const url = new URL(APP_ORIGIN + '/');
  url.searchParams.set('square', reason);
  if (extra) url.searchParams.set('squareReason', String(extra).slice(0, 80));
  return Response.redirect(url.toString(), 302);
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch (_) {
    return {};
  }
}

function sessionCan(session, tenantId) {
  if (!session) return { ok: false, status: 401, error: 'session_required' };
  if (session.role === 'agency') return { ok: true };
  if (session.role === 'owner' && session.tenantId === tenantId) return { ok: true };
  return { ok: false, status: 403, error: 'forbidden' };
}

function safeTenant(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : '';
}

async function kvGet(env, key) {
  if (!env || !env.AUTH_KV) return null;
  const raw = await env.AUTH_KV.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function loadConnection(env, tenantId, deps) {
  if (deps && deps.loadConnection) return deps.loadConnection(env, tenantId);
  const priv = await getPrivateTenant(env, tenantId);
  return (priv && priv[SQUARE_CONNECTION_KEY]) || null;
}

async function saveConnection(env, tenantId, connection, deps) {
  if (deps && deps.saveConnection) return deps.saveConnection(env, tenantId, connection);
  await patchPrivateTenant(env, tenantId, { [SQUARE_CONNECTION_KEY]: connection });
}

async function clearConnection(env, tenantId, deps) {
  if (deps && deps.clearConnection) return deps.clearConnection(env, tenantId);
  await deletePrivateFields(env, tenantId, [SQUARE_CONNECTION_KEY]);
}

async function savePublicStatus(env, tenantId, status, deps) {
  if (deps && deps.savePublicStatus) return deps.savePublicStatus(env, tenantId, status);
  await patchPublicFields(env, tenantId, status);
}

function publicStatusFrom(connection) {
  const connected = !!(connection && connection.cipher && connection.merchantId);
  const ready = connected && !!connection.locationId;
  return { squareReady: ready };
}

function statusView(connection) {
  const connected = !!(connection && connection.cipher && connection.merchantId);
  const ready = connected && !!connection.locationId;
  return {
    ok: true,
    connected,
    ready,
    merchantId: connected ? String(connection.merchantId) : '',
    locationId: ready ? String(connection.locationId) : '',
    locationName: ready ? String(connection.locationName || '') : '',
    accountName: connected ? String(connection.accountName || '') : '',
    needsLocation: !!(connection && connection.cipher && !connection.locationId),
    locations: Array.isArray(connection && connection.locations) ? connection.locations : [],
    expiresAt: connection && connection.expiresAt ? connection.expiresAt : '',
  };
}

function squareFetch(deps, url, init) {
  const fetchImpl = (deps && deps.squareFetch) || fetch;
  return fetchImpl(url, init);
}

async function squareApi(env, deps, token, path, init) {
  const hosts = squareHosts(env);
  const headers = Object.assign({
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Square-Version': SQUARE_VERSION,
  }, (init && init.headers) || {});
  const res = await squareFetch(deps, hosts.api + path, {
    method: (init && init.method) || 'GET',
    headers,
    body: init && init.body ? init.body : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function exchangeToken(env, deps, body) {
  const hosts = squareHosts(env);
  const res = await squareFetch(deps, hosts.connect + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function tokenErrorDisconnected(status, data) {
  if (status === 401) return true;
  const code = String((data && (data.error || data.type || data.code)) || '').toLowerCase();
  const message = JSON.stringify(data || {}).toLowerCase();
  return code.indexOf('invalid_grant') !== -1 || message.indexOf('invalid_grant') !== -1 || code === 'unauthorized';
}

async function accessTokenFor(env, tenantId, deps) {
  const keyBytes = squareTokenKeyBytes(env && env.SQUARE_TOKEN_KEY);
  if (!keyBytes) return { error: 'square_token_key_invalid', status: 500 };
  const connection = await loadConnection(env, tenantId, deps);
  if (!connection || !connection.cipher) return { error: 'square_not_connected', status: 409 };
  let tokens;
  try {
    tokens = await decryptSquareTokens(keyBytes, connection.cipher);
  } catch (_) {
    return { error: 'square_cipher_invalid', status: 500 };
  }
  const expiresAt = Date.parse(connection.expiresAt || '');
  const refreshSoon = !Number.isFinite(expiresAt) || expiresAt - Date.now() < 2 * 24 * 60 * 60 * 1000;
  if (!refreshSoon) return { token: tokens.accessToken, connection, tokens };
  const refreshed = await exchangeToken(env, deps, {
    client_id: String(env.SQUARE_APPLICATION_ID || ''),
    client_secret: String(env.SQUARE_APPLICATION_SECRET || ''),
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
  });
  if (!refreshed.ok) {
    if (tokenErrorDisconnected(refreshed.status, refreshed.data)) {
      await clearConnection(env, tenantId, deps);
      await savePublicStatus(env, tenantId, publicStatusFrom(null), deps);
      return { error: 'square_disconnected', status: 409 };
    }
    return { error: 'square_refresh_failed', status: refreshed.status || 502 };
  }
  const nextTokens = {
    accessToken: refreshed.data.access_token || tokens.accessToken,
    refreshToken: refreshed.data.refresh_token || tokens.refreshToken,
  };
  const cipher = await encryptSquareTokens(keyBytes, nextTokens);
  const next = Object.assign({}, connection, {
    cipher,
    expiresAt: refreshed.data.expires_at || connection.expiresAt,
    merchantId: refreshed.data.merchant_id || connection.merchantId,
  });
  await saveConnection(env, tenantId, next, deps);
  return { token: nextTokens.accessToken, connection: next, tokens: nextTokens };
}

async function fetchLocations(env, deps, token) {
  const listed = await squareApi(env, deps, token, '/v2/locations');
  if (!listed.ok) return { error: 'locations_failed', status: listed.status || 502 };
  const locations = (listed.data.locations || [])
    .filter((loc) => loc && loc.id && String(loc.status || 'ACTIVE').toUpperCase() === 'ACTIVE')
    .map((loc) => ({ id: String(loc.id), name: String(loc.name || loc.business_name || 'Location').slice(0, 120) }));
  return { locations };
}

async function fetchAccountName(env, deps, token, merchantId) {
  if (!merchantId) return '';
  const res = await squareApi(env, deps, token, '/v2/merchants/' + encodeURIComponent(merchantId));
  if (!res.ok) return '';
  const merchant = res.data.merchant || res.data;
  return String(merchant.business_name || merchant.name || '').slice(0, 120);
}

function bookingIdsFrom(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const out = [];
  for (const item of raw) {
    const id = String(item || '').trim();
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(id) || out.indexOf(id) !== -1) continue;
    out.push(id);
    if (out.length === 12) break;
  }
  return out;
}

function bookingOrderKey(tenantId, bookingId) {
  return BOOKING_ORDER_PREFIX + tenantId + ':' + bookingId;
}

async function rememberOrder(env, orderId, tenantId, bookingIds, kind) {
  if (!env || !env.AUTH_KV || !orderId) return;
  const chargeKind = kind === 'deposit' ? 'deposit' : (kind === 'full' ? 'full' : '');
  const ids = (Array.isArray(bookingIds) ? bookingIds : []).map((id) => String(id)).filter(Boolean);
  let keptKind = chargeKind;
  if (!keptKind) {
    const prev = await kvGet(env, ORDER_PREFIX + orderId);
    if (prev && (prev.kind === 'deposit' || prev.kind === 'full')) keptKind = prev.kind;
  }
  const payload = JSON.stringify({ tenantId, bookingIds: ids, kind: keptKind || undefined });
  await env.AUTH_KV.put(ORDER_PREFIX + orderId, payload);
  for (const id of ids) {
    await env.AUTH_KV.put(bookingOrderKey(tenantId, id), JSON.stringify({ orderId: String(orderId), kind: keptKind || undefined }));
  }
}

async function rememberLookup(env, payment, tenantId, bookingIds, kind) {
  if (!env.AUTH_KV) return;
  const ids = (Array.isArray(bookingIds) ? bookingIds : []).map((id) => String(id)).filter(Boolean);
  if (payment && payment.order_id) await rememberOrder(env, payment.order_id, tenantId, ids, kind);
  if (payment && payment.id) {
    await env.AUTH_KV.put(PAYMENT_PREFIX + payment.id, JSON.stringify({ tenantId, bookingIds: ids }));
  }
}

async function rememberRefund(env, refund, tenantId, bookingId, paymentId) {
  if (!env || !env.AUTH_KV) return;
  const id = String(bookingId || '');
  const payId = String(paymentId || (refund && refund.payment_id) || '');
  const refundId = String((refund && refund.id) || '');
  if (payId && id) {
    const prev = await kvGet(env, PAYMENT_PREFIX + payId);
    const ids = Array.isArray(prev && prev.bookingIds) ? prev.bookingIds.map((item) => String(item)) : [];
    if (ids.indexOf(id) === -1) ids.push(id);
    await env.AUTH_KV.put(PAYMENT_PREFIX + payId, JSON.stringify({
      tenantId: (prev && prev.tenantId) || tenantId,
      bookingIds: ids,
    }));
  }
  if (refundId && id) {
    await env.AUTH_KV.put(REFUND_PREFIX + refundId, JSON.stringify({
      tenantId,
      bookingIds: [id],
      paymentId: payId,
    }));
  }
}

async function stampBookings(env, deps, tenantId, nextBookings) {
  const token = deps.firebaseAnonymousToken ? await deps.firebaseAnonymousToken(env) : '';
  const stamps = {};
  for (const booking of nextBookings) {
    if (!booking || !booking.id) continue;
    stamps[String(booking.id)] = booking;
  }
  const save = deps.saveAppointments || persistTenantAppointments;
  await save(env, token, tenantId, nextBookings, { squareStamps: stamps });
}

export async function handleSquareHttp(request, env, origin, path, deps) {
  deps = deps || {};
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: checkoutCors() });
  }

  if (path === '/api/webhooks/square') {
    if (request.method !== 'POST') return jsonResponse(deps, { ok: false, error: 'method_not_allowed' }, 405, origin);
    const raw = await request.text();
    const verified = await readVerifiedSquareEvent(raw, request.headers.get('x-square-hmacsha256-signature'), env);
    if (!verified.ok) return jsonResponse(deps, { ok: false, error: verified.error }, verified.status, origin);
    const store = squareEventStore(env, deps);
    const result = await processSquareNotification(verified.event, store);
    if (result && result.retry) {
      return jsonResponse(deps, { ok: false, error: result.error || 'square_unavailable' }, 503, origin);
    }
    return jsonResponse(deps, { ok: true }, 200, origin);
  }

  if (path === '/api/square/callback') {
    if (request.method !== 'GET') return jsonResponse(deps, { ok: false, error: 'method_not_allowed' }, 405, origin);
    return handleCallback(request, env, url, deps);
  }

  if (path === '/api/square/checkout') {
    if (request.method !== 'POST') return jsonResponse(deps, { ok: false, error: 'method_not_allowed' }, 405, origin);
    const res = await handleCheckout(request, env, deps);
    return withCheckoutCors(res);
  }

  if (path === '/api/square/confirm') {
    if (request.method !== 'POST') return jsonResponse(deps, { ok: false, error: 'method_not_allowed' }, 405, origin);
    const res = await handleConfirm(request, env, deps);
    return withCheckoutCors(res);
  }

  if (request.method !== 'POST') return jsonResponse(deps, { ok: false, error: 'method_not_allowed' }, 405, origin);
  const body = await readJsonBody(request);
  const tenantId = safeTenant(body.tenantId);
  const session = await readSession(env, body.session);
  const access = sessionCan(session, tenantId);
  if (!access.ok) return jsonResponse(deps, { ok: false, error: access.error }, access.status, origin);

  if (path === '/api/square/connect') return handleConnect(env, tenantId, body.session, deps, origin);
  if (path === '/api/square/status') {
    const connection = await loadConnection(env, tenantId, deps);
    return jsonResponse(deps, statusView(connection), 200, origin);
  }
  if (path === '/api/square/location') return handleLocation(env, tenantId, body.locationId, deps, origin);
  if (path === '/api/square/disconnect') return handleDisconnect(env, tenantId, deps, origin);
  if (path === '/api/square/refund') return handleRefund(env, tenantId, body, deps, origin);
  return jsonResponse(deps, { ok: false, error: 'not_found' }, 404, origin);
}

function checkoutCors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function withCheckoutCors(res) {
  const headers = new Headers(res.headers);
  const cors = checkoutCors();
  for (const key of Object.keys(cors)) headers.set(key, cors[key]);
  return new Response(res.body, { status: res.status, headers });
}

async function handleConnect(env, tenantId, sessionToken, deps, origin) {
  const clientId = String((env && env.SQUARE_APPLICATION_ID) || '').trim();
  if (!clientId || !String((env && env.SQUARE_APPLICATION_SECRET) || '').trim()) {
    return jsonResponse(deps, { ok: false, error: 'square_not_configured' }, 500, origin);
  }
  if (!squareTokenKeyBytes(env && env.SQUARE_TOKEN_KEY)) {
    return jsonResponse(deps, { ok: false, error: 'square_token_key_invalid' }, 500, origin);
  }
  const state = newOauthState();
  const record = {
    state,
    tenantId,
    session: String(sessionToken || ''),
    expiresAt: Date.now() + STATE_TTL_SECONDS * 1000,
  };
  if (!env.AUTH_KV) return jsonResponse(deps, { ok: false, error: 'state_store_unavailable' }, 500, origin);
  await env.AUTH_KV.put(STATE_PREFIX + state, JSON.stringify(record), { expirationTtl: STATE_TTL_SECONDS });
  const authorizeUrl = buildAuthorizeUrl(env, state);
  if (authorizeUrl.indexOf('PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS') !== -1) {
    return jsonResponse(deps, { ok: false, error: 'scope_rejected' }, 500, origin);
  }
  return jsonResponse(deps, { ok: true, url: authorizeUrl }, 200, origin);
}

async function handleCallback(request, env, url, deps) {
  const oauthError = url.searchParams.get('error');
  if (oauthError) return portalRedirect('error', oauthError);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const record = await kvGet(env, STATE_PREFIX + state);
  const checked = validateOauthState(record, state, Date.now());
  if (!checked.ok) return portalRedirect('error', checked.reason);
  if (env.AUTH_KV) {
    try { await env.AUTH_KV.delete(STATE_PREFIX + state); } catch (_) {}
  }
  const session = await readSession(env, checked.session);
  const access = sessionCan(session, checked.tenantId);
  if (!access.ok) return portalRedirect('error', 'session');
  const keyBytes = squareTokenKeyBytes(env && env.SQUARE_TOKEN_KEY);
  if (!keyBytes) return portalRedirect('error', 'square_token_key_invalid');
  const exchanged = await exchangeToken(env, deps, {
    client_id: String(env.SQUARE_APPLICATION_ID || ''),
    client_secret: String(env.SQUARE_APPLICATION_SECRET || ''),
    code,
    grant_type: 'authorization_code',
    redirect_uri: squareRedirectUrl(env),
  });
  if (!exchanged.ok || !exchanged.data.access_token || !exchanged.data.refresh_token) {
    return portalRedirect('error', 'token_exchange');
  }
  const accessToken = exchanged.data.access_token;
  const located = await fetchLocations(env, deps, accessToken);
  if (located.error) return portalRedirect('error', located.error);
  const merchantId = String(exchanged.data.merchant_id || '');
  const accountName = await fetchAccountName(env, deps, accessToken, merchantId);
  const cipher = await encryptSquareTokens(keyBytes, {
    accessToken,
    refreshToken: exchanged.data.refresh_token,
  });
  const only = located.locations.length === 1 ? located.locations[0] : null;
  const connection = {
    merchantId,
    accountName,
    expiresAt: exchanged.data.expires_at || '',
    cipher,
    locationId: only ? only.id : '',
    locationName: only ? only.name : '',
    locations: located.locations,
  };
  await saveConnection(env, checked.tenantId, connection, deps);
  await savePublicStatus(env, checked.tenantId, publicStatusFrom(connection), deps);
  return portalRedirect(only ? 'connected' : 'location');
}

async function handleLocation(env, tenantId, locationId, deps, origin) {
  const id = String(locationId || '').trim();
  const got = await accessTokenFor(env, tenantId, deps);
  if (got.error) return jsonResponse(deps, { ok: false, error: got.error }, got.status || 409, origin);
  const match = (got.connection.locations || []).find((loc) => loc && loc.id === id);
  if (!match) return jsonResponse(deps, { ok: false, error: 'location_not_found' }, 400, origin);
  const next = Object.assign({}, got.connection, { locationId: match.id, locationName: match.name });
  await saveConnection(env, tenantId, next, deps);
  await savePublicStatus(env, tenantId, publicStatusFrom(next), deps);
  return jsonResponse(deps, statusView(next), 200, origin);
}

async function handleDisconnect(env, tenantId, deps, origin) {
  const connection = await loadConnection(env, tenantId, deps);
  if (connection && connection.cipher) {
    try {
      const got = await accessTokenFor(env, tenantId, deps);
      const token = got.token;
      if (token) {
        const hosts = squareHosts(env);
        await squareFetch(deps, hosts.connect + '/oauth2/revoke', {
          method: 'POST',
          headers: {
            Authorization: 'Client ' + String(env.SQUARE_APPLICATION_SECRET || ''),
            'Content-Type': 'application/json',
            'Square-Version': SQUARE_VERSION,
          },
          body: JSON.stringify({
            client_id: String(env.SQUARE_APPLICATION_ID || ''),
            access_token: token,
          }),
        });
      }
    } catch (_) {}
  }
  await clearConnection(env, tenantId, deps);
  await savePublicStatus(env, tenantId, publicStatusFrom(null), deps);
  return jsonResponse(deps, { ok: true, connected: false, ready: false }, 200, origin);
}

async function handleCheckout(request, env, deps) {
  const body = await readJsonBody(request);
  const tenantId = safeTenant(body.tenantId);
  const bookingIds = bookingIdsFrom(body.bookingIds || body.bookingId);
  if (!tenantId) return jsonResponse(deps, { ok: false, error: 'invalid_tenant' }, 400, '');
  if (!bookingIds.length) return jsonResponse(deps, { ok: false, error: 'invalid_booking' }, 400, '');
  if (!deps.getTenantById || !deps.firebaseAnonymousToken) {
    return jsonResponse(deps, { ok: false, error: 'square_not_configured' }, 500, '');
  }
  let tenant;
  try {
    const idToken = await deps.firebaseAnonymousToken(env);
    tenant = await deps.getTenantById(env, idToken, tenantId);
  } catch (_) {
    return jsonResponse(deps, { ok: false, error: 'tenant_lookup_failed' }, 502, '');
  }
  if (!tenant) return jsonResponse(deps, { ok: false, error: 'tenant_not_found' }, 404, '');
  const plan = deps.planName ? deps.planName(tenant) : String(tenant.plan || '');
  if (plan === 'free') return jsonResponse(deps, { ok: false, error: 'square_not_on_free' }, 400, '');
  if (tenant.squareReady !== true) return jsonResponse(deps, { ok: false, error: 'square_not_ready' }, 409, '');
  const load = deps.loadAppointments || loadPrivateAppointments;
  const appointments = await load(env, tenantId);
  const selected = bookingIds.map((id) => (appointments || []).find((b) => b && String(b.id) === id)).filter(Boolean);
  if (selected.length !== bookingIds.length) return jsonResponse(deps, { ok: false, error: 'booking_not_found' }, 404, '');
  for (const booking of selected) {
    if (String(booking.paymentMethod || '').toLowerCase() !== 'square') {
      return jsonResponse(deps, { ok: false, error: 'not_square_booking' }, 400, '');
    }
  }
  const depositOn = deps.depositOn ? deps.depositOn(tenant) : false;
  let totalCents = 0;
  let kind = 'full';
  for (const booking of selected) {
    const price = deps.bookingPrice ? deps.bookingPrice(tenant, booking) : Number(booking.amount);
    const status = String(booking.paymentStatus || '').toUpperCase();
    const wantsDeposit = depositOn && (Number(booking.depositAmount) > 0 || status.indexOf('DEPOSIT') !== -1);
    if (wantsDeposit) {
      if (booking.depositPaid === true) continue;
      const quote = deps.depositQuote ? deps.depositQuote(tenant, price) : { required: false, deposit: 0 };
      if (!quote.required) return jsonResponse(deps, { ok: false, error: 'deposit_too_small' }, 400, '');
      const cents = Math.round(Number(quote.deposit) * 100);
      if (cents < 50) return jsonResponse(deps, { ok: false, error: 'deposit_too_small' }, 400, '');
      totalCents += cents;
      kind = 'deposit';
    } else {
      if (status.indexOf('PAID') !== -1 && status.indexOf('AWAITING') === -1) continue;
      if (price === null || !Number.isFinite(Number(price))) {
        return jsonResponse(deps, { ok: false, error: 'service_has_no_price' }, 400, '');
      }
      const cents = Math.round(Number(price) * 100);
      if (cents < 50) return jsonResponse(deps, { ok: false, error: 'amount_too_small' }, 400, '');
      totalCents += cents;
    }
  }
  if (totalCents < 50) return jsonResponse(deps, { ok: true, alreadyPaid: true }, 200, '');
  const got = await accessTokenFor(env, tenantId, deps);
  if (got.error) return jsonResponse(deps, { ok: false, error: got.error }, got.status || 409, '');
  if (!got.connection.locationId) return jsonResponse(deps, { ok: false, error: 'square_location_required' }, 409, '');
  const slug = deps.slugFor ? deps.slugFor(tenant, tenantId) : tenantId;
  const redirectUrl = APP_ORIGIN + '/' + slug + '/?pay=success&kind=square&booking=' + encodeURIComponent(bookingIds[0]);
  const serviceName = String(selected[0].serviceName || 'Appointment');
  const itemName = (kind === 'deposit'
    ? (tenant.name || 'Schedi') + ' deposit — ' + serviceName
    : (tenant.name || 'Schedi') + ' — ' + serviceName).slice(0, 120);
  const linkBody = buildPaymentLinkBody({
    chargeKind: kind,
    bookingIds,
    tenantId,
    locationId: got.connection.locationId,
    amountCents: totalCents,
    currency: 'USD',
    itemName,
    description: kind === 'deposit'
      ? 'Deposit for ' + serviceName + '. The rest is collected in person.'
      : serviceName + ' at ' + (tenant.name || 'the business') + '.',
    redirectUrl,
  });
  if (Object.prototype.hasOwnProperty.call(linkBody, 'app_fee_money')) {
    return jsonResponse(deps, { ok: false, error: 'fee_rejected' }, 500, '');
  }
  const created = await squareApi(env, deps, got.token, '/v2/online-checkout/payment-links', {
    method: 'POST',
    body: JSON.stringify(linkBody),
  });
  if (!created.ok) {
    const message = (created.data && created.data.errors && created.data.errors[0] && created.data.errors[0].code) || 'checkout_failed';
    return jsonResponse(deps, { ok: false, error: message }, created.status || 502, '');
  }
  const link = created.data.payment_link || created.data;
  const payUrl = link.url || link.long_url || '';
  if (!payUrl) return jsonResponse(deps, { ok: false, error: 'checkout_url_missing' }, 502, '');
  const orderId = link.order_id || '';
  const updated = (appointments || []).map((booking) => {
    if (!booking || bookingIds.indexOf(String(booking.id)) === -1) return booking;
    return Object.assign({}, booking, {
      squareOrderId: orderId || booking.squareOrderId,
      squarePaymentLinkId: link.id || booking.squarePaymentLinkId,
    });
  });
  await stampBookings(env, deps, tenantId, updated);
  if (orderId) await rememberOrder(env, orderId, tenantId, bookingIds, kind);
  return jsonResponse(deps, { ok: true, url: payUrl, purpose: kind, amountCents: totalCents }, 200, '');
}

function clientIp(request) {
  const headers = request && request.headers;
  const raw = headers && (headers.get('CF-Connecting-IP') || headers.get('X-Real-IP'));
  return String(raw || 'unknown').slice(0, 64);
}

async function limitConfirm(request, env, deps, tenantId, hasSession) {
  const check = (deps && deps.rateLimitOk) || rateLimitOk;
  if (hasSession) return check(env && env.RL_CLIENTS, 'sqcf:' + tenantId, 30, 'sqcf');
  return check(env && env.RL_BOOKING_CREATE, 'sqcf:' + clientIp(request), 12, 'sqcf');
}

function paymentIdsFromOrder(order) {
  const ids = [];
  const push = (value) => {
    const id = String(value || '').trim();
    if (!id || ids.indexOf(id) !== -1) return;
    ids.push(id);
  };
  const tenders = Array.isArray(order && order.tenders) ? order.tenders : [];
  for (const tender of tenders) {
    if (tender && tender.payment_id) push(tender.payment_id);
  }
  const payments = Array.isArray(order && order.payments) ? order.payments : [];
  for (const payment of payments) {
    if (!payment) continue;
    if (typeof payment === 'string') push(payment);
    else push(payment.id || payment.payment_id);
  }
  if (!ids.length) {
    for (const tender of tenders) {
      if (tender && tender.id) push(tender.id);
    }
  }
  return ids;
}

async function loadSquareOrderPayment(env, deps, token, orderId) {
  const orderRes = await squareApi(env, deps, token, '/v2/orders/' + encodeURIComponent(orderId));
  if (!orderRes.ok) {
    const status = orderRes.status || 502;
    return {
      error: 'square_order_lookup_failed',
      status,
      retry: status >= 500 || status === 429,
    };
  }
  const order = (orderRes.data && orderRes.data.order) || orderRes.data || {};
  const paymentIds = paymentIdsFromOrder(order);
  if (!paymentIds.length) return { order, payment: null, paymentStatus: 'UNPAID' };
  let lastStatus = 'UNPAID';
  for (const paymentId of paymentIds.slice(0, 5)) {
    const payRes = await squareApi(env, deps, token, '/v2/payments/' + encodeURIComponent(paymentId));
    if (!payRes.ok) {
      const status = payRes.status || 502;
      if (status >= 500 || status === 429) {
        return { error: 'square_payment_lookup_failed', status, retry: true };
      }
      continue;
    }
    const payment = (payRes.data && payRes.data.payment) || payRes.data || {};
    const status = squarePaymentStatus(payment);
    if (status) lastStatus = status;
    if (status === 'COMPLETED') return { order, payment, paymentStatus: 'COMPLETED' };
  }
  return { order, payment: null, paymentStatus: lastStatus };
}

function refundNeedsFetch(booking) {
  const refundId = String((booking && booking.squareRefundId) || '').trim();
  if (!refundId) return false;
  return !refundStatusIsFinal(booking.squareRefundStatus);
}

function refundIdsFromPayment(payment) {
  const raw = payment && payment.refund_ids;
  if (!Array.isArray(raw)) return [];
  const ids = [];
  for (const item of raw) {
    const id = String(item || '').trim();
    if (!id || ids.indexOf(id) !== -1) continue;
    ids.push(id);
    if (ids.length === 5) break;
  }
  return ids;
}

async function fetchSquareRefund(env, deps, token, refundId) {
  const res = await squareApi(env, deps, token, '/v2/refunds/' + encodeURIComponent(refundId));
  if (!res.ok) {
    const status = res.status || 502;
    return {
      error: 'square_refund_lookup_failed',
      status,
      retry: status >= 500 || status === 429,
      missing: status === 404,
    };
  }
  return { refund: (res.data && res.data.refund) || res.data || {} };
}

async function persistRefundBooking(env, deps, tenantId, booking, paymentId) {
  const store = squareEventStore(env, deps || {});
  await store.saveBooking(tenantId, booking);
  await rememberRefund(env, {
    id: booking.squareRefundId,
    payment_id: paymentId || booking.squarePaymentId,
  }, tenantId, booking.id, paymentId || booking.squarePaymentId);
}

/** Apply one Square refund object. Amounts come only from that object. */
async function applyFetchedRefund(env, deps, tenantId, booking, refund) {
  const status = squareRefundStatusOf(refund);
  const paymentId = String((refund && refund.payment_id) || (booking && booking.squarePaymentId) || '');
  if (status === 'COMPLETED') {
    const applied = applySquareRefundUpdate(booking, refund);
    if (applied.changed) await persistRefundBooking(env, deps, tenantId, applied.booking, paymentId);
    return {
      booking: applied.booking,
      changed: applied.changed === true,
      refundStatus: 'COMPLETED',
    };
  }
  const recorded = recordSquareRefundProgress(booking, refund);
  if (recorded.changed) await persistRefundBooking(env, deps, tenantId, recorded.booking, paymentId);
  return {
    booking: recorded.booking,
    changed: recorded.changed === true,
    refundStatus: status || String((booking && booking.squareRefundStatus) || ''),
  };
}

async function reconcileBookingRefunds(env, deps, token, tenantId, booking, knownPayment) {
  let current = booking;
  if (refundNeedsFetch(current)) {
    const fetched = await fetchSquareRefund(env, deps, token, current.squareRefundId);
    if (fetched.error) {
      if (fetched.missing) {
        return {
          booking: current,
          checked: true,
          refundStatus: String(current.squareRefundStatus || 'PENDING').toUpperCase(),
        };
      }
      return {
        error: fetched.error,
        status: fetched.status || 502,
        requiredRefund: true,
        booking: current,
      };
    }
    const applied = await applyFetchedRefund(env, deps, tenantId, current, fetched.refund);
    return {
      booking: applied.booking,
      checked: true,
      changed: applied.changed,
      refundStatus: applied.refundStatus,
    };
  }

  const paymentId = String((current && current.squarePaymentId) || '').trim();
  if (!bookingPaidState(current) || !paymentId || String(current.squareRefundId || '').trim()) {
    return { booking: current, checked: false };
  }
  let payment = knownPayment;
  if (!payment || String(payment.id || '') !== paymentId) {
    const payRes = await squareApi(env, deps, token, '/v2/payments/' + encodeURIComponent(paymentId));
    if (!payRes.ok) return { booking: current, checked: false };
    payment = (payRes.data && payRes.data.payment) || payRes.data || {};
  }
  const ids = refundIdsFromPayment(payment);
  if (!ids.length) return { booking: current, checked: false };
  let changed = false;
  let refundStatus = '';
  for (const refundId of ids) {
    const fetched = await fetchSquareRefund(env, deps, token, refundId);
    if (fetched.error || !fetched.refund) continue;
    const applied = await applyFetchedRefund(env, deps, tenantId, current, fetched.refund);
    current = applied.booking;
    if (applied.changed) changed = true;
    if (applied.refundStatus) refundStatus = applied.refundStatus;
  }
  return { booking: current, checked: true, changed, refundStatus };
}

/**
 * Refresh one booking from Square. Payment ids and amounts come from Square.
 * A stored non-final refund is required; refund_ids on a paid booking with no
 * stored refund id are best-effort.
 */
async function reconcileSquareBooking(env, deps, tenantId, booking, context) {
  const ctx = context || {};
  const bookingIds = ctx.bookingIds && ctx.bookingIds.length
    ? ctx.bookingIds.map(String)
    : [String(booking.id)];
  const kind = ctx.kind || '';
  let current = Object.assign({}, booking);
  let payment = null;
  let squareStatus = '';
  let sawPayment = false;
  let paymentChanged = false;
  let orderError = null;

  const got = await accessTokenFor(env, tenantId, deps);
  if (got.error) {
    return {
      error: got.error,
      status: got.status || 409,
      requiredRefund: refundNeedsFetch(current),
      booking: current,
    };
  }

  const orderId = String(current.squareOrderId || '').trim();
  if (orderId) {
    const fetched = await loadSquareOrderPayment(env, deps, got.token, orderId);
    if (fetched.error) {
      orderError = fetched;
    } else {
      squareStatus = fetched.paymentStatus || '';
      if (fetched.payment) {
        payment = Object.assign({}, fetched.payment);
        if (!payment.order_id) payment.order_id = orderId;
        sawPayment = true;
        const note = parseSquarePaymentNote(payment.note) || parseSquarePaymentNote(payment.payment_note);
        const chargeKind = kind || (note && note.kind) || '';
        const applied = await applyFetchedSquarePayment(env, deps, tenantId, bookingIds, payment, chargeKind, String(booking.id));
        if (applied.error) return { error: applied.error, status: applied.status || 404, booking: current };
        if (applied.booking) current = applied.booking;
        paymentChanged = applied.changed === true;
      }
    }
  }

  if (orderError && !refundNeedsFetch(current) && !(bookingPaidState(current) && current.squarePaymentId && !current.squareRefundId)) {
    return { error: orderError.error, status: orderError.status || 502, requiredRefund: false, booking: current };
  }

  const refunds = await reconcileBookingRefunds(env, deps, got.token, tenantId, current, payment);
  if (refunds.error) return refunds;
  if (refunds.booking) current = refunds.booking;
  if (orderError && !refunds.checked) {
    return { error: orderError.error, status: orderError.status || 502, requiredRefund: false, booking: current };
  }

  const paid = bookingPaidState(current);
  const refundedNow = refunds.checked === true && String(current.paymentStatus || '').toUpperCase().indexOf('REFUND') !== -1;
  let status = 'UNPAID';
  if (refundedNow) status = 'REFUNDED';
  else if (sawPayment) status = squarePaymentStatus(payment) || 'COMPLETED';
  else if (squareStatus) status = squareStatus;
  else if (paid) status = String(current.paymentStatus || 'PAID');
  return {
    ok: true,
    paid,
    status,
    booking: current,
    paymentChanged,
    refundChecked: refunds.checked === true,
    refundStatus: refunds.refundStatus || '',
    refunded: refundedNow && refunds.changed === true,
  };
}

function pendingSquareRefund(booking) {
  return !!(booking && String(booking.squareRefundId || '').trim() && String(booking.squareRefundStatus || '').trim().toUpperCase() === 'PENDING');
}

function awaitingSquarePayment(booking, now) {
  if (!booking || !String(booking.squareOrderId || '').trim()) return false;
  if (bookingPaidState(booking)) return false;
  const status = String(booking.paymentStatus || '').toUpperCase();
  if (status.indexOf('AWAITING') === -1) return false;
  const created = Date.parse(String(booking.createdAt || ''));
  if (!Number.isFinite(created)) return false;
  const age = now - created;
  return age >= 0 && age <= AWAITING_MAX_AGE_MS;
}

function reconcileLimit(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return RECONCILE_CAP;
  return Math.min(RECONCILE_CAP, n);
}

async function tenantIdsForReconcile(env, deps) {
  if (Array.isArray(deps && deps.tenantIds)) {
    const ids = [];
    for (const item of deps.tenantIds) {
      const id = safeTenant(item);
      if (id && ids.indexOf(id) === -1) ids.push(id);
    }
    return ids;
  }
  if (!env || !env.AUTH_KV || typeof env.AUTH_KV.list !== 'function') return [];
  const ids = [];
  let cursor;
  for (let page = 0; page < 40; page += 1) {
    const listed = await env.AUTH_KV.list({ prefix: APPT_PREFIX, cursor });
    const keys = (listed && listed.keys) || [];
    for (const key of keys) {
      const name = String((key && key.name) || '');
      if (name.indexOf(APPT_PREFIX) !== 0) continue;
      const id = safeTenant(name.slice(APPT_PREFIX.length));
      if (id && ids.indexOf(id) === -1) ids.push(id);
    }
    if (!listed || listed.list_complete !== false || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return ids;
}

function rotateTenants(ids, after) {
  if (!after) return ids.slice();
  const idx = ids.indexOf(after);
  if (idx === -1) return ids.slice();
  return ids.slice(idx + 1).concat(ids.slice(0, idx + 1));
}

/** Hourly catch-up for Square payments and refunds that never received a webhook. */
export async function runSquareReconcile(env, deps) {
  deps = deps || {};
  const limit = reconcileLimit(deps.limit);
  const now = typeof deps.now === 'number' ? deps.now : Date.now();
  const ids = await tenantIdsForReconcile(env, deps);
  let after = '';
  if (env && env.AUTH_KV) {
    after = safeTenant(await env.AUTH_KV.get(RECONCILE_CURSOR_KEY));
  }
  const ordered = rotateTenants(ids, after);
  let checked = 0;
  let paid = 0;
  let refunded = 0;
  let errors = 0;
  let lastTenant = '';
  const load = (deps && deps.loadAppointments) || loadPrivateAppointments;
  for (const tenantId of ordered) {
    if (checked >= limit) break;
    lastTenant = tenantId;
    let appointments = [];
    try {
      appointments = await load(env, tenantId);
    } catch (_) {
      errors += 1;
      continue;
    }
    for (const booking of appointments || []) {
      if (checked >= limit) break;
      if (!pendingSquareRefund(booking) && !awaitingSquarePayment(booking, now)) continue;
      checked += 1;
      try {
        const result = await reconcileSquareBooking(env, deps, tenantId, booking, {
          bookingIds: [String(booking.id)],
        });
        if (result.error) {
          errors += 1;
          continue;
        }
        if (result.paymentChanged && result.paid) paid += 1;
        if (result.refunded) refunded += 1;
      } catch (_) {
        errors += 1;
      }
    }
  }
  if (lastTenant && env && env.AUTH_KV) {
    await env.AUTH_KV.put(RECONCILE_CURSOR_KEY, lastTenant);
  }
  return { ok: true, checked, paid, refunded, errors };
}

async function applyFetchedSquarePayment(env, deps, tenantId, bookingIds, payment, kind, focusId) {
  const load = (deps && deps.loadAppointments) || loadPrivateAppointments;
  const appointments = await load(env, tenantId);
  const wanted = (Array.isArray(bookingIds) ? bookingIds : []).map((id) => String(id));
  const bookings = wanted.map((id) => (appointments || []).find((item) => item && String(item.id) === id)).filter(Boolean);
  if (!bookings.length) return { error: 'booking_not_found', status: 404 };
  const store = squareEventStore(env, deps || {});
  await rememberLookup(env, payment, tenantId, bookings.map((item) => String(item.id)), kind);
  let changed = false;
  let duplicate = true;
  let paid = false;
  let focus = null;
  for (const booking of bookings) {
    const applied = applySquarePaymentUpdate(booking, payment, kind);
    if (!focusId || String(booking.id) === String(focusId)) focus = applied.booking;
    if (bookingPaidState(applied.booking)) paid = true;
    if (applied.duplicate) continue;
    duplicate = false;
    if (applied.changed) {
      changed = true;
      await store.saveBooking(tenantId, applied.booking);
    }
  }
  return { paid, changed, duplicate: duplicate && !changed, booking: focus };
}

async function handleConfirm(request, env, deps) {
  const body = await readJsonBody(request);
  const tenantId = safeTenant(body.tenantId);
  const bookingId = bookingIdsFrom(body.bookingId)[0] || '';
  if (!tenantId) return jsonResponse(deps, { ok: false, error: 'invalid_tenant', paid: false }, 400, '');
  if (!bookingId) return jsonResponse(deps, { ok: false, error: 'invalid_booking', paid: false }, 400, '');
  const sessionToken = String(body.session || '').trim();
  if (sessionToken) {
    const session = await readSession(env, sessionToken);
    const access = sessionCan(session, tenantId);
    if (!access.ok) return jsonResponse(deps, { ok: false, error: access.error, paid: false }, access.status, '');
  }
  const allowed = await limitConfirm(request, env, deps, tenantId, !!sessionToken);
  if (!allowed) return jsonResponse(deps, { ok: false, error: 'rate_limited', paid: false }, 429, '');

  const load = (deps && deps.loadAppointments) || loadPrivateAppointments;
  const appointments = await load(env, tenantId);
  const booking = (appointments || []).find((item) => item && String(item.id) === bookingId);
  if (!booking) return jsonResponse(deps, { ok: false, error: 'booking_not_found', paid: false }, 404, '');

  // Order id, payment id, and amount come from our records and from Square. Client fields are ignored.
  const reverse = await kvGet(env, bookingOrderKey(tenantId, bookingId));
  const orderId = String(booking.squareOrderId || (reverse && reverse.orderId) || '').trim();
  const mapped = orderId ? await kvGet(env, ORDER_PREFIX + orderId) : null;
  if (mapped && mapped.tenantId && String(mapped.tenantId) !== tenantId) {
    return jsonResponse(deps, { ok: false, error: 'square_order_mismatch', paid: false }, 409, '');
  }
  if (mapped && Array.isArray(mapped.bookingIds) && mapped.bookingIds.length && mapped.bookingIds.map(String).indexOf(bookingId) === -1) {
    return jsonResponse(deps, { ok: false, error: 'square_order_mismatch', paid: false }, 409, '');
  }
  const working = Object.assign({}, booking);
  if (orderId && !working.squareOrderId) working.squareOrderId = orderId;
  const refundOpen = refundNeedsFetch(working);
  const paidWithoutRefund = bookingPaidState(working) && String(working.squarePaymentId || '').trim() && !String(working.squareRefundId || '').trim();
  if (!orderId && !refundOpen && !paidWithoutRefund) {
    const paid = bookingPaidState(working);
    return jsonResponse(deps, { ok: true, paid, status: paid ? String(working.paymentStatus || 'PAID') : 'UNPAID' }, 200, '');
  }
  const bookingIds = mapped && Array.isArray(mapped.bookingIds) && mapped.bookingIds.length
    ? mapped.bookingIds.map(String)
    : [bookingId];
  const kind = (mapped && mapped.kind) || (reverse && reverse.kind) || '';
  const result = await reconcileSquareBooking(env, deps, tenantId, working, { bookingIds, kind });
  if (result.error) {
    if (bookingPaidState(booking) && result.requiredRefund !== true) {
      return jsonResponse(deps, { ok: true, paid: true, status: String(booking.paymentStatus || 'PAID') }, 200, '');
    }
    return jsonResponse(deps, {
      ok: false,
      error: result.error,
      paid: false,
      status: String(booking.paymentStatus || ''),
    }, result.status || 502, '');
  }
  const payload = {
    ok: true,
    paid: result.paid === true,
    status: result.status || 'UNPAID',
  };
  if (result.refundChecked) payload.refundStatus = result.refundStatus || '';
  return jsonResponse(deps, payload, 200, '');
}

async function handleRefund(env, tenantId, body, deps, origin) {
  const bookingId = bookingIdsFrom(body.bookingId)[0] || '';
  if (!bookingId) return jsonResponse(deps, { ok: false, error: 'invalid_booking' }, 400, origin);
  const load = deps.loadAppointments || loadPrivateAppointments;
  const appointments = await load(env, tenantId);
  const booking = (appointments || []).find((item) => item && String(item.id) === bookingId);
  if (!booking) return jsonResponse(deps, { ok: false, error: 'booking_not_found' }, 404, origin);
  if (!booking.squarePaymentId) return jsonResponse(deps, { ok: false, error: 'square_payment_missing' }, 409, origin);
  if (String(booking.squareRefundId || '').trim() && String(booking.squareRefundStatus || '').trim().toUpperCase() === 'PENDING') {
    return jsonResponse(deps, { ok: false, error: 'refund_pending' }, 409, origin);
  }
  const paidCents = Math.round(Number(booking.squareAmountCents) || 0);
  const already = Math.round(Number(booking.squareRefundedCents) || 0);
  const remaining = paidCents > 0 ? Math.max(0, paidCents - already) : 0;
  let amountCents = body.amountCents == null || body.amountCents === '' ? remaining : Math.round(Number(body.amountCents));
  if (!Number.isFinite(amountCents) || amountCents < 1) {
    return jsonResponse(deps, { ok: false, error: 'amount_missing' }, 400, origin);
  }
  if (remaining > 0 && amountCents > remaining) {
    return jsonResponse(deps, { ok: false, error: 'amount_too_large' }, 400, origin);
  }
  const got = await accessTokenFor(env, tenantId, deps);
  if (got.error) return jsonResponse(deps, { ok: false, error: got.error }, got.status || 409, origin);
  const refundBody = buildRefundBody({
    bookingId,
    paymentId: booking.squarePaymentId,
    amountCents,
    currency: booking.squareCurrency || 'USD',
  });
  const created = await squareApi(env, deps, got.token, '/v2/refunds', {
    method: 'POST',
    body: JSON.stringify(refundBody),
  });
  if (!created.ok) {
    const detail = (created.data && created.data.errors && created.data.errors[0]) || {};
    const squareDetail = detail.detail || 'Square could not refund this payment.';
    return jsonResponse(deps, {
      ok: false,
      error: detail.code || 'refund_failed',
      message: squareDetail + ' The appointment was not changed.',
    }, created.status || 502, origin);
  }
  const refund = (created.data && created.data.refund) || created.data;
  const result = applyRefundApiResult(booking, { ok: true, refund });
  if (!result.changed) {
    return jsonResponse(deps, {
      ok: true,
      pending: result.pending === true,
      bookingId,
      message: result.pending ? 'Square is still processing the refund.' : '',
    }, 200, origin);
  }
  const updated = (appointments || []).map((item) => (item && String(item.id) === bookingId ? result.booking : item));
  await stampBookings(env, deps, tenantId, updated);
  await rememberRefund(env, refund, tenantId, bookingId, booking.squarePaymentId);
  if (result.pending === true) {
    return jsonResponse(deps, {
      ok: true,
      pending: true,
      bookingId,
      refundStatus: 'PENDING',
      message: 'Square is still processing the refund.',
    }, 200, origin);
  }
  return jsonResponse(deps, { ok: true, bookingId, refundStatus: 'COMPLETED', paymentStatus: result.booking.paymentStatus }, 200, origin);
}

function squareEventStore(env, deps) {
  return {
    async seenEvent(eventId) {
      if (!env.AUTH_KV || !eventId) return false;
      const hit = await env.AUTH_KV.get(EVENT_PREFIX + eventId);
      return !!hit;
    },
    async markEvent(eventId) {
      if (!env.AUTH_KV || !eventId) return;
      await env.AUTH_KV.put(EVENT_PREFIX + eventId, '1', { expirationTtl: 7 * 24 * 60 * 60 });
    },
    async bookingsFor(tenantId, ids) {
      if (!tenantId || !ids || !ids.length) return [];
      const load = deps.loadAppointments || loadPrivateAppointments;
      const appointments = await load(env, tenantId);
      return ids.map((id) => (appointments || []).find((item) => item && String(item.id) === String(id))).filter(Boolean);
    },
    async findPaymentBooking(payment) {
      const orderId = String((payment && (payment.order_id || payment.orderId)) || '');
      const note = parseSquarePaymentNote(payment && payment.note) || parseSquarePaymentNote(payment && payment.payment_note);
      const mapped = orderId ? await kvGet(env, ORDER_PREFIX + orderId) : null;
      // The sqord: record is written by checkout. Prefer it over payment.note:
      // Square often omits payment_note on the webhook, and a buyer note must
      // not steer the payment onto a different appointment.
      if (mapped && mapped.tenantId && mapped.bookingIds && mapped.bookingIds.length) {
        const bookings = await this.bookingsFor(mapped.tenantId, mapped.bookingIds);
        if (bookings.length) {
          const kind = mapped.kind || (note && note.kind) || '';
          await rememberLookup(env, payment, mapped.tenantId, bookings.map((item) => String(item.id)), kind);
          return { tenantId: String(mapped.tenantId), bookings, kind };
        }
      }
      if (note && note.tenantId && note.bookingIds && note.bookingIds.length) {
        const bookings = await this.bookingsFor(note.tenantId, note.bookingIds);
        if (bookings.length) {
          await rememberLookup(env, payment, note.tenantId, bookings.map((item) => String(item.id)), note.kind);
          return { tenantId: note.tenantId, bookings, kind: note.kind };
        }
      }
      return null;
    },
    async reconcileCompletedOrder(orderId) {
      const mapped = await kvGet(env, ORDER_PREFIX + orderId);
      if (!mapped || !mapped.tenantId || !mapped.bookingIds || !mapped.bookingIds.length) return { ok: true, ignored: true };
      const got = await accessTokenFor(env, mapped.tenantId, deps);
      if (got.error) return { ok: true, ignored: true };
      const fetched = await loadSquareOrderPayment(env, deps, got.token, orderId);
      if (fetched.error) return { ok: false, retry: fetched.retry === true, error: fetched.error };
      if (!fetched.payment) return { ok: true, ignored: true };
      const payment = Object.assign({}, fetched.payment);
      if (!payment.order_id) payment.order_id = orderId;
      const applied = await applyFetchedSquarePayment(env, deps, mapped.tenantId, mapped.bookingIds, payment, mapped.kind || '');
      if (applied.error) return { ok: true, ignored: true };
      return { ok: true, changed: applied.changed === true, duplicate: applied.duplicate === true };
    },
    async findRefundBooking(refund) {
      const paymentId = String((refund && refund.payment_id) || '');
      const refundId = String((refund && refund.id) || '');
      let mapped = paymentId ? await kvGet(env, PAYMENT_PREFIX + paymentId) : null;
      if (!mapped || !mapped.tenantId) {
        mapped = refundId ? await kvGet(env, REFUND_PREFIX + refundId) : null;
      }
      if (!mapped || !mapped.tenantId) return null;
      const load = deps.loadAppointments || loadPrivateAppointments;
      const appointments = await load(env, mapped.tenantId);
      const bookingId = (mapped.bookingIds || [])[0];
      const booking = (appointments || []).find((item) => item && (String(item.squarePaymentId || '') === paymentId || String(item.id) === String(bookingId)));
      if (!booking) return null;
      return { tenantId: mapped.tenantId, booking };
    },
    async saveBooking(tenantId, booking) {
      const load = deps.loadAppointments || loadPrivateAppointments;
      const appointments = await load(env, tenantId);
      const next = (appointments || []).map((item) => (item && String(item.id) === String(booking.id) ? booking : item));
      if (!next.some((item) => item && String(item.id) === String(booking.id))) next.push(booking);
      await stampBookings(env, deps, tenantId, next);
    },
  };
}
