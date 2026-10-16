/**
 * Privacy-friendly per-tenant daily page-visit counter.
 *
 * POST /api/page-visits { tenantId }
 *   Adds one to today's UTC count after the tenant id checks out.
 *   Obvious bots are skipped. Nothing about the visitor is stored: no cookie,
 *   no IP, no user agent. The only value written is an integer at
 *   AUTH_KV key pageVisits:{tenantId}:{YYYY-MM-DD}, kept for 400 days.
 *   KV has no atomic increment, so two hits in the same instant can under-count.
 *   The rate limit is per tenant (and one global bucket), never per IP.
 *
 * GET /api/page-visits?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   Owner session required (Authorization: Bearer, or ?session=).
 *   An owner can read only their own business. An agency session may pass tenantId.
 * POST { action:'read', session, from, to } is the same read.
 *
 * The public booking page does not call this yet. When that page is next edited,
 * one line inside its script is enough (tenant.id is already in that template):
 * fetch('https://schedi.app/api/page-visits',{method:'POST',headers:{'Content-Type':'application/json'},keepalive:true,body:JSON.stringify({tenantId:TENANT_ID})});
 */
import { readSession as readOwnerSession } from './owner-auth.js';
import { rateLimitOk as defaultRateLimitOk } from './rate-limit.js';

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_DAYS = 366;
const TTL_SECONDS = 400 * 24 * 60 * 60;
const BOT_RE = /bot|crawl|spider|slurp|preview|wget|curl|python-requests|go-http-client|headless|phantom|selenium|puppeteer|playwright|bytespider|petalbot|ahrefs|semrush|facebookexternalhit|embedly|whatsapp|telegrambot|slackbot|discordbot|linkedinbot|twitterbot|applebot/i;

export function isLikelyBot(userAgent) {
  const ua = String(userAgent || '').trim();
  if (!ua || ua.length > 300) return true;
  return BOT_RE.test(ua);
}

export function utcDay(now) {
  const date = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export function shiftDay(iso, days) {
  const m = DAY_RE.exec(String(iso || ''));
  if (!m) return '';
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (dt.getUTCFullYear() !== Number(m[1]) || dt.getUTCMonth() !== Number(m[2]) - 1 || dt.getUTCDate() !== Number(m[3])) return '';
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
    if (days.length >= MAX_DAYS) return [];
    days.push(cursor);
    cursor = shiftDay(cursor, 1);
  }
  return days;
}

export function visitKey(tenantId, day) {
  return 'pageVisits:' + tenantId + ':' + day;
}

export function safeTenantId(value) {
  const id = String(value || '').trim();
  return TENANT_RE.test(id) ? id : '';
}

function bearer(request) {
  const header = String((request.headers && request.headers.get('Authorization')) || '');
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : '';
}

function respond(deps, origin, body, status) {
  const base = deps.json(body, status, origin);
  const headers = new Headers(base.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  headers.delete('Set-Cookie');
  return new Response(JSON.stringify(body), { status, headers });
}

async function ownerSession(deps, env, request, body) {
  const readSession = deps.readSession || readOwnerSession;
  const url = new URL(request.url);
  const token = bearer(request) || String((body && body.session) || url.searchParams.get('session') || '');
  if (!token) return null;
  return readSession(env, token);
}

function sessionCanRead(session, requestedId) {
  if (!session) return { error: 'session_required', status: 401 };
  if (session.role === 'agency') {
    const id = safeTenantId(requestedId);
    if (!id) return { error: 'bad_tenant', status: 400 };
    return { tenantId: id };
  }
  const own = session.role === 'owner' ? safeTenantId(session.tenantId) : '';
  if (!own) return { error: 'forbidden', status: 403 };
  const asked = safeTenantId(requestedId);
  if (asked && asked !== own) return { error: 'forbidden', status: 403 };
  return { tenantId: own };
}

async function readCounts(kv, tenantId, from, to) {
  const days = eachDay(from, to);
  if (!days.length) return null;
  const rows = [];
  for (const day of days) {
    const raw = await kv.get(visitKey(tenantId, day));
    const count = Math.max(0, parseInt(raw || '0', 10) || 0);
    rows.push({ date: day, count });
  }
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return { from: days[0], to: days[days.length - 1], total, days: rows };
}

export async function handlePageVisits(request, env, origin, deps) {
  const allowed = deps.isAllowedOrigin || (() => true);
  if (origin && !allowed(origin)) return new Response(null, { status: 403 });
  if (request.method === 'OPTIONS') {
    const headers = new Headers(deps.json({}, 204, origin).headers);
    headers.delete('Content-Type');
    headers.delete('Set-Cookie');
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    return respond(deps, origin, { ok: false, error: 'method_not_allowed' }, 405);
  }

  let body = {};
  if (request.method === 'POST') {
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > 4096) return respond(deps, origin, { ok: false, error: 'too_large' }, 413);
    let text = '';
    try { text = await request.text(); } catch (_) { text = ''; }
    if (text.length > 4096) return respond(deps, origin, { ok: false, error: 'too_large' }, 413);
    if (text) {
      try { body = JSON.parse(text); } catch (_) {
        return respond(deps, origin, { ok: false, error: 'bad_json' }, 400);
      }
    }
    if (!body || typeof body !== 'object') body = {};
  }

  const action = request.method === 'GET' ? 'read' : String(body.action || 'count');
  if (action === 'read') return readPageVisits(request, env, origin, deps, body);
  if (action !== 'count') return respond(deps, origin, { ok: false, error: 'bad_action' }, 400);
  return countPageVisit(request, env, origin, deps, body);
}

