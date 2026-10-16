import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workers/schedi-email-worker/src/firebase-admin.js", () => ({
  adminAccessToken: vi.fn(async () => "access"),
  adminAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer access", "Content-Type": "application/json" })),
}));

import { handleBookingMailPost } from "../workers/schedi-email-worker/src/booking-mail.js";
import {
  handlePrivateBookingHttp,
  loadPrivateRoster,
  savePrivateAppointments,
} from "../workers/schedi-email-worker/src/private-bookings.js";
import {
  buildSeriesConfirmedEmail,
  deliverSeriesConfirmations,
  seriesComingUpLine,
  SERIES_FOLLOWING_CAP,
} from "../workers/schedi-email-worker/src/series-mail.js";

const TENANT = "harbor";
const CLIENT = "schedi-qa@agentmail.to";
const TOKEN = "a".repeat(32);

function kv(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  };
}

function envWith(store = kv()) {
  return {
    FIREBASE_API_KEY: "test-key",
    FIREBASE_PROJECT_ID: "siteforge-97699",
    FIREBASE_APP_ID: "siteforge-97699",
    AUTH_KV: store,
    RL_BOOKING_CREATE: null,
    RL_MAIL: null,
    RL_MAIL_TENANT: null,
  };
}

function tenantProfile(appointments: unknown[] = []) {
  return {
    id: TENANT,
    name: "Harbor Studio",
    slug: "harbor",
    plan: "pro",
    timezone: "America/New_York",
    ownerName: "Avery Cole",
    ownerEmail: "avery@harbor.studio",
    ownerPhone: "(555) 010-1944",
    notifications: {
      emailConfirmations: true,
      replyTo: "avery@harbor.studio",
      extraNote: "Street parking is on Harbor Lane.",
    },
    cancellationFee: { enabled: true, hours: 24, type: "fixed", amount: 15 },
    services: [],
    appointments,
  };
}

function recurrence(dates: string[], index: number) {
  return {
    frequency: "weekly",
    count: dates.length,
    index,
    total: dates.length,
    dates: dates.slice(),
    times: dates.map(() => "10:00 AM"),
  };
}

function visit(id: string, date: string, dates: string[], index: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenantId: TENANT,
    manageToken: TOKEN,
    clientName: "Maya Chen",
    clientEmail: CLIENT,
    clientPhone: "(555) 201-0142",
    serviceName: "Color",
    date,
    time: "10:00 AM",
    status: "pending",
    durationMins: 90,
    amount: 80,
    paymentMethod: "cashapp",
    paymentOptionLabel: "Cash App",
    paymentStatus: "PENDING CASH APP",
    depositAmount: 25,
    depositPaid: false,
    balanceDue: 55,
    seriesId: "SER-HARBOR",
    recurrence: recurrence(dates, index),
    ...extra,
  };
}

function weeklyDates(start: string, count: number) {
  const out: string[] = [];
  const [y, m, d] = start.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  for (let i = 0; i < count; i++) {
    const next = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + i * 7);
    const iso = next.getFullYear() + "-" + String(next.getMonth() + 1).padStart(2, "0") + "-" + String(next.getDate()).padStart(2, "0");
    out.push(iso);
  }
  return out;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let restoreFetch: typeof fetch;
let sent: Array<Record<string, unknown>>;

function sendResend(_env: unknown, payload: Record<string, unknown>) {
  if (payload.to !== CLIENT) {
    throw new Error("refusing to address " + String(payload.to));
  }
  sent.push(payload);
  return Promise.resolve({ ok: true, id: "email_test_" + sent.length });
}

