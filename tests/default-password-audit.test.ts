import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain JS worker module
import { saveOwnerSecret } from "../workers/schedi-email-worker/src/owner-auth.js";
// @ts-expect-error plain JS worker module
import { handleDefaultPasswordAudit } from "../workers/schedi-email-worker/src/default-password-audit.js";
// @ts-expect-error plain JS worker module
import worker from "../workers/schedi-email-worker/src/index.js";

const PEPPER = "unit-test-pepper";
const TOKEN = "ops-snapshot-token-0123456789abcdef";
const AGENCY = "agency-session-token";
const OWNER = "owner-session-token";

type Kv = {
  store: Map<string, string>;
  writes: string[];
  listCalls: Array<{ prefix?: string; cursor?: string; limit?: number }>;
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: (opts?: { prefix?: string; cursor?: string; limit?: number }) => Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor: string;
  }>;
};

function memoryKv(initial: Record<string, string> = {}): Kv {
  const store = new Map(Object.entries(initial));
  const writes: string[] = [];
  const listCalls: Kv["listCalls"] = [];
  return {
    store,
    writes,
    listCalls,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      writes.push("put:" + key);
      store.set(key, value);
    },
    async delete(key) {
      writes.push("delete:" + key);
      store.delete(key);
    },
    async list(opts = {}) {
      listCalls.push(opts);
      const prefix = opts.prefix || "";
      const keys = [...store.keys()].filter((name) => name.startsWith(prefix)).sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const limit = opts.limit || 1000;
      const page = keys.slice(start, start + limit);
      const next = start + page.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: next >= keys.length,
        cursor: String(next),
      };
    },
  };
}

function session(role: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ role, exp: Date.now() + 60 * 60 * 1000, ...extra });
}

let legacyRaw = "";
let changedRaw = "";

beforeAll(async () => {
  const kv = memoryKv();
  const env = { AUTH_KV: kv, AUTH_PEPPER: PEPPER };
  expect((await saveOwnerSecret(env, "legacy@example.com", "legacy-shop", "vance123")).ok).toBe(true);
  expect((await saveOwnerSecret(env, "changed@example.com", "changed-shop", "newpass99")).ok).toBe(true);
  legacyRaw = kv.store.get("tenant:legacy-shop") || "";
  changedRaw = kv.store.get("tenant:changed-shop") || "";
  expect(legacyRaw).toContain("salt");
  expect(changedRaw).toContain("hash");
}, 20000);

function seededStore(extra: Record<string, string> = {}) {
  return {
    ["session:" + AGENCY]: session("agency", { email: "hq@example.com" }),
    ["session:" + OWNER]: session("owner", { email: "owner@example.com", tenantId: "legacy-shop" }),
    "tenant:legacy-shop": legacyRaw,
    "tenant:changed-shop": changedRaw,
    "email:legacy@example.com": JSON.stringify({ tenantIds: ["legacy-shop"] }),
    "tenant:not-a-password": JSON.stringify({ email: "plain@example.com" }),
    "tenant:broken": "{not-json",
    ...extra,
  };
}

function envFrom(store: Record<string, string>, over: Record<string, unknown> = {}) {
  const kv = memoryKv(store);
  return {
    kv,
    env: {
      AUTH_KV: kv,
      AUTH_PEPPER: PEPPER,
      OPS_SNAPSHOT_TOKEN: TOKEN,
      ...over,
    },
  };
}

function call(path: string, init: RequestInit = {}) {
  return new Request("https://schedi-email-worker.example" + path, init);
}

function authed(method: "GET" | "POST", sessionToken = AGENCY, token = TOKEN, body?: unknown) {
  const headers: Record<string, string> = { Authorization: "Bearer " + token };
  if (method === "GET") headers["X-Schedi-Session"] = sessionToken;
  if (method === "POST") headers["Content-Type"] = "application/json";
  return call("/api/ops-default-passwords", {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body ?? { session: sessionToken }) : undefined,
  });
}

