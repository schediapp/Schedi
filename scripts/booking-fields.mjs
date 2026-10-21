// Fields site/booking.html reads off the tenant object. The booking lookup mask
// and the public-doc keep list are generated from this scan.
import { readFileSync, writeFileSync } from "node:fs";

const PRIVATE_OMIT = new Set([
  "ownerEmail",
  "ownerName",
  "ownerPhone",
]);

// Still fetched when an older public doc has them, so the worker can fold them
// into plan or acceptingBookings. They stay off new public writes.
const PRIVATE_PAGE_READS = new Set([
  "billingExempt",
  "complimentaryPro",
  "monthlyPrice",
]);

// Billing status. The mask still fetches it so an unmigrated public doc can set
// acceptingBookings. The keep list omits it so cleanup can delete it.
const BILLING_STATUS_FIELDS = new Set(["subscriptionStatus"]);

// Written in the browser after load. They are not public tenant fields.
const RUNTIME_ONLY = new Set([
  "publicSlots",
  "externalBusy",
]);

// Worker SEO and contact fields the booking script does not touch.
const WORKER_EXTRAS = [
  "seoPublic",
  "city",
  "businessCity",
  "state",
  "businessState",
  "hours",
  "phone",
  "businessPhone",
  "description",
];

export function tenantFieldsReadByBookingPage(source) {
  const html = String(source || "");
  const fields = new Set();
  const re = /\btenant(?:Data)?\s*\.\s*([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = re.exec(html))) fields.add(match[1]);
  for (const skip of RUNTIME_ONLY) fields.delete(skip);
  return [...fields].sort();
}

export function bookingMaskFields(source) {
  const fields = new Set(tenantFieldsReadByBookingPage(source).filter((field) => !PRIVATE_OMIT.has(field)));
  for (const extra of WORKER_EXTRAS) fields.add(extra);
  return [...fields].sort();
}

export function bookingKeepFields(source) {
  return bookingMaskFields(source).filter((field) => !PRIVATE_PAGE_READS.has(field) && !BILLING_STATUS_FIELDS.has(field));
}

export function bookingFieldModule(source) {
  const mask = bookingMaskFields(source);
  const keep = bookingKeepFields(source);
  return [
    "// Generated from site/booking.html by scripts/booking-fields.mjs. Do not edit.",
    "export const BOOKING_MASK_FIELDS = Object.freeze(" + JSON.stringify(mask, null, 2) + ");",
    "export const BOOKING_PAGE_KEEP_FIELDS = Object.freeze(" + JSON.stringify(keep, null, 2) + ");",
    "",
  ].join("\n");
}

export function writeBookingFieldModule(source) {
  const body = bookingFieldModule(source);
  writeFileSync(new URL("../worker/booking-page-keep.js", import.meta.url), body);
  return body;
}

const isMain = process.argv[1] && process.argv[1].endsWith("booking-fields.mjs");
if (isMain) {
  const html = readFileSync(new URL("../site/booking.html", import.meta.url), "utf8");
  writeBookingFieldModule(html);
  console.log("wrote worker/booking-page-keep.js", bookingMaskFields(html).length, "mask fields");
}

export { PRIVATE_OMIT, PRIVATE_PAGE_READS, BILLING_STATUS_FIELDS, RUNTIME_ONLY, WORKER_EXTRAS };
