/**
 * Private iCal links and the owner subscribe feed.
 * Feed URLs stay in AUTH_KV. Clients only see masked links and start/end busy blocks.
 */
import { adminAuthHeaders } from './firebase-admin.js';
import { encodeValue } from './tenant-private.js';
import { buildOwnerFeedIcs } from './booking-ics.js';
import {
  bookingOverlapsBusy,
  hostIsBlocked,
  ipIsPrivate,
  maskCalendarUrl,
  mergeBusyBlocks,
  normalizeCalendarUrl,
  parseBusyBlocks,
  providerLabel,
} from './calendar-ics.js';

const FEEDS_PREFIX = 'calFeeds:';
const BUSY_PREFIX = 'calBusy:';
const TOKEN_PREFIX = 'calOwnerToken:';
const INDEX_KEY = 'calFeedIndex';
const MAX_FEEDS = 8;
const MAX_BYTES = 2000000;
const FETCH_TIMEOUT_MS = 8000;
const FRESH_MS = 2 * 60 * 1000;
const BUSY_MESSAGE = 'That time is already busy.';

export { bookingOverlapsBusy, BUSY_MESSAGE };

function clipId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return '';
  return id;
}

function randomId(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function emptySecret(tenantId) {
  return { tenantId, timeZone: 'America/New_York', ownerToken: '', feeds: [] };
}

async function readJson(kv, key) {
  if (!kv) return null;
  const raw = await kv.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function readSecret(env, tenantId) {
  const row = await readJson(env.AUTH_KV, FEEDS_PREFIX + tenantId);
  const secret = emptySecret(tenantId);
  if (!row || typeof row !== 'object') return secret;
  secret.timeZone = String(row.timeZone || secret.timeZone);
  secret.ownerToken = /^[a-f0-9]{32,128}$/.test(String(row.ownerToken || '')) ? String(row.ownerToken) : '';
  secret.feeds = (Array.isArray(row.feeds) ? row.feeds : []).filter((feed) => feed && feed.id && feed.url).slice(0, MAX_FEEDS);
  return secret;
}

async function writeSecret(env, secret) {
  await env.AUTH_KV.put(FEEDS_PREFIX + secret.tenantId, JSON.stringify({
    tenantId: secret.tenantId,
    timeZone: secret.timeZone,
    ownerToken: secret.ownerToken,
    feeds: secret.feeds,
  }));
}

async function readBusy(env, tenantId) {
  const row = await readJson(env.AUTH_KV, BUSY_PREFIX + tenantId);
  if (!row || typeof row !== 'object') return { syncedAt: 0, blocks: [], sources: [] };
  return {
    syncedAt: Number(row.syncedAt) || 0,
    blocks: Array.isArray(row.blocks) ? row.blocks : [],
    sources: Array.isArray(row.sources) ? row.sources : [],
  };
}

async function writeBusy(env, tenantId, busy) {
  await env.AUTH_KV.put(BUSY_PREFIX + tenantId, JSON.stringify({
    syncedAt: busy.syncedAt || Date.now(),
    blocks: busy.blocks || [],
    sources: busy.sources || [],
  }));
}

async function rememberTenant(env, tenantId) {
  const row = await readJson(env.AUTH_KV, INDEX_KEY);
  const list = Array.isArray(row) ? row.map((id) => String(id)) : [];
  if (!list.includes(tenantId)) {
    list.push(tenantId);
    await env.AUTH_KV.put(INDEX_KEY, JSON.stringify(list.slice(0, 5000)));
  }
}

async function forgetTenant(env, tenantId) {
  const row = await readJson(env.AUTH_KV, INDEX_KEY);
  const list = (Array.isArray(row) ? row : []).map((id) => String(id)).filter((id) => id && id !== tenantId);
  await env.AUTH_KV.put(INDEX_KEY, JSON.stringify(list));
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function dnsLookup(name, type, fetchImpl) {
  const url = 'https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=' + type;
  const res = await fetchImpl(url, { headers: { accept: 'application/dns-json' } });
  if (!res.ok) throw new Error('dns');
  return res.json();
}

export async function resolveHostPublic(hostname, fetchImpl) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  if (hostIsBlocked(host)) {
    const error = new Error('blocked_host');
    error.code = 'blocked_host';
    throw error;
  }
  if (ipIsPrivate(host) || /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) {
    if (ipIsPrivate(host)) {
      const error = new Error('blocked_host');
      error.code = 'blocked_host';
      throw error;
    }
    return [host];
  }
  const lookup = fetchImpl || fetch;
  const [v4, v6] = await Promise.all([
    dnsLookup(host, 'A', lookup).catch(() => null),
    dnsLookup(host, 'AAAA', lookup).catch(() => null),
  ]);
  const answers = []
    .concat((v4 && v4.Answer) || [], (v6 && v6.Answer) || [])
    .filter((row) => row && (row.type === 1 || row.type === 28) && row.data);
  let ips = answers.map((row) => String(row.data).replace(/\.$/, ''));
  if (!ips.length) {
    const cname = []
      .concat((v4 && v4.Answer) || [], (v6 && v6.Answer) || [])
      .find((row) => row && row.type === 5 && row.data);
    if (cname) {
      const target = String(cname.data).replace(/\.$/, '');
      if (hostIsBlocked(target)) {
        const error = new Error('blocked_host');
        error.code = 'blocked_host';
        throw error;
      }
      const again = await dnsLookup(target, 'A', lookup).catch(() => null);
      ips = ((again && again.Answer) || []).filter((row) => row && row.type === 1 && row.data).map((row) => String(row.data));
    }
  }
  if (!ips.length || ips.some((ip) => ipIsPrivate(ip) || hostIsBlocked(ip))) {
    const error = new Error('blocked_host');
    error.code = 'blocked_host';
    throw error;
  }
  return ips;
}

async function readLimited(res, maxBytes) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      received += step.value.byteLength;
      if (received > maxBytes) {
        try { await reader.cancel(); } catch (_) {}
        return { ok: false, error: 'That calendar is too large.' };
      }
      chunks.push(step.value);
    }
    const text = new TextDecoder('utf-8').decode(await new Blob(chunks).arrayBuffer());
    return { ok: true, body: text };
  }
  const text = await res.text();
  if (text.length > maxBytes) return { ok: false, error: 'That calendar is too large.' };
  return { ok: true, body: text };
}

