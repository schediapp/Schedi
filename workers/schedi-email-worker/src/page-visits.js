/**
 * Privacy-friendly booking-page visits.
 *
 * POST /api/page-visits { tenantId, src, utmSource, refHost }
 *   One view for that business. Bots, owner/agency sessions, demo, and preview
 *   are skipped. Nothing identifying is written: no cookie, no IP, no user agent.
 *   A daily salt in AUTH_KV hashes the IP only to decide whether this is a new
 *   visitor today. The hash is the KV key visitSeen:{tenant}:{day}:{hash} for
 *   36 hours and is not copied into Analytics Engine. The salt expires after
 *   48 hours, so the hash cannot be rebuilt.
 *
 * GET /api/page-visits?days=7|30|90
 *   Owner session (Authorization: Bearer, X-Schedi-Session, cookie, ?session=,
 *   or JSON session). Returns that owner's totals, daily series, locations,
 *   sources, devices, and browsers.
 * POST { action:'read', session, days } is the same read.
 *
 * GET /api/page-visits?scope=agency&days=30
 *   or POST { action:'agency', session, days }
 *   Agency session or Authorization: Bearer <OPS_SNAPSHOT_TOKEN>, same gate as
 *   /api/ops-snapshot. An owner session is 403.
 *
 * Storage is Workers Analytics Engine (dataset schedi_page_visits). Reads use
 * the Analytics SQL binding. AUTH_KV holds only the daily salt, the seen-set,
 * and a short "this business exists" cache.
 */
import { readSession } from './owner-auth.js';
import { authorizeBearerOrAgency, sessionTokenFromRequest } from './agency-session.js';
import { rateLimitOk as defaultRateLimitOk } from './rate-limit.js';

const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const DATASET = 'schedi_page_visits';
const RANGES = { 7: 7, 30: 30, 90: 90 };
const SEEN_TTL = 36 * 60 * 60;
const SALT_TTL = 48 * 60 * 60;
const TENANT_OK_TTL = 6 * 60 * 60;
const TENANT_MISS_TTL = 2 * 60;
const BOT_RE = /bot|crawl|spider|slurp|preview|wget|curl|python-requests|go-http-client|headless|phantom|selenium|puppeteer|playwright|bytespider|petalbot|ahrefs|semrush|facebookexternalhit|embedly|whatsapp|telegrambot|slackbot|discordbot|linkedinbot|twitterbot|applebot/i;

const SOURCE_FROM_TOKEN = {
  qr: 'QR',
  qrcode: 'QR',
  instagram: 'Instagram',
  ig: 'Instagram',
  facebook: 'Facebook',
  fb: 'Facebook',
  google: 'Google',
  tiktok: 'TikTok',
};

export function safeTenantId(value) {
  const id = String(value || '').trim();
  return TENANT_RE.test(id) ? id : '';
}

export function utcDay(now) {
  const date = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export function shiftDay(iso, days) {
  const match = DAY_RE.exec(String(iso || ''));
  if (!match) return '';
  const dt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (dt.getUTCFullYear() !== Number(match[1]) || dt.getUTCMonth() !== Number(match[2]) - 1 || dt.getUTCDate() !== Number(match[3])) return '';
  dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
  return dt.toISOString().slice(0, 10);
}

export function eachDay(from, to) {
  const start = shiftDay(from, 0);
  const end = shiftDay(to, 0);
  if (!start || !end || start > end) return [];
  const days = [];
  let cursor = start;
  while (cursor && cursor <= end) {
    if (days.length > 90) return [];
    days.push(cursor);
    cursor = shiftDay(cursor, 1);
  }
  return days;
}

export function isLikelyBot(userAgent) {
  const ua = String(userAgent || '').trim();
  if (!ua || ua.length > 300) return true;
  return BOT_RE.test(ua);
}

export function botSignal(request) {
  const cf = (request && request.cf) || {};
  const bot = cf.botManagement || null;
  if (bot && bot.verifiedBot === true) return 'verified_bot';
  if (bot && typeof bot.score === 'number' && bot.score > 0 && bot.score < 30) return 'bot_score';
  if (cf.verifiedBotCategory) return 'verified_bot';
  return '';
}

export function classifyDevice(userAgent) {
  const ua = String(userAgent || '');
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone|webOS/i.test(ua)) return 'mobile';
  return 'desktop';
}

