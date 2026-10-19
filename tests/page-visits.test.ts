import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, type SchediEnv } from "../worker/handler";
import {
  handlePageVisitsRequest,
  isBotUserAgent,
  noteBookingVisit,
  PAGE_VISIT_TRACKING_START,
  pageVisitFlushForTests,
  readBookingVisits,
  resetPageVisitBufferForTests,
  setPageVisitIsolateForTests,
  shouldCountBookingVisit,
  visitDay,
  type VisitKv,
  type VisitRequest,
} from "../worker/page-visits";

const SHELL = "<!DOCTYPE html><html><head><title>Schedi</title></head><body>app</body></html>";
const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const EXP = Date.now() + 60 * 60 * 1000;

function memoryKv(seed: Record<string, string> = {}): VisitKv & { store: Map<string, string>; puts: string[] } {
  const store = new Map(Object.entries(seed));
  const puts: string[] = [];
  return {
    store,
    puts,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      puts.push(key + "=" + value);
      store.set(key, value);
    },
    async list(options: { prefix?: string; cursor?: string; limit?: number }) {
      const prefix = options.prefix || "";
      const names = Array.from(store.keys())
        .filter((key) => key.startsWith(prefix))
        .sort();
      const start = options.cursor ? Number(options.cursor) : 0;
      const limit = options.limit || names.length;
      const slice = names.slice(start, start + limit);
      const next = start + slice.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: next >= names.length,
        cursor: next >= names.length ? undefined : String(next),
      };
    },
  };
}

function visit(partial: Partial<VisitRequest> & { pathname: string }): VisitRequest {
  const url = new URL("https://schedi.app" + partial.pathname);
  return {
    method: "GET",
    hostname: "schedi.app",
    pathname: url.pathname,
    searchParams: url.searchParams,
    userAgent: CHROME,
    referer: "",
    secFetchDest: "document",
    secFetchMode: "navigate",
    secPurpose: "",
    ...partial,
    hostname: partial.hostname || "schedi.app",
    pathname: url.pathname,
    searchParams: url.searchParams,
  };
}

function shellAssets(): SchediEnv["ASSETS"] {
  return {
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      if (path === "/index.html") {
        return new Response(SHELL, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    },
  };
}

function tenantDoc(timezone = "America/New_York") {
  return new Response(
    JSON.stringify({
      fields: {
        name: { stringValue: "Bright Cuts" },
        industry: { stringValue: "Barber" },
        slug: { stringValue: "bright-cuts" },
        seoPublic: { booleanValue: true },
        timezone: { stringValue: timezone },
        ownerEmail: { stringValue: "hidden@example.com" },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  resetPageVisitBufferForTests();
  vi.unstubAllGlobals();
});

describe("visit counting rules", () => {
  it("counts a real browser GET and skips bots, previews, and non-pages", () => {
    expect(isBotUserAgent("")).toBe(false);
    expect(isBotUserAgent(CHROME)).toBe(false);
    expect(isBotUserAgent("Mozilla/5.0 (iPhone) DuckDuckGo/5")).toBe(false);
    expect(isBotUserAgent("Mozilla/5.0 Instagram 292.0.0.34.123")).toBe(false);
    expect(isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isBotUserAgent("curl/8.4.0")).toBe(true);
    expect(isBotUserAgent("Mozilla/5.0 HeadlessChrome/120.0.0.0")).toBe(true);
    expect(isBotUserAgent("facebookexternalhit/1.1")).toBe(true);
    expect(isBotUserAgent("GPTBot/1.0")).toBe(true);

    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts" }))).toBe(true);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts/" }))).toBe(true);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts", method: "HEAD" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts", userAgent: "Mozilla/5.0 (compatible; bingbot/2.0)" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts", secPurpose: "prefetch" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts", secFetchDest: "image" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts", secFetchMode: "cors" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts?demo=1" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts?portal=preview" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts?dash=reports" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts", referer: "https://schedi.app/login?dash=reports" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts", referer: "https://schedi.app/portal-preview?demo=1" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts", referer: "https://preview.workers.dev/" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts", hostname: "schedi.workers.dev" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts", hostname: "localhost" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts/manage/token" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/assets/logo.svg" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/login" }))).toBe(false);
    expect(shouldCountBookingVisit(visit({ pathname: "/bright-cuts", referer: "https://www.google.com/search?q=haircut" }))).toBe(true);
  });

  it("uses the business timezone for the day bucket", () => {
    const instant = new Date("2026-10-19T03:30:00Z");
    expect(visitDay(instant, "America/New_York")).toBe("2026-10-18");
    expect(visitDay(instant, "Asia/Tokyo")).toBe("2026-10-19");
    expect(visitDay(instant, "Not/AZone")).toBe("2026-10-18");
  });
});

