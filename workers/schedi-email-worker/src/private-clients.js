/**
 * Owner client list (Business Portal "Clients" tab + CSV import).
 *
 * Storage: Worker KV only (AUTH_KV key "privateClients:{tenantId}"). Never written to Firestore,
 * never returned without an owner (or agency) session for that tenant.
 * This module never sends email or SMS. Imported clients are not contacted.
 *
 * POST /api/clients  { action, session, tenantId, ... }
 *   list    -> { ok, clients }
 *   import  -> { rows: [{name, firstName, lastName, email, phone, notes, row}] }  (max 2000 rows)
 *              -> { ok, added, skipped: [{row, reason}], errors: [{row, reason}], total }
 *   add     -> { client: {...} }  -> { ok, client } | { ok:false, error:'duplicate' }
 *   delete  -> { clientId }
 *
 * Bookings: upsertClientsFromBookings() is called server-side whenever bookings are saved
 * (private-bookings.js persistTenantAppointments) for bookings that just became accepted/confirmed,
 * and once by the clients backfill cron. Adds source:'booking' + firstBookingDate. Never contacts anyone.
 */
import { readSession } from './owner-auth.js';
import { rateLimitOk } from './rate-limit.js';

const PREFIX = 'privateClients:';
export const MAX_CLIENTS = 5000;
export const MAX_IMPORT_ROWS = 2000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const EMAIL_RE = /^[^\s@<>()[\],;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function clip(value, max) {
  return String(value == null ? '' : value).slice(0, max);
}

function cleanText(value, max) {
  // Strip control characters, collapse whitespace; leading = + - @ are kept as text (never exported as formulas).
  return clip(String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(), max);
}

export function normEmail(value) {
  return cleanText(value, 254).toLowerCase();
}

export function phoneKey(value) {
  let d = String(value == null ? '' : value).replace(/[^0-9]/g, '');
  if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
  return d;
}

export function sanitizeClientInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_row' };
  let name = cleanText(raw.name, 120);
  if (!name) name = cleanText([cleanText(raw.firstName, 60), cleanText(raw.lastName, 60)].filter(Boolean).join(' '), 120);
  const email = normEmail(raw.email);
  const phoneRaw = cleanText(raw.phone, 40);
  const pk = phoneKey(phoneRaw);
  const notes = cleanText(raw.notes, 500);
  if (!name && !email && !phoneRaw) return { error: 'empty_row' };
  if (!name) return { error: 'missing_name' };
  if (email && !EMAIL_RE.test(email)) return { error: 'invalid_email' };
  if (phoneRaw && (pk.length < 7 || pk.length > 15)) return { error: 'invalid_phone' };
  if (!email && !phoneRaw) return { error: 'missing_contact' };
  return { client: { name, email, phone: phoneRaw, notes } };
}

function randomId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return 'cl_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function loadClients(env, tenantId) {
  if (!env.AUTH_KV) return [];
  const raw = await env.AUTH_KV.get(PREFIX + tenantId);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data && data.clients) ? data.clients : [];
  } catch (_) {
    return [];
  }
}

async function saveClients(env, tenantId, clients) {
  if (!env.AUTH_KV) throw new Error('private_store_unavailable');
  await env.AUTH_KV.put(PREFIX + tenantId, JSON.stringify({ clients: clients.slice(0, MAX_CLIENTS), updatedAt: new Date().toISOString() }));
}

function clientForOwner(c) {
  return {
    id: clip(c.id, 40),
    name: clip(c.name, 120),
    email: clip(c.email, 254),
    phone: clip(c.phone, 40),
    notes: clip(c.notes, 500),
    source: clip(c.source, 10),
    firstBookingDate: clip(c.firstBookingDate, 10),
    createdAt: clip(c.createdAt, 30),
  };
}

/**
 * True when a booking counts as a real client visit: accepted, confirmed (no status / auto-confirmed /
 * manual), or completed. Pending, denied, cancelled, and card-deposit bookings still waiting on the
 * deposit are excluded.
 */
