/**
 * Private iCal busy times.
 * Blocks are start/end instants only. Titles, locations, and attendees are dropped.
 */
import ICAL from 'ical.js';

const MAX_BLOCKS = 2000;
const MAX_OCCURRENCES = 20000;
const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function wallTimeToUtc(dateStr, minutesOfDay, timeZone) {
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
    let hour = parseInt(map.hour, 10);
    if (hour === 24) hour = 0;
    return {
      y: parseInt(map.year, 10),
      mo: parseInt(map.month, 10),
      d: parseInt(map.day, 10),
      h: hour,
      mi: parseInt(map.minute, 10),
    };
  }
  for (let i = 0; i < 4; i++) {
    const got = partsInTz(utc);
    const want = Date.UTC(y, mo - 1, d, h, mi, 0);
    const have = Date.UTC(got.y, got.mo - 1, got.d, got.h, got.mi, 0);
    const next = new Date(utc.getTime() + (want - have));
    if (next.getTime() === utc.getTime()) break;
    utc = next;
  }
  return utc;
}

function shiftIsoDate(iso, days) {
  const p = String(iso || '').split('-');
  if (p.length !== 3) return '';
  const d = new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

function toMinutes(label) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*$/i.exec(String(label || ''));
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function ipv4Parts(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

function ipv4IsPrivate(parts) {
  const a = parts[0];
  const b = parts[1];
  const c = parts[2];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function expandIpv6(ip) {
  let text = String(ip || '').toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (!text.includes(':')) return null;
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side) => {
    if (!side) return [];
    return side.split(':').map((part) => {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      return parseInt(part, 16);
    });
  };
  const left = parseSide(halves[0]);
  const right = halves.length === 2 ? parseSide(halves[1]) : [];
  if (left.includes(null) || right.includes(null)) return null;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    return left;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return left.concat(Array(missing).fill(0), right);
}

function ipv6IsPrivate(groups) {
  if (!groups || groups.length !== 8) return true;
  const allZero = groups.every((n) => n === 0);
  if (allZero) return true;
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return true;
  const head = groups[0];
  if ((head & 0xfe00) === 0xfc00) return true;
  if ((head & 0xffc0) === 0xfe80) return true;
  if ((head & 0xff00) === 0xff00) return true;
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    const v4 = [(groups[6] >> 8) & 255, groups[6] & 255, (groups[7] >> 8) & 255, groups[7] & 255];
    return ipv4IsPrivate(v4);
  }
  return false;
}

export function ipIsPrivate(ip) {
  const text = String(ip || '').trim().toLowerCase();
  const v4 = ipv4Parts(text);
  if (v4) return ipv4IsPrivate(v4);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (mapped) {
    const parts = ipv4Parts(mapped[1]);
    return !parts || ipv4IsPrivate(parts);
  }
  const v6 = expandIpv6(text);
  if (v6) return ipv6IsPrivate(v6);
  return false;
}

export function hostIsBlocked(hostname) {
  let host = String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === 'metadata' || host === 'metadata.google.internal') return true;
  if (/^\d+$/.test(host) || /^0x[0-9a-f.]+$/i.test(host)) return true;
  if (ipv4Parts(host)) return ipIsPrivate(host);
  if (host.includes(':')) return ipIsPrivate(host);
  if (/^\d+\.\d+\.\d+$/.test(host) || /^\d+\.\d+$/.test(host)) return true;
  return false;
}

