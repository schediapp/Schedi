/**
 * Public booking mail endpoint (POST /api/send-booking-email).
 *
 * No shared secret. Every send must be tied to a real stored booking:
 *   - client-side flows (new booking, client cancel / reschedule from the manage link) send
 *     { tenantId, bookingId, manageToken } and the token must match the stored booking;
 *   - owner portal flows (accept, deny, reschedule, cancel, mark paid, manual booking) send
 *     { tenantId, bookingId, session } and the session must be that business's owner (or agency).
 * The recipient is never taken from the browser: client mail goes to the client email on the
 * stored booking, owner mail goes to the owner notify address on the stored tenant record.
 * Subject is rebuilt server-side from a known per-type prefix plus the stored business name.
 * HTML/text built by the page (so the approved designs stay byte-identical) is only accepted if it
 * passes a strict allowlist: known layout tags only, no active content, links only to schedi.app,
 * Google Calendar, or the business's own saved payment links, images only from schedi.app/assets.
 * Client-token sends are also limited per booking (once, or a few per day for reschedules) and every
 * send is rate limited per IP and per tenant.
 */
import { readSession } from './owner-auth.js';
import { loadPrivateAppointments } from './private-bookings.js';
import { rateLimitOk } from './rate-limit.js';
import { appointmentIsClientConfirmed } from './appointment-updated.js';

const OWNER_CONTACT_TOKEN = '{{schedi_owner_contact}}';
const EM_DASH_SEP = ' \u2014 ';

// to: who receives it. prefixes: allowed subject prefixes. client: allowed with a manage token.
// limit: 'once' per booking, or 'daily' (max DAILY_MAX per booking per type per day) for token sends.
const TYPE_RULES = {
  booking_confirmation: { to: 'client', prefixes: ['Request sent', "You're booked!", 'Series booked'], client: true, limit: 'once' },
  owner_booking_alert: { to: 'owner', prefixes: ['Booking request', 'New recurring booking', 'New booking'], client: true, limit: 'once' },
  owner_payment_received: { to: 'owner', prefixes: ['Payment received'], client: true, limit: 'once' },
  booking_cancellation: { to: 'client', prefixes: ['Appointment cancelled'], client: true, limit: 'once', needCancelled: true },
  owner_booking_cancellation: { to: 'owner', prefixes: ['Client cancelled'], client: true, limit: 'once', needCancelled: true },
  booking_reschedule: { to: 'client', prefixes: ['Booking rescheduled'], client: true, limit: 'daily' },
  booking_update: { to: 'client', prefixes: ['Appointment updated'], client: false, limit: 'daily' },
  owner_booking_reschedule: { to: 'owner', prefixes: ['Appointment rescheduled'], client: true, limit: 'daily' },
  booking_accepted: { to: 'client', prefixes: ['Appointment accepted'], client: false },
  booking_denied: { to: 'client', prefixes: ['Request not accepted', 'Appointment not accepted'], client: false },
  payment_received_client: { to: 'client', prefixes: ['Payment received'], client: false },
};
const DAILY_MAX = 6;
const ONCE_TTL_SEC = 60 * 24 * 60 * 60;
const MAX_HTML = 150000;
const MAX_TEXT = 30000;
const ALLOWED_FROM_NAMES = new Set(['schedi', 'schedi bookings']);

const ALLOWED_LINK_HOSTS = new Set(['schedi.app', 'www.schedi.app', 'calendar.google.com']);

/** PNG already on schedi.app. Gmail loads this; it does not load SVG or a missing file. */
export const SCHEDI_EMAIL_MARK = 'https://schedi.app/assets/homescreen-icon.png';

/**
 * Absolute https URL on schedi.app for an email <img>.
 * Asset images must be png or jpeg. A business logo at /logos/{id} is rewritten
 * to /logos/{id}/email.png, which serves only the stored png or jpeg.
 * Returns '' for data:, SVG, other hosts, and anything else Gmail would block.
 */
