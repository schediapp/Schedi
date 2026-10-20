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
      if (path === "/index.html" || path === "/booking.html") {
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
    expect(hqHtml).toContain('data-hq-collapse="directory"');
    expect(hqHtml).not.toContain("flex-col md:flex-row md:items-center justify-between gap-4\" data-hq-collapse-head");
    expect(hqHtml.indexOf('id="agencyBilling"')).toBeLessThan(hqHtml.indexOf('id="agencyDirectory"'));
    expect(hqHtml).toContain("function hqPrepareNewDirectory()");
    expect(hqHtml).toContain("html.schedi-newhq #agencyDirectory { order: 2; }");
    expect(hqHtml).toContain('id="hqGlanceCard"');
    expect(hqHtml).toContain(">At a glance<");
    expect(hqHtml).toContain('id="hqGlanceSummary"');
    expect(hqHtml).toContain('aria-controls="hqGlanceBody"');
    expect(hqHtml).toContain("schedi.hqGlanceOpen.v1");
    expect(hqHtml).toContain('id="statTotalSites"');
    expect(hqHtml).toContain('id="statAgencyMRR"');
    expect(hqHtml).toContain('id="statTotalBookings"');
    expect(hqHtml).toContain('id="statActivePages"');
    expect(hqHtml).toContain("function hqInitScrollSpy()");
    expect(hqHtml).toContain("new IntersectionObserver");
    expect(hqHtml).toContain("#agencyDirectory [data-hq-collapse-tools]");
    expect(hqHtml).toContain("#agencyDirectory #agencySearchInput");
    expect(hqCss).toContain(".hq-glance-body[hidden]");
    expect(hqCss).toContain(".hq-glance-summary[hidden]");
    expect(hqCss).toMatch(/@media \(min-width:\s*860px\)/);
  });

  it.each(["/axeldelcidphotography", "/login", "/portal?biz=harbor"])(
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

  it("blocks live calls in HQ demo, uses the new frame by default, and keeps classichq as the hatch", async () => {
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
      location: { search: "?classichq=1&demo=1", hostname: "127.0.0.1" },
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

    const plain: string[] = [];
    const preview = {
      window: {} as Record<string, unknown>,
      location: { search: "?demo=1", hostname: "127.0.0.1" },
      URLSearchParams,
      document: { documentElement: { classList: { add(name: string) { plain.push(name); } } } },
      navigator: {},
      Response,
      Promise,
    };
    preview.window = preview as unknown as Record<string, unknown>;
    runInNewContext(boot.replace(/^<script>/, "").replace(/<\/script>$/, ""), preview, { filename: "hq-demo-default.js" });
    expect(plain).toEqual(["schedi-newhq", "schedi-hq-demo"]);
    expect(preview.window.__SCHEDI_HQ_DEMO).toBe(true);

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

  it("opens the new owner dashboard from Manage when the HQ frame is on", () => {
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
    expect(portalUrl({ tenant: harbor, search: "?booking=HB-1&session=sekret" })).toBe("/login?tenant=harbor-demo&from=hq");
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
    })).toBe("/login?tenant=lumen-demo&from=hq");
    const ownerStart = hqHtml.indexOf("window.loginAsTenantOwner = function");
    const owner = hqHtml.slice(ownerStart, hqHtml.indexOf("// SCHEDI_HQ_END", ownerStart));
    expect(owner.indexOf("hqManagedPortalUrl")).toBeGreaterThan(-1);
    expect(owner.indexOf("hqManagedPortalUrl")).toBeLessThan(owner.indexOf("switchPlatformMode('tenant')"));
    expect(owner).toContain("if (managedTenant) managedUrl = hqManagedPortalUrl(managedTenant)");
    expect(owner).toContain("window.location.assign(managedUrl)");
    expect(owner).toContain("ownerSelfSession = false");
    expect(hqHtml).toContain("window.loginAsTenantOwner(tenantId);");
    expect(hqHtml.match(/onclick="loginAsTenantOwner\(/g)).toHaveLength(7);
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

  it("opens the new owner dashboard from Manage when the HQ frame is on", () => {
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
    expect(portalUrl({ tenant: harbor, search: "?booking=HB-1&session=sekret" })).toBe("/login?tenant=harbor-demo&from=hq");
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
    })).toBe("/login?tenant=lumen-demo&from=hq");
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

  it("sends Log in to portal to the new dashboard without a token in the URL", () => {
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
    function classList(initial: string[]) {
      const names = new Set(initial);
      return {
        add(name: string) { names.add(name); },
        remove(name: string) { names.delete(name); },
        contains(name: string) { return names.has(name); },
      };
    }
    const assigned: string[] = [];
    const toasts: string[] = [];
    const loginBox = { id: "tenantLoginBox", classList: classList([]) };
    const dashboard = { id: "tenantDashboard", classList: classList(["hidden"]) };
    const biz = { id: "lumen-studio", name: "Lumen Studio", slug: "lumen-studio", subscriptionStatus: "active" };
    const sandbox: Record<string, unknown> = {
      location: {
        search: "?booking=BK-9&session=sekret&token=abc",
        assign(url: string) { assigned.push(String(url)); },
      },
      scrollTo() {},
      document: {
        documentElement: { classList: classList(["schedi-newhq"]) },
        getElementById(id: string) {
          if (id === "tenantLoginBox") return loginBox;
          if (id === "tenantDashboard") return dashboard;
          return null;
        },
      },
      URLSearchParams,
      platformState: {
        tenants: [biz],
        activeTenantId: "",
        isTenantOwnerLoggedIn: false,
        isAgencyMasterLoggedIn: true,
        ownerSelfSession: true,
      },
      biz,
      syncOwnerChangePassBtn() {},
      populateTenantSelect() {},
      updateLivePreviewControlsVisibility() {},
      switchPlatformMode() {},
      syncHqManagingBanner() {},
      getTenant(id?: string) {
        const state = sandbox.platformState as { tenants: typeof biz[]; activeTenantId: string };
        const want = id || state.activeTenantId;
        return state.tenants.find((row) => row.id === want) || state.tenants[0];
      },
      showToast(message: string) { toasts.push(String(message)); },
      hqHealthOf() { return {}; },
      hqDashShortDate() { return ""; },
      hqWarnings() { return [] as string[]; },
      isComplimentaryPro() { return false; },
      hqDashPlanPill() { return ""; },
      hqDashStatusPill() { return ""; },
      hqDashMenu() { return ""; },
      hqDashLiveRow() { return ""; },
    };
    sandbox.window = sandbox;
    const ownerStart = hqHtml.indexOf("window.loginAsTenantOwner = function");
    const owner = hqHtml.slice(ownerStart, hqHtml.indexOf("// SCHEDI_HQ_END", ownerStart));
    runInNewContext(
      [
        extractFunction(hqHtml, "esc"),
        extractFunction(hqHtml, "jsArg"),
        extractFunction(hqHtml, "hqManagedPortalUrl"),
        extractFunction(hqHtml, "hqCountsPhase"),
        extractFunction(hqHtml, "hqCountsHoldHtml"),
        extractFunction(hqHtml, "hqActivityNumbers"),
        extractFunction(hqHtml, "hqDashBizCard"),
        owner,
      ].join("\n"),
      sandbox,
      { filename: "hq-login-portal.js" },
    );
    const markup = runInNewContext("hqDashBizCard(biz);", sandbox, { filename: "hq-login-card.js" }) as string;
    const buttons: { onclick: string; text: string }[] = [];
    const buttonRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
    for (let match = buttonRe.exec(markup); match; match = buttonRe.exec(markup)) {
      const onclick = /onclick="([^"]*)"/.exec(match[1]);
      buttons.push({
        onclick: onclick ? onclick[1] : "",
        text: match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
      });
    }
    const portalButton = buttons.find((button) => button.text === "Log in to portal");
    expect(portalButton?.onclick).toBe("loginAsTenantOwner('lumen-studio')");
    runInNewContext(portalButton?.onclick || "", sandbox, { filename: "hq-login-click.js" });
    expect(assigned).toEqual(["/login?tenant=lumen-studio&from=hq"]);
    expect(assigned.join("")).not.toContain("sekret");
    expect(assigned.join("")).not.toContain("token");
    expect(dashboard.classList.contains("hidden")).toBe(true);
    expect(loginBox.classList.contains("hidden")).toBe(false);
    expect(toasts).toEqual([]);
  });

  it("opens the new dashboard only after a confirmed HQ session names that business", async () => {
    function extractFunction(source: string, name: string) {
      const marker = "function " + name;
      const start = source.indexOf(marker);
      const brace = source.indexOf("{", start);
      let depth = 0;
      for (let i = brace; i < source.length; i++) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            const from = source.slice(start - 6, start) === "async " ? start - 6 : start;
            return source.slice(from, i + 1);
          }
        }
      }
      throw new Error("missing " + name);
    }
    function classList(initial: string[]) {
      const names = new Set(initial);
      return {
        add(...values: string[]) { for (const name of values) names.add(name); },
        remove(...values: string[]) { for (const name of values) names.delete(name); },
        contains(name: string) { return names.has(name); },
        toggle(name: string, force?: boolean) {
          const on = force == null ? !names.has(name) : force;
          if (on) names.add(name);
          else names.delete(name);
          return on;
        },
      };
    }
    const optimistic = extractFunction(publicHtml, "applySchediAuthMetaOptimistic");
    expect(optimistic).not.toContain("searchParams");
    expect(optimistic).not.toContain("get('tenant')");
    expect(optimistic).not.toContain("HQ_MANAGED_TENANT_KEY");
    const remember = extractFunction(publicHtml, "hqRememberManagedTenant");
    expect(remember).toContain("sessionStorage.setItem(HQ_MANAGED_TENANT_KEY, clean)");
    expect(remember).not.toContain("schediAuthSession");
    expect(publicHtml).toContain("onclick=\"hqForgetManagedTenant()\"");
    expect(hqHtml).toContain("try { hqForgetManagedTenant(); } catch (errForgetBoot) {}");
    const helpers = publicHtml.slice(
      publicHtml.indexOf("var schediHqPendingTenantId"),
      publicHtml.indexOf("function attachCloudDbSync"),
    );

    const harbor = { id: "harbor", name: "Harbor Studio", slug: "harbor", services: [], appointments: [] };
    const lumen = { id: "lumen", name: "Lumen Studio", slug: "lumen", services: [], appointments: [] };

    async function restore(input: {
      role: "agency" | "owner";
      tenantId?: string;
      search: string;
      pathname?: string;
      status: number;
      ok?: boolean;
      body?: unknown;
      throwNetwork?: boolean;
      session?: string | null;
      stored?: string;
      cloudLoaded?: boolean;
    }) {
      const replaced: string[] = [];
      const cleared: string[] = [];
      const modes: string[] = [];
      const opened: string[] = [];
      const assigned: string[] = [];
      const bag = new Map<string, string>();
      if (input.stored) bag.set("schedi.hqManagedTenantId", input.stored);
      const loginBox = { classList: classList([]) };
      const dashboard = { classList: classList(["hidden"]) };
      const nameEl = { id: "sdHqManageName", textContent: "" };
      const banner = {
        id: "sdHqManage",
        hidden: true,
        href: "/hq",
        className: "sd-hq-manage",
        children: [{ textContent: "Managing " }, nameEl, { textContent: " · Back to HQ" }],
      };
      const state = {
        activeTenantId: "",
        isTenantOwnerLoggedIn: false,
        ownerSelfSession: false,
        isAgencyMasterLoggedIn: false,
        currentMode: "",
        tenants: [harbor, lumen],
      };
      const href = "https://schedi.app" + (input.pathname || "/login") + input.search;
      const sandbox: Record<string, unknown> = {
        URL,
        URLSearchParams,
        __schediCloudTenantsLoaded: input.cloudLoaded === true,
        location: {
          href,
          search: input.search,
          pathname: input.pathname || "/login",
          hash: "",
          assign(url: string) { assigned.push(String(url)); },
        },
        history: { replaceState(_state: unknown, _title: string, url: string) { replaced.push(String(url)); } },
        sessionStorage: {
          getItem(key: string) { return bag.has(key) ? bag.get(key)! : null; },
          setItem(key: string, value: string) { bag.set(key, String(value)); },
          removeItem(key: string) { bag.delete(key); },
        },
        document: {
          getElementById(id: string) {
            if (id === "tenantLoginBox") return loginBox;
            if (id === "tenantDashboard") return dashboard;
            if (id === "sdHqManage") return banner;
            if (id === "sdHqManageName") return nameEl;
            if (id === "tenantAutoLogoffWrap" || id === "tenantSignOutBtn") return { classList: classList(["hidden"]), querySelector: () => null };
            return null;
          },
        },
        platformState: state,
        schediAuthEpoch: 0,
        schediPrivateProfiles: {},
        schediPrivateProfilesLoaded: false,
        schediAuthRestoreAllowedHere() { return true; },
        schediAuthSession() { return input.session === null ? "" : (input.session || "agency-session"); },
        schediAuthMeta() {
          if (input.role === "owner") return { role: "owner", tenantId: input.tenantId || "harbor", email: "owner@example.com" };
          return { role: "agency", email: "hq@example.com" };
        },
        schediClearAuthSession() { cleared.push("session"); },
        schediSetAuthSession() { return true; },
        applyPrivateProfiles() {},
        clearPrivateAppointments() {},
        clearPrivateProfiles() {},
        updateMasterAuthUI() {},
        refreshPrivateBookings() {},
        refreshAppointmentCounts() {},
        syncOwnerChangePassBtn() {},
        updateLivePreviewControlsVisibility() {},
        syncTenantAutoLogoffSelect() {},
        startTenantOwnerIdleWatch() {},
        stopTenantOwnerIdleWatch() {},
        populateTenantSelect() {},
        renderTenantAdminPortal() { opened.push(state.activeTenantId); },
        fetch: async () => {
          if (input.throwNetwork) throw new Error("offline");
          return {
            status: input.status,
            ok: input.ok != null ? input.ok : input.status >= 200 && input.status < 300,
            json: async () => input.body,
          };
        },
      };
      sandbox.window = sandbox;
      sandbox.opened = opened;
      sandbox.replaced = replaced;
      sandbox.cleared = cleared;
      sandbox.assigned = assigned;
      const script = [
        helpers,
        extractFunction(publicHtml, "isAgencyHqRoute"),
        "function getTenant(id) { if (id == null) id = platformState.activeTenantId; return platformState.tenants.find(function (t) { return t && t.id === id; }) || platformState.tenants[0]; }",
        extractFunction(publicHtml, "syncHqManagingBanner"),
        extractFunction(publicHtml, "openTenantOwnerPortal"),
        "var modes = [];",
        "function switchPlatformMode(mode) { modes.push(mode); platformState.currentMode = mode; try { syncHqManagingBanner(); } catch (err) {} }",
        optimistic,
        extractFunction(publicHtml, "verifySchediAuthSessionRestore"),
        "(async function () {",
        "  var first = applySchediAuthMetaOptimistic();",
        "  var optimisticOwner = platformState.isTenantOwnerLoggedIn;",
        "  var optimisticDashHidden = document.getElementById('tenantDashboard').classList.contains('hidden');",
        "  var confirmed = await verifySchediAuthSessionRestore();",
        "  var bannerEl = document.getElementById('sdHqManage');",
        "  var nameNode = document.getElementById('sdHqManageName');",
        "  return {",
        "    first: first,",
        "    confirmed: confirmed,",
        "    active: platformState.activeTenantId,",
        "    owner: platformState.isTenantOwnerLoggedIn,",
        "    self: platformState.ownerSelfSession,",
        "    agency: platformState.isAgencyMasterLoggedIn,",
        "    modes: modes,",
        "    opened: opened,",
        "    replaced: replaced,",
        "    cleared: cleared,",
        "    loginHidden: document.getElementById('tenantLoginBox').classList.contains('hidden'),",
        "    dashHidden: document.getElementById('tenantDashboard').classList.contains('hidden'),",
        "    bannerHidden: bannerEl.hidden,",
        "    bannerText: 'Managing ' + nameNode.textContent + ' · Back to HQ',",
        "    bannerHref: bannerEl.href,",
        "    managed: sessionStorage.getItem('schedi.hqManagedTenantId') || '',",
        "    assigned: assigned,",
        "    notice: sessionStorage.getItem('schedi.hqReturnNotice') || '',",
        "    optimisticOwner: optimisticOwner,",
        "    optimisticDashHidden: optimisticDashHidden,",
        "    clickClears: (function () {",
        "      if (!bannerEl.onclick) return false;",
        "      bannerEl.onclick();",
        "      return sessionStorage.getItem('schedi.hqManagedTenantId') == null;",
        "    })()",
        "  };",
        "})()",
      ].join("\n");
      const result = await runInNewContext(script, sandbox, { filename: "hq-managed-login.js" }) as {
        first: boolean;
        confirmed: boolean;
        active: string;
        owner: boolean;
        self: boolean;
        agency: boolean;
        modes: string[];
        opened: string[];
        replaced: string[];
        cleared: string[];
        loginHidden: boolean;
        dashHidden: boolean;
        bannerHidden: boolean;
        bannerText: string;
        bannerHref: string;
        managed: string;
        assigned: string[];
        notice: string;
        optimisticOwner: boolean;
        optimisticDashHidden: boolean;
        clickClears: boolean;
      };
      return result;
    }

    const confirmed = await restore({
      role: "agency",
      search: "?tenant=lumen&from=hq&dash=today",
      status: 200,
      body: { ok: true, tenants: [{ id: "harbor" }, { id: "lumen" }] },
    });
    expect(confirmed.first).toBe(true);
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.agency).toBe(true);
    expect(confirmed.owner).toBe(true);
    expect(confirmed.self).toBe(false);
    expect(confirmed.active).toBe("lumen");
    expect(confirmed.opened).toContain("lumen");
    expect(confirmed.modes).toContain("tenant");
    expect(confirmed.loginHidden).toBe(true);
    expect(confirmed.dashHidden).toBe(false);
    expect(confirmed.replaced).toEqual(["/login?dash=today"]);
    expect(confirmed.bannerHidden).toBe(false);
    expect(confirmed.bannerText).toBe("Managing Lumen Studio · Back to HQ");
    expect(confirmed.bannerHref).toBe("/hq");
    expect(confirmed.cleared).toEqual([]);
    expect(confirmed.optimisticOwner).toBe(false);
    expect(confirmed.optimisticDashHidden).toBe(true);
    expect(confirmed.managed).toBe("lumen");
    expect(confirmed.assigned).toEqual([]);
    expect(confirmed.clickClears).toBe(true);

    const owner = await restore({
      role: "owner",
      tenantId: "harbor",
      search: "?tenant=lumen&from=hq",
      status: 200,
      body: { ok: true, tenants: [{ id: "harbor" }, { id: "lumen" }] },
    });
    expect(owner.active).toBe("harbor");
    expect(owner.self).toBe(true);
    expect(owner.owner).toBe(true);
    expect(owner.opened).toEqual(["harbor"]);
    expect(owner.replaced).toEqual([]);
    expect(owner.bannerHidden).toBe(true);

    const invalid = await restore({
      role: "agency",
      search: "?tenant=missing&from=hq",
      status: 200,
      body: { ok: true, tenants: [{ id: "harbor" }, { id: "lumen" }] },
    });
    expect(invalid.owner).toBe(false);
    expect(invalid.self).toBe(false);
    expect(invalid.opened).toEqual([]);
    expect(invalid.dashHidden).toBe(true);
    expect(invalid.replaced).toEqual([]);
    expect(invalid.bannerHidden).toBe(true);

    const onHq = await restore({
      role: "agency",
      pathname: "/hq",
      search: "?tenant=lumen&from=hq",
      status: 200,
      body: { ok: true, tenants: [{ id: "lumen" }] },
    });
    expect(onHq.owner).toBe(false);
    expect(onHq.opened).toEqual([]);
    expect(onHq.modes).toContain("agency");
    expect(onHq.dashHidden).toBe(true);

    const rejected = await restore({
      role: "agency",
      search: "?tenant=lumen&from=hq",
      status: 401,
      body: { error: "session_required" },
    });
    expect(rejected.confirmed).toBe(false);
    expect(rejected.owner).toBe(false);
    expect(rejected.agency).toBe(false);
    expect(rejected.opened).toEqual([]);
    expect(rejected.dashHidden).toBe(true);
    expect(rejected.replaced).toEqual([]);
    expect(rejected.cleared).toEqual(["session"]);

    const unconfirmed = await restore({
      role: "agency",
      search: "?tenant=lumen&from=hq",
      status: 500,
      ok: false,
      body: { ok: false },
    });
    expect(unconfirmed.owner).toBe(false);
    expect(unconfirmed.opened).toEqual([]);
    expect(unconfirmed.dashHidden).toBe(true);
    expect(unconfirmed.replaced).toEqual([]);
    expect(unconfirmed.cleared).toEqual([]);

    const offline = await restore({
      role: "agency",
      search: "?tenant=lumen&from=hq",
      status: 0,
      throwNetwork: true,
    });
    expect(offline.owner).toBe(false);
    expect(offline.opened).toEqual([]);
    expect(offline.dashHidden).toBe(true);

    const unsigned = await restore({
      role: "agency",
      search: "?tenant=lumen&from=hq",
      status: 200,
      session: null,
      body: { ok: true, tenants: [{ id: "lumen" }] },
    });
    expect(unsigned.first).toBe(false);
    expect(unsigned.confirmed).toBe(false);
    expect(unsigned.owner).toBe(false);
    expect(unsigned.opened).toEqual([]);

    const reloaded = await restore({
      role: "agency",
      search: "",
      stored: "lumen",
      status: 200,
      body: { ok: true, tenants: [{ id: "harbor" }, { id: "lumen" }] },
    });
    expect(reloaded.optimisticOwner).toBe(false);
    expect(reloaded.optimisticDashHidden).toBe(true);
    expect(reloaded.confirmed).toBe(true);
    expect(reloaded.owner).toBe(true);
    expect(reloaded.self).toBe(false);
    expect(reloaded.active).toBe("lumen");
    expect(reloaded.opened).toContain("lumen");
    expect(reloaded.loginHidden).toBe(true);
    expect(reloaded.dashHidden).toBe(false);
    expect(reloaded.bannerHidden).toBe(false);
    expect(reloaded.bannerText).toBe("Managing Lumen Studio · Back to HQ");
    expect(reloaded.managed).toBe("lumen");
    expect(reloaded.assigned).toEqual([]);
    expect(reloaded.replaced).toEqual([]);

    const stale = await restore({
      role: "agency",
      search: "",
      stored: "northwind",
      status: 200,
      body: { ok: true, tenants: [{ id: "harbor" }, { id: "lumen" }] },
    });
    expect(stale.owner).toBe(false);
    expect(stale.opened).toEqual([]);
    expect(stale.dashHidden).toBe(true);
    expect(stale.managed).toBe("");
    expect(stale.assigned).toEqual(["/hq"]);
    expect(stale.notice).toBe("That business isn't available to open.");

    const unresolved = await restore({
      role: "agency",
      search: "",
      stored: "northwind",
      cloudLoaded: true,
      status: 200,
      body: { ok: true, tenants: [{ id: "northwind" }, { id: "lumen" }] },
    });
    expect(unresolved.owner).toBe(false);
    expect(unresolved.active).toBe("");
    expect(unresolved.opened).toEqual([]);
    expect(unresolved.managed).toBe("");
    expect(unresolved.assigned).toEqual(["/hq"]);
    expect(unresolved.notice).toBe("That business isn't available to open.");

    const ownerStored = await restore({
      role: "owner",
      tenantId: "harbor",
      search: "",
      stored: "lumen",
      status: 200,
      body: { ok: true, tenants: [{ id: "harbor" }, { id: "lumen" }] },
    });
    expect(ownerStored.opened).toEqual([]);
    expect(ownerStored.managed).toBe("");
    expect(ownerStored.assigned).toEqual(["/hq"]);

    const rejectedStored = await restore({
      role: "agency",
      search: "",
      stored: "lumen",
      status: 401,
      body: { error: "session_required" },
    });
    expect(rejectedStored.confirmed).toBe(false);
    expect(rejectedStored.opened).toEqual([]);
    expect(rejectedStored.managed).toBe("");
    expect(rejectedStored.cleared).toEqual(["session"]);
    expect(rejectedStored.assigned).toEqual(["/hq"]);

    const offlineStored = await restore({
      role: "agency",
      search: "",
      stored: "lumen",
      status: 0,
      throwNetwork: true,
    });
    expect(offlineStored.opened).toEqual([]);
    expect(offlineStored.dashHidden).toBe(true);
    expect(offlineStored.managed).toBe("lumen");
    expect(offlineStored.assigned).toEqual([]);
  });

  it("sends every business portal sign-out to /login, including one opened from HQ", async () => {
    function extractAssigned(source: string, name: string) {
      const marker = "window." + name + " = function";
      const start = source.indexOf(marker);
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
    function classList(initial: string[]) {
      const names = new Set(initial);
      return {
        add(...values: string[]) { for (const name of values) names.add(name); },
        remove(...values: string[]) { for (const name of values) names.delete(name); },
        contains(name: string) { return names.has(name); },
      };
    }
    function runLogout(state: {
      agency: boolean;
      owner: boolean;
      self: boolean;
      role?: string;
      pathname?: string;
      search?: string;
      stored?: string;
    }) {
      const assigned: string[] = [];
      const replaced: string[] = [];
      const cleared: string[] = [];
      const calls: { url: string; credentials: string; session: string }[] = [];
      const local = new Map<string, string>();
      if (state.role) {
        local.set("schedi.authSession", state.role + "-token");
        local.set("schedi.authMeta", JSON.stringify({ role: state.role, email: state.role + "@example.com", tenantId: state.role === "owner" ? "lumen" : "" }));
      }
      const bag = new Map<string, string>();
      if (state.stored) bag.set("schedi.hqManagedTenantId", state.stored);
      const sandbox: Record<string, unknown> = {
        URLSearchParams,
        Promise,
        platformState: {
          isAgencyMasterLoggedIn: state.agency,
          isTenantOwnerLoggedIn: state.owner,
          ownerSelfSession: state.self,
        },
        location: {
          pathname: state.pathname || "/login",
          search: state.search || "",
          assign(url: string) { assigned.push(String(url)); },
          replace(url: string) { replaced.push(String(url)); },
        },
        localStorage: {
          getItem(key: string) { return local.has(key) ? local.get(key)! : null; },
          removeItem(key: string) { local.delete(key); },
        },
        sessionStorage: {
          getItem(key: string) { return bag.has(key) ? bag.get(key)! : null; },
          setItem(key: string, value: string) { bag.set(key, String(value)); },
          removeItem(key: string) { bag.delete(key); },
        },
        document: {
          getElementById() {
            return { classList: classList(["hidden"]), value: "" };
          },
        },
        stopTenantOwnerIdleWatch() {},
        syncOwnerChangePassBtn() {},
        clearPrivateAppointments() { cleared.push("appointments"); },
        clearPrivateProfiles() { cleared.push("profiles"); },
        schediClearAuthSession() { cleared.push("session"); local.clear(); },
        schediAuthSession() { return local.get("schedi.authSession") || ""; },
        schediAuthMeta() {
          try { return JSON.parse(local.get("schedi.authMeta") || "null"); } catch { return null; }
        },
        populateTenantSelect() {},
        updateLivePreviewControlsVisibility() {},
        showToast() {},
        fetch(url: string, init?: { credentials?: string; body?: string }) {
          const body = JSON.parse(String(init?.body || "{}")) as { session?: string };
          calls.push({ url: String(url), credentials: String(init?.credentials || ""), session: String(body.session || "") });
          return Promise.resolve({ ok: true });
        },
      };
      sandbox.window = sandbox;
      const helpers = publicHtml.slice(
        publicHtml.indexOf("var schediHqPendingTenantId"),
        publicHtml.indexOf("function attachCloudDbSync"),
      );
      const pending = runInNewContext(
        helpers + "\n" + extractAssigned(publicHtml, "handleTenantLogout") + "\nvar pending = handleTenantLogout();\npending;",
        sandbox,
        { filename: "hq-sign-out.js" },
      ) as Promise<unknown> | undefined;
      return Promise.resolve(pending).then(() => ({
        assigned,
        replaced,
        cleared,
        calls,
        managed: bag.get("schedi.hqManagedTenantId") || "",
        session: local.get("schedi.authSession") || "",
      }));
    }

    expect(publicHtml).toContain(">Managing <strong id=\"sdHqManageName\"></strong> · Back to HQ</a>");
    expect(publicHtml).toContain("onclick=\"hqForgetManagedTenant()\"");
    const logoutSource = extractAssigned(publicHtml, "handleTenantLogout");
    expect(logoutSource).toContain("window.location.replace('/login')");
    expect(logoutSource).not.toContain("'/hq'");
    expect(logoutSource).not.toContain('"/hq"');

    const hqOut = await runLogout({ agency: true, owner: true, self: false, role: "agency", stored: "lumen", pathname: "/portal" });
    expect(hqOut.calls).toEqual([{ url: "https://schedi.app/auth/logout", credentials: "include", session: "agency-token" }]);
    expect(hqOut.cleared).toContain("session");
    expect(hqOut.replaced).toEqual(["/login"]);
    expect(hqOut.assigned).toEqual([]);
    expect(hqOut.managed).toBe("");
    expect(hqOut.session).toBe("");

    const drifted = await runLogout({ agency: true, owner: true, self: true, role: "agency", stored: "lumen", pathname: "/", search: "?from=hq" });
    expect(drifted.calls[0]?.credentials).toBe("include");
    expect(drifted.calls[0]?.session).toBe("agency-token");
    expect(drifted.replaced).toEqual(["/login"]);
    expect(drifted.session).toBe("");

    const fromLink = await runLogout({ agency: false, owner: true, self: true, role: "owner", pathname: "/portal", search: "?tenant=lumen&from=hq" });
    expect(fromLink.calls).toEqual([]);
    expect(fromLink.cleared).toContain("session");
    expect(fromLink.replaced).toEqual(["/login"]);
    expect(fromLink.assigned).toEqual([]);
    expect(fromLink.session).toBe("");

    const arrived = await runLogout({ agency: true, owner: true, self: true, role: "owner", stored: "lumen", pathname: "/login", search: "?tenant=lumen&from=hq" });
    expect(arrived.calls).toEqual([]);
    expect(arrived.replaced).toEqual([]);
    expect(arrived.assigned).toEqual([]);
    expect(arrived.managed).toBe("");
    expect(arrived.session).toBe("");

    const ownerOut = await runLogout({ agency: false, owner: true, self: true, role: "owner", pathname: "/portal" });
    expect(ownerOut.calls).toEqual([]);
    expect(ownerOut.cleared).toContain("session");
    expect(ownerOut.replaced).toEqual(["/login"]);
    expect(ownerOut.assigned).toEqual([]);
    expect(ownerOut.managed).toBe("");
    expect(ownerOut.session).toBe("");

    const alreadyLogin = await runLogout({ agency: false, owner: true, self: true, role: "owner", pathname: "/login" });
    expect(alreadyLogin.calls).toEqual([]);
    expect(alreadyLogin.replaced).toEqual([]);
    expect(alreadyLogin.assigned).toEqual([]);
    expect(alreadyLogin.session).toBe("");
  });

  it("hides the classic HQ card and leaves for the sign-in page when the agency check fails", async () => {
    function extractFunction(source: string, name: string) {
      const marker = "function " + name;
      const start = source.indexOf(marker);
      const brace = source.indexOf("{", start);
      let depth = 0;
      for (let i = brace; i < source.length; i++) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            const from = source.slice(start - 6, start) === "async " ? start - 6 : start;
            return source.slice(from, i + 1);
          }
        }
      }
      throw new Error("missing " + name);
    }
    expect(hqHtml).toContain("#agencyMasterLoginBox { display: none !important; }");
    expect(hqHtml).toContain('id="hqDashSignOut" class="hqd-signout" onclick="toggleMasterAgencyAuth()">Sign out of HQ</button>');
    expect(hqHtml).toContain('id="hqDashSideSignOut" class="hqd-signout" onclick="toggleMasterAgencyAuth()">Sign out of HQ</button>');
    const agencyRender = hqHtml.slice(hqHtml.indexOf("function renderAgencyDashboard"), hqHtml.indexOf("function hqDirPrefs"));
    expect(agencyRender).toContain("loginBox.classList.add('hidden')");
    expect(agencyRender).not.toContain("loginBox.classList.remove");

    function leave(input: { role?: string; session?: string; bounced?: boolean; demo?: boolean }) {
      const replaced: string[] = [];
      const cleared: string[] = [];
      const calls: { url: string; credentials: string; session: string }[] = [];
      const local = new Map<string, string>();
      if (input.session) local.set("schedi.authSession", input.session);
      if (input.role) local.set("schedi.authMeta", JSON.stringify({ role: input.role, email: "hq@example.com", tenantId: "" }));
      const bag = new Map<string, string>();
      if (input.bounced) bag.set("schedi.hqAuthBounce", "1");
      const sandbox: Record<string, unknown> = {
        Promise,
        __SCHEDI_HQ_DEMO: input.demo === true,
        __schediHqLeaving: false,
        platformState: { isAgencyMasterLoggedIn: true, appointmentCounts: { a: 1 } },
        location: { replace(url: string) { replaced.push(String(url)); } },
        sessionStorage: {
          getItem(key: string) { return bag.has(key) ? bag.get(key)! : null; },
          setItem(key: string, value: string) { bag.set(key, String(value)); },
          removeItem(key: string) { bag.delete(key); },
        },
        schediAuthSession() { return local.get("schedi.authSession") || ""; },
        schediAuthMeta() {
          try { return JSON.parse(local.get("schedi.authMeta") || "null"); } catch { return null; }
        },
        schediClearAuthSession() { cleared.push("session"); local.clear(); },
        clearPrivateAppointments() { cleared.push("appointments"); },
        clearPrivateProfiles() { cleared.push("profiles"); },
        fetch(url: string, init?: { credentials?: string; body?: string }) {
          const body = JSON.parse(String(init?.body || "{}")) as { session?: string };
          calls.push({ url: String(url), credentials: String(init?.credentials || ""), session: String(body.session || "") });
          return Promise.resolve({ ok: true });
        },
      };
      sandbox.window = sandbox;
      const pending = runInNewContext(
        extractFunction(hqHtml, "schediLeaveAgencyHq") + "\nschediLeaveAgencyHq();",
        sandbox,
        { filename: "hq-leave.js" },
      );
      return Promise.resolve(pending).then(async () => {
        await Promise.resolve();
        return {
          replaced,
          cleared,
          calls,
          session: local.get("schedi.authSession") || "",
          bounce: bag.get("schedi.hqAuthBounce") || "",
          loggedIn: (sandbox.platformState as { isAgencyMasterLoggedIn: boolean }).isAgencyMasterLoggedIn,
        };
      });
    }

    const signedOut = await leave({ role: "agency", session: "agency-token" });
    expect(signedOut.calls).toEqual([{ url: "https://schedi.app/auth/logout", credentials: "include", session: "agency-token" }]);
    expect(signedOut.cleared).toEqual(["appointments", "profiles", "session"]);
    expect(signedOut.replaced).toEqual(["/hq"]);
    expect(signedOut.session).toBe("");
    expect(signedOut.loggedIn).toBe(false);
    expect(signedOut.bounce).toBe("1");

    const ownerKept = await leave({ role: "owner", session: "owner-token" });
    expect(ownerKept.calls).toEqual([{ url: "https://schedi.app/auth/logout", credentials: "include", session: "" }]);
    expect(ownerKept.cleared).toEqual([]);
    expect(ownerKept.session).toBe("owner-token");
    expect(ownerKept.replaced).toEqual(["/hq"]);

    const once = await leave({ role: "agency", session: "agency-token", bounced: true });
    expect(once.calls).toEqual([]);
    expect(once.replaced).toEqual([]);
    expect(once.bounce).toBe("");

    const demo = await leave({ role: "agency", session: "agency-token", demo: true });
    expect(demo.calls).toEqual([]);
    expect(demo.replaced).toEqual([]);

    const profile = hqHtml.slice(hqHtml.indexOf("async function verifySchediAuthSessionRestore"), hqHtml.indexOf("var SCHEDI_OWNER_IDLE_KEY"));
    expect(profile).toContain("credentials: 'include'");
    expect(profile).toContain("schediLeaveAgencyHq()");
  });

  it("sends HQ back when the server allows a business the public list does not have", async () => {
    function extractFunction(source: string, name: string) {
      const marker = "function " + name;
      const start = source.indexOf(marker);
      const brace = source.indexOf("{", start);
      let depth = 0;
      for (let i = brace; i < source.length; i++) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            const from = source.slice(start - 6, start) === "async " ? start - 6 : start;
            return source.slice(from, i + 1);
          }
        }
      }
      throw new Error("missing " + name);
    }
    const cloud = extractFunction(publicHtml, "attachCloudDbSync");
    const bailAt = cloud.indexOf("if (tenantSettle === 'bail') return;");
    expect(bailAt).toBeGreaterThan(-1);
    expect(bailAt).toBeLessThan(cloud.indexOf("platformState.tenants = loadedTenants"));
    expect(bailAt).toBeLessThan(cloud.indexOf("renderTenantAdminPortal"));
    expect(publicHtml).not.toContain("services: [], appointments: []");
    expect(hqHtml).toContain("function consumeHqReturnNotice()");
    expect(hqHtml).toContain("try { consumeHqReturnNotice(); } catch (errHqNote) {}");

    const alejandro = { id: "alejandro", name: "Alejandro", slug: "alejandro" };
    const harbor = { id: "harbor", name: "Harbor Studio", slug: "harbor" };
    const left: string[] = [];
    const toasts: string[] = [];
    const bag = new Map<string, string>();
    const state = {
      activeTenantId: "",
      isTenantOwnerLoggedIn: false,
      ownerSelfSession: false,
      isAgencyMasterLoggedIn: false,
      currentMode: "tenant",
      tenants: [alejandro, harbor],
    };
    const sandbox: Record<string, unknown> = {
      URL,
      URLSearchParams,
      __schediCloudTenantsLoaded: true,
      location: {
        href: "https://schedi.app/login?tenant=northwind&from=hq",
        search: "?tenant=northwind&from=hq",
        pathname: "/login",
        hash: "",
        assign(url: string) { left.push(String(url)); },
      },
      history: { replaceState() {} },
      sessionStorage: {
        getItem(key: string) { return bag.has(key) ? bag.get(key)! : null; },
        setItem(key: string, value: string) { bag.set(key, String(value)); },
        removeItem(key: string) { bag.delete(key); },
      },
      document: { getElementById() { return null; } },
      platformState: state,
      schediAuthEpoch: 0,
      schediPrivateProfiles: {},
      schediPrivateProfilesLoaded: false,
      schediAuthRestoreAllowedHere() { return true; },
      schediAuthSession() { return "agency-session"; },
      schediAuthMeta() { return { role: "agency", email: "hq@example.com" }; },
      schediClearAuthSession() {},
      schediSetAuthSession() { return true; },
      applyPrivateProfiles() {},
      clearPrivateAppointments() {},
      clearPrivateProfiles() {},
      updateMasterAuthUI() {},
      refreshPrivateBookings() {},
      refreshAppointmentCounts() {},
      syncOwnerChangePassBtn() {},
      updateLivePreviewControlsVisibility() {},
      syncTenantAutoLogoffSelect() {},
      startTenantOwnerIdleWatch() {},
      stopTenantOwnerIdleWatch() {},
      populateTenantSelect() {},
      renderTenantAdminPortal() { throw new Error("opened a portal"); },
      openTenantOwnerPortal() { throw new Error("opened a portal"); },
      switchPlatformMode() {},
      showToast(message: string) { toasts.push(String(message)); },
      fetch: async () => ({
        status: 200,
        ok: true,
        json: async () => ({ ok: true, tenants: [{ id: "northwind" }, { id: "alejandro" }] }),
      }),
    };
    sandbox.window = sandbox;
    const helpers = publicHtml.slice(
      publicHtml.indexOf("var schediHqPendingTenantId"),
      publicHtml.indexOf("function attachCloudDbSync"),
    );
    const result = await runInNewContext(
      [
        helpers,
        extractFunction(publicHtml, "isAgencyHqRoute"),
        extractFunction(publicHtml, "verifySchediAuthSessionRestore"),
        "(async function () {",
        "  await verifySchediAuthSessionRestore();",
        "  var stored = sessionStorage.getItem('schedi.hqReturnNotice');",
        "  consumeHqReturnNotice();",
        "  return {",
        "    active: platformState.activeTenantId,",
        "    owner: platformState.isTenantOwnerLoggedIn,",
        "    self: platformState.ownerSelfSession,",
        "    ids: platformState.tenants.map(function (t) { return t.id; }),",
        "    pending: schediHqPendingTenantId,",
        "    notice: stored,",
        "    cleared: sessionStorage.getItem('schedi.hqReturnNotice')",
        "  };",
        "})()",
      ].join("\n"),
      sandbox,
      { filename: "hq-missing-public-tenant.js" },
    ) as { active: string; owner: boolean; self: boolean; ids: string[]; pending: string; notice: string; cleared: string | null };
    expect(result.ids).toEqual(["alejandro", "harbor"]);
    expect(result.active).toBe("");
    expect(result.owner).toBe(false);
    expect(result.self).toBe(false);
    expect(result.pending).toBe("northwind");
    expect(left).toEqual(["/hq"]);
    expect(result.notice).toBe("That business isn't available to open.");
    expect(toasts).toEqual(["That business isn't available to open."]);
    expect(result.cleared).toBeNull();
  });

  it("pins the managed business on a later cloud reload, or returns to HQ", () => {
    const helpers = publicHtml.slice(
      publicHtml.indexOf("var schediHqPendingTenantId"),
      publicHtml.indexOf("function attachCloudDbSync"),
    );
    const alejandro = { id: "alejandro", name: "Alejandro" };
    const lumen = { id: "lumen", name: "Lumen Studio" };
    function settle(input: {
      active: string;
      managing: boolean;
      pending?: string;
      rows: { id: string; name: string }[];
    }) {
      const left: string[] = [];
      const bag = new Map<string, string>();
      const state = {
        activeTenantId: input.active,
        isTenantOwnerLoggedIn: input.managing,
        ownerSelfSession: false,
        isAgencyMasterLoggedIn: input.managing,
        tenants: [alejandro, lumen],
      };
      const sandbox: Record<string, unknown> = {
        platformState: state,
        schediHqPendingTenantId: input.pending || "",
        location: { assign(url: string) { left.push(String(url)); } },
        sessionStorage: {
          getItem(key: string) { return bag.has(key) ? bag.get(key)! : null; },
          setItem(key: string, value: string) { bag.set(key, String(value)); },
          removeItem(key: string) { bag.delete(key); },
        },
      };
      sandbox.window = sandbox;
      const context: Record<string, unknown> = { ...sandbox, rows: input.rows };
      context.window = context;
      const result = runInNewContext(
        `${helpers}\nschediHqPendingTenantId = ${JSON.stringify(input.pending || "")};\nsettleActiveTenantAfterCloud(rows);`,
        context,
        { filename: "hq-cloud-settle.js" },
      ) as string;
      return { result, active: state.activeTenantId, left, notice: bag.get("schedi.hqReturnNotice") || "" };
    }

    expect(settle({
      active: "lumen",
      managing: true,
      rows: [alejandro, lumen],
    })).toMatchObject({ result: "pinned", active: "lumen", left: [], notice: "" });

    const missing = settle({
      active: "lumen",
      managing: true,
      rows: [alejandro],
    });
    expect(missing.result).toBe("bail");
    expect(missing.active).toBe("lumen");
    expect(missing.left).toEqual(["/hq"]);
    expect(missing.notice).toBe("That business isn't available to open.");

    const unresolved = settle({
      active: "",
      managing: false,
      pending: "northwind",
      rows: [alejandro],
    });
    expect(unresolved.result).toBe("bail");
    expect(unresolved.active).toBe("");
    expect(unresolved.left).toEqual(["/hq"]);
    expect(unresolved.notice).toBe("That business isn't available to open.");

    expect(settle({
      active: "gone",
      managing: false,
      rows: [alejandro, lumen],
    })).toMatchObject({ result: "default", active: "alejandro", left: [] });
  });
});