export function normalizeCalendarUrl(raw) {
  let text = String(raw || '').trim();
  if (!text || text.length > 2000) return { ok: false, error: 'Paste a calendar link.' };
  if (/^webcals:\/\//i.test(text)) text = 'https://' + text.slice('webcals://'.length);
  else if (/^webcal:\/\//i.test(text)) text = 'https://' + text.slice('webcal://'.length);
  let url;
  try { url = new URL(text); } catch (_) { return { ok: false, error: 'That link is not a calendar address.' }; }
  if (url.protocol !== 'https:') return { ok: false, error: 'Use an https or webcal link.' };
  if (url.username || url.password) return { ok: false, error: 'Remove any username or password from the link.' };
  if (hostIsBlocked(url.hostname)) return { ok: false, error: 'That address cannot be used.' };
  url.hash = '';
  return { ok: true, url: url.toString(), host: url.hostname };
}

export function maskCalendarUrl(raw) {
  const normalized = normalizeCalendarUrl(raw);
  const source = normalized.ok ? normalized.url : String(raw || '');
  let url;
  try { url = new URL(source); } catch (_) { return 'calendar link'; }
  const host = url.hostname.replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  const tail = parts.length ? parts[parts.length - 1] : '';
  const shortTail = tail.length > 28 ? tail.slice(0, 12) + '…' + tail.slice(-10) : tail;
  return shortTail ? host + '/…/' + shortTail : host;
}

export function providerLabel(raw) {
  let host = '';
  try { host = new URL(normalizeCalendarUrl(raw).url || raw).hostname.toLowerCase(); } catch (_) { host = ''; }
  if (host.includes('google')) return 'Google Calendar';
  if (host.includes('icloud') || host.includes('apple')) return 'Apple Calendar';
  if (host.includes('outlook') || host.includes('office') || host.includes('live.com') || host.includes('microsoft')) return 'Outlook';
  return 'Calendar';
}

function notIcs() {
  const error = new Error('not_ics');
  error.code = 'not_ics';
  return error;
}

function propText(event, name) {
  if (!event || !event.component) return '';
  return String(event.component.getFirstPropertyValue(name) || '').toUpperCase();
}

function isCancelled(event) {
  return propText(event, 'status') === 'CANCELLED';
}

function isTransparent(event) {
  return propText(event, 'transp') === 'TRANSPARENT';
}

function icalToDate(time, timeZone) {
  if (!time) return null;
  const tzid = time.zone && time.zone.tzid ? String(time.zone.tzid) : '';
  if (tzid && tzid !== 'floating') {
    const date = time.toJSDate();
    return date && Number.isFinite(date.getTime()) ? date : null;
  }
  const dateStr = time.year + '-' + pad2(time.month) + '-' + pad2(time.day);
  return wallTimeToUtc(dateStr, time.hour * 60 + time.minute, timeZone);
}

function rangeFromTimes(startTime, endTime, timeZone) {
  if (!startTime) return null;
  if (startTime.isDate) {
    const start = wallTimeToUtc(startTime.year + '-' + pad2(startTime.month) + '-' + pad2(startTime.day), 0, timeZone);
    let end = null;
    if (endTime && endTime.isDate) {
      end = wallTimeToUtc(endTime.year + '-' + pad2(endTime.month) + '-' + pad2(endTime.day), 0, timeZone);
    }
    if (!end && start) end = new Date(start.getTime() + DAY_MS);
    if (!start || !end) return null;
    return { startMs: start.getTime(), endMs: end.getTime() };
  }
  const start = icalToDate(startTime, timeZone);
  const end = endTime ? icalToDate(endTime, timeZone) : (start ? new Date(start.getTime() + 60 * 60000) : null);
  if (!start || !end) return null;
  return { startMs: start.getTime(), endMs: end.getTime() };
}

function pushRange(blocks, range, windowStart, windowEnd) {
  if (!range || range.endMs <= range.startMs) return;
  if (range.endMs <= windowStart || range.startMs >= windowEnd) return;
  blocks.push({ start: new Date(range.startMs).toISOString(), end: new Date(range.endMs).toISOString() });
}

function expandRecurring(event, blocks, windowStart, windowEnd, timeZone) {
  // Keep the event's own DTSTART. Passing a later start into iterator()
  // rebases the rule and drops EXDATE / RECURRENCE-ID alignment.
  const iter = event.iterator();
  let guard = 0;
  let next = iter.next();
  while (next && guard < MAX_OCCURRENCES) {
    guard += 1;
    let when = 0;
    try { when = next.toJSDate().getTime(); } catch (_) { when = 0; }
    if (when && when >= windowEnd + DAY_MS) break;
    let details = null;
    try { details = event.getOccurrenceDetails(next); } catch (_) { details = null; }
    if (details) {
      const item = details.item || event;
      if (!isCancelled(item) && !isTransparent(item)) {
        pushRange(blocks, rangeFromTimes(details.startDate, details.endDate, timeZone), windowStart, windowEnd);
      }
    }
    next = iter.next();
  }
}

export function parseBusyBlocks(icsText, options) {
  const opts = options || {};
  const now = opts.now instanceof Date ? opts.now : new Date();
  const horizonDays = Number(opts.horizonDays) > 0 ? Math.min(366, Number(opts.horizonDays)) : 90;
  const timeZone = String(opts.timeZone || 'America/New_York') || 'America/New_York';
  const windowStart = now.getTime();
  const windowEnd = now.getTime() + horizonDays * DAY_MS;
  let root;
  try {
    root = new ICAL.Component(ICAL.parse(String(icsText || '')));
  } catch (_) {
    throw notIcs();
  }
  if (!root || String(root.name || '').toLowerCase() !== 'vcalendar') throw notIcs();
  const vevents = root.getAllSubcomponents('vevent');
  const blocks = [];
  const masterUids = new Set();
  for (const vevent of vevents) {
    if (vevent.getFirstProperty('recurrence-id')) continue;
    const event = new ICAL.Event(vevent);
    const uid = String(event.uid || '');
    if (uid) masterUids.add(uid);
    if (isCancelled(event) || isTransparent(event)) continue;
    if (event.isRecurring()) expandRecurring(event, blocks, windowStart, windowEnd, timeZone);
    else pushRange(blocks, rangeFromTimes(event.startDate, event.endDate, timeZone), windowStart, windowEnd);
  }
  for (const vevent of vevents) {
    if (!vevent.getFirstProperty('recurrence-id')) continue;
    const uid = String(vevent.getFirstPropertyValue('uid') || '');
    if (uid && masterUids.has(uid)) continue;
    const event = new ICAL.Event(vevent);
    if (isCancelled(event) || isTransparent(event)) continue;
    pushRange(blocks, rangeFromTimes(event.startDate, event.endDate, timeZone), windowStart, windowEnd);
  }
  return mergeBusyBlocks(blocks).slice(0, MAX_BLOCKS);
}

export function mergeBusyBlocks(blocks) {
  const rows = [];
  for (const block of blocks || []) {
    const startMs = Date.parse(block && block.start);
    const endMs = Date.parse(block && block.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    rows.push({ startMs, endMs });
  }
  rows.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged = [];
  for (const row of rows) {
    const last = merged[merged.length - 1];
    if (last && row.startMs <= last.endMs) {
      if (row.endMs > last.endMs) last.endMs = row.endMs;
    } else merged.push({ startMs: row.startMs, endMs: row.endMs });
  }
  return merged.map((row) => ({
    start: new Date(row.startMs).toISOString(),
    end: new Date(row.endMs).toISOString(),
  }));
}

export function bookingOverlapsBusy(blocks, booking, options) {
  const opts = options || {};
  const timeZone = String(opts.timeZone || 'America/New_York') || 'America/New_York';
  const bufferRaw = Number(opts.bufferMins);
  const bufferMins = Number.isFinite(bufferRaw) && bufferRaw >= 0 ? bufferRaw : 0;
  const startMin = toMinutes(booking && booking.time);
  const dateStr = String((booking && booking.date) || '');
  if (startMin == null || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const dur = Number(booking.durationMins) > 0 ? Math.round(Number(booking.durationMins)) : 60;
  let endMin = startMin + dur;
  let endDate = dateStr;
  if (endMin >= 1440) {
    endMin -= 1440;
    endDate = shiftIsoDate(dateStr, 1);
  }
  const start = wallTimeToUtc(dateStr, startMin, timeZone);
  const end = wallTimeToUtc(endDate, endMin, timeZone);
  if (!start || !end) return false;
  const buf = bufferMins * 60000;
  const s = start.getTime();
  const e = end.getTime();
  return (blocks || []).some((block) => {
    const b0 = Date.parse(block && block.start);
    const b1 = Date.parse(block && block.end);
    if (!Number.isFinite(b0) || !Number.isFinite(b1)) return false;
    return s < b1 + buf && b0 < e + buf;
  });
}