export function bookingMakesClient(b) {
  if (!b || typeof b !== 'object') return false;
  if (b.cancelled === true) return false;
  const status = String(b.status || '').toLowerCase().trim();
  if (status === 'pending' || status === 'denied' || status === 'cancelled' || status === 'canceled' || status === 'declined' || status === 'rejected' || status === 'no_show' || status === 'noshow') return false;
  if (status && status !== 'accepted' && status !== 'confirmed' && status !== 'completed' && status !== 'complete' && status !== 'booked') return false;
  if (Number(b.depositAmount) > 0 && b.depositPaid !== true) return false;
  return true;
}

/**
 * Upsert clients from bookings into privateClients:{tenantId}.
 * Dedupe by normalized email or phone against saved clients (and within the batch).
 * Existing clients are never overwritten: only a blank email or phone is filled in, and only when
 * that value does not already belong to another saved client. Respects MAX_CLIENTS.
 * Returns { added, filled, skipped, capped, total }.
 */
export async function upsertClientsFromBookings(env, tenantId, bookings) {
  const id = clip(tenantId, 80);
  const out = { added: 0, filled: 0, skipped: 0, capped: 0, invalid: 0, total: 0 };
  if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || !env || !env.AUTH_KV) return out;
  const list = (Array.isArray(bookings) ? bookings : []).filter(bookingMakesClient);
  if (!list.length) return out;
  // Oldest first so firstBookingDate is the earliest visit and series collapse to one client.
  list.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.time || '').localeCompare(String(b.time || '')));
  const clients = await loadClients(env, id);
  const byEmail = new Map();
  const byPhone = new Map();
  for (const c of clients) {
    if (!c) continue;
    const e = normEmail(c.email);
    if (e && !byEmail.has(e)) byEmail.set(e, c);
    const pk = phoneKey(c.phone);
    if (pk && !byPhone.has(pk)) byPhone.set(pk, c);
  }
  let changed = false;
  const now = new Date().toISOString();
  for (const b of list) {
    const res = sanitizeClientInput({ name: b.clientName, email: b.clientEmail, phone: b.clientPhone });
    let cand = res.client;
    if (!cand && (res.error === 'invalid_phone' || res.error === 'invalid_email')) {
      // Keep the usable half (e.g. a good email with a junk phone).
      const retry = sanitizeClientInput(res.error === 'invalid_phone'
        ? { name: b.clientName, email: b.clientEmail }
        : { name: b.clientName, phone: b.clientPhone });
      cand = retry.client;
    }
    if (!cand) { out.invalid += 1; continue; }
    const pk = phoneKey(cand.phone);
    const match = (cand.email && byEmail.get(cand.email)) || (pk && byPhone.get(pk)) || null;
    if (match) {
      out.skipped += 1;
      if (!match.email && cand.email && !byEmail.has(cand.email)) {
        match.email = cand.email;
        byEmail.set(cand.email, match);
        out.filled += 1;
        changed = true;
      }
      if (!match.phone && cand.phone && pk && !byPhone.has(pk)) {
        match.phone = cand.phone;
        byPhone.set(pk, match);
        out.filled += 1;
        changed = true;
      }
      continue;
    }
    if (clients.length >= MAX_CLIENTS) { out.capped += 1; continue; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? String(b.date) : '';
    const client = {
      id: randomId(),
      name: cand.name,
      email: cand.email,
      phone: cand.phone,
      notes: '',
      source: 'booking',
      firstBookingDate: date,
      createdAt: now,
    };
    clients.push(client);
    if (client.email) byEmail.set(client.email, client);
    if (pk) byPhone.set(pk, client);
    out.added += 1;
    changed = true;
  }
  out.total = clients.length;
  if (changed) await saveClients(env, id, clients);
  return out;
}

const BACKFILL_KEY = 'clientsBackfill:v1';

/**
 * One-time backfill (runs from the hourly cron until it has completed once).
 * Adds clients from every business's accepted / confirmed / completed bookings.
 * Stores only per-business counts (no client data) under clientsBackfill:v1.
 */
