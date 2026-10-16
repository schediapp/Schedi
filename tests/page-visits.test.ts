import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  bucketSource,
  botSignal,
  classifyBrowser,
  classifyDevice,
  fillSeries,
  handlePageVisits,
  isLikelyBot,
  visitTenantExists,
} from "../workers/schedi-email-worker/src/page-visits.js";
// @ts-expect-error plain JS worker module
import worker from "../workers/schedi-email-worker/src/index.js";

const NOW = new Date("2026-10-16T15:00:00.000Z");
const EXP = Date.now() + 60 * 60 * 1000;
const TOKEN = "ops-snapshot-token-0123456789abcdef";

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, String(value));
    }),
  };
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function baseEnv(extra: Record<string, unknown> = {}) {
  const points: Array<{ indexes: string[]; blobs: string[]; doubles: number[] }> = [];
  const queries: Array<{ query: string; params: Record<string, string> }> = [];
  const kv = memoryKv({
    "session:owner-token": JSON.stringify({ role: "owner", tenantId: "acme", email: "owner@example.com", exp: EXP }),
    "session:agency-token": JSON.stringify({ role: "agency", email: "hq@example.com", exp: EXP }),
  });
  const env = {
    AUTH_KV: kv,
    OPS_SNAPSHOT_TOKEN: TOKEN,
    PAGE_VISITS: {
      writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }) {
        points.push(point);
      },
    },
    ANALYTICS_SQL: {
      query: vi.fn(async ({ query, params }: { query: string; params: Record<string, string> }) => {
        queries.push({ query, params });
        if (query.includes("index1 AS tenantId")) {
          return { data: [{ tenantId: "acme", views: 5, uniques: 3 }, { tenantId: "lumen", views: 2, uniques: 1 }] };
        }
        if (query.includes("AS day")) return { data: [{ day: "2026-10-16", views: 4, uniques: 2 }] };
        if (query.includes("AS city")) return { data: [{ city: "Austin", region: "Texas", country: "US", views: 4 }] };
        if (query.includes("blob7")) return { data: [{ label: "Instagram", views: 3 }, { label: "QR", views: 1 }] };
        if (query.includes("blob5")) return { data: [{ label: "mobile", views: 4 }] };
        if (query.includes("blob6")) return { data: [{ label: "Safari", views: 4 }] };
        return { data: [] };
      }),
    },
    ...extra,
  };
  return { env, points, queries, kv };
}

function deps() {
  return {
    json,
    isAllowedOrigin: () => true,
    tenantExists: async (id: string) => id === "acme",
    now: () => NOW,
  };
}