export function classifyBrowser(userAgent) {
  const ua = String(userAgent || '');
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung';
  if (/Firefox\/|FxiOS/i.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS/i.test(ua)) return 'Chrome';
  if (/Safari/i.test(ua)) return 'Safari';
  return 'Other';
}

function hostIs(host, root) {
  const name = String(host || '').toLowerCase().replace(/\.$/, '');
  return name === root || name.endsWith('.' + root);
}

function cleanHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || !HOST_RE.test(host)) return '';
  if (hostIs(host, 'schedi.app')) return '';
  return host;
}

function tokenSource(value) {
  const token = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
  return SOURCE_FROM_TOKEN[token] || '';
}

function sourceFromUa(userAgent) {
  const ua = String(userAgent || '');
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'Facebook';
  if (/TikTok|musical_ly/i.test(ua)) return 'TikTok';
  return '';
}

function sourceFromHost(host) {
  if (!host) return '';
  if (hostIs(host, 'instagram.com') || hostIs(host, 'instagr.am')) return 'Instagram';
  if (hostIs(host, 'facebook.com') || hostIs(host, 'fb.com') || hostIs(host, 'fb.me')) return 'Facebook';
  if (hostIs(host, 'tiktok.com')) return 'TikTok';
  if (/(^|\.)google\./i.test(host) || hostIs(host, 'google.com')) return 'Google';
  return '';
}

/**
 * Bucket a visit. QR wins when src or utm_source says so. The raw referrer
 * and user agent are not returned.
 */
export function bucketSource(input) {
  const src = input && input.src;
  const utm = input && input.utmSource;
  if (tokenSource(src) === 'QR' || tokenSource(utm) === 'QR') return 'QR';
  const fromUtm = tokenSource(utm) || tokenSource(src);
  if (fromUtm) return fromUtm;
  const fromHost = sourceFromHost(cleanHost(input && input.refHost));
  if (fromHost) return fromHost;
  const fromUa = sourceFromUa(input && input.userAgent);
  if (fromUa) return fromUa;
  if (!cleanHost(input && input.refHost)) return 'direct';
  return 'other';
}

function clipLabel(value, max) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = text.slice(0, max || 80);
  return cut || 'unknown';
}

function countryCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : 'unknown';
}

export function visitDimensions(request, body) {
  const cf = (request && request.cf) || {};
  const ua = String((request && request.headers && request.headers.get('User-Agent')) || '');
  const referer = String((request && request.headers && request.headers.get('Referer')) || '');
  let refererSrc = '';
  let refererUtm = '';
  let refererDemo = false;
  try {
    const url = new URL(referer);
    refererSrc = url.searchParams.get('src') || '';
    refererUtm = url.searchParams.get('utm_source') || '';
    refererDemo = url.searchParams.get('demo') === '1' || url.searchParams.get('preview') === '1';
  } catch (_) {
    refererSrc = '';
  }
  const source = bucketSource({
    src: (body && body.src) || refererSrc,
    utmSource: (body && body.utmSource) || refererUtm,
    refHost: body && body.refHost,
    userAgent: ua,
  });
  return {
    country: countryCode(cf.country),
    region: clipLabel(cf.region || cf.regionCode || 'unknown', 80),
    city: clipLabel(cf.city || 'unknown', 80),
    device: classifyDevice(ua),
    browser: classifyBrowser(ua),
    source,
    refererDemo,
  };
}

function clientIp(request) {
  const headers = request && request.headers;
  if (!headers || typeof headers.get !== 'function') return '';
  return String(headers.get('CF-Connecting-IP') || '').trim();
}

async function hmacHex(salt, ip) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(salt)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(ip)));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  return hex.slice(0, 32);
}

async function dailySalt(kv, day) {
  const key = 'visitSalt:' + day;
  const existing = await kv.get(key);
  if (existing) return String(existing);
  const salt = crypto.randomUUID() + crypto.randomUUID();
  await kv.put(key, salt, { expirationTtl: SALT_TTL });
  return salt;
}