export async function fetchCalendarText(rawUrl, deps) {
  const normalized = normalizeCalendarUrl(rawUrl);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const fetchImpl = (deps && deps.fetch) || fetch;
  const resolve = (deps && deps.resolve) || ((host) => resolveHostPublic(host, (deps && deps.dnsFetch) || fetchImpl));
  const timeoutMs = (deps && deps.timeoutMs) || FETCH_TIMEOUT_MS;
  const maxBytes = (deps && deps.maxBytes) || MAX_BYTES;
  let current = normalized.url;
  for (let hop = 0; hop < 4; hop++) {
    let parsed;
    try { parsed = new URL(current); } catch (_) { return { ok: false, error: 'That link is not a calendar address.' }; }
    try {
      await resolve(parsed.hostname);
    } catch (_) {
      return { ok: false, error: 'That address cannot be used.' };
    }
    let res;
    try {
      res = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1', 'User-Agent': 'SchediCalendarSync/1.0' },
      });
    } catch (_) {
      return { ok: false, error: 'The calendar link timed out.' };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers && res.headers.get ? res.headers.get('location') : '';
      if (!loc) return { ok: false, error: 'The calendar link did not download.' };
      let next;
      try { next = new URL(loc, current).toString(); } catch (_) { return { ok: false, error: 'That address cannot be used.' }; }
      const check = normalizeCalendarUrl(next);
      if (!check.ok) return { ok: false, error: 'That address cannot be used.' };
      current = check.url;
      continue;
    }
    if (!res.ok) return { ok: false, error: 'The calendar link did not download.' };
    const text = await readLimited(res, maxBytes);
    if (!text.ok) return text;
    if (!/BEGIN:VCALENDAR/i.test(text.body)) return { ok: false, error: 'That file is not a calendar.' };
    return { ok: true, body: text.body, url: normalized.url };
  }
  return { ok: false, error: 'The calendar link redirected too many times.' };
}