export function emailRasterSrc(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 500) return '';
  let u;
  try { u = new URL(s); } catch (_) { return ''; }
  if (u.protocol !== 'https:' || u.username || u.password) return '';
  const host = String(u.hostname || '').toLowerCase();
  if (host !== 'schedi.app' && host !== 'www.schedi.app') return '';
  const path = String(u.pathname || '');
  if (path.indexOf('..') !== -1 || /\.svg$/i.test(path)) return '';
  let v = '';
  let extra = false;
  u.searchParams.forEach((val, key) => {
    if (key === 'v') v = String(val || '');
    else extra = true;
  });
  if (extra) return '';
  if (/^\/assets\/[A-Za-z0-9._/-]+\.(png|jpe?g)$/i.test(path)) {
    if (v && !/^[A-Za-z0-9._-]{1,40}$/.test(v)) return '';
    return 'https://schedi.app' + path + (v ? ('?v=' + v) : '');
  }
  const emailPng = path.match(/^\/logos\/([A-Za-z0-9_-]{1,80})\/email\.png$/);
  const logo = path.match(/^\/logos\/([A-Za-z0-9_-]{1,80})$/);
  const id = emailPng ? emailPng[1] : (logo ? logo[1] : '');
  if (!id) return '';
  if (v && !/^[a-f0-9]{18}$/.test(v)) return '';
  return 'https://schedi.app/logos/' + id + '/email.png' + (v ? ('?v=' + v) : '');
}
const ALLOWED_TAGS = new Set([
  'html', 'head', 'meta', 'title', 'body', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'div', 'span', 'p', 'a', 'img', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'small', 'center', 'font', 'sup', 'sub',
  'blockquote', 'code', 'pre', 'caption', 'colgroup', 'col',
]);
const FORBIDDEN_ATTRS = new Set([
  'action', 'formaction', 'background', 'poster', 'srcset', 'xlink:href', 'data', 'codebase',
  'lowsrc', 'dynsrc', 'ping', 'http-equiv', 'content-security-policy', 'manifest', 'longdesc',
  'usemap', 'profile', 'classid', 'archive', 'srcdoc', 'is',
]);

function clip(v, n) { return String(v == null ? '' : v).slice(0, n); }

function timingSafeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  let diff = left.length ^ right.length;
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return diff === 0;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ''; } })
    .replace(/&#([0-9]+);?/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (_) { return ''; } })
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&colon;/gi, ':').replace(/&tab;/gi, '\t').replace(/&newline;/gi, '\n')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
}

function normUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '').toLowerCase();
}