beforeEach(() => {
  sent = [];
  restoreFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("api.resend.com")) throw new Error("live email send");
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

describe("series email copy", () => {
  const dates = weeklyDates("2026-11-02", 3);
  const bookings = dates.map((date, i) => visit("BK-S000000" + (i + 1), date, dates, i + 1));

  it("uses the confirmation card and names the series once", () => {
    const mail = buildSeriesConfirmedEmail(tenantProfile(), bookings);
    expect(mail).toBeTruthy();
    expect(mail!.to).toBe(CLIENT);
    expect(mail!.subject).toBe("Your visits are booked \u2014 Harbor Studio");
    expect(mail!.html).toContain("email-calendar-check.png");
    expect(mail!.html).toContain("background-color:#059669");
    expect(mail!.html).toContain("Harbor Studio");
    expect(mail!.html).toContain("Color");
    expect(mail!.html).toContain("Weekly");
    expect(mail!.html).toContain("Mon, Nov 2, 2026");
    expect(mail!.html).toContain("10:00 AM");
    expect(mail!.html).toContain("Eastern Time");
    expect(mail!.html).toContain("A deposit of $25.00 is due.");
    expect(mail!.html).toContain("$55.00 is due at the visit.");
    expect(mail!.html).toContain("Cash App");
    expect(mail!.html).toContain("Street parking is on Harbor Lane.");
    expect(mail!.html).toContain("https://schedi.app/harbor/manage/" + TOKEN);
    expect(mail!.html).toContain("Manage / reschedule / cancel");
    expect(mail!.html).toContain("mailto:avery@harbor.studio");
    expect(mail!.html).toContain("ends Mon, Nov 16, 2026 at 10:00 AM");
    expect(mail!.html).not.toContain("and ");
    expect(mail!.text + mail!.html).not.toMatch(/\bPro\b|\bStarter\b|plan tier/i);
    expect(seriesComingUpLine(bookings)).toContain("ends ");
    expect(SERIES_FOLLOWING_CAP).toBe(6);
  });

  it("lists six later dates and then and N more", () => {
    const many = weeklyDates("2026-11-02", 12);
    const rows = many.map((date, i) => visit("BK-L" + String(i).padStart(7, "0"), date, many, i + 1));
    const line = seriesComingUpLine(rows);
    expect(line).toContain("and 5 more");
    expect(line).not.toContain("ends ");
    expect(line).not.toContain("Jan 18, 2027");
    const mail = buildSeriesConfirmedEmail(tenantProfile(), rows);
    expect(mail!.html).toContain("and 5 more");
    expect(mail!.text).toContain("Coming up:");
  });

  it("returns nothing for a one-time visit", () => {
    expect(buildSeriesConfirmedEmail(tenantProfile(), [{
      ...bookings[0],
      seriesId: "",
      recurrence: { frequency: "once", count: 1, index: 1, total: 1, dates: [dates[0]] },
    }])).toBeNull();
  });
});

describe("deliverSeriesConfirmations", () => {
  it("sends one email and skips a second attempt, a missing address, and a turned-off switch", async () => {
    const env = envWith();
    const dates = weeklyDates("2026-11-02", 4);
    const bookings = dates.map((date, i) => visit("BK-D000000" + (i + 1), date, dates, i + 1));
    const tenant = tenantProfile();
    const first = await deliverSeriesConfirmations(env, tenant, bookings, { sendResend });
    const second = await deliverSeriesConfirmations(env, tenant, bookings, { sendResend });
    expect(first).toMatchObject({ ok: true, sent: 1, series: true });
    expect(second).toMatchObject({ ok: true, skipped: true, reason: "already_sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(CLIENT);

    const quiet = bookings.map((b) => ({ ...b, clientEmail: "", seriesId: "SER-NOMAIL" }));
    const skipped = await deliverSeriesConfirmations(env, tenant, quiet, { sendResend });
    expect(skipped).toMatchObject({ ok: true, skipped: true, reason: "no_email" });

    const off = { ...tenant, notifications: { ...tenant.notifications, emailConfirmations: false } };
    const disabled = await deliverSeriesConfirmations(env, off, bookings.map((b) => ({ ...b, seriesId: "SER-OFF" })), { sendResend });
    expect(disabled).toMatchObject({ ok: true, skipped: true, reason: "disabled" });
    expect(sent).toHaveLength(1);
    expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringContaining("api.resend.com"), expect.anything());
  });
});

function bookingDeps(env: ReturnType<typeof envWith>, extra: Record<string, unknown> = {}) {
  const notifyOwnerOfNewBookings = vi.fn(async () => {});
  return {
    notifyOwnerOfNewBookings,
    deps: {
      json,
      isAllowedOrigin: () => true,
      getTenantById: vi.fn(async () => tenantProfile((await loadPrivateRoster(env, TENANT)).appointments)),
      listAllTenants: vi.fn(async () => []),
      notifyOwnerOfNewBookings,
      notifyOwnerOfCancellations: vi.fn(async () => {}),
      sendSeriesConfirmed: (e: unknown, tenant: unknown, bookings: unknown) => deliverSeriesConfirmations(e, tenant, bookings, { sendResend }),
      ...extra,
    },
  };
}

function post(body: unknown, path = "/api/bookings") {
  return new Request("https://schedi.app" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://schedi.app", "CF-Connecting-IP": "203.0.113." + Math.floor(Math.random() * 200 + 10) },
    body: JSON.stringify(body),
  });
}

describe("series create", () => {
  it("emails the client once after a public series is saved and still notifies the owner for every visit", async () => {
    const env = envWith();
    const dates = weeklyDates("2026-11-02", 3);
    const { deps, notifyOwnerOfNewBookings } = bookingDeps(env);
    const res = await handlePrivateBookingHttp(post({
      action: "create",
      tenantId: TENANT,
      bookings: dates.map((date, i) => visit("BK-C000000" + (i + 1), date, dates, i + 1)),
    }), env, "https://schedi.app", "/api/bookings", deps, {});
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("Your visits are booked");
    expect(notifyOwnerOfNewBookings).toHaveBeenCalledTimes(1);
    expect(notifyOwnerOfNewBookings.mock.calls[0][2]).toHaveLength(3);
  });

  it("does not email when the series is rejected", async () => {
    const env = envWith();
    const dates = weeklyDates("2026-11-02", 3);
    const { deps, notifyOwnerOfNewBookings } = bookingDeps(env, {
      getTenantById: vi.fn(async () => tenantProfile([{
        id: "BK-TAKEN0001",
        date: dates[0],
        time: "10:00 AM",
        durationMins: 60,
        status: "accepted",
      }])),
    });
    const res = await handlePrivateBookingHttp(post({
      action: "create",
      tenantId: TENANT,
      bookings: dates.map((date, i) => visit("BK-X000000" + (i + 1), date, dates, i + 1)),
    }), env, "https://schedi.app", "/api/bookings", deps, {});
    expect(res.status).toBe(409);
    expect(sent).toHaveLength(0);
    expect(notifyOwnerOfNewBookings).not.toHaveBeenCalled();
  });

  it("emails once when the owner saves a new series, and not when that series is saved again", async () => {
    const env = envWith();
    env.AUTH_KV.store.set("session:owner-token", JSON.stringify({ role: "owner", tenantId: TENANT, exp: Date.now() + 3600000 }));
    const dates = weeklyDates("2026-12-07", 3);
    const bookings = dates.map((date, i) => visit("BK-O000000" + (i + 1), date, dates, i + 1, { seriesId: "SER-OWNER" }));
    const { deps } = bookingDeps(env);
    const first = await handlePrivateBookingHttp(post({
      action: "sync",
      session: "owner-token",
      tenantId: TENANT,
      rosterRevision: 0,
      appointments: bookings,
    }), env, "https://schedi.app", "/api/bookings", deps, {});
    expect((await first.json()).ok).toBe(true);
    expect(sent).toHaveLength(1);
    const again = await handlePrivateBookingHttp(post({
      action: "sync",
      session: "owner-token",
      tenantId: TENANT,
      rosterRevision: 1,
      appointments: bookings,
    }), env, "https://schedi.app", "/api/bookings", deps, {});
    expect((await again.json()).ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("skips the series email when the owner saves a client with no email", async () => {
    const env = envWith();
    env.AUTH_KV.store.set("session:owner-token", JSON.stringify({ role: "owner", tenantId: TENANT, exp: Date.now() + 3600000 }));
    const dates = weeklyDates("2026-12-14", 2);
    const bookings = dates.map((date, i) => visit("BK-N000000" + (i + 1), date, dates, i + 1, {
      seriesId: "SER-NONE",
      clientEmail: "",
    }));
    const { deps } = bookingDeps(env);
    const res = await handlePrivateBookingHttp(post({
      action: "sync",
      session: "owner-token",
      tenantId: TENANT,
      rosterRevision: 0,
      appointments: bookings,
    }), env, "https://schedi.app", "/api/bookings", deps, {});
    expect((await res.json()).ok).toBe(true);
    expect(sent).toHaveLength(0);
  });
});

describe("per-visit confirmation is replaced", () => {
  it("sends the series email instead of the per-visit confirmation, once for the whole series", async () => {
    const env = envWith();
    const dates = weeklyDates("2026-11-02", 3);
    const bookings = dates.map((date, i) => visit("BK-M000000" + (i + 1), date, dates, i + 1));
    await savePrivateAppointments(env, TENANT, bookings, 0);
    const deps = {
      json,
      isAllowedOrigin: () => true,
      getTenantById: vi.fn(async () => tenantProfile(bookings)),
      firebaseAnonymousToken: vi.fn(async () => "tok"),
      sendResend,
      sendBookingConfirmationSms: vi.fn(async () => ({ ok: true })),
      ownerNotifyEnabledForTenant: () => false,
      escapeHtml: (s: string) => s,
      safeTenantId: (v: string) => (/^[A-Za-z0-9_-]{1,80}$/.test(String(v || "")) ? String(v) : ""),
      sleep: () => Promise.resolve(),
    };
    for (const booking of bookings) {
      const res = await handleBookingMailPost(post({
        type: "booking_confirmation",
        tenantId: TENANT,
        bookingId: booking.id,
        manageToken: TOKEN,
        subject: "You're booked! \u2014 Harbor Studio",
        html: "<p>PER_VISIT_SHOULD_NOT_SEND</p>",
        text: "PER_VISIT_SHOULD_NOT_SEND",
      }, "/api/send-booking-email"), env, "https://schedi.app", deps);
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);
    }
    expect(sent).toHaveLength(1);
    expect(String(sent[0].html)).not.toContain("PER_VISIT_SHOULD_NOT_SEND");
    expect(String(sent[0].html)).toContain("Your visits are booked");
    expect(String(sent[0].subject)).toContain("Your visits are booked");
  });
});