async function countPageVisit(request, env, origin, deps, body) {
  const tenantId = safeTenantId(body.tenantId);
  if (!tenantId) return respond(deps, origin, { ok: false, error: 'bad_tenant' }, 400);
  const limit = deps.rateLimitOk || defaultRateLimitOk;
  const tenantOk = await limit(env && env.RL_PAGE_VISITS, 't:' + tenantId, 60, 'page-visits');
  const allOk = tenantOk && await limit(env && env.RL_PAGE_VISITS, 'all', 240, 'page-visits-all');
  if (!tenantOk || !allOk) return respond(deps, origin, { ok: false, error: 'rate_limited' }, 429);

  if (isLikelyBot(request.headers.get('User-Agent'))) {
    return respond(deps, origin, { ok: true, skipped: 'bot' }, 200);
  }

  const exists = deps.tenantExists || (async () => true);
  let known;
  try { known = await exists(tenantId); } catch (_) { known = null; }
  if (known === null) return respond(deps, origin, { ok: false, error: 'tenant_lookup_failed' }, 503);
  if (!known) return respond(deps, origin, { ok: false, error: 'not_found' }, 404);

  const kv = env && env.AUTH_KV;
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    return respond(deps, origin, { ok: false, error: 'visits_unconfigured' }, 503);
  }
  const day = utcDay(deps.now ? deps.now() : new Date());
  const key = visitKey(tenantId, day);
  const raw = await kv.get(key);
  const next = (Math.max(0, parseInt(raw || '0', 10) || 0)) + 1;
  await kv.put(key, String(next), { expirationTtl: TTL_SECONDS });
  return respond(deps, origin, { ok: true }, 200);
}

async function readPageVisits(request, env, origin, deps, body) {
  const session = await ownerSession(deps, env, request, body);
  const url = new URL(request.url);
  const requested = body.tenantId || url.searchParams.get('tenantId') || '';
  const gate = sessionCanRead(session, requested);
  if (gate.error) return respond(deps, origin, { ok: false, error: gate.error }, gate.status);
  const from = String((body && body.from) || url.searchParams.get('from') || '');
  const to = String((body && body.to) || url.searchParams.get('to') || '');
  if (!eachDay(from, to).length) return respond(deps, origin, { ok: false, error: 'bad_range' }, 400);
  const limit = deps.rateLimitOk || defaultRateLimitOk;
  if (!(await limit(env && env.RL_PAGE_VISITS, 'read:' + gate.tenantId, 60, 'page-visits-read'))) {
    return respond(deps, origin, { ok: false, error: 'rate_limited' }, 429);
  }
  const kv = env && env.AUTH_KV;
  if (!kv || typeof kv.get !== 'function') {
    return respond(deps, origin, { ok: false, error: 'visits_unconfigured' }, 503);
  }
  const report = await readCounts(kv, gate.tenantId, from, to);
  if (!report) return respond(deps, origin, { ok: false, error: 'bad_range' }, 400);
  return respond(deps, origin, Object.assign({ ok: true, tenantId: gate.tenantId }, report), 200);
}