/** Business's own saved payment links (Venmo / PayPal / Cash App), exact URLs only. */
export function tenantPaymentLinks(tenant) {
  const out = new Set();
  if (!tenant) return out;
  for (const k of ['venmoLink', 'paypalLink']) {
    const v = String(tenant[k] || '').trim();
    if (/^https:\/\//i.test(v)) out.add(normUrl(v));
  }
  const tag = String(tenant.cashAppTag || tenant.cashappTag || '').trim().replace(/^\$/, '');
  if (tag) {
    out.add(normUrl('https://cash.app/$' + tag));
    out.add(normUrl('https://cash.app/' + encodeURIComponent('$' + tag)));
  }
  // URLs the owner typed into their own saved text (confirmation note, address) are allowed verbatim.
  const notes = tenant.notifications && typeof tenant.notifications === 'object' ? tenant.notifications.extraNote : '';
  const ownerText = [notes, tenant.address, tenant.location, tenant.businessAddress, tenant.businessLocation]
    .map((v) => (typeof v === 'string' ? v : '')).join(' ');
  const found = ownerText.match(/(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/gi) || [];
  for (const f of found) {
    const clean = f.replace(/[.,;:!?]+$/, '');
    out.add(normUrl(/^https?:\/\//i.test(clean) ? clean : 'https://' + clean));
    if (/^http:\/\//i.test(clean)) out.add(normUrl('https://' + clean.slice(7)));
  }
  return out;
}

function linkAllowed(raw, ctx) {
  const value = decodeEntities(raw).replace(/[\u0000-\u0020\u007f]+/g, '');
  if (!value) return true;
  if (value.charAt(0) === '#') return true;
  if (ctx.paymentLinks.has(normUrl(value))) return true;
  if (/^http:\/\//i.test(value) && ctx.paymentLinks.has(normUrl('https://' + value.slice(7)))) return true;
  let u;
  try { u = new URL(value); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (ALLOWED_LINK_HOSTS.has(u.hostname.toLowerCase())) return true;
  return ctx.paymentLinks.has(normUrl(value));
}

/**
 * Returns '' when the mail content is acceptable, otherwise a short reason code.
 * Exported for local tests.
 */
export function mailContentProblem(html, text, ctx) {
  ctx = ctx || { paymentLinks: new Set() };
  if (html && html.length > MAX_HTML) return 'html_too_large';
  if (text && text.length > MAX_TEXT) return 'text_too_large';
  const h = String(html || '');
  if (/<!--/.test(h)) return 'html_comment';
  if (/<\?/.test(h)) return 'html_pi';
  if (/<!\[CDATA\[/i.test(h)) return 'html_cdata';
  // Every '<' must start a known tag, a closing tag, or the doctype.
  const tagRe = /<\s*(\/)?\s*([a-zA-Z!][a-zA-Z0-9:-]*)([^>]*)>/g;
  let m;
  let consumed = 0;
  let lt = 0;
  for (let i = 0; i < h.length; i++) if (h.charCodeAt(i) === 60) lt++;
  while ((m = tagRe.exec(h))) {
    consumed++;
    const closing = !!m[1];
    const name = m[2].toLowerCase();
    const rest = m[3] || '';
    if (name === '!doctype') {
      if (!/^\s+html\s*$/i.test(rest)) return 'bad_doctype';
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) return 'tag_not_allowed:' + name;
    if (closing) continue;
    if (/[<]/.test(rest)) return 'bad_markup';
    const attrRe = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let a;
    while ((a = attrRe.exec(rest))) {
      const an = a[1].toLowerCase();
      const av = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : '';
      const dv = decodeEntities(av).toLowerCase().replace(/[\u0000-\u0020\u007f]+/g, '');
      if (an.indexOf('on') === 0) return 'event_attr';
      if (FORBIDDEN_ATTRS.has(an)) return 'attr_not_allowed:' + an;
      if (/javascript:|vbscript:|livescript:|data:/.test(dv)) return 'bad_scheme';
      if (an === 'href') {
        if (name !== 'a') return 'href_on_' + name;
        if (!linkAllowed(av, ctx)) return 'link_not_allowed';
      } else if (an === 'src') {
        if (name !== 'img') return 'src_on_' + name;
        const decodedImg = decodeEntities(av).trim();
        const canonImg = emailRasterSrc(decodedImg);
        if (!canonImg || canonImg !== decodedImg) return 'image_not_allowed';
      } else if (an === 'style') {
        if (/url\(|expression\(|@import|behavior:|-moz-binding|image-set\(/.test(dv)) return 'bad_style';
      } else if (an === 'name' && name === 'meta') {
        // fine
      }
    }
  }
  if (consumed !== lt) return 'bad_markup';
  // Plain URLs in text and HTML text must also be allowed (mail apps auto-link them).
  const urlRe = /https?:\/\/[^\s<>"'`)\]]+/gi;
  for (const body of [String(text || ''), h]) {
    let u;
    while ((u = urlRe.exec(body))) {
      const candidate = u[0].replace(/[.,;:!?]+$/, '');
      if (!linkAllowed(candidate, ctx)) return 'url_not_allowed';
    }
  }
  if (/www\.[a-z0-9-]+\.[a-z]{2,}/i.test(String(text || '').replace(/https?:\/\/[^\s]+/gi, ''))) {
    // bare www. links that are not schedi
    const bare = String(text || '').match(/www\.[a-z0-9.-]+\.[a-z]{2,}[^\s]*/gi) || [];
    for (const b of bare) {
      if (!linkAllowed('https://' + b, ctx)) return 'url_not_allowed';
    }
  }
  return '';
}

function isCancelledBooking(b) {
  if (!b) return false;
  if (b.cancelled === true) return true;
  const s = String(b.status || '').toLowerCase();
  return s === 'cancelled' || s === 'canceled';
}

function clientIp(request) {
  return String(request.headers.get('CF-Connecting-IP') || request.headers.get('X-Real-IP') || 'unknown').slice(0, 64);
}

function originOk(origin, isAllowedOrigin) {
  if (!origin) return false;
  if (origin === 'null') return true; // srcdoc / sandboxed booking iframe
  return isAllowedOrigin(origin);
}

async function sessionFor(env, token, tenantId) {
  const t = String(token || '').trim();
  if (!t || t.length < 16 || t.length > 200) return null;
  const s = await readSession(env, t);
  if (!s) return null;
  if (s.role === 'agency') return s;
  if (s.role === 'owner' && String(s.tenantId || '') === String(tenantId || '')) return s;
  return null;
}

async function findStoredBooking(env, tenantId, bookingId, sleep, tries) {
  for (let i = 0; i < tries; i++) {
    let list = [];
    try { list = await loadPrivateAppointments(env, tenantId); } catch (_) { list = []; }
    const hit = (list || []).find((a) => a && String(a.id) === String(bookingId));
    if (hit) return hit;
    if (i < tries - 1) await sleep(900);
  }
  return null;
}

function ownerNotifyAddress(tenant) {
  const ownerEmail = String((tenant && tenant.ownerEmail) || '').trim();
  return String((tenant && tenant.notifications && tenant.notifications.replyTo) || ownerEmail || '').trim();
}

function ownerContact(tenant, escapeHtml) {
  const ownerEmail = String(tenant.ownerEmail || '').trim();
  const name = String(tenant.ownerName || '').trim() || 'us';
  const phone = String(tenant.ownerPhone || '').trim();
  return {
    text: name + (ownerEmail ? ' at ' + ownerEmail : '') + (phone ? ' or ' + phone : ''),
    html: escapeHtml(name) + (ownerEmail ? ' at ' + escapeHtml(ownerEmail) : '') + (phone ? ' or ' + escapeHtml(phone) : ''),
  };
}

function fillToken(s, value) {
  return typeof s === 'string' ? s.split(OWNER_CONTACT_TOKEN).join(value) : s;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * deps: { json, isAllowedOrigin, getTenantById, firebaseAnonymousToken, sendResend, sendBookingConfirmationSms,
 *         runSameDayReminders, ownerNotifyEnabledForTenant, escapeHtml, safeTenantId, sleep? }
 */
export async function handleBookingMailPost(request, env, origin, deps) {
  const { json } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const ip = clientIp(request);

  if (!originOk(origin, deps.isAllowedOrigin)) {
    return json({ ok: false, error: 'origin_not_allowed' }, 403, origin);
  }
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > 400000) return json({ ok: false, error: 'too_large' }, 413, origin);

  let data;
  try {
    const raw = await request.text();
    if (raw.length > 400000) return json({ ok: false, error: 'too_large' }, 413, origin);
    data = JSON.parse(raw || '{}');
  } catch (_) {
    return json({ ok: false, error: 'invalid_json' }, 400, origin);
  }
  if (!data || typeof data !== 'object') return json({ ok: false, error: 'invalid_json' }, 400, origin);

  if (!(await rateLimitOk(env.RL_MAIL, 'ip:' + ip, 30, 'mail'))) {
    return json({ ok: false, error: 'rate_limited' }, 429, origin);
  }

  // Maintenance: manual reminder run. An owner session is never enough.
  // A server-held Bearer (never in page code) or an agency session may run it.
  if (data.action === 'run_reminders') {
    const presented = String(data.session || '').trim();
    if (presented) {
      const s = await readSession(env, presented);
      if (!s) return json({ ok: false, error: 'session_required' }, 401, origin);
      if (s.role !== 'agency') return json({ ok: false, error: 'forbidden' }, 403, origin);
    }
    const secret = String(env.WEBHOOK_SECRET || '').trim();
    const h = request.headers.get('Authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    const bearerOk = !!(secret && secret.length >= 32 && m && timingSafeEqual(m[1].trim(), secret));
    const agencyOk = !!presented;
    if (!bearerOk && !agencyOk) return json({ ok: false, error: 'unauthorized' }, 401, origin);
    try {
      const result = await deps.runSameDayReminders(env, { force: data.force !== false, dryRun: !!data.dryRun });
      return json(result, 200, origin);
    } catch (err) {
      return json({ ok: false, error: 'reminder_run_failed' }, 500, origin);
    }
  }

  // Agency "test email sender" button: fixed content, sent to the signed-in agency/owner address only.
  if (data.type === 'sender_test') {
    const s = data.session ? await readSession(env, String(data.session)) : null;
    if (!s || (s.role !== 'agency' && s.role !== 'owner')) return json({ ok: false, error: 'session_required' }, 401, origin);
    const to = String(s.email || '').trim();
    if (!to || to.indexOf('@') < 1) return json({ ok: false, error: 'no_session_email' }, 400, origin);
    if (!(await rateLimitOk(env.RL_MAIL_TENANT, 'sess:' + to, 10, 'mailt'))) return json({ ok: false, error: 'rate_limited' }, 429, origin);
    const sent = await deps.sendResend(env, {
      to,
      subject: 'Schedi test \u2014 email delivery works',
      text: 'This is a test confirmation from Schedi. If you received this, booking emails are connected.',
      html: '<p>This is a <strong>test confirmation</strong> from Schedi.</p><p>If you received this, booking emails are connected.</p>',
      fromName: 'Schedi Bookings',
      fromAddress: 'bookings@schedi.app',
    });
    return json(sent.ok ? { ok: true, id: sent.id } : { ok: false, error: sent.error }, sent.ok ? 200 : 502, origin);
  }

  const tenantId = deps.safeTenantId(data.tenantId || data.ownerTenantId);
  const bookingId = clip(data.bookingId || (data.sms && data.sms.bookingId), 40);
  const isSmsOnly = data.action === 'send_booking_sms';
  const type = isSmsOnly ? 'booking_confirmation' : String(data.type || '').trim();
  const rule = TYPE_RULES[type];
  if (!tenantId) return json({ ok: false, error: 'tenant_required' }, 400, origin);
  if (!rule) return json({ ok: false, error: 'type_not_allowed' }, 400, origin);
  if (!bookingId || !/^[A-Za-z0-9_-]{2,40}$/.test(bookingId)) return json({ ok: false, error: 'booking_required' }, 400, origin);

  const session = data.session ? await sessionFor(env, data.session, tenantId) : null;
  const manageToken = clip(data.manageToken, 128);
  const tokenShapeOk = /^[A-Za-z0-9_-]{16,128}$/.test(manageToken);
  if (!session && !tokenShapeOk) return json({ ok: false, error: 'unauthorized' }, 401, origin);
  if (!session && !rule.client) return json({ ok: false, error: 'session_required' }, 401, origin);

  const isTestSample = !!session && /^TEST-[A-Z0-9]+$/.test(bookingId) && type === 'booking_confirmation';
  // The page saves the booking and sends the email at the same moment; give the save a few seconds.
  const booking = isTestSample ? null : await findStoredBooking(env, tenantId, bookingId, sleep, 5);
  if (!isTestSample && !booking) return json({ ok: false, error: 'booking_not_found' }, 404, origin);
  if (!session) {
    if (!booking.manageToken || !timingSafeEqual(String(booking.manageToken), manageToken)) {
      return json({ ok: false, error: 'unauthorized' }, 401, origin);
    }
    if (rule.needCancelled && !isCancelledBooking(booking)) return json({ ok: false, error: 'booking_not_cancelled' }, 409, origin);
    if (type === 'booking_confirmation' && (isCancelledBooking(booking) || String(booking.status || '').toLowerCase() === 'denied')) {
      return json({ ok: false, error: 'booking_not_active' }, 409, origin);
    }
  }

  // Walk-ins: never email or text the client. The owner still gets the new-booking alert.
  if (booking && booking.walkIn === true) {
    if (type === 'booking_confirmation' || type === 'booking_update') return json({ ok: true, skipped: true, reason: 'walk_in' }, 200, origin);
  }
  // Appointment updated is only for a confirmed booking. Pending, denied, cancelled, and no-shows stay quiet.
  if (type === 'booking_update' && (!booking || !appointmentIsClientConfirmed(booking))) {
    return json({ ok: true, skipped: true, reason: 'not_confirmed' }, 200, origin);
  }

  // Per-tenant limit only after the caller proved a session or a real manage token,
  // so strangers cannot use up a business's mail budget.
  if (!(await rateLimitOk(env.RL_MAIL_TENANT, 't:' + tenantId, 40, 'mailt'))) {
    return json({ ok: false, error: 'rate_limited' }, 429, origin);
  }

  let tenant;
  try {
    const idToken = await deps.firebaseAnonymousToken(env);
    tenant = await deps.getTenantById(env, idToken, tenantId);
  } catch (_) {
    return json({ ok: false, error: 'tenant_lookup_failed' }, 502, origin);
  }
  if (!tenant) return json({ ok: false, error: 'tenant_not_found' }, 404, origin);
  if (booking && booking.walkIn === true && type === 'owner_booking_alert'
    && !deps.ownerNotifyEnabledForTenant(Object.assign({ id: tenantId }, tenant), env)) {
    return json({ ok: true, skipped: true, reason: 'owner_notify_not_enabled' }, 200, origin);
  }

  const notifyTo = ownerNotifyAddress(tenant);
  const clientTo = booking ? String(booking.clientEmail || '').trim() : '';
  const to = (rule.to === 'owner' || isTestSample) ? notifyTo : clientTo;

  // SMS-only action (email turned off): phone always comes from the stored booking.
  if (isSmsOnly) {
    const sms = await deps.sendBookingConfirmationSms(env, { tenantId, bookingId }).catch(() => ({ ok: false, skipped: true, reason: 'sms_failed' }));
    return json({ ok: true, sms }, 200, origin);
  }

  if (!to || to.indexOf('@') < 1) return json({ ok: false, error: 'recipient_missing' }, 400, origin);

  // Worker already sends the owner cancellation alert itself for gated tenants.
  if (type === 'owner_booking_cancellation' && deps.ownerNotifyEnabledForTenant({ id: tenantId, slug: tenantId }, env)) {
    return json({ ok: true, skipped: true, reason: 'worker_sends_owner_cancel' }, 200, origin);
  }

  // Subject: known prefix for this type + stored business name.
  const rawSubject = clip(data.subject, 300);
  const sepAt = rawSubject.indexOf(EM_DASH_SEP);
  const prefix = sepAt > 0 ? rawSubject.slice(0, sepAt) : '';
  if (rule.prefixes.indexOf(prefix) === -1) return json({ ok: false, error: 'subject_not_allowed' }, 400, origin);
  const bizName = clip(String(tenant.name || '').replace(/[\r\n]+/g, ' ').trim(), 120) || 'Schedi';
  const subject = prefix + EM_DASH_SEP + bizName;

  const ctx = { paymentLinks: tenantPaymentLinks(tenant) };
  let html = typeof data.html === 'string' ? data.html : '';
  let text = typeof data.text === 'string' ? data.text : '';
  if (!html && !text) return json({ ok: false, error: 'validation_failed' }, 400, origin);
  const problem = mailContentProblem(html, text, ctx);
  if (problem) {
    console.warn('booking mail rejected', type, problem);
    return json({ ok: false, error: 'content_not_allowed', reason: problem }, 400, origin);
  }
  const contact = ownerContact(tenant, deps.escapeHtml);
  html = fillToken(html, contact.html);
  text = fillToken(text, contact.text);

  const replyTo = rule.to === 'owner' ? clientTo : notifyTo;
  const fromRaw = String(data.fromName || '').trim();
  const fromName = (fromRaw && (fromRaw === String(tenant.name || '').trim() || ALLOWED_FROM_NAMES.has(fromRaw.toLowerCase())))
    ? fromRaw
    : (String(tenant.name || '').trim() || 'Schedi');

  // Per-booking limits for client-token sends (owner sessions are only rate limited).
  let onceKey = '';
  let dailyKey = '';
  if (!session && env.AUTH_KV) {
    if (rule.limit === 'once') {
      onceKey = 'bmail:once:' + tenantId + ':' + bookingId + ':' + type;
      if (await env.AUTH_KV.get(onceKey)) return json({ ok: true, skipped: true, reason: 'already_sent' }, 200, origin);
    } else if (rule.limit === 'daily') {
      dailyKey = 'bmail:n:' + tenantId + ':' + bookingId + ':' + type + ':' + todayKey();
      const n = Number(await env.AUTH_KV.get(dailyKey)) || 0;
      if (n >= DAILY_MAX) return json({ ok: false, error: 'rate_limited' }, 429, origin);
    }
  }

  if (data.dryRun === true) {
    return json({ ok: true, dryRun: true, sent: false }, 200, origin);
  }

  const smsPromise = (type === 'booking_confirmation' && data.sms && booking)
    ? deps.sendBookingConfirmationSms(env, { tenantId, bookingId }).catch(() => ({ ok: false, skipped: true, reason: 'sms_failed' }))
    : Promise.resolve(null);

  const [result, sms] = await Promise.all([
    deps.sendResend(env, {
      to,
      subject,
      html: html || undefined,
      text: text || undefined,
      replyTo: replyTo && replyTo.indexOf('@') > 0 ? replyTo : undefined,
      fromName,
      fromAddress: 'bookings@schedi.app',
    }),
    smsPromise,
  ]);

  if (!result.ok) {
    const status = result.error === 'validation_failed' ? 400 : result.error === 'RESEND_API_KEY not set' ? 500 : 502;
    return json({ ok: false, error: result.error, sms: sms || undefined }, status, origin);
  }
  try {
    if (onceKey) await env.AUTH_KV.put(onceKey, '1', { expirationTtl: ONCE_TTL_SEC });
    if (dailyKey) {
      const n = Number(await env.AUTH_KV.get(dailyKey)) || 0;
      await env.AUTH_KV.put(dailyKey, String(n + 1), { expirationTtl: 2 * 24 * 60 * 60 });
    }
  } catch (_) {}
  const body = { ok: true, id: result.id };
  if (sms) body.sms = sms;
  return json(body, 200, origin);
}