export async function runClientsBackfillOnce(env, deps) {
  if (!env || !env.AUTH_KV) return { skipped: 'no_kv' };
  const prev = await env.AUTH_KV.get(BACKFILL_KEY);
  if (prev) return { skipped: 'already_done' };
  await env.AUTH_KV.put(BACKFILL_KEY, JSON.stringify({ status: 'running', startedAt: new Date().toISOString() }));
  try {
    const idToken = await deps.firebaseAnonymousToken(env);
    const tenants = await deps.listAllTenants(env, idToken);
    const results = [];
    for (const t of tenants || []) {
      if (!t || !t.id) continue;
      const appts = Array.isArray(t.appointments) ? t.appointments : [];
      const eligible = appts.filter(bookingMakesClient).length;
      let r = { added: 0, filled: 0, skipped: 0, capped: 0, invalid: 0, total: 0 };
      let error = '';
      try { r = await upsertClientsFromBookings(env, t.id, appts); } catch (err) { error = String(err && err.message || err).slice(0, 80); }
      let totalClients = r.total;
      try { totalClients = (await loadClients(env, clip(t.id, 80))).length; } catch (_) {}
      results.push({ tenantId: clip(t.id, 80), slug: clip(t.slug, 60), bookings: appts.length, eligible, added: r.added, filled: r.filled, alreadySaved: r.skipped, capped: r.capped, invalid: r.invalid, totalClients, error });
    }
    const summary = {
      status: 'done',
      finishedAt: new Date().toISOString(),
      tenants: results.length,
      added: results.reduce((n, x) => n + x.added, 0),
      results,
    };
    await env.AUTH_KV.put(BACKFILL_KEY, JSON.stringify(summary));
    return summary;
  } catch (err) {
    // Let the next hourly run try again.
    await env.AUTH_KV.delete(BACKFILL_KEY).catch(() => {});
    throw err;
  }
}

function dedupeIndex(clients) {
  const emails = new Set();
  const phones = new Set();
  for (const c of clients) {
    if (!c) continue;
    if (c.email) emails.add(normEmail(c.email));
    const pk = phoneKey(c.phone);
    if (pk) phones.add(pk);
  }
  return { emails, phones };
}

function duplicateReason(idx, client) {
  if (client.email && idx.emails.has(client.email)) return 'duplicate_email';
  const pk = phoneKey(client.phone);
  if (pk && idx.phones.has(pk)) return 'duplicate_phone';
  return '';
}

function rememberClient(idx, client) {
  if (client.email) idx.emails.add(client.email);
  const pk = phoneKey(client.phone);
  if (pk) idx.phones.add(pk);
}

async function sessionForTenant(env, token, tenantId) {
  const session = await readSession(env, token);
  if (!session) return { error: 'session_required', status: 401 };
  if (session.role === 'agency') return { session };
  if (session.role === 'owner' && session.tenantId === tenantId) return { session };
  return { error: 'forbidden', status: 403 };
}

function cors(origin, isAllowedOrigin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  };
  if (origin && isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function respond(body, status, origin, isAllowedOrigin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cors(origin, isAllowedOrigin)),
  });
}