function tenantDocUrl(env, tenantId) {
  const projectId = String((env && env.FIREBASE_PROJECT_ID) || 'siteforge-97699').trim();
  const appId = String((env && (env.FIREBASE_APP_ID || env.FIREBASE_PROJECT_ID)) || projectId).trim();
  return 'https://firestore.googleapis.com/v1/projects/' + projectId
    + '/databases/(default)/documents/artifacts/' + appId
    + '/public/data/tenants/' + encodeURIComponent(tenantId);
}

async function publishExternalBusy(env, tenantId, blocks) {
  if (!env || !env.FIREBASE_SERVICE_ACCOUNT_JSON) return;
  try {
    const headers = await adminAuthHeaders(env);
    const res = await fetch(tenantDocUrl(env, tenantId) + '?updateMask.fieldPaths=externalBusy', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ fields: { externalBusy: encodeValue(blocks.slice(0, 1500)) } }),
    });
    if (!res.ok) console.log(JSON.stringify({ calendarSync: 'publish_failed', tenantId, status: res.status }));
  } catch (_) {
    console.log(JSON.stringify({ calendarSync: 'publish_skipped', tenantId }));
  }
}

async function timezoneFor(env, tenantId, secret, deps) {
  if (deps && typeof deps.getTenant === 'function') {
    try {
      const tenant = await deps.getTenant(env, tenantId);
      const tz = tenant && (tenant.timezone || tenant.timeZone);
      if (tz) return String(tz);
    } catch (_) {}
  }
  return secret.timeZone || 'America/New_York';
}

export async function syncTenantFeeds(env, tenantId, deps) {
  const id = clipId(tenantId);
  if (!id || !env || !env.AUTH_KV) return { blocks: [], sources: [], syncedAt: 0 };
  const secret = await readSecret(env, id);
  const tz = await timezoneFor(env, id, secret, deps);
  secret.timeZone = tz;
  if (!secret.feeds.length) {
    const empty = { syncedAt: Date.now(), blocks: [], sources: [] };
    await writeBusy(env, id, empty);
    await writeSecret(env, secret);
    await publishExternalBusy(env, id, []);
    return empty;
  }
  const now = deps && deps.now instanceof Date ? deps.now : new Date();
  const all = [];
  const sources = [];
  for (const feed of secret.feeds) {
    const got = await fetchCalendarText(feed.url, deps || {});
    feed.lastSynced = Date.now();
    if (!got.ok) {
      feed.error = got.error;
      feed.eventCount = 0;
      sources.push({ id: feed.id, eventCount: 0, error: feed.error, lastSynced: feed.lastSynced });
      continue;
    }
    try {
      const blocks = parseBusyBlocks(got.body, { now, timeZone: tz, horizonDays: 90 });
      feed.error = '';
      feed.eventCount = blocks.length;
      all.push.apply(all, blocks);
      sources.push({ id: feed.id, eventCount: blocks.length, error: '', lastSynced: feed.lastSynced });
    } catch (_) {
      feed.error = 'That file could not be read as a calendar.';
      feed.eventCount = 0;
      sources.push({ id: feed.id, eventCount: 0, error: feed.error, lastSynced: feed.lastSynced });
    }
  }
  const blocks = mergeBusyBlocks(all).slice(0, 2000);
  const busy = { syncedAt: Date.now(), blocks, sources };
  await writeSecret(env, secret);
  await writeBusy(env, id, busy);
  await publishExternalBusy(env, id, blocks);
  return busy;
}