function post(body: Record<string, unknown>, headers: Record<string, string> = {}, cf?: Record<string, unknown>) {
  const req = new Request("https://schedi.app/api/page-visits", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://schedi.app",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
      "CF-Connecting-IP": "203.0.113.8",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (cf) Object.defineProperty(req, "cf", { value: cf });
  return req;
}

describe("visit classification", () => {
  it("skips obvious bots and empty user agents", () => {
    expect(isLikelyBot("")).toBe(true);
    expect(isLikelyBot("facebookexternalhit/1.1")).toBe(true);
    expect(isLikelyBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1")).toBe(false);
  });

  it("uses Cloudflare bot signals when they are present", () => {
    const human = new Request("https://schedi.app/");
    expect(botSignal(human)).toBe("");
    const verified = new Request("https://schedi.app/");
    Object.defineProperty(verified, "cf", { value: { botManagement: { verifiedBot: true, score: 99 } } });
    expect(botSignal(verified)).toBe("verified_bot");
    const scored = new Request("https://schedi.app/");
    Object.defineProperty(scored, "cf", { value: { botManagement: { score: 2 } } });
    expect(botSignal(scored)).toBe("bot_score");
  });

  it("buckets source, device, and browser without keeping the raw referrer", () => {
    expect(bucketSource({ src: "qr", refHost: "l.instagram.com", userAgent: "Instagram" })).toBe("QR");
    expect(bucketSource({ utmSource: "instagram" })).toBe("Instagram");
    expect(bucketSource({ refHost: "m.facebook.com" })).toBe("Facebook");
    expect(bucketSource({ refHost: "www.google.com" })).toBe("Google");
    expect(bucketSource({ refHost: "vm.tiktok.com" })).toBe("TikTok");
    expect(bucketSource({ refHost: "example.com" })).toBe("other");
    expect(bucketSource({ refHost: "schedi.app" })).toBe("direct");
    expect(bucketSource({})).toBe("direct");
    expect(bucketSource({ userAgent: "Mozilla/5.0 Instagram" })).toBe("Instagram");
    expect(classifyDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)")).toBe("mobile");
    expect(classifyDevice("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)")).toBe("tablet");
    expect(classifyBrowser("Mozilla/5.0 Version/17.5 Mobile/15E148 Safari/604.1")).toBe("Safari");
    expect(classifyBrowser("Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36")).toBe("Chrome");
  });

  it("fills missing days with zeros", () => {
    const series = fillSeries("2026-10-14", "2026-10-16", [{ day: "2026-10-16", views: 4, uniques: 2 }]);
    expect(series.map((row) => row.views)).toEqual([0, 0, 4]);
    expect(series[2].uniques).toBe(2);
  });
});

describe("page visit beacon", () => {
  it("counts a view and a daily unique without storing the ip, user agent, or hash", async () => {
    const { env, points, kv } = baseEnv();
    const first = await handlePageVisits(post({
      tenantId: "acme",
      src: "qr",
      utmSource: "ignored-once-qr",
      refHost: "l.instagram.com",
      email: "visitor@example.com",
    }, {}, { country: "US", region: "Texas", city: "Austin" }), env, "https://schedi.app", deps());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(first.headers.get("set-cookie")).toBeNull();

    const second = await handlePageVisits(post({ tenantId: "acme", src: "qr" }, {}, { country: "US", region: "Texas", city: "Austin" }), env, "https://schedi.app", deps());
    expect(second.status).toBe(200);
    expect(points).toHaveLength(2);
    expect(points[0].indexes).toEqual(["acme"]);
    expect(points[0].blobs).toEqual(["2026-10-16", "US", "Texas", "Austin", "mobile", "Safari", "QR"]);
    expect(points[0].doubles).toEqual([1, 1]);
    expect(points[1].doubles).toEqual([1, 0]);
    const seen = [...kv.store.keys()].filter((key) => key.startsWith("visitSeen:"));
    expect(seen).toHaveLength(1);
    const hash = seen[0].split(":").pop() || "";
    expect(hash.length).toBeGreaterThan(8);
    const stored = JSON.stringify(points);
    expect(stored).not.toContain("203.0.113.8");
    expect(stored).not.toContain(hash);
    expect(stored).not.toContain("visitor@example.com");
    expect(stored).not.toContain("iPhone");
  });

  it("skips bots, sessions, preview, and unknown businesses", async () => {
    const { env, points } = baseEnv();
    const bot = await handlePageVisits(post({ tenantId: "acme" }, { "User-Agent": "facebookexternalhit/1.1" }), env, "https://schedi.app", deps());
    expect(await bot.json()).toEqual({ ok: true, skipped: "bot" });
    const verified = post({ tenantId: "acme" }, {}, { botManagement: { verifiedBot: true, score: 99 }, country: "US" });
    const cfBot = await handlePageVisits(verified, env, "https://schedi.app", deps());
    expect(await cfBot.json()).toEqual({ ok: true, skipped: "bot" });
    const session = await handlePageVisits(post({ tenantId: "acme", session: "owner-token" }), env, "https://schedi.app", deps());
    expect(await session.json()).toEqual({ ok: true, skipped: "session" });
    const preview = await handlePageVisits(post({ tenantId: "acme", preview: true }), env, "https://schedi.app", deps());
    expect(await preview.json()).toEqual({ ok: true, skipped: "preview" });
    const demo = await handlePageVisits(post({ tenantId: "acme" }, { Referer: "https://schedi.app/portal-preview?demo=1" }), env, "https://schedi.app", deps());
    expect(await demo.json()).toEqual({ ok: true, skipped: "preview" });
    const missing = await handlePageVisits(post({ tenantId: "missing" }), env, "https://schedi.app", deps());
    expect(missing.status).toBe(404);
    expect(points).toHaveLength(0);
  });

  it("does not write when Analytics Engine is not bound", async () => {
    const { env } = baseEnv();
    const bare = { ...env, PAGE_VISITS: undefined };
    const res = await handlePageVisits(post({ tenantId: "acme" }), bare, "https://schedi.app", deps());
    expect(await res.json()).toEqual({ ok: true, skipped: "unconfigured" });
  });
});

describe("page visit reads", () => {
  it("returns the owner's 7, 30, or 90 day report and refuses another business", async () => {
    const { env, queries } = baseEnv();
    const res = await handlePageVisits(post({ action: "read", session: "owner-token", days: 7, tenantId: "acme" }), env, "https://schedi.app", deps());
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; tenantId: string; views: number; uniques: number; series: Array<{ views: number }>; locations: unknown[]; sources: unknown[] };
    expect(data.ok).toBe(true);
    expect(data.tenantId).toBe("acme");
    expect(data.views).toBe(4);
    expect(data.uniques).toBe(2);
    expect(data.series).toHaveLength(7);
    expect(data.locations).toEqual([{ city: "Austin", region: "Texas", country: "US", views: 4 }]);
    expect(data.sources).toEqual([{ label: "Instagram", views: 3 }, { label: "QR", views: 1 }]);
    expect(queries[0].params.tenant).toBe("acme");
    expect(JSON.stringify(queries)).not.toContain("203.0.113.8");

    const other = await handlePageVisits(post({ action: "read", session: "owner-token", days: 30, tenantId: "lumen" }), env, "https://schedi.app", deps());
    expect(other.status).toBe(403);
    const bad = await handlePageVisits(post({ action: "read", session: "owner-token", days: 14 }), env, "https://schedi.app", deps());
    expect(bad.status).toBe(400);
    const anon = await handlePageVisits(post({ action: "read", days: 7 }), env, "https://schedi.app", deps());
    expect(anon.status).toBe(401);
  });

  it("lets an agency session or the ops bearer read every business, and refuses an owner", async () => {
    const { env } = baseEnv();
    const agency = await handlePageVisits(post({ action: "agency", session: "agency-token", days: 30 }), env, "https://schedi.app", deps());
    expect(agency.status).toBe(200);
    const agencyBody = await agency.json() as { businesses: Array<{ tenantId: string; views: number }> };
    expect(agencyBody.businesses.map((row) => row.tenantId)).toEqual(["acme", "lumen"]);

    const bearer = new Request("https://schedi.app/api/page-visits?scope=agency&days=7", {
      headers: { Authorization: "Bearer " + TOKEN, Origin: "https://schedi.app" },
    });
    const byToken = await handlePageVisits(bearer, env, "https://schedi.app", deps());
    expect(byToken.status).toBe(200);

    const owner = await handlePageVisits(post({ action: "agency", session: "owner-token", days: 30 }), env, "https://schedi.app", deps());
    expect(owner.status).toBe(403);
    const none = await handlePageVisits(post({ action: "agency", days: 30 }), env, "https://schedi.app", deps());
    expect(none.status).toBe(401);
  });

  it("reports that reads are not configured until the SQL binding exists", async () => {
    const { env } = baseEnv();
    const bare = { ...env, ANALYTICS_SQL: undefined };
    const res = await handlePageVisits(post({ action: "read", session: "owner-token", days: 30 }), bare, "https://schedi.app", deps());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "visits_unconfigured" });
  });
});

