import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workers/schedi-email-worker/src/firebase-admin.js", () => ({
  adminAccessToken: vi.fn(async () => "access"),
  adminAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer access", "Content-Type": "application/json" })),
}));

import worker from "../workers/schedi-email-worker/src/index.js";
import { resetLocalLimits } from "../workers/schedi-email-worker/src/rate-limit.js";

const EXP = Date.now() + 60 * 60 * 1000;

function kv() {
  const store = new Map<string, string>([
    ["session:owner-token", JSON.stringify({ role: "owner", email: "owner@example.com", tenantId: "acme", exp: EXP })],
    ["session:other-token", JSON.stringify({ role: "owner", email: "other@example.com", tenantId: "other-biz", exp: EXP })],
    ["session:agency-token", JSON.stringify({ role: "agency", email: "hq@example.com", exp: EXP })],
  ]);
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  };
}

function env() {
  return {
    AUTH_KV: kv(),
    AUTH_PEPPER: "test-pepper",
    OPS_SNAPSHOT_TOKEN: "t".repeat(40),
    RESEND_API_KEY: "re_test",
    FIREBASE_API_KEY: "test-key",
    FIREBASE_PROJECT_ID: "siteforge-97699",
    FIREBASE_APP_ID: "siteforge-97699",
  };
}

type Who = "none" | "owner" | "other" | "agency";

function requestFor(path: string, body: Record<string, unknown>, who: Who, method = "POST") {
  const payload = { ...body };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: "https://schedi.app",
  };
  if (who === "owner") payload.session = "owner-token";
  if (who === "other") payload.session = "other-token";
  if (who === "agency") payload.session = "agency-token";
  return new Request("https://schedi.app" + path, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(payload),
  });
}

async function statusOf(path: string, body: Record<string, unknown>, who: Who, method = "POST") {
  const response = await worker.fetch(requestFor(path, body, who, method), env(), { waitUntil() {} });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data: data as { ok?: boolean; error?: string } };
}

const agencyOnly: Array<[string, Record<string, unknown>, string?]> = [
  ["/auth/provision-mail", { businessName: "Acme", slug: "acme", ownerName: "Ada", ownerEmail: "ada@example.com", password: "password1" }],
  ["/api/bookings", { action: "counts" }],
  ["/api/bookings", { action: "migrate" }],
  ["/api/ops-snapshot", {}],
  ["/api/ops-default-passwords", {}],
  ["/api/profile", { action: "delete", tenantIds: ["other-biz"] }],
];

const tenantOwned: Array<[string, Record<string, unknown>]> = [
  ["/api/calendar-feeds", { action: "list", tenantId: "acme" }],
  ["/api/square/status", { tenantId: "acme" }],
];

beforeEach(() => {
  resetLocalLimits();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("identitytoolkit.googleapis.com")) {
      return new Response(JSON.stringify({ idToken: "anon" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("api.resend.com")) {
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (init && String(init.method || "GET").toUpperCase() === "DELETE") {
      return new Response("", { status: 200 });
    }
    return new Response(JSON.stringify({ documents: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetLocalLimits();
});

describe("agency-only writes", () => {
  it.each(agencyOnly)("%s %s is 401, 403, then 2xx", async (path, body, method) => {
    const none = await statusOf(path, body, "none", method);
    const owner = await statusOf(path, body, "owner", method);
    const agency = await statusOf(path, body, "agency", method);
    expect(none.status, path + " none").toBe(401);
    expect(owner.status, path + " owner " + JSON.stringify(owner.data)).toBe(403);
    expect(agency.status, path + " agency " + JSON.stringify(agency.data)).toBeGreaterThanOrEqual(200);
    expect(agency.status, path + " agency " + JSON.stringify(agency.data)).toBeLessThan(300);
  });
});

describe("tenant-owned writes", () => {
  it.each(tenantOwned)("%s is 401 without a session, 403 for another owner, and 2xx for the owner and agency", async (path, body) => {
    const none = await statusOf(path, body, "none");
    const other = await statusOf(path, body, "other");
    const owner = await statusOf(path, body, "owner");
    const agency = await statusOf(path, body, "agency");
    expect(none.status, path).toBe(401);
    expect(other.status, path + " " + JSON.stringify(other.data)).toBe(403);
    expect(owner.status, path + " " + JSON.stringify(owner.data)).toBeGreaterThanOrEqual(200);
    expect(owner.status).toBeLessThan(300);
    expect(agency.status, path + " " + JSON.stringify(agency.data)).toBeGreaterThanOrEqual(200);
    expect(agency.status).toBeLessThan(300);
  });
});
