import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workers/schedi-email-worker/src/firebase-admin.js", () => ({
  adminAccessToken: vi.fn(async () => "access"),
  adminAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer access", "Content-Type": "application/json" })),
}));

// @ts-expect-error plain JS worker module
import worker from "../workers/schedi-email-worker/src/index.js";

const TOKEN = "t".repeat(40);
const EXP = Date.now() + 60 * 60 * 1000;

function kv(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function env() {
  return {
    AUTH_KV: kv({
      "session:owner-token": JSON.stringify({ role: "owner", email: "owner@example.com", tenantId: "acme", exp: EXP }),
      "session:agency-token": JSON.stringify({ role: "agency", email: "hq@example.com", exp: EXP }),
    }),
    AUTH_PEPPER: "test-pepper",
    OPS_SNAPSHOT_TOKEN: TOKEN,
    MIGRATION_TOKEN: TOKEN,
    WEBHOOK_SECRET: TOKEN,
    FIREBASE_PROJECT_ID: "siteforge-97699",
  };
}

type Session = "none" | "owner" | "agency";

function call(path: string, body: Record<string, unknown>, session: Session, extraHeaders: Record<string, string> = {}) {
  const payload = { ...body };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: "https://schedi.app",
    ...extraHeaders,
  };
  if (session === "owner") {
    payload.session = "owner-token";
    headers["X-Schedi-Session"] = "owner-token";
  }
  if (session === "agency") {
    payload.session = "agency-token";
    headers["X-Schedi-Session"] = "agency-token";
  }
  const method = extraHeaders["x-method"] || "POST";
  delete headers["x-method"];
  return new Request("https://schedi.app" + path, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(payload),
  });
}

async function statusOf(path: string, body: Record<string, unknown>, session: Session, extraHeaders?: Record<string, string>) {
  const response = await worker.fetch(call(path, body, session, extraHeaders), env(), {});
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data: data as { ok?: boolean; error?: string; features?: string[]; tenants?: Array<{ id?: string; hqTags?: unknown }> } };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("unexpected network");
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("admin routes reject anonymous and owner sessions", () => {
  const denied: Array<[string, Record<string, unknown>, Record<string, string>?]> = [
    ["/auth/provision-mail", { businessName: "Acme", slug: "acme", ownerEmail: "a@b.co", password: "password1" }],
    ["/api/profile", { action: "migrate_private", dryRun: true }, { Authorization: "Bearer " + TOKEN }],
    ["/api/profile", { action: "save", tenants: [{ id: "other-biz", name: "Other", slug: "other-biz" }] }],
    ["/api/profile", { action: "delete", tenantIds: ["other-biz"] }],
    ["/api/bookings", { action: "counts" }],
    ["/api/bookings", { action: "migrate" }],
    ["/api/ops-snapshot", {}, { Authorization: "Bearer " + TOKEN, "x-method": "GET" }],
    ["/api/ops-snapshot", {}, { Authorization: "Bearer " + TOKEN }],
    ["/auth/password", { tenantId: "other-biz", ownerEmail: "a@b.co", newPassword: "password1" }],
    ["/auth/email", { tenantId: "other-biz", ownerEmail: "a@b.co" }],
    ["/auth/rename", { fromId: "other-biz", toId: "other-biz-2" }],
    ["/billing/checkout", { tenantId: "other-biz", plan: "pro" }],
    ["/billing/portal", { tenantId: "other-biz" }],
    ["/billing/cancel", { tenantId: "other-biz" }],
    ["/billing/resume", { tenantId: "other-biz" }],
  ];

  it.each(denied)("%s denies a missing session", async (path, body, headers) => {
    const out = await statusOf(path, body, "none", headers);
    expect([401, 403]).toContain(out.status);
  });

  it.each(denied)("%s denies an owner session", async (path, body, headers) => {
    const out = await statusOf(path, body, "owner", headers);
    expect([401, 403]).toContain(out.status);
  });
});

describe("agency gate is the first check", () => {
  it("rejects a bad agency password and does not treat an owner session as HQ", async () => {
    const out = await statusOf("/auth/agency", { email: "hq@example.com", password: "not-the-password" }, "owner");
    expect(out.status).toBe(401);
    expect(out.data.error).toBe("invalid_login");
  });

  it("opens provision and profile maintenance only after an agency session", async () => {
    const provision = await statusOf("/auth/provision-mail", {}, "agency");
    expect(provision.status).toBe(400);
    expect(provision.data.error).toBe("business_name_required");

    const wipe = await statusOf("/api/profile", { action: "delete", tenantIds: [] }, "agency");
    expect(wipe.status).toBe(400);
    expect(wipe.data.error).toBe("invalid_tenant");

    const migrate = await statusOf("/api/profile", { action: "migrate_private" }, "agency");
    expect(migrate.status).toBe(401);
    expect(migrate.data.error).toBe("unauthorized");

    const snap = await statusOf("/api/ops-snapshot", {}, "agency", { "x-method": "GET" });
    expect(snap.status).toBe(401);
    expect(snap.data.error).toBe("unauthorized");
  });

  it("treats a presented owner session as forbidden for reminder maintenance, even with the server bearer", async () => {
    const owner = await statusOf("/", { action: "run_reminders" }, "owner", { Authorization: "Bearer " + TOKEN });
    expect(owner.status).toBe(403);
    const anon = await statusOf("/", { action: "run_reminders" }, "none");
    expect(anon.status).toBe(401);
  });

  it("keeps HQ tags off an owner's private profile", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      fields: {
        ownerEmail: { stringValue: "owner@example.com" },
        hqTags: { arrayValue: { values: [{ stringValue: "vip" }] } },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const out = await statusOf("/api/profile", { action: "private" }, "owner");
    expect(out.status).toBe(200);
    expect(out.data.features || []).not.toContain("hqTags");
    expect(out.data.tenants).toEqual([{ id: "acme", ownerEmail: "owner@example.com" }]);
    expect(JSON.stringify(out.data)).not.toContain("other-biz");
    expect(JSON.stringify(out.data)).not.toContain("vip");
  });
});
