/**
 * One client email when a recurring series is created.
 *
 * Public booking and the owner roster both save every visit, then the page also queues a
 * per-visit "You're booked!" message. That per-visit mail is not sent for a series. This module
 * sends a single "Your visits are booked" note after the save succeeds, for the whole series.
 * A later per-visit confirmation for any visit in the series sends this same note once (AUTH_KV
 * remembers the series) and does not send the per-visit copy. Owner new-booking alerts are not
 * handled here and stay as they are.
 *
 * The note is skipped when the client has no email, or when confirmation emails are turned off.
 * It never names a plan.
 */
import { formatFriendlyLocalDate } from './owner-notify.js';
import { cancellationFeeSentence } from './cancellation-fee.js';

const MARK_URL = 'https://schedi.app/assets/email-calendar-check.png';
const FROM_ADDRESS = 'bookings@schedi.app';
/** Dates after the first visit that are written out before "and N more". */
export const SERIES_FOLLOWING_CAP = 6;
const ONCE_TTL_SEC = 60 * 24 * 60 * 60;

function clip(v, n) {
  return String(v == null ? '' : v).trim().slice(0, n);
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return '$' + v.toFixed(2);
}

export function isSeriesBooking(booking) {
  if (!booking || !booking.recurrence) return false;
  const rec = booking.recurrence;
  const freq = String(rec.frequency || '').toLowerCase();
  const many = Number(rec.total) > 1 || (Array.isArray(rec.dates) && rec.dates.length > 1);
  if (!many) return false;
  if (booking.seriesId) return true;
  return freq !== 'once';
}

export function seriesFrequencyLabel(freq) {
  const f = String(freq || '').toLowerCase();
  if (f === 'weekly') return 'Weekly';
  if (f === 'biweekly') return 'Biweekly';
  if (f === 'monthly') return 'Monthly';
  if (f === 'custom') return 'Custom dates';
  return 'Repeating';
}

export function seriesTimeZoneLabel(tenant) {
  const tz = clip((tenant && (tenant.timezone || tenant.timeZone)) || 'America/New_York', 80) || 'America/New_York';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longGeneric',
    }).formatToParts(new Date('2026-06-15T16:00:00Z'));
    const name = parts.find((p) => p.type === 'timeZoneName');
    if (name && name.value) return name.value;
  } catch (_) {}
  return tz;
}

function toMinutes(label) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*$/i.exec(String(label || ''));
  if (!m) return 0;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

function compareVisits(a, b) {
  const ad = String(a && a.date || '');
  const bd = String(b && b.date || '');
  if (ad !== bd) return ad < bd ? -1 : 1;
  return toMinutes(a && a.time) - toMinutes(b && b.time);
}

export function seriesKey(booking) {
  if (!booking) return '';
  if (booking.seriesId && (isSeriesBooking(booking) || booking.seriesId)) return String(booking.seriesId);
  if (!isSeriesBooking(booking)) return '';
  const rec = booking.recurrence || {};
  const dates = Array.isArray(rec.dates) ? rec.dates.join(',') : '';
  return 'recurrence:' + String(rec.frequency || '') + ':' + dates;
}

/**
 * One row per visit. When the series record lists more dates than the bookings in hand,
 * those dates are included so the email can name them.
 */
export function expandSeriesVisits(bookings) {
  const list = (bookings || []).filter(Boolean).slice().sort(compareVisits);
  if (!list.length) return [];
  const rec = list.map((b) => b.recurrence).find((r) => r && Array.isArray(r.dates) && r.dates.length > 1);
  if (!rec) return list;
  const byDate = new Map();
  for (const b of list) {
    if (b.date && !byDate.has(String(b.date))) byDate.set(String(b.date), b);
  }
  return rec.dates.map((date, i) => {
    const hit = byDate.get(String(date)) || {};
    const time = (Array.isArray(rec.times) && rec.times[i]) || hit.time || list[0].time || '';
    return Object.assign({}, list[0], hit, { date: String(date), time: String(time || '') });
  });
}

function visitWhen(visit) {
  const date = formatFriendlyLocalDate(visit && visit.date);
  const time = clip(visit && visit.time, 20);
  return time ? (date + ' at ' + time) : date;
}

/**
 * Dates after the first visit. Up to SERIES_FOLLOWING_CAP are written out.
 * If more remain, the line ends with "and N more". If the list is complete, the last
 * date is the end date ("ends …").
 */