describe("visit gauge aggregation", () => {
  it("batches a burst into one gauge and sums isolates without double counting", async () => {
    const kv = memoryKv();
    setPageVisitIsolateForTests("isoa");
    noteBookingVisit(kv, null, "bright-cuts", "2026-10-19", { flushMs: 0, holdMs: 0 });
    noteBookingVisit(kv, null, "bright-cuts", "2026-10-19", { flushMs: 0, holdMs: 0 });
    noteBookingVisit(kv, null, "bright-cuts", "2026-10-20", { flushMs: 0, holdMs: 0 });
    await pageVisitFlushForTests();
    expect(kv.puts).toHaveLength(2);
    expect(kv.store.get("pv1:bright-cuts:2026-10-19:isoa")).toBe("2");
    expect(kv.store.get("pv1:bright-cuts:2026-10-20:isoa")).toBe("1");

    noteBookingVisit(kv, null, "bright-cuts", "2026-10-19", { flushMs: 0, holdMs: 0 });
    await pageVisitFlushForTests();
    expect(kv.store.get("pv1:bright-cuts:2026-10-19:isoa")).toBe("3");

    setPageVisitIsolateForTests("isob");
    noteBookingVisit(kv, null, "bright-cuts", "2026-10-19", { flushMs: 0, holdMs: 0 });
    noteBookingVisit(kv, null, "bright-cuts", "2026-10-19", { flushMs: 0, holdMs: 0 });
    await pageVisitFlushForTests();
    const days = await readBookingVisits(kv, "bright-cuts", "2026-10-19", "2026-10-19");
    expect(days).toEqual({ "2026-10-19": 5 });
    const wider = await readBookingVisits(kv, "bright-cuts", "2026-10-01", "2026-10-31");
    expect(wider).toEqual({ "2026-10-19": 5, "2026-10-20": 1 });
    for (const value of kv.store.values()) expect(value).toMatch(/^\d+$/);
  });

  it("pages the key list when a business has more gauges than one page", async () => {
    const seed: Record<string, string> = {};
    for (let i = 0; i < 3; i += 1) seed[`pv1:acme:2026-10-19:iso${i}`] = "2";
    const kv = memoryKv(seed);
    const original = kv.list.bind(kv);
    kv.list = async (options) => original({ ...options, limit: 2 });
    const days = await readBookingVisits(kv, "acme", "2026-10-19", "2026-10-19");
    expect(days).toEqual({ "2026-10-19": 6 });
  });
});

describe("published page GET", () => {
  function jobs() {
    const pending: Promise<unknown>[] = [];
    return {
      pending,
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    };
  }

  async function serve(path: string, kv: ReturnType<typeof memoryKv>, init: RequestInit = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const target = String(input);
        if (target.includes("/tenants/bright-cuts")) return tenantDoc();
        if (target.includes("/tenants/missing-shop")) return new Response("", { status: 404 });
        throw new Error("unexpected fetch " + target);
      }),
    );
    const ctx = jobs();
    const env: SchediEnv = {
      FIREBASE_PROJECT_ID: "siteforge-97699",
      ASSETS: shellAssets(),
      AUTH_KV: kv,
      PAGE_VISIT_FLUSH_MS: "0",
    };
    const headers = new Headers(init.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", CHROME);
    if (!headers.has("sec-fetch-dest")) headers.set("sec-fetch-dest", "document");
    if (!headers.has("sec-fetch-mode")) headers.set("sec-fetch-mode", "navigate");
    const response = await handleRequest(new Request("https://schedi.app" + path, { ...init, headers }), env, ctx);
    await response.arrayBuffer().catch(() => undefined);
    await Promise.all(ctx.pending);
    await pageVisitFlushForTests();
    return response;
  }

  it("counts real GETs of a published page and ignores bots, the owner portal, and assets", async () => {
    const kv = memoryKv();
    const day = visitDay(new Date(), "America/New_York");
    const first = await serve("/bright-cuts", kv, { headers: { referer: "https://www.google.com/search?q=secret-query" } });
    expect(first.status).toBe(200);
    await serve("/bright-cuts/", kv, { headers: { "x-forwarded-for": "203.0.113.8", "user-agent": CHROME + " UniqueBrowserToken" } });
    await serve("/bright-cuts", kv);
    expect(kv.puts.map((entry) => entry.slice(entry.lastIndexOf("=") + 1))).toEqual(["1", "2", "3"]);
    const stored = Array.from(kv.store.entries());
    expect(stored).toHaveLength(1);
    expect(stored[0][0]).toMatch(new RegExp("^pv1:bright-cuts:" + day + ":[a-z0-9]+$"));
    expect(stored[0][1]).toBe("3");
    const dumped = JSON.stringify(stored);
    expect(dumped).not.toContain("UniqueBrowserToken");
    expect(dumped).not.toContain("203.0.113.8");
    expect(dumped).not.toContain("secret-query");
    expect(dumped).not.toContain("hidden@example.com");

    const before = kv.puts.length;
    await serve("/bright-cuts", kv, { headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" } });
    await serve("/bright-cuts", kv, { headers: { referer: "https://schedi.app/login" } });
    await serve("/bright-cuts?demo=1", kv);
    await serve("/bright-cuts", kv, { headers: { "sec-purpose": "prefetch" } });
    await serve("/bright-cuts", kv, { method: "HEAD" });
    await serve("/bright-cuts/logo.png", kv);
    await serve("/bright-cuts/manage/abc", kv);
    await serve("/missing-shop", kv);
    expect(kv.store.get(stored[0][0])).toBe("3");
    expect(kv.puts.length).toBe(before);
  });
});

