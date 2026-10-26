import { describe, expect, it } from "vitest";
import { handleClientsHttp, upsertClientsFromBookings } from "../workers/schedi-email-worker/src/private-clients.js";
import { resetLocalLimits } from "../workers/schedi-email-worker/src/rate-limit.js";

const TOKEN = "m".repeat(40);
const TENANT = "harbor-demo";

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

function booking(extra: Record<string, unknown> = {}) {
  return {
    id: "BK-1",
    clientName: "Maya Chen",
    clientEmail: "maya@example.com",
    clientPhone: "(555) 201-0142",
    status: "accepted",
    date: "2026-10-20",
    time: "09:00 AM",
    createdAt: "2026-10-15T18:00:00.000Z",
    ...extra,
  };
}

function envFor(role: "owner" | "agency" | "none" = "agency", tenantId = TENANT) {
  const kv = memoryKv();
  const exp = Date.now() + 60 * 60 * 1000;
  if (role === "owner") kv.store.set("session:tok", JSON.stringify({ role: "owner", tenantId, exp }));
  if (role === "agency") kv.store.set("session:tok", JSON.stringify({ role: "agency", exp }));
  return { AUTH_KV: kv, RL_CLIENTS: null, MIGRATION_TOKEN: TOKEN };
}

function putBookings(env: ReturnType<typeof envFor>, tenantId: string, rows: unknown[]) {
  env.AUTH_KV.store.set("privateAppts:" + tenantId, JSON.stringify({ appointments: rows, revision: 3 }));
}

async function call(
  env: ReturnType<typeof envFor>,
  body: unknown,
  authorization = "Bearer " + TOKEN,
) {
  const headers: Record<string, string> = {
    Origin: "https://schedi.app",
    "Content-Type": "application/json",
  };
  if (authorization) headers.Authorization = authorization;
  const res = await handleClientsHttp(
    new Request("https://schedi.app/api/clients", { method: "POST", headers, body: JSON.stringify(body) }),
    env,
    "https://schedi.app",
    {
      isAllowedOrigin: () => true,
      loadPrivateAppointments: async (storeEnv: { AUTH_KV: { get: (key: string) => Promise<string | null> } }, id: string) => {
        const raw = await storeEnv.AUTH_KV.get("privateAppts:" + id);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.appointments) ? parsed.appointments : [];
      },
      listTenantIds: async () => [TENANT, "other-shop"],
    },
  );
  return { status: res.status, data: await res.json() as Record<string, unknown> };
}

function emailsOf(env: ReturnType<typeof envFor>, tenantId = TENANT) {
  const raw = env.AUTH_KV.store.get("privateClients:" + tenantId);
  if (!raw) return [];
  const doc = JSON.parse(raw);
  return (doc.clients || []).map((row: { email?: string }) => row.email);
}

