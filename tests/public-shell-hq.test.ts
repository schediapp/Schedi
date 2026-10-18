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

  it("does not serve the HQ document as a static HTML file", async () => {
    const response = await handleRequest(new Request("https://schedi.app/hq.html"), env(hqHtml, sessions), ctx());
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("agencyHqSection");
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
    expect(hqHtml).toContain('onclick="loginAsTenantOwner(');
    expect(hqHtml).toContain(">Manage</button>");
    expect((hqHtml.match(/onclick="loginAsTenantOwner\(/g) || []).length).toBeGreaterThan(1);
  });
});
