/**
 * Public booking slots must fall inside the hours the booking page would offer.
 * Date and clock are business-local wall time (the YYYY-MM-DD and "h:mm AM/PM"
 * the page sends). The weekday is the weekday of that calendar date.
 * Weekly hours, then specialHours[date] ({ closed: true } or { ranges: [{ start, end }] }),
 * then blockedTimes and blockedRules. Owner and agency manual saves do not call this.
 */
import { parseClockMinutes } from './booking-notice.js';

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const SLOT_UNAVAILABLE = 'slot_unavailable';
export const SLOT_UNAVAILABLE_MESSAGE = 'That time is not available. Choose another time.';

function weekdayAbbr(dateStr) {
  const parts = String(dateStr || '').split('-');
  if (parts.length !== 3) return '';
  const y = parseInt(parts[0], 10);
  const mo = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (!y || !mo || !d) return '';
  const day = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return DAY_ABBR[day] || '';
}

function clockMinutes(label) {
  return parseClockMinutes(label);
}

/** Same open/closed decision as the booking page resolveHoursForDate. */
export function resolveHoursForDate(tenant, dateStr) {
  const emptyClosed = { closed: true, ranges: [], reason: 'Invalid date', special: false, dayAbbr: '' };
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return emptyClosed;
  const parts = String(dateStr).split('-');
  const y = parseInt(parts[0], 10);
  const mo = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(probe.getTime()) || probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return emptyClosed;
  }
  const dayAbbr = weekdayAbbr(dateStr);
  const specialMap = tenant && tenant.specialHours && typeof tenant.specialHours === 'object' ? tenant.specialHours : null;
  const special = specialMap ? specialMap[dateStr] : null;
  if (special != null) {
    if (special && typeof special === 'object' && !Array.isArray(special) && special.closed === true) {
      return { closed: true, ranges: [], reason: 'Closed this day', special: true, dayAbbr };
    }
    const rawRanges = Array.isArray(special) ? special : (special && Array.isArray(special.ranges) ? special.ranges : null);
    if (rawRanges) {
      const ranges = [];
      for (const r of rawRanges) {
        if (!r) continue;
        const startMins = clockMinutes(r.start);
        const endMins = clockMinutes(r.end);
        if (startMins == null || endMins == null || endMins <= startMins) continue;
        ranges.push({ start: String(r.start), end: String(r.end), startMins, endMins });
      }
      if (!ranges.length) {
        return { closed: true, ranges: [], reason: 'Closed this day', special: true, dayAbbr };
      }
      ranges.sort((a, b) => a.startMins - b.startMins);
      return { closed: false, ranges, reason: '', special: true, dayAbbr };
    }
  }
  const dayHours = tenant && tenant.operatingHours ? tenant.operatingHours[dayAbbr] : null;
  if (dayHours && !dayHours.open) {
    return { closed: true, ranges: [], reason: 'Closed', special: false, dayAbbr };
  }
  let openMins = dayHours ? clockMinutes(dayHours.start) : 9 * 60;
  let closeMins = dayHours ? clockMinutes(dayHours.end) : 17 * 60;
  if (openMins == null) openMins = 9 * 60;
  if (closeMins == null || closeMins <= openMins) closeMins = 17 * 60;
  return {
    closed: false,
    ranges: [{
      start: dayHours && dayHours.start ? dayHours.start : '09:00 AM',
      end: dayHours && dayHours.end ? dayHours.end : '05:00 PM',
      startMins: openMins,
      endMins: closeMins,
    }],
    reason: '',
    special: false,
    dayAbbr,
  };
}

export function timeWithinResolvedRanges(startMins, endMins, resolved) {
  if (!resolved || resolved.closed || !resolved.ranges || !resolved.ranges.length) return false;
  return resolved.ranges.some((r) => startMins >= r.startMins && endMins <= r.endMins);
}

/** Daily applies every day. Weekly (Mondays) / Weekly (Fridays) apply on that weekday. Other values, including Monthly, apply every day. */
export function blockedRuleMatchesDay(rule, dayAbbr) {
  const freq = String((rule && rule.frequency) || 'Daily');
  if (freq === 'Weekly (Mondays)') return dayAbbr === 'Mon';
  if (freq === 'Weekly (Fridays)') return dayAbbr === 'Fri';
  return true;
}

function durationMins(text, fallback) {
  if (typeof text === 'number' && Number.isFinite(text) && text > 0) return Math.round(text);
  const str = String(text || '').toLowerCase();
  const hrs = /(\d+(?:\.\d+)?)\s*(h|hr|hour)/.exec(str);
  const mins = /(\d+)\s*(m|min)/.exec(str);
  let total = 0;
  if (hrs) total += parseFloat(hrs[1]) * 60;
  if (mins) total += parseInt(mins[1], 10);
  if (!total) {
    const bare = /^\s*(\d+)\s*$/.exec(str);
    if (bare) total = parseInt(bare[1], 10);
  }
  return total > 0 ? Math.round(total) : (fallback || 60);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function dateInBlock(dateStr, block) {
  if (!block || !dateStr) return false;
  const start = String(block.startDate || '');
  let end = String(block.endDate || block.startDate || '');
  if (!start) return false;
  if (!end) end = start;
  return dateStr >= start && dateStr <= end;
}

function blockedTimeReason(tenant, dateStr, startMins, endMins) {
  const list = tenant && Array.isArray(tenant.blockedTimes) ? tenant.blockedTimes : [];
  for (const block of list) {
    if (!dateInBlock(dateStr, block)) continue;
    if (block.allDay === true || !block.startTime) return 'blocked';
    const bStart = clockMinutes(block.startTime);
    const bEnd = clockMinutes(block.endTime);
    if (bStart == null || bEnd == null || bEnd <= bStart) return 'blocked';
    if (rangesOverlap(startMins, endMins, bStart, bEnd)) return 'blocked';
  }
  return '';
}

function blockedRuleReason(tenant, dayAbbr, startMins, endMins) {
  const rules = tenant && Array.isArray(tenant.blockedRules) ? tenant.blockedRules : [];
  for (const rule of rules) {
    if (!rule || !blockedRuleMatchesDay(rule, dayAbbr)) continue;
    const start = clockMinutes(rule.time);
    if (start == null) continue;
    const len = durationMins(rule.duration, 60);
    if (rangesOverlap(startMins, endMins, start, start + len)) return 'blocked';
  }
  return '';
}

/**
 * '' when the visit fits open hours and misses blocks.
 * Otherwise a short reason: invalid, closed, outside, or blocked.
 */
export function slotAvailabilityProblem(tenant, booking) {
  if (!booking) return 'invalid';
  const dateStr = String(booking.date || '');
  const resolved = resolveHoursForDate(tenant, dateStr);
  if (resolved.reason === 'Invalid date') return 'invalid';
  if (resolved.closed) return 'closed';
  const startMins = clockMinutes(booking.time);
  if (startMins == null) return 'invalid';
  const dur = Number(booking.durationMins) > 0 ? Math.round(Number(booking.durationMins)) : 60;
  const endMins = startMins + dur;
  if (!timeWithinResolvedRanges(startMins, endMins, resolved)) return 'outside';
  if (blockedTimeReason(tenant, dateStr, startMins, endMins)) return 'blocked';
  if (blockedRuleReason(tenant, resolved.dayAbbr, startMins, endMins)) return 'blocked';
  return '';
}

/** '' or 'slot_unavailable'. */
export function bookingAvailabilityError(tenant, booking) {
  return slotAvailabilityProblem(tenant, booking) ? SLOT_UNAVAILABLE : '';
}