/** 1 the first time this IP is seen for the business today, else 0. The hash is not returned. */
async function uniqueBit(kv, tenantId, day, ip) {
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function' || !ip) return 0;
  const salt = await dailySalt(kv, day);
  const hash = await hmacHex(salt, ip);
  const key = 'visitSeen:' + tenantId + ':' + day + ':' + hash;
  const seen = await kv.get(key);
  if (seen) return 0;
  await kv.put(key, '1', { expirationTtl: SEEN_TTL });
  return 1;
}

function bearer(request) {
  const header = String((request && request.headers && request.headers.get('Authorization')) || '');
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : '';
}

function timingSafeEqualStr(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  let diff = left.length ^ right.length;
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return diff === 0;
}

function respond(deps, origin, body, status) {
  const base = deps.json(body, status, origin);
  const headers = new Headers(base.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  headers.delete('Set-Cookie');
  return new Response(JSON.stringify(body), { status, headers });
}

function rangeFromDays(days, now) {
  const n = RANGES[Number(days)];
  if (!n) return null;
  const to = utcDay(now || new Date());
  const from = shiftDay(to, 1 - n);
  if (!from || !to) return null;
  return { days: n, from, to };
}

function num(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

function rowsOf(result) {
  if (!result) return [];
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result)) return result;
  return [];
}

function datasetSql() {
  return 'events.analyticsEngine.' + DATASET;
}

function isMissingDataset(err) {
  const msg = String((err && (err.message || err)) || '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('unknown table') || msg.includes('no such') || msg.includes('not found');
}

async function runQuery(env, query, params) {
  const binding = env && env.ANALYTICS_SQL;
  if (!binding || typeof binding.query !== 'function') {
    const err = new Error('visits_unconfigured');
    err.code = 'visits_unconfigured';
    throw err;
  }
  return binding.query({ query, params: params || {} });
}

export function fillSeries(from, to, rows) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const date = String(row.day || row.date || '').slice(0, 10);
    if (!DAY_RE.test(date)) return;
    map.set(date, { date, views: num(row.views), uniques: num(row.uniques) });
  });
  return eachDay(from, to).map((date) => map.get(date) || { date, views: 0, uniques: 0 });
}

function sumSeries(series) {
  return series.reduce((acc, row) => {
    acc.views += row.views;
    acc.uniques += row.uniques;
    return acc;
  }, { views: 0, uniques: 0 });
}

