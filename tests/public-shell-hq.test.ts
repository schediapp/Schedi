import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { handleRequest, type SchediEnv } from "../worker/handler";
import { HQ_PUBLIC_MARKERS, shellHasHqMarkers } from "../worker/public-shell";

const publicHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hqHtml = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");

function ctx() {
  return { waitUntil() {} };
}

function assets(indexBody: string): SchediEnv["ASSETS"] {
  return {
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      if (path === "/index.html") {
        return new Response(indexBody, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (path === "/hq.html") {
        return new Response(hqHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    },
  };
}

function kv(entries: Record<string, string>) {
  const store = new Map(Object.entries(entries));
  return { get: async (key: string) => store.get(key) ?? null };
}

function env(indexBody: string, store?: Record<string, string>): SchediEnv {
  return {
    FIREBASE_PROJECT_ID: "siteforge-97699",
    ASSETS: assets(indexBody),
    AUTH_KV: store ? kv(store) : undefined,
  };
}

const exp = Date.now() + 60 * 60 * 1000;
const sessions = {
  "session:agency-token": JSON.stringify({ role: "agency", email: "hq@example.com", exp }),
  "session:owner-token": JSON.stringify({ role: "owner", email: "owner@example.com", tenantId: "acme", exp }),
  "session:expired-token": JSON.stringify({ role: "agency", email: "hq@example.com", exp: Date.now() - 1000 }),
};

function assertNoHq(html: string, where: string) {
  const marker = shellHasHqMarkers(html);
  expect(marker, where).toBeNull();
  for (const item of HQ_PUBLIC_MARKERS) expect(html, where).not.toContain(item);
}

describe("public booking HTML", () => {
  it("keeps HQ screens out of the committed public shell", () => {
    const viaSymlink = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
    expect(viaSymlink).toBe(publicHtml);
    assertNoHq(publicHtml, "index.html");
    expect(publicHtml).toContain("Business Owner Portal");
    expect(publicHtml).toContain("function generateStandaloneHtmlForTenant");
    expect(publicHtml).toContain("function ownerPlanActiveUntilText");
    expect(hqHtml).toContain('id="agencyHqSection"');
    expect(hqHtml).toContain("Agency HQ Master Login");
  });

  it.each(["/axeldelcidphotography", "/login", "/portal"])(
    "serves %s without HQ markers even if the asset still contains them",
    async (path) => {
      const response = await handleRequest(new Request("https://schedi.app" + path), env(hqHtml), ctx());
      expect(response.status).toBe(200);
      const html = await response.text();
      assertNoHq(html, path);
      expect(html).toContain("function hqSectionEl(){return null;}");
    },
  );

  it("serves the stripped shell for a public booking page", async () => {
    const response = await handleRequest(
      new Request("https://schedi.app/axeldelcidphotography"),
      env(publicHtml),
      ctx(),
    );
    expect(response.status).toBe(200);
    assertNoHq(await response.text(), "stripped asset");
  });
});

describe("HQ route", () => {
  it.each(["/hq", "/agency", "/hq-9h7p52"])("asks %s to sign in when there is no agency session", async (path) => {
    const response = await handleRequest(new Request("https://schedi.app" + path), env(hqHtml, sessions), ctx());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    const html = await response.text();
    expect(html).toContain("Schedi HQ");
    expect(html).toContain("/auth/agency");
    assertNoHq(html, path);
  });

  it("returns the full HQ shell for an agency session", async () => {
    const response = await handleRequest(
      new Request("https://schedi.app/hq", { headers: { Cookie: "schedi_hq=agency-token" } }),
      env(publicHtml, sessions),
      ctx(),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="agencyHqSection"');
    expect(html).toContain("Agency HQ Master Login");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("does not treat an owner session or an expired agency session as HQ", async () => {
    for (const cookie of ["schedi_hq=owner-token", "schedi_hq=expired-token", "schedi_hq=missing"]) {
      const response = await handleRequest(
        new Request("https://schedi.app/hq", { headers: { Cookie: cookie } }),
        env(hqHtml, sessions),
        ctx(),
      );
      const html = await response.text();
      assertNoHq(html, cookie);
      expect(html).not.toContain('id="agencyHqSection"');
    }
  });

  it("fails closed when session storage is not bound", async () => {
    const response = await handleRequest(
      new Request("https://schedi.app/hq", { headers: { "X-Schedi-Session": "agency-token" } }),
      env(hqHtml),
      ctx(),
    );
    assertNoHq(await response.text(), "no kv");
  });

  it("serves the HQ shell for demo preview without a session and still asks for sign-in otherwise", async () => {
    const demo = await handleRequest(new Request("https://schedi-dashboard-preview.axl199.workers.dev/hq?demo=1&newhq=1"), env(hqHtml), ctx());
    expect(demo.status).toBe(200);
    const html = await demo.text();
    expect(html).toContain('id="agencyHqSection"');
    expect(html).toContain("window.__SCHEDI_HQ_DEMO");
    expect(html).toContain("schedi-newhq");
    expect(html).not.toContain("schediNewHq");
    expect(html).toContain("Agency HQ Master Login");
    const plain = await handleRequest(new Request("https://schedi.app/hq?demo=0"), env(hqHtml), ctx());
    assertNoHq(await plain.text(), "demo off");
    const production = await handleRequest(new Request("https://schedi.app/hq?demo=1"), env(hqHtml), ctx());
    assertNoHq(await production.text(), "production demo");
  });

  it("blocks live calls in HQ demo and keeps the new frame off unless the query asks for it", async () => {
    const boot = hqHtml.slice(hqHtml.indexOf("<script>"), hqHtml.indexOf("</script>") + 9);
    expect(boot).not.toContain("localStorage");
    const calls: string[] = [];
    const classes: string[] = [];
    const context = {
      window: {} as Record<string, unknown>,
      location: { search: "?newhq=1&demo=1", hostname: "schedi-dashboard-preview.axl199.workers.dev" },
      URLSearchParams,
      document: { documentElement: { classList: { add(name: string) { classes.push(name); } } } },
      navigator: { sendBeacon(url: string) { calls.push("BEACON " + url); return true; } },
      Response,
      Promise,
      fetch: async (input: unknown) => {
        calls.push("FETCH " + String(input));
        return new Response("upstream");
      },
    };
    context.window = context as unknown as Record<string, unknown>;
    runInNewContext(boot.replace(/^<script>/, "").replace(/<\/script>$/, ""), context, { filename: "hq-demo-boot.js" });
    const guarded = context.window.fetch as (input: string, init?: { method?: string }) => Promise<Response>;
    const blocked = await guarded("https://schedi.app/api/ops-snapshot", { method: "POST" });
    expect(blocked.status).toBe(403);
    expect(calls).toEqual([]);
    expect((context.window.__schediHqDemoBlocked as { url: string }[])[0].url).toContain("/api/ops-snapshot");
    expect(classes).toEqual(["schedi-newhq", "schedi-hq-demo"]);
    const beacon = context.navigator.sendBeacon as (url: string) => boolean;
    expect(beacon("https://schedi.app/api/profile")).toBe(true);
    expect(calls).toEqual([]);

    const off: string[] = [];
    const quiet = {
      window: {} as Record<string, unknown>,
      location: { search: "?demo=1", hostname: "127.0.0.1" },
      URLSearchParams,
      document: { documentElement: { classList: { add(name: string) { off.push(name); } } } },
      navigator: {},
      Response,
      Promise,
    };
    quiet.window = quiet as unknown as Record<string, unknown>;
    runInNewContext(boot.replace(/^<script>/, "").replace(/<\/script>$/, ""), quiet, { filename: "hq-demo-off.js" });
    expect(off).toEqual(["schedi-hq-demo"]);
    expect(quiet.window.__SCHEDI_HQ_DEMO).toBe(true);

    const live: string[] = [];
    const production = {
      window: {} as Record<string, unknown>,
      location: { search: "?newhq=1&demo=1", hostname: "schedi.app" },
      URLSearchParams,
      document: { documentElement: { classList: { add(name: string) { live.push(name); } } } },
      navigator: {},
      Response,
      Promise,
      fetch: async () => new Response("upstream"),
    };
    production.window = production as unknown as Record<string, unknown>;
    runInNewContext(boot.replace(/^<script>/, "").replace(/<\/script>$/, ""), production, { filename: "hq-demo-live.js" });
    expect(live).toEqual(["schedi-newhq"]);
    expect(production.window.__SCHEDI_HQ_DEMO).toBeUndefined();
    expect(production.window.fetch).toBe(production.fetch);
  });

  it("does not serve the HQ document as a static HTML file", async () => {
    const response = await handleRequest(new Request("https://schedi.app/hq.html"), env(hqHtml, sessions), ctx());
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("agencyHqSection");
  });
});
