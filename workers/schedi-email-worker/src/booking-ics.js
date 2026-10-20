/**
 * GET /api/booking-ics?tenant=<slug|id>&id=<bookingId>&t=<manageToken>
 * Returns a downloadable .ics when the manage token matches. No token → 404.
 */
import { adminAuthHeaders } from './firebase-admin.js';
import { publicBusinessAddress } from './public-address.js';

export { publicBusinessAddress };

function clip(v, n) {
  return String(v == null ? '' : v).trim().slice(0, n || 160);
}

function icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function toMinutes(label) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*$/i.exec(String(label || ''));
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatUtcBasic(date) {
  if (!date || !(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  return (
    date.getUTCFullYear() +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    'T' +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    'Z'
  );
}

function wallTimeToUtcDate(dateStr, minutesOfDay, timeZone) {
  const p = String(dateStr || '').split('-');
  if (p.length !== 3) return null;
  const y = parseInt(p[0], 10);
  const mo = parseInt(p[1], 10);
  const d = parseInt(p[2], 10);
  if (!y || !mo || !d) return null;
  const mins = minutesOfDay == null ? 0 : minutesOfDay;
  const h = Math.floor(mins / 60);
  const mi = mins % 60;
  let utc = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  function partsInTz(date) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const map = {};
    fmt.formatToParts(date).forEach((part) => {
      if (part.type !== 'literal') map[part.type] = part.value;
    });
    return map;
  }
  for (let i = 0; i < 4; i++) {
    const parts = partsInTz(utc);
    const gotY = parseInt(parts.year, 10);
    const gotM = parseInt(parts.month, 10);
    const gotD = parseInt(parts.day, 10);
    let gotH = parseInt(parts.hour, 10);
    if (gotH === 24) gotH = 0;
    const gotMin = parseInt(parts.minute, 10);
    const want = Date.UTC(y, mo - 1, d, h, mi, 0);
    const got = Date.UTC(gotY, gotM - 1, gotD, gotH, gotMin, 0);
    utc = new Date(utc.getTime() + (want - got));
  }
  return utc;
}

function durationMins(booking) {
  const n = Number(booking && booking.durationMins);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return 60;
}

function buildIcsBody(tenant, booking, manageUrl) {
  const tz = String((tenant && (tenant.timezone || tenant.timeZone)) || 'America/New_York').trim() || 'America/New_York';
  const loc = publicBusinessAddress(tenant);
  const service = String((booking && booking.serviceName) || 'Appointment');
  const biz = String((tenant && tenant.name) || 'Schedi');
  const summary = service + ' at ' + biz;
  let startMins = toMinutes(booking && booking.time);
  if (startMins == null) startMins = 10 * 60;
  const dur = durationMins(booking);
  let endMins = startMins + dur;
  let dateStr = String((booking && booking.date) || '');
  let endDateStr = dateStr;
  if (endMins >= 24 * 60) {
    endMins -= 24 * 60;
    const p = dateStr.split('-');
    const d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    d.setDate(d.getDate() + 1);
    endDateStr =
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  const startUtc = wallTimeToUtcDate(dateStr, startMins, tz);
  const endUtc = wallTimeToUtcDate(endDateStr, endMins, tz);
  const uid = 'schedi-' + String((booking && booking.id) || 'booking') + '@schedi.app';
  const descParts = [
    'Service: ' + service,
    'With: ' + biz,
    'Reference: #' + String((booking && booking.id) || ''),
  ];
  if (manageUrl) descParts.push('Manage: ' + manageUrl);
  const description = descParts.join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Schedi//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + formatUtcBasic(new Date()),
    'DTSTART:' + formatUtcBasic(startUtc),
    'DTEND:' + formatUtcBasic(endUtc),
    'SUMMARY:' + icsEscape(summary),
    'DESCRIPTION:' + icsEscape(description),
  ];
  if (loc) lines.push('LOCATION:' + icsEscape(loc));
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export async function handleBookingIcs(request, env, deps) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  }
  if (request.method !== 'GET') {
    return deps.json({ ok: false, error: 'method_not_allowed' }, 405, '');
  }
  const tenantKey = clip(url.searchParams.get('tenant'), 48);
  const bookingId = clip(url.searchParams.get('id'), 40);
  const token = clip(url.searchParams.get('t'), 128);
  if (!tenantKey || !bookingId || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    return new Response('Not found', { status: 404 });
  }
  const idToken = await deps.firebaseAnonymousToken(env);
  let tenant = await deps.getTenantById(env, idToken, tenantKey);
  if (!tenant) {
    const all = await deps.listAllTenants(env, idToken);
    tenant = (all || []).find((t) => t && (t.id === tenantKey || String(t.slug || '').toLowerCase() === tenantKey.toLowerCase())) || null;
  }
  if (!tenant) return new Response('Not found', { status: 404 });
  const booking = (tenant.appointments || []).find((a) => a && String(a.id) === bookingId);
  if (!booking || String(booking.manageToken || '') !== token) {
    return new Response('Not found', { status: 404 });
  }
  const slug = String(tenant.slug || tenant.id || '').trim();
  const manageUrl = slug ? ('https://schedi.app/' + slug + '/manage/' + token) : '';
  const body = buildIcsBody(tenant, booking, manageUrl);
  const fileName = 'schedi-' + bookingId + '.ics';
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + fileName + '"',
      'Cache-Control': 'private, no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