async function queryReport(env, tenantId, range) {
  const table = datasetSql();
  const where = tenantId
    ? 'index1 = $tenant AND blob1 >= $from AND blob1 <= $to'
    : 'blob1 >= $from AND blob1 <= $to';
  const params = tenantId
    ? { tenant: tenantId, from: range.from, to: range.to }
    : { from: range.from, to: range.to };
  const seriesSql = 'SELECT blob1 AS day, SUM(_sample_interval) AS views, SUM(_sample_interval * double2) AS uniques FROM '
    + table + ' WHERE ' + where + ' GROUP BY day ORDER BY day';
  const locationSql = 'SELECT blob4 AS city, blob3 AS region, blob2 AS country, SUM(_sample_interval) AS views FROM '
    + table + ' WHERE ' + where + ' GROUP BY city, region, country ORDER BY views DESC LIMIT 8';
  const sourceSql = 'SELECT blob7 AS label, SUM(_sample_interval) AS views FROM '
    + table + ' WHERE ' + where + ' GROUP BY label ORDER BY views DESC LIMIT 8';
  const deviceSql = 'SELECT blob5 AS label, SUM(_sample_interval) AS views FROM '
    + table + ' WHERE ' + where + ' GROUP BY label ORDER BY views DESC LIMIT 8';
  const browserSql = 'SELECT blob6 AS label, SUM(_sample_interval) AS views FROM '
    + table + ' WHERE ' + where + ' GROUP BY label ORDER BY views DESC LIMIT 8';
  let seriesRows;
  let locationRows;
  let sourceRows;
  let deviceRows;
  let browserRows;
  try {
    const results = await Promise.all([
      runQuery(env, seriesSql, params),
      runQuery(env, locationSql, params),
      runQuery(env, sourceSql, params),
      runQuery(env, deviceSql, params),
      runQuery(env, browserSql, params),
    ]);
    seriesRows = rowsOf(results[0]);
    locationRows = rowsOf(results[1]);
    sourceRows = rowsOf(results[2]);
    deviceRows = rowsOf(results[3]);
    browserRows = rowsOf(results[4]);
  } catch (err) {
    if (err && err.code === 'visits_unconfigured') throw err;
    if (isMissingDataset(err)) {
      seriesRows = [];
      locationRows = [];
      sourceRows = [];
      deviceRows = [];
      browserRows = [];
    } else {
      throw err;
    }
  }
  const series = fillSeries(range.from, range.to, seriesRows);
  const totals = sumSeries(series);
  const locations = locationRows.map((row) => ({
    city: clipLabel(row.city || 'unknown', 80),
    region: clipLabel(row.region || 'unknown', 80),
    country: countryCode(row.country),
    views: num(row.views),
  })).filter((row) => row.views > 0);
  const labeled = (list) => list.map((row) => ({
    label: clipLabel(row.label || 'unknown', 40),
    views: num(row.views),
  })).filter((row) => row.views > 0);
  return {
    days: range.days,
    from: range.from,
    to: range.to,
    views: totals.views,
    uniques: totals.uniques,
    series,
    locations,
    sources: labeled(sourceRows),
    devices: labeled(deviceRows),
    browsers: labeled(browserRows),
  };
}

async function queryAgency(env, range) {
  const sql = 'SELECT index1 AS tenantId, SUM(_sample_interval) AS views, SUM(_sample_interval * double2) AS uniques FROM '
    + datasetSql()
    + ' WHERE blob1 >= $from AND blob1 <= $to GROUP BY tenantId ORDER BY views DESC LIMIT 500';
  let rows = [];
  try {
    rows = rowsOf(await runQuery(env, sql, { from: range.from, to: range.to }));
  } catch (err) {
    if (err && err.code === 'visits_unconfigured') throw err;
    if (!isMissingDataset(err)) throw err;
    rows = [];
  }
  const businesses = [];
  rows.forEach((row) => {
    const tenantId = safeTenantId(row.tenantId || row.index1);
    if (!tenantId) return;
    businesses.push({ tenantId, views: num(row.views), uniques: num(row.uniques) });
  });
  return { days: range.days, from: range.from, to: range.to, businesses };
}

async function ownerSession(env, request, body) {
  const token = sessionTokenFromRequest(request, body || {});
  if (token) {
    const session = await readSession(env, token);
    if (session) return session;
  }
  const auth = bearer(request);
  if (auth && auth !== token) {
    const session = await readSession(env, auth);
    if (session) return session;
  }
  try {
    const query = new URL(request.url).searchParams.get('session') || '';
    if (query && query !== token && query !== auth) return readSession(env, query);
  } catch (_) {}
  return null;
}

function wantsAgency(request, body) {
  if (body && (body.action === 'agency' || body.scope === 'agency')) return true;
  try {
    const url = new URL(request.url);
    const scope = String(url.searchParams.get('scope') || url.searchParams.get('all') || '');
    return scope === 'agency' || scope === '1' || scope === 'all';
  } catch (_) {
    return false;
  }
}

async function limitOk(env, deps, key, localLimit, scope) {
  const limit = deps.rateLimitOk || defaultRateLimitOk;
  return limit(env && env.RL_PAGE_VISITS, key, localLimit, scope);
}

