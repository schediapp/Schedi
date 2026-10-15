/**
 * Weekly "unpaid appointments" email to each business owner.
 * Runs from the hourly cron; sends Monday at 9 AM in the business's time zone, at most once per week
 * (recorded as tenant.unpaidDigestWeek = that Monday's date). Skips when nothing is unpaid.
 * Lists past appointments (last 7 days, plus older ones still open) that are not marked paid,
 * excluding cancelled / denied / released bookings and card-paid ones. Pending (never accepted) requests are skipped.
 */

const APP = 'https://schedi.app';
const SEND_WEEKDAY = 'Mon';
const SEND_HOUR = 9;
const MAX_ROWS = 40;
const OLDEST_DAYS = 120;
const GREEN = '#059669';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function localParts(tz, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(date);
  const g = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { weekday: g('weekday'), ymd: g('year') + '-' + g('month') + '-' + g('day'), hour: parseInt(g('hour'), 10) % 24 };
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function shortDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

const METHOD_LABELS = { cashapp: 'Cash App', 'cash-app': 'Cash App', venmo: 'Venmo', zelle: 'Zelle', paypal: 'PayPal', later: 'Pay at appointment', card: 'Card' };

export function methodLabel(b) {
  const m = String(b.paymentMethod || '').toLowerCase();
  if (METHOD_LABELS[m]) return METHOD_LABELS[m];
  return String(b.paymentOptionLabel || '').trim() || 'Not set';
}

export function isPaid(b) {
  const ps = String(b.paymentStatus || '').toUpperCase();
  return ps.indexOf('PAID') !== -1 && ps.indexOf('UNPAID') === -1;
}

export function isUnpaidPast(b, today) {
  if (!b || !b.date) return false;
  if (String(b.date) >= today) return false;
  if (String(b.date) < addDays(today, -OLDEST_DAYS)) return false;
  if (b.cancelled === true || b.depositExpiredAt) return false;
  const st = String(b.status || '').toLowerCase();
  if (st === 'cancelled' || st === 'canceled' || st === 'denied' || st === 'pending') return false;
  if (isPaid(b)) return false;
  return true;
}

function amountOf(b) {
  const n = Number(b.amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  let due = n;
  if (b.depositPaid === true && Number.isFinite(Number(b.balanceDue))) due = Number(b.balanceDue);
  return Math.round(due * 100) / 100;
}

export function buildUnpaidDigestEmail(tenant, rows, today) {
  const biz = String(tenant.name || 'your business');
  const weekAgo = addDays(today, -7);
  const recent = rows.filter((b) => b.date >= weekAgo);
  const older = rows.filter((b) => b.date < weekAgo);
  const total = rows.reduce((s, b) => s + (amountOf(b) || 0), 0);
  const count = rows.length;
  const subject = count + ' appointment' + (count === 1 ? '' : 's') + ' not marked paid yet — ' + biz;
  const lead = 'Here\'s your Monday check-in. ' + (count === 1 ? 'One past appointment hasn\'t' : count + ' past appointments haven\'t')
    + ' been marked paid in Schedi' + (total > 0 ? (', about $' + total.toFixed(2) + ' in all') : '') + '. If the money already came in, a quick "Mark paid" keeps your reports right. Payment codes help you match Cash App, Venmo and Zelle notes.';
  const th = 'padding:8px 6px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #d1fae5';
  const td = 'padding:9px 6px;font-size:13px;border-bottom:1px dashed #e2e8f0;vertical-align:top';
  function table(list) {
    return '<table role="presentation" width="100%" style="border-collapse:collapse;margin:6px 0 16px">'
      + '<tr><th style="' + th + '">Client</th><th style="' + th + '">Date</th><th style="' + th + '">Service</th><th style="' + th + ';text-align:right">Amount</th></tr>'
      + list.slice(0, MAX_ROWS).map((b) => {
        const amt = amountOf(b);
        return '<tr><td style="' + td + '"><strong>' + esc(b.clientName || 'Client') + '</strong>'
          + '<div style="font-size:11px;color:#64748b">' + esc(methodLabel(b)) + (b.payCode ? (' · <span style="font-family:monospace;color:#047857;font-weight:700;letter-spacing:1px">' + esc(b.payCode) + '</span>') : '') + '</div></td>'
          + '<td style="' + td + ';white-space:nowrap">' + esc(shortDate(b.date)) + '</td>'
          + '<td style="' + td + '">' + esc(b.serviceName || 'Appointment') + '</td>'
          + '<td style="' + td + ';text-align:right;white-space:nowrap;font-weight:700">' + (amt !== null ? '$' + amt.toFixed(2) : '—') + '</td></tr>';
      }).join('')
      + '</table>';
  }
  const more = count > MAX_ROWS ? '<p style="color:#64748b;font-size:12px">…and ' + (count - MAX_ROWS) + ' more in your Roster.</p>' : '';
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(subject) + '</title></head>'
    + '<body style="margin:0;background:#f0fdf4;padding:24px 12px;font-family:Inter,Arial,sans-serif;color:#0f172a">'
    + '<div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #d1fae5;border-radius:16px;padding:26px 22px;line-height:1.5;font-size:15px">'
    + '<h1 style="margin:0 0 12px;font-size:22px;color:#064e3b">Not marked paid yet</h1>'
    + '<p>' + esc(lead) + '</p>'
    + (recent.length ? '<h2 style="font-size:14px;margin:18px 0 0;color:#064e3b">Last 7 days</h2>' + table(recent) : '')
    + (older.length ? '<h2 style="font-size:14px;margin:18px 0 0;color:#064e3b">Older, still open</h2>' + table(older) : '')
    + more
    + '<table role="presentation" cellspacing="0" cellpadding="0" style="margin:18px 0"><tr><td style="border-radius:12px;background:' + GREEN + '">'
    + '<a href="' + APP + '/login" style="display:inline-block;padding:13px 22px;font-weight:700;color:#fff;text-decoration:none;font-size:15px">Open Roster to mark paid</a></td></tr></table>'
    + '<p style="color:#64748b;font-size:12px">You get this on Mondays only when something is still unpaid. Cancelled, denied and card-paid appointments are left out.</p>'
    + '</div><p style="text-align:center;color:#64748b;font-size:12px;margin:14px 0 0">Schedi · ' + esc(biz) + '</p></body></html>';
  const lines = rows.slice(0, MAX_ROWS).map((b) => {
    const amt = amountOf(b);
    return '- ' + (b.clientName || 'Client') + ', ' + shortDate(b.date) + ', ' + (b.serviceName || 'Appointment') + ', ' + (amt !== null ? '$' + amt.toFixed(2) : 'no price') + ', ' + methodLabel(b) + (b.payCode ? ', ' + b.payCode : '');
  });
  const text = lead + '\n\n' + lines.join('\n') + (count > MAX_ROWS ? '\n…and ' + (count - MAX_ROWS) + ' more.' : '') + '\n\nOpen Roster to mark paid: ' + APP + '/login\n\n— Schedi';
  return { subject, html, text };
}

/** deps: { firebaseAnonymousToken, listAllTenants, patchTenantFields, sendResend, tenantTimezone, ownerAddress, fromAddress } */
export async function runUnpaidDigest(env, deps, opts) {
  opts = opts || {};
  const now = opts.now ? new Date(opts.now) : new Date();
  const idToken = await deps.firebaseAnonymousToken(env);
  const tenants = opts.tenants || await deps.listAllTenants(env, idToken);
  const out = { sent: 0, skippedEmpty: 0, errors: 0, actions: [] };
  for (const t of tenants) {
    const tz = deps.tenantTimezone(t);
    let lp;
    try { lp = localParts(tz, now); } catch (_) { continue; }
    if (!opts.force && (lp.weekday !== SEND_WEEKDAY || lp.hour !== SEND_HOUR)) continue;
    const week = lp.ymd;
    if (t.unpaidDigestWeek === week) continue;
    if (t.notifications && t.notifications.unpaidDigest === false) continue;
    const to = deps.ownerAddress(t);
    if (!to) continue;
    const rows = (Array.isArray(t.appointments) ? t.appointments : [])
      .filter((b) => isUnpaidPast(b, lp.ymd))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    if (!rows.length) { out.skippedEmpty++; continue; }
    out.actions.push({ tenantId: t.id, count: rows.length });
    if (opts.dryRun) continue;
    const m = buildUnpaidDigestEmail(t, rows, lp.ymd);
    const r = await deps.sendResend(env, { to, subject: m.subject, html: m.html, text: m.text, fromName: 'Schedi', fromAddress: deps.fromAddress });
    if (!r || !r.ok) { out.errors++; continue; }
    await deps.patchTenantFields(env, idToken, t.id, { unpaidDigestWeek: week });
    out.sent++;
  }
  return out;
}
