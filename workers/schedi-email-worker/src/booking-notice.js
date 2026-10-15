/**
 * Minimum booking notice.
 * The public page hides start times inside this window. Create must reject them too.
 * Allowed values: 0 (none), 1, 2, 4, 12, 24, 48 hours. Missing or unknown values use 2.
 */

export const MIN_NOTICE_HOURS = [0, 1, 2, 4, 12, 24, 48];

export function normalizeMinNoticeHours(value) {
  if (value == null || value === "") return 2;
  if (value === "none" || value === "None") return 0;
  const n = Number(value);
  if (MIN_NOTICE_HOURS.indexOf(n) !== -1) return n;
  return 2;
}

export function parseClockMinutes(label) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*$/i.exec(String(label || ""));
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59 || h > 23) return null;
  const ampm = (m[3] || "").toUpperCase();
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
  }
  return h * 60 + min;
}

/** Wall clock in an IANA zone → UTC Date. Mirrors the booking page converter. */
export function wallTimeToUtc(dateStr, minutesOfDay, timeZone) {
  const p = String(dateStr || "").split("-");
  if (p.length !== 3) return null;
  const y = parseInt(p[0], 10);
  const mo = parseInt(p[1], 10);
  const d = parseInt(p[2], 10);
  if (!y || !mo || !d) return null;
  const mins = minutesOfDay == null ? 0 : minutesOfDay;
  const h = Math.floor(mins / 60);
  const mi = mins % 60;
  const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  const tz = String(timeZone || "America/New_York").trim() || "America/New_York";
  let asTz;
  try {
    asTz = zonedParts(utc, tz);
  } catch {
    return null;
  }
  const desiredDay = Date.UTC(y, mo - 1, d);
  const actualDay = Date.UTC(asTz.y, asTz.mo - 1, asTz.d);
  const diffMs = (desiredDay - actualDay) + ((h * 60 + mi) - (asTz.h * 60 + asTz.mi)) * 60000;
  return new Date(utc.getTime() + diffMs);
}

function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const map = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
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

/**
 * True when the visit starts sooner than the notice window.
 * A start exactly `noticeHours` away is allowed. Notice of 0 does not reject.
 */
export function bookingStartsTooSoon({ date, time, timeZone, noticeHours, now }) {
  const hours = normalizeMinNoticeHours(noticeHours);
  if (!(hours > 0)) return false;
  const startMins = typeof time === "number" ? time : parseClockMinutes(time);
  if (startMins == null) return false;
  const startUtc = wallTimeToUtc(date, startMins, timeZone || "America/New_York");
  if (!startUtc || Number.isNaN(startUtc.getTime())) return false;
  const moment = now instanceof Date ? now : new Date();
  return startUtc.getTime() < moment.getTime() + hours * 60 * 60 * 1000;
}

/** '' or 'too_soon'. Uses the business zone and stored notice (default 2 hours). */
export function bookingNoticeError(tenant, booking, now) {
  if (!booking) return "";
  const hours = normalizeMinNoticeHours(tenant && tenant.minNoticeHours);
  const tz = String((tenant && (tenant.timezone || tenant.timeZone)) || "America/New_York").trim() || "America/New_York";
  if (bookingStartsTooSoon({
    date: booking.date,
    time: booking.time,
    timeZone: tz,
    noticeHours: hours,
    now: now || new Date(),
  })) return "too_soon";
  return "";
}

function zoneName(timeZone, date, style) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: style,
  }).formatToParts(date);
  const part = parts.find((p) => p.type === "timeZoneName");
  return part ? part.value : "";
}

/** "Eastern Time (ET)" for America/New_York. Falls back to the IANA id. */
export function timeZoneLabel(timeZone, now) {
  const tz = String(timeZone || "America/New_York").trim() || "America/New_York";
  const date = now instanceof Date ? now : new Date();
  try {
    const longName = zoneName(tz, date, "longGeneric");
    const shortName = zoneName(tz, date, "shortGeneric");
    if (!longName) return tz;
    if (!shortName || shortName.toLowerCase() === longName.toLowerCase()) return longName;
    return longName + " (" + shortName + ")";
  } catch {
    return tz;
  }
}

/** "Times shown in Eastern Time (ET)." plus a browser-zone note when they differ. */
export function timesShownNote(businessTz, visitorTz, now) {
  const business = String(businessTz || "America/New_York").trim() || "America/New_York";
  let note = "Times shown in " + timeZoneLabel(business, now) + ".";
  const visitor = String(visitorTz || "").trim();
  if (visitor && visitor !== business) {
    note += " Your browser is in " + timeZoneLabel(visitor, now) + ".";
  }
  return note;
}
