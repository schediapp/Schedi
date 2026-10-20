import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workers/schedi-email-worker/src/firebase-admin.js", () => ({
  adminAccessToken: vi.fn(async () => "access"),
  adminAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer access", "Content-Type": "application/json" })),
}));

import { normalizeMinNoticeHours } from "../workers/schedi-email-worker/src/booking-notice.js";
import { handlePrivateBookingHttp, loadPrivateRoster } from "../workers/schedi-email-worker/src/private-bookings.js";
import { sanitizeProfile } from "../workers/schedi-email-worker/src/profile-store.js";
import {
  blockedRuleMatchesDay,
  bookingAvailabilityError,
  resolveHoursForDate,
  slotAvailabilityProblem,
} from "../workers/schedi-email-worker/src/slot-availability.js";
import { splitTenant } from "../workers/schedi-email-worker/src/tenant-private.js";

const TENANT = "acme";

const WEEKDAY = { open: true, start: "09:00 AM", end: "05:00 PM" };
const CLOSED = { open: false, start: "09:00 AM", end: "05:00 PM" };
const WEEK = { Sun: CLOSED, Mon: WEEKDAY, Tue: WEEKDAY, Wed: WEEKDAY, Thu: WEEKDAY, Fri: WEEKDAY, Sat: CLOSED };