export async function syncAllCalendarFeeds(env, deps) {
  if (!env || !env.AUTH_KV) return { ok: false, skipped: true };
  const row = await readJson(env.AUTH_KV, INDEX_KEY);
  const ids = Array.isArray(row) ? row : [];
  let synced = 0;
  let errors = 0;
  for (const tenantId of ids) {
    try {
      await syncTenantFeeds(env, tenantId, deps || {});
      synced += 1;
    } catch (_) {
      errors += 1;
      console.log(JSON.stringify({ calendarSync: 'error', tenantId: String(tenantId) }));
    }
  }
  return { ok: true, synced, errors };
}

export async function busyBlocksForTenant(env, tenantId, deps) {
  const id = clipId(tenantId);
  if (!id || !env || !env.AUTH_KV) return [];
  const secret = await readSecret(env, id);
  if (!secret.feeds.length) return [];
  const cache = await readBusy(env, id);
  const freshMs = deps && Number(deps.freshMs) > 0 ? Number(deps.freshMs) : FRESH_MS;
  const age = Date.now() - (Number(cache.syncedAt) || 0);
  if (cache.syncedAt && age >= 0 && age < freshMs) return cache.blocks || [];
  const timeoutMs = deps && Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : 4000;
  try {
    const fresh = await withTimeout(syncTenantFeeds(env, id, deps || {}), timeoutMs);
    return (fresh && fresh.blocks) || [];
  } catch (_) {
    return cache.blocks || [];
  }
}

function feedView(feed) {
  return {
    id: String(feed.id),
    masked: maskCalendarUrl(feed.url),
    provider: providerLabel(feed.url),
    lastSynced: Number(feed.lastSynced) || 0,
    eventCount: Number(feed.eventCount) || 0,
    error: String(feed.error || ''),
  };
}

function ownerFeedUrls(token) {
  const path = '/api/owner-feed/' + token + '.ics';
  return {
    https: 'https://schedi.app' + path,
    webcal: 'webcal://schedi.app' + path,
  };
}

async function ensureOwnerToken(env, secret) {
  if (secret.ownerToken) {
    const mapped = await env.AUTH_KV.get(TOKEN_PREFIX + secret.ownerToken);
    if (mapped === secret.tenantId) return secret.ownerToken;
  }
  const token = randomId(24);
  secret.ownerToken = token;
  await env.AUTH_KV.put(TOKEN_PREFIX + token, secret.tenantId);
  await writeSecret(env, secret);
  return token;
}

async function sessionCan(env, token, tenantId, readSession) {
  if (typeof readSession !== 'function') return null;
  const session = await readSession(env, token);
  if (!session) return null;
  if (session.role === 'agency') return session;
  if (session.role === 'owner' && session.tenantId === tenantId) return session;
  return null;
}

function publicBlocks(blocks) {
  return (blocks || []).slice(0, 1500).map((block) => ({
    start: String(block.start || ''),
    end: String(block.end || ''),
  })).filter((block) => block.start && block.end);
}

