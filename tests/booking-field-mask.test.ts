import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bookingMaskFields, tenantFieldsReadByBookingPage } from "../scripts/booking-fields.mjs";
import { BOOKING_FIELD_MASK } from "../worker/handler";
import { BOOKING_MASK_FIELDS, BOOKING_PAGE_KEEP_FIELDS } from "../worker/booking-page-keep.js";
import { publicFieldsToTrim, shapePublicBookingFields } from "../workers/schedi-email-worker/src/tenant-private.js";

const bookingHtml = readFileSync(new URL("../site/booking.html", import.meta.url), "utf8");

const REQUIRED = [
  "blockedTimes",
  "blockedRules",
  "specialHours",
  "minNoticeHours",
  "slotInterval",
  "appointmentBufferMins",
  "allowRecurringBookings",
  "coverUrl",
  "logoTone",
  "logoBackdrop",
  "logoClear",
  "logoToneFor",
  "venmoHandle",
  "venmoLink",
  "zelleHandle",
  "zelleLink",
  "paypalHandle",
  "paypalLink",
];

describe("booking field mask", () => {
  it("includes every tenant field booking.html reads", () => {
    const read = tenantFieldsReadByBookingPage(bookingHtml);
    const mask = new Set(BOOKING_MASK_FIELDS);
    for (const field of REQUIRED) {
      expect(read, field).toContain(field);
      expect(mask.has(field), field).toBe(true);
    }
    const missing = bookingMaskFields(bookingHtml).filter((field) => !mask.has(field));
    expect(missing, "run node scripts/booking-fields.mjs").toEqual([]);
    for (const field of BOOKING_MASK_FIELDS) {
      expect(BOOKING_FIELD_MASK).toContain("mask.fieldPaths=" + encodeURIComponent(field));
    }
    expect(BOOKING_FIELD_MASK).not.toContain("ownerEmail");
  });

  it("keeps schedule fields on public writes and out of the trim list", () => {
    const shaped = shapePublicBookingFields({
      id: "axeldelcidphotography",
      name: "Axel",
      plan: "pro",
      subscriptionStatus: "active",
      blockedTimes: [{ startDate: "2026-10-25", endDate: "2026-10-25", allDay: true, note: "Studio closed" }],
      specialHours: { "2027-09-24": { closed: false, ranges: [{ start: "09:00 AM", end: "05:00 PM" }] } },
      blockedRules: [{ title: "Lunch", time: "12:00 PM", duration: "1 hour" }],
      venmoHandle: "axel",
      zelleHandle: "axel@example.com",
      paypalHandle: "axel",
      coverUrl: "https://schedi.app/cover.jpg",
      logoTone: "dark",
      ownerEmail: "hidden@example.com",
      complimentaryPro: true,
    });
    expect(shaped.pub.blockedTimes).toEqual([
      { startDate: "2026-10-25", endDate: "2026-10-25", allDay: true, note: "Studio closed" },
    ]);
    expect(shaped.pub.specialHours).toEqual({
      "2027-09-24": { closed: false, ranges: [{ start: "09:00 AM", end: "05:00 PM" }] },
    });
    expect(shaped.pub.venmoHandle).toBe("axel");
    expect(shaped.pub.ownerEmail).toBeUndefined();
    expect(shaped.pub.complimentaryPro).toBeUndefined();

    const remove = publicFieldsToTrim({
      name: "Axel",
      blockedTimes: [],
      specialHours: {},
      blockedRules: [],
      slotInterval: 30,
      minNoticeHours: 2,
      coverUrl: "https://schedi.app/cover.jpg",
      logoTone: "dark",
      logoBackdrop: "light",
      logoClear: true,
      logoToneFor: "https://schedi.app/logo.png",
      venmoHandle: "axel",
      venmoLink: "https://venmo.com/axel",
      zelleHandle: "axel@example.com",
      zelleLink: "",
      paypalHandle: "axel",
      paypalLink: "",
      subscriptionStatus: "active",
      ownerEmail: "hidden@example.com",
      complimentaryPro: true,
      squareMerchantId: "merchant",
      showPublicAddress: false,
      address: "10 Main St",
    });
    for (const field of BOOKING_PAGE_KEEP_FIELDS) {
      if (field === "address" || field === "location" || field === "businessAddress" || field === "businessLocation" || field === "city" || field === "businessCity" || field === "state" || field === "businessState") continue;
      expect(remove, field).not.toContain(field);
    }
    expect(remove).toContain("ownerEmail");
    expect(remove).toContain("complimentaryPro");
    expect(remove).toContain("squareMerchantId");
    expect(remove).toContain("address");
    expect(remove).not.toContain("blockedTimes");
    expect(remove).not.toContain("specialHours");
  });
});