export function seriesComingUpLine(visits) {
  const rest = (visits || []).slice(1);
  if (!rest.length) return '';
  const shown = rest.slice(0, SERIES_FOLLOWING_CAP);
  const hidden = rest.length - shown.length;
  const bits = shown.map((visit, i) => {
    const when = visitWhen(visit);
    if (hidden === 0 && i === shown.length - 1) return 'ends ' + when;
    return when;
  });
  let line = bits.join(', ');
  if (hidden > 0) line += ', and ' + hidden + ' more';
  return line;
}

function paymentLabel(booking) {
  const stored = clip(booking && booking.paymentOptionLabel, 40);
  if (stored && stored !== '—') return stored;
  const method = String((booking && booking.paymentMethod) || '').toLowerCase();
  const map = {
    card: 'Card',
    cashapp: 'Cash App',
    'cash-app': 'Cash App',
    zelle: 'Zelle',
    venmo: 'Venmo',
    paypal: 'PayPal',
    later: 'Pay at the visit',
    cash: 'Cash',
  };
  return map[method] || '';
}

export function seriesPaymentNote(booking) {
  if (!booking) return '';
  const parts = [];
  const dep = Number(booking.depositAmount);
  if (dep > 0) {
    const paid = booking.depositPaid === true;
    parts.push((paid ? 'Your deposit of ' : 'A deposit of ') + money(dep) + (paid ? ' is paid.' : ' is due.'));
    const bal = Number(booking.balanceDue);
    if (Number.isFinite(bal) && bal > 0) parts.push(money(bal) + ' is due at the visit.');
  }
  const label = paymentLabel(booking);
  if (label) parts.push('Payment: ' + label + '.');
  return parts.join(' ');
}

export function seriesManageUrl(tenant, booking) {
  const token = String(booking && booking.manageToken || '');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return '';
  const slug = clip((tenant && (tenant.slug || tenant.id)) || '', 80);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(slug)) return '';
  return 'https://schedi.app/' + slug + '/manage/' + token;
}

function contactBits(tenant) {
  const name = clip(tenant && tenant.ownerName, 80) || 'the business';
  const email = clip((tenant && tenant.notifications && tenant.notifications.replyTo) || (tenant && tenant.ownerEmail) || '', 160);
  const phone = clip(tenant && tenant.ownerPhone, 40);
  let text = name;
  if (email && email.indexOf('@') > 0) text += ' at ' + email;
  if (phone) text += (email ? ' or ' : ' at ') + phone;
  return { name, email: email.indexOf('@') > 0 ? email : '', phone, text };
}

function calParts(dateStr) {
  const raw = String(dateStr || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { mon: '', day: '' };
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d);
  if (!Number.isFinite(dt.getTime())) return { mon: '', day: '' };
  return {
    mon: dt.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
    day: String(dt.getDate()),
  };
}

function clientEmailOf(visits) {
  for (const visit of visits) {
    const email = clip(visit && visit.clientEmail, 160);
    if (email.indexOf('@') > 0) return email;
  }
  return '';
}

/**
 * The series card. Same shell as the one-visit confirmation: green header, date chip, rows,
 * manage link, contact line. Returns null when this is not a series.
 */
