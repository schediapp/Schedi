import { describe, expect, it } from "vitest";
import {
  bookingNoticeError,
  bookingStartsTooSoon,
  normalizeMinNoticeHours,
  timeZoneLabel,
  timesShownNote,
  wallTimeToUtc,
} from "../workers/schedi-email-worker/src/booking-notice.js";

describe("minimum booking notice", () => {
  it("defaults unknown values to 2 hours and keeps the allowed set", () => {
    expect(normalizeMinNoticeHours(undefined)).toBe(2);
    expect(normalizeMinNoticeHours(null)).toBe(2);
    expect(normalizeMinNoticeHours(3)).toBe(2);
    expect(normalizeMinNoticeHours("nope")).toBe(2);
    expect(normalizeMinNoticeHours("none")).toBe(0);
    expect(normalizeMinNoticeHours(0)).toBe(0);
    expect(normalizeMinNoticeHours("2")).toBe(2);
    expect(normalizeMinNoticeHours(48)).toBe(48);
  });

  it("rejects a start inside the window and allows one exactly on the boundary", () => {
    const now = new Date("2026-01-15T13:00:00.000Z"); // 8:00 AM EST
    const tz = "America/New_York";
    expect(wallTimeToUtc("2026-01-15", 8 * 60, tz)?.toISOString()).toBe("2026-01-15T13:00:00.000Z");
    expect(bookingStartsTooSoon({
      date: "2026-01-15",
      time: "09:30 AM",
      timeZone: tz,
      noticeHours: 2,
      now,
    })).toBe(true);
    expect(bookingStartsTooSoon({
      date: "2026-01-15",
      time: "10:00 AM",
      timeZone: tz,
      noticeHours: 2,
      now,
    })).toBe(false);
    expect(bookingStartsTooSoon({
      date: "2026-01-15",
      time: "09:00 AM",
      timeZone: tz,
      noticeHours: 0,
      now,
    })).toBe(false);
  });

  it("uses the business zone and the stored notice, defaulting to 2 hours", () => {
    const now = new Date("2026-10-15T18:00:00.000Z"); // 2:00 PM EDT
    expect(bookingNoticeError({ timezone: "America/New_York" }, { date: "2026-10-15", time: "03:00 PM" }, now)).toBe("too_soon");
    expect(bookingNoticeError({ timezone: "America/New_York" }, { date: "2026-10-15", time: "04:00 PM" }, now)).toBe("");
    expect(bookingNoticeError({ timezone: "America/New_York", minNoticeHours: 0 }, { date: "2026-10-15", time: "02:30 PM" }, now)).toBe("");
    expect(bookingNoticeError({ timeZone: "America/Los_Angeles", minNoticeHours: 24 }, { date: "2026-10-16", time: "10:00 AM" }, now)).toBe("too_soon");
    expect(bookingNoticeError({ timeZone: "America/Los_Angeles", minNoticeHours: 24 }, { date: "2026-10-16", time: "11:00 AM" }, now)).toBe("");
  });
});

describe("time zone label", () => {
  it("names Eastern Time the way the booking page should", () => {
    const winter = new Date("2026-01-15T15:00:00.000Z");
    const summer = new Date("2026-07-15T16:00:00.000Z");
    expect(timeZoneLabel("America/New_York", winter)).toBe("Eastern Time (ET)");
    expect(timeZoneLabel("America/New_York", summer)).toBe("Eastern Time (ET)");
    expect(timesShownNote("America/New_York", "America/New_York", winter)).toBe("Times shown in Eastern Time (ET).");
    expect(timesShownNote("America/New_York", "America/Los_Angeles", winter)).toBe(
      "Times shown in Eastern Time (ET). Your browser is in Pacific Time (PT).",
    );
  });
});
