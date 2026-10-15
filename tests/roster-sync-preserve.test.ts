import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workers/schedi-email-worker/src/firebase-admin.js", () => ({
  adminAccessToken: vi.fn(async () => "access"),
  adminAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer access", "Content-Type": "application/json" })),
}));

// @ts-expect-error plain JS worker module
import {
  handlePrivateBookingHttp,
  hydrateTenantBookings,
  loadPrivateRoster,
  mergeRosterSync,
  persistTenantAppointments,
  savePrivateAppointments,
} from "../workers/schedi-email-worker/src/private-bookings.js";

const TENANT = "acme";
const OLD_ID = "BK-OLD00001";

function kv(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  };
}

function booking(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenantId: TENANT,
    manageToken: ("mt" + id + "xxxxxxxxxxxxxxxxxxxx").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24),
    clientName: "Client " + id,
    clientEmail: id.toLowerCase() + "@example.com",
    clientPhone: "555-0100",
    serviceName: "Haircut",
    date: "2026-10-20",
    time: id === OLD_ID ? "10:00 AM" : "4:00 PM",
    status: "pending",
    durationMins: 60,
    paymentMethod: "later",
    paymentStatus: "UNPAID",
    notes: "keep-" + id,
    createdAt: "2026-10-15T18:48:48.000Z",
    ...extra,
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

let armedSlotId = "";
let slotCancels: string[] = [];
let restoreFetch: typeof fetch;