describe("owner page-visits API", () => {
  function json(body: unknown, status: number) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  function envFor(kv: VisitKv) {
    return {
      AUTH_KV: kv,
      AUTH_PEPPER: "test-pepper",
    };
  }

  it("returns only the signed-in owner's totals", async () => {
    const kv = memoryKv({
      "session:owner-token": JSON.stringify({ role: "owner", email: "owner@example.com", tenantId: "acme", exp: EXP }),
      "session:other-token": JSON.stringify({ role: "owner", email: "other@example.com", tenantId: "other", exp: EXP }),
      "session:agency-token": JSON.stringify({ role: "agency", email: "hq@example.com", exp: EXP }),
      "pv1:acme:2026-10-19:isoa": "4",
      "pv1:acme:2026-10-18:isoa": "9",
      "pv1:other:2026-10-19:isoa": "100",
    });
    const { readSession } = await import("../workers/schedi-email-worker/src/owner-auth.js");
    const ok = await handlePageVisitsRequest(
      new Request("https://schedi.app/api/page-visits", {
        method: "POST",
        body: JSON.stringify({ session: "owner-token", from: "2026-10-01", to: "2026-10-19", tenantId: "acme" }),
      }),
      envFor(kv),
      "https://schedi.app",
      json,
      readSession,
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; total: number; days: Record<string, number>; partial: boolean; trackingStart: string };
    expect(body.ok).toBe(true);
    expect(body.trackingStart).toBe(PAGE_VISIT_TRACKING_START);
    expect(body.partial).toBe(true);
    expect(body.days).toEqual({ "2026-10-19": 4 });
    expect(body.total).toBe(4);
    expect(JSON.stringify(body)).not.toContain("100");

    const denied = await handlePageVisitsRequest(
      new Request("https://schedi.app/api/page-visits", {
        method: "POST",
        body: JSON.stringify({ session: "owner-token", from: "2026-10-19", to: "2026-10-19", tenantId: "other" }),
      }),
      envFor(kv),
      "https://schedi.app",
      json,
      readSession,
    );
    expect(denied.status).toBe(403);

    const agency = await handlePageVisitsRequest(
      new Request("https://schedi.app/api/page-visits", {
        method: "POST",
        body: JSON.stringify({ session: "agency-token", from: "2026-10-19", to: "2026-10-19", tenantId: "acme" }),
      }),
      envFor(kv),
      "https://schedi.app",
      json,
      readSession,
    );
    expect(agency.status).toBe(403);

    const anon = await handlePageVisitsRequest(
      new Request("https://schedi.app/api/page-visits", {
        method: "POST",
        body: JSON.stringify({ from: "2026-10-19", to: "2026-10-19" }),
      }),
      envFor(kv),
      "https://schedi.app",
      json,
      readSession,
    );
    expect(anon.status).toBe(401);

    const bad = await handlePageVisitsRequest(
      new Request("https://schedi.app/api/page-visits", {
        method: "POST",
        body: JSON.stringify({ session: "owner-token", from: "yesterday", to: "today" }),
      }),
      envFor(kv),
      "https://schedi.app",
      json,
      readSession,
    );
    expect(bad.status).toBe(400);
  });

  it("is mounted on the email worker for the owner and rejects other callers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("unexpected network");
    }));
    const { default: worker } = await import("../workers/schedi-email-worker/src/index.js");
    const kv = memoryKv({
      "session:owner-token": JSON.stringify({ role: "owner", email: "owner@example.com", tenantId: "acme", exp: EXP }),
      "session:agency-token": JSON.stringify({ role: "agency", email: "hq@example.com", exp: EXP }),
      "pv1:acme:2026-10-19:isoa": "2",
    });
    const env = { AUTH_KV: kv, AUTH_PEPPER: "test-pepper", FIREBASE_PROJECT_ID: "siteforge-97699" };
    const owner = await worker.fetch(
      new Request("https://schedi.app/api/page-visits", {
        method: "POST",
        headers: { Origin: "https://schedi.app", "Content-Type": "application/json" },
        body: JSON.stringify({ session: "owner-token", from: "2026-10-19", to: "2026-10-19" }),
      }),
      env,
      {},
    );
    expect(owner.status).toBe(200);
    const payload = (await owner.json()) as { total: number; days: Record<string, number> };
    expect(payload.total).toBe(2);
    expect(payload.days).toEqual({ "2026-10-19": 2 });

    const agency = await worker.fetch(
      new Request("https://schedi.app/api/page-visits", {
        method: "POST",
        headers: { Origin: "https://schedi.app", "Content-Type": "application/json" },
        body: JSON.stringify({ session: "agency-token", from: "2026-10-19", to: "2026-10-19" }),
      }),
      env,
      {},
    );
    expect(agency.status).toBe(403);

    const options = await worker.fetch(
      new Request("https://schedi.app/api/page-visits", { method: "OPTIONS", headers: { Origin: "https://schedi.app" } }),
      env,
      {},
    );
    expect(options.status).toBe(204);
  });
});