export async function handleCalendarFeeds(request, env, origin, deps) {
  const json = deps.json;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin && deps.isAllowedOrigin(origin) ? origin : 'https://schedi.app', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
  if (!env.AUTH_KV) return json({ ok: false, error: 'calendar_store_unavailable' }, 503, origin);
  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const tenantId = clipId(body.tenantId);
  const session = await sessionCan(env, body.session, tenantId, deps.readSession);
  if (!session) return json({ ok: false, error: 'forbidden' }, 403, origin);
  const action = String(body.action || 'list');
  const secret = await readSecret(env, tenantId);

  if (action === 'add') {
    if (secret.feeds.length >= MAX_FEEDS) return json({ ok: false, error: 'too_many_feeds', message: 'Remove a calendar before adding another.' }, 400, origin);
    const normalized = normalizeCalendarUrl(body.url);
    if (!normalized.ok) return json({ ok: false, error: 'invalid_url', message: normalized.error }, 400, origin);
    if (secret.feeds.some((feed) => feed.url === normalized.url)) {
      return json({ ok: false, error: 'duplicate_feed', message: 'That calendar is already added.' }, 400, origin);
    }
    const got = await fetchCalendarText(body.url, deps);
    if (!got.ok) return json({ ok: false, error: 'feed_unreadable', message: got.error }, 400, origin);
    secret.feeds.push({
      id: randomId(6),
      url: normalized.url,
      addedAt: Date.now(),
      lastSynced: 0,
      eventCount: 0,
      error: '',
    });
    await writeSecret(env, secret);
    await rememberTenant(env, tenantId);
    await syncTenantFeeds(env, tenantId, deps);
  } else if (action === 'remove') {
    const id = String(body.id || '');
    const before = secret.feeds.length;
    secret.feeds = secret.feeds.filter((feed) => feed.id !== id);
    if (secret.feeds.length === before) return json({ ok: false, error: 'not_found' }, 404, origin);
    await writeSecret(env, secret);
    if (!secret.feeds.length) await forgetTenant(env, tenantId);
    await syncTenantFeeds(env, tenantId, deps);
  } else if (action === 'refresh') {
    await syncTenantFeeds(env, tenantId, deps);
  } else if (action === 'reset-feed') {
    if (secret.ownerToken) {
      await env.AUTH_KV.delete(TOKEN_PREFIX + secret.ownerToken);
      secret.ownerToken = '';
    }
    await ensureOwnerToken(env, secret);
  } else if (action !== 'list') {
    return json({ ok: false, error: 'not_found' }, 404, origin);
  }

  const current = await readSecret(env, tenantId);
  const token = await ensureOwnerToken(env, current);
  const busy = await readBusy(env, tenantId);
  return json({
    ok: true,
    feeds: current.feeds.map(feedView),
    ownerFeed: ownerFeedUrls(token),
    blocks: publicBlocks(busy.blocks),
    syncedAt: busy.syncedAt || 0,
  }, 200, origin);
}

export async function handleCalendarBusy(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), { status: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
  const tenantId = clipId(url.searchParams.get('tenant'));
  if (!tenantId || !env.AUTH_KV) {
    return new Response(JSON.stringify({ ok: true, blocks: [] }), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' } });
  }
  const busy = await readBusy(env, tenantId);
  return new Response(JSON.stringify({ ok: true, blocks: publicBlocks(busy.blocks), syncedAt: busy.syncedAt || 0 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' },
  });
}

function isoDay(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch (_) {
    return date.toISOString().slice(0, 10);
  }
}

function shiftDay(iso, days) {
  const p = String(iso || '').split('-');
  const d = new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function handleOwnerFeed(request, env, token, deps) {
  if (request.method !== 'GET') return new Response('Not found', { status: 404 });
  const key = String(token || '').toLowerCase();
  if (!/^[a-f0-9]{32,128}$/.test(key) || !env.AUTH_KV) return new Response('Not found', { status: 404 });
  const tenantId = clipId(await env.AUTH_KV.get(TOKEN_PREFIX + key));
  if (!tenantId) return new Response('Not found', { status: 404 });
  let tenant = null;
  try {
    if (deps && typeof deps.getTenantById === 'function' && typeof deps.firebaseAnonymousToken === 'function') {
      const idToken = await deps.firebaseAnonymousToken(env);
      tenant = await deps.getTenantById(env, idToken, tenantId);
    }
  } catch (_) { tenant = null; }
  if (!tenant) tenant = { id: tenantId, name: 'Schedi', timezone: 'America/New_York' };
  let appointments = [];
  try {
    if (deps && typeof deps.loadAppointments === 'function') appointments = await deps.loadAppointments(tenantId) || [];
  } catch (_) { appointments = []; }
  const tz = String(tenant.timezone || tenant.timeZone || 'America/New_York');
  const today = isoDay(new Date(), tz);
  const start = shiftDay(today, -1);
  const end = shiftDay(today, 180);
  const upcoming = appointments.filter((booking) => booking && booking.date >= start && booking.date <= end).slice(0, 500);
  const body = buildOwnerFeedIcs(tenant, upcoming, new Date());
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="schedi-bookings.ics"',
      'Cache-Control': 'private, max-age=300',
    },
  });
}
