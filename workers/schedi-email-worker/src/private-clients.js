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
 *   update  -> { clientId, client: { name, email, phone, notes, tags } } -> { ok, client }
 *   delete  -> { clientId }
 *
 * Allowed client fields are name, email, phone, notes, and tags. Anything else on the
 * payload is dropped. Updating a client does not rewrite bookings or the roster.
 * Visits already on the calendar keep the name, email, and phone stored on each booking.
 *
 * Bookings: upsertClientsFromBookings() is called server-side whenever bookings are saved
 * (private-bookings.js persistTenantAppointments) for bookings that just became accepted/confirmed,
 * and once by the clients backfill cron. Adds source:'booking' + firstBookingDate. Never contacts anyone.
 *
 * A booking that was already accepted when that cron finished is not retried on later saves.
 * POST /api/clients { action:'backfill', dryRun } repairs those rows. It defaults to a dry run.
 * Agency session plus Authorization: Bearer <MIGRATION_TOKEN>. It only adds missing client rows.
 * It does not edit or delete bookings, and it does not overwrite an existing client's name, notes, or tags.
 * Removing a client records that contact so a later backfill does not put the old visits back.
 * A booking created after the removal still adds the client again.
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

const MAX_CLIENT_TAGS = 12;

export function sanitizeClientTags(value) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[,;\n]/) : []);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (out.length >= MAX_CLIENT_TAGS) break;
    if (item != null && typeof item !== 'string' && typeof item !== 'number') continue;
    const tag = cleanText(item, 24);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export function sanitizeClientInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_row' };
  let name = cleanText(raw.name, 120);
  if (!name) name = cleanText([cleanText(raw.firstName, 60), cleanText(raw.lastName, 60)].filter(Boolean).join(' '), 120);
  const email = normEmail(raw.email);
  const phoneRaw = cleanText(raw.phone, 40);
  const pk = phoneKey(phoneRaw);
  const notes = cleanText(raw.notes, 500);
  const tags = sanitizeClientTags(raw.tags);
  if (!name && !email && !phoneRaw) return { error: 'empty_row' };
  if (!name) return { error: 'missing_name' };
  if (email && !EMAIL_RE.test(email)) return { error: 'invalid_email' };
  if (phoneRaw && (pk.length < 7 || pk.length > 15)) return { error: 'invalid_phone' };
  if (!email && !phoneRaw) return { error: 'missing_contact' };
  return { client: { name, email, phone: phoneRaw, notes, tags } };
}

function randomId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return 'cl_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const MAX_REMOVED = 2000;

function sanitizeRemoved(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const email = normEmail(row.email);
    const phone = phoneKey(row.phone);
    const at = clip(row.at, 30);
    if ((!email && !phone) || !/^\d{4}-\d{2}-\d{2}T/.test(at)) continue;
    out.push({ email, phone, at });
    if (out.length >= MAX_REMOVED) break;
  }
  return out;
}

async function loadClientDoc(env, tenantId) {
  if (!env || !env.AUTH_KV) return { clients: [], removed: [] };
  const raw = await env.AUTH_KV.get(PREFIX + tenantId);
  if (!raw) return { clients: [], removed: [] };
  try {
    const data = JSON.parse(raw);
    return {
      clients: Array.isArray(data && data.clients) ? data.clients : [],
      removed: sanitizeRemoved(data && data.removed),
    };
  } catch (_) {
    return { clients: [], removed: [] };
  }
}

export async function loadClients(env, tenantId) {
  const doc = await loadClientDoc(env, tenantId);
  return doc.clients;
}

async function saveClients(env, tenantId, clients, removed) {
  if (!env.AUTH_KV) throw new Error('private_store_unavailable');
  let kept = removed;
  if (kept === undefined) kept = (await loadClientDoc(env, tenantId)).removed;
  await env.AUTH_KV.put(PREFIX + tenantId, JSON.stringify({
    clients: clients.slice(0, MAX_CLIENTS),
    removed: sanitizeRemoved(kept).slice(-MAX_REMOVED),
    updatedAt: new Date().toISOString(),
  }));
}

function rememberRemoval(removed, client, at) {
  const email = normEmail(client && client.email);
  const phone = phoneKey(client && client.phone);
  const next = (removed || []).filter((row) => {
    if (email && row.email === email) return false;
    if (phone && row.phone === phone) return false;
    return true;
  });
  if (email || phone) next.push({ email, phone, at: clip(at, 30) });
  return sanitizeRemoved(next).slice(-MAX_REMOVED);
}

function forgetRemoval(removed, client) {
  const email = normEmail(client && client.email);
  const phone = phoneKey(client && client.phone);
  return (removed || []).filter((row) => {
    if (email && row.email === email) return false;
    if (phone && row.phone === phone) return false;
    return true;
  });
}

