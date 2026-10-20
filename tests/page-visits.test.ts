import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, type SchediEnv } from "../worker/handler";
import {
  handlePageVisitsRequest,
  isBotUserAgent,
  noteBookingVisit,
  PAGE_VISIT_TRACKING_START,
  PAGE_VISITS_DATASET,
  PageVisitQueryError,
  readBookingVisits,
  shouldCountBookingVisit,
  visitDay,
  type PageVisitDataset,
  type VisitRequest,
} from "../worker/page-visits";

const SHELL = "<!DOCTYPE html><html><head><title>Schedi</title></head><body>app</body></html>";
const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const EXP = Date.now() + 60 * 60 * 1000;
const ACCOUNT = "a".repeat(32);

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
  };
}

function dataset(): PageVisitDataset & { points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> } {
  const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
  return {
    points,
    writeDataPoint(point) {
      points.push(point);
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
      if (path === "/index.html" || path === "/booking.html") {
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

describe("analytics engine writes", () => {
  it("writes one point per view and keeps only the slug and day", () => {
    const visits = dataset();
    noteBookingVisit(visits, "bright-cuts", "2026-10-19");
    noteBookingVisit(visits, "bright-cuts", "2026-10-19");
    noteBookingVisit(visits, "bright-cuts", "2026-10-20");
    expect(visits.points).toEqual([
      { indexes: ["bright-cuts"], blobs: ["bright-cuts", "2026-10-19"], doubles: [1] },
      { indexes: ["bright-cuts"], blobs: ["bright-cuts", "2026-10-19"], doubles: [1] },
      { indexes: ["bright-cuts"], blobs: ["bright-cuts", "2026-10-20"], doubles: [1] },
    ]);
    const dumped = JSON.stringify(visits.points);
    expect(dumped).not.toMatch(/mozilla|cookie|203\.0\.113|@/i);
    noteBookingVisit(visits, "../other", "2026-10-19");
    noteBookingVisit(visits, "bright-cuts", "2026-10-18");
    expect(visits.points).toHaveLength(3);
  });

  it("keeps accepting views after a write throws", () => {
    const points: unknown[] = [];
    let failed = false;
    const visits: PageVisitDataset = {
      writeDataPoint(point) {
        if (!failed) {
          failed = true;
          throw new Error("binding rejected the point");
        }
        points.push(point);
      },
    };
    const timers = vi.spyOn(globalThis, "setTimeout");
    noteBookingVisit(visits, "bright-cuts", "2026-10-19");
    noteBookingVisit(visits, "bright-cuts", "2026-10-19");
    expect(points).toHaveLength(1);
    expect(timers).not.toHaveBeenCalled();
  });

  it("sums the SQL sample interval for that business only", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sql = String(init?.body || "");
      expect(sql).toContain("FROM " + PAGE_VISITS_DATASET);
      expect(sql).toContain("SUM(_sample_interval)");
      expect(sql).toContain("blob1 = 'bright-cuts'");
      expect(sql).toContain("blob2 >= '2026-10-19'");
      expect(sql).toContain("blob2 <= '2026-10-19'");
      expect(sql).toContain("timestamp >= toDateTime('2026-10-17 00:00:00')");
      expect(sql).not.toContain("other-shop");
      return new Response(
        JSON.stringify({ data: [{ day: "2026-10-19", visits: "5" }, { day: "2026-10-18", visits: 9 }] }),
        { status: 200 },
      );
    });
    const days = await readBookingVisits(
      { CF_ACCOUNT_ID: ACCOUNT, ANALYTICS_API_TOKEN: "test-token" },
      "bright-cuts",
      "2026-10-19",
      "2026-10-19",
      fetchImpl as typeof fetch,
    );
    expect(days).toEqual({ "2026-10-19": 5 });
  });

  it("treats a missing dataset as zero and a bad token as unconfigured", async () => {
    const missing = vi.fn(async () => new Response("dataset does not exist", { status: 404 }));
    await expect(
      readBookingVisits(
        { CF_ACCOUNT_ID: ACCOUNT, ANALYTICS_API_TOKEN: "test-token" },
        "bright-cuts",
        "2026-10-19",
        "2026-10-20",
        missing as typeof fetch,
      ),
    ).resolves.toEqual({});

    const outage = vi.fn(async () => new Response("unknown error while reading dataset", { status: 500 }));
    await expect(
      readBookingVisits(
        { CF_ACCOUNT_ID: ACCOUNT, ANALYTICS_API_TOKEN: "test-token" },
        "bright-cuts",
        "2026-10-19",
        "2026-10-20",
        outage as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "visits_unavailable" });

    const denied = vi.fn(async () => new Response("denied", { status: 403 }));
    await expect(
      readBookingVisits(
        { CF_ACCOUNT_ID: ACCOUNT, ANALYTICS_API_TOKEN: "test-token" },
        "bright-cuts",
        "2026-10-19",
        "2026-10-20",
        denied as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "visits_unconfigured" });
    await expect(readBookingVisits({}, "bright-cuts", "2026-10-19", "2026-10-20", denied as typeof fetch)).rejects.toBeInstanceOf(
      PageVisitQueryError,
    );
    expect(denied).toHaveBeenCalledTimes(1);
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

  async function serve(
    path: string,
    visits: ReturnType<typeof dataset>,
    init: RequestInit = {},
  ) {
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
      PAGE_VISITS: visits,
    };
    const headers = new Headers(init.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", CHROME);
    if (!headers.has("sec-fetch-dest")) headers.set("sec-fetch-dest", "document");
    if (!headers.has("sec-fetch-mode")) headers.set("sec-fetch-mode", "navigate");
    const response = await handleRequest(new Request("https://schedi.app" + path, { ...init, headers }), env, ctx);
    await response.arrayBuffer().catch(() => undefined);
    expect(ctx.pending).toEqual([]);
    return response;
  }

  it("counts real GETs of a published page and ignores bots, the owner portal, and assets", async () => {
    const visits = dataset();
    const day = visitDay(new Date(), "America/New_York");
    const first = await serve("/bright-cuts", visits, { headers: { referer: "https://www.google.com/search?q=secret-query" } });
    expect(first.status).toBe(200);
    await serve("/bright-cuts/", visits, { headers: { "x-forwarded-for": "203.0.113.8", "user-agent": CHROME + " UniqueBrowserToken" } });
    await serve("/bright-cuts", visits);
    expect(visits.points).toHaveLength(3);
    for (const point of visits.points) {
      expect(point.blobs).toEqual(["bright-cuts", day]);
      expect(point.doubles).toEqual([1]);
    }
    const dumped = JSON.stringify(visits.points);
    expect(dumped).not.toContain("UniqueBrowserToken");
    expect(dumped).not.toContain("203.0.113.8");
    expect(dumped).not.toContain("secret-query");
    expect(dumped).not.toContain("hidden@example.com");

    const before = visits.points.length;
    await serve("/bright-cuts", visits, { headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" } });
    await serve("/bright-cuts", visits, { headers: { referer: "https://schedi.app/login" } });
    await serve("/bright-cuts?demo=1", visits);
    await serve("/bright-cuts", visits, { headers: { "sec-purpose": "prefetch" } });
    await serve("/bright-cuts", visits, { method: "HEAD" });
    await serve("/bright-cuts/logo.png", visits);
    await serve("/bright-cuts/manage/abc", visits);
    await serve("/missing-shop", visits);
    expect(visits.points).toHaveLength(before);
  });
});

describe("owner page-visits API", () => {
  function json(body: unknown, status: number) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  function envFor(kv: ReturnType<typeof memoryKv>, extra: { CF_ACCOUNT_ID?: string; ANALYTICS_API_TOKEN?: string } = {}) {
    return {
      AUTH_KV: kv,
      AUTH_PEPPER: "test-pepper",
      CF_ACCOUNT_ID: ACCOUNT,
      ANALYTICS_API_TOKEN: "test-analytics-token",
      ...extra,
    };
  }

  it("returns only the signed-in owner's totals", async () => {
    const kv = memoryKv({
      "session:owner-token": JSON.stringify({ role: "owner", email: "owner@example.com", tenantId: "acme", exp: EXP }),
      "session:other-token": JSON.stringify({ role: "owner", email: "other@example.com", tenantId: "other", exp: EXP }),
      "session:agency-token": JSON.stringify({ role: "agency", email: "hq@example.com", exp: EXP }),
    });
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer test-analytics-token");
        expect(String(input)).toBe("https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT + "/analytics_engine/sql");
        const sql = String(init?.body || "");
        seen.push(sql);
        expect(sql).toContain("blob1 = 'acme'");
        expect(sql).not.toContain("other");
        return new Response(JSON.stringify({ data: [{ day: "2026-10-19", visits: 4 }, { day: "2026-10-18", visits: 9 }] }), {
          status: 200,
        });
      }),
    );
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
    expect(seen).toHaveLength(1);

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
    expect(seen).toHaveLength(1);

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

    const unconfigured = await handlePageVisitsRequest(
      new Request("https://schedi.app/api/page-visits", {
        method: "POST",
        body: JSON.stringify({ session: "owner-token", from: "2026-10-19", to: "2026-10-19" }),
      }),
      envFor(kv, { CF_ACCOUNT_ID: "", ANALYTICS_API_TOKEN: "" }),
      "https://schedi.app",
      json,
      readSession,
    );
    expect(unconfigured.status).toBe(503);
    const failure = (await unconfigured.json()) as { error?: string };
    expect(failure.error).toBe("visits_unconfigured");
    expect(JSON.stringify(failure)).not.toContain("test-analytics-token");
    expect(seen).toHaveLength(1);
  });

  it("is mounted on the email worker for the owner and rejects other callers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes("/analytics_engine/sql")) throw new Error("unexpected network " + url);
        expect(String(init?.body || "")).toContain("blob1 = 'acme'");
        return new Response(JSON.stringify({ data: [{ day: "2026-10-19", visits: 2 }] }), { status: 200 });
      }),
    );
    const { default: worker } = await import("../workers/schedi-email-worker/src/index.js");
    const kv = memoryKv({
      "session:owner-token": JSON.stringify({ role: "owner", email: "owner@example.com", tenantId: "acme", exp: EXP }),
      "session:agency-token": JSON.stringify({ role: "agency", email: "hq@example.com", exp: EXP }),
    });
    const env = {
      AUTH_KV: kv,
      AUTH_PEPPER: "test-pepper",
      FIREBASE_PROJECT_ID: "siteforge-97699",
      CF_ACCOUNT_ID: ACCOUNT,
      ANALYTICS_API_TOKEN: "test-analytics-token",
    };
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
