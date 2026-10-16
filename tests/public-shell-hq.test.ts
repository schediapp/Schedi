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
    const hqCss = hqHtml.slice(hqHtml.indexOf("SCHEDI_HQ_START"), hqHtml.indexOf("SCHEDI_HQ_END"));
    expect(hqCss).toMatch(/\[data-hq-collapse-head\]\s*\{[^}]*flex-direction:\s*row/);
    expect(hqCss).toMatch(/\.hq-collapse-btn\s*\{[^}]*min-height:\s*44px/);
    expect(hqHtml.match(/data-hq-collapse-head>/g) || []).toHaveLength(3);
    expect(hqHtml).not.toContain("flex-col md:flex-row md:items-center justify-between gap-4\" data-hq-collapse-head");
    expect(hqHtml).toContain('id="hqGlanceCard"');
    expect(hqHtml).toContain(">At a glance<");
    expect(hqHtml).toContain('id="hqGlanceSummary"');
    expect(hqHtml).toContain('aria-controls="hqGlanceBody"');
    expect(hqHtml).toContain("schedi.hqGlanceOpen.v1");
    expect(hqHtml).toContain('id="statTotalSites"');
    expect(hqHtml).toContain('id="statAgencyMRR"');
    expect(hqHtml).toContain('id="statTotalBookings"');
    expect(hqHtml).toContain('id="statActivePages"');
    expect(hqCss).toContain(".hq-glance-body[hidden]");
    expect(hqCss).toContain(".hq-glance-summary[hidden]");
    expect(hqCss).toMatch(/@media \(min-width:\s*860px\)/);
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

  it("opens the new owner dashboard from Manage only behind the HQ preview flags", () => {
    function extractFunction(source: string, name: string) {
      const start = source.indexOf("function " + name);
      const brace = source.indexOf("{", start);
      let depth = 0;
      for (let i = brace; i < source.length; i++) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") {
          depth -= 1;
          if (depth === 0) return source.slice(start, i + 1);
        }
      }
      throw new Error("missing " + name);
    }
    const fn = extractFunction(hqHtml, "hqManagedPortalUrl");
    function portalUrl(input: { demo?: boolean; framed?: boolean; search?: string; tenant: { id?: string; slug?: string } | null }) {
      return runInNewContext(`${fn}\nhqManagedPortalUrl(tenant);`, {
        window: { __SCHEDI_HQ_DEMO: input.demo === true, location: { search: input.search || "" } },
        document: { documentElement: { classList: { contains: (name: string) => input.framed === true && name === "schedi-newhq" } } },
        URLSearchParams,
        tenant: input.tenant,
      }) as string;
    }
    const harbor = { id: "harbor-demo", slug: "harbor-demo" };
    expect(portalUrl({ tenant: harbor, search: "?booking=HB-1" })).toBe("");
    expect(portalUrl({
      demo: true,
      framed: true,
      search: "?newhq=1&demo=1&booking=HB-1006&date=2026-10-16&biz=somewhere&from=hq",
      tenant: harbor,
    })).toBe("/portal-preview?booking=HB-1006&date=2026-10-16&biz=harbor-demo&from=hq&tenant=harbor-demo&demo=1");
    expect(portalUrl({ demo: true, search: "?demo=1", tenant: { id: "northwind-demo", slug: "northwind-clinic" } }))
      .toBe("/portal-preview?biz=northwind-clinic&tenant=northwind-demo&demo=1");
    expect(portalUrl({
      framed: true,
      search: "?newhq=1&demo=1&booking=BK-9&appt=BK-9&ref=mail",
      tenant: { id: "lumen-demo", slug: "lumen-studio" },
    })).toBe("/?booking=BK-9&appt=BK-9&ref=mail&biz=lumen-studio&tenant=lumen-demo&newdash=1");
    const ownerStart = hqHtml.indexOf("window.loginAsTenantOwner = function");
    const owner = hqHtml.slice(ownerStart, hqHtml.indexOf("// SCHEDI_HQ_END", ownerStart));
    expect(owner.indexOf("hqManagedPortalUrl")).toBeGreaterThan(-1);
    expect(owner.indexOf("hqManagedPortalUrl")).toBeLessThan(owner.indexOf("switchPlatformMode('tenant')"));
    expect(owner).toContain("if (managedTenant) managedUrl = hqManagedPortalUrl(managedTenant)");
    expect(owner).toContain("window.location.assign(managedUrl)");
    expect(owner).toContain("ownerSelfSession = false");
    expect(hqHtml).toContain("window.loginAsTenantOwner(tenantId);");
    expect(hqHtml.match(/onclick="loginAsTenantOwner\(/g)).toHaveLength(2);
    expect(hqHtml.match(/>Manage<\/button>/g)).toHaveLength(2);
  });

  it("uses Harbor's portal sample, and the other HQ demo profiles when Manage asks for them", () => {
    function extractFunction(source: string, name: string) {
      const start = source.indexOf("function " + name);
      const brace = source.indexOf("{", start);
      let depth = 0;
      for (let i = brace; i < source.length; i++) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") {
          depth -= 1;
          if (depth === 0) return source.slice(start, i + 1);
        }
      }
      throw new Error("missing " + name);
    }
    const fn = `${extractFunction(publicHtml, "schediApplyDemoBiz")}\nschediApplyDemoBiz(tenant);`;
    function apply(search: string) {
      const tenant = { id: "harbor-demo", name: "Harbor Studio", slug: "harbor-demo", appointments: [{ id: "HB-1001" }], services: [{ id: 1 }] };
      return runInNewContext(fn, {
        window: { location: { search } },
        URLSearchParams,
        tenant,
      }) as { name: string; slug: string; appointments: unknown[]; services: unknown[] };
    }
    expect(apply("").name).toBe("Harbor Studio");
    expect(apply("?biz=harbor-demo").appointments).toHaveLength(1);
    const north = apply("?biz=northwind-clinic&tenant=northwind-demo");
    expect(north).toMatchObject({ name: "Northwind Clinic", slug: "northwind-clinic", appointments: [], services: [] });
    const lumen = apply("?tenant=lumen-demo");
    expect(lumen.name).toBe("Lumen Studio");
    expect(lumen.services).toHaveLength(1);
    expect(apply("?biz=someone-else").name).toBe("Harbor Studio");
    const boot = publicHtml.slice(publicHtml.indexOf("function bootSchediDemoPortal"), publicHtml.indexOf("function bootSchediDemoPortal") + 900);
    expect(boot).toContain("schediApplyDemoBiz(schediBuildDemoTenant())");
    expect(boot).toContain("tenant.id === 'harbor-demo' ? schediDemoClientRows() : []");
  });

  it("does not serve the HQ document as a static HTML file", async () => {
    const response = await handleRequest(new Request("https://schedi.app/hq.html"), env(hqHtml, sessions), ctx());
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("agencyHqSection");
  });
});