function removalBlocks(removed, cand, booking) {
  const pk = phoneKey(cand.phone);
  let at = '';
  for (const row of removed || []) {
    const hit = (cand.email && row.email && row.email === cand.email) || (pk && row.phone && row.phone === pk);
    if (hit && String(row.at || '') > at) at = String(row.at);
  }
  if (!at) return false;
  const created = String(booking && booking.createdAt || '');
  if (/^\d{4}-\d{2}-\d{2}T/.test(created) && created > at) return false;
  return true;
}

function timingSafeEqualStr(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  let diff = left.length ^ right.length;
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return diff === 0;
}

function clientForOwner(c) {
  return {
    id: clip(c.id, 40),
    name: clip(c.name, 120),
    email: clip(c.email, 254),
    phone: clip(c.phone, 40),
    notes: clip(c.notes, 500),
    tags: sanitizeClientTags(c.tags),
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
 * options.respectRemoval: skip contacts the owner removed, unless the booking was created after that removal.
 * Returns { added, filled, skipped, capped, total }.
 */
export async function upsertClientsFromBookings(env, tenantId, bookings, options) {
  const id = clip(tenantId, 80);
  const out = { added: 0, filled: 0, skipped: 0, capped: 0, invalid: 0, total: 0 };
  const respectRemoval = !!(options && options.respectRemoval);
  if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || !env || !env.AUTH_KV) return out;
  const list = (Array.isArray(bookings) ? bookings : []).filter(bookingMakesClient);
  if (!list.length) return out;
  // Oldest first so firstBookingDate is the earliest visit and series collapse to one client.
  list.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.time || '').localeCompare(String(b.time || '')));
  const doc = await loadClientDoc(env, id);
  const clients = doc.clients;
  const removed = doc.removed;
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
    if (!match && respectRemoval && removalBlocks(removed, cand, b)) {
      out.skipped += 1;
      continue;
    }
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
      tags: [],
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
  if (changed && !(options && options.dryRun)) await saveClients(env, id, clients, removed);
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
      try { r = await upsertClientsFromBookings(env, t.id, appts, { respectRemoval: true }); } catch (err) { error = String(err && err.message || err).slice(0, 80); }
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

function countBackfill(rows, key) {
  return rows.reduce((n, row) => n + (Number(row[key]) || 0), 0);
}

/**
 * Repair missing client rows from the private booking roster.
 * dryRun defaults to true and writes nothing. A real run only adds clients (and may fill a blank
 * email or phone). Bookings are read, never written. The result is counts only: no names, emails, or phones.
 * Removed clients stay removed unless that booking was created after the removal.
 */
export async function backfillClientsFromBookings(env, deps, options) {
  const dryRun = !options || options.dryRun !== false;
  const only = clip(options && options.tenantId, 80);
  if (only && !/^[A-Za-z0-9_-]{1,80}$/.test(only)) return { ok: false, error: 'invalid_tenant' };
  if (!env || !env.AUTH_KV) return { ok: false, error: 'private_store_unavailable' };
  if (!deps || typeof deps.loadPrivateAppointments !== 'function') return { ok: false, error: 'backfill_unavailable' };
  let ids = [];
  if (only) ids = [only];
  else {
    if (typeof deps.listTenantIds !== 'function') return { ok: false, error: 'backfill_unavailable' };
    try { ids = await deps.listTenantIds(env); } catch (_) { return { ok: false, error: 'tenant_list_failed' }; }
  }
  const results = [];
  for (const tenantId of ids || []) {
    const id = clip(tenantId, 80);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) continue;
    let appts = [];
    try {
      appts = await deps.loadPrivateAppointments(env, id);
    } catch (_) {
      results.push({ tenantId: id, error: 'roster_unavailable', bookings: 0, eligible: 0, added: 0, filled: 0, skipped: 0, capped: 0, invalid: 0, totalClients: 0 });
      continue;
    }
    const list = Array.isArray(appts) ? appts : [];
    const eligible = list.filter(bookingMakesClient).length;
    let r = { added: 0, filled: 0, skipped: 0, capped: 0, invalid: 0, total: 0 };
    let error = '';
    try {
      r = await upsertClientsFromBookings(env, id, list, { respectRemoval: true, dryRun });
    } catch (_) {
      error = 'upsert_failed';
    }
    let totalClients = 0;
    try { totalClients = (await loadClients(env, id)).length; } catch (_) { totalClients = 0; }
    const row = {
      tenantId: id,
      bookings: list.length,
      eligible,
      added: r.added,
      filled: r.filled,
      skipped: r.skipped,
      capped: r.capped,
      invalid: r.invalid,
      totalClients,
    };
    if (error) row.error = error;
    results.push(row);
  }
  return {
    ok: true,
    dryRun,
    bookingsUntouched: true,
    tenants: results.length,
    added: countBackfill(results, 'added'),
    filled: countBackfill(results, 'filled'),
    skipped: countBackfill(results, 'skipped'),
    results,
  };
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