describe("client upsert and backfill", () => {
  it("adds accepted and blank bookings and skips pending, unpaid deposits, and a second copy", async () => {
    const env = envFor();
    const first = await upsertClientsFromBookings(env, TENANT, [
      booking(),
      booking({ id: "BK-BLANK", status: "", clientEmail: "blank@example.com", clientName: "Blank Status", clientPhone: "(555) 201-0143" }),
      booking({ id: "BK-PEND", status: "pending", clientEmail: "pending@example.com", clientName: "Pending Person", clientPhone: "(555) 201-0144" }),
      booking({ id: "BK-DEPOSIT", status: "accepted", depositAmount: 25, depositPaid: false, clientEmail: "deposit@example.com", clientName: "Deposit Person", clientPhone: "(555) 201-0145" }),
      booking({ id: "BK-PAID", status: "accepted", depositAmount: 25, depositPaid: true, clientEmail: "paid@example.com", clientName: "Paid Deposit", clientPhone: "(555) 201-0146" }),
    ]);
    expect(first.added).toBe(3);
    expect(emailsOf(env).sort()).toEqual(["blank@example.com", "maya@example.com", "paid@example.com"]);
    await env.AUTH_KV.put("privateClients:" + TENANT, JSON.stringify({
      clients: [{ id: "cl_maya", name: "Maya Chen", email: "maya@example.com", phone: "(555) 201-0142", notes: "Keep this", tags: ["regular"], source: "manual" }],
      removed: [],
    }));
    const second = await upsertClientsFromBookings(env, TENANT, [booking({ clientName: "Maya Changed", notes: "overwrite" })]);
    expect(second.added).toBe(0);
    const stored = JSON.parse(env.AUTH_KV.store.get("privateClients:" + TENANT) || "{}");
    expect(stored.clients).toHaveLength(1);
    expect(stored.clients[0].name).toBe("Maya Chen");
    expect(stored.clients[0].notes).toBe("Keep this");
    expect(stored.clients[0].tags).toEqual(["regular"]);
  });

  it("remembers a removal so backfill skips the old visit and a later booking can return", async () => {
    const env = envFor("owner");
    const added = await call(env, {
      action: "add",
      session: "tok",
      tenantId: TENANT,
      client: { name: "Maya Chen", email: "maya@example.com", phone: "(555) 201-0142" },
    }, "");
    expect(added.status).toBe(200);
    const clientId = (added.data.client as { id: string }).id;
    const removed = await call(env, { action: "delete", session: "tok", tenantId: TENANT, clientId }, "");
    expect(removed.status).toBe(200);
    const doc = JSON.parse(env.AUTH_KV.store.get("privateClients:" + TENANT) || "{}");
    expect(doc.clients).toEqual([]);
    expect(doc.removed.some((row: { email?: string }) => row.email === "maya@example.com")).toBe(true);

    const blocked = await upsertClientsFromBookings(env, TENANT, [booking()], { respectRemoval: true });
    expect(blocked.added).toBe(0);
    expect(emailsOf(env)).toEqual([]);

    const fresh = await upsertClientsFromBookings(env, TENANT, [booking()], {});
    expect(fresh.added).toBe(1);
    await call(env, { action: "delete", session: "tok", tenantId: TENANT, clientId: JSON.parse(env.AUTH_KV.store.get("privateClients:" + TENANT) || "{}").clients[0].id }, "");

    const later = await upsertClientsFromBookings(env, TENANT, [
      booking({ createdAt: "2099-01-01T00:00:00.000Z" }),
    ], { respectRemoval: true });
    expect(later.added).toBe(1);
    expect(emailsOf(env)).toEqual(["maya@example.com"]);
  });

  it("lets a manual add clear a removal", async () => {
    const env = envFor("owner");
    const added = await call(env, {
      action: "add",
      session: "tok",
      tenantId: TENANT,
      client: { name: "Maya Chen", email: "maya@example.com", phone: "(555) 201-0142" },
    }, "");
    const clientId = (added.data.client as { id: string }).id;
    await call(env, { action: "delete", session: "tok", tenantId: TENANT, clientId }, "");
    const again = await call(env, {
      action: "add",
      session: "tok",
      tenantId: TENANT,
      client: { name: "Maya Chen", email: "maya@example.com", phone: "(555) 201-0142" },
    }, "");
    expect(again.status).toBe(200);
    const doc = JSON.parse(env.AUTH_KV.store.get("privateClients:" + TENANT) || "{}");
    expect(doc.removed.some((row: { email?: string }) => row.email === "maya@example.com")).toBe(false);
  });

  it("dry-runs by default, applies only when asked, and leaves bookings untouched", async () => {
    resetLocalLimits();
    const env = envFor("agency");
    putBookings(env, TENANT, [booking(), booking({ id: "BK-PEND", status: "pending", clientEmail: "pending@example.com", clientName: "Pending Person", clientPhone: "(555) 201-0199" })]);
    putBookings(env, "other-shop", [booking({ id: "BK-OTHER", clientEmail: "other@example.com", clientName: "Other Shop", clientPhone: "(555) 201-0188" })]);
    const before = env.AUTH_KV.store.get("privateAppts:" + TENANT);

    const preview = await call(env, { action: "backfill", session: "tok" });
    expect(preview.status).toBe(200);
    expect(preview.data.dryRun).toBe(true);
    expect(preview.data.bookingsUntouched).toBe(true);
    expect(preview.data.added).toBe(2);
    expect(env.AUTH_KV.store.has("privateClients:" + TENANT)).toBe(false);
    expect(env.AUTH_KV.store.get("privateAppts:" + TENANT)).toBe(before);
    const previewText = JSON.stringify(preview.data);
    expect(previewText).not.toContain("maya@example.com");
    expect(previewText).not.toContain("Maya");
    expect(previewText).not.toContain(TOKEN);
    expect(previewText).not.toContain("BK-1");

    const word = await call(env, { action: "backfill", session: "tok", dryRun: "no" });
    expect(word.status).toBe(200);
    expect(word.data.dryRun).toBe(true);
    expect(env.AUTH_KV.store.has("privateClients:" + TENANT)).toBe(false);

    const applied = await call(env, { action: "backfill", session: "tok", dryRun: false });
    expect(applied.status).toBe(200);
    expect(applied.data.dryRun).toBe(false);
    expect(applied.data.bookingsUntouched).toBe(true);
    expect(applied.data.added).toBe(2);
    expect(emailsOf(env).sort()).toEqual(["maya@example.com"]);
    expect(emailsOf(env, "other-shop")).toEqual(["other@example.com"]);
    expect(env.AUTH_KV.store.get("privateAppts:" + TENANT)).toBe(before);
    const appliedText = JSON.stringify(applied.data);
    expect(appliedText).not.toContain("maya@example.com");
    expect(appliedText).not.toContain("other@example.com");
    expect(appliedText).not.toContain(TOKEN);

    const scoped = await call(env, { action: "backfill", session: "tok", tenantId: TENANT, dryRun: true });
    expect(scoped.status).toBe(200);
    expect(scoped.data.tenants).toBe(1);
    expect((scoped.data.results as { tenantId: string }[])[0].tenantId).toBe(TENANT);
  });

  it("rejects an owner, a missing token, and a short token", async () => {
    resetLocalLimits();
    const owner = envFor("owner");
    putBookings(owner, TENANT, [booking()]);
    const forbidden = await call(owner, { action: "backfill", session: "tok", dryRun: false });
    expect(forbidden.status).toBe(403);
    expect(forbidden.data.error).toBe("forbidden");
    expect(owner.AUTH_KV.store.has("privateClients:" + TENANT)).toBe(false);

    const agency = envFor("agency");
    putBookings(agency, TENANT, [booking()]);
    const missing = await call(agency, { action: "backfill", session: "tok" }, "");
    expect(missing.status).toBe(401);
    expect(missing.data.error).toBe("unauthorized");
    const shortEnv = envFor("agency");
    shortEnv.MIGRATION_TOKEN = "short-token";
    const short = await call(shortEnv, { action: "backfill", session: "tok" }, "Bearer short-token");
    expect(short.status).toBe(401);
    const wrong = await call(agency, { action: "backfill", session: "tok" }, "Bearer " + "n".repeat(40));
    expect(wrong.status).toBe(401);
    const none = envFor("none");
    const signedOut = await call(none, { action: "backfill", session: "tok", dryRun: false });
    expect(signedOut.status).toBe(401);
    expect(signedOut.data.error).toBe("session_required");
    expect(agency.AUTH_KV.store.has("privateClients:" + TENANT)).toBe(false);

    const badTenant = await call(agency, { action: "backfill", session: "tok", tenantId: "not a tenant" });
    expect(badTenant.status).toBe(400);
    expect(badTenant.data.error).toBe("invalid_tenant");
  });
});