export async function handlePageVisits(request, env, origin, deps) {
  const tools = deps || {};
  const allowed = tools.isAllowedOrigin || (() => true);
  if (origin && !allowed(origin)) return new Response(null, { status: 403 });
  if (request.method === 'OPTIONS') {
    const headers = new Headers(tools.json({}, 204, origin).headers);
    headers.delete('Content-Type');
    headers.delete('Set-Cookie');
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    return respond(tools, origin, { ok: false, error: 'method_not_allowed' }, 405);
  }

  let body = {};
  if (request.method === 'POST') {
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > 4096) return respond(tools, origin, { ok: false, error: 'too_large' }, 413);
    let text = '';
    try { text = await request.text(); } catch (_) { text = ''; }
    if (text.length > 4096) return respond(tools, origin, { ok: false, error: 'too_large' }, 413);
    if (text) {
      try { body = JSON.parse(text); } catch (_) {
        return respond(tools, origin, { ok: false, error: 'bad_json' }, 400);
      }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
  }

  const action = request.method === 'GET'
    ? (wantsAgency(request, body) ? 'agency' : 'read')
    : String(body.action || 'count');
  if (action === 'read') return readOwnerVisits(request, env, origin, tools, body);
  if (action === 'agency') return readAgencyVisits(request, env, origin, tools, body);
  if (action !== 'count') return respond(tools, origin, { ok: false, error: 'bad_action' }, 400);
  return countPageVisit(request, env, origin, tools, body);
}

async function countPageVisit(request, env, origin, deps, body) {
  const tenantId = safeTenantId(body.tenantId);
  if (!tenantId) return respond(deps, origin, { ok: false, error: 'bad_tenant' }, 400);
  const tenantLimited = await limitOk(env, deps, 't:' + tenantId, 120, 'page-visits');
  const allLimited = tenantLimited && await limitOk(env, deps, 'all', 600, 'page-visits-all');
  if (!tenantLimited || !allLimited) return respond(deps, origin, { ok: false, error: 'rate_limited' }, 429);

  if (body.preview === true || body.demo === true || String(body.preview || '') === '1' || String(body.demo || '') === '1') {
    return respond(deps, origin, { ok: true, skipped: 'preview' }, 200);
  }
  if (isLikelyBot(request.headers.get('User-Agent')) || botSignal(request)) {
    return respond(deps, origin, { ok: true, skipped: 'bot' }, 200);
  }
  const presented = sessionTokenFromRequest(request, body);
  if (presented) {
    const session = await readSession(env, presented);
    if (session && (session.role === 'owner' || session.role === 'agency')) {
      return respond(deps, origin, { ok: true, skipped: 'session' }, 200);
    }
  }

  const exists = deps.tenantExists || (async () => true);
  let known;
  try { known = await exists(tenantId); } catch (_) { known = null; }
  if (known === null) return respond(deps, origin, { ok: false, error: 'tenant_lookup_failed' }, 503);
  if (!known) return respond(deps, origin, { ok: false, error: 'not_found' }, 404);

  const dims = visitDimensions(request, body);
  if (dims.refererDemo) return respond(deps, origin, { ok: true, skipped: 'preview' }, 200);

  const dataset = env && env.PAGE_VISITS;
  if (!dataset || typeof dataset.writeDataPoint !== 'function') {
    return respond(deps, origin, { ok: true, skipped: 'unconfigured' }, 200);
  }
  const day = utcDay(deps.now ? deps.now() : new Date());
  const ip = clientIp(request);
  const unique = await uniqueBit(env && env.AUTH_KV, tenantId, day, ip);
  try {
    dataset.writeDataPoint({
      indexes: [tenantId],
      blobs: [day, dims.country, dims.region, dims.city, dims.device, dims.browser, dims.source],
      doubles: [1, unique],
    });
  } catch (_) {
    return respond(deps, origin, { ok: false, error: 'visit_write_failed' }, 502);
  }
  return respond(deps, origin, { ok: true }, 200);
}