async function handleClientsBackfill(request, env, origin, isAllowedOrigin, body, deps) {
  const session = await readSession(env, body && body.session);
  if (!session) return respond({ ok: false, error: 'session_required' }, 401, origin, isAllowedOrigin);
  if (session.role !== 'agency') return respond({ ok: false, error: 'forbidden' }, 403, origin, isAllowedOrigin);
  const expected = String(env.MIGRATION_TOKEN || '').trim();
  const header = String(request.headers.get('Authorization') || '');
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!expected || expected.length < 32 || !given || !timingSafeEqualStr(given, expected)) {
    return respond({ ok: false, error: 'unauthorized' }, 401, origin, isAllowedOrigin);
  }
  if (!(await rateLimitOk(env.RL_CLIENTS, 'backfill', 12, 'clients-backfill'))) {
    return respond({ ok: false, error: 'rate_limited' }, 429, origin, isAllowedOrigin);
  }
  const tenantId = clip(body && body.tenantId, 80);
  if (tenantId && !/^[A-Za-z0-9_-]{1,80}$/.test(tenantId)) {
    return respond({ ok: false, error: 'invalid_tenant' }, 400, origin, isAllowedOrigin);
  }
  try {
    const result = await backfillClientsFromBookings(env, deps, {
      dryRun: !body || body.dryRun !== false,
      tenantId,
    });
    return respond(result, result.ok ? 200 : 500, origin, isAllowedOrigin);
  } catch (_) {
    return respond({ ok: false, error: 'backfill_failed' }, 500, origin, isAllowedOrigin);
  }
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
  if (action === 'backfill') return handleClientsBackfill(request, env, origin, isAllowedOrigin, body, deps);
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
    const doc = await loadClientDoc(env, tenantId);
    const existing = doc.clients;
    let removed = doc.removed;
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
      removed = forgetRemoval(removed, client);
    }
    if (added.length) await saveClients(env, tenantId, existing.concat(added), removed);
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
    const doc = await loadClientDoc(env, tenantId);
    const existing = doc.clients;
    const current = existing.find((c) => c && String(c.id) === clientId);
    const next = existing.filter((c) => !(c && String(c.id) === clientId));
    if (!current || next.length === existing.length) return respond({ ok: false, error: 'not_found' }, 404, origin, isAllowedOrigin);
    await saveClients(env, tenantId, next, rememberRemoval(doc.removed, current, new Date().toISOString()));
    return respond({ ok: true, deleted: clientId, count: next.length }, 200, origin, isAllowedOrigin);
  }

  if (action === 'update') {
    if (!(await rateLimitOk(env.RL_CLIENTS, 'update:' + tenantId, 40, 'clients-update'))) {
      return respond({ ok: false, error: 'rate_limited' }, 429, origin, isAllowedOrigin);
    }
    const clientId = clip(body.clientId, 40);
    if (!clientId) return respond({ ok: false, error: 'not_found' }, 404, origin, isAllowedOrigin);
    const doc = await loadClientDoc(env, tenantId);
    const existing = doc.clients;
    const current = existing.find((c) => c && String(c.id) === clientId);
    if (!current) return respond({ ok: false, error: 'not_found' }, 404, origin, isAllowedOrigin);
    const res = sanitizeClientInput(body.client || {});
    if (res.error) return respond({ ok: false, error: res.error }, 400, origin, isAllowedOrigin);
    const others = existing.filter((c) => c && String(c.id) !== clientId);
    const dup = duplicateReason(dedupeIndex(others), res.client);
    if (dup) return respond({ ok: false, error: dup }, 409, origin, isAllowedOrigin);
    const updated = {
      id: current.id,
      name: res.client.name,
      email: res.client.email,
      phone: res.client.phone,
      notes: res.client.notes,
      tags: res.client.tags,
      source: clip(current.source, 10),
      firstBookingDate: clip(current.firstBookingDate, 10),
      createdAt: clip(current.createdAt, 30),
    };
    const next = existing.map((c) => (c && String(c.id) === clientId ? updated : c));
    await saveClients(env, tenantId, next, forgetRemoval(doc.removed, updated));
    return respond({ ok: true, client: clientForOwner(updated) }, 200, origin, isAllowedOrigin);
  }

  return respond({ ok: false, error: 'unknown_action' }, 400, origin, isAllowedOrigin);
}