describe("page visit route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is served by the email worker and checks the business before writing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes("identitytoolkit")) return new Response(JSON.stringify({ idToken: "tok" }), { status: 200 });
      if (target.includes("/tenants/acme")) return new Response(JSON.stringify({ fields: { name: { stringValue: "Acme" } } }), { status: 200 });
      if (target.includes("/tenants/missing")) return new Response("nope", { status: 404 });
      throw new Error("unexpected " + target);
    }));
    const { env, points } = baseEnv({
      FIREBASE_API_KEY: "test-key",
      FIREBASE_PROJECT_ID: "siteforge-97699",
      FIREBASE_APP_ID: "siteforge-97699",
    });
    const ok = await worker.fetch(post({ tenantId: "acme", refHost: "instagram.com" }, {}, { country: "US", city: "Austin", region: "Texas" }), env, {});
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(points[0].blobs[6]).toBe("Instagram");
    const cached = await worker.fetch(post({ tenantId: "acme" }), env, {});
    expect(cached.status).toBe(200);
    const lookup = vi.mocked(fetch).mock.calls.filter((call) => String(call[0]).includes("/tenants/acme"));
    expect(lookup).toHaveLength(1);

    const missing = await worker.fetch(post({ tenantId: "missing" }), env, {});
    expect(missing.status).toBe(404);
    const again = await visitTenantExists(env, "missing");
    expect(again).toBe(false);
  });
});

describe("visit UI wiring", () => {
  const portal = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");

  it("beacons from the public booking page and stays quiet for owners, agencies, and preview", () => {
    const beaconAt = portal.indexOf("function schediVisitBeaconHtml");
    expect(beaconAt).toBeGreaterThan(0);
    const beacon = portal.slice(beaconAt, portal.indexOf("function generateStandaloneHtmlForTenant", beaconAt));
    expect(beacon).toContain('credentials:"same-origin"');
    expect(beacon).toContain('meta.role==="owner"');
    expect(beacon).toContain('meta.role==="agency"');
    expect(beacon).toContain("__SCHEDI_DEMO");
    expect(beacon).toContain("livePreviewIframe");
    expect(portal).toContain("countVisits: false");
    expect(portal).toContain("https://schedi.app/api/page-visits");
  });

  it("loads owner visits in Reports and uses sample data in demo without calling the API", () => {
    const start = portal.indexOf("function pageVisitEnsure");
    const fetchAt = portal.indexOf("api/page-visits", start);
    const demoAt = portal.indexOf("__SCHEDI_DEMO", start);
    expect(demoAt).toBeGreaterThan(start);
    expect(demoAt).toBeLessThan(fetchAt);
    expect(portal).toContain('id="tenantVisitReport"');
    expect(portal).toContain("Top locations");
    expect(portal).toContain("Top sources");
    expect(portal).toContain(">Devices<");
    expect(portal).toContain("sd-spark");
  });

  it("shows a visits column and total in Agency HQ, with sample rows in demo", () => {
    expect(hq).toContain('id="statPageVisits"');
    expect(hq).toContain("hq-col-visits");
    expect(hq).toContain("Page visits · 30 days");
    expect(hq).toContain("'harbor-demo': { views: 312, uniques: 198 }");
    const start = hq.indexOf("function hqEnsurePageVisits");
    const fetchAt = hq.indexOf("api/page-visits", start);
    const demoAt = hq.indexOf("__SCHEDI_HQ_DEMO", start);
    expect(demoAt).toBeGreaterThan(start);
    expect(demoAt).toBeLessThan(fetchAt);
    expect(hq.slice(start, start + 1600)).toContain("action: 'agency'");
  });
});
