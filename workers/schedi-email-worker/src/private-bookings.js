/**
 * Private appointment store.
 * Full bookings (name, email, phone, manage token) live in Worker KV.
 * Firestore only gets slot docs with date, time, duration, status, and service name.
 * Slot writes use the Firebase Admin service account so browser rules can deny client writes.
 */
import { readSession } from './owner-auth.js';
import { isUnpaidPast } from './unpaid-digest.js';
import { adminAuthHeaders } from './firebase-admin.js';
import { applyCancellationFee, cancellationPolicyPublic } from './cancellation-fee.js';
import { proOnlyBookingError } from './entitlements.js';
import { rateLimitOk } from './rate-limit.js';
import { bookingMakesClient, upsertClientsFromBookings } from './private-clients.js';

const PRIVATE_PREFIX = 'privateAppts:';
const MAX_BOOKINGS = 800;

function firebaseConfig(env) {
  return {
    apiKey: String(env.FIREBASE_API_KEY || '').trim(),
    projectId: String(env.FIREBASE_PROJECT_ID || 'siteforge-97699').trim(),
    appId: String(env.FIREBASE_APP_ID || 'siteforge-97699').trim(),
  };
}

function tenantsCollectionUrl(env) {
  const { projectId, appId } = firebaseConfig(env);
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/artifacts/${appId}/public/data/tenants`;
}

function tenantDocUrl(env, tenantId) {
  return `${tenantsCollectionUrl(env)}/${encodeURIComponent(tenantId)}`;
}

function encodeFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeFirestoreValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const k of Object.keys(v)) {
      if (v[k] !== undefined) fields[k] = encodeFirestoreValue(v[k]);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

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
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.idToken) throw new Error('firebase_anon_auth_failed');
  return data.idToken;
}

function clip(value, max) {
  return String(value == null ? '' : value).slice(0, max);
}

function slotDocId(bookingId) {
  const raw = clip(bookingId, 80).replace(/[^A-Za-z0-9_-]/g, '_');
  return raw || 'slot';
}

export function publicSlotFromBooking(booking) {
  if (!booking || typeof booking !== 'object') return null;
  const status = clip(booking.status, 20).toLowerCase();
  const serviceName = clip(booking.serviceName, 80).replace(/@/g, '');
  let duration = Math.round(Number(booking.durationMins) || 0);
  if (!Number.isFinite(duration) || duration < 0) duration = 0;
  if (duration > 480) duration = 480;
  return {
    date: clip(booking.date, 10),
    time: clip(booking.time, 15),
    durationMins: duration,
    status: status,
    cancelled: booking.cancelled === true || status === 'cancelled' || status === 'canceled',
    serviceName: serviceName,
  };
}

const BOOKING_KEYS = [
  'id', 'tenantId', 'manageToken', 'clientName', 'clientPhone', 'clientEmail', 'serviceName',
  'date', 'time', 'paymentStatus', 'paymentMethod', 'paymentOptionLabel', 'paidMethod', 'amount', 'durationMins',
  'status', 'seriesId', 'recurrence', 'depositAmount', 'depositPaid', 'balanceDue', 'cancelled',
  'cancelledAt', 'cancelledBy', 'reminderSentAt', 'smsReminderSentAt', 'smsConfirmSentAt',
  'depositConfirmSentAt', 'notes', 'createdAt', 'walkIn',
  'depositNudgeSentAt', 'depositDayBeforeSentAt', 'depositOwnerWarnSentAt', 'depositExpiredAt',
  'payCode',
  'stripeCustomerId', 'stripePaymentMethodId',
  'cancellationFeeStatus', 'cancellationFeeReason', 'cancellationFeeAmount', 'cancellationFeeAt',
  'cancellationFeePaymentIntentId',
  'items',
];

function sanitizeRecurrence(value) {
  if (!value || typeof value !== 'object') return undefined;
  const dates = Array.isArray(value.dates) ? value.dates.map((d) => clip(d, 10)).slice(0, 52) : [];
  return {
    frequency: clip(value.frequency || 'once', 20),
    count: Math.min(52, Math.max(1, Number(value.count) || 1)),
    index: Math.max(1, Number(value.index) || 1),
    total: Math.min(52, Math.max(1, Number(value.total) || 1)),
    dates: dates,
    ...(Array.isArray(value.times) ? { times: value.times.map((t) => clip(t, 15)).slice(0, 52) } : {}),
  };
}

const MAX_ITEMS = 10;
const MAX_ITEM_QTY = 10;
const MAX_BLOCK_MINS = 480;

function sanitizeItems(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const raw of value.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== 'object') continue;
    const qty = Math.round(Number(raw.qty) || 1);
    if (!(qty >= 1)) continue;
    const item = {
      serviceId: typeof raw.serviceId === 'number' ? raw.serviceId : clip(raw.serviceId, 40),
      name: clip(raw.name, 80).replace(/@/g, ''),
      qty: Math.min(MAX_ITEM_QTY, qty),
    };
    const price = raw.price === null || raw.price === '' || raw.price === undefined ? null : Number(raw.price);
    if (price !== null && Number.isFinite(price) && price >= 0) item.price = Math.round(price * 100) / 100;
    else item.price = null;
    const dur = Math.round(Number(raw.durationMins) || 0);
    if (dur > 0) item.durationMins = Math.min(MAX_BLOCK_MINS, dur);
    out.push(item);
  }
  return out.length ? out : undefined;
}

export function catalogDurationMins(svc) {
  if (!svc) return 60;
  if (Number(svc.durationMins) > 0) return Math.round(Number(svc.durationMins));
  const str = String(svc.duration || '').toLowerCase();
  if (/^\d+(\.\d+)?$/.test(str.trim())) return Math.round(Number(str.trim()));
  const hrs = /(\d+(?:\.\d+)?)\s*(h|hr|hour)/.exec(str);
  const mins = /(\d+)\s*(m|min)/.exec(str);
  let total = 0;
  if (hrs) total += parseFloat(hrs[1]) * 60;
  if (mins) total += parseInt(mins[1], 10);
  return total > 0 ? Math.round(total) : 60;
}

function findCatalogService(tenant, item) {
  const services = Array.isArray(tenant && tenant.services) ? tenant.services : [];
  const byId = services.find((s) => s && item.serviceId !== '' && item.serviceId !== undefined && String(s.id) === String(item.serviceId));
  if (byId) return byId;
  return services.find((s) => s && s.name === item.name) || null;
}

/**
 * Multi-service bookings: rebuild every item from the business's own service list so price and
 * length cannot be set by the browser. Sets the summary serviceName / durationMins / amount that
 * older code reads. Returns '' or an error code. Bookings without items are left as they are.
 */
export function normalizeBookingItems(tenant, booking) {
  if (!booking || !Array.isArray(booking.items) || !booking.items.length) {
    if (booking) delete booking.items;
    return '';
  }
  const merged = [];
  for (const item of booking.items) {
    const svc = findCatalogService(tenant, item);
    if (!svc) return 'invalid_service';
    const prev = merged.find((m) => String(m.serviceId) === String(svc.id));
    if (prev) { prev.qty = Math.min(MAX_ITEM_QTY, prev.qty + item.qty); continue; }
    const priceRaw = svc.price;
    const priced = !(priceRaw === null || priceRaw === undefined || priceRaw === '') && Number.isFinite(Number(priceRaw)) && Number(priceRaw) >= 0;
    merged.push({
      serviceId: typeof svc.id === 'number' ? svc.id : clip(svc.id, 40),
      name: clip(svc.name, 80).replace(/@/g, ''),
      qty: item.qty,
      price: priced ? Math.round(Number(priceRaw) * 100) / 100 : null,
      durationMins: Math.min(MAX_BLOCK_MINS, catalogDurationMins(svc)),
    });
  }
  const total = merged.reduce((n, m) => n + m.durationMins * m.qty, 0);
  if (total > MAX_BLOCK_MINS) return 'too_long';
  booking.items = merged;
  booking.durationMins = Math.max(5, total);
  booking.serviceName = merged.map((m) => m.name + (m.qty > 1 ? ' ×' + m.qty : '')).join(' + ').slice(0, 160);
  if (merged.every((m) => m.price !== null)) {
    booking.amount = Math.round(merged.reduce((n, m) => n + m.price * m.qty, 0) * 100) / 100;
  } else {
    delete booking.amount;
  }
  return '';
}

// Payment code for manual payments: SCH- + 4 chars with no 0/O/1/I/L (easy to read and type).
export const PAY_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PAY_CODE_RE = /^SCH-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

export function newPayCode() {
  const buf = new Uint32Array(4);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < 4; i++) out += PAY_CODE_ALPHABET.charAt(buf[i] % PAY_CODE_ALPHABET.length);
  return 'SCH-' + out;
}

function wantsPayCode(booking) {
  if (!booking) return false;
  const method = String(booking.paymentMethod || '').toLowerCase();
  if (method === 'card') return false;
  if (Number(booking.depositAmount) > 0) return false;
  return true;
}

/**
 * Keep payment codes unique within one business and give one to any non-card booking that lacks it
 * (new bookings normally bring their own; older bookings get one the next time the list is saved).
 * Earlier bookings keep their code; a later duplicate is re-rolled.
 */
export function ensurePayCodes(appointments) {
  const seen = new Set();
  for (const b of appointments) {
    if (!b) continue;
    if (b.payCode && !seen.has(b.payCode)) { seen.add(b.payCode); continue; }
    if (b.payCode) delete b.payCode;
    if (!wantsPayCode(b)) continue;
    let code = newPayCode();
    for (let n = 0; n < 20 && seen.has(code); n++) code = newPayCode();
    b.payCode = code;
    seen.add(code);
  }
  return appointments;
}

export function sanitizeBooking(raw, tenantId) {
  if (!raw || typeof raw !== 'object') return null;
  let id = clip(raw.id, 40);
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) {
    id = clip(String(raw.id || '').replace(/[^A-Za-z0-9_-]/g, '_'), 40);
  }
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) return null;
  const out = { id: id, tenantId: clip(tenantId || raw.tenantId, 48) };
  for (const key of BOOKING_KEYS) {
    if (raw[key] === undefined || key === 'id' || key === 'tenantId') continue;
    if (key === 'recurrence') {
      const rec = sanitizeRecurrence(raw.recurrence);
      if (rec) out.recurrence = rec;
      continue;
    }
    if (key === 'items') {
      const items = sanitizeItems(raw.items);
      if (items) out.items = items;
      continue;
    }
    if (key === 'amount' || key === 'depositAmount' || key === 'balanceDue' || key === 'durationMins' || key === 'cancellationFeeAmount') {
      // null / blank amount means "no price" — omit rather than store $0.
      if (raw[key] === null || raw[key] === '') continue;
      const n = Number(raw[key]);
      if (Number.isFinite(n) && n >= 0) out[key] = Math.round(n * 100) / 100;
      continue;
    }
    if (key === 'depositPaid' || key === 'cancelled') {
      out[key] = raw[key] === true;
      continue;
    }
    if (key === 'walkIn') {
      // Owner-logged walk-in (Log Manual Appointment). Only stored when true.
      if (raw[key] === true) out[key] = true;
      continue;
    }
    if (key === 'stripeCustomerId' || key === 'stripePaymentMethodId' || key === 'cancellationFeePaymentIntentId') {
      continue;
    }
    if (key === 'cancellationFeeStatus') {
      const status = clip(raw[key], 40);
      if (status === 'outside_window' || status === 'collected' || status === 'not_collected') out[key] = status;
      continue;
    }
    if (key === 'cancellationFeeReason') {
      const reason = clip(raw[key], 40);
      if (/^[a-z_]{1,40}$/.test(reason)) out[key] = reason;
      continue;
    }
    if (key === 'payCode') {
      const code = clip(raw[key], 8).toUpperCase();
      if (PAY_CODE_RE.test(code)) out[key] = code;
      continue;
    }
    if (key === 'cancellationFeeAt') {
      const at = clip(raw[key], 40);
      if (/^\d{4}-\d{2}-\d{2}T/.test(at)) out[key] = at;
      continue;
    }
    const max = key === 'notes' ? 500 : key === 'manageToken' ? 128 : 160;
    out[key] = clip(raw[key], max);
  }
  if (out.manageToken && !/^[A-Za-z0-9_-]{16,128}$/.test(out.manageToken)) delete out.manageToken;
  return out;
}

function mergeById(primary, extra) {
  const map = new Map();
  for (const item of extra || []) {
    const clean = item && item.id ? item : null;
    if (clean) map.set(String(clean.id), clean);
  }
  for (const item of primary || []) {
    if (!item || !item.id) continue;
    const prev = map.get(String(item.id)) || {};
    map.set(String(item.id), Object.assign({}, prev, item));
  }
  return Array.from(map.values()).slice(0, MAX_BOOKINGS);
}

async function readPrivateRecord(env, tenantId) {
  if (!env.AUTH_KV) return [];
  const raw = await env.AUTH_KV.get(PRIVATE_PREFIX + tenantId);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : (Array.isArray(data.appointments) ? data.appointments : []);
  } catch (_) {
    return [];
  }
}

export async function loadPrivateAppointments(env, tenantId) {
  const id = clip(tenantId, 80);
  if (!id) return [];
  return readPrivateRecord(env, id);
}

export async function savePrivateAppointments(env, tenantId, appointments) {
  const id = clip(tenantId, 80);
  if (!id || !env.AUTH_KV) throw new Error('private_store_unavailable');
  const list = (Array.isArray(appointments) ? appointments : []).slice(0, MAX_BOOKINGS);
  await env.AUTH_KV.put(PRIVATE_PREFIX + id, JSON.stringify({ appointments: list }));
  return list;
}

async function authHeader(idToken) {
  return { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' };
}

async function deleteFirestoreField(env, idToken, tenantId, field) {
  const url = tenantDocUrl(env, tenantId) + '?updateMask.fieldPaths=' + encodeURIComponent(field);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: await adminAuthHeaders(env),
    body: JSON.stringify({ fields: {} }),
  });
  if (!res.ok && res.status !== 404) {
    const t = await res.text().catch(() => '');
    console.warn('delete field failed', res.status, t.slice(0, 180));
  }
}

async function listSlotDocs(env, idToken, tenantId) {
  const docs = [];
  let pageToken = '';
  do {
    const url = tenantDocUrl(env, tenantId) + '/slots?pageSize=200' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
    if (res.status === 404) return docs;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('list slots failed', res.status);
      return docs;
    }
    for (const doc of data.documents || []) {
      docs.push(String(doc.name || '').split('/').pop());
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return docs;
}

async function writeSlotDoc(env, idToken, tenantId, booking) {
  const slot = publicSlotFromBooking(booking);
  if (!slot || !slot.date || !slot.time) return;
  const docId = slotDocId(booking.id);
  const fields = {};
  for (const k of Object.keys(slot)) fields[k] = encodeFirestoreValue(slot[k]);
  const base = tenantDocUrl(env, tenantId) + '/slots/' + encodeURIComponent(docId);
  const headers = await adminAuthHeaders(env);
  let res = await fetch(base, { method: 'PATCH', headers, body: JSON.stringify({ fields }) });
  if (res.status === 404) {
    const parent = tenantDocUrl(env, tenantId) + '/slots?documentId=' + encodeURIComponent(docId);
    res = await fetch(parent, { method: 'POST', headers, body: JSON.stringify({ fields }) });
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.warn('slot write failed', res.status, t.slice(0, 180));
  }
}

async function cancelSlotDoc(env, idToken, tenantId, docId) {
  const fields = {
    cancelled: encodeFirestoreValue(true),
    status: encodeFirestoreValue('cancelled'),
  };
  const url = tenantDocUrl(env, tenantId) + '/slots/' + encodeURIComponent(docId) + '?updateMask.fieldPaths=cancelled&updateMask.fieldPaths=status';
  await fetch(url, { method: 'PATCH', headers: await adminAuthHeaders(env), body: JSON.stringify({ fields }) });
}


async function deleteSlotDoc(env, tenantId, docId) {
  const url = tenantDocUrl(env, tenantId) + '/slots/' + encodeURIComponent(docId);
  const res = await fetch(url, { method: 'DELETE', headers: await adminAuthHeaders(env) });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    console.warn('slot delete failed', res.status, body.slice(0, 180));
  }
}

async function deleteReminderDoc(env, tenantId, bookingId) {
  const cfg = firebaseConfig(env);
  const projectId = String((cfg && cfg.projectId) || (env && env.FIREBASE_PROJECT_ID) || '').trim();
  const appId = String((cfg && cfg.appId) || (env && (env.FIREBASE_APP_ID || env.FIREBASE_PROJECT_ID)) || projectId).trim();
  if (!projectId || !appId || !tenantId || !bookingId) return;
  const docId = (String(tenantId) + '__' + String(bookingId)).replace(/[^a-zA-Z0-9_-]/g, '_');
  const url = 'https://firestore.googleapis.com/v1/projects/' + projectId
    + '/databases/(default)/documents/artifacts/' + appId
    + '/public/data/bookingReminders/' + encodeURIComponent(docId);
  const res = await fetch(url, { method: 'DELETE', headers: await adminAuthHeaders(env) });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    console.warn('reminder delete failed', res.status, body.slice(0, 180));
  }
}

export async function syncPublicSlots(env, idToken, tenantId, appointments) {
  const list = Array.isArray(appointments) ? appointments : [];
  const keep = new Set();
  for (const booking of list) {
    if (!booking || !booking.id) continue;
    keep.add(slotDocId(booking.id));
    await writeSlotDoc(env, idToken, tenantId, booking);
  }
  const existing = await listSlotDocs(env, idToken, tenantId);
  for (const docId of existing) {
    if (!keep.has(docId)) await cancelSlotDoc(env, idToken, tenantId, docId);
  }
}

const FEE_KEEP_KEYS = [
  'cancellationFeeStatus', 'cancellationFeeReason', 'cancellationFeeAmount',
  'cancellationFeeAt', 'cancellationFeePaymentIntentId',
];

function validServerId(value, kind) {
  const s = String(value || '').trim();
  if (kind === 'cus' && /^cus_[A-Za-z0-9]+$/.test(s)) return s;
  if (kind === 'pm' && /^pm_[A-Za-z0-9]+$/.test(s)) return s;
  if (kind === 'pi' && /^pi_[A-Za-z0-9]+$/.test(s)) return s;
  return '';
}

function bookingForClient(booking) {
  if (!booking || typeof booking !== 'object') return booking;
  const copy = Object.assign({}, booking);
  delete copy.stripeCustomerId;
  delete copy.stripePaymentMethodId;
  delete copy.cancellationFeePaymentIntentId;
  return copy;
}

const DEPOSIT_STAMP_KEYS = ['depositNudgeSentAt', 'depositDayBeforeSentAt', 'depositOwnerWarnSentAt', 'depositExpiredAt'];

function applyServerOnlyFields(booking, prev, options) {
  const trustFee = !!(options && options.trustFee);
  const card = options && options.cards ? options.cards[String(booking.id)] : null;
  delete booking.stripeCustomerId;
  delete booking.stripePaymentMethodId;
  delete booking.cancellationFeePaymentIntentId;
  if (!trustFee) {
    if (prev && prev.cancellationFeeStatus) {
      for (const key of FEE_KEEP_KEYS) {
        if (prev[key] !== undefined && prev[key] !== '') booking[key] = prev[key];
        else delete booking[key];
      }
    } else {
      for (const key of FEE_KEEP_KEYS) delete booking[key];
    }
  } else if (booking.cancellationFeePaymentIntentId) {
    delete booking.cancellationFeePaymentIntentId;
  }
  if (trustFee && prev && prev.cancellationFeePaymentIntentId && !booking.cancellationFeePaymentIntentId) {
    const pi = validServerId(prev.cancellationFeePaymentIntentId, 'pi');
    if (pi) booking.cancellationFeePaymentIntentId = pi;
  }
  // Deposit follow-up stamps are server-owned: keep them even if a stale client copy omits them,
  // and never let a stale copy "un-release" a slot the cron already released for non-payment.
  // A payment code never changes once issued (the client already has it in their note/email).
  if (prev && prev.payCode) booking.payCode = prev.payCode;
  if (prev) {
    for (const key of DEPOSIT_STAMP_KEYS) {
      if (prev[key] && !booking[key]) booking[key] = prev[key];
    }
    if (prev.depositExpiredAt && booking.depositPaid !== true) {
      booking.status = 'cancelled';
      booking.cancelled = true;
      if (prev.cancelledAt) booking.cancelledAt = prev.cancelledAt;
      if (prev.cancelledBy) booking.cancelledBy = prev.cancelledBy;
    }
  }
  if (prev && prev.stripeCustomerId) {
    const customer = validServerId(prev.stripeCustomerId, 'cus');
    if (customer) booking.stripeCustomerId = customer;
  }
  if (prev && prev.stripePaymentMethodId) {
    const method = validServerId(prev.stripePaymentMethodId, 'pm');
    if (method) booking.stripePaymentMethodId = method;
  }
  if (!booking.stripeCustomerId && card) {
    const customer = validServerId(card.stripeCustomerId, 'cus');
    if (customer) booking.stripeCustomerId = customer;
  }
  if (!booking.stripePaymentMethodId && card) {
    const method = validServerId(card.stripePaymentMethodId, 'pm');
    if (method) booking.stripePaymentMethodId = method;
  }
  if (trustFee) {
    const pi = validServerId(options && options.feePaymentIntentId, 'pi');
    if (pi && String(options.feeBookingId || '') === String(booking.id)) {
      booking.cancellationFeePaymentIntentId = pi;
    }
  }
  return booking;
}

export async function persistTenantAppointments(env, idToken, tenantId, appointments, options) {
  const token = idToken || await firebaseAnonymousToken(env);
  const previous = await loadPrivateAppointments(env, tenantId);
  const prevById = new Map();
  for (const item of previous) {
    if (item && item.id) prevById.set(String(item.id), item);
  }
  const clean = (appointments || []).map((item) => {
    const booking = sanitizeBooking(item, tenantId);
    if (!booking) return null;
    return applyServerOnlyFields(booking, prevById.get(String(booking.id)), options);
  }).filter(Boolean);
  // Existing codes win over newcomers: order by createdAt so a re-rolled duplicate is always the newer booking.
  ensurePayCodes(clean.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))));
  await savePrivateAppointments(env, tenantId, clean);
  await syncPublicSlots(env, token, tenantId, clean);
  await addClientsForNewlyConfirmed(env, tenantId, clean, prevById);
  return clean;
}

/**
 * Owner Clients list: bookings that just became accepted/confirmed (new auto-confirmed or manual
 * bookings, owner accepts, deposit paid, accepted reschedules) are upserted into privateClients.
 * Never blocks or fails the booking save. Never contacts the client.
 */
async function addClientsForNewlyConfirmed(env, tenantId, saved, prevById) {
  try {
    const fresh = (saved || []).filter((b) => {
      if (!bookingMakesClient(b)) return false;
      const prev = prevById.get(String(b.id));
      if (!prev || !bookingMakesClient(prev)) return true;
      return String(prev.date || '') !== String(b.date || '') || String(prev.time || '') !== String(b.time || '');
    });
    if (fresh.length) await upsertClientsFromBookings(env, tenantId, fresh);
  } catch (err) {
    console.warn('booking->clients upsert failed', err && err.message ? err.message : err);
  }
}

export async function hydrateTenantBookings(env, idToken, tenant) {
  if (!tenant || !tenant.id) return tenant;
  const hadField = Object.prototype.hasOwnProperty.call(tenant, 'appointments');
  const legacy = hadField && Array.isArray(tenant.appointments) ? tenant.appointments : [];
  let stored = await loadPrivateAppointments(env, tenant.id);
  if (hadField) {
    const legacyClean = legacy.map((item) => sanitizeBooking(item, tenant.id)).filter(Boolean);
    const merged = mergeById(stored, legacyClean);
    await savePrivateAppointments(env, tenant.id, merged);
    await syncPublicSlots(env, idToken, tenant.id, merged);
    await deleteFirestoreField(env, idToken, tenant.id, 'appointments');
    delete tenant.appointments;
    stored = merged;
  }
  tenant.appointments = stored || [];
  return tenant;
}

function toMinutes(label) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*$/i.exec(String(label || ''));
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

function isCancelled(booking) {
  if (!booking) return false;
  if (booking.cancelled === true) return true;
  const status = String(booking.status || '').toLowerCase();
  return status === 'cancelled' || status === 'canceled';
}

function releasesSlot(booking) {
  if (!booking) return true;
  if (booking.cancelled === true) return true;
  const status = String(booking.status || '').toLowerCase();
  return status === 'cancelled' || status === 'canceled' || status === 'denied';
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd + 15 && bStart < aEnd + 15;
}

function slotTaken(existing, booking, ignoreId) {
  const start = toMinutes(booking.time);
  if (start === null || !booking.date) return false;
  const dur = Number(booking.durationMins) > 0 ? Math.round(Number(booking.durationMins)) : 60;
  const end = start + dur;
  return (existing || []).some((other) => {
    if (!other || releasesSlot(other)) return false;
    if (ignoreId && other.id === ignoreId) return false;
    if (other.date !== booking.date) return false;
    const tStart = toMinutes(other.time);
    if (tStart === null) return false;
    const tDur = Number(other.durationMins) > 0 ? Math.round(Number(other.durationMins)) : 60;
    return overlaps(start, end, tStart, tStart + tDur);
  });
}

function randomToken() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomBookingId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return 'BK-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function sessionCanAccess(env, sessionToken, tenantId) {
  const session = await readSession(env, sessionToken);
  if (!session) return null;
  if (session.role === 'agency') return session;
  if (session.role === 'owner' && session.tenantId === tenantId) return session;
  return null;
}

function bookingCors(origin, isAllowedOrigin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
  if (!origin || origin === 'null') headers['Access-Control-Allow-Origin'] = '*';
  else if (isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  } else headers['Access-Control-Allow-Origin'] = 'https://schedi.app';
  return headers;
}

function respond(json, body, status, origin, isAllowedOrigin) {
  const res = json(body, status, origin);
  const headers = new Headers(res.headers);
  const cors = bookingCors(origin, isAllowedOrigin);
  for (const k of Object.keys(cors)) headers.set(k, cors[k]);
  return new Response(res.body, { status: res.status, headers });
}

async function findTenantBySlug(env, idToken, slug, getTenantById, listAllTenants) {
  const direct = await getTenantById(env, idToken, slug);
  if (direct) return direct;
  const tenants = await listAllTenants(env, idToken);
  const want = String(slug || '').toLowerCase();
  return tenants.find((t) => String(t.slug || t.id || '').toLowerCase() === want) || null;
}

async function deleteCollection(env, idToken, collectionUrl) {
  const headers = await adminAuthHeaders(env);
  let removed = 0;
  let pageToken = '';
  do {
    const url = collectionUrl + '?pageSize=100' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(url, { headers: { Authorization: headers.Authorization } });
    if (!res.ok) break;
    const data = await res.json().catch(() => ({}));
    for (const doc of data.documents || []) {
      if (!doc.name) continue;
      const del = await fetch('https://firestore.googleapis.com/v1/' + doc.name, {
        method: 'DELETE',
        headers: { Authorization: headers.Authorization },
      });
      if (del.ok || del.status === 404) removed += 1;
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return removed;
}

export async function migratePrivateBookings(env, deps) {
  const idToken = await firebaseAnonymousToken(env);
  const tenants = await deps.listAllTenants(env, idToken);
  let moved = 0;
  for (const tenant of tenants) {
    if (!tenant || !tenant.id) continue;
    const before = Object.prototype.hasOwnProperty.call(tenant, 'appointments');
    await hydrateTenantBookings(env, idToken, tenant);
    if (before) moved += 1;
    else await syncPublicSlots(env, idToken, tenant.id, tenant.appointments || []);
  }
  const { projectId, appId } = firebaseConfig(env);
  const root = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const mailRemoved = await deleteCollection(env, idToken, root + `/artifacts/${appId}/public/data/mail`);
  const topMailRemoved = await deleteCollection(env, idToken, root + '/mail');
  return { ok: true, tenants: tenants.length, stripped: moved, mailRemoved: mailRemoved + topMailRemoved };
}

function runOwnerCancelNotify(deps, env, tenant, bookings, ctx) {
  if (typeof deps.notifyOwnerOfCancellations !== 'function') return Promise.resolve();
  const list = (bookings || []).filter(Boolean);
  if (!list.length) return Promise.resolve();
  const task = Promise.resolve()
    .then(() => deps.notifyOwnerOfCancellations(env, tenant, list))
    .catch((err) => {
      console.warn('owner-cancel batch failed', err && err.message ? err.message : err);
    });
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(task);
    return Promise.resolve();
  }
  return task;
}

export async function handlePrivateBookingHttp(request, env, origin, path, deps, ctx) {
  const { json, isAllowedOrigin } = deps;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: bookingCors(origin, isAllowedOrigin) });
  }
  const url = new URL(request.url);

  if (request.method === 'GET' && path === '/api/manage') {
    const slug = clip(url.searchParams.get('slug') || '', 48).toLowerCase();
    const token = clip(url.searchParams.get('token') || '', 128);
    if (!slug || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
      return respond(json, { ok: false, error: 'not_found' }, 404, origin, isAllowedOrigin);
    }
    const idToken = await firebaseAnonymousToken(env);
    const tenant = await findTenantBySlug(env, idToken, slug, deps.getTenantById, deps.listAllTenants);
    if (!tenant) return respond(json, { ok: false, error: 'not_found' }, 404, origin, isAllowedOrigin);
    const appt = (tenant.appointments || []).find((a) => a && String(a.manageToken || '') === token) || null;
    if (!appt) return respond(json, { ok: false, error: 'not_found' }, 404, origin, isAllowedOrigin);
    const slots = (tenant.appointments || []).map(publicSlotFromBooking).filter(Boolean);
    return respond(json, {
      ok: true,
      businessName: clip(tenant.name, 120),
      appointment: bookingForClient(appt),
      slots: slots,
      cancellationPolicy: cancellationPolicyPublic(tenant),
    }, 200, origin, isAllowedOrigin);
  }

  if (request.method !== 'POST' || path !== '/api/bookings') {
    return respond(json, { ok: false, error: 'not_found' }, 404, origin, isAllowedOrigin);
  }

  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const action = clip(body.action, 20);

  if (action === 'migrate') {
    // One-off maintenance (rewrites every tenant's store and clears old mail collections): agency only.
    const migrator = await readSession(env, body.session);
    if (!migrator || migrator.role !== 'agency') {
      return respond(json, { ok: false, error: 'forbidden' }, 403, origin, isAllowedOrigin);
    }
    try {
      const result = await migratePrivateBookings(env, deps);
      return respond(json, result, 200, origin, isAllowedOrigin);
    } catch (err) {
      return respond(json, { ok: false, error: 'migrate_failed' }, 500, origin, isAllowedOrigin);
    }
  }

  if (action === 'list') {
    const session = await readSession(env, body.session);
    if (!session) return respond(json, { ok: false, error: 'session_required' }, 401, origin, isAllowedOrigin);
    const idToken = await firebaseAnonymousToken(env);
    const tenants = await deps.listAllTenants(env, idToken);
    const visible = tenants.filter((t) => session.role === 'agency' || (session.role === 'owner' && t.id === session.tenantId));
    return respond(json, {
      ok: true,
      tenants: visible.map((t) => ({
        id: t.id,
        appointments: (t.appointments || []).map(bookingForClient),
      })),
    }, 200, origin, isAllowedOrigin);
  }

  if (action === 'counts') {
    const session = await readSession(env, body.session);
    if (!session) return respond(json, { ok: false, error: 'session_required' }, 401, origin, isAllowedOrigin);
    if (session.role !== 'agency') {
      return respond(json, { ok: false, error: 'forbidden' }, 403, origin, isAllowedOrigin);
    }
    const idToken = await firebaseAnonymousToken(env);
    const tenants = await deps.listAllTenants(env, idToken);
    const counts = {};
    // HQ directory health (agency only): bookings this month, unpaid past visits, last booking date.
    const health = {};
    for (const t of tenants) {
      if (!t || !t.id) continue;
      const appts = Array.isArray(t.appointments) ? t.appointments : [];
      let today = new Date().toISOString().slice(0, 10);
      try {
        today = new Intl.DateTimeFormat('en-CA', { timeZone: t.timezone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      } catch (_) {}
      const month = today.slice(0, 7);
      let n = 0, inMonth = 0, unpaid = 0, last = '';
      for (const a of appts) {
        if (!a) continue;
        if (!releasesSlot(a)) {
          n += 1;
          if (String(a.date || '').slice(0, 7) === month) inMonth += 1;
        }
        if (isUnpaidPast(a, today)) unpaid += 1;
        const made = String(a.createdAt || a.date || '').slice(0, 10);
        if (made && made > last) last = made;
      }
      counts[String(t.id)] = n;
      health[String(t.id)] = { month: inMonth, unpaid: unpaid, lastBooking: last };
    }
    return respond(json, { ok: true, counts: counts, health: health }, 200, origin, isAllowedOrigin);
  }

  if (action === 'sync') {
    const tenantId = clip(body.tenantId, 48);
    const session = await sessionCanAccess(env, body.session, tenantId);
    if (!session) return respond(json, { ok: false, error: 'forbidden' }, 403, origin, isAllowedOrigin);
    const clean = (Array.isArray(body.appointments) ? body.appointments : []).map((item) => sanitizeBooking(item, tenantId)).filter(Boolean);
    const idToken = await firebaseAnonymousToken(env);
    let before = [];
    try { before = await loadPrivateAppointments(env, tenantId); } catch (_) { before = []; }
    const saved = await persistTenantAppointments(env, idToken, tenantId, clean);
    // Owner/agency cancelled from the portal: alert the owner once per booking (gated in owner-notify).
    try {
      const wasLive = new Set((before || []).filter((a) => a && a.id && !isCancelled(a)).map((a) => String(a.id)));
      const newlyCancelled = (saved || []).filter((a) => a && a.id && wasLive.has(String(a.id)) && isCancelled(a))
        .map((a) => Object.assign({}, a, { cancelledBy: a.cancelledBy === 'client' ? 'client' : 'owner' }));
      if (newlyCancelled.length) {
        let tenant = null;
        try { tenant = await deps.getTenantById(env, idToken, tenantId); } catch (_) { tenant = null; }
        if (tenant) await runOwnerCancelNotify(deps, env, tenant, newlyCancelled, ctx);
      }
    } catch (errN) {
      console.warn('owner-cancel sync diff failed', errN && errN.message ? errN.message : errN);
    }
    return respond(json, { ok: true, count: clean.length }, 200, origin, isAllowedOrigin);
  }

  if (action === 'client') {
    const slug = clip(body.slug, 48).toLowerCase();
    const token = clip(body.token, 128);
    if (!slug || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
      return respond(json, { ok: false, error: 'not_found' }, 404, origin, isAllowedOrigin);
    }
    const idToken = await firebaseAnonymousToken(env);
    const tenant = await findTenantBySlug(env, idToken, slug, deps.getTenantById, deps.listAllTenants);
    if (!tenant) return respond(json, { ok: false, error: 'not_found' }, 404, origin, isAllowedOrigin);
    const appts = (tenant.appointments || []).slice();
    const idx = appts.findIndex((a) => a && String(a.manageToken || '') === token);
    if (idx < 0) return respond(json, { ok: false, error: 'not_found' }, 404, origin, isAllowedOrigin);
    const next = Object.assign({}, appts[idx]);
    let clientWasCancelled = false;
    if (body.cancel === true) {
      const already = next.cancelled === true || String(next.status || '').toLowerCase() === 'cancelled' || String(next.status || '').toLowerCase() === 'canceled';
      clientWasCancelled = already;
      if (!already) {
        let feePatch = {};
        try {
          if (typeof deps.applyCancellationFee === 'function') {
            feePatch = await deps.applyCancellationFee(env, tenant, next) || {};
          }
        } catch (_) {
          feePatch = {
            cancellationFeeStatus: 'not_collected',
            cancellationFeeReason: 'charge_failed',
            cancellationFeeAt: new Date().toISOString(),
          };
        }
        next.cancelled = true;
        next.status = 'cancelled';
        next.cancelledAt = new Date().toISOString();
        next.cancelledBy = 'client';
        if (feePatch && typeof feePatch === 'object') Object.assign(next, feePatch);
      }
    } else if (body.date || body.time) {
      const proposed = Object.assign({}, next, {
        date: body.date ? clip(body.date, 10) : next.date,
        time: body.time ? clip(body.time, 15) : next.time,
      });
      if (slotTaken(appts, proposed, next.id)) {
        return respond(json, { ok: false, error: 'slot_taken' }, 409, origin, isAllowedOrigin);
      }
      next.date = proposed.date;
      next.time = proposed.time;
    } else {
      return respond(json, { ok: false, error: 'no_change' }, 400, origin, isAllowedOrigin);
    }
    appts[idx] = next;
    const feePi = validServerId(next.cancellationFeePaymentIntentId, 'pi');
    delete next.cancellationFeePaymentIntentId;
    await persistTenantAppointments(env, idToken, tenant.id, appts, {
      trustFee: body.cancel === true,
      feeBookingId: next.id,
      feePaymentIntentId: feePi,
    });
    const saved = (await loadPrivateAppointments(env, tenant.id)).find((a) => a && a.id === next.id) || next;
    if (body.cancel === true && !clientWasCancelled && isCancelled(saved)) {
      try {
        await runOwnerCancelNotify(deps, env, tenant, [Object.assign({}, saved, { cancelledBy: 'client' })], ctx);
      } catch (_) {}
    }
    return respond(json, {
      ok: true,
      appointment: bookingForClient(saved),
      cancellationFee: saved.cancellationFeeStatus ? {
        status: saved.cancellationFeeStatus,
        amount: Number(saved.cancellationFeeAmount) || 0,
        reason: saved.cancellationFeeReason || '',
      } : null,
    }, 200, origin, isAllowedOrigin);
  }


  if (action === 'delete') {
    const tenantId = clip(body.tenantId, 48);
    const bookingId = clip(body.bookingId, 40);
    const session = await sessionCanAccess(env, body.session, tenantId);
    if (!session) return respond(json, { ok: false, error: 'forbidden' }, 403, origin, isAllowedOrigin);
    if (!tenantId || !bookingId) {
      return respond(json, { ok: false, error: 'invalid_booking' }, 400, origin, isAllowedOrigin);
    }
    const idToken = await firebaseAnonymousToken(env);
    const existing = await loadPrivateAppointments(env, tenantId);
    const next = (existing || []).filter((a) => !(a && String(a.id) === String(bookingId)));
    if (next.length === (existing || []).length) {
      return respond(json, { ok: false, error: 'not_found' }, 404, origin, isAllowedOrigin);
    }
    await persistTenantAppointments(env, idToken, tenantId, next);
    try { await deleteSlotDoc(env, tenantId, slotDocId(bookingId)); } catch (errSlot) {
      console.warn('delete slot cleanup', errSlot && errSlot.message ? errSlot.message : errSlot);
    }
    try { await deleteReminderDoc(env, tenantId, bookingId); } catch (errRem) {
      console.warn('delete reminder cleanup', errRem && errRem.message ? errRem.message : errRem);
    }
    return respond(json, { ok: true, deleted: bookingId, count: next.length }, 200, origin, isAllowedOrigin);
  }

  if (action === 'create') {
    const createIp = String(request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 64);
    if (!(await rateLimitOk(env.RL_BOOKING_CREATE, 'ip:' + createIp, 12, 'create'))) {
      return respond(json, { ok: false, error: 'rate_limited' }, 429, origin, isAllowedOrigin);
    }
    const tenantId = clip(body.tenantId, 48);
    if (!tenantId) return respond(json, { ok: false, error: 'invalid_tenant' }, 400, origin, isAllowedOrigin);
    // A repeating series is at most 12 visits. Refuse a bigger one instead of quietly dropping visits.
    if (Array.isArray(body.bookings) && body.bookings.length > 12) {
      return respond(json, { ok: false, error: 'too_many_visits' }, 400, origin, isAllowedOrigin);
    }
    const incoming = Array.isArray(body.bookings) ? body.bookings.slice(0, 12) : [];
    if (!incoming.length) return respond(json, { ok: false, error: 'invalid_booking' }, 400, origin, isAllowedOrigin);
    const idToken = await firebaseAnonymousToken(env);
    const tenant = await deps.getTenantById(env, idToken, tenantId);
    if (!tenant) return respond(json, { ok: false, error: 'tenant_not_found' }, 404, origin, isAllowedOrigin);
    const existing = (tenant.appointments || []).slice();
    const created = [];
    for (const raw of incoming) {
      const booking = sanitizeBooking(Object.assign({}, raw, {
        id: raw && raw.id ? raw.id : randomBookingId(),
        manageToken: raw && raw.manageToken ? raw.manageToken : randomToken(),
      }), tenant.id);
      if (!booking) return respond(json, { ok: false, error: 'invalid_booking' }, 400, origin, isAllowedOrigin);
      if (!booking.clientName || !booking.clientEmail || !booking.date || !booking.time) {
        return respond(json, { ok: false, error: 'invalid_booking' }, 400, origin, isAllowedOrigin);
      }
      // Online bookings must carry a real email: it's where the confirmation, pay link and manage link go.
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(booking.clientEmail).trim())) {
        return respond(json, { ok: false, error: 'email_required' }, 400, origin, isAllowedOrigin);
      }
      const itemsErr = normalizeBookingItems(tenant, booking);
      if (itemsErr) return respond(json, { ok: false, error: itemsErr }, 400, origin, isAllowedOrigin);
      const planErr = proOnlyBookingError(tenant, booking);
      if (planErr) return respond(json, { ok: false, error: planErr }, 403, origin, isAllowedOrigin);
      if (existing.some((a) => a && a.id === booking.id) || created.some((a) => a.id === booking.id)) {
        return respond(json, { ok: false, error: 'duplicate_booking' }, 409, origin, isAllowedOrigin);
      }
      const withNew = existing.concat(created);
      if (slotTaken(withNew, booking)) {
        return respond(json, { ok: false, error: 'slot_taken' }, 409, origin, isAllowedOrigin);
      }
      created.push(booking);
    }
    const saved = existing.concat(created);
    await persistTenantAppointments(env, idToken, tenant.id, saved);
    if (typeof deps.notifyOwnerOfNewBookings === 'function') {
      const notifyTask = Promise.resolve()
        .then(() => deps.notifyOwnerOfNewBookings(env, tenant, created))
        .catch((err) => {
          console.warn('owner-notify batch failed', err && err.message ? err.message : err);
        });
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(notifyTask);
      else await notifyTask.catch(() => {});
    }
    return respond(json, { ok: true, bookings: created }, 200, origin, isAllowedOrigin);
  }

  return respond(json, { ok: false, error: 'not_found' }, 404, origin, isAllowedOrigin);
}