export async function handleClientsHttp(request, env, origin, deps) {
  const isAllowedOrigin = deps.isAllowedOrigin;
  if (origin && !isAllowedOrigin(origin)) return new Response(null, { status: 403 });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin, isAllowedOrigin) });
  if (request.method !== 'POST') return respond({ ok: false, error: 'method_not_allowed' }, 405, origin, isAllowedOrigin);

  const ip = String(request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 64);
  if (!(await rateLimitOk(env.RL_CLIENTS, 'ip:' + ip, 60, 'clients-ip'))) {
    return respond({ ok: false, error: 'rate_limited' }, 429, origin, isAllowedOrigin);
  }
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BODY_BYTES) return respond({ ok: false, error: 'too_large' }, 413, origin, isAllowedOrigin);
  let text = '';
  try { text = await request.text(); } catch (_) { text = ''; }
  if (text.length > MAX_BODY_BYTES) return respond({ ok: false, error: 'too_large' }, 413, origin, isAllowedOrigin);
  let body = {};
  try { body = JSON.parse(text || '{}'); } catch (_) { body = {}; }
  const action = clip(body.action, 20);
  const tenantId = clip(body.tenantId, 80);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(tenantId)) return respond({ ok: false, error: 'invalid_tenant' }, 400, origin, isAllowedOrigin);

  const auth = await sessionForTenant(env, body.session, tenantId);
  if (auth.error) return respond({ ok: false, error: auth.error }, auth.status, origin, isAllowedOrigin);

  if (action === 'list') {
    const clients = await loadClients(env, tenantId);
    return respond({ ok: true, clients: clients.map(clientForOwner) }, 200, origin, isAllowedOrigin);
  }

  if (action === 'import' || action === 'add') {
    const scopeLimit = action === 'import' ? 6 : 40;
    if (!(await rateLimitOk(env.RL_CLIENTS, action + ':' + tenantId, scopeLimit, 'clients-' + action))) {
      return respond({ ok: false, error: 'rate_limited' }, 429, origin, isAllowedOrigin);
    }
    const rows = action === 'add' ? [Object.assign({ row: 1 }, body.client || {})] : (Array.isArray(body.rows) ? body.rows : []);
    if (!rows.length) return respond({ ok: false, error: 'no_rows' }, 400, origin, isAllowedOrigin);
    if (rows.length > MAX_IMPORT_ROWS) return respond({ ok: false, error: 'too_many_rows', max: MAX_IMPORT_ROWS }, 400, origin, isAllowedOrigin);
    const existing = await loadClients(env, tenantId);
    const idx = dedupeIndex(existing);
    const added = [];
    const skipped = [];
    const errors = [];
    const now = new Date().toISOString();
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const rowNo = Math.max(1, Math.min(100000, parseInt(raw && raw.row, 10) || (i + 1)));
      const res = sanitizeClientInput(raw);
      if (res.error) { errors.push({ row: rowNo, reason: res.error }); continue; }
      const dup = duplicateReason(idx, res.client);
      if (dup) { skipped.push({ row: rowNo, reason: dup }); continue; }
      if (existing.length + added.length >= MAX_CLIENTS) { errors.push({ row: rowNo, reason: 'client_limit' }); continue; }
      const client = Object.assign({ id: randomId(), source: action === 'import' ? 'csv' : 'manual', createdAt: now }, res.client);
      rememberClient(idx, client);
      added.push(client);
    }
    if (added.length) await saveClients(env, tenantId, existing.concat(added));
    if (action === 'add') {
      if (added.length) return respond({ ok: true, client: clientForOwner(added[0]) }, 200, origin, isAllowedOrigin);
      const why = (skipped[0] && skipped[0].reason) || (errors[0] && errors[0].reason) || 'invalid_row';
      return respond({ ok: false, error: why }, why.indexOf('duplicate') === 0 ? 409 : 400, origin, isAllowedOrigin);
    }
    return respond({
      ok: true,
      total: rows.length,
      added: added.length,
      skipped: skipped.slice(0, MAX_IMPORT_ROWS),
      errors: errors.slice(0, MAX_IMPORT_ROWS),
      clients: added.map(clientForOwner),
    }, 200, origin, isAllowedOrigin);
  }

  if (action === 'delete') {
    if (!(await rateLimitOk(env.RL_CLIENTS, 'delete:' + tenantId, 60, 'clients-delete'))) {
      return respond({ ok: false, error: 'rate_limited' }, 429, origin, isAllowedOrigin);
    }
    const clientId = clip(body.clientId, 40);
    const existing = await loadClients(env, tenantId);
    const next = existing.filter((c) => !(c && String(c.id) === clientId));
    if (next.length === existing.length) return respond({ ok: false, error: 'not_found' }, 404, origin, isAllowedOrigin);
    await saveClients(env, tenantId, next);
    return respond({ ok: true, deleted: clientId, count: next.length }, 200, origin, isAllowedOrigin);
  }

  return respond({ ok: false, error: 'unknown_action' }, 400, origin, isAllowedOrigin);
}
