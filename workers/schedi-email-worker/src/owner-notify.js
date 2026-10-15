/**
 * Email the business owner when a client books.
 * Enabled for all businesses (OWNER_NOTIFY_SLUG_ALLOWLIST = ['*'], approved by Axel 2026-10-12).
 * (and optionally add an owner opt-out on the tenant).
 */
import { getPrivateTenant, PRIVATE_REPLY_TO_KEY } from './tenant-private.js';
import { sendOwnerPush } from './owner-push.js';

/** Temporary allowlist. Empty array = off. Replace with ["*"] or remove the check to enable for all. */
export const OWNER_NOTIFY_SLUG_ALLOWLIST = ['*'];

const PORTAL_LOGIN_URL = 'https://schedi.app/login';
const FROM_NAME = 'Schedi';
const FROM_ADDRESS = 'bookings@schedi.app';

function clip(v, n) {
  return String(v == null ? '' : v).trim().slice(0, n || 160);
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tenantSlug(tenant) {
  return String((tenant && (tenant.slug || tenant.id)) || '').trim().toLowerCase();
}

export function ownerNotifyEnabledForTenant(tenant, env) {
  const slug = tenantSlug(tenant);
  if (!slug) return false;
  const fromEnv = String((env && env.OWNER_NOTIFY_SLUGS) || '').trim();
  let list = OWNER_NOTIFY_SLUG_ALLOWLIST;
  if (fromEnv) {
    list = fromEnv.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  if (!list.length) return false;
  if (list.includes('*')) return true;
  return list.includes(slug);
}

function isPendingBooking(booking) {
  return String((booking && booking.status) || '').toLowerCase() === 'pending';
}

function isAutoConfirmedBooking(booking) {
  const status = String((booking && booking.status) || '').toLowerCase();
  if (!status) return true;
  return status === 'accepted' || status === 'confirmed';
}

/** Pending is priority; auto-confirm also notifies behind the same gate. */
export function shouldSendOwnerNotify(tenant, booking, env) {
  if (!ownerNotifyEnabledForTenant(tenant, env)) return false;
  if (!booking || !booking.id) return false;
  if (booking.cancelled === true) return false;
  const status = String(booking.status || '').toLowerCase();
  if (status === 'denied' || status === 'cancelled' || status === 'canceled') return false;
  return isPendingBooking(booking) || isAutoConfirmedBooking(booking);
}

export function resolveOwnerNotifyAddress(tenant, priv) {
  const replyTo = priv && priv[PRIVATE_REPLY_TO_KEY]
    ? String(priv[PRIVATE_REPLY_TO_KEY]).trim()
    : '';
  const fromPriv = priv && priv.ownerEmail ? String(priv.ownerEmail).trim() : '';
  const fromTenant = tenant && tenant.ownerEmail ? String(tenant.ownerEmail).trim() : '';
  const fromNotes = tenant && tenant.notifications && tenant.notifications.replyTo
    ? String(tenant.notifications.replyTo).trim()
    : '';
  const pick = replyTo || fromPriv || fromNotes || fromTenant;
  if (!pick || pick.indexOf('@') < 1) return '';
  return pick;
}


/** Format YYYY-MM-DD as "Tue, Oct 20, 2026" using local calendar parts (no UTC shift). */
export function formatFriendlyLocalDate(dateStr) {
  const raw = String(dateStr || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return clip(raw, 40);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d);
  if (!Number.isFinite(dt.getTime()) || dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) {
    return clip(raw, 40);
  }
  return dt.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function buildOwnerNotifyEmail(tenant, booking) {
  const pending = isPendingBooking(booking);
  const biz = clip(tenant && tenant.name, 120) || 'your business';
  const client = clip(booking && booking.clientName, 120) || 'a client';
  const service = clip(booking && booking.serviceName, 120) || 'Appointment';
  const dateRaw = clip(booking && booking.date, 20);
  const date = dateRaw ? formatFriendlyLocalDate(dateRaw) : '';
  const time = clip(booking && booking.time, 20);
  const when = [date, time].filter(Boolean).join(' at ');
  const phone = clip(booking && booking.clientPhone, 40);
  const email = clip(booking && booking.clientEmail, 160);
  const notes = clip(booking && booking.notes, 500);
  const ref = clip(booking && booking.id, 40);
  const slug = tenantSlug(tenant);

  const subject = pending
    ? ('New booking request: ' + client + ', ' + service + (when ? (', ' + when) : ''))
    : ('New booking: ' + client + ', ' + service + (when ? (', ' + when) : ''));

  const headline = pending ? 'New booking request' : 'New booking';
  const lead = pending
    ? ('A client requested a time with <strong>' + esc(biz) + '</strong>. Accept or deny it in the Business Portal.')
    : ('A new appointment was booked for <strong>' + esc(biz) + '</strong>.');

  const text = [
    pending ? ('A client requested a time with ' + biz + '. Accept or deny it in the Business Portal.') : ('A new appointment was booked for ' + biz + '.'),
    '',
    'Business: ' + biz,
    'Client: ' + client,
    phone ? ('Phone: ' + phone) : '',
    email ? ('Email: ' + email) : '',
    'Service: ' + service,
    date ? ('Date: ' + date) : '',
    time ? ('Time: ' + time) : '',
    ref ? ('Reference: #' + ref) : '',
    notes ? ('Notes: ' + notes) : '',
    '',
    'Review in Business Portal:',
    PORTAL_LOGIN_URL,
    slug ? ('Booking page: https://schedi.app/' + slug + '/') : '',
    '',
    '— Schedi',
  ].filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n');

  const rows = [
    ['Business', biz],
    ['Client', client],
    phone ? ['Phone', phone] : null,
    email ? ['Email', email] : null,
    ['Service', service],
    date ? ['Date', date] : null,
    time ? ['Time', time] : null,
    ref ? ['Reference', '#' + ref] : null,
    notes ? ['Notes', notes] : null,
  ].filter(Boolean);

  const table = rows.map(function (r) {
    return '<tr><td style="padding:4px 12px 4px 0;color:#64748b;vertical-align:top">' + esc(r[0])
      + '</td><td style="padding:4px 0;font-weight:600">' + esc(r[1]) + '</td></tr>';
  }).join('');

  const html = '<div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#0f172a">'
    + '<h2 style="margin:0 0 12px;color:' + (pending ? '#0ea5e9' : '#059669') + '">' + esc(headline) + '</h2>'
    + '<p>' + lead + '</p>'
    + '<table style="border-collapse:collapse;margin:16px 0">' + table + '</table>'
    + '<p style="margin:20px 0">'
    + '<a href="' + PORTAL_LOGIN_URL + '" style="display:inline-block;background:#10b981;color:#022c22;text-decoration:none;font-weight:700;font-size:14px;padding:12px 18px;border-radius:10px">Review in Business Portal</a>'
    + '</p>'
    + '<p style="font-size:12px;color:#64748b">Or open <a href="' + PORTAL_LOGIN_URL + '" style="color:#059669">' + PORTAL_LOGIN_URL + '</a>'
    + (slug ? (' · public page <a href="https://schedi.app/' + encodeURIComponent(slug) + '/" style="color:#059669">https://schedi.app/' + esc(slug) + '/</a>') : '')
    + '</p>'
    + '<p style="color:#64748b;font-size:13px">— Schedi</p></div>';

  return {
    subject: subject.slice(0, 200),
    text,
    html,
    replyTo: email && email.indexOf('@') > 0 ? email : '',
    pending,
  };
}

/**
 * Send owner notify if gated + eligible. Never throws. Idempotent via reminder doc ownerNotifySentAt.
 * deps: { sendResend, getReminderDoc, mergeReminderDoc, firebaseAnonymousToken }
 */
export async function notifyOwnerOfNewBooking(env, tenant, booking, deps) {
  deps = deps || {};
  try {
    if (!shouldSendOwnerNotify(tenant, booking, env)) {
      return { ok: true, skipped: true, reason: 'not_eligible' };
    }
    const tenantId = clip(tenant && tenant.id, 80);
    const bookingId = clip(booking && booking.id, 40);
    if (!tenantId || !bookingId) return { ok: true, skipped: true, reason: 'missing_ids' };

    let idToken = '';
    try {
      idToken = deps.firebaseAnonymousToken ? await deps.firebaseAnonymousToken(env) : '';
    } catch (_) {}

    if (deps.getReminderDoc) {
      try {
        const rec = await deps.getReminderDoc(env, idToken, tenantId, bookingId);
        if (rec && rec.exists && rec.fields && rec.fields.ownerNotifySentAt) {
          return { ok: true, skipped: true, reason: 'already_sent', emailId: rec.fields.ownerNotifyEmailId || '' };
        }
      } catch (err) {
        console.warn('owner-notify dedup check failed', err && err.message ? err.message : err);
      }
    }

    await sendOwnerPush(env, tenantId, booking, 'new');

    let priv = null;
    try {
      priv = await getPrivateTenant(env, tenantId);
    } catch (err) {
      console.warn('owner-notify private read failed', err && err.message ? err.message : err);
    }
    const to = resolveOwnerNotifyAddress(tenant, priv);
    if (!to) {
      console.warn('owner-notify skipped: no owner email', tenantSlug(tenant));
      return { ok: false, skipped: true, reason: 'owner_email_missing' };
    }

    const content = buildOwnerNotifyEmail(tenant, booking);
    if (!deps.sendResend) return { ok: false, error: 'send_missing' };
    const result = await deps.sendResend(env, {
      to,
      subject: content.subject,
      html: content.html,
      text: content.text,
      replyTo: content.replyTo || undefined,
      fromName: FROM_NAME,
      fromAddress: FROM_ADDRESS,
    });

    if (!result || !result.ok) {
      console.warn('owner-notify send failed', tenantSlug(tenant), bookingId, result && result.error);
      return { ok: false, error: (result && result.error) || 'send_failed', detail: result };
    }

    const sentAt = new Date().toISOString();
    if (deps.mergeReminderDoc) {
      try {
        await deps.mergeReminderDoc(env, idToken, tenantId, booking, {
          ownerNotifySentAt: sentAt,
          ownerNotifyEmailId: result.id || '',
          ownerNotifyKind: content.pending ? 'pending' : 'confirmed',
        });
      } catch (err) {
        console.warn('owner-notify stamp failed', err && err.message ? err.message : err);
      }
    }

    console.log('owner-notify sent', JSON.stringify({
      slug: tenantSlug(tenant),
      bookingId,
      pending: content.pending,
      emailId: result.id || '',
    }));
    return { ok: true, id: result.id, toMasked: maskEmail(to), pending: content.pending };
  } catch (err) {
    console.warn('owner-notify exception', err && err.message ? err.message : err);
    return { ok: false, error: 'exception', detail: String(err && err.message ? err.message : err).slice(0, 200) };
  }
}

function isCancelledBooking(booking) {
  if (!booking) return false;
  if (booking.cancelled === true) return true;
  const status = String(booking.status || '').toLowerCase();
  return status === 'cancelled' || status === 'canceled';
}

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  return '$' + v.toFixed(2);
}

/** Plain-English cancellation fee line for the owner, or '' when no fee rule applied. */
export function cancellationFeeLine(booking) {
  const status = String((booking && booking.cancellationFeeStatus) || '').toLowerCase();
  if (!status) return '';
  const amt = money(booking && booking.cancellationFeeAmount);
  const reason = String((booking && booking.cancellationFeeReason) || '').toLowerCase();
  if (status === 'collected') return (amt ? amt + ' ' : '') + 'cancellation fee charged to the client\'s card on file.';
  if (status === 'outside_window') return 'No fee: cancelled outside your cancellation window.';
  if (status === 'not_collected') {
    const why = reason === 'shown_only' ? 'shown to the client only (automatic charging is a Pro feature)'
      : reason === 'no_card' ? 'no card on file to charge'
      : reason === 'fee_too_small' ? 'amount too small to charge'
      : reason === 'charge_failed' ? 'the card charge did not go through'
      : '';
    return (amt ? amt + ' cancellation fee' : 'Cancellation fee') + ' not collected' + (why ? (': ' + why) : '') + '.';
  }
  return 'Cancellation fee: ' + status.replace(/_/g, ' ') + (amt ? (' (' + amt + ')') : '') + '.';
}

export function shouldSendOwnerCancelNotify(tenant, booking, env) {
  if (!ownerNotifyEnabledForTenant(tenant, env)) return false;
  if (!booking || !booking.id) return false;
  return isCancelledBooking(booking);
}

export function buildOwnerCancelEmail(tenant, booking) {
  const byClient = String((booking && booking.cancelledBy) || '').toLowerCase() === 'client';
  const biz = clip(tenant && tenant.name, 120) || 'your business';
  const client = clip(booking && booking.clientName, 120) || 'a client';
  const service = clip(booking && booking.serviceName, 120) || 'Appointment';
  const dateRaw = clip(booking && booking.date, 20);
  const date = dateRaw ? formatFriendlyLocalDate(dateRaw) : '';
  const time = clip(booking && booking.time, 20);
  const when = [date, time].filter(Boolean).join(' at ');
  const phone = clip(booking && booking.clientPhone, 40);
  const email = clip(booking && booking.clientEmail, 160);
  const ref = clip(booking && booking.id, 40);
  const slug = tenantSlug(tenant);
  const fee = cancellationFeeLine(booking);
  const who = byClient ? 'The client' : 'You (the business)';

  const subject = (byClient ? 'Client cancelled: ' : 'You cancelled: ')
    + client + ', ' + service + (when ? (', ' + when) : '');
  const headline = byClient ? 'Client cancelled' : 'Appointment cancelled';
  const leadText = byClient
    ? (client + ' cancelled their ' + service + ' appointment' + (when ? (' on ' + when) : '') + ' with ' + biz + '. The time is open again.')
    : ('You cancelled ' + client + '\u2019s ' + service + ' appointment' + (when ? (' on ' + when) : '') + ' from the Business Portal.' + (email ? ' The client is sent a cancellation email.' : '') + ' The time is open again.');
  const leadHtml = byClient
    ? ('<strong>' + esc(client) + '</strong> cancelled their appointment with <strong>' + esc(biz) + '</strong>. The time is open again.')
    : ('You cancelled this appointment for <strong>' + esc(biz) + '</strong> from the Business Portal.' + (email ? ' The client is sent a cancellation email.' : '') + ' The time is open again.');

  const text = [
    leadText,
    '',
    'Business: ' + biz,
    'Client: ' + client,
    phone ? ('Phone: ' + phone) : null,
    email ? ('Email: ' + email) : null,
    'Service: ' + service,
    date ? ('Date: ' + date) : null,
    time ? ('Time: ' + time) : null,
    'Cancelled by: ' + who,
    fee ? ('Cancellation fee: ' + fee) : null,
    ref ? ('Reference: #' + ref) : null,
    '',
    'Business Portal:',
    PORTAL_LOGIN_URL,
    '',
    '\u2014 Schedi',
  ].filter((line) => line !== null).join('\n');

  const rows = [
    ['Business', biz],
    ['Client', client],
    phone ? ['Phone', phone] : null,
    email ? ['Email', email] : null,
    ['Service', service],
    date ? ['Date', date] : null,
    time ? ['Time', time] : null,
    ['Cancelled by', who],
    fee ? ['Cancellation fee', fee] : null,
    ref ? ['Reference', '#' + ref] : null,
  ].filter(Boolean);

  const table = rows.map(function (r) {
    return '<tr><td style="padding:4px 12px 4px 0;color:#64748b;vertical-align:top">' + esc(r[0])
      + '</td><td style="padding:4px 0;font-weight:600">' + esc(r[1]) + '</td></tr>';
  }).join('');

  const html = '<div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#0f172a">'
    + '<h2 style="margin:0 0 12px;color:#e11d48">' + esc(headline) + '</h2>'
    + '<p>' + leadHtml + '</p>'
    + '<table style="border-collapse:collapse;margin:16px 0">' + table + '</table>'
    + '<p style="margin:20px 0">'
    + '<a href="' + PORTAL_LOGIN_URL + '" style="display:inline-block;background:#10b981;color:#022c22;text-decoration:none;font-weight:700;font-size:14px;padding:12px 18px;border-radius:10px">Open Business Portal</a>'
    + '</p>'
    + '<p style="font-size:12px;color:#64748b">Or open <a href="' + PORTAL_LOGIN_URL + '" style="color:#059669">' + PORTAL_LOGIN_URL + '</a>'
    + (slug ? (' \u00b7 public page <a href="https://schedi.app/' + encodeURIComponent(slug) + '/" style="color:#059669">https://schedi.app/' + esc(slug) + '/</a>') : '')
    + '</p>'
    + '<p style="color:#64748b;font-size:13px">\u2014 Schedi</p></div>';

  return {
    subject: subject.slice(0, 200),
    text,
    html,
    replyTo: email && email.indexOf('@') > 0 ? email : '',
    byClient,
  };
}

/**
 * Email the owner when a booking is cancelled (client via manage link, or owner from the portal).
 * Never throws. Idempotent via reminder doc ownerCancelNotifiedAt.
 * deps: { sendResend, getReminderDoc, mergeReminderDoc, firebaseAnonymousToken }
 */
export async function notifyOwnerOfCancellation(env, tenant, booking, deps) {
  deps = deps || {};
  try {
    if (!shouldSendOwnerCancelNotify(tenant, booking, env)) {
      return { ok: true, skipped: true, reason: 'not_eligible' };
    }
    const tenantId = clip(tenant && tenant.id, 80);
    const bookingId = clip(booking && booking.id, 40);
    if (!tenantId || !bookingId) return { ok: true, skipped: true, reason: 'missing_ids' };

    let idToken = '';
    try {
      idToken = deps.firebaseAnonymousToken ? await deps.firebaseAnonymousToken(env) : '';
    } catch (_) {}

    if (deps.getReminderDoc) {
      try {
        const rec = await deps.getReminderDoc(env, idToken, tenantId, bookingId);
        if (rec && rec.exists && rec.fields && rec.fields.ownerCancelNotifiedAt) {
          return { ok: true, skipped: true, reason: 'already_sent', emailId: rec.fields.ownerCancelEmailId || '' };
        }
      } catch (err) {
        console.warn('owner-cancel dedup check failed', err && err.message ? err.message : err);
      }
    }

    await sendOwnerPush(env, tenantId, booking, 'cancel');

    let priv = null;
    try {
      priv = await getPrivateTenant(env, tenantId);
    } catch (err) {
      console.warn('owner-cancel private read failed', err && err.message ? err.message : err);
    }
    const to = resolveOwnerNotifyAddress(tenant, priv);
    if (!to) {
      console.warn('owner-cancel skipped: no owner email', tenantSlug(tenant));
      return { ok: false, skipped: true, reason: 'owner_email_missing' };
    }

    const content = buildOwnerCancelEmail(tenant, booking);
    if (!deps.sendResend) return { ok: false, error: 'send_missing' };
    const sentAt = new Date().toISOString();
    // Stamp first so a slow/duplicate request can't send twice; clear-on-failure is not needed (rare, and a missed alert beats a double).
    if (deps.mergeReminderDoc) {
      try {
        await deps.mergeReminderDoc(env, idToken, tenantId, booking, {
          ownerCancelNotifiedAt: sentAt,
          ownerCancelBy: content.byClient ? 'client' : 'owner',
        });
      } catch (err) {
        console.warn('owner-cancel stamp failed', err && err.message ? err.message : err);
      }
    }
    const result = await deps.sendResend(env, {
      to,
      subject: content.subject,
      html: content.html,
      text: content.text,
      replyTo: content.replyTo || undefined,
      fromName: FROM_NAME,
      fromAddress: FROM_ADDRESS,
    });

    if (!result || !result.ok) {
      console.warn('owner-cancel send failed', tenantSlug(tenant), bookingId, result && result.error);
      return { ok: false, error: (result && result.error) || 'send_failed' };
    }
    if (deps.mergeReminderDoc && result.id) {
      try {
        await deps.mergeReminderDoc(env, idToken, tenantId, booking, { ownerCancelEmailId: result.id });
      } catch (_) {}
    }
    console.log('owner-cancel sent', JSON.stringify({
      slug: tenantSlug(tenant),
      bookingId,
      by: content.byClient ? 'client' : 'owner',
      emailId: result.id || '',
    }));
    return { ok: true, id: result.id, toMasked: maskEmail(to), by: content.byClient ? 'client' : 'owner' };
  } catch (err) {
    console.warn('owner-cancel exception', err && err.message ? err.message : err);
    return { ok: false, error: 'exception' };
  }
}

export function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return '***';
  const user = s.slice(0, at);
  const domain = s.slice(at + 1);
  const keep = user.length <= 2 ? user.charAt(0) : user.slice(0, 2);
  return keep + '***@' + domain;
}

/** For harness / Axel preview: return HTML without sending. */
export function previewOwnerNotifyHtml(tenant, booking) {
  return buildOwnerNotifyEmail(tenant, booking);
}