export function buildSeriesConfirmedEmail(tenant, bookings) {
  const visits = expandSeriesVisits(bookings);
  if (visits.length < 2) return null;
  const first = visits[0];
  const rec = visits.map((v) => v.recurrence).find(Boolean) || {};
  const biz = clip(tenant && tenant.name, 120) || 'your business';
  const service = clip(first.serviceName, 120) || 'Appointment';
  const freq = seriesFrequencyLabel(rec.frequency);
  const zone = seriesTimeZoneLabel(tenant);
  const coming = seriesComingUpLine(visits);
  const pay = seriesPaymentNote(first);
  const fee = cancellationFeeSentence(tenant, first.amount);
  const extra = clip(tenant && tenant.notifications && tenant.notifications.extraNote, 500);
  const manageUrl = seriesManageUrl(tenant, first);
  const contact = contactBits(tenant);
  const friendly = formatFriendlyLocalDate(first.date);
  const cal = calParts(first.date);
  const time = clip(first.time, 20);
  const headline = 'Your visits are booked';
  const sub = 'See you soon at ' + biz;
  const subject = headline + ' \u2014 ' + biz;

  const text = [
    headline,
    sub,
    '',
    'Business: ' + biz,
    'Service: ' + service,
    'Repeats: ' + freq,
    'First visit: ' + visitWhen(first),
    coming ? ('Coming up: ' + coming) : '',
    'Time zone: ' + zone,
    pay || '',
    fee || '',
    extra ? ('Note: ' + extra) : '',
    first.id ? ('First visit ref: #' + first.id) : '',
    manageUrl ? ('Manage / reschedule / cancel:\n' + manageUrl) : '',
    manageUrl ? 'Cancelling or rescheduling from that link updates the first visit only, not the other visits.' : '',
    '',
    'Questions? Contact ' + contact.text + '.',
    '',
    '\u2014 ' + biz,
  ].filter((line) => line !== '').join('\n');

  function row(label, value, last) {
    const border = last ? 'border-bottom:none;' : 'border-bottom:1px dashed #334155;';
    return '<tr><td style="padding:13px 0;' + border + 'font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#94a3b8;vertical-align:middle;">' + esc(label) + '</td>'
      + '<td style="padding:13px 0;' + border + 'font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#f1f5f9;font-weight:600;text-align:right;vertical-align:middle;">' + value + '</td></tr>';
  }
  const rows = [
    ['Business', esc(biz)],
    ['Service', esc(service)],
    ['Repeats', esc(freq)],
    ['First visit', esc(visitWhen(first))],
    coming ? ['Coming up', esc(coming)] : null,
    ['Time zone', esc(zone)],
    pay ? ['Payment', esc(pay)] : null,
    first.id ? ['First visit ref', esc('#' + first.id)] : null,
  ].filter(Boolean);
  const rowsHtml = rows.map((pair, i) => row(pair[0], pair[1], i === rows.length - 1)).join('');
  const whenLine = time
    ? ('<strong style="color:#34d399;font-weight:600">' + esc(time) + '</strong>')
    : '';
  let manageHtml = '';
  if (manageUrl) {
    const href = manageUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    manageHtml = '<tr><td align="center" style="padding:18px 28px 8px;">'
      + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
      + '<td align="center" bgcolor="#059669" style="background-color:#059669;border-radius:14px;">'
      + '<a href="' + href + '" style="display:block;padding:14px 18px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">Manage / reschedule / cancel</a>'
      + '</td></tr></table>'
      + '<p style="margin:10px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#64748b;line-height:1.4;">Cancel or reschedule without signing in. This link is for the first visit.</p>'
      + '</td></tr>';
  }
  let notesHtml = '';
  if (fee) {
    notesHtml += '<tr><td style="padding:8px 28px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#94a3b8;line-height:1.45;">' + esc(fee) + '</td></tr>';
  }
  if (extra) {
    notesHtml += '<tr><td style="padding:10px 28px 0;"><div style="padding:12px 14px;border-radius:10px;background-color:#111c33;border:1px solid #334155;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#cbd5e1;">' + esc(extra) + '</div></td></tr>';
  }
  const contactHtml = 'Questions? Contact ' + esc(contact.name)
    + (contact.email ? (' at <a href="mailto:' + esc(contact.email) + '" style="color:#34d399;text-decoration:none;">' + esc(contact.email) + '</a>') : '')
    + (contact.phone ? (' or ' + esc(contact.phone)) : '')
    + '.';
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;background-color:#020617;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#020617;"><tr><td align="center" style="padding:24px 12px;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;width:100%;background-color:#0b1325;border:1px solid #334155;border-radius:24px;overflow:hidden;">'
    + '<tr><td align="center" bgcolor="#059669" style="background-color:#059669;padding:36px 28px 40px;">'
    + '<img src="' + MARK_URL + '" width="72" height="72" alt="" style="display:block;width:72px;height:72px;border:0;border-radius:20px;margin:0 auto 16px;">'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:28px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;line-height:1.2;">' + esc(headline) + '</div>'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#ecfdf5;margin-top:8px;line-height:1.4;">' + esc(sub) + '</div>'
    + '</td></tr>'
    + '<tr><td style="padding:0 24px;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:-22px;background-color:#111c33;border:1px solid #334155;border-radius:18px;"><tr>'
    + '<td width="62" valign="middle" style="padding:14px 0 14px 16px;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="62" style="width:62px;border-radius:12px;overflow:hidden;">'
    + '<tr><td align="center" bgcolor="#059669" style="background-color:#059669;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:1.5px;padding:4px 0;">' + esc(cal.mon) + '</td></tr>'
    + '<tr><td align="center" bgcolor="#ffffff" style="background-color:#ffffff;color:#020617;font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:700;padding:4px 0 6px;">' + esc(cal.day) + '</td></tr>'
    + '</table></td>'
    + '<td valign="middle" style="padding:14px 16px 14px 12px;font-family:Arial,Helvetica,sans-serif;">'
    + '<div style="color:#ffffff;font-size:16px;font-weight:600;line-height:1.3;">' + esc(friendly) + '</div>'
    + '<div style="color:#94a3b8;font-size:14px;margin-top:4px;line-height:1.3;">' + whenLine + '</div>'
    + '</td></tr></table></td></tr>'
    + '<tr><td style="padding:8px 28px 6px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">' + rowsHtml + '</table></td></tr>'
    + manageHtml
    + notesHtml
    + '<tr><td style="padding:18px 28px 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>'
    + '<td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#64748b;vertical-align:middle;">' + contactHtml + '</td>'
    + '<td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#94a3b8;font-weight:600;vertical-align:middle;">'
    + '<img src="' + MARK_URL + '" width="16" height="16" alt="" style="display:inline-block;width:16px;height:16px;border:0;vertical-align:middle;margin-right:4px;">Schedi</td>'
    + '</tr></table></td></tr>'
    + '</table>'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#475569;padding:16px 8px 0;">Powered by Schedi</div>'
    + '</td></tr></table></body></html>';

  return {
    subject,
    text,
    html,
    to: clientEmailOf(visits),
    replyTo: contact.email,
    fromName: biz,
  };
}

