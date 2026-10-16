import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eachDay, handlePageVisits, isLikelyBot, utcDay, visitKey } from "../workers/schedi-email-worker/src/page-visits.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const worker = readFileSync(new URL("../workers/schedi-email-worker/src/index.js", import.meta.url), "utf8");
const source = readFileSync(new URL("../workers/schedi-email-worker/src/page-visits.js", import.meta.url), "utf8");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://schedi.app" },
  });
}

function memoryKv() {
  const data = new Map<string, string>();
  const puts: { key: string; value: string }[] = [];
  return {
    data,
    puts,
    async get(key: string) { return data.has(key) ? data.get(key)! : null; },
    async put(key: string, value: string) {
      data.set(key, String(value));
      puts.push({ key, value: String(value) });
    },
  };
}

function request(method: string, body: unknown, headers: Record<string, string> = {}, query = "") {
  const seen: string[] = [];
  const bag = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    seen,
    req: new Request("https://schedi.app/api/page-visits" + query, {
      method,
      headers: new Headers(headers),
      body: method === "POST" ? JSON.stringify(body || {}) : undefined,
    }),
    spyHeaders(req: Request) {
      const inner = req.headers;
      return new Proxy(req, {
        get(target, prop, receiver) {
          if (prop === "headers") {
            return {
              get(name: string) {
                seen.push(name);
                return inner.get(name);
              },
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Request;
    },
    bag,
  };
}

const owner = { role: "owner", tenantId: "harbor" };
const browser = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

function deps(overrides: Record<string, unknown> = {}) {
  return {
    json,
    isAllowedOrigin: () => true,
    readSession: async () => null,
    rateLimitOk: async () => true,
    tenantExists: async () => true,
    now: () => new Date("2026-10-16T15:00:00Z"),
    ...overrides,
  };
}

describe("page visit counter", () => {
  it("treats empty and obvious crawler agents as bots and leaves a normal browser alone", () => {
    expect(isLikelyBot("")).toBe(true);
    expect(isLikelyBot("curl/8.0")).toBe(true);
    expect(isLikelyBot("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
    expect(isLikelyBot(browser)).toBe(false);
  });

  it("counts one visit per call and stores only the integer", async () => {
    const kv = memoryKv();
    const ip = "203.0.113.9";
    const made = request("POST", { tenantId: "harbor" }, {
      "User-Agent": browser,
      "CF-Connecting-IP": ip,
      Cookie: "session=secret",
    });
    const res = await handlePageVisits(made.spyHeaders(made.req), { AUTH_KV: kv }, "https://schedi.app", deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
    expect(kv.puts).toEqual([{ key: visitKey("harbor", "2026-10-16"), value: "1" }]);
    expect(kv.puts[0].value).not.toContain(ip);
    expect(made.seen.map((name) => name.toLowerCase())).not.toContain("cf-connecting-ip");
    expect(made.seen.map((name) => name.toLowerCase())).not.toContain("cookie");
    const again = request("POST", { tenantId: "harbor" }, { "User-Agent": browser });
    await handlePageVisits(again.req, { AUTH_KV: kv }, "https://schedi.app", deps());
    expect(kv.data.get(visitKey("harbor", "2026-10-16"))).toBe("2");
  });

  it("skips bots, unknown tenants, and limited callers without writing", async () => {
    const kv = memoryKv();
    const looked: string[] = [];
    const bot = request("POST", { tenantId: "harbor" }, { "User-Agent": "curl/8.0" });
    const skipped = await handlePageVisits(bot.req, { AUTH_KV: kv }, "https://schedi.app", deps({
      tenantExists: async (id: string) => { looked.push(id); return true; },
    }));
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toEqual({ ok: true, skipped: "bot" });
    expect(looked).toEqual([]);
    expect(kv.puts).toEqual([]);

    const missing = request("POST", { tenantId: "nope" }, { "User-Agent": browser });
    const notFound = await handlePageVisits(missing.req, { AUTH_KV: kv }, "https://schedi.app", deps({
      tenantExists: async () => false,
    }));
    expect(notFound.status).toBe(404);
    expect(kv.puts).toEqual([]);

    const limited = request("POST", { tenantId: "harbor" }, { "User-Agent": browser });
    const blocked = await handlePageVisits(limited.req, { AUTH_KV: kv }, "https://schedi.app", deps({
      rateLimitOk: async () => false,
    }));
    expect(blocked.status).toBe(429);
    expect(kv.puts).toEqual([]);
    const bad = await handlePageVisits(request("POST", { tenantId: "bad id!" }, { "User-Agent": browser }).req, { AUTH_KV: kv }, "https://schedi.app", deps());
    expect(bad.status).toBe(400);
  });

  it("lets the owner read the range and refuses everyone else", async () => {
    const kv = memoryKv();
    await kv.put(visitKey("harbor", "2026-10-15"), "4");
    await kv.put(visitKey("harbor", "2026-10-16"), "2");
    const open = request("GET", null, {}, "?from=2026-10-14&to=2026-10-16");
    expect((await handlePageVisits(open.req, { AUTH_KV: kv }, "https://schedi.app", deps())).status).toBe(401);

    const other = request("GET", null, { Authorization: "Bearer tok" }, "?from=2026-10-15&to=2026-10-16&tenantId=other");
    const forbidden = await handlePageVisits(other.req, { AUTH_KV: kv }, "https://schedi.app", deps({
      readSession: async () => owner,
    }));
    expect(forbidden.status).toBe(403);

    const own = request("POST", { action: "read", session: "tok", from: "2026-10-14", to: "2026-10-16" });
    const report = await handlePageVisits(own.req, { AUTH_KV: kv }, "https://schedi.app", deps({
      readSession: async (env: unknown, token: string) => (token === "tok" ? owner : null),
    }));
    expect(report.status).toBe(200);
    expect(report.headers.get("set-cookie")).toBeNull();
    expect(await report.json()).toEqual({
      ok: true,
      tenantId: "harbor",
      from: "2026-10-14",
      to: "2026-10-16",
      total: 6,
      days: [
        { date: "2026-10-14", count: 0 },
        { date: "2026-10-15", count: 4 },
        { date: "2026-10-16", count: 2 },
      ],
    });
  });

  it("is wired in the worker and not called from the booking page", () => {
    expect(eachDay("2026-10-01", "2026-10-03")).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(eachDay("2026-01-01", "2027-02-01")).toEqual([]);
    expect(utcDay(new Date("2026-10-16T03:30:00Z"))).toBe("2026-10-16");
    expect(worker).toContain("path === '/api/page-visits'");
    expect(worker).toContain("page_visits");
    expect(html).not.toContain("/api/page-visits");
    expect(source).toContain("keepalive:true");
    expect(source).not.toContain("CF-Connecting-IP");
  });
});