function kv(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function envWith(store = kv()) {
  return {
    FIREBASE_API_KEY: "test-key",
    FIREBASE_PROJECT_ID: "siteforge-97699",
    FIREBASE_APP_ID: "siteforge-97699",
    AUTH_KV: store,
    RL_BOOKING_CREATE: null,
  };
}

let restoreFetch: typeof fetch;

beforeEach(() => {
  restoreFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("identitytoolkit.googleapis.com")) {
      return new Response(JSON.stringify({ idToken: "tok" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = restoreFetch;
  vi.clearAllMocks();
});

function tenant(extra: Record<string, unknown> = {}) {
  return {
    id: TENANT,
    name: "Acme",
    plan: "pro",
    timezone: "America/New_York",
    operatingHours: WEEK,
    services: [],
    appointments: [] as unknown[],
    ...extra,
  };
}

function deps(business: Record<string, unknown>) {
  return {
    json,
    isAllowedOrigin: () => true,
    getTenantById: vi.fn(async (env: { AUTH_KV: ReturnType<typeof kv> }, _token: string, tenantId: string) => ({
      ...business,
      id: tenantId,
      appointments: (await loadPrivateRoster(env, tenantId)).appointments,
    })),
    listAllTenants: vi.fn(async () => []),
    notifyOwnerOfNewBookings: vi.fn(async () => {}),
    notifyOwnerOfCancellations: vi.fn(async () => {}),
  };
}

function post(body: unknown, ip = "203.0.113.80") {
  return new Request("https://schedi.app/api/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://schedi.app", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}

async function create(env: ReturnType<typeof envWith>, business: Record<string, unknown>, booking: Record<string, unknown>, ip?: string) {
  const res = await handlePrivateBookingHttp(
    post({ action: "create", tenantId: TENANT, bookings: [booking] }, ip),
    env,
    "https://schedi.app",
    "/api/bookings",
    deps(business),
    {},
  );
  return { status: res.status, data: await res.json() };
}

function visit(extra: Record<string, unknown> = {}) {
  return {
    clientName: "Ada Lovelace",
    clientEmail: "ada@example.com",
    clientPhone: "555-0100",
    serviceName: "Cut",
    date: "2026-10-21",
    time: "10:00 AM",
    durationMins: 60,
    paymentMethod: "later",
    ...extra,
  };
}

function putSession(env: ReturnType<typeof envWith>, token: string, role: "owner" | "agency", tenantId = TENANT) {
  const payload = role === "agency"
    ? { role, exp: Date.now() + 3_600_000 }
    : { role, tenantId, exp: Date.now() + 3_600_000 };
  env.AUTH_KV.store.set("session:" + token, JSON.stringify(payload));
}

describe("resolveHoursForDate", () => {
  it("uses weekly hours, then a special-hours override for that date", () => {
    expect(resolveHoursForDate({ operatingHours: WEEK }, "2026-10-21")).toMatchObject({
      closed: false,
      special: false,
      dayAbbr: "Wed",
      ranges: [{ startMins: 9 * 60, endMins: 17 * 60 }],
    });
    expect(resolveHoursForDate({ operatingHours: WEEK }, "2026-10-25")).toMatchObject({
      closed: true,
      special: false,
      dayAbbr: "Sun",
    });
    expect(resolveHoursForDate({
      operatingHours: WEEK,
      specialHours: { "2026-10-21": { closed: true } },
    }, "2026-10-21")).toMatchObject({ closed: true, special: true, dayAbbr: "Wed" });
    expect(resolveHoursForDate({
      operatingHours: WEEK,
      specialHours: { "2026-10-25": { ranges: [{ start: "11:00 AM", end: "02:00 PM" }] } },
    }, "2026-10-25")).toMatchObject({
      closed: false,
      special: true,
      dayAbbr: "Sun",
      ranges: [{ startMins: 11 * 60, endMins: 14 * 60 }],
    });
    expect(resolveHoursForDate({ operatingHours: WEEK }, "2026-02-31").closed).toBe(true);
  });

  it("keeps the weekday of the calendar date, not the worker clock", () => {
    expect(resolveHoursForDate({ operatingHours: WEEK }, "2026-10-20").dayAbbr).toBe("Tue");
    expect(blockedRuleMatchesDay({ frequency: "Weekly (Fridays)" }, "Fri")).toBe(true);
    expect(blockedRuleMatchesDay({ frequency: "Weekly (Mondays)" }, "Fri")).toBe(false);
    expect(blockedRuleMatchesDay({ frequency: "Daily" }, "Sun")).toBe(true);
    expect(blockedRuleMatchesDay({ frequency: "Monthly" }, "Wed")).toBe(true);
  });
});

describe("slotAvailabilityProblem", () => {
  const shop = tenant();

  it("rejects a visit that does not fit inside open hours", () => {
    expect(slotAvailabilityProblem(shop, { date: "2026-10-21", time: "08:00 AM", durationMins: 60 })).toBe("outside");
    expect(slotAvailabilityProblem(shop, { date: "2026-10-21", time: "04:30 PM", durationMins: 60 })).toBe("outside");
    expect(slotAvailabilityProblem(shop, { date: "2026-10-21", time: "04:00 PM", durationMins: 60 })).toBe("");
    expect(slotAvailabilityProblem(shop, { date: "2026-10-25", time: "11:00 AM", durationMins: 60 })).toBe("closed");
    expect(bookingAvailabilityError(shop, { date: "2026-10-25", time: "11:00 AM", durationMins: 60 })).toBe("slot_unavailable");
  });

  it("lets a special-hours window replace the weekly schedule", () => {
    const early = tenant({ specialHours: { "2026-10-21": { ranges: [{ start: "07:00 AM", end: "09:00 AM" }] } } });
    expect(slotAvailabilityProblem(early, { date: "2026-10-21", time: "07:00 AM", durationMins: 60 })).toBe("");
    expect(slotAvailabilityProblem(early, { date: "2026-10-21", time: "10:00 AM", durationMins: 60 })).toBe("outside");
    const shut = tenant({ specialHours: { "2026-10-21": { closed: true, ranges: [] } } });
    expect(slotAvailabilityProblem(shut, { date: "2026-10-21", time: "10:00 AM", durationMins: 60 })).toBe("closed");
  });

  it("rejects blocked times and only the weekdays a recurring rule names", () => {
    const blocked = tenant({
      blockedTimes: [
        { id: "vac", note: "Vacation", startDate: "2026-10-22", endDate: "2026-10-22", allDay: true },
        { id: "lunch", startDate: "2026-10-21", endDate: "2026-10-21", allDay: false, startTime: "12:00 PM", endTime: "01:00 PM" },
      ],
      blockedRules: [
        { id: "fri", title: "Team meeting", time: "04:00 PM", duration: "1 hour", frequency: "Weekly (Fridays)" },
        { id: "daily", title: "Lunch", time: "12:00 PM", duration: "30 min", frequency: "Daily" },
      ],
    });
    expect(slotAvailabilityProblem(blocked, { date: "2026-10-22", time: "10:00 AM", durationMins: 60 })).toBe("blocked");
    expect(slotAvailabilityProblem(blocked, { date: "2026-10-21", time: "12:30 PM", durationMins: 60 })).toBe("blocked");
    expect(slotAvailabilityProblem(blocked, { date: "2026-10-21", time: "01:00 PM", durationMins: 60 })).toBe("");
    expect(slotAvailabilityProblem(blocked, { date: "2026-10-23", time: "03:30 PM", durationMins: 60 })).toBe("blocked");
    expect(slotAvailabilityProblem(blocked, { date: "2026-10-21", time: "03:30 PM", durationMins: 60 })).toBe("");
    expect(slotAvailabilityProblem(blocked, { date: "2026-10-21", time: "11:30 AM", durationMins: 60 })).toBe("blocked");
    expect(slotAvailabilityProblem(blocked, { date: "2026-10-21", time: "11:00 AM", durationMins: 60 })).toBe("");
  });
});

describe("public booking create", () => {
  it("returns 409 slot_unavailable outside hours and still accepts a fitting slot", async () => {
    const env = envWith();
    const closed = await create(env, tenant(), visit({ date: "2026-10-25", time: "11:00 AM" }), "203.0.113.81");
    expect(closed.status).toBe(409);
    expect(closed.data).toMatchObject({
      ok: false,
      error: "slot_unavailable",
      message: "That time is not available. Choose another time.",
    });
    expect((await loadPrivateRoster(env, TENANT)).appointments).toHaveLength(0);

    const open = await create(env, tenant(), visit(), "203.0.113.82");
    expect(open.status).toBe(200);
    expect(open.data.ok).toBe(true);
  });

  it("returns 409 too_soon from the business zone and lets the boundary through", async () => {
    const env = envWith();
    const soon = await create(env, tenant({ minNoticeHours: 48 }), visit({ date: "2020-01-15", time: "10:00 AM" }), "203.0.113.83");
    expect(soon.status).toBe(409);
    expect(soon.data).toMatchObject({
      ok: false,
      error: "too_soon",
      message: "That time is too soon. Choose a later time.",
    });

    const later = await create(env, tenant({ timezone: "America/Los_Angeles", minNoticeHours: 2 }), visit({ date: "2027-06-16", time: "10:00 AM" }), "203.0.113.84");
    expect(later.status).toBe(200);
    expect(normalizeMinNoticeHours("nope")).toBe(0);
  });

  it("rejects a slot that overlaps a cached external calendar block", async () => {
    const env = envWith();
    env.AUTH_KV.store.set("calFeeds:" + TENANT, JSON.stringify({
      tenantId: TENANT,
      timeZone: "America/New_York",
      feeds: [{ id: "feed1", url: "https://calendar.example/busy.ics" }],
    }));
    env.AUTH_KV.store.set("calBusy:" + TENANT, JSON.stringify({
      syncedAt: Date.now(),
      blocks: [{ start: "2026-10-21T14:00:00.000Z", end: "2026-10-21T15:00:00.000Z" }],
    }));
    const busy = await create(env, tenant(), visit({ time: "10:30 AM" }), "203.0.113.85");
    expect(busy.status).toBe(409);
    expect(busy.data.error).toBe("slot_taken");
    const clear = await create(env, tenant(), visit({ time: "03:00 PM" }), "203.0.113.86");
    expect(clear.status).toBe(200);
  });

  it("lets an owner or agency book outside hours, and a roster sync still can", async () => {
    const env = envWith();
    putSession(env, "owner-token", "owner");
    putSession(env, "agency-token", "agency");
    const early = visit({ date: "2026-10-25", time: "07:00 AM", clientEmail: "owner-booked@example.com" });

    const owner = await handlePrivateBookingHttp(
      post({ action: "create", session: "owner-token", tenantId: TENANT, bookings: [early] }, "203.0.113.87"),
      env,
      "https://schedi.app",
      "/api/bookings",
      deps(tenant({ minNoticeHours: 48 })),
      {},
    );
    expect(owner.status).toBe(200);

    const manual = visit({
      id: "MN-SUNDAY01",
      date: "2026-10-25",
      time: "06:30 AM",
      clientEmail: "walkin@example.com",
      manageToken: "managetokenvalue01",
    });
    const synced = await handlePrivateBookingHttp(
      post({
        action: "sync",
        session: "agency-token",
        tenantId: TENANT,
        appointments: [manual],
      }, "203.0.113.88"),
      env,
      "https://schedi.app",
      "/api/bookings",
      deps(tenant()),
      {},
    );
    const syncedBody = await synced.json();
    expect(synced.status).toBe(200);
    expect(syncedBody.ok).toBe(true);
    const roster = await loadPrivateRoster(env, TENANT);
    expect(roster.appointments.some((row: { time?: string }) => row.time === "06:30 AM")).toBe(true);
  });

  it("rejects a customer reschedule into a closed day", async () => {
    const env = envWith();
    const made = await create(env, tenant(), visit(), "203.0.113.89");
    expect(made.status).toBe(200);
    const saved = made.data.bookings[0];
    const res = await handlePrivateBookingHttp(
      post({
        action: "client",
        slug: TENANT,
        token: saved.manageToken,
        date: "2026-10-25",
        time: "11:00 AM",
      }, "203.0.113.90"),
      env,
      "https://schedi.app",
      "/api/bookings",
      deps(tenant()),
      {},
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toBe("slot_unavailable");
    const roster = await loadPrivateRoster(env, TENANT);
    expect(roster.appointments.find((row: { id: string }) => row.id === saved.id)?.date).toBe("2026-10-21");
  });
});

describe("public tenant doc", () => {
  it("publishes minNoticeHours and drops an unknown value to none", () => {
    const saved = sanitizeProfile({
      name: "Harbor",
      minNoticeHours: "12",
      ownerEmail: "owner@example.com",
    }, "harbor");
    expect(saved && saved.minNoticeHours).toBe(12);
    const split = splitTenant(saved);
    expect(split.pub.minNoticeHours).toBe(12);
    expect(split.priv.ownerEmail).toBe("owner@example.com");
    expect(split.pub.ownerEmail).toBeUndefined();
    const none = sanitizeProfile({ name: "Harbor", minNoticeHours: 3 }, "harbor");
    expect(none && none.minNoticeHours).toBe(0);
    const missing = sanitizeProfile({ name: "Harbor" }, "harbor");
    expect(missing && Object.prototype.hasOwnProperty.call(missing, "minNoticeHours")).toBe(false);
  });
});
