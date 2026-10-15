/**
 * Resend email engagement capture (opens / clicks / delivery) for Schedi mail.
 *
 * POST /api/resend-events   Resend webhook receiver (Svix-signed; secret RESEND_WEBHOOK_SECRET = whsec_...)
 *
 * Storage: one KV key per webhook delivery, so concurrent events never overwrite each other:
 *   emailEvt:e:<email_id>:<svix-id>   value "1", small metadata (type, time, sender, masked recipient, subject, link)
 * Retries reuse the same svix-id, so they land on the same key (idempotent).
 * Aggregated at read time by buildEmailEngagement() for /api/ops-snapshot.
 *
 * Data kept minimal: no bodies, no IPs, no user agents, no full recipient address
 * (masked local part + domain + short SHA-256 used only to match a business owner).
 * Mail from bookings@ goes to end clients, so for those only the recipient domain is kept and no subject.
 */

export const EMAIL_EVT_PREFIX = 'emailEvt:e:';
const TTL_SEC = 180 * 24 * 3600;
const TOLERANCE_SEC = 5 * 60;
const TZ = 'America/New_York';

const TYPE_MAP = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
};

function j(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Svix signature check. Returns true when any v1 signature in the header matches. */
export async function verifySvix(secret, id, timestamp, sigHeader, body, nowSec) {
  if (!secret || !id || !timestamp || !sigHeader) return false;
  const ts = parseInt(timestamp, 10);
  const now = nowSec || Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TOLERANCE_SEC) return false;
  let keyBytes;
  try {
    keyBytes = b64ToBytes(String(secret).trim().replace(/^whsec_/, ''));
  } catch (_) {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const expected = bytesToB64(mac);
  for (const part of String(sigHeader).split(' ')) {
    const [ver, sig] = part.split(',');
    if (ver === 'v1' && sig && safeEq(sig, expected)) return true;
  }
  return false;
}

export async function shortHash(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return '';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(e));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bareAddress(v) {
  const s = String(v || '');
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

function maskEmail(addr) {
  const a = bareAddress(addr);
  const at = a.lastIndexOf('@');
  if (at < 1) return '';
  return a[0] + '***' + a.slice(at);
}

function stripLink(u) {
  try {
    const x = new URL(String(u));
    return (x.origin + x.pathname).slice(0, 150);
  } catch (_) {
    return String(u || '').split(/[?#]/)[0].slice(0, 150);
  }
}

function toMs(v) {
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

/** Resend ids are UUIDv7: the first 48 bits are the creation time in ms. */
export function uuidv7Ms(id) {
  const hex = String(id || '').replace(/-/g, '').slice(0, 12);
  if (!/^[0-9a-f]{12}$/i.test(hex)) return null;
  const ms = parseInt(hex, 16);
  return ms > 1.6e12 && ms < 4.1e12 ? ms : null;
}

export async function handleResendEventsHttp(request, env) {
  if (request.method !== 'POST') return j({ ok: false, error: 'method_not_allowed' }, 405);
  const secret = String(env.RESEND_WEBHOOK_SECRET || '').trim();
  if (!secret) return j({ ok: false, error: 'not_configured' }, 503); // Resend retries, so nothing is lost while unset
  if (!env.AUTH_KV) return j({ ok: false, error: 'no_kv' }, 500);
  const body = await request.text();
  if (body.length > 64 * 1024) return j({ ok: false, error: 'too_large' }, 413);
  const id = request.headers.get('svix-id') || '';
  const ts = request.headers.get('svix-timestamp') || '';
  const sig = request.headers.get('svix-signature') || '';
  const ok = await verifySvix(secret, id, ts, sig, body);
  if (!ok) return j({ ok: false, error: 'invalid_signature' }, 401);

  let evt;
  try { evt = JSON.parse(body); } catch (_) { return j({ ok: false, error: 'bad_json' }, 400); }
  const t = TYPE_MAP[evt && evt.type];
  const data = (evt && evt.data) || {};
  const emailId = String(data.email_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (!t || !emailId) return j({ ok: true, ignored: true }, 200);

  const from = bareAddress(data.from);
  if (!from.endsWith('@schedi.app')) return j({ ok: true, ignored: 'not_schedi_sender' }, 200);
  const sender = from.split('@')[0];
  const toList = Array.isArray(data.to) ? data.to : (data.to ? [data.to] : []);
  const to0 = bareAddress(toList[0]);
  const isClient = sender === 'bookings';
  const meta = {
    t,
    at: (t === 'clicked' && data.click && toMs(data.click.timestamp)) || toMs(evt.created_at) || Date.now(),
    f: sender,
    d: to0.includes('@') ? to0.split('@').pop().slice(0, 60) : '',
  };
  const created = toMs(data.created_at);
  if (created) meta.c = created;
  if (!isClient) {
    meta.r = maskEmail(to0);
    meta.h = await shortHash(to0);
    if (data.subject) meta.s = String(data.subject).slice(0, 90);
  }
  if (toList.length > 1) meta.n = toList.length;
  if (t === 'clicked' && data.click && data.click.link) meta.l = stripLink(data.click.link);
  if (t === 'bounced' && data.bounce) meta.bt = String(data.bounce.type || data.bounce.subType || '').slice(0, 30);
  if (data.tags && typeof data.tags === 'object' && data.tags.category) meta.g = String(data.tags.category).slice(0, 30);

  const svixKey = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  await env.AUTH_KV.put(EMAIL_EVT_PREFIX + emailId + ':' + svixKey, '1', { metadata: meta, expirationTtl: TTL_SEC });
  return j({ ok: true }, 200);
}

/* ---------------- Aggregation for the ops snapshot ---------------- */

function etString(ms) {
  if (!ms) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
    }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toISOString();
  }
}

const STATUS_RANK = { seed: 0, sent: 1, delayed: 2, delivered: 3, opened: 4, clicked: 5, suppressed: 6, failed: 7, bounced: 8, complained: 9 };

export async function buildEmailEngagement(env, tenants, nowMs) {
  const now = nowMs || Date.now();
  const d1 = now - 864e5;
  const d7 = now - 7 * 864e5;
  const out = {
    webhookConfigured: !!String(env.RESEND_WEBHOOK_SECRET || '').trim(),
    webhookUrl: 'https://schedi-email-worker.axl199.workers.dev/api/resend-events',
    eventsStored: 0,
    lastEventAtET: null,
    trackingSeen: { opens: false, clicks: false },
    last24h: { sent: 0, delivered: 0, opens: 0, uniqueOpened: 0, clicks: 0, uniqueClicked: 0, bounced: 0, complained: 0 },
    last7d: { sent: 0, delivered: 0, opens: 0, uniqueOpened: 0, clicks: 0, uniqueClicked: 0, bounced: 0, complained: 0 },
    bySender7d: {},
    recent: [],
    notes: [],
  };
  if (!env.AUTH_KV) { out.notes.push('no KV binding'); return out; }

  const keys = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const l = await env.AUTH_KV.list({ prefix: EMAIL_EVT_PREFIX, limit: 1000, cursor });
    keys.push(...(l.keys || []));
    if (l.list_complete || !l.cursor) break;
    cursor = l.cursor;
  }
  out.eventsStored = keys.length;

  const byHash = {};
  const bySlug = {};
  for (const t of tenants || []) {
    const slug = String(t.slug || t.id || t.__docId || '');
    const info = { slug, businessName: String(t.name || t.businessName || '') };
    bySlug[slug] = info;
    if (t.ownerEmail) byHash[await shortHash(t.ownerEmail)] = info;
  }

  const emails = new Map();
  let lastEvent = 0;
  for (const k of keys) {
    const m = k.metadata || {};
    const rest = k.name.slice(EMAIL_EVT_PREFIX.length);
    const emailId = rest.split(':')[0];
    if (!emailId) continue;
    let e = emails.get(emailId);
    if (!e) {
      e = { emailId, sender: '', recipient: null, recipientDomain: '', h: '', slug: '', subject: null, note: null, category: null,
        sentMs: null, createdMs: null, deliveredMs: null, bouncedMs: null, complainedMs: null, failed: false, suppressed: false, delayed: false,
        opens: [], clicks: [], links: {}, status: 'unknown', source: 'webhook', seeded: false, live: false, recipients: 1 };
      emails.set(emailId, e);
    }
    const at = Number(m.at) || null;
    if (m.t !== 'seed' && at && at > lastEvent) lastEvent = at;
    if (m.f && !e.sender) e.sender = m.f;
    if (m.r && !e.recipient) e.recipient = m.r;
    if (m.d && !e.recipientDomain) e.recipientDomain = m.d;
    if (m.h && !e.h) e.h = m.h;
    if (m.slug && !e.slug) e.slug = m.slug;
    if (m.s && !e.subject) e.subject = m.s;
    if (m.note && !e.note) e.note = m.note;
    if (m.g && !e.category) e.category = m.g;
    if (m.n) e.recipients = m.n;
    if (m.c && !e.createdMs) e.createdMs = m.c;
    switch (m.t) {
      case 'seed': e.seeded = true; if (at && !e.sentMs) e.sentMs = at; break;
      case 'sent': if (at) e.sentMs = at; break;
      case 'delivered': e.deliveredMs = Math.min(e.deliveredMs || Infinity, at || now); break;
      case 'delayed': e.delayed = true; break;
      case 'opened': if (at) e.opens.push(at); break;
      case 'clicked': if (at) e.clicks.push(at); if (m.l) e.links[m.l] = (e.links[m.l] || 0) + 1; break;
      case 'bounced': e.bouncedMs = at || now; break;
      case 'complained': e.complainedMs = at || now; break;
      case 'failed': e.failed = true; break;
      case 'suppressed': e.suppressed = true; break;
      default: break;
    }
    if (m.t !== 'seed') e.live = true;
    if (STATUS_RANK[m.t] !== undefined && STATUS_RANK[m.t] >= (STATUS_RANK[e.status] ?? -1)) e.status = m.t;
  }
  out.lastEventAtET = lastEvent ? etString(lastEvent) : null;

  const rows = [];
  for (const e of emails.values()) {
    e.source = e.seeded ? (e.live ? 'seed+webhook' : 'seed') : 'webhook';
    const sentMs = e.sentMs || e.createdMs || uuidv7Ms(e.emailId);
    e.opens.sort((a, b) => a - b);
    e.clicks.sort((a, b) => a - b);
    if (e.opens.length) out.trackingSeen.opens = true;
    if (e.clicks.length) out.trackingSeen.clicks = true;
    for (const [win, start] of [['last24h', d1], ['last7d', d7]]) {
      const w = out[win];
      if (sentMs && sentMs >= start) w.sent++;
      if (e.deliveredMs && e.deliveredMs >= start) w.delivered++;
      const o = e.opens.filter((x) => x >= start).length;
      const c = e.clicks.filter((x) => x >= start).length;
      w.opens += o; if (o) w.uniqueOpened++;
      w.clicks += c; if (c) w.uniqueClicked++;
      if (e.bouncedMs && e.bouncedMs >= start) w.bounced++;
      if (e.complainedMs && e.complainedMs >= start) w.complained++;
    }
    if (sentMs && sentMs >= d7) {
      const s = out.bySender7d[e.sender || '?'] || (out.bySender7d[e.sender || '?'] = { sent: 0, delivered: 0, opened: 0, clicked: 0 });
      s.sent++;
      if (e.deliveredMs) s.delivered++;
      if (e.opens.length) s.opened++;
      if (e.clicks.length) s.clicked++;
    }
    const match = (e.slug && bySlug[e.slug]) || (e.h && byHash[e.h]) || null;
    const tracked = e.live;
    rows.push({
      sentMs,
      row: {
        emailId: e.emailId,
        sender: e.sender ? e.sender + '@schedi.app' : null,
        recipient: e.sender === 'bookings' ? '(client)' : e.recipient,
        recipientDomain: e.recipientDomain || null,
        business: match ? match.businessName : null,
        slug: match ? match.slug : null,
        subject: e.subject,
        sentAtET: etString(sentMs),
        status: tracked ? e.status : 'unknown (sent before the tracking webhook existed)',
        delivered: e.deliveredMs ? true : (tracked && !e.seeded ? false : null),
        deliveredAtET: etString(e.deliveredMs),
        opened: tracked ? e.opens.length > 0 : null,
        firstOpenedAtET: etString(e.opens[0]),
        lastOpenedAtET: etString(e.opens[e.opens.length - 1]),
        openCount: tracked ? e.opens.length : null,
        clicked: tracked ? e.clicks.length > 0 : null,
        clickCount: tracked ? e.clicks.length : null,
        firstClickedAtET: etString(e.clicks[0]),
        clickedLinks: Object.entries(e.links).map(([url, count]) => ({ url, count })),
        bounced: !!e.bouncedMs,
        complained: !!e.complainedMs,
        source: e.source,
        note: e.note || undefined,
      },
    });
  }
  rows.sort((a, b) => (b.sentMs || 0) - (a.sentMs || 0));
  out.recent = rows.slice(0, 25).map((r) => r.row);
  out.emailsTracked = rows.length;

  if (!out.webhookConfigured) out.notes.push('RESEND_WEBHOOK_SECRET not set: the Resend webhook is not connected yet, so no new events are recorded.');
  if (!out.trackingSeen.opens) out.notes.push('No open events seen yet. Opens only appear after open tracking is enabled on schedi.app in Resend (with a verified tracking subdomain) and the webhook is connected.');
  out.notes.push('Opens are a low-confidence signal (Apple Mail Privacy Protection pre-loads the pixel, Gmail caches images, many clients block images). Clicks are stronger but security scanners can click links too.');
  return out;
}