function seriesMailKey(tenantId, key) {
  return 'seriesmail:' + clip(tenantId, 80) + ':' + clip(key, 80);
}

function confirmationsOn(tenant) {
  const notes = tenant && tenant.notifications;
  if (!notes || typeof notes !== 'object') return true;
  return notes.emailConfirmations !== false;
}

export function seriesGroups(bookings) {
  const groups = new Map();
  for (const booking of bookings || []) {
    if (!booking) continue;
    const key = booking.seriesId ? String(booking.seriesId) : seriesKey(booking);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(booking);
  }
  const out = [];
  for (const [key, list] of groups) {
    const visits = expandSeriesVisits(list);
    const series = visits.length > 1 || list.some(isSeriesBooking);
    if (series && visits.length > 1) out.push({ key, visits });
  }
  return out;
}

async function deliverOne(env, tenant, group, deps) {
  const visits = group.visits || [];
  const content = buildSeriesConfirmedEmail(tenant, visits);
  if (!content) return { ok: true, skipped: true, reason: 'not_a_series' };
  if (!confirmationsOn(tenant)) return { ok: true, skipped: true, reason: 'disabled' };
  if (!content.to) return { ok: true, skipped: true, reason: 'no_email' };
  const onceKey = seriesMailKey(tenant && tenant.id, group.key);
  if (env && env.AUTH_KV && onceKey) {
    try {
      if (await env.AUTH_KV.get(onceKey)) return { ok: true, skipped: true, reason: 'already_sent' };
    } catch (_) {}
  }
  if (!deps || typeof deps.sendResend !== 'function') return { ok: false, error: 'send_missing' };
  const result = await deps.sendResend(env, {
    to: content.to,
    subject: content.subject,
    html: content.html,
    text: content.text,
    replyTo: content.replyTo || undefined,
    fromName: content.fromName,
    fromAddress: FROM_ADDRESS,
  });
  if (!result || !result.ok) {
    return { ok: false, error: (result && result.error) || 'send_failed' };
  }
  if (env && env.AUTH_KV && onceKey) {
    try { await env.AUTH_KV.put(onceKey, '1', { expirationTtl: ONCE_TTL_SEC }); } catch (_) {}
  }
  return { ok: true, id: result.id || '', series: true };
}

/** Send one email per series in the list. Never throws. */
export async function deliverSeriesConfirmations(env, tenant, bookings, deps) {
  try {
    const groups = seriesGroups(bookings);
    if (!groups.length) return { ok: true, skipped: true, reason: 'not_a_series', sent: 0 };
    const results = [];
    for (const group of groups) results.push(await deliverOne(env, tenant, group, deps));
    const sent = results.filter((r) => r && r.id);
    if (sent.length) return { ok: true, id: sent[0].id, sent: sent.length, series: true, results };
    const failed = results.find((r) => r && r.ok === false);
    if (failed) return failed;
    return { ok: true, skipped: true, reason: (results[0] && results[0].reason) || 'skipped', sent: 0, results };
  } catch (err) {
    console.warn('series-mail failed', err && err.message ? err.message : err);
    return { ok: false, error: 'series_mail_failed' };
  }
}