beforeEach(() => {
  armedSlotId = "";
  slotCancels = [];
  restoreFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = (init && init.method) || "GET";
    if (u.includes("identitytoolkit.googleapis.com")) {
      return new Response(JSON.stringify({ idToken: "tok" }), { status: 200 });
    }
    if (method === "GET" && u.includes("/slots")) {
      const documents = armedSlotId
        ? [{ name: "projects/p/databases/(default)/documents/tenants/acme/slots/" + armedSlotId }]
        : [];
      return new Response(JSON.stringify({ documents }), { status: 200 });
    }
    if (u.includes("updateMask.fieldPaths=cancelled") && armedSlotId && u.includes(encodeURIComponent(armedSlotId))) {
      slotCancels.push(u);
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = restoreFetch;
  vi.clearAllMocks();
});

function deps(extra: Record<string, unknown> = {}) {
  return {
    json,
    isAllowedOrigin: () => true,
    getTenantById: vi.fn(async (env: { AUTH_KV: ReturnType<typeof kv> }, _token: string, tenantId: string) => ({
      id: tenantId,
      name: "Acme",
      plan: "pro",
      timezone: "America/New_York",
      services: [],
      appointments: (await loadPrivateRoster(env, tenantId)).appointments,
    })),
    listAllTenants: vi.fn(async () => []),
    notifyOwnerOfNewBookings: vi.fn(async () => {}),
    notifyOwnerOfCancellations: vi.fn(async () => {}),
    ...extra,
  };
}

function post(body: unknown, ip = "203.0.113.10") {
  return new Request("https://schedi.app/api/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://schedi.app", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}

async function call(env: ReturnType<typeof envWith>, body: unknown, ip?: string, extra?: Record<string, unknown>) {
  const res = await handlePrivateBookingHttp(post(body, ip), env, "https://schedi.app", "/api/bookings", deps(extra), {});
  const data = await res.json();
  return { status: res.status, data };
}

function putSession(env: ReturnType<typeof envWith>, token: string, role: "owner" | "agency", tenantId = TENANT) {
  const payload = role === "agency"
    ? { role, exp: Date.now() + 3_600_000 }
    : { role, tenantId, exp: Date.now() + 3_600_000 };
  env.AUTH_KV.store.set("session:" + token, JSON.stringify(payload));
}

async function roster(env: ReturnType<typeof envWith>, tenantId = TENANT) {
  return loadPrivateRoster(env, tenantId);
}

function sameBooking(actual: Record<string, unknown> | undefined, expected: Record<string, unknown>) {
  expect(actual).toBeTruthy();
  for (const key of ["id", "clientName", "clientEmail", "clientPhone", "manageToken", "status", "date", "time", "notes", "serviceName"]) {
    expect(actual?.[key]).toEqual(expected[key]);
  }
}

describe("mergeRosterSync", () => {
  it("keeps a server booking the client did not send and still applies a known edit", () => {
    const stored = [booking(OLD_ID), booking("BK-NEW00001", { clientName: "Real Customer", clientEmail: "real@example.com" })];
    const merged = mergeRosterSync(stored, [{ ...stored[0], status: "accepted" }]);
    expect(merged.find((b) => b.id === OLD_ID)?.status).toBe("accepted");
    expect(merged.find((b) => b.id === "BK-NEW00001")).toEqual(stored[1]);
  });

  it("does not drop an unknown booking when the client list is already at the cap", () => {
    const fresh = booking("BK-NEW00001", { clientName: "Real Customer" });
    const incoming = Array.from({ length: 800 }, (_, i) => ({ id: "BK-C" + String(i).padStart(5, "0"), clientName: "n" }));
    const merged = mergeRosterSync([fresh], incoming);
    expect(merged).toHaveLength(800);
    expect(merged.find((b) => b.id === "BK-NEW00001")).toEqual(fresh);
  });
});

describe("stale roster save", () => {
  async function seedOwnerAndOldBooking(env: ReturnType<typeof envWith>) {
    putSession(env, "owner-token", "owner");
    await savePrivateAppointments(env, TENANT, [booking(OLD_ID)], 0);
  }

  async function arrivePublicBooking(env: ReturnType<typeof envWith>, ip: string) {
    const created = await call(env, {
      action: "create",
      tenantId: TENANT,
      bookings: [{
        clientName: "Real Customer",
        clientEmail: "real.customer@example.com",
        clientPhone: "555-0199",
        serviceName: "Color",
        date: "2026-10-21",
        time: "4:30 PM",
        status: "pending",
        durationMins: 90,
        paymentMethod: "later",
        notes: "arrived-after-page-load",
      }],
    }, ip);
    expect(created.status).toBe(200);
    expect(created.data.ok).toBe(true);
    const fresh = created.data.bookings[0];
    const stored = await roster(env);
    const saved = stored.appointments.find((b: { id: string }) => b.id === fresh.id);
    expect(saved).toBeTruthy();
    return { fresh, saved, revision: stored.revision as number };
  }

  it("keeps a new public booking when a stale page saves the list it loaded", async () => {
    const env = envWith();
    await seedOwnerAndOldBooking(env);
    const { saved, fresh } = await arrivePublicBooking(env, "203.0.113.21");
    armedSlotId = fresh.id;

    const synced = await call(env, {
      action: "sync",
      session: "owner-token",
      tenantId: TENANT,
      appointments: [{ ...booking(OLD_ID), status: "accepted", clientName: "Owner Edited" }],
    });
    expect(synced.status).toBe(200);
    expect(synced.data.ok).toBe(true);

    const after = await roster(env);
    const kept = after.appointments.find((b: { id: string }) => b.id === fresh.id);
    sameBooking(kept, saved);
    expect(after.appointments.find((b: { id: string }) => b.id === OLD_ID)?.status).toBe("accepted");
    expect(after.appointments.find((b: { id: string }) => b.id === OLD_ID)?.clientName).toBe("Owner Edited");
    expect(slotCancels).toEqual([]);
  });

  it("keeps the new booking when the stale page sends an empty roster", async () => {
    const env = envWith();
    await seedOwnerAndOldBooking(env);
    const { saved, fresh } = await arrivePublicBooking(env, "203.0.113.22");
    const synced = await call(env, {
      action: "sync",
      session: "owner-token",
      tenantId: TENANT,
      appointments: [],
    });
    expect(synced.status).toBe(200);
    const after = await roster(env);
    sameBooking(after.appointments.find((b: { id: string }) => b.id === fresh.id), saved);
    expect(after.appointments.find((b: { id: string }) => b.id === OLD_ID)?.id).toBe(OLD_ID);
  });

  it("rejects a stale rosterRevision with 409 and does not write", async () => {
    const env = envWith();
    await seedOwnerAndOldBooking(env);
    const { saved, fresh, revision } = await arrivePublicBooking(env, "203.0.113.23");
    const before = env.AUTH_KV.store.get("privateAppts:" + TENANT);
    const synced = await call(env, {
      action: "sync",
      session: "owner-token",
      tenantId: TENANT,
      rosterRevision: revision - 1,
      appointments: [{ ...booking(OLD_ID), status: "denied", clientName: "Should Not Stick" }],
    });
    expect(synced.status).toBe(409);
    expect(synced.data).toMatchObject({ ok: false, error: "stale_roster", rosterRevision: revision });
    expect(env.AUTH_KV.store.get("privateAppts:" + TENANT)).toBe(before);
    const after = await roster(env);
    sameBooking(after.appointments.find((b: { id: string }) => b.id === fresh.id), saved);
    expect(after.appointments.find((b: { id: string }) => b.id === OLD_ID)?.clientName).toBe("Client " + OLD_ID);
  });

  it("still keeps an omitted booking when the client sends the current revision", async () => {
    const env = envWith();
    await seedOwnerAndOldBooking(env);
    const { saved, fresh, revision } = await arrivePublicBooking(env, "203.0.113.24");
    const synced = await call(env, {
      action: "sync",
      session: "owner-token",
      tenantId: TENANT,
      rosterRevision: revision,
      appointments: [{ ...booking(OLD_ID), status: "accepted" }],
    });
    expect(synced.status).toBe(200);
    expect(synced.data.rosterRevision).toBe(revision + 1);
    const after = await roster(env);
    sameBooking(after.appointments.find((b: { id: string }) => b.id === fresh.id), saved);
    expect(after.appointments.find((b: { id: string }) => b.id === OLD_ID)?.status).toBe("accepted");
  });

  it("lets an agency save merge the same way and still refuses another owner", async () => {
    const env = envWith();
    await seedOwnerAndOldBooking(env);
    putSession(env, "agency-token", "agency");
    putSession(env, "other-token", "owner", "other-shop");
    const { saved, fresh } = await arrivePublicBooking(env, "203.0.113.25");
    const before = env.AUTH_KV.store.get("privateAppts:" + TENANT);

    const denied = await call(env, {
      action: "sync",
      session: "other-token",
      tenantId: TENANT,
      appointments: [],
    });
    expect(denied.status).toBe(403);
    expect(denied.data.error).toBe("forbidden");
    expect(env.AUTH_KV.store.get("privateAppts:" + TENANT)).toBe(before);

    const deniedDelete = await call(env, {
      action: "delete",
      session: "other-token",
      tenantId: TENANT,
      bookingId: fresh.id,
    });
    expect(deniedDelete.status).toBe(403);
    expect(env.AUTH_KV.store.get("privateAppts:" + TENANT)).toBe(before);

    const synced = await call(env, {
      action: "sync",
      session: "agency-token",
      tenantId: TENANT,
      appointments: [booking(OLD_ID)],
    });
    expect(synced.status).toBe(200);
    const after = await roster(env);
    sameBooking(after.appointments.find((b: { id: string }) => b.id === fresh.id), saved);
  });

  it("deletes only the named booking after a newer public booking arrived", async () => {
    const env = envWith();
    await seedOwnerAndOldBooking(env);
    const { saved, fresh } = await arrivePublicBooking(env, "203.0.113.26");
    armedSlotId = fresh.id;
    const deleted = await call(env, {
      action: "delete",
      session: "owner-token",
      tenantId: TENANT,
      bookingId: OLD_ID,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.data.deleted).toBe(OLD_ID);
    const after = await roster(env);
    expect(after.appointments.find((b: { id: string }) => b.id === OLD_ID)).toBeUndefined();
    sameBooking(after.appointments.find((b: { id: string }) => b.id === fresh.id), saved);
    expect(slotCancels).toEqual([]);
  });

  it("keeps a booking a server full-list writer never loaded", async () => {
    const env = envWith();
    await savePrivateAppointments(env, TENANT, [
      booking(OLD_ID),
      booking("BK-NEW00001", { clientName: "Real Customer", clientEmail: "real.customer@example.com", notes: "arrived-after-page-load" }),
    ], 0);
    const before = (await roster(env)).appointments.find((b: { id: string }) => b.id === "BK-NEW00001");
    await persistTenantAppointments(env, "tok", TENANT, [{ ...booking(OLD_ID), status: "accepted" }]);
    const after = await roster(env);
    sameBooking(after.appointments.find((b: { id: string }) => b.id === "BK-NEW00001"), before);
    expect(after.appointments.find((b: { id: string }) => b.id === OLD_ID)?.status).toBe("accepted");
  });

  it("delete then save with the returned rosterRevision does not 409", async () => {
    const env = envWith();
    await seedOwnerAndOldBooking(env);
    const kept = booking("BK-KEEP0001", { time: "2:00 PM", clientName: "Still Here" });
    const seeded = await call(env, {
      action: "sync",
      session: "owner-token",
      tenantId: TENANT,
      rosterRevision: (await roster(env)).revision,
      appointments: [booking(OLD_ID), kept],
    });
    expect(seeded.status).toBe(200);
    const loaded = seeded.data.rosterRevision as number;

    const deleted = await call(env, {
      action: "delete",
      session: "owner-token",
      tenantId: TENANT,
      bookingId: OLD_ID,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.data.ok).toBe(true);
    expect(deleted.data.deleted).toBe(OLD_ID);
    expect(deleted.data.rosterRevision).toBe(loaded + 1);

    const stale = await call(env, {
      action: "sync",
      session: "owner-token",
      tenantId: TENANT,
      rosterRevision: loaded,
      appointments: [kept],
    });
    expect(stale.status).toBe(409);
    expect(stale.data.error).toBe("stale_roster");

    const follow = await call(env, {
      action: "sync",
      session: "owner-token",
      tenantId: TENANT,
      rosterRevision: deleted.data.rosterRevision,
      appointments: [kept],
    });
    expect(follow.status).toBe(200);
    expect(follow.data.ok).toBe(true);
    expect(follow.data.error).toBeUndefined();
    expect(follow.data.rosterRevision).toBe((deleted.data.rosterRevision as number) + 1);

    const after = await roster(env);
    expect(after.appointments.find((b: { id: string }) => b.id === OLD_ID)).toBeUndefined();
    expect(after.appointments.find((b: { id: string }) => b.id === "BK-KEEP0001")?.clientName).toBe("Still Here");
  });

  it("save then save with each returned rosterRevision does not 409", async () => {
    const env = envWith();
    await seedOwnerAndOldBooking(env);
    const loaded = (await roster(env)).revision as number;

    const first = await call(env, {
      action: "sync",
      session: "owner-token",
      tenantId: TENANT,
      rosterRevision: loaded,
      appointments: [{ ...booking(OLD_ID), clientName: "First Edit" }],
    });
    expect(first.status).toBe(200);
    expect(first.data.ok).toBe(true);
    expect(first.data.rosterRevision).toBe(loaded + 1);

    const second = await call(env, {
      action: "sync",
      session: "owner-token",
      tenantId: TENANT,
      rosterRevision: first.data.rosterRevision,
      appointments: [{ ...booking(OLD_ID), clientName: "First Edit", status: "accepted" }],
    });
    expect(second.status).toBe(200);
    expect(second.data.ok).toBe(true);
    expect(second.data.error).toBeUndefined();
    expect(second.data.rosterRevision).toBe((first.data.rosterRevision as number) + 1);

    const after = await roster(env);
    expect(after.revision).toBe(second.data.rosterRevision);
    expect(after.appointments.find((b: { id: string }) => b.id === OLD_ID)?.clientName).toBe("First Edit");
    expect(after.appointments.find((b: { id: string }) => b.id === OLD_ID)?.status).toBe("accepted");
  });

  it("create and client writes return a revision the next save can send", async () => {
    const env = envWith();
    await seedOwnerAndOldBooking(env);
    const before = (await roster(env)).revision as number;
    const token = (await roster(env)).appointments[0].manageToken as string;

    const created = await call(env, {
      action: "create",
      tenantId: TENANT,
      bookings: [{
        clientName: "Walk Up",
        clientEmail: "walk.up@example.com",
        clientPhone: "555-0140",
        serviceName: "Color",
        date: "2026-10-22",
        time: "11:30 AM",
        status: "pending",
        durationMins: 60,
        paymentMethod: "later",
      }],
    }, "203.0.113.41");
    expect(created.status).toBe(200);
    expect(created.data.rosterRevision).toBe(before + 1);
    const fresh = created.data.bookings[0];

    const cancelled = await call(env, {
      action: "client",
      slug: TENANT,
      token,
      cancel: true,
    }, "203.0.113.42");
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.ok).toBe(true);
    expect(cancelled.data.rosterRevision).toBe((created.data.rosterRevision as number) + 1);

    const follow = await call(env, {
      action: "sync",
      session: "owner-token",
      tenantId: TENANT,
      rosterRevision: cancelled.data.rosterRevision,
      appointments: [
        { ...booking(OLD_ID), status: "cancelled", cancelled: true, manageToken: token },
        fresh,
      ],
    });
    expect(follow.status).toBe(200);
    expect(follow.data.ok).toBe(true);
    expect(follow.data.error).toBeUndefined();
    const after = await roster(env);
    expect(after.appointments.find((b: { id: string }) => b.id === fresh.id)?.clientEmail).toBe("walk.up@example.com");
    expect(after.appointments.find((b: { id: string }) => b.id === OLD_ID)?.status).toBe("cancelled");
  });

  it("returns the roster revision the portal sends on the next save", async () => {
    const env = envWith();
    putSession(env, "owner-token", "owner");
    await savePrivateAppointments(env, TENANT, [booking(OLD_ID)], 4);
    const tenant = { id: TENANT, name: "Acme" };
    await hydrateTenantBookings(env, "tok", tenant);
    expect(tenant.rosterRevision).toBe(5);
    const listed = await call(env, { action: "list", session: "owner-token" }, "203.0.113.27", {
      listAllTenants: async () => [tenant],
    });
    expect(listed.status).toBe(200);
    expect(listed.data.tenants).toEqual([
      expect.objectContaining({ id: TENANT, rosterRevision: 5 }),
    ]);
  });
});