describe("GET|POST /api/ops-default-passwords", () => {
  it("returns only tenant ids whose stored password is still the old default", async () => {
    const { kv, env } = envFrom(seededStore());
    const before = kv.writes.length;
    const res = await handleDefaultPasswordAudit(authed("GET"), env);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body).toEqual({ ok: true, tenantIds: ["legacy-shop"] });
    expect(Object.keys(body).sort()).toEqual(["ok", "tenantIds"]);
    const legacy = JSON.parse(legacyRaw);
    expect(text).not.toContain(legacy.salt);
    expect(text).not.toContain(legacy.hash);
    expect(text).not.toContain("vance123");
    expect(text).not.toContain("legacy@example.com");
    expect(text).not.toContain(PEPPER);
    expect(kv.writes.slice(before)).toEqual([]);
    expect(kv.listCalls.every((c) => c.prefix === "tenant:")).toBe(true);
  });

  it("accepts the agency session from the JSON body or the schedi_hq cookie", async () => {
    const { env } = envFrom(seededStore());
    const posted = await handleDefaultPasswordAudit(authed("POST"), env);
    expect(await posted.json()).toEqual({ ok: true, tenantIds: ["legacy-shop"] });
    const cookie = await handleDefaultPasswordAudit(call("/api/ops-default-passwords", {
      method: "GET",
      headers: {
        Authorization: "Bearer " + TOKEN,
        Cookie: "other=1; schedi_hq=" + encodeURIComponent(AGENCY),
      },
    }), env);
    expect(await cookie.json()).toEqual({ ok: true, tenantIds: ["legacy-shop"] });
  });

  it("uses that record's salt, so a swapped salt does not match", async () => {
    const legacy = JSON.parse(legacyRaw);
    const changed = JSON.parse(changedRaw);
    const { env } = envFrom(seededStore({
      "tenant:swapped": JSON.stringify({ ...legacy, salt: changed.salt, tenantId: "swapped" }),
    }));
    const res = await handleDefaultPasswordAudit(authed("GET"), env);
    expect(await res.json()).toEqual({ ok: true, tenantIds: ["legacy-shop"] });
  });

  it("walks every tenant: page and still does not write", async () => {
    const { kv, env } = envFrom(seededStore({
      "tenant:also-legacy": legacyRaw,
    }));
    kv.list = async (opts = {}) => {
      kv.listCalls.push(opts);
      if (!opts.cursor) {
        return { keys: [{ name: "tenant:changed-shop" }, { name: "email:legacy@example.com" }], list_complete: false, cursor: "next" };
      }
      return { keys: [{ name: "tenant:legacy-shop" }, { name: "tenant:also-legacy" }, { name: "tenant:" }], list_complete: true, cursor: "" };
    };
    const res = await handleDefaultPasswordAudit(authed("POST", AGENCY, TOKEN, { session: AGENCY, password: "vance123" }), env);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, tenantIds: ["also-legacy", "legacy-shop"] });
    expect(text).not.toContain("vance123");
    expect(kv.listCalls).toHaveLength(2);
    expect(kv.writes).toEqual([]);
  });

  it("rejects a missing or wrong bearer before reading sessions or tenant records", async () => {
    const { kv, env } = envFrom(seededStore());
    for (const headers of [
      {},
      { Authorization: "Bearer " },
      { Authorization: "Bearer nope", "X-Schedi-Session": AGENCY },
      { Authorization: TOKEN, "X-Schedi-Session": AGENCY },
    ]) {
      const res = await handleDefaultPasswordAudit(call("/api/ops-default-passwords", { method: "GET", headers }), env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    }
    expect(kv.listCalls).toEqual([]);
    expect(kv.writes).toEqual([]);
  });

  it("requires an agency session after the bearer matches", async () => {
    const { kv, env } = envFrom(seededStore());
    const missing = await handleDefaultPasswordAudit(call("/api/ops-default-passwords", {
      method: "GET",
      headers: { Authorization: "Bearer " + TOKEN },
    }), env);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ ok: false, error: "session_required" });

    const owner = await handleDefaultPasswordAudit(authed("GET", OWNER), env);
    expect(owner.status).toBe(403);
    expect(await owner.json()).toEqual({ ok: false, error: "forbidden" });

    const stale = await handleDefaultPasswordAudit(authed("POST", "missing-session"), env);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ ok: false, error: "session_required" });
    expect(kv.listCalls).toEqual([]);
  });

  it("does not scan when auth is not configured, and rejects other methods", async () => {
    const { kv, env } = envFrom(seededStore(), { AUTH_PEPPER: "" });
    const res = await handleDefaultPasswordAudit(authed("GET"), env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "auth_not_configured" });
    expect(kv.listCalls).toEqual([]);

    const nope = await handleDefaultPasswordAudit(call("/api/ops-default-passwords", { method: "DELETE" }), env);
    expect(nope.status).toBe(405);
    expect(await nope.json()).toEqual({ ok: false, error: "method_not_allowed" });
  });

  it("is wired on the worker and returns an empty list when nothing matches", async () => {
    const { env } = envFrom(seededStore({ "tenant:legacy-shop": changedRaw }));
    const res = await worker.fetch(authed("GET"), env, { waitUntil() {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tenantIds: [] });
  });
});