async function readOwnerVisits(request, env, origin, deps, body) {
  const session = await ownerSession(env, request, body);
  if (!session) return respond(deps, origin, { ok: false, error: 'session_required' }, 401);
  if (session.role !== 'owner') return respond(deps, origin, { ok: false, error: 'forbidden' }, 403);
  const tenantId = safeTenantId(session.tenantId);
  if (!tenantId) return respond(deps, origin, { ok: false, error: 'forbidden' }, 403);
  let asked = safeTenantId(body.tenantId || '');
  try {
    if (!asked) asked = safeTenantId(new URL(request.url).searchParams.get('tenantId') || '');
  } catch (_) {}
  if (asked && asked !== tenantId) return respond(deps, origin, { ok: false, error: 'forbidden' }, 403);
  let days = body.days;
  try {
    if (days == null) days = new URL(request.url).searchParams.get('days');
  } catch (_) {}
  const range = rangeFromDays(days, deps.now ? deps.now() : new Date());
  if (!range) return respond(deps, origin, { ok: false, error: 'bad_range' }, 400);
  if (!(await limitOk(env, deps, 'read:' + tenantId, 60, 'page-visits-read'))) {
    return respond(deps, origin, { ok: false, error: 'rate_limited' }, 429);
  }
  try {
    const report = await queryReport(env, tenantId, range);
    return respond(deps, origin, Object.assign({ ok: true, tenantId }, report), 200);
  } catch (err) {
    if (err && err.code === 'visits_unconfigured') {
      return respond(deps, origin, { ok: false, error: 'visits_unconfigured' }, 503);
    }
    return respond(deps, origin, { ok: false, error: 'visits_query_failed' }, 502);
  }
}

async function readAgencyVisits(request, env, origin, deps, body) {
  const expected = String((env && env.OPS_SNAPSHOT_TOKEN) || '').trim();
  const given = bearer(request);
  const bearerOk = !!(expected && given && timingSafeEqualStr(given, expected));
  const gate = await authorizeBearerOrAgency(env, request, body, bearerOk);
  if (!gate.ok) return respond(deps, origin, { ok: false, error: gate.error }, gate.status);
  let days = body.days;
  try {
    if (days == null) days = new URL(request.url).searchParams.get('days');
  } catch (_) {}
  const range = rangeFromDays(days == null || days === '' ? 30 : days, deps.now ? deps.now() : new Date());
  if (!range) return respond(deps, origin, { ok: false, error: 'bad_range' }, 400);
  if (!(await limitOk(env, deps, 'agency', 30, 'page-visits-agency'))) {
    return respond(deps, origin, { ok: false, error: 'rate_limited' }, 429);
  }
  try {
    const report = await queryAgency(env, range);
    return respond(deps, origin, Object.assign({ ok: true }, report), 200);
  } catch (err) {
    if (err && err.code === 'visits_unconfigured') {
      return respond(deps, origin, { ok: false, error: 'visits_unconfigured' }, 503);
    }
    return respond(deps, origin, { ok: false, error: 'visits_query_failed' }, 502);
  }
}

export async function visitTenantExists(env, tenantId) {
  const id = safeTenantId(tenantId);
  if (!id) return false;
  const kv = env && env.AUTH_KV;
  const cacheKey = 'visitTenantOk:' + id;
  if (kv && typeof kv.get === 'function') {
    const hit = await kv.get(cacheKey);
    if (hit === '1') return true;
    if (hit === '0') return false;
  }
  const apiKey = String((env && env.FIREBASE_API_KEY) || '').trim();
  if (!apiKey) return null;
  const projectId = String((env && env.FIREBASE_PROJECT_ID) || 'siteforge-97699').trim();
  const appId = String((env && env.FIREBASE_APP_ID) || 'siteforge-97699').trim();
  let token = '';
  try {
    const signup = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + encodeURIComponent(apiKey),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }),
      },
    );
    const data = await signup.json().catch(() => ({}));
    if (!signup.ok || !data.idToken) return null;
    token = data.idToken;
  } catch (_) {
    return null;
  }
  const url = 'https://firestore.googleapis.com/v1/projects/' + projectId
    + '/databases/(default)/documents/artifacts/' + appId
    + '/public/data/tenants/' + encodeURIComponent(id)
    + '?mask.fieldPaths=name';
  try {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 404) {
      if (kv && typeof kv.put === 'function') await kv.put(cacheKey, '0', { expirationTtl: TENANT_MISS_TTL });
      return false;
    }
    if (!res.ok) return null;
    if (kv && typeof kv.put === 'function') await kv.put(cacheKey, '1', { expirationTtl: TENANT_OK_TTL });
    return true;
  } catch (_) {
    return null;
  }
}
