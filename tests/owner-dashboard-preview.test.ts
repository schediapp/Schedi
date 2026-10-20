import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, handleRequest, type SchediEnv } from "../worker/handler";
import { renderRobots, renderSitemap } from "../worker/render";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;
const BOOKING_TEMPLATE_SHA = "5e46cd196b1d4bee162dc292e76aebbf571baa30e65bea3f981c517f37ab208c";
const SHELL_STYLE_SHA = "7c1f1bbb7af97aa8c1e95ab8de650f6493512361a409fd083bcbe3a2c04332d6";

function bookingTemplate(source: string): string {
  const marker = "return `<!DOCTYPE html>";
  const start = source.indexOf(marker);
  const openTick = start + "return ".length;
  const end = source.indexOf("</html>`", openTick);
  return source.slice(openTick, end + "</html>`".length);
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf("function " + name);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("could not extract " + name);
}

function dashCss(source: string): string {
  const marker = '<style id="schediNewDashStyle">';
  const start = source.indexOf(marker);
  const end = source.indexOf("</style>", start);
  return source.slice(start + marker.length, end);
}

function headScript(source: string): string {
  const styleEnd = source.indexOf("</style>", source.indexOf("schediNewDashStyle"));
  const start = source.indexOf("<script>", styleEnd);
  const end = source.indexOf("</script>", start);
  return source.slice(start + "<script>".length, end);
}

function cssColorParts(value: string): [number, number, number, number] | null {
  const match = value.trim().match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] == null ? 1 : Number(match[4])];
}

function expectSettledColor(actual: string, expected: string, label: string) {
  const got = cssColorParts(actual);
  const want = cssColorParts(expected);
  expect(got, `${label} ${actual}`).not.toBeNull();
  expect(want, label).not.toBeNull();
  if (!got || !want) return;
  expect(Math.abs(got[0] - want[0]), `${label} red`).toBeLessThanOrEqual(1);
  expect(Math.abs(got[1] - want[1]), `${label} green`).toBeLessThanOrEqual(1);
  expect(Math.abs(got[2] - want[2]), `${label} blue`).toBeLessThanOrEqual(1);
  expect(Math.abs(got[3] - want[3]), `${label} alpha`).toBeLessThanOrEqual(0.02);
}

function unscopedSelectors(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const bad: string[] = [];
  function walk(block: string) {
    let i = 0;
    while (i < block.length) {
      while (i < block.length && /\s/.test(block[i])) i++;
      if (i >= block.length) break;
      const brace = block.indexOf("{", i);
      if (brace < 0) break;
      const selector = block.slice(i, brace).trim();
      let depth = 0;
      let j = brace;
      for (; j < block.length; j++) {
        if (block[j] === "{") depth++;
        else if (block[j] === "}") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      const body = block.slice(brace + 1, j - 1);
      if (selector.startsWith("@media") || selector.startsWith("@supports")) walk(body);
      else if (selector.startsWith("@keyframes") || selector.startsWith("@-webkit-keyframes")) {
        if (!selector.includes("schedi-newdash")) bad.push(selector);
      } else {
        for (const part of selector.split(",")) {
          if (!part.includes("schedi-newdash")) bad.push(part.trim());
        }
      }
      i = j;
    }
  }
  walk(clean);
  return bad;
}

function ctx() {
  return { waitUntil() {} };
}

function shellAssets(): SchediEnv["ASSETS"] {
  return {
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      if (path === "/index.html") {
        return new Response("<!DOCTYPE html><html><head><title>Schedi</title></head><body>app</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("missing", { status: 404 });
    },
  };
}

function env(): SchediEnv {
  return { FIREBASE_PROJECT_ID: "", ASSETS: shellAssets() };
}

type GuardResult = {
  demo: boolean;
  dash: boolean;
  classes: string[];
  fetches: { url: string; method: string }[];
  sets: string[];
  blocked: { url: string; method: string }[];
  stored: Record<string, string>;
};

function runHead(pathname: string, search: string, hostname: string, stored: Record<string, string> = {}): GuardResult {
  const fetches: { url: string; method: string }[] = [];
  const sets: string[] = [];
  const bag = new Map(Object.entries(stored));
  const classes = new Set<string>();
  const sandbox = {
    window: {} as Record<string, unknown>,
    location: { pathname, search, hostname },
    URLSearchParams,
    document: {
      documentElement: {
        classList: {
          add(name: string) { classes.add(name); },
          remove(name: string) { classes.delete(name); },
        },
      },
    },
    localStorage: {
      getItem(key: string) { return bag.has(key) ? bag.get(key)! : null; },
      setItem(key: string, value: string) { sets.push(key); bag.set(key, String(value)); },
      removeItem(key: string) { bag.delete(key); },
    },
    navigator: { sendBeacon(url: string) { fetches.push({ url: String(url), method: "BEACON" }); return true; } },
    Response,
    Promise,
    fetch: async (input: unknown, init?: { method?: string }) => {
      const url = typeof input === "string" ? input : String((input as { url?: string })?.url || "");
      fetches.push({ url, method: String(init?.method || "GET").toUpperCase() });
      return new Response("ok");
    },
  };
  sandbox.window = sandbox as unknown as Record<string, unknown>;
  runInNewContext(headScript(html), sandbox, { filename: "schedi-dash-head.js" });
  return {
    demo: sandbox.window.__SCHEDI_DEMO === true,
    dash: sandbox.window.__SCHEDI_NEWDASH === true,
    classes: [...classes],
    fetches,
    sets,
    blocked: (sandbox.window.__schediDemoBlocked as { url: string; method: string }[]) || [],
    stored: Object.fromEntries(bag),
  };
}

describe("owner dashboard preview", () => {
  it("pins the public booking template and keeps dashboard CSS scoped", () => {
    const template = bookingTemplate(html);
    expect(createHash("sha256").update(template).digest("hex")).toBe(BOOKING_TEMPLATE_SHA);
    expect(template).toContain("<style>");
    expect(template).not.toContain("schedi-newdash");
    const shellStart = html.indexOf("<style>");
    const shellEnd = html.indexOf("</style>", shellStart);
    const shellStyle = html.slice(shellStart, shellEnd + "</style>".length);
    expect(createHash("sha256").update(shellStyle).digest("hex")).toBe(SHELL_STYLE_SHA);
    expect(unscopedSelectors(dashCss(html))).toEqual([]);
  });

  it("reads paid and unpaid from free-text payment status", () => {
    const fn = new Function(`${extractFunction(html, "bookingPaymentState")}; return bookingPaymentState;`)() as (
      value: unknown,
    ) => string;
    expect(fn("PENDING CASH APP")).toBe("unpaid");
    expect(fn("PENDING ZELLE")).toBe("unpaid");
    expect(fn("AWAITING DEPOSIT")).toBe("unpaid");
    expect(fn("UNPAID")).toBe("unpaid");
    expect(fn("NOT PAID")).toBe("unpaid");
    expect(fn("PAY AT APPOINTMENT")).toBe("unpaid");
    expect(fn("PAID")).toBe("paid");
    expect(fn("PAID VIA CARD")).toBe("paid");
    expect(fn("PAID IN CASH")).toBe("paid");
    expect(fn("PENDING PAID")).toBe("paid");
    expect(fn("PAID PENDING")).toBe("paid");
    expect(fn("AWAITING DEPOSIT PAID")).toBe("paid");
    expect(fn({ paymentStatus: "PENDING VENMO" })).toBe("unpaid");
    expect(fn("")).toBe("unpaid");
    const menu = new Function(`${extractFunction(html, "bookingPaymentState")}\n${extractFunction(html, "rosterPayMenuLabel")}; return rosterPayMenuLabel;`)() as (
      value: { paymentStatus?: string },
    ) => string;
    expect(menu({ paymentStatus: "PAY AT APPOINTMENT" })).toBe("Mark paid");
    expect(menu({ paymentStatus: "PAID" })).toBe("Mark unpaid");
    expect(menu({ paymentStatus: "PENDING PAID" })).toBe("Mark unpaid");
    const unpaid = new Function(`${extractFunction(html, "bookingPaymentState")}\n${extractFunction(html, "rosterUnpaidPatch")}; return rosterUnpaidPatch;`)() as (
      value: { paymentStatus?: string; paymentStatusBeforePaid?: string; paymentMethodBeforePaid?: string },
    ) => { paymentStatus: string; clearPaidMethod: boolean; paymentMethod: string };
    expect(unpaid({
      paymentStatus: "PAID",
      paymentStatusBeforePaid: "PENDING VENMO",
      paymentMethodBeforePaid: "venmo",
    })).toMatchObject({ paymentStatus: "PENDING VENMO", paymentMethod: "venmo", clearPaidMethod: true });
    const commit = extractFunction(html, "commitRosterPayment");
    expect(commit).toContain("quietSyncErrors");
    expect(commit).toContain("rosterPaymentRestore");
    expect(commit.indexOf("row.ok")).toBeLessThan(commit.indexOf("return { ok: true"));
    const marked = html.slice(html.indexOf("confirmRosterMarkPaid"), html.indexOf("window.markAppointmentUnpaid"));
    expect(marked.indexOf("await commitRosterPayment")).toBeLessThan(marked.indexOf("Marked #"));
    expect(marked).toContain("sendClientPaymentReceivedEmail");
    expect(marked).toContain("sendOwnerPaymentReceivedEmail");
    expect(html).toContain("Visit history");
    expect(html).toContain("markAppointmentUnpaid");
    expect(extractFunction(html, "rosterStatusCellHtml")).toContain("appointmentStatusChipsHtml");
    expect(extractFunction(html, "appointmentStatusChipsHtml")).toContain("appointmentPayMarkup");
    expect(extractFunction(html, "appointmentPayKind")).toContain("bookingPaymentState");
    const kind = new Function(`${extractFunction(html, "bookingPaymentState")}\n${extractFunction(html, "inferPaidMethodFromBooking")}\n${extractFunction(html, "appointmentPayKind")}; return appointmentPayKind;`)() as (
      value: Record<string, unknown>,
    ) => string;
    expect(kind({ paymentStatus: "PAID VIA CARD", paidMethod: "card", stripePaymentMethodId: "pm_1" })).toBe("card");
    expect(kind({ paymentStatus: "PAID", stripeChargeId: "ch_1" })).toBe("card");
    expect(kind({ paymentStatus: "PAID", paidMethod: "venmo", stripePaymentMethodId: "pm_1", stripeChargeId: "ch_1" })).toBe("venmo");
    expect(kind({ paymentStatus: "PAID", paidMethod: "cashapp" })).toBe("cashapp");
    expect(kind({ paymentStatus: "PAID", paidMethod: "zelle" })).toBe("zelle");
    expect(kind({ paymentStatus: "PAID", paidMethod: "venmo" })).toBe("venmo");
    expect(kind({ paymentStatus: "PAID", paidMethod: "paypal" })).toBe("paypal");
    expect(kind({ paymentStatus: "PAID SQUARE", paidMethod: "square" })).toBe("square");
    expect(kind({ paymentStatus: "PAID IN CASH", paidMethod: "cash" })).toBe("cash");
    expect(kind({ paymentStatus: "PAY AT APPOINTMENT" })).toBe("unpaid");
    expect(kind({ paymentStatus: "PENDING CASH APP", paymentMethod: "cashapp" })).toBe("unpaid");
    expect(kind({ paymentStatus: "PENDING PAID", paidMethod: "venmo" })).toBe("venmo");
    expect(html).toContain('id="rosterPayFilter"');
    expect(html).toContain("Card (Stripe)");
    expect(html).toContain("In person / Cash");
    for (const method of ["card", "cashapp", "zelle", "venmo", "paypal", "square", "cash"]) {
      expect(html).toContain(`paidMethod: '${method}'`);
    }
    expect(html).toContain("value: 'PAID SQUARE'");
    expect(html).toContain('id="manPaymentChoices"');
    expect(html).toContain('class="sd-pay-choice');
    expect(html).toContain("does not refund");
    expect(html).toContain('id="unpaidStripeModal"');
    expect(html).toContain('data-theme-toggle="1"');
    expect(html.split('data-theme-toggle="1"').length - 1).toBe(2);
    expect(html.split('data-theme-set="light"').length - 1).toBe(2);
    expect(html.split('data-theme-set="dark"').length - 1).toBe(2);
    expect(html).toContain("window.setSchediTheme");
    expect(html).toContain("toggleSchediTheme");
    expect(html).toContain('id="schediDashAccountMenu"');
    expect(html).toContain('id="rosterSearchInput"');
    expect(html).toContain("function rosterSearchAppointments");
    expect(html).toContain("sd-row-side");
    expect(html).toContain("placeSchediMoreMenu");
    expect(html).toContain('class="sd-book-rules"');
    expect(html).toContain('class="sd-outages"');
    expect(html).toContain("sd-hours-hint-gap");
    expect(html).toContain('id="svcIconCats"');
    expect(html).toContain("Hair & Barber");
    expect(extractFunction(html, "markAppointmentUnpaid")).toContain("appointmentChargedOnStripe");
    expect(extractFunction(html, "refreshOwnerPaymentSurfaces")).toContain("renderSchediToday");
    expect(extractFunction(html, "paintRosterPayment")).toContain("refreshOwnerPaymentSurfaces");
    expect(html.slice(html.indexOf("window.handleManualBookingSubmit"), html.indexOf("function appointmentReportRows"))).toContain("refreshOwnerPaymentSurfaces");
    expect(html).toContain("In person / Cash");
    expect(html).toContain('id="tenantDateBlocksList"');
    expect(html).toContain("openAddDateBlockModal");
    expect(extractFunction(html, "renderTenantHours")).toContain("tenantDateBlocksList");
    expect(html).toContain('class="sd-hours-aside"');
    expect(html).toContain('class="sd-pay-settings"');
  });

  it("serves the preview shell and keeps production opt-in", async () => {
    const preview = await handleRequest(new Request("https://schedi.app/portal-preview"), env(), ctx());
    expect(preview.status).toBe(302);
    expect(preview.headers.get("location")).toBe("https://schedi.app/login");

    const wwwPreview = await handleRequest(new Request("https://www.schedi.app/portal-preview?demo=1"), env(), ctx());
    expect(wwwPreview.status).toBe(302);
    expect(wwwPreview.headers.get("location")).toBe("https://schedi.app/login");

    const previewClassic = await handleRequest(
      new Request("https://schedi.app/portal-preview?classic=1&demo=1&biz=harbor&tenant=harbor&newdash=0&dash=hours"),
      env(),
      ctx(),
    );
    expect(previewClassic.status).toBe(302);
    expect(previewClassic.headers.get("location")).toBe("https://schedi.app/login?classic=1&newdash=0&dash=hours");

    const plainPortal = await handleRequest(new Request("https://schedi.app/portal"), env(), ctx());
    expect(plainPortal.status).toBe(302);
    expect(plainPortal.headers.get("location")).toBe("https://schedi.app/login");

    const classicPortal = await handleRequest(new Request("https://schedi.app/portal?classic=1"), env(), ctx());
    expect(classicPortal.status).toBe(302);
    expect(classicPortal.headers.get("location")).toBe("https://schedi.app/login?classic=1");

    const wwwPortal = await handleRequest(new Request("https://www.schedi.app/portal?classic=1"), env(), ctx());
    expect(wwwPortal.status).toBe(302);
    expect(wwwPortal.headers.get("location")).toBe("https://schedi.app/login?classic=1");
    const classicAfter = runHead("/login", "?classic=1", "schedi.app");
    expect(classicAfter.demo).toBe(false);
    expect(classicAfter.dash).toBe(false);

    const newdashPortal = await handleRequest(new Request("https://schedi.app/portal/?newdash=0&dash=hours"), env(), ctx());
    expect(newdashPortal.status).toBe(302);
    expect(newdashPortal.headers.get("location")).toBe("https://schedi.app/login?newdash=0&dash=hours");
    const newdashAfter = runHead("/login", "?newdash=0", "schedi.app");
    expect(newdashAfter.dash).toBe(false);

    const headPortal = await handleRequest(new Request("https://schedi.app/PORTAL?classic=1", { method: "HEAD" }), env(), ctx());
    expect(headPortal.status).toBe(302);
    expect(headPortal.headers.get("location")).toBe("https://schedi.app/login?classic=1");

    for (const path of ["/?demo=1", "/?newdash=1"]) {
      const response = await handleRequest(new Request("https://schedi.app" + path), env(), ctx());
      expect(response.status, path).toBe(200);
      expect(response.headers.get("location"), path).toBeNull();
      const text = await response.text();
      expect(text, path).toContain("Schedi | Booking pages for service businesses");
      expect(text, path).not.toContain("<body>app</body>");
    }

    const portalDemo = await handleRequest(new Request("https://schedi.app/portal?biz=harbor&demo=1"), env(), ctx());
    expect(portalDemo.status).toBe(200);
    expect(portalDemo.headers.get("location")).toBeNull();
    expect(await portalDemo.text()).toContain("<body>app</body>");

    for (const path of ["/portal?biz=harbor", "/portal?tenant=harbor"]) {
      const portal = await handleRequest(new Request("https://schedi.app" + path), env(), ctx());
      expect(portal.status, path).toBe(200);
      expect(portal.headers.get("location"), path).toBeNull();
      expect(await portal.text(), path).toContain("<body>app");
    }

    const help = await handleRequest(new Request("https://schedi.app/portal/help?dash=hours"), env(), ctx());
    expect(help.status).toBe(200);
    expect(help.headers.get("location")).toBeNull();
    expect(await help.text()).toContain("<body>app");

    const login = await handleRequest(new Request("https://schedi.app/login"), env(), ctx());
    expect(login.status).toBe(200);
    expect(login.headers.get("location")).toBeNull();
    expect(await login.text()).toContain("<body>app");

    const booking = await handleRequest(new Request("https://schedi.app/axeldelcidphotography/"), env(), ctx());
    expect(booking.status).toBe(200);
    expect(booking.headers.get("location")).toBeNull();
    expect(await booking.text()).toContain("<body>app");

    const workerPreview = await handleRequest(
      new Request("https://schedi-dashboard-preview.axl199.workers.dev/portal-preview?demo=1"),
      env(),
      ctx(),
    );
    expect(workerPreview.status).toBe(200);
    expect(await workerPreview.text()).toContain("<body>app</body>");

    const workerPortal = await handleRequest(
      new Request("https://schedi-dashboard-preview.axl199.workers.dev/portal"),
      env(),
      ctx(),
    );
    expect(workerPortal.status).toBe(200);
    expect(workerPortal.headers.get("location")).toBeNull();
    expect(await workerPortal.text()).toContain("<body>app</body>");

    for (const path of ["/?demo=1", "/?newdash=1"]) {
      const response = await handleRequest(new Request("http://127.0.0.1" + path), env(), ctx());
      expect(response.status, path).toBe(200);
      const text = await response.text();
      expect(text, path).toContain("<title>Schedi</title>");
      expect(text, path).toContain("<body>app");
      expect(text, path).not.toContain("Booking pages for service businesses");
    }

    const localPreview = await handleRequest(new Request("http://localhost/portal-preview"), env(), ctx());
    expect(localPreview.status).toBe(200);
    expect(await localPreview.text()).toContain("<title>Schedi</title>");

    const home = await handleRequest(new Request("https://schedi.app/"), env(), ctx());
    expect(await home.text()).not.toContain("<body>app</body>");
    expect(renderRobots()).toContain("Disallow: /portal-preview");
    expect(renderSitemap()).not.toContain("portal-preview");
    expect(html).toContain("first === 'portal-preview'");
  });

  it("opens the owner dashboard from /login when a session is already stored", () => {
    function extractAssigned(source: string, name: string): string {
      const marker = "window." + name + " = function";
      const start = source.indexOf(marker);
      if (start < 0) throw new Error("could not extract " + name);
      const brace = source.indexOf("{", start);
      let depth = 0;
      for (let i = brace; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") {
          depth--;
          if (depth === 0) {
            const params = source.slice(start + marker.length, brace).trim();
            return "function " + name + params + " " + source.slice(brace, i + 1);
          }
        }
      }
      throw new Error("could not extract " + name);
    }
    function classList(hidden: boolean) {
      const names = new Set(hidden ? ["hidden"] : []);
      return {
        add(...values: string[]) { for (const name of values) names.add(name); },
        remove(...values: string[]) { for (const name of values) names.delete(name); },
        contains(name: string) { return names.has(name); },
      };
    }
    function boot(pathname: string, stored: Record<string, string> | null) {
      const bag = new Map(Object.entries(stored || {}));
      const els: Record<string, { classList: ReturnType<typeof classList> }> = {
        tenantLoginBox: { classList: classList(false) },
        tenantDashboard: { classList: classList(true) },
        tenantPortalSection: { classList: classList(true) },
      };
      const sandbox = {
        window: {
          location: { pathname, search: "", hostname: "schedi.app" },
          localStorage: {
            getItem(key: string) { return bag.has(key) ? bag.get(key)! : null; },
            setItem(key: string, value: string) { bag.set(key, String(value)); },
            removeItem(key: string) { bag.delete(key); },
          },
          sessionStorage: {
            getItem() { return null; },
            setItem() {},
            removeItem() {},
          },
        },
        document: {
          getElementById(id: string) { return els[id] || null; },
        },
      };
      const script = [
        "var SCHEDI_AUTH_SESSION_KEY = 'schedi.authSession';",
        "var SCHEDI_AUTH_META_KEY = 'schedi.authMeta';",
        "var platformState = { activeTenantId: '', isTenantOwnerLoggedIn: false, ownerSelfSession: false, isAgencyMasterLoggedIn: false, currentMode: '' };",
        "var painted = 0;",
        extractFunction(html, "isReservedBusinessSlug"),
        extractFunction(html, "getPublicSlugFromPath"),
        extractFunction(html, "isAgencyHqRoute"),
        extractFunction(html, "schediAuthSession"),
        extractFunction(html, "schediAuthMeta"),
        extractFunction(html, "schediAuthRestoreAllowedHere"),
        extractFunction(html, "applySchediAuthMetaOptimistic"),
        extractAssigned(html, "switchPlatformMode"),
        "function hqSectionEl(){return null;}",
        "function hqNavButton(){return null;}",
        "function syncHqManagingBanner(){}",
        "function renderTenantAdminPortal(){ painted += 1; }",
        "function updateLivePreviewControlsVisibility(){}",
        "function syncAgencyChrome(){}",
        "function syncPublicHomeFooter(){}",
        "var onBookingPage = !!getPublicSlugFromPath();",
        "var restored = onBookingPage ? false : applySchediAuthMetaOptimistic();",
        "if (!onBookingPage) switchPlatformMode('tenant');",
        "({",
        "  restored: restored,",
        "  loggedIn: platformState.isTenantOwnerLoggedIn,",
        "  tenantId: platformState.activeTenantId,",
        "  painted: painted,",
        "  loginHidden: document.getElementById('tenantLoginBox').classList.contains('hidden'),",
        "  dashboardHidden: document.getElementById('tenantDashboard').classList.contains('hidden'),",
        "  sectionHidden: document.getElementById('tenantPortalSection').classList.contains('hidden')",
        "});",
      ].join("\n");
      return runInNewContext(script, sandbox) as {
        restored: boolean;
        loggedIn: boolean;
        tenantId: string;
        painted: number;
        loginHidden: boolean;
        dashboardHidden: boolean;
        sectionHidden: boolean;
      };
    }

    const owner = boot("/login", {
      "schedi.authSession": "owner-session",
      "schedi.authMeta": JSON.stringify({ role: "owner", tenantId: "aura-exec", email: "alex@example.com" }),
    });
    expect(owner.restored).toBe(true);
    expect(owner.loggedIn).toBe(true);
    expect(owner.tenantId).toBe("aura-exec");
    expect(owner.painted).toBe(1);
    expect(owner.loginHidden).toBe(true);
    expect(owner.dashboardHidden).toBe(false);
    expect(owner.sectionHidden).toBe(false);

    const signedOut = boot("/login", null);
    expect(signedOut.restored).toBe(false);
    expect(signedOut.loggedIn).toBe(false);
    expect(signedOut.painted).toBe(0);
    expect(signedOut.loginHidden).toBe(false);
    expect(signedOut.dashboardHidden).toBe(true);

    const booking = boot("/axeldelcidphotography/", {
      "schedi.authSession": "owner-session",
      "schedi.authMeta": JSON.stringify({ role: "owner", tenantId: "aura-exec", email: "alex@example.com" }),
    });
    expect(booking.restored).toBe(false);
    expect(booking.loggedIn).toBe(false);
    expect(booking.painted).toBe(0);
  });

  it("turns the new dashboard on for real owner sessions and keeps demo data off production", () => {
    const demo = runHead("/portal-preview", "", "127.0.0.1");
    expect(demo.demo).toBe(true);
    expect(demo.dash).toBe(true);
    expect(demo.classes).toContain("schedi-newdash-boot");

    const compared = runHead("/portal-preview", "?newdash=0", "127.0.0.1");
    expect(compared.demo).toBe(true);
    expect(compared.dash).toBe(false);

    const production = runHead("/login", "", "schedi.app");
    expect(production.demo).toBe(false);
    expect(production.dash).toBe(true);
    expect(production.classes).toContain("schedi-newdash-boot");

    const classic = runHead("/login", "?classic=1", "www.schedi.app");
    expect(classic.demo).toBe(false);
    expect(classic.dash).toBe(false);

    const previewHost = runHead("/login", "", "localhost");
    expect(previewHost.demo).toBe(false);
    expect(previewHost.dash).toBe(true);

    const forced = runHead("/login", "?newdash=1", "www.schedi.app");
    expect(forced.demo).toBe(false);
    expect(forced.dash).toBe(true);

    const productionPath = runHead("/portal-preview", "", "schedi.app");
    expect(productionPath.demo).toBe(false);
    expect(productionPath.dash).toBe(true);

    const productionDemo = runHead("/", "?demo=1", "schedi.app");
    expect(productionDemo.demo).toBe(false);
    expect(productionDemo.dash).toBe(true);

    const worker = runHead("/portal-preview", "", "preview.example.workers.dev");
    expect(worker.demo).toBe(true);
    expect(worker.dash).toBe(true);

    const localDemo = runHead("/", "?demo=1", "localhost");
    expect(localDemo.demo).toBe(true);
    expect(localDemo.dash).toBe(true);

    const storedOff = runHead("/login", "", "schedi.app", { schediNewDash: "0" });
    expect(storedOff.demo).toBe(false);
    expect(storedOff.dash).toBe(true);
  });

  it("blocks demo writes before they reach the network or stored auth", async () => {
    const calls: { url: string; method: string }[] = [];
    const storage = new Map<string, string>();
    const sets: string[] = [];
    const context = {
      window: {} as Record<string, unknown>,
      location: { pathname: "/portal-preview", search: "", hostname: "127.0.0.1" },
      URLSearchParams,
      document: { documentElement: { classList: { add() {}, remove() {} } } },
      localStorage: {
        getItem(key: string) { return storage.has(key) ? storage.get(key)! : null; },
        setItem(key: string, value: string) { sets.push(key); storage.set(key, String(value)); },
        removeItem(key: string) { storage.delete(key); },
      },
      navigator: { sendBeacon(url: string) { calls.push({ url: String(url), method: "BEACON" }); return true; } },
      Response,
      Promise,
      fetch: async (input: unknown, init?: { method?: string }) => {
        const url = typeof input === "string" ? input : String((input as { url?: string })?.url || "");
        calls.push({ url, method: String(init?.method || "GET").toUpperCase() });
        return new Response("upstream");
      },
    };
    context.window = context as unknown as Record<string, unknown>;
    runInNewContext(headScript(html), context, { filename: "schedi-dash-head.js" });
    const guardedFetch = context.window.fetch as (input: unknown, init?: { method?: string }) => Promise<Response>;
    const post = await guardedFetch("https://schedi.app/api/profile", { method: "POST" });
    const put = await guardedFetch("/api/bookings", { method: "PUT" });
    const fonts = await guardedFetch("https://fonts.googleapis.com/css?family=Inter");
    expect(post.status).toBe(403);
    expect(put.status).toBe(403);
    expect(fonts.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual(["https://fonts.googleapis.com/css?family=Inter"]);
    expect((context.window.__schediDemoBlocked as { method: string }[]).map((row) => row.method)).toEqual(["POST", "PUT"]);
    context.localStorage.setItem("siteforge.platformState.v2", "secret");
    context.localStorage.setItem("schedi.authSession", "token");
    context.localStorage.setItem("schedi.theme", "light");
    expect(sets).toEqual(["schedi.theme"]);
    expect(storage.has("siteforge.platformState.v2")).toBe(false);
    expect(storage.has("schedi.authSession")).toBe(false);
    expect(storage.get("schedi.theme")).toBe("light");
    context.navigator.sendBeacon("https://schedi.app/api/send-booking-email");
    expect(calls.some((call) => call.method === "BEACON")).toBe(false);
    expect(html).toContain("if (window.__SCHEDI_DEMO) return schediDemoClientsApi(payload);");
    expect(html).toContain("if (window.__SCHEDI_DEMO) return { ok: true, demo: true, queued: true, delivered: false };");
    const moduleStart = html.indexOf('<script type="module">');
    const moduleSource = html.slice(moduleStart, html.indexOf("</script>", moduleStart));
    expect(moduleSource).toContain("if (!window.__SCHEDI_DEMO)");
    expect(moduleSource).toContain('await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js")');
    expect(moduleSource).not.toContain("import { initializeApp } from");
    const ready = html.indexOf("window.addEventListener('DOMContentLoaded'");
    const load = html.indexOf("loadState();", ready);
    const boot = html.indexOf("bootSchediDemoPortal();", ready);
    expect(boot).toBeGreaterThan(ready);
    expect(boot).toBeLessThan(load);
  });

  it("builds owner recurring dates the same way the public booking page does", () => {
    const ownerSource = ["localISODate", "parseIsoDateLocal", "addIsoDays", "shiftIsoMonth", "buildOwnerRecurringDates", "buildOwnerSeriesDates"]
      .map((name) => extractFunction(html, name))
      .join("\n");
    const owner = new Function(`${ownerSource}; var OWNER_SERIES_MAX = 12; return { buildOwnerRecurringDates, buildOwnerSeriesDates };`)() as {
      buildOwnerRecurringDates: (start: string, frequency: string, count: number) => string[];
      buildOwnerSeriesDates: (start: string, frequency: string, count: number, extra: string[]) => string[];
    };
    const template = bookingTemplate(html);
    const pubSource = ["localISODate", "addDaysISO", "addMonthsISO", "generateRecurringDates"]
      .map((name) => extractFunction(template, name))
      .join("\n");
    const generateRecurringDates = new Function(`${pubSource}; var MAX_SERIES_VISITS = 12; return generateRecurringDates;`)() as (
      start: string,
      frequency: string,
      count: number,
    ) => string[];
    for (const freq of ["weekly", "biweekly", "monthly"]) {
      expect(owner.buildOwnerRecurringDates("2026-10-15", freq, 4)).toEqual(generateRecurringDates("2026-10-15", freq, 4));
    }
    expect(owner.buildOwnerRecurringDates("2026-01-31", "monthly", 3)).toEqual(generateRecurringDates("2026-01-31", "monthly", 3));
    expect(owner.buildOwnerRecurringDates("2026-10-15", "weekly", 40)).toEqual(generateRecurringDates("2026-10-15", "weekly", 40));
    expect(owner.buildOwnerRecurringDates("2026-10-15", "weekly", 1)).toEqual(generateRecurringDates("2026-10-15", "weekly", 1));
    expect(owner.buildOwnerSeriesDates("2026-10-15", "custom", 4, ["2026-10-20", "2026-10-10", "2026-11-02", "2026-10-20"])).toEqual([
      "2026-10-15", "2026-10-20", "2026-11-02",
    ]);
    const addKind = html.slice(html.indexOf("window.schediDashAddKind = function"), html.indexOf("var OWNER_SERIES_MAX"));
    const fromClient = html.slice(html.indexOf("window.openClientRecurring = function"), html.indexOf("window.toggleClientAddForm"));
    expect(addKind).toContain("openOwnerRecurringModal()");
    expect(fromClient).toContain("openOwnerRecurringModal({");
    expect(fromClient).toContain("clientName:");
    expect(html).toContain("New recurring appointment");
  });

  it("opens a recurring series form and declines through the styled confirm", () => {
    const addStart = html.indexOf("window.schediDashAddKind = function");
    const addEnd = html.indexOf("var OWNER_SERIES_MAX", addStart);
    const addKind = html.slice(addStart, addEnd);
    expect(addKind).toContain("openOwnerRecurringModal");
    expect(addKind).not.toContain("tenantAllowRecurringCheck");
    expect(addKind).not.toContain("window.confirm");
    const deny = extractFunction(html, "denyAppointment");
    expect(deny).toContain("openDenyConfirmModal");
    expect(deny).not.toContain("window.confirm");
    expect(html).toContain('id="ownerRecurringModal"');
    expect(html).toContain('id="denyConfirmModal"');
    expect(html).toContain('id="ownerRecurClient"');
    expect(html).toContain('name="ownerRecurFreq" value="weekly"');
    expect(html).toContain('name="ownerRecurFreq" value="biweekly"');
    expect(html).toContain("> Biweekly</label>");
    expect(html).toContain('name="ownerRecurFreq" value="monthly"');
    expect(html).toContain('name="ownerRecurFreq" value="custom"');
    expect(html).toContain(">End after</label>");
    expect(html).not.toContain('name="ownerRecurEnd"');
    expect(html).toContain("seriesId: seriesId");
    expect(html).toContain("This demo does not save a recurring series.");
    expect(html).toContain("data-booking-id");
    const modal = html.slice(html.indexOf('id="denyConfirmModal"'), html.indexOf('id="ownerRecurringModal"'));
    expect(modal).toContain('role="dialog"');
    expect(modal).toContain("Decline");
    expect(modal).not.toContain("window.confirm");
  });

  it("suggests a service icon from whole words and keeps an explicit class", () => {
    const start = html.indexOf("var SERVICE_ICON_RULES");
    const source = html.slice(start, html.indexOf("function serviceIconClass", start));
    const suggest = new Function(`${source}; return suggestServiceIcon;`)() as (name: string, desc?: string) => string;
    expect(suggest("Haircut", "")).toBe("fa-scissors");
    expect(suggest("low fade", "")).toBe("fa-scissors");
    expect(suggest("Beard trim", "")).toBe("fa-scissors");
    expect(suggest("Barber", "")).toBe("fa-scissors");
    expect(suggest("Manicure", "")).toBe("fa-hand");
    expect(suggest("Deep tissue massage", "")).toBe("fa-spa");
    expect(suggest("Strategy session", "coaching")).toBe("fa-briefcase");
    expect(suggest("Headshot", "")).toBe("fa-camera");
    expect(suggest("Move-out clean", "")).toBe("fa-broom");
    expect(suggest("Personal training", "")).toBe("fa-dumbbell");
    expect(suggest("Piano lesson", "")).toBe("fa-book");
    expect(suggest("Auto detail", "")).toBe("fa-car");
    expect(suggest("Dog groom", "")).toBe("fa-paw");
    expect(suggest("Window washing", "")).toBe("fa-calendar");
    expect(suggest("", "")).toBe("fa-calendar");
    expect(suggest("Card payment", "")).toBe("fa-calendar");
    expect(suggest("Classic color", "")).toBe("fa-calendar");
    expect(suggest("Scar treatment", "")).toBe("fa-calendar");
    expect(suggest("House cleaning", "")).toBe("fa-calendar");
    expect(suggest("Consult about my car", "")).toBe("fa-briefcase");
    expect(suggest("Yoga", "")).toBe("fa-yoga-mat");
    expect(suggest("Kettlebell swings", "")).toBe("fa-kettlebell");
    expect(suggest("French tips", "")).toBe("fa-french-tips");
    expect(suggest("Nail file", "")).toBe("fa-hand");
    expect(suggest("Vacuum floors", "")).toBe("fa-vacuum");
    expect(suggest("Spanish conversation", "")).toBe("fa-language");
    expect(html).not.toContain("FontAwesome Icon Class");
    expect(html).toContain('id="svcIconGrid"');
    expect(html).toContain("Upload your own");
    expect(html).toContain("Current icon");
    const save = html.slice(html.indexOf("window.handleAddServiceSubmit = function"), html.indexOf("window.deleteService = function"));
    expect(save).toContain("suggestServiceIcon");
    expect(save).toContain("svc.icon = icon");
    expect(html.indexOf("id=\"tenantServiceModal\"")).toBeLessThan(html.indexOf("return `<!DOCTYPE html>"));
  });

  it("places Add appointment in Coming up, after the glance and the queue", () => {
    const panel = html.slice(html.indexOf('id="schediTodayPanel"'), html.indexOf('id="schediDashTabbar"'));
    const desktopBtn = panel.indexOf("sd-add-desktop");
    const phoneBtn = panel.indexOf("sd-add-phone");
    const schedule = panel.indexOf('id="schediTodaySchedule"');
    const glance = panel.indexOf('id="schediGlanceHeading"');
    const pulse = panel.indexOf('class="sd-pulse"');
    const waiting = panel.indexOf(">Waiting on you<");
    const coming = panel.indexOf('id="schediAgendaHeading"');
    const ready = panel.indexOf('id="schediReady"');
    expect(desktopBtn).toBeGreaterThan(-1);
    expect(glance).toBeGreaterThan(desktopBtn);
    expect(pulse).toBeGreaterThan(glance);
    expect(waiting).toBeGreaterThan(pulse);
    expect(coming).toBeGreaterThan(waiting);
    expect(phoneBtn).toBeGreaterThan(coming);
    expect(schedule).toBeGreaterThan(phoneBtn);
    expect(ready).toBeGreaterThan(schedule);
    expect(panel.slice(phoneBtn, schedule)).not.toContain("sd-pulse");
    expect(panel.slice(phoneBtn, schedule)).not.toContain("Waiting on you");
    expect(panel.slice(glance, pulse)).toContain(">At a glance<");
    const css = dashCss(html);
    const grid = css.slice(css.indexOf("#tenantPortalSection.schedi-newdash .sd-today-grid {"), css.indexOf("#tenantPortalSection.schedi-newdash .sd-glance,"));
    expect(grid).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(grid).not.toContain("1.45fr");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-btn.sd-add-phone { display: none; }");
    const phone = css.slice(css.indexOf("@media (max-width: 859px)"));
    expect(phone).toContain("#tenantPortalSection.schedi-newdash .sd-btn.sd-add-desktop { display: none; }");
    expect(phone).toContain("#tenantPortalSection.schedi-newdash .sd-btn.sd-add-phone { display: flex; width: 100%; justify-content: center; margin: 0; }");
    expect(css.slice(0, css.indexOf("@media (max-width: 859px)"))).not.toContain(".sd-add-desktop { display: none");
  });

  it("colors paid methods, no-shows, collected amounts, service titles, and plan compare text", () => {
    const css = dashCss(html);
    expect(css).toContain("#008CFF");
    expect(css).toContain("#00D64F");
    expect(css).toContain("#6D1ED4");
    expect(css).toContain("#003087");
    expect(css).toContain("#0070E0");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-chip.sd-pay-square");
    expect(css).toContain("background: #000000");
    expect(css).toContain("background: #ffffff");
    const squareChip = css.slice(
      css.indexOf("#tenantPortalSection.schedi-newdash .sd-pay-square,"),
      css.indexOf("#tenantPortalSection.schedi-newdash .sd-chip-count"),
    );
    expect(squareChip).toContain("background: rgba(255, 255, 255, 0.14)");
    expect(squareChip).toContain("color: #f8fafc");
    expect(squareChip).toContain("border-color: #e2e8f0");
    expect(squareChip).toContain("background: #000000");
    expect(squareChip).toContain("color: #ffffff");
    const cashChip = css.slice(
      css.indexOf("#tenantPortalSection.schedi-newdash .sd-pay.sd-pay-cashapp,"),
      css.indexOf("#tenantPortalSection.schedi-newdash .sd-pay-zelle,"),
    );
    expect(cashChip).toContain("color: #00D64F");
    expect(cashChip).toContain("background: rgba(0, 214, 79, 0.18)");
    expect(cashChip).toContain("border-color: #00D64F");
    expect(cashChip).toContain("color: #046632");
    expect(cashChip).toContain("background: rgba(0, 214, 79, 0.16)");
    expect(cashChip).not.toContain("rgba(148, 163, 184");
    expect(css).toContain("rgba(0, 140, 255, 0.16)");
    expect(css).toContain("rgba(109, 30, 212, 0.22)");
    expect(css).toContain("color: #4c128f");
    expect(css).toContain("color: #c5ddff");
    expect(css).toContain("#635BFF");
    expect(css).toContain("color: #c4c0ff");
    expect(css).toContain("color: #4338ca");
    expect(css).toContain("background: rgba(99, 91, 255, 0.18)");
    expect(extractFunction(html, "noShowPillHtml")).toContain("sd-pill-rose");
    expect(extractFunction(html, "rosterApptChip")).toContain("appointmentStatusChipsHtml");
    expect(extractFunction(html, "appointmentOutcomeChipHtml")).toContain("noShowPillHtml");
    expect(extractFunction(html, "appointmentPayMarkup")).toContain("sd-pay-");
    expect(extractFunction(html, "renderRosterPayFilter")).toContain("rosterBrandPayClass");
    expect(html).toContain('colspan="9"');
    expect(html).not.toContain('colspan="8"');
    expect(html).not.toContain('colspan="7"');
    expect(html).toContain(">Paid</th>");
    expect(css).toContain("font-variant-numeric: tabular-nums");
    expect(css).toContain("font-size: 16px");
    expect(css).toContain("font-size: 1.375rem");
    const desktopServices = css.slice(css.indexOf("@media (min-width: 768px)"));
    expect(desktopServices).toContain(".sd-svc-title");
    expect(desktopServices).toContain("font-size: 15px");
    expect(desktopServices).toContain("font-weight: 600");
    const collected = new Function(
      `${extractFunction(html, "roundMoney")}\n${extractFunction(html, "hasPricedAmount")}\n${extractFunction(html, "catalogServicePrice")}\n${extractFunction(html, "bookingPaymentState")}\n${extractFunction(html, "rosterAmountCollected")}; return rosterAmountCollected;`,
    )() as (app: Record<string, unknown>, tenant?: { services: { name: string; price: number | null }[] }) => {
      net: number;
      refund: number;
      refunded: boolean;
      empty: boolean;
    };
    const tenant = { services: [{ name: "Beard trim", price: 28 }, { name: "Consultation", price: null }] };
    expect(collected({ paymentStatus: "PAID", amount: 65 }, tenant)).toMatchObject({ net: 65, empty: false, refunded: false });
    expect(collected({ paymentStatus: "PAID", paidMethod: "cashapp", serviceName: "Beard trim" }, tenant)).toMatchObject({ net: 28, empty: false });
    expect(collected({ paymentStatus: "PAID", paidMethod: "zelle", serviceName: "Consultation" }, tenant)).toMatchObject({ net: 0, empty: false });
    expect(collected({ paymentStatus: "PAY AT APPOINTMENT", amount: 80 }, tenant)).toMatchObject({ empty: true, net: 0 });
    expect(collected({ paymentStatus: "PENDING VENMO", paymentMethod: "venmo", amount: 55 }, tenant)).toMatchObject({ empty: true });
    expect(collected({
      paymentStatus: "DEPOSIT PAID",
      depositPaid: true,
      depositAmount: 36,
      amount: 120,
    }, tenant)).toMatchObject({ net: 36, empty: false });
    expect(collected({ paymentStatus: "PAID", amount: 65, refundAmount: 20 }, tenant)).toMatchObject({ net: 45, refund: 20, refunded: true });
    expect(collected({ paymentStatus: "PAID", amount: 65, refunded: true }, tenant)).toMatchObject({ net: 0, refunded: true });
    expect(html).toContain("depositAmount: 36");
    expect(html).toContain("refundAmount: 20");
    expect(css).toContain("#comparePlansModal .schedi-compare-table .bg-slate-900\\/40");
    expect(css).toContain("background-color: #f1f5f9");
    expect(css).toContain("color: #1f2937");
    expect(css).toContain("color: #047857");
    expect(css).toContain("color: #9a3412");
    expect(css).toContain("color: #3730a3");
  });

  it("offers a week layout for hours without changing the saved hours shape", () => {
    const css = dashCss(html);
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-hours-week.roster-week-grid");
    expect(css).toContain("grid-template-columns: 1fr");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-hours-week-day");
    expect(css).not.toContain("minmax(200px");
    const stackedWeek = css.slice(css.indexOf("@media (min-width: 640px) and (max-width: 1099px)"));
    expect(stackedWeek).toContain("grid-template-columns: 1fr");
    expect(stackedWeek).toContain("overflow-x: visible");
    const desktopWeek = css.slice(css.indexOf("@media (min-width: 1100px)"));
    expect(desktopWeek).toContain("repeat(7, minmax(0, 1fr))");
    expect(desktopWeek).toContain("overflow-x: visible");
    expect(css).not.toContain("minmax(148px");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-hours-week-day .sd-time-input");
    expect(css).toContain("font-size: 11px");
    expect(extractFunction(html, "hoursWeekDayHtml")).toContain("Not applied while closed");
    expect(extractFunction(html, "hoursWeekDayHtml")).toContain("hoursWeekBlockHtml");
    const fromEnv = new Function(
      `${extractFunction(html, "hoursWeekLayoutFromEnv")}; return hoursWeekLayoutFromEnv;`,
    )() as (search: string, stored: string | null) => boolean;
    expect(fromEnv("", null)).toBe(true);
    expect(fromEnv("?weekhours=1", "0")).toBe(true);
    expect(fromEnv("?weekhours=0", "1")).toBe(false);
    expect(fromEnv("", "1")).toBe(true);
    const matches = new Function(
      `${extractFunction(html, "hoursRuleMatchesDay")}; return hoursRuleMatchesDay;`,
    )() as (rule: { frequency?: string }, day: string) => boolean;
    expect(matches({ frequency: "Daily" }, "Sun")).toBe(true);
    expect(matches({ frequency: "Weekly (Mondays)" }, "Mon")).toBe(true);
    expect(matches({ frequency: "Weekly (Mondays)" }, "Fri")).toBe(false);
    expect(matches({ frequency: "Weekly (Fridays)" }, "Fri")).toBe(true);
    expect(matches({ frequency: "Monthly" }, "Wed")).toBe(true);
    const segments = new Function(
      `${extractFunction(html, "toMinutes")}\n${extractFunction(html, "fromMinutes")}\n${extractFunction(html, "parseDurationMins")}\n${extractFunction(html, "hoursWeekSegments")}; return hoursWeekSegments;`,
    )() as (start: string, end: string, rules: { time: string; duration: string }[]) => { start: string; end: string }[];
    expect(segments("11:00 AM", "07:00 PM", [{ time: "12:00 PM", duration: "1 hour" }])).toEqual([
      { start: "11:00 AM", end: "12:00 PM" },
      { start: "01:00 PM", end: "07:00 PM" },
    ]);
    expect(segments("09:00 AM", "05:00 PM", [])).toEqual([{ start: "09:00 AM", end: "05:00 PM" }]);
    const render = extractFunction(html, "renderTenantHours");
    expect(render).toContain("sd-hours-day");
    expect(render).toContain("hoursWeekGridHtml");
    expect(extractFunction(html, "hoursWeekGridHtml")).toContain("roster-week-grid");
    expect(extractFunction(html, "hoursWeekDayHtml")).toContain("shiftOpen_");
    expect(extractFunction(html, "hoursWeekDayHtml")).toContain('class="sd-pay-switch" role="switch"');
    expect(extractFunction(html, "hoursWeekDayHtml")).not.toContain("sd-hours-week-state");
    expect(extractFunction(html, "hoursWeekDayHtml")).toContain("(h.open ? 'Open' : 'Closed')");
    expect(css).not.toContain(".sd-hours-week-state");
    expect(render).toContain('class="sd-pay-switch" role="switch"');
    expect(render).toContain("is-closed");
    expect(render).toContain("Not applied while closed");
    expect(render).toContain("hoursWeekOpenChanged('${day}')");
    expect(render).toContain("hoursApplyOpenState");
    expect(extractFunction(html, "hoursApplyOpenState")).toContain("input.disabled = !open");
    expect(extractFunction(html, "hoursWeekOpenChanged")).toContain("hoursApplyOpenState");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-hours-day.is-closed .sd-hours-times");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-hours-day.is-closed .sd-hours-week-closed-note");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-row > .sd-time { grid-area: time; }");
    expect(css).not.toContain("#tenantPortalSection.schedi-newdash .sd-time { grid-area: time; }");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-hours-times > .sd-time");
    expect(css).toContain("grid-area: auto");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-hours-day .sd-hours-times {\n        grid-template-columns: minmax(0, 1fr);");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-hours-open .sd-pay-switch,");
    expect(css).toContain("width: 52px;\n    height: 30px;");
    expect(extractFunction(html, "hoursWeekDayHtml")).toContain("openAddBlockedTimeForDay");
    expect(extractFunction(html, "hoursWeekDayHtml")).toContain("openHoursCopySheet");
    expect(extractFunction(html, "hoursWeekDayHtml")).toContain("Copy to…");
    expect(extractFunction(html, "renderTenantHours")).toContain("openHoursCopySheet");
    expect(extractFunction(html, "renderTenantHours")).toContain(">Copy to…</button>");
    expect(extractFunction(html, "hoursWeekDayHtml")).not.toContain("copyHoursToOtherDays");
    expect(extractFunction(html, "copyHoursToOtherDays")).not.toContain("saveState");
    expect(extractFunction(html, "copyHoursToOtherDays")).toContain("hoursCopyTargets");
    expect(html).toContain('id="hoursCopySheet"');
    expect(html).toContain('id="hoursCopyAll"');
    expect(html).toContain(">Select all</span>");
    expect(html).toContain('id="hoursCopyApply"');
    expect(html).toContain(">Apply</button>");
    expect(extractFunction(html, "openHoursCopySheet")).toContain("all.checked = false");
    const copyTargets = new Function(
      `${extractFunction(html, "hoursCopyDayOrder")}\n${extractFunction(html, "hoursCopyTargets")}; return hoursCopyTargets;`,
    )() as (source: string, selected: string[]) => string[];
    expect(copyTargets("Mon", [])).toEqual([]);
    expect(copyTargets("Mon", ["Mon", "Tue", "Fri"])).toEqual(["Tue", "Fri"]);
    expect(copyTargets("Sun", ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    const saveHours = html.slice(html.indexOf("window.handleUpdateShiftsSubmit"), html.indexOf("function canManageBlockedTimes"));
    expect(saveHours).toContain("shiftOpen_${day}");
    expect(saveHours).toContain("shiftStart_${day}");
    expect(saveHours).toContain("shiftEnd_${day}");
    expect(saveHours).toContain("nextHours[day] = { open, start, end }");
    expect(html).toContain("Sun: { open: false, start: '10:00 AM', end: '02:00 PM' }");
    expect(html).toContain("Tue: { open: true, start: '11:00 AM', end: '07:00 PM' }");
    expect(html).toContain("id: 'rule-lunch'");
    expect(html).toContain("id: 'rule-friday'");
    expect(html).toContain("frequency: 'Weekly (Fridays)'");
    expect(html).toContain('id="hoursWeekLayoutBtn"');
    expect(html).toContain('id="hoursWeekSummary"');
    expect(css).toContain("#tenantPortalSection.schedi-newdash[data-dash=\"hours\"] #tenantHoursShiftBlock { display: block !important; }");
    expect(css).toContain("#tenantPortalSection.schedi-newdash[data-dash=\"profile\"] #tenantHoursIntro");
    expect(css).toContain("#tenantPortalSection.schedi-newdash[data-dash=\"profile\"] #hoursWeekSummary");
    expect(css).toContain("#tenantPortalSection.schedi-newdash[data-dash=\"profile\"] #tenantHoursShiftBlock { display: none !important; }");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-hours-summary-line:not(:last-child)::after { content: \" · \"; font-weight: 700; }");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-hours-summary-line:not(:last-child)::after { content: none; }");
    const summary = new Function(
      `${extractFunction(html, "toMinutes")}\n${extractFunction(html, "fromMinutes")}\n${extractFunction(html, "parseDurationMins")}\n${extractFunction(html, "hoursRuleMatchesDay")}\n${extractFunction(html, "hoursSummaryParts")}\n${extractFunction(html, "hoursSummaryRange")}\n${extractFunction(html, "hoursSummaryDayList")}\n${extractFunction(html, "hoursDailyBreakSummary")}\n${extractFunction(html, "hoursWeekSummary")}; return { hoursWeekSummary, hoursSummaryRange };`,
    )() as {
      hoursWeekSummary: (hours: Record<string, { open?: boolean; start?: string; end?: string }>, rules?: { title?: string; time?: string; duration?: string; frequency?: string }[]) => { lines: string[]; breakNote: string };
      hoursSummaryRange: (start: string, end: string) => string;
    };
    const open = (start: string, end: string) => ({ open: true, start, end });
    const closed = { open: false, start: "09:00 AM", end: "05:00 PM" };
    expect(summary.hoursSummaryRange("09:00 AM", "09:00 PM")).toBe("9 AM–9 PM");
    expect(summary.hoursSummaryRange("12:00 PM", "01:00 PM")).toBe("12–1 PM");
    expect(summary.hoursSummaryRange("09:30 AM", "10:30 AM")).toBe("9:30–10:30 AM");
    expect(summary.hoursSummaryRange("09:30 AM", "05:30 PM")).toBe("9:30 AM–5:30 PM");
    expect(summary.hoursWeekSummary({
      Mon: open("09:00 AM", "09:00 PM"),
      Tue: open("09:00 AM", "09:00 PM"),
      Wed: open("09:00 AM", "09:00 PM"),
      Thu: open("09:00 AM", "09:00 PM"),
      Fri: open("09:00 AM", "09:00 PM"),
      Sat: open("09:00 AM", "05:00 PM"),
      Sun: closed,
    }, []).lines).toEqual(["Mon–Fri 9 AM–9 PM", "Sat 9 AM–5 PM", "Sun Closed"]);
    expect(summary.hoursWeekSummary({
      Mon: open("09:00 AM", "05:00 PM"),
      Tue: open("11:00 AM", "03:00 PM"),
      Wed: open("09:00 AM", "05:00 PM"),
      Thu: closed,
      Fri: closed,
      Sat: closed,
      Sun: closed,
    }, []).lines).toEqual(["Mon, Wed 9 AM–5 PM", "Tue 11 AM–3 PM", "Thu–Sun Closed"]);
    expect(summary.hoursWeekSummary({
      Mon: open("09:00 AM", "06:00 PM"),
      Tue: open("11:00 AM", "07:00 PM"),
      Wed: open("09:00 AM", "06:00 PM"),
      Thu: open("09:00 AM", "06:00 PM"),
      Fri: open("09:00 AM", "06:00 PM"),
      Sat: open("10:00 AM", "04:00 PM"),
      Sun: closed,
    }, [
      { title: "Lunch", time: "12:00 PM", duration: "1 hour", frequency: "Daily" },
      { title: "Team meeting", time: "04:00 PM", duration: "1 hour", frequency: "Weekly (Fridays)" },
    ])).toEqual({
      lines: ["Mon, Wed–Fri 9 AM–6 PM", "Tue 11 AM–7 PM", "Sat 10 AM–4 PM", "Sun Closed"],
      breakNote: "Daily break 12–1 PM",
    });
    expect(summary.hoursWeekSummary({
      Mon: closed, Tue: closed, Wed: closed, Thu: closed, Fri: closed, Sat: closed, Sun: closed,
    }, []).lines).toEqual(["Mon–Sun Closed"]);
    expect(extractFunction(html, "renderTenantHours")).toContain("paintHoursWeekSummary(tenant)");
    expect(extractFunction(html, "paintHoursWeekSummary")).toContain("hoursWeekSummary");
    expect(extractFunction(html, "paintHoursWeekSummary")).toContain("hoursDaySplitLabel");
    expect(extractFunction(html, "hoursWeekDayHtml")).toContain("shiftSplit_");
    expect(css).toContain("margin: 16px 0 0");
    expect(css).toContain("white-space: nowrap");
    expect(html).toContain('id="tenantReportRangeLabel"');
    expect(html).toContain("Back to portal");
    expect(extractFunction(html, "showHelpPage")).toContain("ownerPortalBackHref");
    expect(extractFunction(html, "renderSchediToday")).toContain("linkEl.hidden = true");
    expect(extractFunction(html, "renderSchediToday")).not.toContain("getTenantPublicBookingUrl");
    const back = new Function(`${extractFunction(html, "ownerPortalBackHrefFrom")}; return ownerPortalBackHrefFrom;`)() as (search: string) => string;
    expect(back("?demo=1&dash=hours&biz=harbor-demo&tenant=harbor")).toContain("/portal-preview?");
    expect(back("?demo=1&dash=hours&biz=harbor-demo&tenant=harbor")).toContain("demo=1");
    expect(back("?demo=1&dash=hours&biz=harbor-demo&tenant=harbor")).toContain("dash=hours");
    expect(back("?demo=1&dash=hours&biz=harbor-demo&tenant=harbor")).toContain("biz=harbor-demo");
    expect(back("?demo=1&dash=hours&biz=harbor-demo&tenant=harbor")).toContain("tenant=harbor");
    expect(back("?dash=services")).toBe("/?dash=services");
    const helpHref = new Function(`${extractFunction(html, "ownerHelpHrefFrom")}; return ownerHelpHrefFrom;`)() as (search: string, path: string, dash: string) => string;
    const previewHelp = helpHref("?biz=harbor-demo", "/portal-preview", "hours");
    expect(previewHelp.startsWith("/portal/help?")).toBe(true);
    expect(previewHelp).toContain("demo=1");
    expect(previewHelp).toContain("portal=preview");
    expect(previewHelp).toContain("dash=hours");
    expect(previewHelp).toContain("biz=harbor-demo");
    const helpPath = new Function(`${extractFunction(html, "isOwnerHelpPath")}; return isOwnerHelpPath;`)() as (pathname: string) => boolean;
    expect(helpPath("/portal/help")).toBe(true);
    expect(helpPath("/portal/help/")).toBe(true);
    expect(helpPath("/help")).toBe(true);
    expect(helpPath("/help/booking")).toBe(false);
    expect(helpPath("/portal")).toBe(false);
    const plan = new Function(
      `${extractFunction(html, "isComplimentaryPro")}\n${extractFunction(html, "normalizePlan")}\n${extractFunction(html, "schediDashPlanLabel")}; return schediDashPlanLabel;`,
    )() as (tenant: Record<string, unknown>) => string;
    expect(plan({ plan: "pro", subscriptionStatus: "active" })).toBe("Not subscribed");
    expect(plan({ plan: "pro", stripeSubscriptionId: "sub_1", subscriptionStatus: "active" })).toBe("Pro");
    expect(plan({ plan: "starter", stripeSubscriptionId: "sub_1" })).toBe("Starter");
    expect(plan({ plan: "pro", complimentaryPro: true })).toBe("Complimentary Pro");
    expect(plan({ plan: "pro", stripeSubscriptionId: "sub_1", subscriptionStatus: "paused" })).toBe("Paused");
    expect(plan({ plan: "free" })).toBe("Free");
    expect(css).toContain("flex-wrap: nowrap !important");
    expect(css).toContain("flex: 0 0 auto");
    expect(css).toContain("min-height: 68px");
    expect(css).toContain("gap: 14px");
    expect(css).not.toContain("min-height: calc(100dvh - 72px - 112px - 8px)");
    expect(css).not.toContain("flex: 1 1 60px");
    expect(css).toContain("font-size: 22px");
    expect(css).toContain(".sd-svc-title { font-size: 18px; font-weight: 700;");
    expect(html).toContain('class="sd-svc-actions flex gap-2"');
    expect(css).toContain("html.schedi-light #tenantPortalSection.schedi-newdash #tenantServicesGrid .sd-svc-edit");
    expect(css).toContain("background-color: #ffffff !important");
    expect(css).toContain("border: 1px solid #cbd5e1");
    expect(css).toContain("#tenantPortalSection.schedi-newdash #tenantServicesGrid .sd-svc-actions > button");
    expect(html).toContain('id="hoursWeekLayoutBtn"');
    expect(css).toContain("#tenantPortalSection.schedi-newdash #hoursWeekLayoutBtn { align-self: flex-end; }");
  });

  it("replaces payment checkboxes with large switches and keeps deposit method bindings", () => {
    const pay = html.slice(html.indexOf('id="tenantSectionPayments"'), html.indexOf('id="tenantSectionNotifications"'));
    expect(pay).not.toContain("w-4 h-4");
    if (pay.includes('id="tenantPaySquareCheck"')) {
      expect(pay).toContain('id="tenantPaySquareCheck" class="sd-pay-switch" role="switch"');
    }
    for (const id of [
      "tenantPayCardCheck",
      "tenantPayCashAppCheck",
      "tenantPayZelleCheck",
      "tenantPayVenmoCheck",
      "tenantPayPaypalCheck",
      "tenantPayLaterCheck",
      "tenantDepositEnabled",
      "tenantCancelFeeEnabled",
      "tenantDepositMethodCard",
      "tenantDepositMethodCashapp",
      "tenantDepositMethodZelle",
      "tenantDepositMethodVenmo",
      "tenantDepositMethodPaypal",
    ]) {
      expect(pay).toContain(`id="${id}" class="sd-pay-switch" role="switch" aria-checked="false"`);
    }
    expect(pay).toContain("Accept this deposit on");
    expect(pay).toContain('class="sd-pay-radio"');
    expect(pay).toContain('id="tenantDepositTypePercent"');
    expect(pay).toContain('id="tenantCancelFeeTypeFixed"');
    const css = dashCss(html);
    const sw = css.slice(css.indexOf("#tenantPortalSection.schedi-newdash .sd-pay-switch {"));
    expect(sw.slice(0, 500)).toContain("width: 52px");
    expect(sw.slice(0, 500)).toContain("height: 30px");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-pay-switch-row {");
    expect(css).toContain("min-height: 56px");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-pay-switch-title {");
    expect(css).toContain("font-size: 17px");
    expect(css).toContain("background: #64748b");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-pay-switch:checked { background: #10b981; }");
    expect(css).toContain("html.schedi-light #tenantPortalSection.schedi-newdash .sd-pay-switch { background: #cbd5e1; }");
    expect(css).toContain("html.schedi-light #tenantPortalSection.schedi-newdash .sd-pay-switch:checked { background: #059669; }");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-pay-radio {");
    expect(css).toContain("min-height: 48px");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-pay-radio input {");
    expect(css).toContain("width: 22px");
    expect(css).toContain("height: 22px");
    const read = new Function(
      `${extractFunction(html, "roundMoney")}\n${extractFunction(html, "depositMethodMapFor")}\n${extractFunction(html, "readDepositSettings")}; return depositMethodMapFor;`,
    )() as (tenant: { paymentGateways?: Record<string, boolean>; deposit?: { methods?: Record<string, boolean> } }) => Record<string, boolean>;
    expect(read({
      paymentGateways: { card: false, cashapp: true, zelle: true, venmo: true, paypal: false },
      deposit: { enabled: true } as { methods?: Record<string, boolean> },
    })).toEqual({ card: false, cashapp: true, zelle: true, venmo: true, paypal: false });
    expect(read({
      paymentGateways: { card: true, cashapp: true, zelle: false, venmo: false, paypal: true },
      deposit: { methods: { card: false, cashapp: false, zelle: true, venmo: true, paypal: true } },
    })).toEqual({ card: false, cashapp: false, zelle: false, venmo: false, paypal: true });
    expect(html).toContain("depSettings.methods[key] = !!(box && box.checked && tenant.paymentGateways[key])");
    expect(extractFunction(html, "renderTenantPayments")).toContain("tenantDepositMethodCard");
    expect(extractFunction(html, "syncPaySwitchAria")).toContain('setAttribute(\'aria-checked\'');
    expect(extractFunction(html, "syncPaySwitchAriaAll")).toContain("tenantPortalSection");
  });

  it("replaces email and calendar write checkboxes with the shared switch", () => {
    const section = html.slice(html.indexOf('id="tenantSectionNotifications"'), html.indexOf('id="tenantSectionClients"'));
    expect(section).not.toContain("w-4 h-4");
    for (const id of [
      "tenantEmailConfirmCheck",
      "tenantAllowRecurringCheck",
      "tenantRemindersEnabledCheck",
      "tenantSmsEnabledCheck",
    ]) {
      expect(section).toContain(`id="${id}" class="sd-pay-switch" role="switch"`);
      expect(section).toContain("sd-pay-switch-title");
      expect(section).toContain("sd-pay-switch-note");
      expect(section).toContain("sd-pay-switch-row");
    }
    expect(section).toContain('id="tenantRemindersEnabledCheck" class="sd-pay-switch" role="switch" aria-checked="true" aria-labelledby="tenantRemindersLabel" checked');
    expect(section).toContain('id="tenantRecurringNote" class="sd-pay-switch-note text-slate-400"');
    expect(section).toContain('id="webPushSwitch" role="switch"');
    expect(extractFunction(html, "renderTenantNotifications")).toContain("syncPaySwitchAriaAll()");
    expect(html).toContain("tenant.notifications.emailConfirmations = document.getElementById('tenantEmailConfirmCheck').checked");
    expect(html).toContain("tenant.allowRecurringBookings = wantRecurring");
    expect(html).toContain("tenant.remindersEnabled = remEl ? !!remEl.checked : true");
    expect(html).toContain("tenant.smsEnabled = smsEl ? !!smsEl.checked : false");
    const busy = extractFunction(html, "paintBusyCard");
    expect(busy).toContain("Keep busy times off the book");
    expect(busy).toContain("Secret address in iCal format");
    expect(busy).not.toContain("data-busy-write=");
    expect(busy).not.toContain("Coming soon");
    expect(html).not.toContain("data-busy-write=");
  });

  it("mutes unselected mark-paid methods and keeps a single radio choice", () => {
    expect(html).toContain('id="rosterPaidMethodOptions" role="radiogroup" aria-labelledby="rosterPaidMethodTitle"');
    const paint = extractFunction(html, "paintRosterPaidMethodOptions");
    const radios = extractFunction(html, "paintOwnerPayRadios");
    expect(paint).toContain("paintOwnerPayRadios");
    expect(paint).toContain("extraClass: 'roster-paid-opt'");
    expect(radios).toContain('role="radio"');
    expect(radios).toContain("aria-checked");
    expect(radios).toContain("sd-paid-check");
    expect(radios).toContain("on ? rosterBrandPayClass(row.kind) : ''");
    expect(radios).toContain("is-on");
    expect(radios).not.toContain("aria-pressed");
    expect(paint).not.toContain("aria-pressed");
    expect(paint).toContain("confirmBtn.disabled = !chosen");
    const marked = html.slice(html.indexOf("window.confirmRosterMarkPaid"), html.indexOf("async function markAppointmentUnpaid"));
    expect(marked).toContain("if (!method || !allowed) return;");
    expect(marked).not.toContain("|| 'cash'");
    const css = dashCss(html);
    expect(css).toContain("body.schedi-newdash .sd-pay-choice.is-on,");
    expect(css).toContain("body.schedi-newdash #rosterPaidMethodOptions .roster-paid-opt.is-on {");
    expect(css).toContain("body.schedi-newdash .sd-pay-choice.is-on.sd-pay-cashapp");
    expect(css).toContain("body.schedi-newdash #rosterPaidMethodOptions .roster-paid-opt.is-on.sd-pay-cashapp");
    expect(css).toContain("body.schedi-newdash #rosterPaidMethodOptions .roster-paid-opt.is-on.sd-pay-zelle");
    expect(css).toContain("body.schedi-newdash #rosterPaidMethodOptions .roster-paid-opt.is-on.sd-pay-venmo");
    expect(css).toContain("body.schedi-newdash #rosterPaidMethodOptions .roster-paid-opt.is-on.sd-pay-paypal");
    expect(css).toContain("body.schedi-newdash #rosterPaidMethodOptions .roster-paid-opt.is-on.sd-pay-card");
    expect(css).toContain("body.schedi-newdash #rosterPaidMethodOptions .roster-paid-opt.is-on.sd-pay-square");
    expect(css).toContain("background: #635BFF");
    expect(css).toContain("background: #4338ca");
    expect(css).toContain("body.schedi-newdash #rosterPaidMethodConfirmBtn:disabled");
  });

  it("keeps card actions neutral until hover, focus, or press", () => {
    const actions = extractFunction(html, "rosterActionsHtml");
    expect(actions).toContain("btn('markAppointmentPaid', 'sd-act sd-act-ok', '<i class=\"fa-solid fa-circle-check mr-1\"></i>Mark paid')");
    expect(actions).toContain("btn('openEditAppointment', 'sd-act', 'Edit')");
    expect(actions).toContain("btn('openTenantRescheduleModal', 'sd-act sd-act-ok', '<i class=\"fa-solid fa-calendar-days mr-1\"></i>Reschedule')");
    expect(actions).toContain("btn('markAppointmentNoShow', 'sd-act', 'Mark no-show')");
    expect(actions).toContain("btn('undoAppointmentNoShow', 'sd-act', '<i class=\"fa-solid fa-rotate-left mr-1\" aria-hidden=\"true\"></i>Undo no-show')");
    expect(actions).toContain("btn('deleteAppointment', 'sd-act sd-act-no', '<i class=\"fa-solid fa-xmark mr-1\"></i>Cancel')");
    expect(actions).toContain("btn('openRosterDeleteModal', 'sd-act sd-act-no', '<i class=\"fa-solid fa-trash mr-1\"></i>Delete')");
    expect(actions).toContain("btn('markAppointmentUnpaid', 'sd-act', 'Mark unpaid')");
    const paid = actions.slice(actions.indexOf("markAppointmentPaid"), actions.indexOf("openEditAppointment"));
    expect(paid).not.toContain("emerald");
    const reschedule = actions.slice(actions.indexOf("openTenantRescheduleModal"), actions.indexOf("markAppointmentNoShow"));
    expect(reschedule).not.toContain("brand");
    const cancel = actions.slice(actions.indexOf("deleteAppointment"), actions.indexOf("out.push(btn('openRosterDeleteModal'"));
    expect(cancel).not.toContain("rose");
    const remove = actions.slice(actions.indexOf("openRosterDeleteModal"));
    expect(remove).not.toContain("rose");
    expect(actions).toContain("bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400");
    const today = extractFunction(html, "renderSchediToday");
    expect(today).toContain('class="sd-act-ok" role="menuitem" onclick="closeSchediTodayMenus(event); markAppointmentPaid(');
    expect(today).toContain('role="menuitem" onclick="closeSchediTodayMenus(event); markAppointmentUnpaid(');
    expect(today).toContain('class="sd-act-ok" role="menuitem" onclick="closeSchediTodayMenus(event); openTenantRescheduleModal(');
    expect(today).toContain('class="sd-act-no" role="menuitem" onclick="closeSchediTodayMenus(event); deleteAppointment(');
    expect(today).toContain('class="sd-act-no sd-act-delete" role="menuitem" onclick="closeSchediTodayMenus(event); openRosterDeleteModal(');
    expect(today).toContain('role="menuitem" onclick="closeSchediTodayMenus(event); markAppointmentNoShow(');
    expect(today).toContain('role="menuitem" onclick="closeSchediTodayMenus(event); undoAppointmentNoShow(');
    expect(today).toContain('fa-rotate-left');
    expect(today).toContain('>Undo no-show</button>');
    const undoItem = today.slice(today.indexOf("undoAppointmentNoShow"), today.indexOf(">Undo no-show</button>"));
    expect(undoItem).not.toContain("sd-act-ok");
    expect(undoItem).not.toContain("sd-act-no");
    expect(today).toContain('role="menuitem" onclick="closeSchediTodayMenus(event); openEditAppointment(');
    const css = dashCss(html);
    const rest = css.slice(css.indexOf("body.schedi-newdash .roster-actions > button.sd-act,"));
    expect(rest.slice(0, 280)).toContain("background: #1e293b");
    expect(rest.slice(0, 280)).toContain("color: #e2e8f0");
    expect(rest.slice(0, 280)).toContain("border: 1px solid #334155");
    expect(css).toContain("html.schedi-light body.schedi-newdash .roster-actions > button.sd-act,");
    expect(css).toContain("background: #ffffff");
    expect(css).toContain("border-color: #cbd5e1");
    expect(css).toContain("body.schedi-newdash .roster-actions > button.sd-act.sd-act-ok:hover");
    expect(css).toContain("body.schedi-newdash .roster-actions > button.sd-act.sd-act-ok:focus-visible");
    expect(css).toContain("body.schedi-newdash .roster-actions > button.sd-act.sd-act-ok:active");
    expect(css).toContain("color: #34d399");
    expect(css).toContain("body.schedi-newdash .roster-actions > button.sd-act.sd-act-no:hover");
    expect(css).toContain("color: #fb7185");
    expect(css).toContain("html.schedi-light body.schedi-newdash .roster-actions > button.sd-act.sd-act-ok:active");
    expect(css).toContain("color: #047857");
    expect(css).toContain("html.schedi-light body.schedi-newdash .roster-actions > button.sd-act.sd-act-no:active");
    expect(css).toContain("color: #be123c");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-more-menu button.sd-act-ok:hover");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-more-menu button.sd-act-no:active");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-more-menu button.sd-act-delete { color: #fb7185; }");
    expect(css).toContain("html.schedi-light #tenantPortalSection.schedi-newdash .sd-more-menu button.sd-act-delete { color: #be123c; }");
    expect(css).toContain("body.schedi-newdash .roster-sheet-actions > button.sd-act");
    expect(today).toContain('<article class="sd-card sd-row');
    expect(today).toContain(" is-next");
    expect(today).not.toContain('role="button"');
    expect(today).not.toContain('tabindex="0"');
    expect(today).not.toContain('aria-haspopup="menu"');
    expect(today).not.toContain("More actions for ");
    expect(today).toContain('aria-label="More actions" aria-expanded="false"><i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i></summary>');
    expect(today).not.toContain(">…</summary>");
    expect(css).not.toContain("#tenantPortalSection.schedi-newdash .sd-card.sd-row { cursor: pointer; }");
    expect(css).not.toContain("#tenantPortalSection.schedi-newdash .sd-card.sd-row:focus-visible");
    expect(css).not.toContain("#tenantPortalSection.schedi-newdash .sd-card.sd-row:active");
    expect(html).not.toContain("event.target.classList.contains('sd-row')");
    expect(html).not.toContain("if (todayCard && todayMenu && !todayControl && !menuHit)");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-more > summary {");
    expect(css).toContain("border: 0;");
    expect(css).toContain("border-radius: 999px;");
    expect(css).toContain("background: transparent;");
    const kebab = css.slice(css.indexOf("#tenantPortalSection.schedi-newdash .sd-more > summary {"), css.indexOf("#tenantPortalSection.schedi-newdash .sd-more > summary i {"));
    expect(kebab).toContain("width: 48px;");
    expect(kebab).toContain("height: 48px;");
    expect(kebab).toContain("min-width: 48px;");
    expect(kebab).toContain("min-height: 48px;");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-more > summary i {\n    font-size: 26px;\n    font-weight: 900;\n    line-height: 1;\n    pointer-events: none;\n    -webkit-text-stroke: 0.5px currentColor;\n    paint-order: stroke fill;\n}");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-more > summary { width: 48px; height: 48px; }");
    expect(unscopedSelectors(dashCss(html))).toEqual([]);
  });

  it("wraps crowded payment chips, keeps the cancel dismiss label, and lines up list prices", () => {
    const css = dashCss(html);
    const line = css.slice(css.indexOf("#tenantPortalSection.schedi-newdash #rosterListWrap .roster-status-line {"));
    const status = line.slice(0, line.indexOf("}"));
    expect(status).toContain("flex-wrap: wrap");
    expect(status).not.toContain("nowrap");
    const payChip = line.slice(line.indexOf(".roster-status-line > .sd-pay {"), line.indexOf(".sd-pay-word"));
    expect(payChip).toContain("min-width: min(100%, max-content)");
    expect(payChip).not.toContain("min-width: 0");
    expect(line.slice(0, line.indexOf("@media (min-width: 1360px)"))).toContain("white-space: nowrap");
    const priceRule = css.slice(css.indexOf("#tenantPortalSection.schedi-newdash .roster-cell-price {"), css.indexOf("#tenantPortalSection.schedi-newdash .roster-status-price"));
    expect(priceRule).toContain("text-align: left");
    const price = extractFunction(html, "rosterListPriceHtml");
    expect(price).toContain("if (!parts.showPrice) return '';");
    expect(price).toContain("return appointmentStatusPriceHtml(app);");
    expect(price).not.toContain("paidMoney");
    const cancel = html.slice(html.indexOf("window.deleteAppointment = async function"), html.indexOf("var ownerConfirmResolve"));
    expect(cancel).toContain("confirmLabel: 'Cancel appointment'");
    expect(cancel).toContain("dismissLabel: 'Keep appointment'");
    const open = html.slice(html.indexOf("window.openOwnerConfirm = function"), html.indexOf("window.closeOwnerConfirm = function"));
    expect(open).toContain("getElementById('ownerConfirmDismiss')");
    expect(open).toContain("opts.dismissLabel || 'Cancel'");
    expect(html).toContain('id="ownerConfirmDismiss"');
    const drew = html.slice(html.indexOf("id: 'HB-1010'"), html.indexOf("id: 'HB-1011'"));
    expect(drew).toContain("paidMethod: 'zelle'");
    expect(drew).toContain("amount: 45");
    expect(html.slice(html.indexOf("id: 'HB-1009'"), html.indexOf("id: 'HB-1010'"))).toContain("amount: 28");
    expect(html.slice(html.indexOf("id: 'HB-1011'"), html.indexOf("id: 'HB-1012'"))).toContain("amount: 65");
    expect(html.slice(html.indexOf("id: 'HB-1012'"), html.indexOf("id: 'HB-1013'"))).toContain("amount: 80");
  });

  it("clears a no-show and restores a no-show status without charging", () => {
    const start = html.indexOf("window.undoAppointmentNoShow = function");
    const end = html.indexOf("window.deleteAppointment = async function");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const src = html.slice(start, end);
    expect(src).toContain("app.noShow = false");
    expect(src).toContain("app.status = 'accepted'");
    expect(src).toContain("saveState()");
    expect(src).toContain("refreshOwnerPaymentSurfaces(tenant)");
    expect(src).toContain("showToast('No-show cleared', 'info')");
    expect(src).not.toMatch(/refund|stripe|sendClient|sendMail|email/i);
    expect(html).toContain("'undoAppointmentNoShow'");
    type Visit = { id: string; status?: string; noShow?: boolean; paymentStatus?: string; refundAmount?: number };
    const undo = new Function(
      "window",
      "getTenant",
      "saveState",
      "refreshOwnerPaymentSurfaces",
      "showToast",
      `${extractFunction(html, "appointmentIsCancelled")}\n${extractFunction(html, "appointmentIsNoShow")}\n${src}\nreturn window.undoAppointmentNoShow;`,
    ) as (
      window: object,
      getTenant: () => { appointments: Visit[] },
      saveState: () => void,
      refreshOwnerPaymentSurfaces: () => void,
      showToast: (message: string) => void,
    ) => (id: string) => void;
    const run = (row: Visit) => {
      const state = { saved: 0, refreshed: 0, toasted: "" };
      const fn = undo(
        {},
        () => ({ appointments: [row] }),
        () => { state.saved += 1; },
        () => { state.refreshed += 1; },
        (message: string) => { state.toasted = message; },
      );
      fn(row.id);
      return { row, ...state };
    };
    const kept = run({ id: "HB-1", status: "accepted", noShow: true, paymentStatus: "PAID IN CASH", refundAmount: 0 });
    expect(kept.row).toMatchObject({ status: "accepted", noShow: false, paymentStatus: "PAID IN CASH", refundAmount: 0 });
    expect(kept).toMatchObject({ saved: 1, refreshed: 1, toasted: "No-show cleared" });
    const fromStatus = run({ id: "HB-2", status: "no_show", noShow: true, paymentStatus: "PAY AT APPOINTMENT" });
    expect(fromStatus.row).toMatchObject({ status: "accepted", noShow: false, paymentStatus: "PAY AT APPOINTMENT" });
    expect(run({ id: "HB-3", status: "no-show" }).row.status).toBe("accepted");
    expect(run({ id: "HB-4", status: "NoShow" }).row).toMatchObject({ status: "accepted", noShow: false });
    const completed = run({ id: "HB-5", status: "completed", noShow: true });
    expect(completed.row).toMatchObject({ status: "completed", noShow: false });
    const pending = run({ id: "HB-6", status: "pending", noShow: true });
    expect(pending.row).toMatchObject({ status: "pending", noShow: false });
    const absent = run({ id: "HB-7", status: "accepted" });
    expect(absent).toMatchObject({ saved: 0, refreshed: 0, toasted: "" });
    expect(absent.row.noShow).toBeUndefined();
    const cancelled = run({ id: "HB-8", status: "cancelled", noShow: true });
    expect(cancelled.row.noShow).toBe(true);
    expect(cancelled.saved).toBe(0);
    const denied = run({ id: "HB-9", status: "denied", noShow: true });
    expect(denied.row).toMatchObject({ status: "denied", noShow: true });
    expect(denied.saved).toBe(0);
    const actions = new Function(
      `${extractFunction(html, "esc")}\n${extractFunction(html, "jsArg")}\n${extractFunction(html, "appointmentIsCancelled")}\n${extractFunction(html, "appointmentIsNoShow")}\n${extractFunction(html, "bookingPaymentState")}\n${extractFunction(html, "rosterActionsHtml")}\nreturn rosterActionsHtml;`,
    )() as (app: Visit, big: boolean) => string;
    const marked = actions({ id: "HB-1005", status: "accepted", noShow: true, paymentStatus: "PAY AT APPOINTMENT" }, false);
    expect(marked).toContain("undoAppointmentNoShow");
    expect(marked).toContain("Undo no-show");
    expect(marked).toContain("fa-rotate-left");
    expect(marked).not.toContain("markAppointmentNoShow");
    const undoButton = marked.slice(marked.lastIndexOf("<button", marked.indexOf("undoAppointmentNoShow")), marked.indexOf("</button>", marked.indexOf("Undo no-show")));
    expect(undoButton).toContain("sd-act");
    expect(undoButton).not.toContain("sd-act-ok");
    expect(undoButton).not.toContain("sd-act-no");
    const clear = actions({ id: "HB-1003", status: "accepted", paymentStatus: "PAY AT APPOINTMENT" }, true);
    expect(clear).toContain("markAppointmentNoShow");
    expect(clear).not.toContain("undoAppointmentNoShow");
    const sheet = actions({ id: "HB-1008", status: "accepted", noShow: true, paymentStatus: "PAID IN CASH" }, true);
    expect(sheet).toContain("rosterApptDo(");
    expect(sheet).toContain("undoAppointmentNoShow");
  });

  it("closes the today actions menu before a menu item and keeps it under modals", () => {
    const close = extractFunction(html, "closeSchediTodayMenus");
    expect(close).toContain("if (event && typeof event.stopPropagation === 'function') event.stopPropagation();");
    expect(close).toContain("el.open = false");
    expect(close).toContain("summary.setAttribute('aria-expanded', 'false')");
    expect(close).not.toContain("card.setAttribute");
    expect(html).toContain("summary.setAttribute('aria-expanded', details.open ? 'true' : 'false')");
    expect(close).toContain("menu.style.visibility = 'hidden'");
    expect(html).toContain("window.closeSchediTodayMenus = closeSchediTodayMenus;");
    expect(html).toContain("if (menuHit) {\n                closeSchediTodayMenus();");
    expect(html).toContain("menu.style.zIndex = '45';");
    const css = dashCss(html);
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-more-menu {\n    position: fixed;\n    z-index: 45;");
    expect(html).toContain("var schediTodayMenuObserver = new MutationObserver");
    expect(html).toContain("attributeFilter: ['class', 'hidden']");
    expect(html).toContain("node.id === 'schediDashMoreSheet'");
    expect(html).toContain("node.id === 'schediDashHelp'");
    expect(html).toContain("node.id === 'sdClientPanel'");
    expect(html).toContain("node.id === 'schediDashAddMenu'");
    expect(unscopedSelectors(css)).toEqual([]);
  });

  it("puts the round close chip and shared switch on every reschedule path", () => {
    const modal = html.slice(html.indexOf('id="tenantRescheduleModal"'), html.indexOf('id="tenantChangePassModal"'));
    expect(modal).toContain("sd-form-sheet");
    expect(modal).toContain("sd-form-head");
    expect(modal).toContain('id="tenantRescheduleTitle"');
    expect(modal).toContain('class="sd-form-close" aria-label="Close"');
    expect(modal).toContain("sd-form-scroll");
    expect(modal).not.toContain("text-slate-400 hover:text-white");
    expect(modal).not.toContain("w-3.5 h-3.5");
    const today = extractFunction(html, "renderSchediToday");
    const actions = extractFunction(html, "rosterActionsHtml");
    expect(today).toContain("openTenantRescheduleModal(");
    expect(actions).toContain("btn('openTenantRescheduleModal', 'sd-act sd-act-ok', '<i class=\"fa-solid fa-calendar-days mr-1\"></i>Reschedule')");
    expect(html).toContain("'openTenantRescheduleModal'");
    const extras = extractFunction(html, "ensureOwnerTimeExtras");
    expect(extras).toContain('class="owner-time-showall sd-pay-switch" role="switch" aria-checked="false"');
    expect(extras).toContain("sd-pay-switch-row");
    expect(extras).toContain("sd-pay-switch-title");
    expect(extras).toContain("Show all times");
    expect(extras).toContain("syncPaySwitchAria(ev.target)");
    expect(extras).not.toContain("w-3.5");
    expect(extractFunction(html, "populateOwnerTimeSelect")).toContain("syncPaySwitchAria(extras.toggle)");
    expect(extractFunction(html, "setManualWalkIn")).toContain("syncPaySwitchAria(showAll)");
    const css = dashCss(html);
    expect(css).toContain("body.schedi-newdash #tenantRescheduleModal { overflow: hidden; }");
    expect(css).toContain("body.schedi-newdash #tenantRescheduleModal .sd-form-sheet {");
    expect(css).toContain("body.schedi-newdash .owner-time-extras .sd-pay-switch {");
    expect(css).toContain("body.schedi-newdash .owner-time-extras .sd-pay-switch-row {");
    expect(css).toContain("body.schedi-newdash .owner-time-extras .sd-pay-switch-title {");
    expect(css).toContain("html.schedi-light body.schedi-newdash .owner-time-extras .sd-pay-switch { background: #cbd5e1; }");
    expect(css).toContain("html.schedi-light body.schedi-newdash .owner-time-extras .sd-pay-switch:checked { background: #059669; }");
    expect(css).toContain("body.schedi-newdash .owner-time-extras .sd-pay-switch:checked { background: #10b981; }");
    expect(unscopedSelectors(css)).toEqual([]);
  });

  it("orders appointment status chips as booking, outcome, payment, then price", () => {
    const api = new Function(`
      ${extractFunction(html, "esc")}
      ${extractFunction(html, "roundMoney")}
      ${extractFunction(html, "hasPricedAmount")}
      ${extractFunction(html, "formatBookingAmountLabel")}
      ${extractFunction(html, "appointmentIsCancelled")}
      ${extractFunction(html, "appointmentIsNoShow")}
      ${extractFunction(html, "bookingPaymentState")}
      ${extractFunction(html, "inferPaidMethodFromBooking")}
      ${extractFunction(html, "appointmentPayKind")}
      ${extractFunction(html, "payKindSvg")}
      var ROSTER_PAY_WORDS = { unpaid: "Unpaid", card: "Card", cashapp: "Cash App", zelle: "Zelle", venmo: "Venmo", paypal: "PayPal", square: "Square", cash: "In person / Cash" };
      ${extractFunction(html, "appointmentPaidChipMoney")}
      ${extractFunction(html, "appointmentPayMarkup")}
      ${extractFunction(html, "noShowPillHtml")}
      ${extractFunction(html, "rosterAcceptedBadge")}
      ${extractFunction(html, "appointmentPaymentSlot")}
      ${extractFunction(html, "appointmentStatusParts")}
      ${extractFunction(html, "appointmentRequestChipHtml")}
      ${extractFunction(html, "appointmentOutcomeChipHtml")}
      ${extractFunction(html, "appointmentStatusPriceHtml")}
      ${extractFunction(html, "appointmentStatusLabels")}
      ${extractFunction(html, "appointmentStatusChipsHtml")}
      return { appointmentStatusLabels, appointmentStatusChipsHtml, appointmentStatusParts };
    `)() as {
      appointmentStatusLabels: (app: Record<string, unknown>, opts?: Record<string, unknown>) => string[];
      appointmentStatusChipsHtml: (app: Record<string, unknown>, opts?: Record<string, unknown>) => string;
      appointmentStatusParts: (app: Record<string, unknown>) => { request: string; outcomes: string[]; payment: string; showPayment: boolean; showPrice: boolean };
    };
    const elena = { status: "accepted", noShow: true, paymentStatus: "PAY AT APPOINTMENT", amount: 120 };
    expect(api.appointmentStatusLabels(elena)).toEqual(["Accepted", "No-show", "Unpaid", "$120"]);
    const chips = api.appointmentStatusChipsHtml(elena);
    expect(chips.indexOf("Accepted")).toBeGreaterThan(-1);
    expect(chips.indexOf("Accepted")).toBeLessThan(chips.indexOf("No-show"));
    expect(chips.indexOf("No-show")).toBeLessThan(chips.indexOf("Unpaid"));
    expect(chips.indexOf("Unpaid")).toBeLessThan(chips.indexOf("$120"));
    expect(chips.indexOf("sd-pill-rose")).toBeGreaterThan(chips.indexOf("Accepted"));
    expect(api.appointmentStatusLabels({ status: "pending", paymentStatus: "PENDING CASH APP", amount: 28 }, { pendingLabel: "New request" })).toEqual(["New request", "Unpaid"]);
    expect(api.appointmentStatusLabels({ status: "requested", paymentStatus: "PAY AT APPOINTMENT" })).toEqual(["Requested", "Unpaid"]);
    expect(api.appointmentStatusLabels({ status: "denied", noShow: true, paymentStatus: "PAY AT APPOINTMENT", amount: 80 })).toEqual(["Denied", "No-show"]);
    expect(api.appointmentStatusLabels({ status: "declined", paymentStatus: "PAY AT APPOINTMENT" })).toEqual(["Declined"]);
    expect(api.appointmentStatusLabels({ status: "cancelled", paymentStatus: "PAID", amount: 65 })).toEqual(["Cancelled"]);
    expect(api.appointmentStatusLabels({ status: "accepted", noShow: true, paymentStatus: "PAID IN CASH", paidMethod: "cash", amount: 65 })).toEqual(["Accepted", "No-show", "Paid · $65"]);
    expect(api.appointmentStatusLabels({ status: "completed", paymentStatus: "PAID", paidMethod: "cash", amount: 65 })).toEqual(["Completed", "Paid · $65"]);
    expect(api.appointmentStatusLabels({ status: "done", paymentStatus: "PAID", amount: 40 })).toEqual(["Done", "Paid · $40"]);
    expect(api.appointmentStatusLabels({ status: "rescheduled", paymentStatus: "PAY AT APPOINTMENT", amount: 28 })).toEqual(["Rescheduled", "Unpaid", "$28"]);
    expect(api.appointmentStatusParts({ status: "accepted", paymentStatus: "DEPOSIT PAID", depositPaid: true, amount: 120 }).payment).toBe("deposit");
    expect(api.appointmentStatusLabels({ status: "accepted", paymentStatus: "DEPOSIT PAID", depositPaid: true, amount: 120 })).toEqual(["Accepted", "Deposit paid · $120"]);
    expect(api.appointmentStatusLabels({ status: "accepted", paymentStatus: "DEPOSIT PAID", depositPaid: true, depositAmount: 36, amount: 120 })).toEqual(["Accepted", "Deposit paid · $36"]);
    expect(api.appointmentStatusLabels({ status: "accepted", paymentStatus: "PAID", refundAmount: 20, amount: 65 })).toEqual(["Accepted", "Refunded · $45"]);
    const deposit = api.appointmentStatusChipsHtml({ status: "accepted", paymentStatus: "DEPOSIT PAID", paidMethod: "card", depositPaid: true, amount: 120 });
    expect(deposit).toContain("Card · $120");
    expect(deposit.indexOf("Accepted")).toBeLessThan(deposit.indexOf("sd-pay-card"));
    expect(deposit.indexOf("sd-pay-card")).toBeLessThan(deposit.indexOf("$120"));
    expect(deposit).not.toContain("text-slate-300");
    const depositRecorded = api.appointmentStatusChipsHtml({ status: "accepted", paymentStatus: "DEPOSIT PAID", paidMethod: "card", depositPaid: true, depositAmount: 36, amount: 120 });
    expect(depositRecorded).toContain('aria-label="Card · $36"');
    expect(depositRecorded).not.toContain("$120");
    expect(depositRecorded).not.toContain("text-slate-300");
    const zelle = api.appointmentStatusChipsHtml({ status: "accepted", paymentStatus: "PAID ZELLE", paidMethod: "zelle", amount: 65 });
    expect(zelle).toContain('aria-label="Zelle · $65"');
    expect(zelle).toContain(">Zelle<");
    expect(zelle).toContain('class="sd-pay-amt"> · $65<');
    expect(zelle).not.toContain("text-slate-300");
    const unpaidChip = api.appointmentStatusChipsHtml(elena);
    expect(unpaidChip).toContain("Unpaid");
    expect(unpaidChip).not.toContain("Unpaid ·");
    expect(unpaidChip).toContain("$120");
    const refunded = api.appointmentStatusChipsHtml({ status: "accepted", paymentStatus: "PAID", paidMethod: "cash", refundAmount: 20, amount: 65 });
    expect(refunded).toContain('aria-label="In person / Cash · $45"');
    expect(refunded).toContain(">In person / Cash<");
    expect(refunded).toContain('class="sd-pay-amt"> · $45<');
    expect(refunded).not.toContain("$65");
    expect(refunded).not.toContain("text-slate-300");
    const historyPaid = api.appointmentStatusChipsHtml({ status: "completed", paymentStatus: "PAID", paidMethod: "zelle", amount: 65 }, { priceHtml: "<span>$65</span>" });
    expect(historyPaid).toContain(">Zelle<");
    expect(historyPaid).toContain('class="sd-pay-amt"> · $65<');
    expect(historyPaid).not.toContain("<span>$65</span>");
    const historyUnpaid = api.appointmentStatusChipsHtml(elena, { priceHtml: "<span>$120</span>" });
    expect(historyUnpaid).toContain("Unpaid");
    expect(historyUnpaid).toContain("$120");
    const source = extractFunction(html, "appointmentStatusChipsHtml");
    expect(source.indexOf("appointmentRequestChipHtml")).toBeLessThan(source.indexOf("appointmentOutcomeChipHtml"));
    expect(source.indexOf("appointmentOutcomeChipHtml")).toBeLessThan(source.indexOf("appointmentPayMarkup"));
    expect(source.indexOf("appointmentPayMarkup")).toBeLessThan(source.indexOf("appointmentStatusPriceHtml"));
    expect(extractFunction(html, "renderSchediToday")).toContain("pendingLabel: 'New request'");
    expect(extractFunction(html, "clientHistoryGroupHtml")).toContain("appointmentStatusChipsHtml");
    expect(extractFunction(html, "renderRosterSearchResults")).toContain("appointmentStatusChipsHtml");
    expect(extractFunction(html, "rosterStatusCellHtml").indexOf("appointmentStatusChipsHtml")).toBeLessThan(extractFunction(html, "rosterStatusCellHtml").indexOf("depositRosterLine"));
    const depositLine = extractFunction(html, "depositRosterLine");
    expect(depositLine).toContain("formatBookingAmountLabel(dep)");
    expect(depositLine).toContain("formatBookingAmountLabel(roundMoney(bal))");
    expect(depositLine).not.toContain("toFixed");
  });

  it("keeps light-mode status chips readable and hides disabled mark-paid methods", () => {
    const css = dashCss(html);
    expect(css).toContain("html.schedi-light #tenantPortalSection.schedi-newdash .text-sky-300,");
    expect(css).toContain("html.schedi-light body.schedi-newdash #rosterApptModal .text-sky-400 { color: #0369a1 !important; }");
    expect(css).toContain("html.schedi-light #tenantPortalSection.schedi-newdash .text-rose-300,");
    expect(css).toContain("html.schedi-light body.schedi-newdash #rosterApptModal .text-rose-400 { color: #be123c !important; }");
    expect(css).toContain("html.schedi-light #tenantPortalSection.schedi-newdash .sd-pill-amber,");
    expect(css).toContain("html.schedi-light body.schedi-newdash #rosterApptModal .sd-pill-amber { color: #92400e !important; }");
    const today = extractFunction(html, "renderSchediToday");
    expect(today).toContain('class="sd-row-head"');
    expect(today).toContain('class="sd-row-chips"');
    expect(css).toContain('grid-template-areas: "time side more" "main main main";');
    expect(css).toContain(".sd-row-title { width: 100%; overflow: visible; text-overflow: clip; white-space: normal; }");
    const methods = new Function(`
      var OWNER_PAY_METHODS = [
        ["card", "Card"], ["cashapp", "Cash App"], ["zelle", "Zelle"], ["venmo", "Venmo"],
        ["paypal", "PayPal"], ["square", "Square"], ["cash", "In person / Cash"]
      ];
      ${extractFunction(html, "ownerMarkPaidMethods")}
      return ownerMarkPaidMethods;
    `)() as (tenant: { paymentGateways?: Record<string, boolean> }) => string[][];
    expect(methods({ paymentGateways: { card: false, cashapp: true, zelle: true, venmo: true, paypal: false, later: true } }).map((row) => row[0])).toEqual(["cashapp", "zelle", "venmo", "cash"]);
    expect(methods({ paymentGateways: { card: true, square: true, later: false } }).map((row) => row[0])).toEqual(["card", "cash"]);
    expect(methods({ paymentGateways: { card: false, square: true, paypal: true } }).map((row) => row[0])).toEqual(["paypal", "cash"]);
    expect(methods({ paymentGateways: {} }).map((row) => row[0])).toEqual(["cash"]);
    const paint = extractFunction(html, "paintRosterPaidMethodOptions");
    expect(paint).toContain("ownerMarkPaidMethods");
    expect(paint).toContain("Card (Stripe)");
    expect(paint).not.toContain("OWNER_PAY_METHODS.map");
    expect(extractFunction(html, "ownerMarkPaidMethods")).toContain("row[0] === 'square'");
    expect(html).toContain("['card', 'Card', 'Card']");
    expect(html).toContain("if (!method || !allowed) return;");
    const logChoices = new Function(`
      var OWNER_PAY_METHODS = [
        ["card", "Card"], ["cashapp", "Cash App"], ["zelle", "Zelle"], ["venmo", "Venmo"],
        ["paypal", "PayPal"], ["square", "Square"], ["cash", "In person / Cash"]
      ];
      var MANUAL_PAY_CHOICES = [
        { value: "PAID VIA CARD", method: "card", label: "Card" },
        { value: "PAID CASH APP", method: "cashapp", label: "Cash App" },
        { value: "PAID ZELLE", method: "zelle", label: "Zelle" },
        { value: "PAID VENMO", method: "venmo", label: "Venmo" },
        { value: "PAID PAYPAL", method: "paypal", label: "PayPal" },
        { value: "PAID SQUARE", method: "square", label: "Square" },
        { value: "PAID IN CASH", method: "cash", label: "In person / Cash" },
        { value: "PAY AT APPOINTMENT", method: "later", label: "Unpaid", unpaid: true }
      ];
      ${extractFunction(html, "ownerMarkPaidMethods")}
      ${extractFunction(html, "manualPayFromStatus")}
      ${extractFunction(html, "ownerLogPayChoices")}
      return ownerLogPayChoices;
    `)() as (tenant: { paymentGateways?: Record<string, boolean> }, status: string) => { method: string }[];
    expect(logChoices({ paymentGateways: { card: false, cashapp: true, zelle: true, venmo: true, paypal: false } }, "PAY AT APPOINTMENT").map((row) => row.method)).toEqual(["cashapp", "zelle", "venmo", "cash", "later"]);
    expect(logChoices({ paymentGateways: { card: true, square: true } }, "PAY AT APPOINTMENT").map((row) => row.method)).toEqual(["card", "cash", "later"]);
    expect(logChoices({ paymentGateways: {} }, "PAID SQUARE").map((row) => row.method)).toEqual(["square", "cash", "later"]);
    expect(logChoices({ paymentGateways: { card: false } }, "PAID VIA CARD").map((row) => row.method)).toEqual(["card", "cash", "later"]);
    const filterRows = new Function(`
      var OWNER_PAY_METHODS = [
        ["card", "Card", "Card"], ["cashapp", "Cash App", "Cash App"], ["zelle", "Zelle", "Zelle"],
        ["venmo", "Venmo", "Venmo"], ["paypal", "PayPal", "PayPal"], ["square", "Square", "Square"],
        ["cash", "In person / Cash", "In person / Cash"]
      ];
      var ROSTER_PAY_FILTERS = [["all", "All"]].concat(OWNER_PAY_METHODS.map(function (row) {
        return [row[0], row[1]];
      })).concat([["unpaid", "Unpaid"]]);
      function bookingPaymentState(app) {
        var up = String((app && app.paymentStatus) || "").toUpperCase();
        if (up.indexOf("PAID") !== -1 && up.indexOf("UNPAID") === -1) return "paid";
        return "unpaid";
      }
      function appointmentPayKind(app) {
        if (bookingPaymentState(app) !== "paid") return "unpaid";
        var explicit = String((app && app.paidMethod) || "").toLowerCase();
        if (explicit) return explicit;
        var status = String((app && app.paymentStatus) || "").toUpperCase();
        if (status.indexOf("CARD") !== -1 || status.indexOf("STRIPE") !== -1) return "card";
        if (status.indexOf("SQUARE") !== -1) return "square";
        if (status.indexOf("PAYPAL") !== -1) return "paypal";
        return "cash";
      }
      ${extractFunction(html, "ownerMarkPaidMethods")}
      ${extractFunction(html, "rosterPayFilterRows")}
      return rosterPayFilterRows;
    `)() as (tenant: { paymentGateways?: Record<string, boolean> }, apps: { paymentStatus?: string; paidMethod?: string }[]) => string[][];
    const harbor = { paymentGateways: { card: false, cashapp: true, zelle: true, venmo: true, paypal: false } };
    const harborApps = [
      { paymentStatus: "PAID VIA CARD", paidMethod: "card" },
      { paymentStatus: "PAID SQUARE", paidMethod: "square" },
      { paymentStatus: "PAID PAYPAL", paidMethod: "paypal" },
      { paymentStatus: "PAY AT APPOINTMENT" },
    ];
    expect(filterRows(harbor, harborApps).map((row) => row[0])).toEqual(["all", "card", "cashapp", "zelle", "venmo", "paypal", "square", "cash", "unpaid"]);
    expect(filterRows({ paymentGateways: { cashapp: true } }, []).map((row) => row[0])).toEqual(["all", "cashapp", "cash", "unpaid"]);
    expect(filterRows({ paymentGateways: {} }, [{ paymentStatus: "PAID VIA CARD", paidMethod: "card" }]).map((row) => row[0])).toEqual(["all", "card", "cash", "unpaid"]);
    expect(extractFunction(html, "renderRosterPayFilter")).toContain("rosterPayFilterRows");
    expect(html).toContain("row[0] === 'cash' ? 'Cash' : row[1]");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-chip { min-height: 36px; border-radius: 999px; border: 1px solid var(--sd-line); background: transparent; color: var(--sd-text); font-weight: 800; font-size: 12px; padding: 4px 10px; display: inline-flex; align-items: center; flex: none; white-space: nowrap; }");
    expect(extractFunction(html, "manualBookingFieldsUntouched")).toContain("manualBookingOpenedSnapshot");
    const submit = html.slice(html.indexOf("window.handleManualBookingSubmit = function"), html.indexOf("function appointmentReportRows"));
    expect(submit).toContain("if (window.__manualBookingDismissed) return;");
    expect(submit).toContain("manualBookingFieldsUntouched()");
    expect(submit.indexOf("manualBookingFieldsUntouched()")).toBeLessThan(submit.indexOf("Updated appointment"));
    expect(extractFunction(html, "paintManualPayChoices")).toContain("paintStatusPayChoices('manPaymentChoices'");
    expect(extractFunction(html, "paintOwnerRecurPayChoices")).toContain("paintStatusPayChoices('ownerRecurPaymentChoices'");
    expect(extractFunction(html, "paintStatusPayChoices")).toContain("ownerLogPayChoices");
    expect(extractFunction(html, "paintStatusPayChoices")).toContain("paintOwnerPayRadios");
    expect(html).toContain('id="manPaymentChoices" class="sd-pay-choices" role="radiogroup"');
    expect(html).toContain('id="ownerRecurPaymentChoices" class="sd-pay-choices" role="radiogroup"');
    const recur = html.slice(html.indexOf("window.handleOwnerRecurringSubmit"), html.indexOf("window.schediDashToggleMore"));
    expect(recur).toContain("ownerRecurPayment");
    expect(recur).toContain("booking.paidMethod = payChoice.method");
  });

  it("uses one sliding pill for the phone tab bar", () => {
    const css = dashCss(html);
    const barStart = css.indexOf("#tenantPortalSection.schedi-newdash #schediDashTabbar {");
    const bar = css.slice(barStart, css.indexOf("@media (min-width: 860px)", barStart));
    expect(bar).toContain("left: 0;");
    expect(bar).toContain("right: 0;");
    expect(bar).toContain("bottom: 0;");
    expect(bar).toContain("width: 100vw;");
    expect(bar).toContain("max-width: 100vw;");
    expect(dashCss(html)).toContain("#tenantPortalSection.schedi-newdash .sd-pay { position: relative;");
    expect(bar).toContain("background: #0b1220;");
    expect(bar).toContain("border-top: 1px solid rgba(148, 163, 184, 0.32);");
    expect(bar).toContain("border-radius: 0;");
    expect(bar).toContain("padding: 8px 0 calc(8px + env(safe-area-inset-bottom));");
    expect(bar).not.toContain("left: max(10px");
    expect(bar).not.toContain("border-radius: 12px");
    expect(bar).not.toContain("border: 1px solid #64748b");
    expect(bar).toContain("border-top-color: #e2e8f0;");
    expect(bar).toContain("background: #ffffff;");
    expect(bar).toContain("color: #a3b1c6;");
    expect(bar).toContain("color: #3f4b5e;");
    expect(bar).toContain("color: #34d399;");
    expect(bar).toContain("color: #047857;");
    expect(bar).toContain("font-family: Inter, sans-serif;");
    expect(bar).toContain("font-size: 12px;");
    expect(bar).toContain("font-weight: 700;");
    expect(bar).toContain("font-size: 22px;");
    expect(bar).toContain("background: rgba(16, 185, 129, 0.15);");
    expect(bar).toContain("border-radius: 14px;");
    expect(bar).toContain("width: 28px;");
    expect(bar).toContain("height: 3px;");
    expect(bar).toContain("transform: translateX(calc(var(--sd-tab-slot, 0) * 100%));");
    expect(bar).toContain("transition: transform 200ms ease-out;");
    expect(bar).toContain("transition: color 200ms ease-out;");
    expect(bar).toContain("grid-template-columns: repeat(5, minmax(0, 1fr));");
    expect(bar).toContain("width: 20%;");
    expect(bar).toContain("width: 52px;");
    expect(bar).toContain("height: 52px;");
    expect(bar).toContain("margin: -6px auto 0;");
    expect(bar).toContain(".sd-fab");
    expect(bar).not.toContain("margin: -20px");
    expect(bar).toContain("background: #10b981;");
    expect(bar).toContain("prefers-reduced-motion: reduce");
    expect(bar).toContain("transition: none;");
    const nav = html.slice(html.indexOf('id="schediDashTabbar"'), html.indexOf('id="schediDashAccountMenu"'));
    expect(nav).toContain('class="sd-tab-indicator"');
    expect(nav).toContain("sd-fab");
    expect(nav).toContain('aria-label="Add appointment"');
    expect(nav).toContain("schediDashToggleAdd");
    expect(nav).not.toContain("<span>Add");
    expect(nav.indexOf(">Agenda<")).toBeLessThan(nav.indexOf(">Clients<"));
    expect(nav.indexOf(">Clients<")).toBeLessThan(nav.indexOf("sd-fab"));
    expect(nav.indexOf("sd-fab")).toBeLessThan(nav.indexOf(">Calendar<"));
    expect(nav.indexOf(">Calendar<")).toBeLessThan(nav.indexOf(">More<"));
    const setPage = extractFunction(html, "schediDashSetPage");
    expect(setPage).toContain("setAttribute('aria-current', 'page')");
    expect(setPage).toContain("'--sd-tab-slot'");
    expect(setPage).toContain("schediDashTabSlot(current)");
    const slot = new Function(`${extractFunction(html, "schediDashTabSlot")}; return schediDashTabSlot;`)() as (page: string) => number;
    expect(slot("today")).toBe(0);
    expect(slot("clients")).toBe(1);
    expect(slot("appointments")).toBe(3);
    expect(slot("hours")).toBe(4);
    expect(slot("services")).toBe(4);
    expect(slot("payments")).toBe(4);
    expect(slot("reports")).toBe(4);
    expect([slot("today"), slot("clients"), slot("appointments"), slot("hours"), slot("reports")]).not.toContain(2);
  });

  it("holds the add chooser highlight and pins the form close and actions", () => {
    const css = dashCss(html);
    expect(css).toContain("#schediDashAddMenu button.is-picked");
    expect(css).toContain("transform: scale(0.97);");
    expect(css).toContain("0 0 18px rgba(16, 185, 129, 0.55)");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("transform: none;");
    expect(css).toContain("min-height: 48px;");
    expect(css).toContain(".sd-form-close i { font-size: 22px;");
    expect(css).toContain("gap: 12px;");
    expect(css).toContain("min-height: 54px;");
    expect(css).toContain("font-size: 17px;");
    expect(css).toContain("font-weight: 800;");
    expect(css).toContain("env(safe-area-inset-bottom, 0px)");
    expect(css).toContain("background: #10b981;");
    expect(css).toContain("background: #1e293b;");
    expect(css).toContain("background: #f1f5f9;");
    expect(css).toContain("border: 1px solid #cbd5e1;");
    const addKind = html.slice(html.indexOf("window.schediDashAddKind = function"), html.indexOf("var OWNER_SERIES_MAX"));
    expect(addKind).toContain("is-picked");
    expect(addKind).toContain("prefers-reduced-motion: reduce");
    expect(addKind).toContain("setTimeout");
    expect(addKind).toContain(", 200)");
    expect(addKind).toContain("openOwnerRecurringModal()");
    expect(addKind).toContain("setManualWalkIn(true, true)");
    expect(addKind).toContain("requestAnimationFrame");
    expect(html).toContain("schediDashAddKind(addKind.getAttribute('data-dash-add'), addKind)");
    expect(html).toContain('class="sd-form-close" onpointerdown="window.__manualBookingDismissed=true" onclick="closeManualBookingModal()" aria-label="Close"');
    expect(html).toContain('class="sd-form-close" onclick="closeOwnerRecurringModal()" aria-label="Close"');
    expect(html).toContain('form="manualBookingForm"');
    expect(html).toContain('form="ownerRecurringForm"');
    expect(html).toContain('class="sd-form-bar"');
    expect(html).toContain(">Log Appointment</button>");
    expect(html).toContain(">Save series</button>");
    expect(html).toContain(">Cancel</button>");
  });

  it("shares the round close chip on sheets and modals", () => {
    const css = dashCss(html);
    expect(css).toContain("body.schedi-newdash .sd-form-close,");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-form-close {");
    expect(css).toContain("width: 48px;");
    expect(css).toContain("height: 48px;");
    expect(css).toContain("border-radius: 999px;");
    expect(css).toContain("background: #1e293b;");
    expect(css).toContain("background: #f1f5f9;");
    expect(css).toContain("border: 1px solid #cbd5e1;");
    expect(css).toContain(".sd-form-close i { font-size: 22px;");
    expect(css).toContain(".sd-sheet-bar {\n    display: flex;");
    expect(css).toContain("position: sticky;");
    const markers = [
      'onclick="schediDashToggleMore(false)"',
      'onclick="schediDashHelp(false)"',
      'id="sdClientPanelClose"',
      'id="sdSeriesPreviewClose"',
      'onclick="closeSubPaymentModal()"',
      'onclick="closeComparePlansModal()"',
      'onclick="closeClientImport()"',
      'onclick="closeTenantRescheduleModal()"',
      'onclick="closeTenantChangePassModal()"',
      'onclick="closeTenantForgotModal()"',
      'onclick="closeAddBlockedTimeModal()"',
      'onclick="closeAddDateBlockModal()"',
      'onclick="closeAddSpecialHoursModal()"',
      'onclick="closeAddServiceModal()"',
      'onclick="closeRosterApptModal()"',
      'onclick="closeManualBookingModal()"',
      'onclick="closeOwnerRecurringModal()"',
    ];
    for (const marker of markers) {
      const at = html.indexOf(marker);
      expect(at, marker).toBeGreaterThan(-1);
      const start = html.lastIndexOf("<button", at);
      const button = html.slice(start, html.indexOf("</button>", at));
      expect(button, marker).toContain("sd-form-close");
      expect(button, marker).toContain('aria-label="Close"');
      expect(button, marker).toContain("fa-xmark");
    }
    expect(html).not.toContain('aria-label="Close help"');
    expect(unscopedSelectors(css)).toEqual([]);
  });

  it("fits service icon labels and pins the service close", () => {
    const css = dashCss(html);
    expect(html).toContain("var nameClass = 'sd-icon-name'");
    expect(html).toContain("is-long");
    expect(html).toContain("is-wrap");
    expect(html).toContain("trimmed.length > 5");
    expect(html).toContain("/\\s/.test(trimmed)");
    expect(html).not.toContain('class="truncate w-full text-center"');
    expect(html).toContain('class="sd-svc-sheet');
    expect(html).toContain('class="sd-form-head"');
    expect(css).toContain("body.schedi-newdash #svcIconGrid .sd-icon-name.is-long {");
    expect(css).toContain("body.schedi-newdash #svcIconGrid .sd-icon-name.is-wrap {");
    expect(css).toContain("font-size: clamp(11px, 20cqi, 13px);");
    expect(css).toContain("letter-spacing: -0.04em;");
    expect(css).toContain("overflow-wrap: normal;");
    expect(css).toContain("text-overflow: clip;");
    expect(css).toContain("container-type: inline-size;");
    expect(css).toContain("height: 100svh;");
    expect(css).toContain("body.schedi-newdash #tenantServiceModal > .sd-svc-sheet {");
    expect(css).toContain("z-index: 90;");
    expect(unscopedSelectors(css)).toEqual([]);
  });

  it("pins the compare plans and roster appointment headers", () => {
    const css = dashCss(html);
    expect(html).toContain('id="comparePlansModalBody" class="sd-form-scroll overflow-x-auto"');
    expect(html).toContain('class="sd-plans-foot"');
    expect(html).toContain('id="rosterApptBody" class="space-y-4 text-xs sd-form-scroll"');
    expect(html).toContain("sheetBody.scrollTop = 0");
    expect(html).toContain("body.scrollTop = 0;\n            modal.classList.remove('hidden');\n            modal.scrollTop = 0;");
    expect(css).toContain("body.schedi-newdash #comparePlansModal,\nbody.schedi-newdash #rosterApptModal,\nbody.schedi-newdash #tenantRescheduleModal { overflow: hidden; }");
    expect(css).toContain("body.schedi-newdash #comparePlansModal .sd-plans-foot {");
    expect(css).toContain("body.schedi-newdash #rosterApptModal > .sd-form-sheet");
    expect(css).toContain("max-height: 94dvh;");
    expect(unscopedSelectors(css)).toEqual([]);
  });

  it("puts client actions beside the details and uses the business mark on every avatar", () => {
    const row = html.slice(html.indexOf("sd-client-copy"), html.indexOf("function clientTagsHtml"));
    expect(row.indexOf("sd-client-copy")).toBeLessThan(row.indexOf("sd-client-contact"));
    expect(row.indexOf("sd-client-contact")).toBeLessThan(row.indexOf("sd-client-actions"));
    const css = dashCss(html);
    const phone = css.slice(css.indexOf("@media (max-width: 859px)"));
    expect(phone).toContain("#tenantPortalSection.schedi-newdash .sd-client-actions button { flex: 0 0 auto; }");
    expect(phone).not.toContain(".sd-client-actions { width: 100%; }");
    expect(phone).toContain("#tenantPortalSection.schedi-newdash .sd-client-head { flex-wrap: nowrap; align-items: center; }");
    expect(phone).toContain("#tenantPortalSection.schedi-newdash .sd-client-actions { width: auto; margin-left: auto; align-self: center; }");
    expect(css).not.toContain(".sd-client-copy { flex-basis: 100%; }");
    const head = css.slice(css.indexOf("#tenantPortalSection.schedi-newdash .sd-client-head {"), css.indexOf("#tenantPortalSection.schedi-newdash .sd-client-copy {"));
    expect(head).toContain("flex-wrap: nowrap");
    expect(head).toContain("align-items: center");
    const svcNarrow = css.slice(css.indexOf("@media (max-width: 420px)"), css.indexOf("@media (min-width: 768px) and (max-width: 1099px)"));
    expect(svcNarrow).toContain("#tenantPortalSection.schedi-newdash #tenantServicesGrid .sd-svc-actions {");
    expect(svcNarrow.slice(svcNarrow.indexOf(".sd-svc-actions {"), svcNarrow.indexOf(".sd-svc-actions > button"))).toContain("flex-direction: row");
    expect(svcNarrow).not.toContain("flex-direction: column");
    expect(css).toContain("@media (min-width: 860px)");
    expect(css).toContain("#tenantPortalSection.schedi-newdash #schediDashTop .sd-theme { display: none; }");
    expect(html).toContain('id="schediDashUserLogoPhone"');
    const paint = extractFunction(html, "schediDashPaint");
    expect(paint).toContain("schediDashInitials(bizName)");
    expect(paint).not.toContain("schediDashInitials(who)");
    expect(paint).toContain("schediDashUserLogoPhone");
    expect(paint).toContain("schediDashApplyLogo(phoneLogo, phoneInitials)");
  });

  it("gives classic roster icons an intrinsic size outside the new dashboard stylesheet", () => {
    expect(extractFunction(html, "payKindSvg")).toContain('width="16" height="16"');
    expect(extractFunction(html, "serviceSvg")).toContain('width="16" height="16"');
    const start = html.indexOf('<style id="schediClassicRoster">');
    const end = html.indexOf("</style>", start);
    const classic = html.slice(start, end);
    expect(classic).toContain("#tenantPortalSection:not(.schedi-newdash)");
    expect(classic).toContain("#tenantPortalSection:not(.schedi-newdash) .sd-pay svg,\n#tenantPortalSection:not(.schedi-newdash) .sd-chip svg { width: 14px; height: 14px;");
    expect(classic).toContain(".sd-svc-mark svg");
    expect(classic).toContain(".roster-paid-kicker { display: none; }");
    expect(classic).toContain(".sd-roster-search-toggle { display: none; }");
    expect(classic).toContain(".sd-roster-all { display: none; }");
    expect(dashCss(html)).not.toContain(":not(.schedi-newdash)");
    expect(unscopedSelectors(dashCss(html))).toEqual([]);
  });

  it("centers a visible owner sign-in inside the desktop new-dashboard shell", () => {
    const css = dashCss(html);
    const at = css.indexOf("@media (min-width: 860px) {\n    #tenantPortalSection.schedi-newdash:has(> #tenantLoginBox:not(.hidden))");
    expect(at).toBeGreaterThan(0);
    const rule = css.slice(at, css.indexOf("#tenantPortalSection.schedi-newdash .sd-pay-radio input") > at ? css.length : at + 900);
    expect(rule).toContain("justify-content: center");
    expect(rule).toContain("align-items: center");
    expect(rule).toContain("min-height: 100dvh");
    expect(unscopedSelectors(css)).toEqual([]);
    const classicStart = html.indexOf('<style id="schediClassicRoster">');
    const classic = html.slice(classicStart, html.indexOf("</style>", classicStart));
    expect(classic).toContain("#tenantPortalSection:not(.schedi-newdash):has(> #tenantLoginBox:not(.hidden))");
    expect(classic).toContain("@media (min-width: 860px)");
  });
});

const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

describe.skipIf(!chrome)("owner dashboard demo browser", () => {
  it("loads sample data and sends no write requests", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const requests: { url: string; method: string }[] = [];
    const errors: string[] = [];
    try {
      const page = await browser.newPage();
      page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => {
        const people = document.getElementById("schediStatPeople");
        const waiting = document.querySelectorAll("#schediTodayRequests .sd-request").length;
        return people?.textContent === "2" && waiting === 3 && document.body.textContent?.includes("Maya Chen");
      }, { timeout: 20000 });
      const stats = await page.evaluate(() => {
        const tenant = (window as unknown as { getTenant: () => { appointments: { id: string; date?: string; status?: string; amount?: number }[] } }).getTenant();
        const today = tenant.appointments.find((app) => app.id === "HB-1001")?.date || "";
        const parts = today.split("-").map((part) => Number(part));
        const cursor = new Date(parts[0], parts[1] - 1, parts[2]);
        cursor.setDate(cursor.getDate() - cursor.getDay());
        const iso = (date: Date) => date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
        const start = iso(cursor);
        cursor.setDate(cursor.getDate() + 6);
        const end = iso(cursor);
        let visits = 0;
        tenant.appointments.forEach((app) => {
          const status = String(app.status || "").toLowerCase();
          if (status === "cancelled" || status === "canceled" || status === "denied") return;
          if (!app.date || app.date < start || app.date > end) return;
          visits += 1;
        });
        return {
          week: document.getElementById("schediStatWeekVisits")?.textContent,
          weekExpected: String(visits),
          owed: document.getElementById("schediStatOwed")?.textContent,
          people: document.getElementById("schediStatPeople")?.textContent,
          setup: document.getElementById("schediSetupTitle")?.textContent,
          setupCount: document.getElementById("schediSetupCount")?.textContent,
          dash: document.body.classList.contains("schedi-newdash"),
          demo: document.getElementById("schediDemoNote")?.hidden === false,
        };
      });
      expect(stats.dash).toBe(true);
      expect(stats.demo).toBe(true);
      expect(stats.setup).toBe("Get your page ready");
      expect(stats.setupCount).toBe("5 of 6");
      expect(stats.people).toBe("2");
      expect(stats.owed).toMatch(/^\$\d+/);
      expect(stats.week).toBe(stats.weekExpected);
      const pendingDates = await page.evaluate(() => {
        const tenant = (window as unknown as { getTenant: () => { appointments: { id?: string; date?: string; status?: string }[] } }).getTenant();
        const today = tenant.appointments.find((app) => app.id === "HB-1001")?.date || "";
        const pending = tenant.appointments.filter((app) => String(app.status || "").toLowerCase() === "pending");
        return { today, rows: pending.map((app) => ({ id: app.id || "", date: app.date || "" })) };
      });
      expect(pendingDates.rows.map((row) => row.id).sort()).toEqual(["HB-1002", "HB-1004", "HB-1031"]);
      pendingDates.rows.forEach((row) => expect(row.date > pendingDates.today).toBe(true));
      const accept = await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((node) => node.textContent === "Accept");
        if (!button) return "missing";
        (button as HTMLButtonElement).click();
        return String(document.querySelectorAll("#schediTodayRequests .sd-request").length);
      });
      expect(accept).toBe("2");
      const decline = await page.evaluate(() => {
        window.confirm = () => { throw new Error("browser confirm"); };
        const button = [...document.querySelectorAll("#schediTodayRequests button")].find((node) => node.textContent === "Decline");
        if (!button) return { open: false, title: "missing" };
        (button as HTMLButtonElement).click();
        const modal = document.getElementById("denyConfirmModal");
        return {
          open: !!modal && !modal.classList.contains("hidden"),
          title: document.getElementById("denyConfirmTitle")?.textContent || "",
          centered: modal ? getComputedStyle(modal).alignItems : "",
        };
      });
      expect(decline.open).toBe(true);
      expect(decline.title).toMatch(/Decline/);
      const kept = await page.evaluate(() => {
        (document.getElementById("denyConfirmKeep") as HTMLButtonElement).click();
        return {
          hidden: document.getElementById("denyConfirmModal")?.classList.contains("hidden") === true,
          review: String(document.querySelectorAll("#schediTodayRequests .sd-request").length),
        };
      });
      expect(kept).toEqual({ hidden: true, review: "2" });
      const declined = await page.evaluate(() => {
        const button = [...document.querySelectorAll("#schediTodayRequests button")].find((node) => node.textContent === "Decline");
        (button as HTMLButtonElement).click();
        (document.getElementById("denyConfirmBtn") as HTMLButtonElement).click();
        return String(document.querySelectorAll("#schediTodayRequests .sd-request").length);
      });
      expect(declined).toBe("1");
      const paidFlip = await page.evaluate(async () => {
        const w = window as unknown as {
          markAppointmentPaid: (id: string) => void;
          confirmRosterMarkPaid: () => Promise<void>;
          getTenant: () => { appointments: { id: string; paymentStatus?: string; paidMethod?: string }[] };
          schediDashGo: (page: string) => void;
          setRosterCalendarView: (view: string) => void;
          setRosterPayFilter: (kind: string) => void;
          openClientDetail: (id: string) => void;
        };
        const unpaidBefore = document.getElementById("schediStatOwed")?.textContent || "";
        w.markAppointmentPaid("HB-1003");
        const cash = document.querySelector('#rosterPaidMethodOptions [data-paid-method="cash"]') as HTMLButtonElement | null;
        if (!cash) throw new Error("cash method missing");
        cash.click();
        await w.confirmRosterMarkPaid();
        const row = [...document.querySelectorAll("#schediTodaySchedule article")].find((node) => node.textContent?.includes("Jordan"));
        const pill = row?.querySelector(".sd-pay");
        const maya = [...document.querySelectorAll("#schediTodaySchedule article")].find((node) => node.textContent?.includes("Maya"));
        w.schediDashGo("appointments");
        const chips = [...document.querySelectorAll("#rosterPayFilter .sd-chip")].map((node) => node.textContent || "");
        w.setRosterPayFilter("cashapp");
        const cashRows = [...document.querySelectorAll("#tenantRosterTableBody tr")].map((node) => node.textContent || "");
        w.setRosterPayFilter("all");
        const list = document.querySelector('[data-booking-id="HB-1003"] .roster-cell-pay')?.textContent || "";
        w.setRosterCalendarView("week");
        const weekJordan = [...document.querySelectorAll("#rosterCalendarWrap .roster-appt")].find((node) => node.textContent?.includes("Jordan"));
        w.setRosterCalendarView("month");
        const monthJordan = [...document.querySelectorAll("#rosterCalendarWrap .roster-month-day")].find((node) => node.textContent?.includes("Jordan"));
        w.schediDashGo("clients");
        for (let i = 0; i < 20 && !document.getElementById("clientListBody")?.textContent?.includes("Jordan"); i++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        w.openClientDetail("CL-JORDAN");
        const saved = w.getTenant().appointments.find((item) => item.id === "HB-1003");
        return {
          unpaidBefore,
          unpaid: document.getElementById("schediStatOwed")?.textContent || "",
          pill: pill?.textContent || "",
          pillClass: pill?.className || "",
          maya: maya?.querySelector(".sd-pay")?.textContent || "",
          chips,
          cashRows,
          menu: row?.querySelector(".sd-more-menu")?.textContent || "",
          list,
          week: weekJordan?.textContent || "",
          month: monthJordan?.textContent || "",
          history: document.getElementById("sdClientPanel")?.textContent || "",
          status: saved?.paymentStatus || "",
          method: saved?.paidMethod || "",
        };
      });
      const owedNumber = (value: string) => Number(String(value).replace(/[^0-9.]/g, ""));
      expect(owedNumber(paidFlip.unpaidBefore) - owedNumber(paidFlip.unpaid)).toBe(80);
      expect(paidFlip.pill).toContain("In person / Cash · $80");
      expect(paidFlip.pillClass).toContain("sd-pay-cash");
      expect(paidFlip.maya).toContain("Card · $65");
      expect(paidFlip.chips.join(" ")).toMatch(/Card/);
      expect(paidFlip.chips.join(" ")).toMatch(/Cash App/);
      expect(paidFlip.chips.join(" ")).toMatch(/PayPal/);
      expect(paidFlip.chips.join(" ")).toMatch(/Unpaid/);
      expect(paidFlip.cashRows.length).toBeGreaterThan(0);
      expect(paidFlip.cashRows.every((row) => row.includes("Cash App"))).toBe(true);
      expect(paidFlip.menu).toContain("Mark unpaid");
      expect(paidFlip.menu).not.toContain("Mark paid");
      expect(paidFlip.list).toContain("In person / Cash");
      expect(paidFlip.week).toContain("Jordan");
      expect(paidFlip.week).toContain("In person / Cash");
      expect(paidFlip.month).toContain("Jordan");
      expect(paidFlip.month).toContain("In person / Cash");
      expect(paidFlip.history).toContain("Visit history");
      expect(paidFlip.history).toContain("In person / Cash");
      expect(paidFlip.status).toBe("PAID");
      expect(paidFlip.method).toBe("cash");
      const series = await page.evaluate(() => {
        const before = (window as unknown as { getTenant: () => { appointments: unknown[] } }).getTenant().appointments.length;
        (window as unknown as { schediDashAddKind: (kind: string) => void }).schediDashAddKind("recurring");
        const modal = document.getElementById("ownerRecurringModal");
        const client = document.getElementById("ownerRecurClient") as HTMLInputElement;
        const date = document.getElementById("ownerRecurDate") as HTMLInputElement;
        client.value = "Maya Chen";
        date.value = "2027-03-02";
        (window as unknown as { onOwnerRecurDateChange: () => void }).onOwnerRecurDateChange();
        (document.getElementById("ownerRecurringForm") as HTMLFormElement).requestSubmit();
        return {
          open: !!modal && !modal.classList.contains("hidden"),
          note: document.getElementById("ownerRecurNote")?.textContent || "",
          visits: document.getElementById("ownerRecurPreview")?.textContent || "",
          after: (window as unknown as { getTenant: () => { appointments: unknown[] } }).getTenant().appointments.length,
          before,
        };
      });
      expect(series.open).toBe(true);
      expect(series.note).toContain("This demo does not save a recurring series");
      expect(series.visits).toContain("Mar");
      expect(series.after).toBe(series.before);
      const probe = await page.evaluate(async () => {
        const before = (window as unknown as { __schediDemoBlocked: { url: string; method: string }[] }).__schediDemoBlocked.length;
        await fetch("https://schedi.app/api/profile", { method: "POST", body: "{}" });
        await fetch("/api/bookings", { method: "DELETE" });
        await (window as unknown as { saveState: () => Promise<unknown> }).saveState();
        localStorage.setItem("schedi.authSession", "nope");
        localStorage.setItem("siteforge.platformState.v2", "nope");
        return {
          blocked: (window as unknown as { __schediDemoBlocked: { method: string }[] }).__schediDemoBlocked.slice(before).map((row) => row.method),
          auth: localStorage.getItem("schedi.authSession"),
          state: localStorage.getItem("siteforge.platformState.v2"),
        };
      });
      expect(probe.blocked).toEqual(expect.arrayContaining(["POST", "DELETE", "SET"]));
      expect(probe.auth).toBeNull();
      expect(probe.state).toBeNull();
      const writes = requests.filter((request) => !["GET", "HEAD", "OPTIONS"].includes(request.method));
      const privateHosts = requests.filter((request) => /schedi\.app|firebase|identitytoolkit|firestore/.test(request.url));
      expect(writes).toEqual([]);
      expect(privateHosts).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 60000);

  it("fits seven hours columns in the card at 1280 and mutes blocks on a closed day", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      const measure = async (width: number) => {
        await page.setViewport({ width, height: 900 });
        return page.evaluate(() => {
          const card = document.getElementById("tenantSectionHours");
          const scroll = document.querySelector(".sd-hours-week-scroll") as HTMLElement | null;
          const grid = document.querySelector(".sd-hours-week") as HTMLElement | null;
          const days = [...document.querySelectorAll(".sd-hours-week-day")];
          const input = document.getElementById("shiftStart_Mon") as HTMLInputElement | null;
          const sunday = document.getElementById("shiftOpen_Sun")?.closest(".sd-hours-week-day") as HTMLElement | null;
          const note = sunday?.querySelector(".sd-hours-week-closed-note") as HTMLElement | null;
          const lunch = sunday?.querySelector(".sd-hours-week-block") as HTMLElement | null;
          const cardBox = card?.getBoundingClientRect();
          const dayBoxes = days.map((day) => {
            const box = day.getBoundingClientRect();
            return { right: box.right, left: box.left, width: box.width };
          });
          const rules = (window as unknown as { getTenant: () => { blockedRules: { id: string }[] } }).getTenant().blockedRules.map((rule) => rule.id);
          return {
            columns: getComputedStyle(grid as Element).gridTemplateColumns,
            scrollWidth: scroll?.scrollWidth || 0,
            clientWidth: scroll?.clientWidth || 0,
            fontSize: input ? getComputedStyle(input).fontSize : "",
            inputClip: input ? input.scrollWidth - input.clientWidth : 0,
            cardRight: cardBox?.right || 0,
            cardLeft: cardBox?.left || 0,
            dayBoxes,
            sundayClosed: sunday?.classList.contains("is-closed") || false,
            note: note?.textContent || "",
            noteDisplay: note ? getComputedStyle(note).display : "",
            lunch: lunch?.textContent || "",
            rules,
          };
        });
      };
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`http://127.0.0.1:${port}/portal-preview?weekhours=1`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("hours"));
      await page.waitForSelector(".sd-hours-week-day", { timeout: 10000 });
      const desktop = await measure(1280);
      expect(desktop.dayBoxes).toHaveLength(7);
      expect(desktop.scrollWidth).toBeLessThanOrEqual(desktop.clientWidth + 1);
      expect(desktop.fontSize).toBe("11px");
      expect(desktop.inputClip).toBeLessThanOrEqual(0);
      expect(desktop.columns.split(" ").length).toBe(7);
      const cardRight = desktop.cardRight + 1;
      const cardLeft = desktop.cardLeft - 1;
      desktop.dayBoxes.forEach((box) => {
        expect(box.left).toBeGreaterThanOrEqual(cardLeft);
        expect(box.right).toBeLessThanOrEqual(cardRight);
        expect(box.width).toBeGreaterThan(40);
      });
      expect(desktop.sundayClosed).toBe(true);
      expect(desktop.note).toBe("Not applied while closed");
      expect(desktop.noteDisplay).not.toBe("none");
      expect(desktop.lunch).toContain("Lunch");
      expect(desktop.rules).toContain("rule-lunch");
      const wide = await measure(1024);
      expect(wide.scrollWidth).toBeLessThanOrEqual(wide.clientWidth + 1);
      expect(wide.inputClip).toBeLessThanOrEqual(0);
      expect(wide.dayBoxes).toHaveLength(7);
      const fittedRight = wide.cardRight + 1;
      wide.dayBoxes.forEach((box) => expect(box.right).toBeLessThanOrEqual(fittedRight));
      const phone = await measure(390);
      expect(phone.columns.split(" ").length).toBe(1);
      expect(phone.scrollWidth).toBeLessThanOrEqual(phone.clientWidth + 1);
      expect(phone.fontSize).toBe("16px");
      await page.setViewport({ width: 390, height: 844 });
      const beforeCopy = await page.evaluate(() => ({
        tue: (document.getElementById("shiftStart_Tue") as HTMLInputElement).value,
        wed: (document.getElementById("shiftStart_Wed") as HTMLInputElement).value,
        sun: (document.getElementById("shiftOpen_Sun") as HTMLInputElement).checked,
      }));
      await page.$eval(".sd-hours-week-day .sd-hours-week-copy", (el) => (el as HTMLButtonElement).click());
      const sheet = await page.evaluate(() => {
        const root = document.getElementById("hoursCopySheet");
        const boxes = [...document.querySelectorAll("#hoursCopyDays input")].map((el) => ({
          value: (el as HTMLInputElement).value,
          checked: (el as HTMLInputElement).checked,
        }));
        const close = root?.querySelector(".sd-form-close") as HTMLElement | null;
        const closeBox = close?.getBoundingClientRect();
        const card = root?.querySelector(".sd-sheet-card") as HTMLElement | null;
        const cardBox = card?.getBoundingClientRect();
        return {
          hidden: !!root?.hidden,
          title: document.getElementById("hoursCopyTitle")?.textContent || "",
          boxes,
          applyDisabled: (document.getElementById("hoursCopyApply") as HTMLButtonElement | null)?.disabled,
          allChecked: (document.getElementById("hoursCopyAll") as HTMLInputElement | null)?.checked,
          close: closeBox ? { w: closeBox.width, h: closeBox.height, top: closeBox.top, right: closeBox.right, bottom: closeBox.bottom } : null,
          cardTop: cardBox?.top || 0,
          labels: [...document.querySelectorAll(".sd-hours-week-copy")].map((el) => (el.textContent || "").trim()),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect(sheet.hidden).toBe(false);
      expect(sheet.title).toBe("Copy Monday to…");
      expect(sheet.boxes.map((box) => box.value)).toEqual(["Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
      expect(sheet.boxes.every((box) => !box.checked)).toBe(true);
      expect(sheet.applyDisabled).toBe(true);
      expect(sheet.allChecked).toBe(false);
      expect(sheet.close && sheet.close.w).toBeGreaterThanOrEqual(48);
      expect(sheet.close && sheet.close.h).toBeGreaterThanOrEqual(48);
      expect(sheet.close && sheet.close.top).toBeGreaterThanOrEqual(0);
      expect(sheet.close && sheet.close.right).toBeLessThanOrEqual(390);
      expect(sheet.cardTop).toBeGreaterThanOrEqual(0);
      expect(sheet.overflow).toBeLessThanOrEqual(1);
      expect(sheet.labels).toEqual(["Copy to…", "Copy to…", "Copy to…", "Copy to…", "Copy to…", "Copy to…", "Copy to…"]);
      await page.click('#hoursCopyDays input[value="Tue"]');
      await page.click("#hoursCopyApply");
      const afterCopy = await page.evaluate(() => ({
        sheetHidden: document.getElementById("hoursCopySheet")?.hidden,
        tue: (document.getElementById("shiftStart_Tue") as HTMLInputElement).value,
        tueEnd: (document.getElementById("shiftEnd_Tue") as HTMLInputElement).value,
        tueOpen: (document.getElementById("shiftOpen_Tue") as HTMLInputElement).checked,
        wed: (document.getElementById("shiftStart_Wed") as HTMLInputElement).value,
        sun: (document.getElementById("shiftOpen_Sun") as HTMLInputElement).checked,
        mon: (document.getElementById("shiftStart_Mon") as HTMLInputElement).value,
        monEnd: (document.getElementById("shiftEnd_Mon") as HTMLInputElement).value,
        monOpen: (document.getElementById("shiftOpen_Mon") as HTMLInputElement).checked,
      }));
      expect(afterCopy.sheetHidden).toBe(true);
      expect(afterCopy.tue).toBe(afterCopy.mon);
      expect(afterCopy.tueEnd).toBe(afterCopy.monEnd);
      expect(afterCopy.tueOpen).toBe(afterCopy.monOpen);
      expect(afterCopy.tue).not.toBe(beforeCopy.tue);
      expect(afterCopy.wed).toBe(beforeCopy.wed);
      expect(afterCopy.sun).toBe(beforeCopy.sun);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 60000);

  it("keeps seven hour controls visible when week layout is toggled", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const errors: string[] = [];
    try {
      const page = await browser.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      const visible = (selector: string) => page.evaluate((sel) => {
        const block = document.getElementById("tenantHoursShiftBlock");
        const blockStyle = block ? getComputedStyle(block) : null;
        const nodes = [...document.querySelectorAll(sel)];
        const shown = nodes.filter((el) => {
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && box.height > 0 && box.width > 0;
        });
        const summary = document.querySelector(".sd-hours-summary-lines");
        const line = document.querySelector(".sd-hours-summary-line");
        const summaryBox = document.getElementById("hoursWeekSummary");
        const grid = document.getElementById("perDayShiftsGrid");
        return {
          total: nodes.length,
          shown: shown.length,
          block: blockStyle ? blockStyle.display : "",
          blockH: block ? block.getBoundingClientRect().height : 0,
          summary: summaryBox?.textContent || "",
          beforeGrid: !!(summaryBox && grid && (summaryBox.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING)),
          dir: summary ? getComputedStyle(summary).flexDirection : "",
          after: line ? getComputedStyle(line, "::after").content : "",
          tabbar: getComputedStyle(document.getElementById("schediDashTabbar") as Element).display,
          dash: document.body.classList.contains("schedi-newdash"),
          pressed: document.getElementById("hoursWeekLayoutBtn")?.getAttribute("aria-pressed"),
        };
      }, selector);
      const ready = async (search = "") => {
        await page.goto(`http://127.0.0.1:${port}/portal-preview${search}`, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
        await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("hours"));
        await page.waitForSelector("#shiftOpen_Mon", { timeout: 10000 });
      };
      await page.setViewport({ width: 390, height: 900 });
      await ready();
      for (const width of [390, 1280]) {
        await page.setViewport({ width, height: 900 });
        const pressed = await page.$eval("#hoursWeekLayoutBtn", (el) => el.getAttribute("aria-pressed"));
        if (pressed === "true") await page.$eval("#hoursWeekLayoutBtn", (el) => (el as HTMLButtonElement).click());
        const day = await visible(".sd-hours-day");
        expect(day.shown).toBe(7);
        expect(day.block).toBe("block");
        expect(day.blockH).toBeGreaterThan(0);
        expect(day.dash).toBe(true);
        expect(day.beforeGrid).toBe(true);
        expect(day.summary).toContain("Mon, Wed–Fri 9 AM–6 PM");
        expect(day.summary).toContain("Sun Closed");
        expect(day.summary).toContain("Daily break 12–1 PM");
        expect(day.tabbar).toBe(width < 860 ? "grid" : "none");
        expect(day.dir).toBe(width < 860 ? "column" : "row");
        if (width < 860) expect(day.after).toBe("none");
        else expect(day.after).toContain("·");
        await page.$eval("#hoursWeekLayoutBtn", (el) => (el as HTMLButtonElement).click());
        const week = await visible(".sd-hours-week-day");
        expect(week.shown).toBe(7);
        expect(week.pressed).toBe("true");
        expect(week.block).toBe("block");
        await page.$eval("#hoursWeekLayoutBtn", (el) => (el as HTMLButtonElement).click());
        const again = await visible(".sd-hours-day");
        expect(again.shown).toBe(7);
        expect(again.pressed).toBe("false");
        expect(again.blockH).toBeGreaterThan(0);
        await page.$eval("#hoursWeekLayoutBtn", (el) => (el as HTMLButtonElement).click());
        const back = await visible(".sd-hours-week-day");
        expect(back.shown).toBe(7);
        expect(back.block).toBe("block");
      }
      await page.evaluate(() => {
        const input = document.getElementById("shiftEnd_Mon") as HTMLInputElement;
        input.value = "09:00 PM";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const edited = await page.$eval("#hoursWeekSummary", (el) => el.textContent || "");
      expect(edited).toContain("Mon 9 AM–9 PM");
      expect(edited).toContain("Wed–Fri 9 AM–6 PM");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("hours"));
      await page.waitForSelector(".sd-hours-week-day", { timeout: 10000 });
      const remembered = await visible(".sd-hours-week-day");
      expect(await page.evaluate(() => localStorage.getItem("schediWeekHours"))).toBe("1");
      expect(remembered.shown).toBe(7);
      expect(remembered.block).toBe("block");
      await page.evaluate(() => localStorage.setItem("schediWeekHours", "0"));
      await page.setViewport({ width: 390, height: 900 });
      await ready("?weekhours=1");
      const flagged = await visible(".sd-hours-week-day");
      expect(flagged.shown).toBe(7);
      expect(flagged.pressed).toBe("true");
      expect(flagged.tabbar).toBe("grid");
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("profile"));
      const profile = await visible(".sd-hours-week-day");
      expect(profile.shown).toBe(0);
      expect(profile.block).toBe("none");
      expect(profile.blockH).toBe(0);
      const profileFields = await page.evaluate(() => {
        const shown = (id: string) => {
          const el = document.getElementById(id);
          if (!el) return "missing";
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return style.display !== "none" && box.height > 0 ? "shown" : "hidden";
        };
        return {
          dash: document.getElementById("tenantPortalSection")?.getAttribute("data-dash"),
          booking: shown("tenantProfileFields"),
          address: shown("tenantAddress"),
          intro: shown("tenantHoursIntro"),
          summary: shown("hoursWeekSummary"),
          weekBtn: shown("hoursWeekLayoutBtn"),
          rules: shown("tenantSlotInterval"),
          timeOff: getComputedStyle(document.getElementById("tenantHoursTimeOff") as Element).display,
          save: (document.getElementById("tenantHoursSaveBtn")?.textContent || "").trim(),
        };
      });
      expect(profileFields.dash).toBe("profile");
      expect(profileFields.booking).toBe("shown");
      expect(profileFields.address).toBe("shown");
      expect(profileFields.intro).toBe("hidden");
      expect(profileFields.summary).toBe("hidden");
      expect(profileFields.weekBtn).toBe("hidden");
      expect(profileFields.rules).toBe("hidden");
      expect(profileFields.timeOff).toBe("none");
      expect(profileFields.save).toBe("Save booking page");
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("hours"));
      await page.waitForSelector(".sd-hours-week-day", { timeout: 10000 });
      const hoursAgain = await visible(".sd-hours-week-day");
      expect(hoursAgain.shown).toBe(7);
      expect(hoursAgain.pressed).toBe("true");
      expect(hoursAgain.block).toBe("block");
      expect(await page.$eval("#tenantHoursSaveBtn", (el) => (el.textContent || "").trim())).toBe("Save Operating Hours");
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 90000);

  it("keeps Opens and Closes on their own fields and uses the open switch", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const overlaps = (a: { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }) => {
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return width > 1 && height > 1;
    };
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("hours"));
      await page.waitForSelector("#shiftOpen_Mon", { timeout: 10000 });
      const measure = () => page.evaluate(() => {
        const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        const card = document.getElementById("tenantSectionHours")!.getBoundingClientRect();
        return days.map((day) => {
          const open = document.getElementById("shiftOpen_" + day) as HTMLInputElement;
          const start = document.getElementById("shiftStart_" + day) as HTMLInputElement;
          const end = document.getElementById("shiftEnd_" + day) as HTMLInputElement;
          const startCombo = start.closest("[data-time-combo]") as HTMLElement;
          const endCombo = end.closest("[data-time-combo]") as HTMLElement;
          const startLabel = startCombo.querySelector(".sd-time-label") as HTMLElement;
          const endLabel = endCombo.querySelector(".sd-time-label") as HTMLElement;
          const box = (el: Element) => {
            const rect = el.getBoundingClientRect();
            return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
          };
          const openStyle = getComputedStyle(open);
          const cardEl = open.closest(".sd-hours-day, .sd-hours-week-day") as HTMLElement;
          const times = cardEl.querySelector(".sd-hours-times") as HTMLElement;
          const note = cardEl.querySelector(".sd-hours-week-closed-note") as HTMLElement | null;
          const startBtn = startCombo.querySelector(".sd-time-open") as HTMLButtonElement;
          return {
            day,
            startValue: start.value,
            endValue: end.value,
            startLabel: startLabel.textContent,
            endLabel: endLabel.textContent,
            openLabel: document.getElementById("shiftOpenLabel_" + day)?.textContent || "",
            duplicateState: !!cardEl.querySelector(".sd-hours-week-state"),
            closed: cardEl.classList.contains("is-closed"),
            timesOpacity: getComputedStyle(times).opacity,
            startDisabled: start.disabled,
            endDisabled: end.disabled,
            startBtnDisabled: startBtn.disabled,
            note: note?.textContent || "",
            noteDisplay: note ? getComputedStyle(note).display : "",
            startColor: getComputedStyle(start).color,
            startCombo: box(startCombo),
            endCombo: box(endCombo),
            startLabelBox: box(startLabel),
            endLabelBox: box(endLabel),
            startBox: box(start),
            endBox: box(end),
            startClip: start.scrollWidth - start.clientWidth,
            endClip: end.scrollWidth - end.clientWidth,
            labelColor: getComputedStyle(startLabel).color,
            position: getComputedStyle(startCombo).position,
            openRole: open.getAttribute("role"),
            aria: open.getAttribute("aria-checked"),
            checked: open.checked,
            switchW: openStyle.width,
            switchH: openStyle.height,
            switchBg: openStyle.backgroundColor,
            appearance: openStyle.appearance,
            openBox: box(open),
            card: { left: card.left, right: card.right },
          };
        });
      });
      for (const width of [340, 390, 1280]) {
        await page.setViewport({ width, height: 900 });
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => {
            (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode);
          }, theme);
          await page.waitForFunction((mode) => document.documentElement.classList.contains("schedi-light") === (mode === "light"), { timeout: 2000 }, theme);
          for (const layout of ["list", "week"] as const) {
            const pressed = await page.$eval("#hoursWeekLayoutBtn", (el) => el.getAttribute("aria-pressed"));
            if ((layout === "week") !== (pressed === "true")) {
              await page.$eval("#hoursWeekLayoutBtn", (el) => (el as HTMLButtonElement).click());
              await page.waitForSelector(layout === "week" ? ".sd-hours-week-day" : ".sd-hours-day", { timeout: 5000 });
            }
            const rows = await measure();
            expect(rows).toHaveLength(7);
            for (const row of rows) {
              expect(row.startLabel).toBe("Opens");
              expect(row.endLabel).toBe("Closes");
              expect(row.position).toBe("relative");
              expect(row.startCombo.height).toBeGreaterThan(40);
              expect(row.endCombo.height).toBeGreaterThan(40);
              expect(row.startCombo.width).toBeGreaterThan(80);
              expect(row.endCombo.width).toBeGreaterThan(80);
              expect(overlaps(row.startCombo, row.endCombo)).toBe(false);
              expect(overlaps(row.startLabelBox, row.endLabelBox)).toBe(false);
              expect(overlaps(row.startBox, row.endBox)).toBe(false);
              expect(row.startLabelBox.bottom).toBeLessThanOrEqual(row.startBox.top + 2);
              expect(row.endLabelBox.bottom).toBeLessThanOrEqual(row.endBox.top + 2);
              expect(row.startLabelBox.left).toBeLessThan(row.startBox.right);
              expect(row.startLabelBox.right).toBeGreaterThan(row.startBox.left);
              expect(row.endLabelBox.left).toBeLessThan(row.endBox.right);
              expect(row.endLabelBox.right).toBeGreaterThan(row.endBox.left);
              expect(row.startClip).toBeLessThanOrEqual(1);
              expect(row.endClip).toBeLessThanOrEqual(1);
              expect(row.labelColor).toBe(theme === "dark" ? "rgb(203, 213, 225)" : "rgb(51, 65, 85)");
              const stacked = row.startCombo.bottom <= row.endCombo.top + 1;
              const beside = row.startCombo.right <= row.endCombo.left + 1;
              expect(stacked || beside).toBe(true);
              if (width < 860 || layout === "week") expect(stacked).toBe(true);
              else expect(beside).toBe(true);
              expect(row.openRole).toBe("switch");
              expect(row.appearance).toBe("none");
              expect(row.aria).toBe(row.checked ? "true" : "false");
              expect(row.switchW).toBe("52px");
              expect(row.switchH).toBe("30px");
              expect(row.openBox.left).toBeGreaterThanOrEqual(row.card.left - 1);
              expect(row.openBox.right).toBeLessThanOrEqual(row.card.right + 1);
              expect(row.openBox.width).toBeGreaterThanOrEqual(51);
              expect(row.openBox.height).toBeGreaterThanOrEqual(29);
              expect(row.duplicateState).toBe(false);
              expect(row.openLabel).toBe(row.day === "Sun" ? "Closed" : "Open");
              if (row.day === "Sun") {
                expect(row.checked).toBe(false);
                expect(row.switchBg).toBe(theme === "dark" ? "rgb(100, 116, 139)" : "rgb(203, 213, 225)");
                expect(row.closed).toBe(true);
                expect(row.timesOpacity).toBe("0.55");
                expect(row.startDisabled).toBe(true);
                expect(row.endDisabled).toBe(true);
                expect(row.startBtnDisabled).toBe(true);
                expect(row.note).toBe("Not applied while closed");
                expect(row.noteDisplay).toBe("block");
                expect(row.startColor).toBe(theme === "dark" ? "rgb(248, 250, 252)" : "rgb(15, 23, 42)");
              } else {
                expect(row.checked).toBe(true);
                expect(row.switchBg).toBe(theme === "dark" ? "rgb(16, 185, 129)" : "rgb(5, 150, 105)");
                expect(row.closed).toBe(false);
                expect(row.timesOpacity).toBe("1");
                expect(row.startDisabled).toBe(false);
                expect(row.endDisabled).toBe(false);
                expect(row.startBtnDisabled).toBe(false);
                expect(row.noteDisplay).toBe("none");
              }
            }
            const monday = rows.find((row) => row.day === "Mon");
            expect(monday?.startValue).toBe("09:00 AM");
            expect(monday?.endValue).toBe("06:00 PM");
          }
        }
      }
      await page.setViewport({ width: 390, height: 900 });
      await page.evaluate(() => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme("dark"));
      if (await page.$eval("#hoursWeekLayoutBtn", (el) => el.getAttribute("aria-pressed")) === "true") {
        await page.$eval("#hoursWeekLayoutBtn", (el) => (el as HTMLButtonElement).click());
      }
      await page.$eval("#shiftOpen_Mon", (el) => (el as HTMLInputElement).click());
      const closedList = await page.evaluate(() => {
        const card = document.getElementById("shiftOpen_Mon")?.closest(".sd-hours-day");
        const times = card?.querySelector(".sd-hours-times") as HTMLElement | null;
        const note = card?.querySelector(".sd-hours-week-closed-note") as HTMLElement | null;
        const start = document.getElementById("shiftStart_Mon") as HTMLInputElement;
        return {
          aria: document.getElementById("shiftOpen_Mon")?.getAttribute("aria-checked"),
          checked: (document.getElementById("shiftOpen_Mon") as HTMLInputElement).checked,
          summary: document.getElementById("hoursWeekSummary")?.textContent || "",
          label: document.getElementById("shiftOpenLabel_Mon")?.textContent || "",
          closed: card?.classList.contains("is-closed") || false,
          opacity: times ? getComputedStyle(times).opacity : "",
          disabled: start.disabled,
          note: note?.textContent || "",
          noteDisplay: note ? getComputedStyle(note).display : "",
        };
      });
      expect(closedList.checked).toBe(false);
      expect(closedList.aria).toBe("false");
      expect(closedList.summary).toContain("Mon, Sun Closed");
      expect(closedList.summary).toContain("Wed–Fri 9 AM–6 PM");
      expect(closedList.summary).not.toContain("Mon, Wed–Fri");
      expect(closedList.label).toBe("Closed");
      expect(closedList.closed).toBe(true);
      expect(closedList.opacity).toBe("0.55");
      expect(closedList.disabled).toBe(true);
      expect(closedList.note).toBe("Not applied while closed");
      expect(closedList.noteDisplay).toBe("block");
      await page.$eval("#shiftOpen_Mon", (el) => (el as HTMLInputElement).click());
      const reopened = await page.evaluate(() => {
        const card = document.getElementById("shiftOpen_Mon")?.closest(".sd-hours-day");
        const times = card?.querySelector(".sd-hours-times") as HTMLElement | null;
        const note = card?.querySelector(".sd-hours-week-closed-note") as HTMLElement | null;
        return {
          summary: document.getElementById("hoursWeekSummary")?.textContent || "",
          label: document.getElementById("shiftOpenLabel_Mon")?.textContent || "",
          closed: card?.classList.contains("is-closed") || false,
          opacity: times ? getComputedStyle(times).opacity : "",
          disabled: (document.getElementById("shiftStart_Mon") as HTMLInputElement).disabled,
          noteDisplay: note ? getComputedStyle(note).display : "",
        };
      });
      expect(reopened.summary).toContain("Mon, Wed–Fri 9 AM–6 PM");
      expect(reopened.label).toBe("Open");
      expect(reopened.closed).toBe(false);
      expect(reopened.opacity).toBe("1");
      expect(reopened.disabled).toBe(false);
      expect(reopened.noteDisplay).toBe("none");
      await page.$eval("#hoursWeekLayoutBtn", (el) => (el as HTMLButtonElement).click());
      await page.waitForSelector(".sd-hours-week-day");
      await page.$eval("#shiftOpen_Mon", (el) => (el as HTMLInputElement).click());
      const closedWeek = await page.evaluate(() => {
        const card = document.getElementById("shiftOpen_Mon")?.closest(".sd-hours-week-day");
        const times = card?.querySelector(".sd-hours-times") as HTMLElement | null;
        const note = card?.querySelector(".sd-hours-week-closed-note") as HTMLElement | null;
        const opens = [...(card?.querySelectorAll(".sd-hours-open span") || [])].map((el) => el.textContent);
        return {
          aria: document.getElementById("shiftOpen_Mon")?.getAttribute("aria-checked"),
          label: document.getElementById("shiftOpenLabel_Mon")?.textContent || "",
          opens,
          duplicate: document.querySelectorAll(".sd-hours-week-state").length,
          closed: card?.classList.contains("is-closed") || false,
          opacity: times ? getComputedStyle(times).opacity : "",
          disabled: (document.getElementById("shiftStart_Mon") as HTMLInputElement).disabled,
          note: note?.textContent || "",
          noteDisplay: note ? getComputedStyle(note).display : "",
        };
      });
      expect(closedWeek.aria).toBe("false");
      expect(closedWeek.label).toBe("Closed");
      expect(closedWeek.opens).toEqual(["Closed"]);
      expect(closedWeek.duplicate).toBe(0);
      expect(closedWeek.closed).toBe(true);
      expect(closedWeek.opacity).toBe("0.55");
      expect(closedWeek.disabled).toBe(true);
      expect(closedWeek.note).toBe("Not applied while closed");
      expect(closedWeek.noteDisplay).toBe("block");
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("sizes payment switches at 340, 390, and 1280 in light and dark", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.waitForFunction(() => {
        const tenant = (window as unknown as { getTenant?: () => { paymentGateways?: { later?: boolean } } }).getTenant?.();
        return !!(tenant && tenant.paymentGateways && tenant.paymentGateways.later === true);
      }, { timeout: 20000 });
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("payments"));
      await page.waitForFunction(() => {
        const later = document.getElementById("tenantPayLaterCheck") as HTMLInputElement | null;
        const tag = document.getElementById("tenantCashAppTagInput") as HTMLInputElement | null;
        return !!(later && later.checked && tag && tag.value === "$HarborStudio");
      }, { timeout: 10000 });
      const measure = () => page.evaluate(() => {
        const boxOf = (id: string) => {
          const el = document.getElementById(id) as HTMLInputElement | null;
          if (!el) return null;
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          const row = el.closest(".sd-pay-switch-row, .sd-pay-radio") as HTMLElement | null;
          const rowBox = row?.getBoundingClientRect();
          const titleEl = row?.querySelector(".sd-pay-switch-title") as HTMLElement | null;
          return {
            role: el.getAttribute("role"),
            checked: el.getAttribute("aria-checked"),
            on: el.checked,
            w: Math.round(box.width),
            h: Math.round(box.height),
            bg: style.backgroundColor,
            rowH: rowBox ? Math.round(rowBox.height) : 0,
            rowW: rowBox ? Math.round(rowBox.width) : 0,
            inside: !!(rowBox && box.right <= rowBox.right + 1 && box.left >= rowBox.left - 1),
            right: !!(rowBox && box.left > rowBox.left + 40),
            font: titleEl ? getComputedStyle(titleEl).fontSize : (row ? getComputedStyle(row).fontSize : ""),
          };
        };
        return {
          later: boxOf("tenantPayLaterCheck"),
          card: boxOf("tenantPayCardCheck"),
          deposit: boxOf("tenantDepositEnabled"),
          fee: boxOf("tenantCancelFeeEnabled"),
          cash: boxOf("tenantDepositMethodCashapp"),
          paypal: boxOf("tenantDepositMethodPaypal"),
          radio: boxOf("tenantDepositTypeFixed"),
        };
      });
      for (const width of [340, 390, 1280]) {
        await page.setViewport({ width, height: 900 });
        await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("payments"));
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode), theme);
          const view = await measure();
          expect(view.later?.role).toBe("switch");
          expect(view.later?.on).toBe(true);
          expect(view.later?.checked).toBe("true");
          expect(view.later?.w).toBe(52);
          expect(view.later?.h).toBe(30);
          expect(view.later?.rowH).toBeGreaterThanOrEqual(56);
          expect(view.later?.inside).toBe(true);
          expect(view.later?.right).toBe(true);
          expect(view.later?.font).toBe("17px");
          expect(view.later?.bg).toBe(theme === "dark" ? "rgb(16, 185, 129)" : "rgb(5, 150, 105)");
          expect(view.card?.on).toBe(false);
          expect(view.card?.checked).toBe("false");
          expect(view.card?.bg).toBe(theme === "dark" ? "rgb(100, 116, 139)" : "rgb(203, 213, 225)");
          expect(view.deposit?.w).toBe(52);
          expect(view.deposit?.rowH).toBeGreaterThanOrEqual(56);
          expect(view.fee?.role).toBe("switch");
          expect(view.fee?.rowH).toBeGreaterThanOrEqual(56);
          expect(view.cash?.on).toBe(true);
          expect(view.cash?.checked).toBe("true");
          expect(view.cash?.w).toBe(52);
          expect(view.cash?.rowH).toBeGreaterThanOrEqual(56);
          expect(view.paypal?.on).toBe(false);
          expect(view.paypal?.w).toBe(52);
          expect(view.radio?.w).toBe(22);
          expect(view.radio?.h).toBe(22);
          expect(view.radio?.rowH).toBeGreaterThanOrEqual(48);
          expect(view.radio?.font).toBe("16px");
          expect(view.radio?.inside).toBe(true);
        }
      }
      await page.evaluate(() => {
        const row = document.getElementById("tenantPayLaterCheck")?.closest("label") as HTMLElement | null;
        row?.click();
      });
      const toggled = await page.$eval("#tenantPayLaterCheck", (el) => ({
        on: (el as HTMLInputElement).checked,
        aria: el.getAttribute("aria-checked"),
      }));
      expect(toggled).toEqual({ on: false, aria: "false" });
      await page.evaluate(() => {
        const row = document.getElementById("tenantDepositMethodCashapp")?.closest("label") as HTMLElement | null;
        row?.click();
      });
      const method = await page.$eval("#tenantDepositMethodCashapp", (el) => ({
        on: (el as HTMLInputElement).checked,
        aria: el.getAttribute("aria-checked"),
        role: el.getAttribute("role"),
      }));
      expect(method).toEqual({ on: false, aria: "false", role: "switch" });
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 90000);

  it("sizes email switches at 340 and 390 in light and dark", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.waitForFunction(() => {
        const tenant = (window as unknown as { getTenant?: () => { notifications?: { emailConfirmations?: boolean } } }).getTenant?.();
        return !!(tenant && tenant.notifications && tenant.notifications.emailConfirmations === true);
      }, { timeout: 20000 });
      const measure = () => page.evaluate(() => {
        const boxOf = (id: string) => {
          const el = document.getElementById(id) as HTMLInputElement | null;
          if (!el) return null;
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          const row = el.closest(".sd-pay-switch-row") as HTMLElement | null;
          const rowBox = row?.getBoundingClientRect();
          const parent = row?.parentElement?.getBoundingClientRect();
          const titleEl = row?.querySelector(".sd-pay-switch-title") as HTMLElement | null;
          const noteEl = row?.querySelector(".sd-pay-switch-note") as HTMLElement | null;
          return {
            role: el.getAttribute("role"),
            checked: el.getAttribute("aria-checked"),
            on: el.checked,
            w: Math.round(box.width),
            h: Math.round(box.height),
            bg: style.backgroundColor,
            rowH: rowBox ? Math.round(rowBox.height) : 0,
            rowW: rowBox ? Math.round(rowBox.width) : 0,
            full: !!(rowBox && parent && rowBox.width >= parent.width - 40 && rowBox.width <= parent.width + 1),
            right: !!(rowBox && box.left > rowBox.left + 40),
            title: titleEl ? getComputedStyle(titleEl).fontSize : "",
            note: noteEl ? getComputedStyle(noteEl).fontSize : "",
          };
        };
        const smsRow = document.getElementById("tenantSmsRow");
        const smsHidden = !!smsRow?.classList.contains("hidden");
        if (smsRow && smsHidden) smsRow.classList.remove("hidden");
        const sms = boxOf("tenantSmsEnabledCheck");
        if (smsRow && smsHidden) smsRow.classList.add("hidden");
        return {
          email: boxOf("tenantEmailConfirmCheck"),
          recurring: boxOf("tenantAllowRecurringCheck"),
          reminders: boxOf("tenantRemindersEnabledCheck"),
          sms,
          smsHidden,
        };
      });
      for (const width of [340, 390]) {
        await page.setViewport({ width, height: 900 });
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode), theme);
          await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("emails"));
          await page.waitForFunction(() => {
            const email = document.getElementById("tenantEmailConfirmCheck") as HTMLInputElement | null;
            return !!(email && email.checked && email.getAttribute("aria-checked") === "true" && email.getAttribute("role") === "switch");
          }, { timeout: 10000 });
          const emails = await measure();
          for (const row of [emails.email, emails.recurring, emails.reminders, emails.sms]) {
            expect(row?.role).toBe("switch");
            expect(row?.w).toBe(52);
            expect(row?.h).toBe(30);
            expect(row?.rowH).toBeGreaterThanOrEqual(56);
            expect(row?.full).toBe(true);
            expect(row?.right).toBe(true);
            expect(row?.title).toBe("17px");
            expect(row?.note).toBe("16px");
          }
          expect(emails.smsHidden).toBe(true);
          expect(emails.email?.on).toBe(true);
          expect(emails.email?.checked).toBe("true");
          expect(emails.email?.bg).toBe(theme === "dark" ? "rgb(16, 185, 129)" : "rgb(5, 150, 105)");
          expect(emails.reminders?.on).toBe(true);
          expect(emails.reminders?.checked).toBe("true");
          await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("hours"));
          await page.waitForFunction(() => {
            const title = document.getElementById("sdBusyTitle");
            const add = document.querySelector('[data-busy-add="1"]');
            return !!(title && title.textContent === "Keep busy times off the book" && add);
          }, { timeout: 10000 });
        }
      }
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("emails"));
      await page.evaluate(() => {
        const row = document.getElementById("tenantEmailConfirmCheck")?.closest("label") as HTMLElement | null;
        row?.click();
        const reminders = document.getElementById("tenantRemindersEnabledCheck")?.closest("label") as HTMLElement | null;
        reminders?.click();
      });
      const saved = await page.evaluate(() => {
        const email = document.getElementById("tenantEmailConfirmCheck") as HTMLInputElement;
        const reminders = document.getElementById("tenantRemindersEnabledCheck") as HTMLInputElement;
        (window as unknown as { handleSaveTenantNotifications: (event: { preventDefault: () => void }) => void }).handleSaveTenantNotifications({ preventDefault() {} });
        const tenant = (window as unknown as { getTenant: () => { notifications: { emailConfirmations: boolean }; remindersEnabled: boolean } }).getTenant();
        return {
          emailOn: email.checked,
          emailAria: email.getAttribute("aria-checked"),
          emailSaved: tenant.notifications.emailConfirmations,
          remindersOn: reminders.checked,
          remindersAria: reminders.getAttribute("aria-checked"),
          remindersSaved: tenant.remindersEnabled,
        };
      });
      expect(saved).toEqual({
        emailOn: false,
        emailAria: "false",
        emailSaved: false,
        remindersOn: false,
        remindersAria: "false",
        remindersSaved: false,
      });
      const feeds = await page.evaluate(() => {
        const title = document.getElementById("sdBusyTitle")?.textContent || "";
        const card = document.getElementById("sdBusyCard")?.textContent || "";
        const tenant = (window as unknown as { getTenant: () => { calendarSync?: { feedCount?: number; feeds?: { masked?: string }[] } } }).getTenant();
        return {
          title,
          hasSecret: card.includes("Secret address in iCal format"),
          hasSoon: card.includes("Coming soon"),
          feedCount: tenant.calendarSync && tenant.calendarSync.feedCount,
          masked: tenant.calendarSync && tenant.calendarSync.feeds && tenant.calendarSync.feeds[0] && tenant.calendarSync.feeds[0].masked,
        };
      });
      expect(feeds).toEqual({
        title: "Keep busy times off the book",
        hasSecret: true,
        hasSoon: false,
        feedCount: 1,
        masked: "calendar.google.com/…/basic.ics",
      });
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("mutes unselected mark-paid methods at 340 and 390 in light and dark", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const muted = {
      dark: { bg: "rgb(15, 23, 42)", fg: "rgb(248, 250, 252)", border: "rgb(51, 65, 85)" },
      light: { bg: "rgb(255, 255, 255)", fg: "rgb(15, 23, 42)", border: "rgb(203, 213, 225)" },
    };
    const brands: Record<string, { dark: string; light: string; fg: string; lightFg?: string }> = {
      cashapp: { dark: "rgb(0, 214, 79)", light: "rgb(0, 214, 79)", fg: "rgb(11, 18, 32)" },
      zelle: { dark: "rgb(109, 30, 212)", light: "rgb(109, 30, 212)", fg: "rgb(255, 255, 255)" },
      venmo: { dark: "rgb(0, 140, 255)", light: "rgb(0, 140, 255)", fg: "rgb(11, 18, 32)" },
      paypal: { dark: "rgb(0, 112, 224)", light: "rgb(0, 48, 135)", fg: "rgb(255, 255, 255)" },
      square: { dark: "rgb(255, 255, 255)", light: "rgb(0, 0, 0)", fg: "rgb(0, 0, 0)", lightFg: "rgb(255, 255, 255)" },
      card: { dark: "rgb(99, 91, 255)", light: "rgb(67, 56, 202)", fg: "rgb(255, 255, 255)" },
      cash: { dark: "rgb(5, 150, 105)", light: "rgb(4, 120, 87)", fg: "rgb(255, 255, 255)" },
    };
    try {
      const page = await browser.newPage();
      const writes: string[] = [];
      page.on("request", (req) => {
        if (req.method() !== "GET" && req.method() !== "HEAD") writes.push(req.url());
      });
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.waitForFunction(() => {
        const apps = (window as unknown as { getTenant?: () => { appointments?: { id?: string }[] } }).getTenant?.()?.appointments || [];
        return apps.some((row) => row && row.id === "HB-1002");
      }, { timeout: 20000 });
      const read = () => page.evaluate(() => {
        const group = document.getElementById("rosterPaidMethodOptions");
        const buttons = Array.from(group?.querySelectorAll(".roster-paid-opt") || []) as HTMLButtonElement[];
        const confirm = document.getElementById("rosterPaidMethodConfirmBtn") as HTMLButtonElement | null;
        return {
          role: group?.getAttribute("role") || "",
          labelled: group?.getAttribute("aria-labelledby") || "",
          enabled: confirm ? !confirm.disabled : false,
          options: buttons.map((el) => {
            const style = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            return {
              method: el.getAttribute("data-paid-method") || "",
              label: (el.querySelector("span")?.textContent || "").trim(),
              radio: el.getAttribute("role"),
              checked: el.getAttribute("aria-checked"),
              bg: style.backgroundColor,
              fg: style.color,
              border: style.borderTopColor,
              w: Math.round(box.width),
              h: Math.round(box.height),
              check: !!el.querySelector(".sd-paid-check"),
            };
          }),
        };
      });
      for (const width of [340, 390]) {
        await page.setViewport({ width, height: 900 });
        await page.evaluate(() => (window as unknown as { openRosterPaidMethodModal: (id: string) => void }).openRosterPaidMethodModal("HB-1002"));
        await page.waitForSelector("#rosterPaidMethodModal:not(.hidden) .roster-paid-opt", { timeout: 10000 });
        const paidClose = await page.$eval("#rosterPaidMethodModal .sd-form-close", (el) => {
          const box = el.getBoundingClientRect();
          return { label: el.getAttribute("aria-label") || "", w: Math.round(box.width), h: Math.round(box.height), radius: getComputedStyle(el).borderRadius };
        });
        expect(paidClose.label).toBe("Close");
        expect(paidClose.w).toBeGreaterThanOrEqual(44);
        expect(paidClose.h).toBeGreaterThanOrEqual(44);
        expect(parseFloat(paidClose.radius)).toBeGreaterThanOrEqual(20);
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode), theme);
          const view = await read();
          expect(view.role).toBe("radiogroup");
          expect(view.labelled).toBe("rosterPaidMethodTitle");
          expect(view.enabled).toBe(false);
          expect(view.options.map((row) => row.method)).toEqual(["cashapp", "zelle", "venmo", "cash"]);
          const on = view.options.filter((row) => row.checked === "true");
          expect(on).toEqual([]);
          for (const row of view.options) {
            expect(row.radio).toBe("radio");
            expect(row.h).toBeGreaterThanOrEqual(44);
            expect(row.w).toBeGreaterThan(240);
            const brand = brands[row.method];
            if (row.checked === "true") {
              expect(row.bg).toBe(brand[theme]);
              expect(row.fg).toBe(theme === "light" && brand.lightFg ? brand.lightFg : brand.fg);
              expect(row.check).toBe(true);
            } else {
              expect(row.bg).toBe(muted[theme].bg);
              expect(row.fg).toBe(muted[theme].fg);
              expect(row.border).toBe(muted[theme].border);
              expect(row.check).toBe(false);
            }
          }
        }
      }
      await page.evaluate(() => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme("dark"));
      await page.evaluate(() => {
        const zelle = document.querySelector('#rosterPaidMethodOptions [data-paid-method="zelle"]') as HTMLButtonElement | null;
        zelle?.click();
      });
      const zelle = await read();
      expect(zelle.options.filter((row) => row.checked === "true").map((row) => row.method)).toEqual(["zelle"]);
      expect(zelle.options.find((row) => row.method === "cashapp")?.bg).toBe(muted.dark.bg);
      expect(zelle.options.find((row) => row.method === "zelle")?.bg).toBe(brands.zelle.dark);
      expect(zelle.options.find((row) => row.method === "venmo")?.bg).toBe(muted.dark.bg);
      expect(zelle.options.some((row) => row.method === "square" || row.method === "paypal" || row.method === "card")).toBe(false);
      await page.click("#rosterPaidMethodConfirmBtn");
      await page.waitForFunction(() => document.getElementById("rosterPaidMethodModal")?.classList.contains("hidden"), { timeout: 10000 });
      const saved = await page.evaluate(() => {
        const apps = (window as unknown as { getTenant?: () => { appointments?: { id?: string; paidMethod?: string; paymentStatus?: string }[] } }).getTenant?.()?.appointments || [];
        const row = apps.find((app) => app && app.id === "HB-1002");
        return { paidMethod: row?.paidMethod || "", paymentStatus: row?.paymentStatus || "" };
      });
      expect(saved).toEqual({ paidMethod: "zelle", paymentStatus: "PAID" });
      await page.evaluate(() => (window as unknown as { openRosterPaidMethodModal: (id: string) => void }).openRosterPaidMethodModal("HB-1003"));
      await page.waitForSelector("#rosterPaidMethodModal:not(.hidden) #rosterPaidMethodOptions .roster-paid-opt", { timeout: 10000 });
      const cash = await read();
      expect(cash.enabled).toBe(false);
      expect(cash.options.filter((row) => row.checked === "true")).toEqual([]);
      expect(cash.options.map((row) => row.method)).toEqual(["cashapp", "zelle", "venmo", "cash"]);
      expect(cash.options.find((row) => row.method === "cash")?.bg).toBe(muted.dark.bg);
      expect(cash.options.some((row) => row.method === "card")).toBe(false);
      await page.evaluate(() => {
        const tenant = (window as unknown as { getTenant?: () => { paymentGateways?: Record<string, boolean> } }).getTenant?.();
        if (!tenant || !tenant.paymentGateways) return;
        tenant.paymentGateways.card = true;
        tenant.paymentGateways.square = true;
        tenant.paymentGateways.cashapp = false;
        tenant.paymentGateways.paypal = false;
        tenant.paymentGateways.later = false;
        (window as unknown as { openRosterPaidMethodModal: (id: string) => void }).openRosterPaidMethodModal("HB-1003");
      });
      await page.waitForSelector('#rosterPaidMethodOptions [data-paid-method="card"]', { timeout: 10000 });
      const gated = await read();
      expect(gated.options.map((row) => row.method)).toEqual(["card", "zelle", "venmo", "cash"]);
      expect(gated.options.some((row) => row.method === "square")).toBe(false);
      expect(gated.options.find((row) => row.method === "card")?.label).toBe("Card (Stripe)");
      expect(gated.options.find((row) => row.method === "cash")?.checked).toBe("false");
      await page.evaluate(() => {
        const card = document.querySelector('#rosterPaidMethodOptions [data-paid-method="card"]') as HTMLButtonElement | null;
        card?.click();
      });
      for (const theme of ["dark", "light"] as const) {
        await page.evaluate((mode) => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode), theme);
        const picked = await read();
        const card = picked.options.find((row) => row.method === "card");
        expect(card?.checked).toBe("true");
        expect(card?.bg).toBe(brands.card[theme]);
        expect(card?.fg).toBe(brands.card.fg);
        expect(picked.options.find((row) => row.method === "zelle")?.bg).toBe(muted[theme].bg);
      }
      await page.click("#rosterPaidMethodConfirmBtn");
      await page.waitForFunction(() => document.getElementById("rosterPaidMethodModal")?.classList.contains("hidden"), { timeout: 10000 });
      const cardPaid = await page.evaluate(() => {
        const row = [...document.querySelectorAll("#schediTodaySchedule article")].find((node) => node.textContent?.includes("Jordan"));
        const pill = row?.querySelector(".sd-pay") as HTMLElement | null;
        const style = pill ? getComputedStyle(pill) : null;
        return { text: pill?.textContent || "", cls: pill?.className || "", color: style?.color || "" };
      });
      expect(cardPaid.text).toContain("Card · $80");
      expect(cardPaid.cls).toContain("sd-pay-card");
      expect(cardPaid.color).toBe("rgb(67, 56, 202)");
      await page.evaluate(() => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme("dark"));
      const cardPaidDark = await page.evaluate(() => {
        const row = [...document.querySelectorAll("#schediTodaySchedule article")].find((node) => node.textContent?.includes("Jordan"));
        const pill = row?.querySelector(".sd-pay") as HTMLElement | null;
        return getComputedStyle(pill as Element).color;
      });
      expect(cardPaidDark).toBe("rgb(196, 192, 255)");
      expect(writes).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 90000);

  it("keeps card actions neutral at rest at 340 and 390 in light and dark", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const rest = {
      dark: { bg: "rgb(30, 41, 59)", fg: "rgb(226, 232, 240)", border: "rgb(51, 65, 85)" },
      light: { bg: "rgb(255, 255, 255)", fg: "rgb(15, 23, 42)", border: "rgb(203, 213, 225)" },
    };
    const green = {
      dark: { bg: "rgba(16, 185, 129, 0.18)", fg: "rgb(52, 211, 153)", border: "rgb(52, 211, 153)" },
      light: { bg: "rgb(236, 253, 245)", fg: "rgb(4, 120, 87)", border: "rgb(110, 231, 183)" },
    };
    const red = {
      dark: { bg: "rgba(244, 63, 94, 0.16)", fg: "rgb(251, 113, 133)", border: "rgb(251, 113, 133)" },
      light: { bg: "rgb(255, 241, 242)", fg: "rgb(190, 18, 60)", border: "rgb(253, 164, 175)" },
    };
    try {
      const page = await browser.newPage();
      const writes: string[] = [];
      page.on("request", (req) => {
        if (req.method() !== "GET" && req.method() !== "HEAD") writes.push(req.url());
      });
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.waitForFunction(() => {
        const apps = (window as unknown as { getTenant?: () => { appointments?: { id?: string }[] } }).getTenant?.()?.appointments || [];
        return apps.some((row) => row && row.id === "HB-1022");
      }, { timeout: 20000 });
      const read = (selector: string) => page.evaluate((sel) => {
        const root = document.querySelector(sel);
        return Array.from(root?.querySelectorAll(":scope > button") || []).map((node) => {
          const el = node as HTMLButtonElement;
          const style = getComputedStyle(el);
          const icon = el.querySelector("i");
          const box = el.getBoundingClientRect();
          return {
            label: (el.textContent || "").replace(/\s+/g, " ").trim(),
            bg: style.backgroundColor,
            fg: style.color,
            border: style.borderTopColor,
            icon: icon ? getComputedStyle(icon).color : "",
            h: Math.round(box.height),
            w: Math.round(box.width),
          };
        });
      }, selector);
      const mark = async (selector: string, label: string) => {
        const found = await page.evaluate((sel, name) => {
          document.querySelectorAll("[data-act-probe]").forEach((el) => el.removeAttribute("data-act-probe"));
          const root = document.querySelector(sel);
          const btn = Array.from(root?.querySelectorAll(":scope > button") || []).find((el) => (el.textContent || "").replace(/\s+/g, " ").trim() === name) as HTMLElement | undefined;
          if (!btn) return false;
          btn.setAttribute("data-act-probe", "1");
          btn.scrollIntoView({ block: "center", inline: "center" });
          return true;
        }, selector, label);
        expect(found).toBe(true);
      };
      const hover = async (selector: string, label: string, expected: { bg: string; fg: string; border?: string }) => {
        await mark(selector, label);
        await page.hover("[data-act-probe='1']");
        await page.waitForFunction((bg, fg, border) => {
          const el = document.querySelector("[data-act-probe='1']");
          if (!el) return false;
          const style = getComputedStyle(el);
          if (style.backgroundColor !== bg || style.color !== fg) return false;
          return !border || style.borderTopColor === border;
        }, { timeout: 2000 }, expected.bg, expected.fg, expected.border || "");
        return page.$eval("[data-act-probe='1']", (el) => {
          const style = getComputedStyle(el);
          const icon = el.querySelector("i");
          return {
            bg: style.backgroundColor,
            fg: style.color,
            border: style.borderTopColor,
            icon: icon ? getComputedStyle(icon).color : "",
          };
        });
      };
      const list = '[data-booking-id="HB-1022"] .roster-actions';
      const expectRest = (rows: { label: string; bg: string; fg: string; border: string; icon: string; h: number; w: number }[], theme: "dark" | "light") => {
        expect(rows.map((row) => row.label)).toEqual(["Mark paid", "Edit", "Reschedule", "Mark no-show", "Cancel", "Delete"]);
        for (const row of rows) {
          expect(row.bg).toBe(rest[theme].bg);
          expect(row.fg).toBe(rest[theme].fg);
          expect(row.border).toBe(rest[theme].border);
          expect(row.h).toBeGreaterThanOrEqual(44);
          expect(row.w).toBeGreaterThan(40);
          if (row.icon) expect(row.icon).toBe(rest[theme].fg);
        }
      };
      const expectPrimary = (rows: { label: string; bg: string; fg: string; border: string; icon: string; h: number; w: number }[], theme: "dark" | "light") => {
        expect(rows.map((row) => row.label)).toEqual(["Mark paid"]);
        for (const row of rows) {
          expect(row.bg).toBe(rest[theme].bg);
          expect(row.fg).toBe(rest[theme].fg);
          expect(row.border).toBe(rest[theme].border);
          expect(row.h).toBeGreaterThanOrEqual(44);
          expect(row.w).toBeGreaterThan(40);
          if (row.icon) expect(row.icon).toBe(rest[theme].fg);
        }
      };
      for (const width of [340, 390]) {
        await page.setViewport({ width, height: 900 });
        await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("appointments"));
        await page.waitForSelector(list, { timeout: 10000 });
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode), theme);
          await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), list);
          await page.waitForFunction((sel, bg, fg) => {
            const el = document.querySelector(sel + " > button");
            if (!el) return false;
            const style = getComputedStyle(el);
            return style.backgroundColor === bg && style.color === fg;
          }, { timeout: 2000 }, list, rest[theme].bg, rest[theme].fg);
          expectPrimary(await read(list), theme);
          const paid = await hover(list, "Mark paid", green[theme]);
          expect(paid).toMatchObject({ ...green[theme], icon: green[theme].fg });
          await page.mouse.move(2, 2);
          await page.evaluate((sel) => {
            const summary = document.querySelector(sel + " summary") as HTMLElement | null;
            summary?.click();
          }, list);
          const menuRoot = list + " .sd-more-menu";
          await page.waitForFunction((sel) => {
            const menu = document.querySelector(sel) as HTMLElement | null;
            return !!menu && getComputedStyle(menu).visibility === "visible";
          }, { timeout: 5000 }, menuRoot);
          const menuLabels = await page.evaluate((sel) => {
            return Array.from(document.querySelectorAll(sel + " > button")).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim());
          }, menuRoot);
          expect(menuLabels).toEqual(["Edit", "Reschedule", "Mark no-show", "Cancel", "Delete"]);
          const menuRest = theme === "dark" ? "rgb(241, 245, 249)" : "rgb(15, 23, 42)";
          const deleteRest = theme === "dark" ? "rgb(251, 113, 133)" : "rgb(190, 18, 60)";
          const menuRestRows = await read(menuRoot);
          for (const row of menuRestRows) {
            expect(row.fg).toBe(row.label === "Delete" ? deleteRest : menuRest);
            expect(row.bg).toBe("rgba(0, 0, 0, 0)");
          }
          const reschedule = await hover(menuRoot, "Reschedule", { bg: green[theme].bg, fg: green[theme].fg });
          expect(reschedule.fg).toBe(green[theme].fg);
          expect(reschedule.bg).toBe(green[theme].bg);
          const cancel = await hover(menuRoot, "Cancel", { bg: red[theme].bg, fg: red[theme].fg });
          expect(cancel.fg).toBe(red[theme].fg);
          expect(cancel.bg).toBe(red[theme].bg);
          await page.mouse.move(2, 2);
          await page.evaluate(() => (window as unknown as { closeSchediTodayMenus: () => void }).closeSchediTodayMenus());
          await page.waitForFunction((sel, color) => {
            const el = document.querySelector(sel + " > button");
            return !!el && getComputedStyle(el).color === color;
          }, { timeout: 2000 }, list, rest[theme].fg);
        }
      }
      await page.setViewport({ width: 390, height: 900 });
      await page.evaluate(() => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme("dark"));
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("appointments"));
      await page.waitForSelector(list, { timeout: 10000 });
      await mark(list, "Mark paid");
      const point = await page.$eval("[data-act-probe='1']", (el) => {
        const box = el.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      await page.evaluate(() => {
        const block = (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
        };
        document.addEventListener("click", block, true);
        (window as unknown as { __schediUnblockClick?: () => void }).__schediUnblockClick = () => document.removeEventListener("click", block, true);
      });
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.waitForFunction(() => {
        const el = document.querySelector("[data-act-probe='1']");
        return !!el && el.matches(":active") && getComputedStyle(el).color === "rgb(52, 211, 153)";
      }, { timeout: 2000 });
      const pressed = await page.$eval("[data-act-probe='1']", (el) => {
        const style = getComputedStyle(el);
        return {
          bg: style.backgroundColor,
          fg: style.color,
          border: style.borderTopColor,
          active: el.matches(":active"),
        };
      });
      expect(pressed.active).toBe(true);
      expect(pressed.bg).toBe(green.dark.bg);
      expect(pressed.fg).toBe(green.dark.fg);
      expect(pressed.border).toBe(green.dark.border);
      await page.mouse.up();
      await page.evaluate(() => (window as unknown as { __schediUnblockClick?: () => void }).__schediUnblockClick?.());
      await page.mouse.move(2, 2);
      await page.waitForFunction(() => {
        const el = document.querySelector("[data-act-probe='1']");
        return !!el && getComputedStyle(el).color === "rgb(226, 232, 240)";
      }, { timeout: 2000 });
      await page.$eval("[data-act-probe='1']", (el) => (el as HTMLElement).focus());
      await page.keyboard.press("Tab");
      await page.keyboard.down("Shift");
      await page.keyboard.press("Tab");
      await page.keyboard.up("Shift");
      await page.waitForFunction(() => {
        const el = document.querySelector("[data-act-probe='1']");
        return !!el && el.matches(":focus-visible") && getComputedStyle(el).color === "rgb(52, 211, 153)";
      }, { timeout: 2000 });
      const focused = await page.$eval("[data-act-probe='1']", (el) => el.matches(":focus-visible"));
      expect(focused).toBe(true);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.evaluate(() => (window as unknown as { openRosterApptModal: (id: string) => void }).openRosterApptModal("HB-1022"));
      await page.waitForSelector("#rosterApptModal:not(.hidden) .roster-sheet-actions", { timeout: 10000 });
      expectRest(await read("#rosterApptModal .roster-sheet-actions"), "dark");
      const sheetPaid = await hover("#rosterApptModal .roster-sheet-actions", "Mark paid", green.dark);
      expect(sheetPaid.fg).toBe(green.dark.fg);
      expect(sheetPaid.bg).toBe(green.dark.bg);
      await page.mouse.move(2, 2);
      await page.waitForFunction(() => {
        const el = document.querySelector("#rosterApptModal .roster-sheet-actions button");
        return !!el && getComputedStyle(el).color === "rgb(226, 232, 240)";
      }, { timeout: 2000 });
      await page.evaluate(() => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme("light"));
      await page.waitForFunction((bg, fg, border) => {
        const buttons = Array.from(document.querySelectorAll("#rosterApptModal .roster-sheet-actions > button"));
        return buttons.length === 6 && buttons.every((el) => {
          const style = getComputedStyle(el);
          return style.backgroundColor === bg && style.color === fg && style.borderTopColor === border;
        });
      }, { timeout: 2000 }, rest.light.bg, rest.light.fg, rest.light.border);
      expectRest(await read("#rosterApptModal .roster-sheet-actions"), "light");
      const sheetDelete = await hover("#rosterApptModal .roster-sheet-actions", "Delete", red.light);
      expect(sheetDelete).toMatchObject({ ...red.light, icon: red.light.fg });
      await page.mouse.move(2, 2);
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("#rosterApptModal .roster-sheet-actions button")).find((el) => (el.textContent || "").includes("Reschedule")) as HTMLButtonElement | undefined;
        btn?.click();
      });
      await page.waitForSelector("#tenantRescheduleModal:not(.hidden)", { timeout: 10000 });
      expect(await page.$eval("#rescheduleAppId", (el) => (el as HTMLInputElement).value)).toBe("HB-1022");
      await page.evaluate(() => (window as unknown as { closeTenantRescheduleModal: () => void }).closeTenantRescheduleModal());
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("appointments"));
      await page.evaluate(() => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme("dark"));
      await page.waitForSelector(list, { timeout: 10000 });
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('[data-booking-id="HB-1022"] .roster-actions button')).find((el) => (el.textContent || "").includes("Mark paid")) as HTMLButtonElement | undefined;
        btn?.click();
      });
      await page.waitForSelector("#rosterPaidMethodModal:not(.hidden)", { timeout: 10000 });
      const stillUnpaid = await page.evaluate(() => {
        const apps = (window as unknown as { getTenant?: () => { appointments?: { id?: string; paymentStatus?: string }[] } }).getTenant?.()?.appointments || [];
        return apps.find((row) => row && row.id === "HB-1022")?.paymentStatus || "";
      });
      expect(stillUnpaid).toBe("PAY AT APPOINTMENT");
      await page.evaluate(() => (window as unknown as { closeRosterPaidMethodModal: () => void }).closeRosterPaidMethodModal());
      const accept = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('[data-booking-id="HB-1002"] .roster-actions button')).find((el) => (el.textContent || "").trim() === "Accept") as HTMLElement | undefined;
        if (!btn) return null;
        return { fg: getComputedStyle(btn).color, cls: btn.className };
      });
      expect(accept?.cls).toContain("text-emerald-400");
      expect(accept?.fg).not.toBe(rest.dark.fg);
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("today"));
      await page.waitForSelector('#schediTodaySchedule button[onclick*="HB-1003"]', { timeout: 10000 });
      for (const theme of ["dark", "light"] as const) {
        await page.setViewport({ width: theme === "dark" ? 340 : 390, height: 900 });
        await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("today"));
        await page.evaluate((mode) => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode), theme);
        await page.evaluate(() => {
          const summary = document.querySelector('#schediTodaySchedule button[onclick*="HB-1003"]')?.closest("article")?.querySelector("summary");
          summary?.scrollIntoView({ block: "center" });
        });
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        await page.evaluate(() => {
          const summary = document.querySelector('#schediTodaySchedule button[onclick*="HB-1003"]')?.closest("article")?.querySelector("summary") as HTMLElement | undefined;
          summary?.click();
        });
        await page.waitForFunction(() => {
          const menu = document.querySelector('#schediTodaySchedule button[onclick*="HB-1003"]')?.closest(".sd-more-menu") as HTMLElement | null;
          return !!menu && getComputedStyle(menu).visibility === "visible";
        }, { timeout: 5000 });
        const menu = await page.evaluate(() => {
          const root = document.querySelector('#schediTodaySchedule button[onclick*="HB-1003"]')?.closest(".sd-more-menu");
          return Array.from(root?.querySelectorAll("button") || []).map((node) => {
            const el = node as HTMLButtonElement;
            const style = getComputedStyle(el);
            return {
              label: (el.textContent || "").replace(/\s+/g, " ").trim(),
              bg: style.backgroundColor,
              fg: style.color,
              border: style.borderTopWidth,
            };
          });
        });
        expect(menu.map((row) => row.label)).toEqual(["Mark paid", "Reschedule", "Mark no-show", "Cancel", "Edit", "Delete"]);
        const menuRest = theme === "dark" ? "rgb(241, 245, 249)" : "rgb(15, 23, 42)";
        const deleteRest = theme === "dark" ? "rgb(251, 113, 133)" : "rgb(190, 18, 60)";
        for (const row of menu) {
          expect(row.fg).toBe(row.label === "Delete" ? deleteRest : menuRest);
          expect(row.bg).toBe("rgba(0, 0, 0, 0)");
          expect(row.border).toBe("0px");
        }
        const menuRoot = "#schediTodaySchedule details.sd-more[open] .sd-more-menu";
        const menuPaid = await hover(menuRoot, "Mark paid", { bg: green[theme].bg, fg: green[theme].fg });
        expect(menuPaid.fg).toBe(green[theme].fg);
        expect(menuPaid.bg).toBe(green[theme].bg);
        const menuCancel = await hover(menuRoot, "Cancel", { bg: red[theme].bg, fg: red[theme].fg });
        expect(menuCancel.fg).toBe(red[theme].fg);
        expect(menuCancel.bg).toBe(red[theme].bg);
        await page.mouse.move(2, 2);
      }
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("clients"));
      await page.waitForFunction(() => !!document.querySelector('.sd-client-name[data-client-id="CL-JORDAN"]'), { timeout: 10000 });
      await page.evaluate(() => (window as unknown as { openClientDetail: (id: string) => void }).openClientDetail("CL-JORDAN"));
      await page.waitForSelector("#sdClientPanel:not([hidden]) .sd-client-visit", { timeout: 10000 });
      const clientActions = await page.evaluate(() => {
        const panel = document.getElementById("sdClientPanel");
        return Array.from(panel?.querySelectorAll("button") || []).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim());
      });
      expect(clientActions).toContain("Edit");
      expect(clientActions.some((label) => label === "Mark paid" || label === "Reschedule" || label === "Cancel" || label === "Delete" || label === "Mark no-show")).toBe(false);
      expect(writes).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("opens today's schedule from the borderless kebab, and a card tap stays closed, at 340 and 390", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      const measure = () => page.evaluate(() => {
        const card = document.querySelector("#schediTodaySchedule article.sd-row") as HTMLElement | null;
        const summary = card?.querySelector("summary") as HTMLElement | null;
        const icon = summary?.querySelector("i");
        if (!card || !summary) return null;
        const cardStyle = getComputedStyle(card);
        const summaryStyle = getComputedStyle(summary);
        const box = summary.getBoundingClientRect();
        const iconStyle = icon ? getComputedStyle(icon) : null;
        const before = icon ? getComputedStyle(icon, "::before") : null;
        let inkH = 0;
        let inkW = 0;
        if (icon && before) {
          const content = JSON.parse(before.content);
          const canvas = document.createElement("canvas");
          const scale = 8;
          canvas.width = 120 * scale;
          canvas.height = 120 * scale;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.scale(scale, scale);
            ctx.font = before.font;
            ctx.textBaseline = "top";
            ctx.lineJoin = "round";
            ctx.lineWidth = (iconStyle ? parseFloat(iconStyle.webkitTextStrokeWidth) : 0) * 2;
            ctx.strokeStyle = "#fff";
            ctx.fillStyle = "#fff";
            if (ctx.lineWidth) ctx.strokeText(content, 24, 24);
            ctx.fillText(content, 24, 24);
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let minY = canvas.height;
            let maxY = 0;
            let minX = canvas.width;
            let maxX = 0;
            for (let y = 0; y < canvas.height; y++) {
              for (let x = 0; x < canvas.width; x++) {
                if (pixels[(y * canvas.width + x) * 4 + 3] > 40) {
                  if (y < minY) minY = y;
                  if (y > maxY) maxY = y;
                  if (x < minX) minX = x;
                  if (x > maxX) maxX = x;
                }
              }
            }
            inkH = (maxY - minY + 1) / scale;
            inkW = (maxX - minX + 1) / scale;
          }
        }
        return {
          role: card.getAttribute("role"),
          tab: card.getAttribute("tabindex"),
          popup: card.getAttribute("aria-haspopup"),
          cardExpanded: card.getAttribute("aria-expanded"),
          cursor: cardStyle.cursor,
          cardBg: cardStyle.backgroundColor,
          label: summary.getAttribute("aria-label"),
          expanded: summary.getAttribute("aria-expanded"),
          icon: icon?.className || "",
          w: Math.round(box.width),
          h: Math.round(box.height),
          radius: summaryStyle.borderRadius,
          border: summaryStyle.borderTopWidth,
          bg: summaryStyle.backgroundColor,
          fill: summaryStyle.backgroundImage,
          glyph: iconStyle?.fontSize || "",
          stroke: iconStyle?.webkitTextStrokeWidth || "",
          inkH,
          inkW,
          color: summaryStyle.color,
        };
      });
      const menuClosed = () => page.evaluate(() => document.querySelectorAll("details.sd-more[open]").length === 0);
      for (const width of [340, 390]) {
        await page.setViewport({ width, height: 900 });
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode), theme);
          await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("today"));
          await page.waitForSelector("#schediTodaySchedule article.sd-row summary", { timeout: 10000 });
          const view = await measure();
          expect(view?.role).toBeNull();
          expect(view?.tab).toBeNull();
          expect(view?.popup).toBeNull();
          expect(view?.cardExpanded).toBeNull();
          expect(view?.cursor).toBe("auto");
          expect(view?.label).toBe("More actions");
          expect(view?.expanded).toBe("false");
          expect(view?.icon).toContain("fa-ellipsis-vertical");
          expect(view?.w).toBeGreaterThanOrEqual(48);
          expect(view?.h).toBeGreaterThanOrEqual(48);
          expect(view?.glyph).toBe("26px");
          expect(view?.stroke).toBe("0.5px");
          expect(view?.inkH).toBeGreaterThanOrEqual(22);
          expect(view?.inkH).toBeLessThanOrEqual(24);
          expect(view?.inkW).toBeGreaterThanOrEqual(6);
          expect(view?.color).toBe(theme === "dark" ? "rgb(241, 245, 249)" : "rgb(15, 23, 42)");
          expect(view?.border).toBe("0px");
          expect(view?.bg).toBe("rgba(0, 0, 0, 0)");
          expect(view?.radius).toBe("999px");
          await page.evaluate(() => document.querySelector("#schediTodaySchedule article.sd-row")?.scrollIntoView({ block: "center" }));
          const pointOf = (selector: string) => page.$eval(selector, (el) => {
            const box = el.getBoundingClientRect();
            return { x: box.x + Math.min(12, box.width / 2), y: box.y + box.height / 2 };
          });
          const namePoint = await pointOf("#schediTodaySchedule article.sd-row .sd-row-title");
          const restBg = view?.cardBg;
          await page.mouse.move(namePoint.x, namePoint.y);
          await page.mouse.down();
          const pressed = await page.$eval("#schediTodaySchedule article.sd-row", (el) => getComputedStyle(el).backgroundColor);
          await page.mouse.up();
          expect(pressed).toBe(restBg);
          expect(pressed).not.toBe("rgba(148, 163, 184, 0.14)");
          expect(pressed).not.toBe("rgb(241, 245, 249)");
          expect(await menuClosed()).toBe(true);
          const cardKeys = await page.evaluate(() => {
            const card = document.querySelector("#schediTodaySchedule article.sd-row");
            const title = card?.querySelector(".sd-row-title");
            const time = card?.querySelector(".sd-time");
            if (title instanceof HTMLElement) title.click();
            if (time instanceof HTMLElement) time.click();
            if (card instanceof HTMLElement) card.click();
            if (!(card instanceof HTMLElement)) return false;
            card.focus();
            for (const key of ["Enter", " "]) card.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
            return document.querySelectorAll("details.sd-more[open]").length === 0;
          });
          expect(cardKeys).toBe(true);
          const summaryPoint = await pointOf("#schediTodaySchedule article.sd-row summary");
          await page.mouse.move(summaryPoint.x, summaryPoint.y);
          const hovered = await page.$eval("#schediTodaySchedule article.sd-row summary", (el) => getComputedStyle(el).backgroundColor);
          expect(hovered).not.toBe("rgba(0, 0, 0, 0)");
          await page.mouse.down();
          const kebabPressed = await page.$eval("#schediTodaySchedule article.sd-row summary", (el) => ({
            bg: getComputedStyle(el).backgroundColor,
            active: el.matches(":active"),
          }));
          await page.mouse.up();
          expect(kebabPressed.bg).not.toBe("rgba(0, 0, 0, 0)");
          expect(kebabPressed.active).toBe(true);
          await page.waitForFunction(() => {
            const summary = document.querySelector("#schediTodaySchedule article.sd-row summary");
            const menu = summary?.parentElement?.querySelector(".sd-more-menu") as HTMLElement | null;
            return summary?.getAttribute("aria-expanded") === "true" && !!menu && getComputedStyle(menu).visibility === "visible" && document.querySelectorAll("details.sd-more[open]").length === 1;
          }, { timeout: 5000 });
          const labels = await page.$$eval("#schediTodaySchedule details.sd-more[open] .sd-more-menu button", (nodes) => nodes.map((el) => (el.textContent || "").trim()));
          expect(labels).toContain("Reschedule");
          expect(labels).toContain("Edit");
          expect(labels).toContain("Delete");
          expect(labels.some((label) => label === "Mark paid" || label === "Mark unpaid")).toBe(true);
          await page.evaluate(() => {
            const summary = document.querySelector("#schediTodaySchedule article.sd-row summary");
            if (summary instanceof HTMLElement) summary.click();
          });
          await page.waitForFunction(() => document.querySelector("#schediTodaySchedule article.sd-row summary")?.getAttribute("aria-expanded") === "false" && document.querySelectorAll("details.sd-more[open]").length === 0, { timeout: 5000 });
        }
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("hides today's actions menu after every item, Escape, outside tap, and an opening sheet", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const modalFor: Record<string, string> = {
      "Mark paid": "rosterPaidMethodModal",
      "Reschedule": "tenantRescheduleModal",
      Edit: "manualBookingModal",
      Cancel: "ownerConfirmModal",
      Delete: "rosterDeleteModal",
      "Mark unpaid": "unpaidStripeModal",
    };
    const closeFor: Record<string, string> = {
      "Mark paid": "closeRosterPaidMethodModal",
      Reschedule: "closeTenantRescheduleModal",
      Edit: "closeManualBookingModal",
      Cancel: "closeOwnerConfirm",
      Delete: "closeRosterDeleteModal",
      "Mark unpaid": "closeUnpaidStripeModal",
    };
    try {
      const page = await browser.newPage();
      page.on("dialog", (dialog) => {
        void dialog.dismiss();
      });
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.evaluate(() => {
        const tenant = (window as unknown as { getTenant: () => { appointments: { id?: string; date?: string }[] } }).getTenant();
        const today = tenant.appointments.find((app) => app.id === "HB-1001")?.date || "";
        const row = tenant.appointments.find((app) => app.id === "HB-1004");
        if (row && today) row.date = today;
      });
      const menuState = () => page.evaluate(() => {
        const menus = Array.from(document.querySelectorAll("#schediTodaySchedule .sd-more-menu")) as HTMLElement[];
        return {
          open: document.querySelectorAll("details.sd-more[open]").length,
          expanded: Array.from(document.querySelectorAll("#schediTodaySchedule summary")).filter((el) => el.getAttribute("aria-expanded") === "true").length,
          visible: menus.filter((menu) => getComputedStyle(menu).visibility !== "hidden").length,
        };
      });
      const openMenu = async (id: string) => {
        await page.evaluate((appointmentId) => {
          const button = document.querySelector(`#schediTodaySchedule button[onclick*="${appointmentId}"]`);
          const summary = button?.closest("article.sd-row")?.querySelector("summary");
          if (!(summary instanceof HTMLElement)) throw new Error("missing menu opener for " + appointmentId);
          summary.click();
        }, id);
        await page.waitForFunction((appointmentId) => {
          const button = document.querySelector(`#schediTodaySchedule button[onclick*="${appointmentId}"]`);
          const details = button?.closest("details");
          const menu = details?.querySelector(".sd-more-menu") as HTMLElement | null;
          const summary = details?.querySelector("summary");
          const openCount = document.querySelectorAll("details.sd-more[open]").length;
          return openCount === 1 && !!details?.open && summary?.getAttribute("aria-expanded") === "true" && !!menu && getComputedStyle(menu).visibility === "visible";
        }, { timeout: 5000 }, id);
      };
      const passes: Array<{ width: number; id: string; labels: string[] }> = [
        { width: 390, id: "HB-1004", labels: ["Reschedule", "Cancel", "Edit", "Delete"] },
        { width: 340, id: "HB-1003", labels: ["Mark paid", "Reschedule", "Mark no-show", "Cancel", "Edit", "Delete"] },
        { width: 390, id: "HB-1001", labels: ["Mark unpaid"] },
        { width: 340, id: "HB-1001", labels: ["Mark unpaid"] },
      ];
      for (const pass of passes) {
        await page.setViewport({ width: pass.width, height: 900 });
        await page.evaluate(() => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme("light"));
        await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("today"));
        await page.waitForSelector(`#schediTodaySchedule button[onclick*="${pass.id}"]`, { timeout: 10000 });
        const stayedClosed = await page.evaluate((appointmentId) => {
          const button = document.querySelector(`#schediTodaySchedule button[onclick*="${appointmentId}"]`);
          const card = button?.closest("article.sd-row");
          const title = card?.querySelector(".sd-row-title");
          const time = card?.querySelector(".sd-time");
          if (title instanceof HTMLElement) title.click();
          if (time instanceof HTMLElement) time.click();
          if (card instanceof HTMLElement) card.click();
          return document.querySelectorAll("details.sd-more[open]").length === 0;
        }, pass.id);
        expect(stayedClosed).toBe(true);
        for (const label of pass.labels) {
          await openMenu(pass.id);
          const stacked = await page.evaluate((appointmentId) => {
            const button = document.querySelector(`#schediTodaySchedule button[onclick*="${appointmentId}"]`);
            const menu = button?.closest(".sd-more-menu") as HTMLElement | null;
            return menu ? Number.parseInt(getComputedStyle(menu).zIndex, 10) : 0;
          }, pass.id);
          expect(stacked).toBe(45);
          const tapped = await page.evaluate((appointmentId, item) => {
            const buttons = Array.from(document.querySelectorAll(`#schediTodaySchedule button[onclick*="${appointmentId}"]`));
            const hit = buttons.find((el) => (el.textContent || "").trim() === item);
            if (!(hit instanceof HTMLElement)) return false;
            hit.click();
            return true;
          }, pass.id, label);
          expect(tapped).toBe(true);
          await page.waitForFunction(() => document.querySelectorAll("details.sd-more[open]").length === 0, { timeout: 5000 });
          expect(await menuState()).toEqual({ open: 0, expanded: 0, visible: 0 });
          const modalId = modalFor[label];
          if (modalId) {
            const stack = await page.evaluate((id, appointmentId) => {
              const dialog = document.getElementById(id) as HTMLElement | null;
              const menu = document.querySelector(`#schediTodaySchedule button[onclick*="${appointmentId}"]`)?.closest(".sd-more-menu") as HTMLElement | null;
              const title = dialog?.querySelector("h3") as HTMLElement | null;
              const box = title?.getBoundingClientRect();
              const hit = box ? document.elementFromPoint(box.x + 12, box.y + Math.min(8, box.height / 2)) : null;
              return {
                open: !!dialog && !dialog.classList.contains("hidden"),
                menuZ: menu ? Number.parseInt(getComputedStyle(menu).zIndex, 10) : 0,
                dialogZ: dialog ? Number.parseInt(getComputedStyle(dialog).zIndex, 10) : 0,
                inMenu: !!hit?.closest(".sd-more-menu"),
                inDialog: !!hit?.closest(`#${id}`),
              };
            }, modalId, pass.id);
            expect(stack.open).toBe(true);
            expect(stack.menuZ).toBeLessThan(stack.dialogZ);
            expect(stack.inMenu).toBe(false);
            expect(stack.inDialog).toBe(true);
            await page.evaluate((name) => {
              const api = window as unknown as Record<string, () => void>;
              api[name]();
            }, closeFor[label]);
            expect(await menuState()).toEqual({ open: 0, expanded: 0, visible: 0 });
          }
        }
      }
      await page.setViewport({ width: 390, height: 900 });
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("today"));
      await openMenu("HB-1003");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelectorAll("details.sd-more[open]").length === 0, { timeout: 5000 });
      expect(await menuState()).toEqual({ open: 0, expanded: 0, visible: 0 });
      await openMenu("HB-1003");
      await page.evaluate(() => {
        const heading = document.getElementById("schediTodayHeading");
        if (!(heading instanceof HTMLElement)) throw new Error("missing today heading");
        heading.click();
      });
      await page.waitForFunction(() => document.querySelectorAll("details.sd-more[open]").length === 0, { timeout: 5000 });
      expect(await menuState()).toEqual({ open: 0, expanded: 0, visible: 0 });
      await openMenu("HB-1003");
      await page.evaluate(() => (window as unknown as { schediDashToggleMore: (force?: boolean) => void }).schediDashToggleMore(true));
      await page.waitForFunction(() => {
        const sheet = document.getElementById("schediDashMoreSheet");
        return !!sheet && !sheet.hidden && document.querySelectorAll("details.sd-more[open]").length === 0;
      }, { timeout: 5000 });
      expect(await menuState()).toEqual({ open: 0, expanded: 0, visible: 0 });
      await page.evaluate(() => (window as unknown as { schediDashToggleMore: (force?: boolean) => void }).schediDashToggleMore(false));
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("clears a no-show from the today menu, roster actions, and details card at 340 and 390", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const menuFg = { dark: "rgb(241, 245, 249)", light: "rgb(15, 23, 42)" };
    try {
      const page = await browser.newPage();
      const writes: string[] = [];
      page.on("request", (req) => {
        if (req.method() !== "GET" && req.method() !== "HEAD") writes.push(req.url());
      });
      page.on("dialog", (dialog) => { void dialog.dismiss(); });
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.waitForFunction(() => {
        const apps = (window as unknown as { getTenant?: () => { appointments?: { id?: string }[] } }).getTenant?.()?.appointments || [];
        return apps.some((row) => row && row.id === "HB-1005");
      }, { timeout: 20000 });
      const openMenu = async (id: string) => {
        await page.evaluate((appointmentId) => {
          const button = document.querySelector(`#schediTodaySchedule button[onclick*="${appointmentId}"]`);
          const summary = button?.closest("article.sd-row")?.querySelector("summary");
          if (!(summary instanceof HTMLElement)) throw new Error("missing menu opener for " + appointmentId);
          summary.scrollIntoView({ block: "center" });
        }, id);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        await page.evaluate((appointmentId) => {
          const button = document.querySelector(`#schediTodaySchedule button[onclick*="${appointmentId}"]`);
          const summary = button?.closest("article.sd-row")?.querySelector("summary");
          if (!(summary instanceof HTMLElement)) throw new Error("missing menu opener for " + appointmentId);
          summary.click();
        }, id);
        await page.waitForFunction((appointmentId) => {
          const button = document.querySelector(`#schediTodaySchedule button[onclick*="${appointmentId}"]`);
          const details = button?.closest("details");
          const menu = details?.querySelector(".sd-more-menu") as HTMLElement | null;
          return !!details?.open && !!menu && getComputedStyle(menu).visibility === "visible";
        }, { timeout: 5000 }, id);
      };
      const visitOf = (id: string) => page.evaluate((appointmentId) => {
        const apps = (window as unknown as { getTenant: () => { appointments: { id?: string; status?: string; noShow?: boolean; paymentStatus?: string; refundAmount?: number }[] } }).getTenant().appointments;
        const row = apps.find((app) => app && app.id === appointmentId);
        return row ? { status: row.status || "", noShow: row.noShow === true, paymentStatus: row.paymentStatus || "", refundAmount: row.refundAmount } : null;
      }, id);
      for (const width of [340, 390]) {
        for (const theme of ["dark", "light"] as const) {
          await page.setViewport({ width, height: 900 });
          await page.evaluate((mode) => {
            (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode);
            (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("today");
            (window as unknown as { markAppointmentNoShow: (id: string) => void }).markAppointmentNoShow("HB-1003");
          }, theme);
          await page.waitForFunction(() => (document.getElementById("toastContainer")?.textContent || "").includes("Marked #HB-1003 as a no-show."), { timeout: 5000 });
          const marked = await visitOf("HB-1003");
          expect(marked).toMatchObject({ status: "accepted", noShow: true, paymentStatus: "PAY AT APPOINTMENT" });
          await openMenu("HB-1003");
          const menu = await page.evaluate(() => {
            const root = document.querySelector('#schediTodaySchedule button[onclick*="HB-1003"]')?.closest(".sd-more-menu");
            return Array.from(root?.querySelectorAll("button") || []).map((node) => {
              const el = node as HTMLButtonElement;
              const style = getComputedStyle(el);
              const icon = el.querySelector("i");
              return {
                label: (el.textContent || "").replace(/\s+/g, " ").trim(),
                cls: el.className,
                fg: style.color,
                bg: style.backgroundColor,
                icon: icon ? icon.className : "",
              };
            });
          });
          expect(menu.map((row) => row.label)).toEqual(["Mark paid", "Reschedule", "Undo no-show", "Cancel", "Edit", "Delete"]);
          const undo = menu.find((row) => row.label === "Undo no-show");
          expect(undo?.icon).toContain("fa-rotate-left");
          expect(undo?.cls).not.toContain("sd-act-ok");
          expect(undo?.cls).not.toContain("sd-act-no");
          expect(undo?.fg).toBe(menuFg[theme]);
          expect(undo?.bg).toBe("rgba(0, 0, 0, 0)");
          const chips = await page.evaluate(() => (document.querySelector('#schediTodaySchedule button[onclick*="HB-1003"]')?.closest("article")?.querySelector(".sd-row-chips")?.textContent || "").replace(/\s+/g, " ").trim());
          expect(chips).toContain("No-show");
          await page.evaluate(() => {
            const hit = Array.from(document.querySelectorAll('#schediTodaySchedule button[onclick*="HB-1003"]')).find((el) => (el.textContent || "").includes("Undo no-show"));
            if (!(hit instanceof HTMLElement)) throw new Error("missing undo");
            hit.click();
          });
          await page.waitForFunction(() => document.querySelectorAll("details.sd-more[open]").length === 0, { timeout: 5000 });
          await page.waitForFunction(() => (document.getElementById("toastContainer")?.textContent || "").includes("No-show cleared"), { timeout: 5000 });
          const cleared = await visitOf("HB-1003");
          expect(cleared).toMatchObject({ status: "accepted", noShow: false, paymentStatus: "PAY AT APPOINTMENT" });
          const after = await page.evaluate(() => (document.querySelector('#schediTodaySchedule button[onclick*="HB-1003"]')?.closest("article")?.querySelector(".sd-row-chips")?.textContent || "").replace(/\s+/g, " ").trim());
          expect(after).toContain("Accepted");
          expect(after).not.toContain("No-show");
          await openMenu("HB-1003");
          const restored = await page.evaluate(() => Array.from(document.querySelectorAll('#schediTodaySchedule button[onclick*="HB-1003"]')).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()));
          expect(restored).toContain("Mark no-show");
          expect(restored).not.toContain("Undo no-show");
          await page.evaluate(() => {
            const hit = Array.from(document.querySelectorAll('#schediTodaySchedule button[onclick*="HB-1003"]')).find((el) => (el.textContent || "").trim() === "Mark paid");
            if (!(hit instanceof HTMLElement)) throw new Error("missing mark paid");
            hit.click();
          });
          await page.waitForSelector("#rosterPaidMethodModal:not(.hidden)", { timeout: 5000 });
          expect(await visitOf("HB-1003")).toMatchObject({ paymentStatus: "PAY AT APPOINTMENT", noShow: false });
          await page.evaluate(() => (window as unknown as { closeRosterPaidMethodModal: () => void }).closeRosterPaidMethodModal());
          await page.waitForSelector("#rosterPaidMethodModal.hidden", { timeout: 5000 });
        }
      }
      for (const width of [340, 390]) {
        await page.setViewport({ width, height: 900 });
        await page.evaluate(() => {
          const tenant = (window as unknown as { getTenant: () => { appointments: { id?: string; date?: string; status?: string; noShow?: boolean }[] } }).getTenant();
          const today = tenant.appointments.find((app) => app && app.id === "HB-1001")?.date || "";
          const row = tenant.appointments.find((app) => app && app.id === "HB-1004");
          if (!row) throw new Error("missing HB-1004");
          if (today) row.date = today;
          row.status = "no_show";
          row.noShow = true;
          (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("today");
        });
        await openMenu("HB-1004");
        const label = await page.evaluate(() => {
          const hit = Array.from(document.querySelectorAll('#schediTodaySchedule button[onclick*="HB-1004"]')).find((el) => (el.textContent || "").includes("Undo no-show")) as HTMLButtonElement | undefined;
          const icon = hit?.querySelector("i");
          return { text: (hit?.textContent || "").replace(/\s+/g, " ").trim(), icon: icon ? icon.className : "", cls: hit?.className || "" };
        });
        expect(label.text).toBe("Undo no-show");
        expect(label.icon).toContain("fa-rotate-left");
        expect(label.cls).not.toContain("sd-act-no");
        if (width === 390) {
          await page.evaluate(() => {
            const hit = Array.from(document.querySelectorAll('#schediTodaySchedule button[onclick*="HB-1004"]')).find((el) => (el.textContent || "").includes("Undo no-show"));
            if (!(hit instanceof HTMLElement)) throw new Error("missing status undo");
            hit.click();
          });
          await page.waitForFunction(() => (document.getElementById("toastContainer")?.textContent || "").includes("No-show cleared"), { timeout: 5000 });
          expect(await visitOf("HB-1004")).toMatchObject({ status: "accepted", noShow: false, paymentStatus: "PENDING ZELLE" });
        } else {
          await page.keyboard.press("Escape");
          await page.waitForFunction(() => document.querySelectorAll("details.sd-more[open]").length === 0, { timeout: 5000 });
        }
      }
      const reportOf = () => page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll("#tenantReportBody .sd-report-card"));
        const read = (name: string) => {
          const card = cards.find((el) => (el.querySelector(".sd-report-kicker")?.textContent || "").includes(name));
          return {
            value: (card?.querySelector(".sd-report-value")?.textContent || "").trim(),
            aria: card?.querySelector(".sd-report-split")?.getAttribute("aria-label") || "",
          };
        };
        return { noShow: read("No-shows"), completion: read("Completion") };
      });
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("report"));
      await page.waitForSelector("#tenantReportBody .sd-report-card", { timeout: 10000 });
      const beforeReport = await reportOf();
      const beforeNoShow = Number(beforeReport.noShow.value);
      const beforeDone = Number((beforeReport.completion.aria.match(/(\d+) done/) || [])[1]);
      expect(beforeNoShow).toBeGreaterThan(0);
      expect(beforeDone).toBeGreaterThan(0);
      for (const width of [340, 390]) {
        for (const theme of ["dark", "light"] as const) {
          await page.setViewport({ width, height: 900 });
          await page.evaluate((mode) => {
            (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode);
            (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("appointments");
          }, theme);
          await page.waitForSelector('[data-booking-id="HB-1005"] .roster-actions', { timeout: 10000 });
          const button = await page.evaluate((fg) => {
            const root = document.querySelector('[data-booking-id="HB-1005"] .roster-actions');
            const hit = Array.from(root?.querySelectorAll(".sd-more-menu button") || []).find((el) => (el.textContent || "").includes("Undo no-show")) as HTMLButtonElement | undefined;
            if (!hit) return null;
            const style = getComputedStyle(hit);
            const icon = hit.querySelector("i");
            return {
              cls: hit.className,
              icon: icon ? icon.className : "",
              bg: style.backgroundColor,
              fg: style.color,
              border: style.borderTopWidth,
              direct: hit.parentElement === root,
              matches: style.backgroundColor === "rgba(0, 0, 0, 0)" && style.color === fg && style.borderTopWidth === "0px",
            };
          }, theme === "dark" ? "rgb(241, 245, 249)" : "rgb(15, 23, 42)");
          expect(button?.cls).not.toContain("sd-act-ok");
          expect(button?.cls).not.toContain("sd-act-no");
          expect(button?.icon).toContain("fa-rotate-left");
          expect(button?.direct).toBe(false);
          expect(button?.matches).toBe(true);
          expect(button?.bg).toBe("rgba(0, 0, 0, 0)");
          expect(button?.border).toBe("0px");
        }
      }
      await page.setViewport({ width: 390, height: 900 });
      await page.evaluate(() => (window as unknown as { openRosterApptModal: (id: string) => void }).openRosterApptModal("HB-1005"));
      await page.waitForSelector("#rosterApptModal:not(.hidden) .roster-sheet-actions", { timeout: 10000 });
      const sheet = await page.evaluate(() => {
        const hit = Array.from(document.querySelectorAll("#rosterApptModal .roster-sheet-actions button")).find((el) => (el.textContent || "").includes("Undo no-show")) as HTMLButtonElement | undefined;
        const icon = hit?.querySelector("i");
        const box = hit?.getBoundingClientRect();
        return {
          cls: hit?.className || "",
          icon: icon ? icon.className : "",
          h: box ? Math.round(box.height) : 0,
          chips: (document.getElementById("rosterApptBody")?.textContent || "").replace(/\s+/g, " ").trim(),
        };
      });
      expect(sheet.cls).toContain("sd-act");
      expect(sheet.cls).not.toContain("sd-act-ok");
      expect(sheet.cls).not.toContain("sd-act-no");
      expect(sheet.icon).toContain("fa-rotate-left");
      expect(sheet.h).toBeGreaterThanOrEqual(44);
      expect(sheet.chips).toContain("No-show");
      await page.evaluate(() => {
        const hit = Array.from(document.querySelectorAll("#rosterApptModal .roster-sheet-actions button")).find((el) => (el.textContent || "").includes("Undo no-show"));
        if (!(hit instanceof HTMLElement)) throw new Error("missing sheet undo");
        hit.click();
      });
      await page.waitForSelector("#rosterApptModal.hidden", { timeout: 5000 });
      await page.waitForFunction(() => (document.getElementById("toastContainer")?.textContent || "").includes("No-show cleared"), { timeout: 5000 });
      expect(await visitOf("HB-1005")).toMatchObject({ status: "accepted", noShow: false, paymentStatus: "PENDING VENMO" });
      const rowAfter = await page.evaluate(() => (document.querySelector('[data-booking-id="HB-1005"] .roster-cell-pay')?.textContent || "").replace(/\s+/g, " ").trim());
      expect(rowAfter).toContain("Accepted");
      expect(rowAfter).not.toContain("No-show");
      const relabeled = await page.evaluate(() => Array.from(document.querySelectorAll('[data-booking-id="HB-1005"] .roster-actions button')).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()));
      expect(relabeled).toContain("Mark no-show");
      expect(relabeled.some((label) => label.includes("Undo no-show"))).toBe(false);
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("report"));
      await page.waitForFunction((previous) => {
        const cards = Array.from(document.querySelectorAll("#tenantReportBody .sd-report-card"));
        const card = cards.find((el) => (el.querySelector(".sd-report-kicker")?.textContent || "").includes("No-shows"));
        return (card?.querySelector(".sd-report-value")?.textContent || "").trim() === String(previous - 1);
      }, { timeout: 5000 }, beforeNoShow);
      const afterReport = await reportOf();
      const afterDone = Number((afterReport.completion.aria.match(/(\d+) done/) || [])[1]);
      expect(afterDone).toBe(beforeDone + 1);
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("clients"));
      await page.waitForFunction(() => !!document.querySelector('.sd-client-name[data-client-id="CL-MAYA"]'), { timeout: 10000 });
      const mayaBefore = await page.evaluate(() => {
        const name = document.querySelector('.sd-client-name[data-client-id="CL-MAYA"]');
        return (name?.closest(".sd-client")?.querySelector(".sd-client-visits strong")?.textContent || "").trim();
      });
      await page.evaluate(() => (window as unknown as { openClientDetail: (id: string) => void }).openClientDetail("CL-MAYA"));
      await page.waitForSelector("#sdClientPanel:not([hidden]) .sd-client-noshow", { timeout: 10000 });
      const panelBefore = await page.evaluate(() => (document.querySelector("#sdClientPanel .sd-client-noshow")?.textContent || "").replace(/\s+/g, " ").trim());
      expect(panelBefore).toMatch(/No-shows: [1-9]/);
      await page.evaluate(() => (window as unknown as { undoAppointmentNoShow: (id: string) => void }).undoAppointmentNoShow("HB-1014"));
      await page.waitForFunction((previous) => {
        const text = (document.querySelector("#sdClientPanel .sd-client-noshow")?.textContent || "").replace(/\s+/g, " ").trim();
        return text.length > 0 && text !== previous;
      }, { timeout: 5000 }, panelBefore);
      const panelAfter = await page.evaluate(() => (document.querySelector("#sdClientPanel .sd-client-noshow")?.textContent || "").replace(/\s+/g, " ").trim());
      expect(Number(panelAfter.replace(/[^0-9]/g, ""))).toBe(Number(panelBefore.replace(/[^0-9]/g, "")) - 1);
      expect(await visitOf("HB-1014")).toMatchObject({ status: "accepted", noShow: false, paymentStatus: "PAID IN CASH" });
      const mayaAfter = await page.evaluate(() => {
        const name = document.querySelector('.sd-client-name[data-client-id="CL-MAYA"]');
        return (name?.closest(".sd-client")?.querySelector(".sd-client-visits strong")?.textContent || "").trim();
      });
      expect(Number(mayaAfter)).toBe(Number(mayaBefore) + 1);
      expect(writes).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("opens the round-close reschedule sheet from today, the roster row, and the details card", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      page.on("dialog", (dialog) => {
        void dialog.dismiss();
      });
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      const assertSheet = async (theme: "dark" | "light", entry: string) => {
        await page.waitForSelector("#tenantRescheduleModal:not(.hidden) .sd-form-head .sd-form-close", { timeout: 5000 });
        const box = await page.evaluate(() => {
          const close = document.querySelector("#tenantRescheduleModal .sd-form-close") as HTMLElement;
          const input = document.querySelector("#rescheduleTimeInputExtras .sd-pay-switch") as HTMLInputElement;
          const closeBox = close.getBoundingClientRect();
          const inputBox = input.getBoundingClientRect();
          const menus = document.querySelectorAll("details.sd-more[open]").length;
          return {
            closeW: closeBox.width,
            closeH: closeBox.height,
            radius: parseFloat(getComputedStyle(close).borderTopLeftRadius),
            bg: getComputedStyle(close).backgroundColor,
            inHead: !!close.closest(".sd-form-head"),
            role: input.getAttribute("role"),
            sw: inputBox.width,
            sh: inputBox.height,
            aria: input.getAttribute("aria-checked"),
            menus,
          };
        });
        expect(box.inHead, entry).toBe(true);
        expect(box.closeW, entry).toBeGreaterThanOrEqual(47.5);
        expect(box.closeW, entry).toBeLessThanOrEqual(48.5);
        expect(box.closeH, entry).toBeGreaterThanOrEqual(47.5);
        expect(box.closeH, entry).toBeLessThanOrEqual(48.5);
        expect(box.radius, entry).toBeGreaterThanOrEqual(24);
        expect(box.bg, entry).toBe(theme === "dark" ? "rgb(30, 41, 59)" : "rgb(241, 245, 249)");
        expect(box.role, entry).toBe("switch");
        expect(box.sw, entry).toBeGreaterThanOrEqual(51.5);
        expect(box.sw, entry).toBeLessThanOrEqual(52.5);
        expect(box.sh, entry).toBeGreaterThanOrEqual(29.5);
        expect(box.sh, entry).toBeLessThanOrEqual(30.5);
        expect(box.aria, entry).toBe("false");
        expect(box.menus, entry).toBe(0);
        await page.evaluate(() => (window as unknown as { closeTenantRescheduleModal: () => void }).closeTenantRescheduleModal());
        await page.waitForSelector("#tenantRescheduleModal.hidden", { timeout: 5000 });
      };
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((mode) => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode), theme);
        await page.evaluate(() => {
          const tenant = (window as unknown as { getTenant: () => { appointments: { id?: string; date?: string }[] } }).getTenant();
          const today = tenant.appointments.find((app) => app.id === "HB-1001")?.date || "";
          const row = tenant.appointments.find((app) => app.id === "HB-1004");
          if (row && today) row.date = today;
          (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("today");
        });
        const id = "HB-1004";
        await page.waitForSelector(`#schediTodaySchedule button[onclick*="${id}"]`, { timeout: 10000 });
        await page.evaluate((appointmentId) => {
          const button = document.querySelector(`#schediTodaySchedule button[onclick*="${appointmentId}"]`);
          const summary = button?.closest("article.sd-row")?.querySelector("summary");
          if (!(summary instanceof HTMLElement)) throw new Error("missing today menu");
          summary.click();
        }, id);
        await page.waitForFunction((appointmentId) => {
          const button = document.querySelector(`#schediTodaySchedule button[onclick*="${appointmentId}"]`);
          const details = button?.closest("details");
          const menu = button?.closest(".sd-more-menu") as HTMLElement | null;
          return !!details?.open && !!menu && getComputedStyle(menu).visibility === "visible";
        }, { timeout: 5000 }, id);
        const tapped = await page.evaluate((appointmentId) => {
          const buttons = Array.from(document.querySelectorAll(`#schediTodaySchedule button[onclick*="${appointmentId}"]`));
          const hit = buttons.find((el) => (el.textContent || "").trim() === "Reschedule");
          if (!(hit instanceof HTMLElement)) return false;
          hit.click();
          return true;
        }, id);
        expect(tapped, `today ${theme}`).toBe(true);
        await assertSheet(theme, `today ${theme}`);
        await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("appointments"));
        await page.waitForSelector(`#tenantRosterTableBody button[onclick*="${id}"]`, { timeout: 10000 });
        const rowTapped = await page.evaluate((appointmentId) => {
          const buttons = Array.from(document.querySelectorAll(`#tenantRosterTableBody button[onclick*="${appointmentId}"]`));
          const hit = buttons.find((el) => (el.textContent || "").includes("Reschedule"));
          if (!(hit instanceof HTMLElement)) return false;
          hit.click();
          return true;
        }, id);
        expect(rowTapped, `row ${theme}`).toBe(true);
        await assertSheet(theme, `row ${theme}`);
        await page.evaluate((appointmentId) => {
          (window as unknown as { openRosterApptModal: (id: string) => void }).openRosterApptModal(appointmentId);
        }, id);
        await page.waitForSelector("#rosterApptModal:not(.hidden) .roster-sheet-actions button", { timeout: 5000 });
        const cardTapped = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("#rosterApptModal .roster-sheet-actions button"));
          const hit = buttons.find((el) => (el.textContent || "").includes("Reschedule"));
          if (!(hit instanceof HTMLElement)) return false;
          hit.click();
          return true;
        });
        expect(cardTapped, `card ${theme}`).toBe(true);
        await assertSheet(theme, `card ${theme}`);
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("reads status chips as booking, outcome, payment, then price at 340 and 390", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const orderOf = (text: string, words: string[]) => {
      const indexes = words.map((word) => text.indexOf(word));
      expect(indexes.every((index) => index >= 0)).toBe(true);
      for (let i = 1; i < indexes.length; i++) expect(indexes[i - 1]).toBeLessThan(indexes[i]);
    };
    try {
      const page = await browser.newPage();
      const writes: string[] = [];
      page.on("request", (req) => {
        if (req.method() !== "GET" && req.method() !== "HEAD") writes.push(req.url());
      });
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.waitForFunction(() => {
        const apps = (window as unknown as { getTenant?: () => { appointments?: { id?: string }[] } }).getTenant?.()?.appointments || [];
        return apps.some((row) => row && row.id === "HB-1005");
      }, { timeout: 20000 });
      for (const width of [340, 390]) {
        await page.setViewport({ width, height: 900 });
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => {
            const tenant = (window as unknown as { getTenant: () => { appointments: { id?: string; noShow?: boolean; date?: string }[] } }).getTenant();
            const row = tenant.appointments.find((app) => app && app.id === "HB-1026");
            if (row) row.noShow = true;
            const today = tenant.appointments.find((app) => app && app.id === "HB-1001")?.date || "";
            const request = tenant.appointments.find((app) => app && app.id === "HB-1002");
            if (request && today) request.date = today;
            (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode);
            (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("appointments");
          }, theme);
          await page.waitForSelector('[data-booking-id="HB-1005"] .roster-cell-pay', { timeout: 10000 });
          const list = await page.evaluate(() => {
            const text = (selector: string) => (document.querySelector(selector)?.textContent || "").replace(/\s+/g, " ").trim();
            const row = (id: string) => [text(`[data-booking-id="${id}"] .roster-cell-pay`), text(`[data-booking-id="${id}"] .roster-cell-price`)].filter(Boolean).join(" ");
            return {
              avery: row("HB-1005"),
              elena: row("HB-1026"),
              denied: text('[data-booking-id="HB-1021"] .roster-cell-pay'),
            };
          });
          orderOf(list.avery, ["Accepted", "No-show", "Unpaid", "$55"]);
          orderOf(list.elena, ["Accepted", "No-show", "Unpaid", "$120"]);
          expect(list.denied).toContain("Denied");
          expect(list.denied).not.toContain("Unpaid");
          expect(list.denied.indexOf("No-show")).toBe(-1);
          await page.evaluate(() => (window as unknown as { openRosterApptModal: (id: string) => void }).openRosterApptModal("HB-1026"));
          await page.waitForSelector("#rosterApptModal:not(.hidden)", { timeout: 10000 });
          const sheet = await page.evaluate(() => (document.getElementById("rosterApptBody")?.textContent || "").replace(/\s+/g, " ").trim());
          orderOf(sheet, ["Accepted", "No-show", "Unpaid", "$120"]);
          await page.evaluate(() => (window as unknown as { closeRosterApptModal: () => void }).closeRosterApptModal());
          await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("today"));
          await page.waitForSelector("#schediTodaySchedule .sd-row", { timeout: 10000 });
          const today = await page.evaluate(() => {
            const text = (id: string) => {
              const button = document.querySelector(`#schediTodaySchedule button[onclick*="${id}"]`);
              return (button?.closest("article")?.textContent || "").replace(/\s+/g, " ").trim();
            };
            return { request: text("HB-1002"), accepted: text("HB-1003") };
          });
          orderOf(today.request, ["New request", "Unpaid"]);
          expect(today.request.indexOf("No-show")).toBe(-1);
          orderOf(today.accepted, ["Accepted", "Unpaid"]);
          await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("clients"));
          await page.waitForFunction(() => {
            const view = window as unknown as { openClientDetail?: (id: string) => void };
            if (!document.querySelector('.sd-client-name[data-client-id="CL-ELENA"]')) return false;
            if (document.querySelector("#sdClientPanel:not([hidden]) .sd-client-visit")) return true;
            view.openClientDetail?.("CL-ELENA");
            return !!document.querySelector("#sdClientPanel:not([hidden]) .sd-client-visit");
          }, { timeout: 10000 });
          const visit = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll("#sdClientPanel .sd-client-visit"));
            const hit = rows.find((row) => (row.textContent || "").includes("No-show"));
            return (hit?.textContent || "").replace(/\s+/g, " ").trim();
          });
          orderOf(visit, ["Accepted", "No-show", "Unpaid", "$120.00"]);
        }
      }
      expect(writes).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("keeps today names and status chips readable at 340 and 390 in light and dark", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    const measure = (selector: string) => page.evaluate((rootSelector) => {
      function parse(color: string): [number, number, number, number] {
        const match = String(color).match(/rgba?\(([^)]+)\)/);
        if (!match) return [255, 255, 255, 1];
        const parts = match[1].split(",").map((part) => Number(part.trim()));
        return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
      }
      function over(top: [number, number, number, number], bottom: [number, number, number, number]): [number, number, number, number] {
        const alpha = top[3] + bottom[3] * (1 - top[3]);
        if (alpha <= 0) return [0, 0, 0, 0];
        return [
          (top[0] * top[3] + bottom[0] * bottom[3] * (1 - top[3])) / alpha,
          (top[1] * top[3] + bottom[1] * bottom[3] * (1 - top[3])) / alpha,
          (top[2] * top[3] + bottom[2] * bottom[3] * (1 - top[3])) / alpha,
          alpha,
        ];
      }
      function rel(rgb: [number, number, number, number]) {
        const lin = [rgb[0], rgb[1], rgb[2]].map((value) => {
          const s = value / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
      }
      function contrast(fg: [number, number, number, number], bg: [number, number, number, number]) {
        const hi = Math.max(rel(fg), rel(bg));
        const lo = Math.min(rel(fg), rel(bg));
        return (hi + 0.05) / (lo + 0.05);
      }
      function backdrop(el: Element): [number, number, number, number] {
        const chain: Element[] = [];
        let node = el.parentElement;
        while (node) {
          chain.push(node);
          node = node.parentElement;
        }
        let bg: [number, number, number, number] = [255, 255, 255, 0];
        chain.reverse().forEach((layer) => {
          bg = over(parse(getComputedStyle(layer).backgroundColor), bg);
        });
        if (bg[3] < 1) bg = over(bg, [255, 255, 255, 1]);
        return bg;
      }
      const root = document.querySelector(rootSelector);
      const chips = root ? Array.from(root.querySelectorAll(".sd-pill, .text-sky-300, .text-rose-300, .text-amber-300")) : [];
      return chips.map((el) => {
        const style = getComputedStyle(el);
        const fg = parse(style.color);
        const bg = over(parse(style.backgroundColor), backdrop(el));
        return {
          text: (el.textContent || "").replace(/\s+/g, " ").trim(),
          color: style.color,
          contrast: contrast(fg[3] < 1 ? over(fg, bg) : fg, bg),
        };
      }).filter((chip) => chip.text);
    }, selector);
    try {
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      for (const width of [340, 390]) {
        await page.setViewport({ width, height: 900 });
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => {
            (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode);
            (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("today");
          }, theme);
          await page.waitForFunction(() => {
            const titles = Array.from(document.querySelectorAll("#schediTodaySchedule .sd-row-title")).map((el) => (el.textContent || "").trim());
            return titles.includes("Jordan Lee · Walk-in") && titles.includes("Maya Chen") && !titles.includes("Luis Ortega");
          }, { timeout: 10000 });
          const rows = await page.evaluate(() => Array.from(document.querySelectorAll("#schediTodaySchedule .sd-row")).map((row) => {
            const title = row.querySelector(".sd-row-title") as HTMLElement | null;
            const chips = row.querySelector(".sd-row-chips") as HTMLElement | null;
            const main = row.querySelector(".sd-row-main") as HTMLElement | null;
            const titleBox = title?.getBoundingClientRect();
            const chipBox = chips?.getBoundingClientRect();
            const mainBox = main?.getBoundingClientRect();
            return {
              name: (title?.textContent || "").trim(),
              titleWidth: titleBox?.width || 0,
              mainWidth: mainBox?.width || 0,
              titleBottom: titleBox?.bottom || 0,
              chipTop: chipBox?.top || 0,
              clipped: !!title && title.scrollWidth > title.clientWidth + 1,
            };
          }));
          for (const name of ["Jordan Lee · Walk-in", "Maya Chen"]) {
            const row = rows.find((item) => item.name === name);
            expect(row, name).toBeTruthy();
            expect(row?.clipped).toBe(false);
            expect(row?.titleWidth || 0).toBeGreaterThan(180);
            expect((row?.mainWidth || 0) - (row?.titleWidth || 0)).toBeLessThan(4);
            expect(row?.chipTop || 0).toBeGreaterThanOrEqual((row?.titleBottom || 0) - 1);
          }
          const todayChips = await measure("#schediTodaySchedule");
          const accepted = todayChips.find((chip) => chip.text === "Accepted");
          expect(accepted).toBeTruthy();
          expect(accepted?.contrast).toBeGreaterThanOrEqual(4.5);
          if (theme === "light") expect(accepted?.color).toBe("rgb(3, 105, 161)");
          todayChips.forEach((chip) => expect(chip.contrast).toBeGreaterThanOrEqual(4.5));
          await page.evaluate(() => {
            (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("clients");
            const title = document.getElementById("sdClientPanelTitle");
            const panel = document.getElementById("sdClientPanel");
            const already = !!panel && !panel.hidden && (title?.textContent || "").trim() === "Jordan Lee";
            if (!already) (window as unknown as { openClientDetail?: (id: string) => void }).openClientDetail?.("CL-JORDAN");
          });
          await page.waitForFunction(() => {
            const panel = document.querySelector("#sdClientPanel:not([hidden])");
            return !!panel && (panel.textContent || "").includes("Accepted") && (panel.textContent || "").includes("Denied");
          }, { timeout: 10000 });
          const clientChips = await measure("#sdClientPanel");
          const clientAccepted = clientChips.find((chip) => chip.text === "Accepted");
          const denied = clientChips.find((chip) => chip.text === "Denied");
          expect(clientAccepted).toBeTruthy();
          expect(denied).toBeTruthy();
          if (theme === "light") {
            expect(clientAccepted?.color).toBe("rgb(3, 105, 161)");
            expect(denied?.color).toBe("rgb(190, 18, 60)");
          }
          clientChips.forEach((chip) => expect(chip.contrast).toBeGreaterThanOrEqual(4.5));
          await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("appointments"));
          await page.waitForFunction(() => (document.getElementById("tenantRosterTableBody")?.textContent || "").includes("Accepted"), { timeout: 10000 });
          const listChips = await measure("#tenantRosterTableBody");
          const listAccepted = listChips.find((chip) => chip.text === "Accepted");
          expect(listAccepted).toBeTruthy();
          if (theme === "light") expect(listAccepted?.color).toBe("rgb(3, 105, 161)");
          listChips.forEach((chip) => expect(chip.contrast, `${chip.text} ${chip.color}`).toBeGreaterThanOrEqual(4.5));
        }
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("slides the H2 tab bar at 340, 390, and 420 in light and dark", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    const readBar = () => page.evaluate(() => {
      const bar = document.getElementById("schediDashTabbar") as HTMLElement;
      const indicator = bar.querySelector(".sd-tab-indicator") as HTMLElement;
      const buttons = Array.from(bar.querySelectorAll(":scope > button")) as HTMLButtonElement[];
      const barStyle = getComputedStyle(bar);
      const indStyle = getComputedStyle(indicator);
      const pill = getComputedStyle(indicator, "::before");
      const line = getComputedStyle(indicator, "::after");
      const fab = bar.querySelector(".sd-fab") as HTMLButtonElement;
      const fabStyle = getComputedStyle(fab);
      const barBox = bar.getBoundingClientRect();
      const fabBox = fab.getBoundingClientRect();
      const widths = buttons.map((btn) => {
        const box = btn.getBoundingClientRect();
        return { width: box.width, center: box.left + box.width / 2 };
      });
      const active = buttons.find((btn) => btn.getAttribute("aria-current") === "page") || null;
      const activeBox = active ? active.getBoundingClientRect() : null;
      const indBox = indicator.getBoundingClientRect();
      window.scrollTo(0, document.documentElement.scrollHeight);
      const panelBottom = document.getElementById("schediTodayPanel")?.getBoundingClientRect().bottom ?? 0;
      const barTop = bar.getBoundingClientRect().top;
      return {
        bg: barStyle.backgroundColor,
        radius: barStyle.borderTopLeftRadius,
        borderTop: barStyle.borderTopWidth,
        borderLeft: barStyle.borderLeftWidth,
        borderColor: barStyle.borderTopColor,
        left: barBox.left,
        right: barBox.right,
        bottom: barBox.bottom,
        width: document.documentElement.clientWidth,
        height: window.innerHeight,
        padBottom: getComputedStyle(document.getElementById("tenantPortalSection") as Element).paddingBottom,
        barHeight: barBox.height,
        panelBottom,
        barTop,
        labels: buttons.map((btn) => (btn.querySelector("span")?.textContent || "").trim()),
        widths,
        icon: getComputedStyle(buttons[0].querySelector("i") as Element).fontSize,
        labelSize: getComputedStyle(buttons[0].querySelector("span") as Element).fontSize,
        labelWeight: getComputedStyle(buttons[0].querySelector("span") as Element).fontWeight,
        labelFont: getComputedStyle(buttons[0].querySelector("span") as Element).fontFamily,
        inactive: getComputedStyle(buttons[1]).color,
        activeColor: active ? getComputedStyle(active).color : "",
        activeLabel: active ? (active.querySelector("span")?.textContent || "").trim() : "",
        pill: pill.backgroundColor,
        pillRadius: pill.borderTopLeftRadius,
        lineW: line.width,
        lineH: line.height,
        lineShadow: line.boxShadow,
        lineBg: line.backgroundColor,
        transform: indStyle.transform,
        duration: indStyle.transitionDuration,
        timing: indStyle.transitionTimingFunction,
        colorDuration: getComputedStyle(buttons[0]).transitionDuration,
        fabW: fabBox.width,
        fabH: fabBox.height,
        fabTop: fabBox.top,
        fabCenter: fabBox.top + fabBox.height / 2,
        iconCenter: (() => {
          const icon = (buttons[0].querySelector("i") as Element).getBoundingClientRect();
          return icon.top + icon.height / 2;
        })(),
        barOuterTop: barBox.top,
        fabBg: fabStyle.backgroundColor,
        fabFg: fabStyle.color,
        fabBorder: fabStyle.borderTopWidth,
        fabShadow: fabStyle.boxShadow,
        fabCurrent: fab.getAttribute("aria-current"),
        fabOn: fab.classList.contains("is-on"),
        fabLabel: (fab.textContent || "").replace(/\s+/g, ""),
        slot: bar.style.getPropertyValue("--sd-tab-slot"),
        indLeft: indBox.left,
        activeLeft: activeBox ? activeBox.left : -1,
        activeWidth: activeBox ? activeBox.width : -1,
        indWidth: indBox.width,
        stacked: getComputedStyle(buttons[0]).flexDirection,
        iconTop: (buttons[0].querySelector("i") as Element).getBoundingClientRect().top,
        labelTop: (buttons[0].querySelector("span") as Element).getBoundingClientRect().top,
      };
    });
    try {
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.waitForSelector("#schediDashTabbar .sd-tab-indicator", { timeout: 10000 });
      for (const width of [340, 390, 420]) {
        await page.setViewport({ width, height: 900 });
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => {
            (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode);
            (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("today");
          }, theme);
          const inactive = theme === "dark" ? "rgb(163, 177, 198)" : "rgb(63, 75, 94)";
          const active = theme === "dark" ? "rgb(52, 211, 153)" : "rgb(4, 120, 87)";
          await page.waitForFunction((idle, on) => {
            const bar = document.getElementById("schediDashTabbar");
            const calendar = bar?.querySelector('[data-dash-go="appointments"]');
            const today = bar?.querySelector('[data-dash-go="today"]');
            return bar?.style.getPropertyValue("--sd-tab-slot") === "0"
              && !!calendar && getComputedStyle(calendar).color === idle
              && !!today && getComputedStyle(today).color === on;
          }, { timeout: 5000 }, inactive, active);
          const metrics = await readBar();
          expect(metrics.left).toBe(0);
          expect(metrics.right).toBeCloseTo(metrics.width, 0);
          expect(metrics.bottom).toBeCloseTo(900, 0);
          expect(metrics.radius).toBe("0px");
          expect(metrics.borderTop).toBe("1px");
          expect(metrics.borderLeft).toBe("0px");
          expect(metrics.bg).toBe(theme === "dark" ? "rgb(11, 18, 32)" : "rgb(255, 255, 255)");
          expect(metrics.borderColor).toBe(theme === "dark" ? "rgba(148, 163, 184, 0.32)" : "rgb(226, 232, 240)");
          expect(metrics.labels).toEqual(["Agenda", "Clients", "", "Calendar", "More"]);
          const slot = metrics.right / 5;
          metrics.widths.forEach((box, index) => {
            expect(Math.abs(box.center - (slot * index + slot / 2))).toBeLessThan(2);
          });
          expect(Math.abs(metrics.widths[0].width - metrics.widths[1].width)).toBeLessThan(1.5);
          expect(Math.abs(metrics.widths[3].width - metrics.widths[4].width)).toBeLessThan(1.5);
          expect(metrics.stacked).toBe("column");
          expect(metrics.iconTop).toBeLessThan(metrics.labelTop);
          expect(metrics.icon).toBe("22px");
          expect(metrics.labelSize).toBe("12px");
          expect(metrics.labelWeight).toBe("700");
          expect(metrics.labelFont.toLowerCase()).toContain("inter");
          expect(metrics.inactive).toBe(theme === "dark" ? "rgb(163, 177, 198)" : "rgb(63, 75, 94)");
          expect(metrics.activeLabel).toBe("Agenda");
          expect(metrics.activeColor).toBe(theme === "dark" ? "rgb(52, 211, 153)" : "rgb(4, 120, 87)");
          expect(metrics.pill).toBe("rgba(16, 185, 129, 0.15)");
          expect(metrics.pillRadius).toBe("14px");
          expect(metrics.lineW).toBe("28px");
          expect(metrics.lineH).toBe("3px");
          expect(metrics.lineShadow).not.toBe("none");
          expect(metrics.duration).toBe("0.2s");
          expect(metrics.timing).toBe("ease-out");
          expect(metrics.colorDuration).toBe("0.2s");
          expect(metrics.fabW).toBeCloseTo(52, 0);
          expect(metrics.fabH).toBeCloseTo(52, 0);
          expect(metrics.barOuterTop - metrics.fabTop).toBeLessThanOrEqual(4);
          expect(Math.abs(metrics.fabCenter - metrics.iconCenter)).toBeLessThan(6);
          expect(metrics.fabBg).toBe("rgb(16, 185, 129)");
          expect(metrics.fabFg).toBe("rgb(255, 255, 255)");
          expect(metrics.fabBorder).toBe("0px");
          expect(metrics.fabShadow).not.toBe("none");
          expect(metrics.fabCurrent).toBeNull();
          expect(metrics.fabOn).toBe(false);
          expect(metrics.fabLabel).toBe("");
          expect(metrics.slot).toBe("0");
          expect(Math.abs(metrics.indLeft - metrics.activeLeft)).toBeLessThan(1.5);
          expect(Math.abs(metrics.indWidth - metrics.activeWidth)).toBeLessThan(1.5);
          expect(parseFloat(metrics.padBottom)).toBeGreaterThan(metrics.barHeight);
          expect(metrics.panelBottom).toBeLessThanOrEqual(metrics.barTop + 1);
        }
      }
      await page.setViewport({ width: 390, height: 900 });
      await page.evaluate(() => {
        (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme("dark");
        (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("today");
      });
      const motion = await page.evaluate(() => new Promise<{ start: number; end: number; mids: number[]; colors: string[] }>((resolve) => {
        const bar = document.getElementById("schediDashTabbar") as HTMLElement;
        const indicator = bar.querySelector(".sd-tab-indicator") as HTMLElement;
        const today = bar.querySelector('[data-dash-go="today"]') as HTMLElement;
        const clients = bar.querySelector('[data-dash-go="clients"]') as HTMLElement;
        const samples: { left: number; color: string }[] = [];
        const start = indicator.getBoundingClientRect().left;
        const begun = performance.now();
        clients.click();
        const step = () => {
          samples.push({ left: indicator.getBoundingClientRect().left, color: getComputedStyle(today).color });
          if (performance.now() - begun < 360) requestAnimationFrame(step);
          else {
            const end = indicator.getBoundingClientRect().left;
            const mids = samples.map((row) => row.left).filter((left) => left > start + 4 && left < end - 4);
            const colors = samples.map((row) => row.color);
            resolve({ start, end, mids, colors });
          }
        };
        requestAnimationFrame(step);
      }));
      expect(motion.end).toBeGreaterThan(motion.start + 40);
      expect(motion.mids.length).toBeGreaterThan(0);
      const startColor = "rgb(52, 211, 153)";
      const endColor = "rgb(163, 177, 198)";
      expect(motion.colors.some((color) => color !== startColor && color !== endColor)).toBe(true);
      await page.waitForFunction(() => document.getElementById("schediDashTabbar")?.style.getPropertyValue("--sd-tab-slot") === "1", { timeout: 2000 });
      const settled = await page.evaluate(() => {
        const bar = document.getElementById("schediDashTabbar") as HTMLElement;
        const clients = bar.querySelector('[data-dash-go="clients"]') as HTMLElement;
        const fab = bar.querySelector(".sd-fab") as HTMLElement;
        return {
          slot: bar.style.getPropertyValue("--sd-tab-slot"),
          current: clients.getAttribute("aria-current"),
          today: bar.querySelector('[data-dash-go="today"]')?.getAttribute("aria-current") || "",
          fab: fab.getAttribute("aria-current") || "",
          fabOn: fab.classList.contains("is-on"),
        };
      });
      expect(settled).toEqual({ slot: "1", current: "page", today: "", fab: "", fabOn: false });
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await page.waitForFunction(() => getComputedStyle(document.querySelector("#schediDashTabbar .sd-tab-indicator") as Element).transitionDuration === "0s", { timeout: 2000 });
      const reduced = await page.evaluate(() => new Promise<{ jumped: boolean; duration: string }>((resolve) => {
        const bar = document.getElementById("schediDashTabbar") as HTMLElement;
        const indicator = bar.querySelector(".sd-tab-indicator") as HTMLElement;
        const today = bar.querySelector('[data-dash-go="today"]') as HTMLElement;
        const before = indicator.getBoundingClientRect().left;
        const target = today.getBoundingClientRect().left;
        today.click();
        requestAnimationFrame(() => {
          const now = indicator.getBoundingClientRect().left;
          resolve({
            jumped: Math.abs(now - target) < 1.5 && Math.abs(before - target) > 40,
            duration: getComputedStyle(indicator).transitionDuration,
          });
        });
      }));
      expect(reduced.duration).toBe("0s");
      expect(reduced.jumped).toBe(true);
      const more = await page.evaluate(() => {
        (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("hours");
        const bar = document.getElementById("schediDashTabbar") as HTMLElement;
        const moreBtn = document.getElementById("schediDashMoreBtn");
        return {
          slot: bar.style.getPropertyValue("--sd-tab-slot"),
          current: moreBtn?.getAttribute("aria-current") || "",
          on: moreBtn?.classList.contains("is-on") === true,
        };
      });
      expect(more).toEqual({ slot: "4", current: "page", on: true });
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("keeps Agenda, Clients, Add, Calendar, and More visible at 390 on every tab", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    const readBar = () => page.evaluate(() => {
      const bar = document.getElementById("schediDashTabbar") as HTMLElement;
      const view = window.visualViewport;
      const buttons = Array.from(bar.querySelectorAll(":scope > button")) as HTMLButtonElement[];
      const items = buttons.map((btn) => {
        const box = btn.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          label: btn.getAttribute("aria-label") || (btn.querySelector("span")?.textContent || "").trim(),
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          hit: !!(hit && (hit === btn || btn.contains(hit))),
        };
      });
      return {
        inner: window.innerWidth,
        visual: view?.width ?? window.innerWidth,
        visualHeight: view?.height ?? window.innerHeight,
        scroll: document.documentElement.scrollWidth,
        dash: document.getElementById("tenantPortalSection")?.getAttribute("data-dash") || "",
        view: (window as unknown as { rosterCalendarView?: string }).rosterCalendarView || "",
        items,
      };
    });
    const expectBar = async (where: string) => {
      const bar = await readBar();
      expect(bar.inner, where).toBe(390);
      expect(bar.visual, where).toBe(390);
      expect(bar.scroll, where).toBeLessThanOrEqual(390);
      expect(bar.items.map((item) => item.label), where).toEqual(["Agenda", "Clients", "Add appointment", "Calendar", "More"]);
      bar.items.forEach((item) => {
        expect(item.left, `${where} ${item.label}`).toBeGreaterThanOrEqual(-1);
        expect(item.right, `${where} ${item.label}`).toBeLessThanOrEqual(bar.visual + 1);
        expect(item.top, `${where} ${item.label}`).toBeGreaterThanOrEqual(-1);
        expect(item.bottom, `${where} ${item.label}`).toBeLessThanOrEqual(bar.visualHeight + 1);
        expect(item.hit, `${where} ${item.label}`).toBe(true);
      });
    };
    try {
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.getElementById("schediStatPeople")?.textContent === "2", { timeout: 20000 });
      await expectBar("today");
      await page.click('#schediDashTabbar [data-dash-go="clients"]');
      await page.waitForFunction(() => document.getElementById("tenantPortalSection")?.getAttribute("data-dash") === "clients");
      await expectBar("clients");
      await page.click('#schediDashTabbar [data-dash-go="appointments"]');
      await page.waitForFunction(() => document.getElementById("tenantPortalSection")?.getAttribute("data-dash") === "appointments");
      await expectBar("calendar list");
      await page.click("#rosterViewWeek");
      await page.waitForFunction(() => (window as unknown as { rosterCalendarView?: string }).rosterCalendarView === "week");
      await expectBar("calendar week");
      await page.click("#rosterViewMonth");
      await page.waitForFunction(() => (window as unknown as { rosterCalendarView?: string }).rosterCalendarView === "month");
      await expectBar("calendar month");
      for (const name of ["services", "hours", "payments", "emails", "profile", "reports", "account", "billing"]) {
        await page.click("#schediDashMoreBtn");
        await page.waitForSelector("#schediDashMoreSheet:not([hidden])");
        await page.click(`#schediDashMoreSheet [data-dash-go="${name}"]`);
        await page.waitForFunction((pageName) => {
          const section = document.getElementById("tenantPortalSection");
          const sheet = document.getElementById("schediDashMoreSheet");
          return section?.getAttribute("data-dash") === pageName && !!sheet?.hidden;
        }, {}, name);
        await expectBar(name);
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("highlights an add choice before opening the sheet at 340 and 390", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    const kinds = [
      { kind: "appointment", modal: "manualBookingModal", submit: "Log Appointment", walkIn: false },
      { kind: "walkin", modal: "manualBookingModal", submit: "Log Appointment", walkIn: true },
      { kind: "recurring", modal: "ownerRecurringModal", submit: "Save series", walkIn: false },
    ] as const;
    try {
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.waitForFunction(() => {
        const apps = (window as unknown as { getTenant?: () => { appointments?: { id?: string }[] } }).getTenant?.()?.appointments || [];
        return apps.some((row) => row && row.id === "HB-1005");
      }, { timeout: 20000 });
      for (const width of [340, 390]) {
        await page.setViewport({ width, height: 780 });
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => {
            (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode);
            (window as unknown as { closeManualBookingModal: () => void }).closeManualBookingModal();
            (window as unknown as { closeOwnerRecurringModal: () => void }).closeOwnerRecurringModal();
            const menu = document.getElementById("schediDashAddMenu");
            if (menu) menu.hidden = true;
          }, theme);
          await page.waitForFunction((mode) => document.documentElement.classList.contains("schedi-light") === (mode === "light"), { timeout: 2000 }, theme);
          for (const item of kinds) {
            const expectedBorder = theme === "dark" ? "rgb(52, 211, 153)" : "rgb(5, 150, 105)";
            const expectedBg = theme === "dark" ? "rgba(16, 185, 129, 0.2)" : "rgb(209, 250, 229)";
            const sample = await page.evaluate((kind, borderTarget, bgTarget) => new Promise<{
              picked: boolean;
              menuOpen: boolean;
              modalHidden: boolean;
              border: string;
              shadow: string;
              scale: number;
              bg: string;
              visible: boolean;
              started: number;
            }>((resolve) => {
              const menu = document.getElementById("schediDashAddMenu") as HTMLElement;
              menu.hidden = true;
              (document.querySelector("#schediDashTabbar .sd-fab") as HTMLButtonElement).click();
              const button = menu.querySelector(`[data-dash-add="${kind}"]`) as HTMLButtonElement;
              const started = performance.now();
              const parts = (value: string) => {
                const match = value.trim().match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i);
                if (!match) return null;
                return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] == null ? 1 : Number(match[4])];
              };
              const nearColor = (actual: string, expected: string) => {
                const got = parts(actual);
                const want = parts(expected);
                if (!got || !want) return false;
                return Math.abs(got[0] - want[0]) <= 1 && Math.abs(got[1] - want[1]) <= 1 && Math.abs(got[2] - want[2]) <= 1 && Math.abs(got[3] - want[3]) <= 0.02;
              };
              const read = () => {
                const style = getComputedStyle(button);
                const matrix = style.transform.match(/matrix\(([^)]+)\)/);
                const scale = matrix ? Number(matrix[1].split(",")[0]) : (style.transform === "none" ? 1 : 0);
                const modalId = kind === "recurring" ? "ownerRecurringModal" : "manualBookingModal";
                const shadow = style.boxShadow;
                const blurNear = (shadow.match(/([\d.]+)px/g) || []).some((part) => Math.abs(parseFloat(part) - 18) <= 1);
                return {
                  picked: button.classList.contains("is-picked"),
                  menuOpen: !menu.hidden,
                  modalHidden: document.getElementById(modalId)?.classList.contains("hidden") !== false,
                  border: style.borderTopColor,
                  shadow,
                  scale,
                  bg: style.backgroundColor,
                  visible: button.getBoundingClientRect().height > 0,
                  started,
                  ready: nearColor(style.borderTopColor, borderTarget) && nearColor(style.backgroundColor, bgTarget) && blurNear && scale > 0.95 && scale < 0.99,
                };
              };
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                button.removeEventListener("transitionend", onEnd);
                resolve(read());
              };
              const seen = { border: false, transform: false, shadow: false };
              const onEnd = (event: TransitionEvent) => {
                if (event.target !== button) return;
                const name = event.propertyName || "";
                if (name === "border-color" || /^border-(top|right|bottom|left)-color$/.test(name)) seen.border = true;
                if (name === "transform") seen.transform = true;
                if (name === "box-shadow") seen.shadow = true;
                if (seen.border && seen.transform && seen.shadow) finish();
              };
              button.addEventListener("transitionend", onEnd);
              button.click();
              const watch = () => {
                if (settled) return;
                const snap = read();
                if (snap.ready || !snap.modalHidden || performance.now() - started > 1000) finish();
                else requestAnimationFrame(watch);
              };
              requestAnimationFrame(watch);
            }), item.kind, expectedBorder, expectedBg);
            expect(sample.picked, item.kind).toBe(true);
            expect(sample.menuOpen, item.kind).toBe(true);
            expect(sample.modalHidden, item.kind).toBe(true);
            expect(sample.visible, item.kind).toBe(true);
            expectSettledColor(sample.border, expectedBorder, item.kind);
            expectSettledColor(sample.bg, expectedBg, item.kind);
            expect((sample.shadow.match(/([\d.]+)px/g) || []).some((part) => Math.abs(parseFloat(part) - 18) <= 1), item.kind).toBe(true);
            expect(sample.scale, item.kind).toBeGreaterThan(0.95);
            expect(sample.scale, item.kind).toBeLessThan(0.99);
            await page.waitForFunction((modalId) => !document.getElementById(modalId)?.classList.contains("hidden"), { timeout: 2000 }, item.modal);
            const opened = await page.evaluate((started) => performance.now() - started, sample.started);
            expect(opened, item.kind).toBeGreaterThanOrEqual(160);
            expect(opened, item.kind).toBeLessThan(700);
            await page.waitForFunction((modalId) => {
              const sheet = document.getElementById(modalId)?.querySelector(".sd-form-sheet");
              if (!sheet) return false;
              const transform = getComputedStyle(sheet).transform;
              if (transform === "none") return true;
              const matrix = transform.match(/matrix\(([^)]+)\)/);
              if (!matrix) return false;
              const parts = matrix[1].split(",").map((part) => Number(part.trim()));
              return Math.abs(parts[5] || 0) < 0.5;
            }, { timeout: 2000 }, item.modal);
            const chromeBox = await page.evaluate((spec) => {
              const modal = document.getElementById(spec.modal) as HTMLElement;
              const sheet = modal.querySelector(".sd-form-sheet") as HTMLElement;
              const close = sheet.querySelector(".sd-form-close") as HTMLButtonElement;
              const icon = close.querySelector("i") as HTMLElement;
              const bar = sheet.querySelector(".sd-form-bar") as HTMLElement;
              const buttons = Array.from(bar.querySelectorAll("button")) as HTMLButtonElement[];
              const scroller = sheet.querySelector(".sd-form-scroll") as HTMLElement;
              const spacer = document.createElement("div");
              spacer.setAttribute("data-test-spacer", "1");
              spacer.style.height = "900px";
              scroller.appendChild(spacer);
              scroller.scrollTop = scroller.scrollHeight;
              const sheetBox = sheet.getBoundingClientRect();
              const closeBox = close.getBoundingClientRect();
              const barBox = bar.getBoundingClientRect();
              const first = buttons[0].getBoundingClientRect();
              const second = buttons[1].getBoundingClientRect();
              const closeStyle = getComputedStyle(close);
              const barStyle = getComputedStyle(bar);
              const saveStyle = getComputedStyle(buttons[1]);
              const cancelStyle = getComputedStyle(buttons[0]);
              const iconStyle = getComputedStyle(icon);
              const scrolled = {
                closeTop: closeBox.top,
                closeBottom: closeBox.bottom,
                barTop: barBox.top,
                barBottom: barBox.bottom,
                scrollMoved: scroller.scrollTop > 40,
              };
              spacer.remove();
              scroller.scrollTop = 0;
              return {
                sheetLeft: sheetBox.left,
                sheetRight: sheetBox.right,
                sheetTop: sheetBox.top,
                sheetBottom: sheetBox.bottom,
                radiusTop: getComputedStyle(sheet).borderTopLeftRadius,
                radiusBottom: getComputedStyle(sheet).borderBottomLeftRadius,
                closeW: closeBox.width,
                closeH: closeBox.height,
                closeTop: closeBox.top,
                closeRight: closeBox.right,
                closeLeft: closeBox.left,
                closeLabel: close.getAttribute("aria-label"),
                closeBg: closeStyle.backgroundColor,
                closeBorder: closeStyle.borderTopColor,
                closeBorderW: closeStyle.borderTopWidth,
                closeRadius: closeStyle.borderRadius,
                icon: iconStyle.fontSize,
                labels: buttons.map((button) => (button.textContent || "").replace(/\s+/g, " ").trim()),
                gap: second.left - first.right,
                firstW: first.width,
                secondW: second.width,
                firstH: first.height,
                secondH: second.height,
                sameRow: Math.abs(first.top - second.top) < 2,
                font: saveStyle.fontSize,
                weight: saveStyle.fontWeight,
                saveBg: saveStyle.backgroundColor,
                saveFg: saveStyle.color,
                cancelBg: cancelStyle.backgroundColor,
                cancelFg: cancelStyle.color,
                cancelBorder: cancelStyle.borderTopColor,
                barPad: barStyle.paddingBottom,
                barGap: barStyle.gap,
                walkIn: (document.getElementById("manWalkInBtn") as HTMLButtonElement | null)?.getAttribute("aria-pressed") || "",
                deleteHidden: document.getElementById("manDeleteBtn")?.classList.contains("hidden") !== false,
                scrolled,
                innerH: window.innerHeight,
              };
            }, { modal: item.modal });
            expect(chromeBox.sheetLeft).toBeCloseTo(0, 0);
            expect(chromeBox.sheetRight).toBeCloseTo(width, 0);
            expect(chromeBox.sheetBottom).toBeCloseTo(780, 0);
            expect(parseFloat(chromeBox.radiusTop)).toBeGreaterThan(0);
            expect(chromeBox.radiusBottom).toBe("0px");
            expect(chromeBox.closeW).toBeGreaterThanOrEqual(44);
            expect(chromeBox.closeH).toBeGreaterThanOrEqual(44);
            expect(chromeBox.closeW).toBeLessThanOrEqual(48.5);
            expect(chromeBox.sheetRight - chromeBox.closeRight).toBeLessThan(20);
            expect(chromeBox.closeTop - chromeBox.sheetTop).toBeLessThan(24);
            expect(chromeBox.closeLeft).toBeGreaterThan(width / 2);
            expect(chromeBox.closeLabel).toBe("Close");
            expect(chromeBox.closeBg).toBe(theme === "dark" ? "rgb(30, 41, 59)" : "rgb(241, 245, 249)");
            expect(chromeBox.closeBorderW).toBe(theme === "dark" ? "0px" : "1px");
            if (theme === "light") expect(chromeBox.closeBorder).toBe("rgb(203, 213, 225)");
            expect(parseFloat(chromeBox.closeRadius)).toBeGreaterThanOrEqual(24);
            expect(chromeBox.icon).toBe("22px");
            expect(chromeBox.labels).toEqual(["Cancel", item.submit]);
            expect(chromeBox.gap).toBeGreaterThan(10);
            expect(chromeBox.gap).toBeLessThan(14);
            expect(Math.abs(chromeBox.firstW - chromeBox.secondW)).toBeLessThan(2);
            expect(chromeBox.firstH).toBeGreaterThanOrEqual(52);
            expect(chromeBox.secondH).toBeGreaterThanOrEqual(52);
            expect(chromeBox.sameRow).toBe(true);
            expect(chromeBox.font).toBe("17px");
            expect(Number(chromeBox.weight)).toBeGreaterThanOrEqual(700);
            expect(chromeBox.saveBg).toBe("rgb(16, 185, 129)");
            expect(chromeBox.saveFg).toBe("rgb(2, 44, 34)");
            expect(chromeBox.cancelBg).toBe(theme === "dark" ? "rgb(30, 41, 59)" : "rgb(255, 255, 255)");
            expect(chromeBox.cancelFg).toBe(theme === "dark" ? "rgb(226, 232, 240)" : "rgb(15, 23, 42)");
            expect(chromeBox.cancelBorder).toBe(theme === "dark" ? "rgb(51, 65, 85)" : "rgb(203, 213, 225)");
            expect(chromeBox.barGap).toBe("12px");
            expect(parseFloat(chromeBox.barPad)).toBeGreaterThanOrEqual(12);
            expect(chromeBox.scrolled.scrollMoved).toBe(true);
            expect(chromeBox.scrolled.closeTop).toBeGreaterThanOrEqual(0);
            expect(chromeBox.scrolled.closeBottom).toBeLessThanOrEqual(chromeBox.innerH);
            expect(chromeBox.scrolled.barBottom).toBeLessThanOrEqual(chromeBox.innerH + 1);
            expect(chromeBox.scrolled.barTop).toBeLessThan(chromeBox.innerH);
            expect(Math.abs(chromeBox.scrolled.closeTop - chromeBox.closeTop)).toBeLessThan(2);
            if (item.walkIn) expect(chromeBox.walkIn).toBe("true");
            if (!item.walkIn && item.modal === "manualBookingModal") expect(chromeBox.walkIn).toBe("false");
            expect(chromeBox.deleteHidden).toBe(true);
            await page.evaluate((modalId) => {
              if (modalId === "ownerRecurringModal") (window as unknown as { closeOwnerRecurringModal: () => void }).closeOwnerRecurringModal();
              else (window as unknown as { closeManualBookingModal: () => void }).closeManualBookingModal();
            }, item.modal);
          }
          const edited = await page.evaluate(() => {
            (window as unknown as { openEditAppointment: (id: string) => void }).openEditAppointment("HB-1005");
            const bar = document.querySelector("#manualBookingModal .sd-form-bar");
            const labels = Array.from(bar?.querySelectorAll("button") || []).map((button) => (button.textContent || "").replace(/\s+/g, " ").trim());
            const del = document.getElementById("manDeleteBtn");
            return {
              open: !document.getElementById("manualBookingModal")?.classList.contains("hidden"),
              title: document.getElementById("manModalTitle")?.textContent || "",
              labels,
              deleteShown: !!del && !del.classList.contains("hidden"),
            };
          });
          expect(edited.open).toBe(true);
          expect(edited.title).toBe("Edit appointment");
          expect(edited.labels).toEqual(["Cancel", "Save appointment"]);
          expect(edited.deleteShown).toBe(true);
          await page.evaluate(() => (window as unknown as { closeManualBookingModal: () => void }).closeManualBookingModal());
        }
      }
      const immediate = await page.evaluate(() => {
        const started = performance.now();
        (window as unknown as { schediDashAddKind: (kind: string) => void }).schediDashAddKind("recurring");
        const modal = document.getElementById("ownerRecurringModal");
        return {
          elapsed: performance.now() - started,
          open: !!modal && !modal.classList.contains("hidden"),
        };
      });
      expect(immediate.open).toBe(true);
      expect(immediate.elapsed).toBeLessThan(50);
      await page.evaluate(() => (window as unknown as { closeOwnerRecurringModal: () => void }).closeOwnerRecurringModal());
      const cancelled = await page.evaluate(() => new Promise<{ hidden: boolean; picked: boolean }>((resolve) => {
        const menu = document.getElementById("schediDashAddMenu") as HTMLElement;
        menu.hidden = true;
        (document.querySelector("#schediDashTabbar .sd-fab") as HTMLButtonElement).click();
        (menu.querySelector('[data-dash-add="appointment"]') as HTMLButtonElement).click();
        document.body.click();
        window.setTimeout(() => {
          resolve({
            hidden: document.getElementById("manualBookingModal")?.classList.contains("hidden") !== false,
            picked: !!document.querySelector("#schediDashAddMenu button.is-picked"),
          });
        }, 360);
      }));
      expect(cancelled.hidden).toBe(true);
      expect(cancelled.picked).toBe(false);
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      const reduced = await page.evaluate(() => new Promise<{
        immediate: { picked: boolean; hidden: boolean; transform: string; duration: string };
        mid: { picked: boolean; hidden: boolean; transform: string };
        after: { hidden: boolean; elapsed: number };
      }>((resolve) => {
        const menu = document.getElementById("schediDashAddMenu") as HTMLElement;
        menu.hidden = true;
        (document.querySelector("#schediDashTabbar .sd-fab") as HTMLButtonElement).click();
        const button = menu.querySelector('[data-dash-add="walkin"]') as HTMLButtonElement;
        const started = performance.now();
        button.click();
        const style = getComputedStyle(button);
        const immediate = {
          picked: button.classList.contains("is-picked"),
          hidden: document.getElementById("manualBookingModal")?.classList.contains("hidden") !== false,
          transform: style.transform,
          duration: style.transitionDuration,
        };
        requestAnimationFrame(() => {
          const midStyle = getComputedStyle(button);
          const mid = {
            picked: button.classList.contains("is-picked"),
            hidden: document.getElementById("manualBookingModal")?.classList.contains("hidden") !== false,
            transform: midStyle.transform,
          };
          requestAnimationFrame(() => {
            resolve({
              immediate,
              mid,
              after: {
                hidden: document.getElementById("manualBookingModal")?.classList.contains("hidden") !== false,
                elapsed: performance.now() - started,
              },
            });
          });
        });
      }));
      expect(reduced.immediate.picked).toBe(true);
      expect(reduced.immediate.hidden).toBe(true);
      expect(reduced.immediate.transform).toBe("none");
      expect(reduced.immediate.duration).toBe("0s");
      expect(reduced.mid.picked).toBe(true);
      expect(reduced.mid.hidden).toBe(true);
      expect(reduced.mid.transform).toBe("none");
      expect(reduced.after.hidden).toBe(false);
      expect(reduced.after.elapsed).toBeLessThan(160);
      const reducedWalk = await page.evaluate(() => (document.getElementById("manWalkInBtn") as HTMLButtonElement | null)?.getAttribute("aria-pressed") || "");
      expect(reducedWalk).toBe("true");
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("mutes add, edit, and recurring payment choices until one is selected", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const muted = {
      dark: { bg: "rgb(15, 23, 42)", fg: "rgb(248, 250, 252)", border: "rgb(51, 65, 85)" },
      light: { bg: "rgb(255, 255, 255)", fg: "rgb(15, 23, 42)", border: "rgb(203, 213, 225)" },
    };
    const brands: Record<string, { dark: string; light: string; fg: string; lightFg?: string }> = {
      cashapp: { dark: "rgb(0, 214, 79)", light: "rgb(0, 214, 79)", fg: "rgb(11, 18, 32)" },
      zelle: { dark: "rgb(109, 30, 212)", light: "rgb(109, 30, 212)", fg: "rgb(255, 255, 255)" },
      venmo: { dark: "rgb(0, 140, 255)", light: "rgb(0, 140, 255)", fg: "rgb(11, 18, 32)" },
      paypal: { dark: "rgb(0, 112, 224)", light: "rgb(0, 48, 135)", fg: "rgb(255, 255, 255)" },
      square: { dark: "rgb(255, 255, 255)", light: "rgb(0, 0, 0)", fg: "rgb(0, 0, 0)", lightFg: "rgb(255, 255, 255)" },
      card: { dark: "rgb(99, 91, 255)", light: "rgb(67, 56, 202)", fg: "rgb(255, 255, 255)" },
      cash: { dark: "rgb(5, 150, 105)", light: "rgb(4, 120, 87)", fg: "rgb(255, 255, 255)" },
      later: { dark: "rgb(5, 150, 105)", light: "rgb(4, 120, 87)", fg: "rgb(255, 255, 255)" },
    };
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.waitForFunction(() => {
        const apps = (window as unknown as { getTenant?: () => { appointments?: { id?: string }[] } }).getTenant?.()?.appointments || [];
        return apps.some((row) => row && row.id === "HB-1001");
      }, { timeout: 20000 });
      const read = (boxId: string) => page.evaluate((id) => {
        const group = document.getElementById(id);
        const buttons = Array.from(group?.querySelectorAll(".sd-pay-choice") || []) as HTMLButtonElement[];
        return {
          role: group?.getAttribute("role") || "",
          options: buttons.map((el) => {
            const style = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            return {
              status: el.getAttribute("data-pay-status") || "",
              radio: el.getAttribute("role"),
              checked: el.getAttribute("aria-checked"),
              bg: style.backgroundColor,
              fg: style.color,
              border: style.borderTopColor,
              shadow: style.boxShadow,
              h: Math.round(box.height),
              w: Math.round(box.width),
              check: !!el.querySelector(".sd-paid-check"),
            };
          }),
        };
      }, boxId);
      const methodOf = (status: string) => {
        if (status === "PAID VIA CARD") return "card";
        if (status === "PAID CASH APP") return "cashapp";
        if (status === "PAID ZELLE") return "zelle";
        if (status === "PAID VENMO") return "venmo";
        if (status === "PAID PAYPAL") return "paypal";
        if (status === "PAID SQUARE") return "square";
        if (status === "PAID IN CASH") return "cash";
        return "later";
      };
      const expectMutedPicker = async (boxId: string, theme: "dark" | "light", methods: string[], selected: string) => {
        const view = await read(boxId);
        expect(view.role).toBe("radiogroup");
        expect(view.options.map((row) => methodOf(row.status))).toEqual(methods);
        const on = view.options.filter((row) => row.checked === "true");
        expect(on.map((row) => methodOf(row.status))).toEqual([selected]);
        for (const row of view.options) {
          expect(row.radio).toBe("radio");
          expect(row.h).toBeGreaterThanOrEqual(44);
          expect(row.w).toBeGreaterThan(240);
          const method = methodOf(row.status);
          const brand = brands[method];
          if (row.checked === "true") {
            expect(row.bg).toBe(brand[theme]);
            expect(row.fg).toBe(theme === "light" && brand.lightFg ? brand.lightFg : brand.fg);
            expect(row.check).toBe(true);
            expect(row.shadow).not.toBe("none");
          } else {
            expect(row.bg).toBe(muted[theme].bg);
            expect(row.fg).toBe(muted[theme].fg);
            expect(row.border).toBe(muted[theme].border);
            expect(row.check).toBe(false);
          }
        }
      };
      for (const width of [340, 390]) {
        await page.setViewport({ width, height: 900 });
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode), theme);
          await page.evaluate(() => (window as unknown as { openManualBookingModal: () => void }).openManualBookingModal());
          await page.waitForSelector("#manPaymentChoices .sd-pay-choice.is-on", { timeout: 10000 });
          await expectMutedPicker("manPaymentChoices", theme, ["cashapp", "zelle", "venmo", "cash", "later"], "later");
          await page.evaluate(() => (window as unknown as { closeManualBookingModal: () => void }).closeManualBookingModal());
          await page.evaluate(() => (window as unknown as { schediDashAddKind: (kind: string) => void }).schediDashAddKind("walkin"));
          await page.waitForSelector("#manPaymentChoices .sd-pay-choice.is-on", { timeout: 10000 });
          const walk = await page.evaluate(() => (document.getElementById("manWalkInBtn") as HTMLButtonElement | null)?.getAttribute("aria-pressed") || "");
          expect(walk).toBe("true");
          await expectMutedPicker("manPaymentChoices", theme, ["cashapp", "zelle", "venmo", "cash", "later"], "later");
          await page.evaluate(() => (window as unknown as { closeManualBookingModal: () => void }).closeManualBookingModal());
          await page.evaluate(() => (window as unknown as { openEditAppointment: (id: string) => void }).openEditAppointment("HB-1001"));
          await page.waitForSelector('#manPaymentChoices [data-pay-status="PAID VIA CARD"].is-on', { timeout: 10000 });
          await expectMutedPicker("manPaymentChoices", theme, ["card", "cashapp", "zelle", "venmo", "cash", "later"], "card");
          await page.evaluate(() => (window as unknown as { closeManualBookingModal: () => void }).closeManualBookingModal());
          await page.evaluate(() => (window as unknown as { openEditAppointment: (id: string) => void }).openEditAppointment("HB-1012"));
          await page.waitForSelector('#manPaymentChoices [data-pay-status="PAID SQUARE"].is-on', { timeout: 10000 });
          await expectMutedPicker("manPaymentChoices", theme, ["cashapp", "zelle", "venmo", "square", "cash", "later"], "square");
          await page.evaluate(() => (window as unknown as { closeManualBookingModal: () => void }).closeManualBookingModal());
          await page.evaluate(() => (window as unknown as { openOwnerRecurringModal: () => void }).openOwnerRecurringModal());
          await page.waitForSelector("#ownerRecurPaymentChoices .sd-pay-choice.is-on", { timeout: 10000 });
          await expectMutedPicker("ownerRecurPaymentChoices", theme, ["cashapp", "zelle", "venmo", "cash", "later"], "later");
          await page.evaluate(() => (window as unknown as { closeOwnerRecurringModal: () => void }).closeOwnerRecurringModal());
        }
      }
      await page.setViewport({ width: 390, height: 900 });
      await page.evaluate(() => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme("dark"));
      await page.evaluate(() => (window as unknown as { openManualBookingModal: () => void }).openManualBookingModal());
      await page.waitForSelector("#manPaymentChoices .sd-pay-choice", { timeout: 10000 });
      await page.evaluate(() => {
        const venmo = document.querySelector('#manPaymentChoices [data-pay-status="PAID VENMO"]') as HTMLButtonElement | null;
        venmo?.click();
      });
      await expectMutedPicker("manPaymentChoices", "dark", ["cashapp", "zelle", "venmo", "cash", "later"], "venmo");
      const stored = await page.evaluate(() => (document.getElementById("manPaymentStatus") as HTMLInputElement).value);
      expect(stored).toBe("PAID VENMO");
      const checkedCount = await page.evaluate(() => document.querySelectorAll('#manPaymentChoices [aria-checked="true"]').length);
      expect(checkedCount).toBe(1);
      await page.evaluate(() => (window as unknown as { closeManualBookingModal: () => void }).closeManualBookingModal());
      await page.evaluate(() => (window as unknown as { openOwnerRecurringModal: () => void }).openOwnerRecurringModal());
      await page.waitForSelector("#ownerRecurPaymentChoices .sd-pay-choice", { timeout: 10000 });
      await page.evaluate(() => {
        const cash = document.querySelector('#ownerRecurPaymentChoices [data-pay-status="PAID IN CASH"]') as HTMLButtonElement | null;
        cash?.click();
      });
      await expectMutedPicker("ownerRecurPaymentChoices", "dark", ["cashapp", "zelle", "venmo", "cash", "later"], "cash");
      const seriesPay = await page.evaluate(() => (document.getElementById("ownerRecurPayment") as HTMLInputElement).value);
      expect(seriesPay).toBe("PAID IN CASH");
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("uses the round close chip on More and other sheets at 340 and 390", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    const readClose = (selector: string) => page.evaluate((sel) => {
      const close = document.querySelector(sel) as HTMLButtonElement | null;
      const icon = close?.querySelector("i") as HTMLElement | null;
      const card = close?.closest(".sd-sheet-card, .glass-card, .sd-client-panel-card, .sd-series-preview-card, .sd-form-sheet") as HTMLElement | null;
      if (!close || !icon || !card) return null;
      const closeBox = close.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      const style = getComputedStyle(close);
      const iconStyle = getComputedStyle(icon);
      return {
        w: closeBox.width,
        h: closeBox.height,
        label: close.getAttribute("aria-label"),
        bg: style.backgroundColor,
        borderW: style.borderTopWidth,
        border: style.borderTopColor,
        radius: parseFloat(style.borderTopLeftRadius),
        icon: iconStyle.fontSize,
        iconClass: icon.className,
        rightGap: cardBox.right - closeBox.right,
        topGap: closeBox.top - cardBox.top,
        onRight: closeBox.left > cardBox.left + cardBox.width / 2,
      };
    }, selector);
    const expectChip = (box: Awaited<ReturnType<typeof readClose>>, theme: "dark" | "light", label: string) => {
      expect(box, label).toBeTruthy();
      if (!box) return;
      expect(box.w, label).toBeGreaterThanOrEqual(47.5);
      expect(box.w, label).toBeLessThanOrEqual(48.5);
      expect(box.h, label).toBeGreaterThanOrEqual(47.5);
      expect(box.h, label).toBeLessThanOrEqual(48.5);
      expect(box.label, label).toBe("Close");
      expect(box.bg, label).toBe(theme === "dark" ? "rgb(30, 41, 59)" : "rgb(241, 245, 249)");
      expect(box.borderW, label).toBe(theme === "dark" ? "0px" : "1px");
      if (theme === "light") expect(box.border, label).toBe("rgb(203, 213, 225)");
      expect(box.radius, label).toBeGreaterThanOrEqual(24);
      expect(box.icon, label).toBe("22px");
      expect(box.iconClass, label).toContain("fa-xmark");
      expect(box.rightGap, label).toBeGreaterThanOrEqual(0);
      expect(box.rightGap, label).toBeLessThan(28);
      expect(box.topGap, label).toBeGreaterThanOrEqual(0);
      expect(box.topGap, label).toBeLessThan(28);
      expect(box.onRight, label).toBe(true);
    };
    try {
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.waitForFunction(() => {
        const apps = (window as unknown as { getTenant?: () => { appointments?: { id?: string }[] } }).getTenant?.()?.appointments || [];
        return apps.some((row) => row && row.id === "HB-1001");
      }, { timeout: 20000 });
      for (const width of [340, 390]) {
        await page.setViewport({ width, height: 780 });
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => {
            const win = window as unknown as {
              setSchediTheme: (mode: string) => void;
              schediDashGo: (page: string) => void;
              closeComparePlansModal: () => void;
              closeAddServiceModal: () => void;
              closeRosterApptModal: () => void;
              closeClientPanel: () => void;
              closeSeriesEmailPreview: () => void;
              closeAddBlockedTimeModal: () => void;
              closeTenantRescheduleModal: () => void;
              schediDashToggleMore: (force: boolean) => void;
              schediDashHelp: (force: boolean) => void;
            };
            win.setSchediTheme(mode);
            win.schediDashGo("today");
            win.closeComparePlansModal();
            win.closeAddServiceModal();
            win.closeRosterApptModal();
            win.closeClientPanel();
            win.closeSeriesEmailPreview();
            win.closeAddBlockedTimeModal();
            win.closeTenantRescheduleModal();
            win.schediDashToggleMore(false);
            win.schediDashHelp(false);
          }, theme);
          await page.waitForFunction((mode) => document.documentElement.classList.contains("schedi-light") === (mode === "light"), { timeout: 2000 }, theme);
          await page.evaluate(() => (window as unknown as { schediDashToggleMore: (force: boolean) => void }).schediDashToggleMore(true));
          await page.waitForSelector("#schediDashMoreSheet:not([hidden]) .sd-form-close", { timeout: 5000 });
          const pinned = await page.evaluate(() => {
            const sheet = document.getElementById("schediDashMoreSheet") as HTMLElement;
            const card = sheet.querySelector(".sd-sheet-card") as HTMLElement;
            const close = card.querySelector(".sd-form-close") as HTMLElement;
            card.style.maxHeight = "180px";
            card.scrollTop = 240;
            const closeBox = close.getBoundingClientRect();
            const cardBox = card.getBoundingClientRect();
            const scrolled = card.scrollTop > 40;
            card.style.maxHeight = "";
            card.scrollTop = 0;
            return { scrolled, topGap: closeBox.top - cardBox.top };
          });
          expect(pinned.scrolled, `${width} ${theme}`).toBe(true);
          expect(pinned.topGap, `${width} ${theme}`).toBeLessThan(28);
          expectChip(await readClose("#schediDashMoreSheet .sd-form-close"), theme, `more ${width} ${theme}`);
          await page.click("#schediDashMoreSheet .sd-form-close");
          await page.waitForSelector("#schediDashMoreSheet[hidden]", { timeout: 2000 });
          await page.evaluate(() => (window as unknown as { schediDashToggleMore: (force: boolean) => void }).schediDashToggleMore(true));
          await page.click('#schediDashMoreSheet [data-dash-go="services"]');
          await page.waitForSelector("#schediDashMoreSheet[hidden]", { timeout: 2000 });
          const servicesOn = await page.evaluate(() => !document.getElementById("tenantSectionServices")?.classList.contains("hidden"));
          expect(servicesOn, `${width} ${theme}`).toBe(true);
          await page.evaluate(() => (window as unknown as { schediDashHelp: (force: boolean) => void }).schediDashHelp(true));
          await page.waitForSelector("#schediDashHelp:not([hidden]) .sd-form-close", { timeout: 5000 });
          expectChip(await readClose("#schediDashHelp .sd-form-close"), theme, `help ${width} ${theme}`);
          await page.click("#schediDashHelp .sd-form-close");
          await page.evaluate(() => (window as unknown as { openComparePlansModal: () => void }).openComparePlansModal());
          await page.waitForSelector("#comparePlansModal:not(.hidden) .sd-form-close", { timeout: 5000 });
          expectChip(await readClose("#comparePlansModal .sd-form-close"), theme, `plans ${width} ${theme}`);
          const plansPin = await page.evaluate(() => {
            const modal = document.getElementById("comparePlansModal") as HTMLElement;
            const sheet = modal.querySelector(".sd-form-sheet") as HTMLElement;
            const body = document.getElementById("comparePlansModalBody") as HTMLElement;
            const close = modal.querySelector(".sd-form-close") as HTMLElement;
            const foot = modal.querySelector(".sd-plans-foot button") as HTMLElement;
            if (body.scrollHeight <= body.clientHeight + 40) sheet.style.maxHeight = "320px";
            const before = close.getBoundingClientRect().top;
            const footBefore = foot.getBoundingClientRect().top;
            body.scrollTop = 480;
            const closeBox = close.getBoundingClientRect();
            const footBox = foot.getBoundingClientRect();
            const hit = document.elementFromPoint(closeBox.left + closeBox.width / 2, closeBox.top + closeBox.height / 2);
            const inside = (box: DOMRect) => box.top >= -0.5 && box.left >= -0.5 && box.bottom <= window.innerHeight + 0.5 && box.right <= window.innerWidth + 0.5;
            const result = {
              scrolled: body.scrollTop > 40,
              overlayHidden: getComputedStyle(modal).overflowY === "hidden",
              stayed: Math.abs(closeBox.top - before) < 1,
              footStayed: Math.abs(footBox.top - footBefore) < 1,
              closeInView: inside(closeBox),
              footInView: inside(footBox),
              hitClose: !!hit && (hit === close || close.contains(hit)),
              wordClose: (foot.textContent || "").trim() === "Close",
            };
            sheet.style.maxHeight = "";
            body.scrollTop = 0;
            return result;
          });
          expect(plansPin.scrolled, `plans scroll ${width} ${theme}`).toBe(true);
          expect(plansPin.overlayHidden, `plans overflow ${width} ${theme}`).toBe(true);
          expect(plansPin.stayed, `plans close ${width} ${theme}`).toBe(true);
          expect(plansPin.footStayed, `plans foot ${width} ${theme}`).toBe(true);
          expect(plansPin.closeInView, `plans close view ${width} ${theme}`).toBe(true);
          expect(plansPin.footInView, `plans foot view ${width} ${theme}`).toBe(true);
          expect(plansPin.hitClose, `plans hit ${width} ${theme}`).toBe(true);
          expect(plansPin.wordClose, `plans word ${width} ${theme}`).toBe(true);
          await page.click("#comparePlansModal .sd-form-close");
          await page.evaluate(() => (window as unknown as { openAddServiceModal: () => void }).openAddServiceModal());
          await page.waitForSelector("#tenantServiceModal:not(.hidden) .sd-form-close", { timeout: 5000 });
          expectChip(await readClose("#tenantServiceModal .sd-form-close"), theme, `service ${width} ${theme}`);
          const servicePin = await page.evaluate(() => {
            const modal = document.getElementById("tenantServiceModal") as HTMLElement;
            const sheet = modal.querySelector(".sd-svc-sheet") as HTMLElement;
            const body = modal.querySelector(".sd-svc-body") as HTMLElement;
            const close = modal.querySelector(".sd-form-close") as HTMLElement;
            const title = document.getElementById("tenantServiceModalTitle") as HTMLElement;
            const before = close.getBoundingClientRect().top;
            body.scrollTop = 480;
            const closeBox = close.getBoundingClientRect();
            const titleBox = title.getBoundingClientRect();
            const sheetBox = sheet.getBoundingClientRect();
            const hit = document.elementFromPoint(closeBox.left + closeBox.width / 2, closeBox.top + closeBox.height / 2);
            const inside = (box: DOMRect) => box.top >= -0.5 && box.left >= -0.5 && box.bottom <= window.innerHeight + 0.5 && box.right <= window.innerWidth + 0.5;
            return {
              title: title.textContent,
              scrolled: body.scrollTop > 40,
              stayed: Math.abs(closeBox.top - before) < 1,
              topGap: closeBox.top - sheetBox.top,
              closeInView: inside(closeBox),
              titleInView: inside(titleBox),
              hitClose: !!hit && (hit === close || close.contains(hit)),
            };
          });
          expect(servicePin.title, `${width} ${theme}`).toBe("Add Offered Service");
          expect(servicePin.scrolled, `${width} ${theme}`).toBe(true);
          expect(servicePin.stayed, `${width} ${theme}`).toBe(true);
          expect(servicePin.topGap, `${width} ${theme}`).toBeGreaterThanOrEqual(0);
          expect(servicePin.topGap, `${width} ${theme}`).toBeLessThan(28);
          expect(servicePin.closeInView, `${width} ${theme}`).toBe(true);
          expect(servicePin.titleInView, `${width} ${theme}`).toBe(true);
          expect(servicePin.hitClose, `${width} ${theme}`).toBe(true);
          const clipped = await page.evaluate(() => {
            const missed: string[] = [];
            const sizes: Record<string, string> = {};
            const lines: Record<string, number> = {};
            const ellipsis: string[] = [];
            const fit = (label: HTMLElement, state: string) => {
              const name = label.textContent || "";
              const style = getComputedStyle(label);
              sizes[name] = style.fontSize;
              const range = document.createRange();
              range.selectNodeContents(label);
              lines[name] = range.getClientRects().length;
              const overflow = label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1 || style.textOverflow === "ellipsis";
              if (style.textOverflow === "ellipsis" && ellipsis.indexOf(name) < 0) ellipsis.push(name);
              const key = `${state}:${name}`;
              if (overflow && missed.indexOf(key) < 0) missed.push(key);
              if (label.classList.contains("is-long") && lines[name] !== 1 && missed.indexOf(`lines:${name}`) < 0) missed.push(`lines:${name}`);
            };
            const tabs = Array.prototype.slice.call(document.querySelectorAll("#svcIconCats [role='tab']")) as HTMLButtonElement[];
            const ids: string[] = [];
            tabs.forEach((tab) => {
              tab.click();
              Array.prototype.forEach.call(document.querySelectorAll("#svcIconGrid [role='option']"), (button: HTMLElement) => {
                const id = button.getAttribute("data-icon") || "";
                if (id && ids.indexOf(id) < 0) ids.push(id);
                const label = button.querySelector(".sd-icon-name") as HTMLElement | null;
                if (label && button.getAttribute("aria-selected") !== "true") fit(label, "rest");
              });
            });
            const api = window as unknown as { setServiceIconCategory: (id: string) => void; selectServiceIcon: (id: string) => void };
            api.setServiceIconCategory("all");
            ids.forEach((id) => {
              api.selectServiceIcon(id);
              const label = document.querySelector("#svcIconGrid [role='option'][aria-selected='true'] .sd-icon-name") as HTMLElement | null;
              if (!label) missed.push(`missing:${id}`);
              else fit(label, "selected");
            });
            return {
              missed,
              ellipsis,
              star: sizes.Star || "",
              calendar: sizes.Calendar || "",
              kettlebell: sizes.Kettlebell || "",
              shampoo: sizes.Shampoo || "",
              detergent: sizes.Detergent || "",
              language: sizes.Language || "",
              realEstate: lines["Real estate"] || 0,
              homeRepair: lines["Home repair"] || 0,
            };
          });
          expect(clipped.ellipsis, `${width} ${theme}`).toEqual([]);
          expect(clipped.missed, `${width} ${theme} ${clipped.missed.join(", ")}`).toEqual([]);
          expect(clipped.star, `${width} ${theme}`).toBe("16px");
          expect(parseFloat(clipped.calendar), `${width} ${theme}`).toBeLessThanOrEqual(13);
          expect(parseFloat(clipped.calendar), `${width} ${theme}`).toBeGreaterThanOrEqual(11);
          expect(parseFloat(clipped.kettlebell), `${width} ${theme}`).toBeLessThanOrEqual(13);
          expect(parseFloat(clipped.shampoo), `${width} ${theme}`).toBeLessThanOrEqual(13);
          expect(parseFloat(clipped.detergent), `${width} ${theme}`).toBeLessThanOrEqual(13);
          expect(parseFloat(clipped.language), `${width} ${theme}`).toBeLessThanOrEqual(13);
          expect(clipped.realEstate, `${width} ${theme}`).toBeGreaterThanOrEqual(1);
          expect(clipped.realEstate, `${width} ${theme}`).toBeLessThanOrEqual(2);
          expect(clipped.homeRepair, `${width} ${theme}`).toBeGreaterThanOrEqual(1);
          expect(clipped.homeRepair, `${width} ${theme}`).toBeLessThanOrEqual(2);
          await page.click("#tenantServiceModal .sd-form-close");
          await page.evaluate(() => (window as unknown as { openEditServiceModal: (id: number) => void }).openEditServiceModal(1));
          await page.waitForSelector("#tenantServiceModal:not(.hidden) .sd-form-close", { timeout: 5000 });
          const editTitle = await page.evaluate(() => document.getElementById("tenantServiceModalTitle")?.textContent);
          expect(editTitle, `${width} ${theme}`).toBe("Edit Offered Service");
          expectChip(await readClose("#tenantServiceModal .sd-form-close"), theme, `edit service ${width} ${theme}`);
          await page.click("#tenantServiceModal .sd-form-close");
          await page.evaluate(() => (window as unknown as { openRosterApptModal: (id: string) => void }).openRosterApptModal("HB-1001"));
          await page.waitForSelector("#rosterApptModal:not(.hidden) .sd-form-close", { timeout: 5000 });
          expectChip(await readClose("#rosterApptModal .sd-form-close"), theme, `roster ${width} ${theme}`);
          const rosterPin = await page.evaluate(() => {
            const modal = document.getElementById("rosterApptModal") as HTMLElement;
            const sheet = modal.querySelector(".sd-form-sheet") as HTMLElement;
            const body = document.getElementById("rosterApptBody") as HTMLElement;
            const close = modal.querySelector(".sd-form-close") as HTMLElement;
            if (body.scrollHeight <= body.clientHeight + 40) sheet.style.maxHeight = "320px";
            const before = close.getBoundingClientRect().top;
            body.scrollTop = 480;
            const closeBox = close.getBoundingClientRect();
            const hit = document.elementFromPoint(closeBox.left + closeBox.width / 2, closeBox.top + closeBox.height / 2);
            const inside = (box: DOMRect) => box.top >= -0.5 && box.left >= -0.5 && box.bottom <= window.innerHeight + 0.5 && box.right <= window.innerWidth + 0.5;
            const actions = body.querySelector(".roster-sheet-actions");
            const result = {
              scrolled: body.scrollTop > 40,
              overlayHidden: getComputedStyle(modal).overflowY === "hidden",
              stayed: Math.abs(closeBox.top - before) < 1,
              closeInView: inside(closeBox),
              hitClose: !!hit && (hit === close || close.contains(hit)),
              actions: !!actions,
            };
            sheet.style.maxHeight = "";
            body.scrollTop = 0;
            return result;
          });
          expect(rosterPin.scrolled, `roster scroll ${width} ${theme}`).toBe(true);
          expect(rosterPin.overlayHidden, `roster overflow ${width} ${theme}`).toBe(true);
          expect(rosterPin.stayed, `roster close ${width} ${theme}`).toBe(true);
          expect(rosterPin.closeInView, `roster close view ${width} ${theme}`).toBe(true);
          expect(rosterPin.hitClose, `roster hit ${width} ${theme}`).toBe(true);
          expect(rosterPin.actions, `roster actions ${width} ${theme}`).toBe(true);
          await page.click("#rosterApptModal .sd-form-close");
          await page.evaluate(() => (window as unknown as { openTenantRescheduleModal: (id: string) => void }).openTenantRescheduleModal("HB-1001"));
          await page.waitForSelector("#tenantRescheduleModal:not(.hidden) .sd-form-close", { timeout: 5000 });
          expectChip(await readClose("#tenantRescheduleModal .sd-form-close"), theme, `reschedule ${width} ${theme}`);
          const showAll = await page.evaluate(() => {
            const modal = document.getElementById("tenantRescheduleModal") as HTMLElement;
            const close = modal.querySelector(".sd-form-close") as HTMLElement;
            const input = document.querySelector("#rescheduleTimeInputExtras .owner-time-showall") as HTMLInputElement;
            const title = document.getElementById("rescheduleTimeInputShowAllLabel") as HTMLElement;
            const row = input.closest(".sd-pay-switch-row") as HTMLElement;
            const box = input.getBoundingClientRect();
            const style = getComputedStyle(input);
            return {
              inHead: !!close.closest(".sd-form-head"),
              role: input.getAttribute("role"),
              aria: input.getAttribute("aria-checked"),
              on: input.checked,
              w: box.width,
              h: box.height,
              radius: parseFloat(style.borderTopLeftRadius),
              bg: style.backgroundColor,
              title: title.textContent,
              titleSize: getComputedStyle(title).fontSize,
              rowH: row.getBoundingClientRect().height,
            };
          });
          expect(showAll.inHead, `reschedule head ${width} ${theme}`).toBe(true);
          expect(showAll.role, `show all ${width} ${theme}`).toBe("switch");
          expect(showAll.aria, `show all ${width} ${theme}`).toBe("false");
          expect(showAll.on, `show all ${width} ${theme}`).toBe(false);
          expect(showAll.w, `show all ${width} ${theme}`).toBeGreaterThanOrEqual(51.5);
          expect(showAll.w, `show all ${width} ${theme}`).toBeLessThanOrEqual(52.5);
          expect(showAll.h, `show all ${width} ${theme}`).toBeGreaterThanOrEqual(29.5);
          expect(showAll.h, `show all ${width} ${theme}`).toBeLessThanOrEqual(30.5);
          expect(showAll.radius, `show all ${width} ${theme}`).toBeGreaterThanOrEqual(15);
          expect(showAll.bg, `show all ${width} ${theme}`).toBe(theme === "dark" ? "rgb(100, 116, 139)" : "rgb(203, 213, 225)");
          expect(showAll.title, `show all ${width} ${theme}`).toBe("Show all times");
          expect(showAll.titleSize, `show all ${width} ${theme}`).toBe("17px");
          expect(showAll.rowH, `show all ${width} ${theme}`).toBeGreaterThanOrEqual(56);
          await page.click("#rescheduleTimeInputExtras .owner-time-showall");
          const toggled = await page.evaluate(() => {
            const input = document.querySelector("#rescheduleTimeInputExtras .owner-time-showall") as HTMLInputElement;
            const hint = document.querySelector("#rescheduleTimeInputExtras .owner-time-hint") as HTMLElement;
            return {
              aria: input.getAttribute("aria-checked"),
              on: input.checked,
              bg: getComputedStyle(input).backgroundColor,
              hint: hint.textContent || "",
              hidden: hint.classList.contains("hidden"),
            };
          });
          expect(toggled.on, `show all on ${width} ${theme}`).toBe(true);
          expect(toggled.aria, `show all on ${width} ${theme}`).toBe("true");
          expect(toggled.bg, `show all on ${width} ${theme}`).toBe(theme === "dark" ? "rgb(16, 185, 129)" : "rgb(5, 150, 105)");
          expect(toggled.hidden, `show all hint ${width} ${theme}`).toBe(false);
          expect(toggled.hint, `show all hint ${width} ${theme}`).toContain("Showing every time");
          await page.click("#tenantRescheduleModal .sd-form-close");
          await page.evaluate(() => (window as unknown as { openAddBlockedTimeModal: () => void }).openAddBlockedTimeModal());
          await page.waitForSelector("#addBlockedTimeModal:not(.hidden) .sd-form-close", { timeout: 5000 });
          expectChip(await readClose("#addBlockedTimeModal .sd-form-close"), theme, `blocked ${width} ${theme}`);
          await page.click("#addBlockedTimeModal .sd-form-close");
          await page.evaluate(() => (window as unknown as { openClientDetail: (id: string) => void }).openClientDetail("CL-MAYA"));
          await page.waitForSelector("#sdClientPanel:not([hidden]) .sd-form-close", { timeout: 5000 });
          expectChip(await readClose("#sdClientPanel .sd-form-close"), theme, `client ${width} ${theme}`);
          await page.click("#sdClientPanel .sd-form-close");
          await page.evaluate(() => {
            (window as unknown as { schediDashGo: (page: string) => void }).schediDashGo("emails");
            (window as unknown as { openSeriesEmailPreview: () => void }).openSeriesEmailPreview();
          });
          await page.waitForSelector("#sdSeriesPreview:not([hidden]) .sd-form-close", { timeout: 5000 });
          expectChip(await readClose("#sdSeriesPreview .sd-form-close"), theme, `series ${width} ${theme}`);
          await page.click("#sdSeriesPreview .sd-form-close");
        }
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("includes every paid visit in history Total paid, including upcoming", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const money = (label: string) => Number(String(label).replace(/[^0-9.]/g, ""));
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("clients"));
      await page.waitForSelector('.sd-client-name[data-client-id="CL-MAYA"]', { timeout: 10000 });
      const readPaid = () => page.evaluate(() => {
        const card = document.querySelector('.sd-client-name[data-client-id="CL-MAYA"]')?.closest(".sd-client");
        const figure = card?.querySelector(".sd-client-paid-figure");
        (window as unknown as { openClientHistory: (id: string) => void }).openClientHistory("CL-MAYA");
        const modal = document.getElementById("clientHistoryModal");
        const totals = Array.from(modal?.querySelectorAll(".sd-client-history-totals p") || []);
        const paid = totals.find((node) => (node.querySelector("span")?.textContent || "") === "Total paid");
        const upcoming = Array.from(modal?.querySelectorAll(".sd-client-history-group") || []).find((node) => node.querySelector("h3")?.textContent === "Upcoming");
        return {
          card: figure?.textContent || "",
          sheet: paid?.querySelector("strong")?.textContent || "",
          upcoming: upcoming?.textContent || "",
        };
      });
      const before = await readPaid();
      expect(before.card).toBe("$238");
      expect(before.sheet).toBe(before.card);
      await page.evaluate(() => {
        const tenant = (window as unknown as { getTenant: () => { appointments?: Record<string, unknown>[] } }).getTenant();
        (tenant.appointments || []).push({
          id: "HB-PREPAID",
          clientName: "Maya Chen",
          clientPhone: "(555) 201-0142",
          clientEmail: "maya@example.com",
          serviceName: "Prepaid color",
          date: "2099-01-15",
          time: "11:00 AM",
          status: "accepted",
          paymentStatus: "PAID VIA CARD",
          paidMethod: "card",
          amount: 65,
          durationMins: 90,
        });
        (window as unknown as { renderClientList: () => void }).renderClientList();
      });
      const after = await readPaid();
      expect(after.upcoming).toContain("Prepaid color");
      expect(after.card).toBe("$303");
      expect(after.sheet).toBe(after.card);
      expect(money(after.sheet)).toBe(money(before.sheet) + 65);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 60000);

  it("gives the history sheet chip styles and closes it on Escape", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("clients"));
      await page.waitForSelector('.sd-client-name[data-client-id="CL-MAYA"]', { timeout: 10000 });
      const planted = await page.evaluate(() => {
        const tenant = (window as unknown as { getTenant: () => { appointments?: Record<string, unknown>[] } }).getTenant();
        const apps = tenant.appointments || [];
        const today = String(apps.find((row) => row && row.id === "HB-1001")?.date || "");
        const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
        const map: Record<string, string> = {};
        fmt.formatToParts(new Date()).forEach((part) => {
          if (part.type !== "literal") map[part.type] = part.value;
        });
        let hour = parseInt(map.hour, 10);
        if (hour === 24) hour = 0;
        const now = hour * 60 + parseInt(map.minute, 10);
        const label = (mins: number) => {
          const h = Math.floor(mins / 60);
          const m = mins % 60;
          const ap = h >= 12 ? "PM" : "AM";
          const h12 = h % 12 || 12;
          return h12 + ":" + String(m).padStart(2, "0") + " " + ap;
        };
        const early = now > 0 ? now - 1 : null;
        const late = now < 23 * 60 + 59 ? now + 1 : null;
        if (early != null) {
          apps.push({ id: "HB-EARLY", clientName: "Maya Chen", clientPhone: "(555) 201-0142", clientEmail: "maya@example.com", serviceName: "Earlier today cut", date: today, time: label(early), status: "accepted", paymentStatus: "PAID VIA CARD", paidMethod: "card", amount: 40, durationMins: 30 });
        }
        if (late != null) {
          apps.push({ id: "HB-LATE", clientName: "Maya Chen", clientPhone: "(555) 201-0142", clientEmail: "maya@example.com", serviceName: "Later today cut", date: today, time: label(late), status: "accepted", paymentStatus: "PAY AT APPOINTMENT", amount: 55, durationMins: 30 });
        }
        return { today, early, late };
      });
      const readHistory = () => page.evaluate(() => {
        const modal = document.getElementById("clientHistoryModal");
        const chip = modal?.querySelector(".sd-pay.sd-pay-card") as HTMLElement | null;
        const svg = chip?.querySelector("svg");
        const word = chip?.querySelector(".sd-pay-word");
        const totals = modal?.querySelector(".sd-client-history-totals p");
        const span = totals?.querySelector("span");
        const strong = totals?.querySelector("strong");
        const heading = modal?.querySelector(".sd-client-history-group h3");
        const section = (title: string) => {
          const groups = modal?.querySelectorAll(".sd-client-history-group") || [];
          for (const group of groups) {
            const name = group.querySelector("h3")?.textContent || "";
            if (name === title) return group.textContent || "";
          }
          return "";
        };
        if (!modal || !chip || !svg || !word || !span || !strong || !heading) return null;
        const chipStyle = getComputedStyle(chip);
        const svgBox = svg.getBoundingClientRect();
        const wordBox = word.getBoundingClientRect();
        const spanBox = span.getBoundingClientRect();
        const strongBox = strong.getBoundingClientRect();
        const headingStyle = getComputedStyle(heading);
        return {
          hidden: modal.classList.contains("hidden"),
          display: chipStyle.display,
          radius: chipStyle.borderTopLeftRadius,
          weight: chipStyle.fontWeight,
          chipColor: chipStyle.color,
          svgW: Math.round(svgBox.width),
          svgDisplay: getComputedStyle(svg).display,
          sameLine: Math.abs(svgBox.top - wordBox.top) < 8 && svgBox.right <= wordBox.left + 2,
          spanDisplay: getComputedStyle(span).display,
          strongDisplay: getComputedStyle(strong).display,
          stacked: strongBox.top >= spanBox.bottom - 1,
          label: span.textContent || "",
          value: strong.textContent || "",
          headingWeight: headingStyle.fontWeight,
          headingSize: headingStyle.fontSize,
          headingColor: headingStyle.color,
          totalsBg: getComputedStyle(totals as Element).backgroundColor,
          upcoming: section("Upcoming"),
          past: section("Past"),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      for (const width of [390, 768, 1024, 1280, 1440]) {
        await page.setViewport({ width, height: 900 });
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode), theme);
          await page.evaluate(() => (window as unknown as { openClientHistory: (id: string) => void }).openClientHistory("CL-MAYA"));
          await page.waitForSelector("#clientHistoryModal:not(.hidden) .sd-pay", { timeout: 5000 });
          const view = await readHistory();
          expect(view, `${width} ${theme}`).not.toBeNull();
          if (!view) continue;
          expect(view.hidden, `${width} ${theme}`).toBe(false);
          expect(view.display, `${width} ${theme}`).toBe("flex");
          expect(view.radius, `${width} ${theme}`).toBe("999px");
          expect(view.weight, `${width} ${theme}`).toBe("800");
          expect(view.svgW, `${width} ${theme}`).toBe(14);
          expect(view.svgDisplay, `${width} ${theme}`).toBe("block");
          expect(view.sameLine, `${width} ${theme}`).toBe(true);
          expect(view.chipColor, `${width} ${theme}`).toBe(theme === "dark" ? "rgb(196, 192, 255)" : "rgb(67, 56, 202)");
          expect(view.spanDisplay, `${width} ${theme}`).toBe("block");
          expect(view.strongDisplay, `${width} ${theme}`).toBe("block");
          expect(view.stacked, `${width} ${theme}`).toBe(true);
          expect(view.label, `${width} ${theme}`).toBe("Visits");
          expect(view.value, `${width} ${theme}`).toMatch(/^\d+ done · \d+ upcoming$/);
          expect(view.headingWeight, `${width} ${theme}`).toBe("800");
          expect(view.headingSize, `${width} ${theme}`).toBe("13px");
          expect(view.headingColor, `${width} ${theme}`).toBe(theme === "dark" ? "rgb(241, 245, 249)" : "rgb(15, 23, 42)");
          expect(view.totalsBg, `${width} ${theme}`).toBe(theme === "dark" ? "rgb(6, 8, 13)" : "rgb(244, 247, 251)");
          expect(view.overflow, `${width} ${theme}`).toBeLessThanOrEqual(1);
          if (planted.early != null) expect(view.past, `${width} ${theme}`).toContain("Earlier today cut");
          if (planted.late != null) expect(view.upcoming, `${width} ${theme}`).toContain("Later today cut");
          if (planted.early != null) expect(view.upcoming, `${width} ${theme}`).not.toContain("Earlier today cut");
        }
      }
      await page.keyboard.press("Escape");
      await page.waitForSelector("#clientHistoryModal.hidden", { timeout: 5000 });
      const closed = await page.$eval("#clientHistoryModal", (el) => el.classList.contains("hidden"));
      expect(closed).toBe(true);
      for (const theme of ["dark", "light"] as const) {
        await page.setViewport({ width: 390, height: 900 });
        await page.evaluate((mode) => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode), theme);
        await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("clients"));
        await page.evaluate(() => {
          const row = document.querySelector('.sd-client-name[data-client-id="CL-MAYA"]')?.closest(".sd-client");
          (row?.querySelector("details.sd-more summary") as HTMLElement | null)?.click();
        });
        await page.waitForFunction(() => {
          const menu = document.querySelector('.sd-client-name[data-client-id="CL-MAYA"]')?.closest(".sd-client")?.querySelector(".sd-more-menu") as HTMLElement | null;
          return !!menu && getComputedStyle(menu).visibility === "visible";
        }, { timeout: 5000 });
        const remove = await page.evaluate(() => {
          const menu = document.querySelector('.sd-client-name[data-client-id="CL-MAYA"]')?.closest(".sd-client")?.querySelector(".sd-more-menu");
          return Array.from(menu?.querySelectorAll("button") || []).map((node) => {
            const el = node as HTMLButtonElement;
            return { label: (el.textContent || "").trim(), fg: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor };
          });
        });
        const rest = theme === "dark" ? "rgb(241, 245, 249)" : "rgb(15, 23, 42)";
        const danger = theme === "dark" ? "rgb(251, 113, 133)" : "rgb(190, 18, 60)";
        expect(remove.map((row) => row.label)).toEqual(["Book appointment", "View history", "Remove"]);
        expect(remove.find((row) => row.label === "Remove")?.fg).toBe(danger);
        expect(remove.find((row) => row.label === "Remove")?.bg).toBe("rgba(0, 0, 0, 0)");
        expect(remove.find((row) => row.label === "View history")?.fg).toBe(rest);
        await page.evaluate(() => (window as unknown as { closeSchediTodayMenus: () => void }).closeSchediTodayMenus());
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it("paints paid method chips in brand tints on cards, filters, and history", async () => {
    const paint = {
      cashapp: {
        dark: { color: "rgb(0, 214, 79)", bg: "rgba(0, 214, 79, 0.18)", border: "rgb(0, 214, 79)" },
        light: { color: "rgb(4, 102, 50)", bg: "rgba(0, 214, 79, 0.16)", border: "rgb(0, 214, 79)" },
        on: {
          dark: { color: "rgb(0, 214, 79)", bg: "rgba(0, 214, 79, 0.28)", border: "rgb(0, 214, 79)" },
          light: { color: "rgb(4, 102, 50)", bg: "rgba(0, 214, 79, 0.24)", border: "rgb(0, 214, 79)" },
        },
      },
      venmo: {
        dark: { color: "rgb(185, 221, 255)", bg: "rgba(0, 140, 255, 0.16)", border: "rgb(0, 140, 255)" },
        light: { color: "rgb(0, 87, 184)", bg: "rgba(0, 140, 255, 0.12)", border: "rgb(0, 140, 255)" },
        on: {
          dark: { color: "rgb(185, 221, 255)", bg: "rgba(0, 140, 255, 0.28)", border: "rgb(0, 140, 255)" },
          light: { color: "rgb(0, 87, 184)", bg: "rgba(0, 140, 255, 0.22)", border: "rgb(0, 140, 255)" },
        },
      },
      zelle: {
        dark: { color: "rgb(228, 212, 255)", bg: "rgba(109, 30, 212, 0.22)", border: "rgb(109, 30, 212)" },
        light: { color: "rgb(76, 18, 143)", bg: "rgba(109, 30, 212, 0.14)", border: "rgb(109, 30, 212)" },
        on: {
          dark: { color: "rgb(228, 212, 255)", bg: "rgba(109, 30, 212, 0.34)", border: "rgb(109, 30, 212)" },
          light: { color: "rgb(76, 18, 143)", bg: "rgba(109, 30, 212, 0.22)", border: "rgb(109, 30, 212)" },
        },
      },
      paypal: {
        dark: { color: "rgb(197, 221, 255)", bg: "rgba(0, 112, 224, 0.2)", border: "rgb(0, 112, 224)" },
        light: { color: "rgb(0, 48, 135)", bg: "rgba(0, 48, 135, 0.12)", border: "rgb(0, 48, 135)" },
        on: {
          dark: { color: "rgb(197, 221, 255)", bg: "rgba(0, 112, 224, 0.32)", border: "rgb(0, 112, 224)" },
          light: { color: "rgb(0, 48, 135)", bg: "rgba(0, 48, 135, 0.2)", border: "rgb(0, 48, 135)" },
        },
      },
      square: {
        dark: { color: "rgb(248, 250, 252)", bg: "rgba(255, 255, 255, 0.14)", border: "rgb(226, 232, 240)" },
        light: { color: "rgb(255, 255, 255)", bg: "rgb(0, 0, 0)", border: "rgb(0, 0, 0)" },
        on: {
          dark: { color: "rgb(248, 250, 252)", bg: "rgba(255, 255, 255, 0.22)", border: "rgb(226, 232, 240)" },
          light: { color: "rgb(255, 255, 255)", bg: "rgb(0, 0, 0)", border: "rgb(0, 0, 0)" },
        },
      },
      card: {
        dark: { color: "rgb(196, 192, 255)", bg: "rgba(99, 91, 255, 0.18)", border: "rgb(99, 91, 255)" },
        light: { color: "rgb(67, 56, 202)", bg: "rgba(99, 91, 255, 0.14)", border: "rgb(99, 91, 255)" },
        on: {
          dark: { color: "rgb(196, 192, 255)", bg: "rgba(99, 91, 255, 0.28)", border: "rgb(99, 91, 255)" },
          light: { color: "rgb(67, 56, 202)", bg: "rgba(99, 91, 255, 0.22)", border: "rgb(99, 91, 255)" },
        },
      },
      cash: {
        dark: { color: "rgb(241, 245, 249)", bg: "rgba(148, 163, 184, 0.14)", border: "rgba(255, 255, 255, 0.08)" },
        light: { color: "rgb(15, 23, 42)", bg: "rgba(148, 163, 184, 0.14)", border: "rgb(215, 222, 232)" },
      },
      unpaid: {
        dark: { color: "rgb(251, 113, 133)", bg: "rgba(244, 63, 94, 0.1)", border: "rgba(244, 63, 94, 0.35)" },
        light: { color: "rgb(190, 18, 60)", bg: "rgba(244, 63, 94, 0.1)", border: "rgba(244, 63, 94, 0.35)" },
      },
    };
    const rows: Record<string, string> = {
      cashapp: "HB-1009",
      zelle: "HB-1010",
      venmo: "HB-1011",
      square: "HB-1012",
      paypal: "HB-1024",
      card: "HB-1001",
      unpaid: "HB-1003",
    };
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      const readChip = (selector: string) => page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;
        const style = getComputedStyle(el);
        return {
          text: (el.textContent || "").replace(/\s+/g, " ").trim(),
          color: style.color,
          bg: style.backgroundColor,
          border: style.borderTopColor,
        };
      }, selector);
      for (const width of [390, 1280]) {
        await page.setViewport({ width, height: 900 });
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode), theme);
          await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("today"));
          await page.waitForSelector("#schediTodaySchedule .sd-pay", { timeout: 8000 });
          const todayNames = { card: "Maya Chen", unpaid: "Jordan Lee" } as const;
          for (const kind of ["card", "unpaid"] as const) {
            const chip = await page.evaluate((name) => {
              const cards = document.querySelectorAll("#schediTodaySchedule .sd-card");
              for (const card of cards) {
                const title = card.querySelector(".sd-row-title")?.textContent || "";
                if (!title.includes(name)) continue;
                const el = card.querySelector(".sd-pay") as HTMLElement | null;
                if (!el) return null;
                const style = getComputedStyle(el);
                return { color: style.color, bg: style.backgroundColor, border: style.borderTopColor };
              }
              return null;
            }, todayNames[kind]);
            expect(chip, `today ${kind} ${width} ${theme}`).toEqual(paint[kind][theme]);
          }
          await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("appointments"));
          await page.waitForSelector('#tenantSectionRoster [data-booking-id="HB-1009"] .sd-pay', { timeout: 8000 });
          for (const kind of Object.keys(rows)) {
            const chip = await readChip(`#tenantSectionRoster [data-booking-id="${rows[kind]}"] .sd-pay`);
            expect(chip && { color: chip.color, bg: chip.bg, border: chip.border }, `roster ${kind} ${width} ${theme}`).toEqual(paint[kind as keyof typeof paint][theme]);
            if (kind === "cashapp") expect(chip?.text, `${width} ${theme}`).toContain("Cash App");
            if (kind === "cashapp") expect(chip?.text, `${width} ${theme}`).toContain("$28");
            if (kind === "unpaid") {
              const cashChip = await readChip('#tenantSectionRoster [data-booking-id="HB-1006"] .sd-pay');
              expect(cashChip && { color: cashChip.color, bg: cashChip.bg, border: cashChip.border }, `roster cash ${width} ${theme}`).toEqual(paint.cash[theme]);
              expect(cashChip?.bg, `${width} ${theme}`).not.toBe(chip?.bg);
              expect(cashChip?.text, `${width} ${theme}`).toContain("In person / Cash");
            }
            if (kind === "cashapp") {
              const cashAppFilter = await page.evaluate(() => {
                const el = document.querySelector('#rosterPayFilter [data-pay-filter="cashapp"]') as HTMLElement | null;
                const cash = document.querySelector('#rosterPayFilter [data-pay-filter="cash"]') as HTMLElement | null;
                if (!el || !cash) return null;
                const style = getComputedStyle(el);
                const cashStyle = getComputedStyle(cash);
                return {
                  color: style.color,
                  bg: style.backgroundColor,
                  border: style.borderTopColor,
                  text: (el.textContent || "").replace(/\s+/g, " ").trim(),
                  wrap: style.whiteSpace,
                  cashText: (cash.textContent || "").replace(/\s+/g, " ").trim(),
                  cashWrap: cashStyle.whiteSpace,
                  cashH: cash.offsetHeight,
                };
              });
              expect(cashAppFilter && { color: cashAppFilter.color, bg: cashAppFilter.bg, border: cashAppFilter.border }, `cash app filter ${width} ${theme}`).toEqual(paint.cashapp[theme]);
              expect(cashAppFilter?.text, `${width} ${theme}`).toContain("Cash App");
              expect(cashAppFilter?.wrap, `${width} ${theme}`).toBe("nowrap");
              expect(cashAppFilter?.cashText, `${width} ${theme}`).toMatch(/^Cash\d+$/);
              expect(cashAppFilter?.cashText, `${width} ${theme}`).not.toContain("In person");
              expect(cashAppFilter?.cashWrap, `${width} ${theme}`).toBe("nowrap");
              if (width >= 860) expect(cashAppFilter?.cashH, `${width} ${theme}`).toBeLessThanOrEqual(40);
            }
            const filter = await readChip(`#rosterPayFilter [data-pay-filter="${kind}"]`);
            if (kind === "unpaid") {
              expect(filter, `filter ${kind} ${width} ${theme}`).toBeTruthy();
            } else {
              expect(filter && { color: filter.color, bg: filter.bg, border: filter.border }, `filter ${kind} ${width} ${theme}`).toEqual(paint[kind as keyof typeof paint][theme]);
            }
          }
          for (const kind of ["cashapp", "venmo", "zelle", "paypal", "square", "card"] as const) {
            await page.evaluate((id) => (window as unknown as { setRosterPayFilter: (id: string) => void }).setRosterPayFilter(id), kind);
            const selected = await readChip(`#rosterPayFilter [data-pay-filter="${kind}"]`);
            expect(selected && { color: selected.color, bg: selected.bg, border: selected.border }, `selected ${kind} ${width} ${theme}`).toEqual(paint[kind].on[theme]);
          }
          await page.evaluate(() => (window as unknown as { setRosterPayFilter: (id: string) => void }).setRosterPayFilter("all"));
          await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("clients"));
          await page.evaluate(() => (window as unknown as { openClientHistory: (id: string) => void }).openClientHistory("CL-LUIS"));
          await page.waitForSelector("#clientHistoryModal:not(.hidden) .sd-pay-cashapp", { timeout: 5000 });
          const historyCash = await readChip("#clientHistoryModal .sd-pay-cashapp");
          expect(historyCash && { color: historyCash.color, bg: historyCash.bg, border: historyCash.border }, `history cash ${width} ${theme}`).toEqual(paint.cashapp[theme]);
          expect(historyCash?.text, `${width} ${theme}`).toContain("$28");
          await page.evaluate(() => (window as unknown as { closeClientHistory: () => void }).closeClientHistory());
          await page.evaluate(() => (window as unknown as { openClientHistory: (id: string) => void }).openClientHistory("CL-ELENA"));
          await page.waitForSelector("#clientHistoryModal:not(.hidden) .sd-pay-paypal", { timeout: 5000 });
          const historyPayPal = await readChip("#clientHistoryModal .sd-pay-paypal");
          expect(historyPayPal && { color: historyPayPal.color, bg: historyPayPal.bg, border: historyPayPal.border }, `history paypal ${width} ${theme}`).toEqual(paint.paypal[theme]);
          await page.evaluate(() => (window as unknown as { closeClientHistory: () => void }).closeClientHistory());
        }
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);
});

describe.skipIf(!chrome)("classic owner roster icons", () => {
  it("gives a signed-in owner the new dashboard and keeps roster icons sized", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const policy = contentSecurityPolicy(true);
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/login" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      const headers: Record<string, string> = {
        "content-type": types[extname(full)] || "application/octet-stream",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "strict-transport-security": "max-age=31536000",
      };
      if (file === "/index.html") {
        headers["content-security-policy"] = policy;
        headers["x-frame-options"] = "DENY";
      }
      res.writeHead(200, headers);
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1024, height: 800 });
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        if (url.startsWith("https://schedi.app/")) {
          const headers = {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "content-type",
          };
          if (request.method() === "OPTIONS") {
            void request.respond({ status: 204, headers });
            return;
          }
          const body = url.includes("/auth/tenant")
            ? JSON.stringify({ session: "roster-classic-test", tenantId: "aura-exec" })
            : JSON.stringify({ ok: true });
          void request.respond({ status: 200, contentType: "application/json", headers, body });
          return;
        }
        void request.continue();
      });
      const response = await page.goto(`http://127.0.0.1:${port}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
      expect(response?.headers()["content-security-policy"]).toBe(policy);
      await page.waitForSelector("#tenantLoginEmail", { timeout: 20000 });
      await page.type("#tenantLoginEmail", "alex@auraconsulting.com");
      await page.type("#tenantLoginPassword", "classic-roster");
      await page.click("#tenantLoginBox button[type='submit']");
      await page.waitForFunction(() => {
        const section = document.getElementById("tenantPortalSection");
        const side = document.getElementById("schediDashSidebar");
        return document.body.classList.contains("schedi-newdash")
          && !!section?.classList.contains("schedi-newdash")
          && !!side
          && getComputedStyle(side).display !== "none";
      }, { timeout: 20000 });
      await page.evaluate(() => (window as unknown as { schediDashGo: (page: string) => void }).schediDashGo("appointments"));
      await page.waitForFunction(() => {
        const nodes = [...document.querySelectorAll("#tenantRosterTableBody .sd-pay svg")];
        return nodes.some((svg) => svg.getBoundingClientRect().width > 0);
      }, { timeout: 20000 });
      const measure = () => page.evaluate(() => {
        const section = document.getElementById("tenantPortalSection");
        const side = document.getElementById("schediDashSidebar");
        const tab = document.getElementById("schediDashTabbar");
        const nodes = [
          ...document.querySelectorAll("#rosterPayFilter svg, #tenantRosterTableBody svg, #schediTodaySchedule svg"),
        ] as SVGElement[];
        const svgs = nodes.filter((svg) => svg.getAttribute("role") !== "img").map((svg) => {
          const box = svg.getBoundingClientRect();
          return { w: box.width, h: box.height };
        }).filter((box) => box.w > 0 || box.h > 0);
        const paid = document.querySelector('[data-booking-id="NX-8910"] .roster-paid-figure') as HTMLElement | null;
        const count = document.querySelector("#rosterPayFilter .sd-chip-count") as HTMLElement | null;
        const input = document.getElementById("rosterSearchInput") as HTMLElement | null;
        const toggle = document.getElementById("rosterSearchToggle");
        const selectAll = document.getElementById("rosterSelectAllPhone");
        const labels = [...document.querySelectorAll("#rosterPayFilter button")].map((btn) => (btn.textContent || "").replace(/\s+/g, ""));
        return {
          newdash: !!(section && section.classList.contains("schedi-newdash") && document.body.classList.contains("schedi-newdash")),
          demo: (window as unknown as { __SCHEDI_DEMO?: boolean }).__SCHEDI_DEMO === true,
          side: side ? getComputedStyle(side).display : "",
          tab: tab ? getComputedStyle(tab).display : "",
          svgs,
          paid: paid ? (paid.textContent || "").replace(/\s+/g, " ").trim() : "",
          countGap: count ? getComputedStyle(count).marginLeft : "",
          inputBg: input ? getComputedStyle(input).backgroundColor : "",
          toggle: toggle ? getComputedStyle(toggle).display : "",
          selectAll: selectAll ? getComputedStyle(selectAll).display : "",
          labels,
          light: document.documentElement.classList.contains("schedi-light"),
        };
      });
      const dark = await measure();
      expect(dark.demo).toBe(false);
      expect(dark.newdash).toBe(true);
      expect(dark.side).not.toBe("none");
      expect(dark.tab).toBe("none");
      expect(dark.svgs.length).toBeGreaterThan(0);
      dark.svgs.forEach((svg) => {
        expect(svg.w).toBeLessThanOrEqual(48);
        expect(svg.h).toBeLessThanOrEqual(48);
      });
      expect(dark.paid).toBe("$75");
      expect(dark.paid).not.toContain("Paid$");
      expect(dark.labels.some((label) => /Card/.test(label) && /All/.test(label))).toBe(false);
      expect(dark.countGap).not.toBe("0px");
      expect(dark.toggle).toBe("none");
      expect(dark.selectAll).toBe("none");
      expect(dark.inputBg).not.toBe("rgb(255, 255, 255)");
      await page.setViewport({ width: 390, height: 800 });
      const phone = await measure();
      expect(phone.newdash).toBe(true);
      expect(phone.demo).toBe(false);
      expect(phone.side).toBe("none");
      expect(phone.tab).not.toBe("none");
      phone.svgs.forEach((svg) => {
        expect(svg.w).toBeLessThanOrEqual(48);
        expect(svg.h).toBeLessThanOrEqual(48);
      });
      await page.setViewport({ width: 1024, height: 800 });
      await page.evaluate(() => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme("light"));
      const light = await measure();
      expect(light.light).toBe(true);
      expect(light.newdash).toBe(true);
      expect(light.side).not.toBe("none");
      expect(light.tab).toBe("none");
      light.svgs.forEach((svg) => {
        expect(svg.w).toBeLessThanOrEqual(48);
        expect(svg.h).toBeLessThanOrEqual(48);
      });
      expect(light.paid).toBe("$75");
      expect(light.toggle).toBe("none");
      const open = async (url: string) => {
        let last: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
          } catch (error) {
            last = error;
          }
        }
        throw last;
      };
      const classic = await open(`http://127.0.0.1:${port}/login?classic=1`);
      expect(classic?.headers()["content-security-policy"]).toBe(policy);
      await page.waitForFunction(() => {
        const row = document.querySelector("#tenantRosterTableBody .sd-pay svg");
        const box = row?.getBoundingClientRect();
        return !document.body.classList.contains("schedi-newdash") && !!box && box.width > 0 && box.width <= 48;
      }, { timeout: 20000 });
      const demo = await open(`http://127.0.0.1:${port}/portal-preview`);
      expect(demo?.headers()["content-security-policy"]).toBe(policy);
      await page.waitForFunction(() => {
        const row = document.querySelector("#tenantRosterTableBody .sd-pay svg, #schediTodaySchedule .sd-pay svg");
        const box = row?.getBoundingClientRect();
        return document.body.classList.contains("schedi-newdash") && !!box && box.width > 0;
      }, { timeout: 20000 });
      const preview = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll("#rosterPayFilter svg, #tenantRosterTableBody svg, #schediTodaySchedule .sd-pay svg, #schediTodaySchedule .sd-svc-mark svg")] as SVGElement[];
        return {
          demo: (window as unknown as { __SCHEDI_DEMO?: boolean }).__SCHEDI_DEMO === true,
          svgs: nodes.map((svg) => {
            const box = svg.getBoundingClientRect();
            return { w: box.width, h: box.height };
          }),
        };
      });
      expect(preview.demo).toBe(true);
      const visible = preview.svgs.filter((svg) => svg.w > 0 || svg.h > 0);
      expect(visible.length).toBeGreaterThan(0);
      visible.forEach((svg) => {
        expect(svg.w).toBeLessThanOrEqual(48);
        expect(svg.h).toBeLessThanOrEqual(48);
      });
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);
});

describe.skipIf(!chrome)("owner sign-in placement", () => {
  it("centers the sign-in card on desktop and leaves the phone layout and signed-in dashboard alone", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/login" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        if (/googleapis|firebaseio|firebasestorage|gstatic|cloudflareinsights|schedi\.app/.test(url)) {
          void request.respond({ status: 204, body: "" });
          return;
        }
        void request.continue();
      });
      const place = () => page.evaluate(() => {
        const box = document.getElementById("tenantLoginBox");
        const section = document.getElementById("tenantPortalSection");
        const side = document.getElementById("schediDashSidebar");
        const rect = box?.getBoundingClientRect();
        const visible = !!box && !box.classList.contains("hidden") && !!rect && rect.width > 0;
        const style = section ? getComputedStyle(section) : null;
        const sideRect = side?.getBoundingClientRect();
        return {
          deltaX: visible && rect ? (rect.left + rect.width / 2) - window.innerWidth / 2 : null,
          deltaY: visible && rect ? (rect.top + rect.height / 2) - window.innerHeight / 2 : null,
          top: visible && rect ? rect.top : null,
          width: visible && rect ? rect.width : 0,
          padL: style ? style.paddingLeft : "",
          header: getComputedStyle(document.querySelector("header") as HTMLElement).display,
          sideW: sideRect ? sideRect.width : 0,
          light: document.documentElement.classList.contains("schedi-light"),
        };
      });
      const open = async (path: string, width: number, height = 900) => {
        await page.setViewport({ width, height, deviceScaleFactor: 1 });
        await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForFunction(() => {
          const box = document.getElementById("tenantLoginBox");
          return !!box && box.getBoundingClientRect().width > 100;
        }, { timeout: 15000 });
      };
      const mountDash = () => page.evaluate(() => {
        document.body.classList.add("schedi-newdash");
        const section = document.getElementById("tenantPortalSection");
        section?.classList.add("schedi-newdash");
        section?.classList.remove("hidden");
        document.getElementById("tenantLoginBox")?.classList.remove("hidden");
        document.getElementById("tenantDashboard")?.classList.add("hidden");
      });
      for (const width of [860, 1024, 1280, 1440]) {
        await open("/login", width);
        await mountDash();
        for (const theme of ["dark", "light"]) {
          await page.evaluate((mode) => {
            document.documentElement.classList.toggle("schedi-light", mode === "light");
          }, theme);
          const box = await place();
          expect(box.deltaX, `new ${width} ${theme}`).not.toBeNull();
          expect(Math.abs(box.deltaX || 0), `new ${width} ${theme}`).toBeLessThanOrEqual(8);
          expect(Math.abs(box.deltaY || 0), `new ${width} ${theme}`).toBeLessThanOrEqual(24);
          expect(box.width, `new ${width} ${theme}`).toBeGreaterThan(400);
          expect(box.width, `new ${width} ${theme}`).toBeLessThan(480);
          expect(box.header, `new ${width} ${theme}`).toBe("none");
          expect(box.light, `new ${width} ${theme}`).toBe(theme === "light");
        }
        await open("/login?classic=1", width);
        for (const theme of ["dark", "light"]) {
          await page.evaluate((mode) => {
            document.documentElement.classList.toggle("schedi-light", mode === "light");
          }, theme);
          const box = await place();
          expect(Math.abs(box.deltaX || 0), `classic ${width} ${theme}`).toBeLessThanOrEqual(8);
          expect(box.top || 0, `classic ${width} ${theme}`).toBeGreaterThan(70);
          expect(box.top || 0, `classic ${width} ${theme}`).toBeLessThan(220);
          expect(box.header, `classic ${width} ${theme}`).toBe("block");
          expect(box.width, `classic ${width} ${theme}`).toBeGreaterThan(400);
        }
      }
      await open("/login", 390, 800);
      const phone = await place();
      expect(Math.abs(phone.deltaX || 0)).toBeLessThanOrEqual(8);
      expect(phone.top || 0).toBeGreaterThan(120);
      expect(phone.top || 0).toBeLessThan(220);
      expect(phone.header).toBe("block");
      expect(phone.padL).toBe("0px");
      await mountDash();
      const phoneDash = await place();
      expect(Math.abs(phoneDash.deltaX || 0)).toBeLessThanOrEqual(8);
      expect(phoneDash.padL).toBe("14px");
      expect(phoneDash.top || 0).toBeLessThan(140);
      expect(phoneDash.header).toBe("none");
      await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
      await page.evaluate(() => {
        document.getElementById("tenantLoginBox")?.classList.add("hidden");
        document.getElementById("tenantDashboard")?.classList.remove("hidden");
        const chromeBox = document.getElementById("schediDashChrome");
        if (chromeBox) chromeBox.hidden = false;
      });
      const signedIn = await place();
      expect(signedIn.width).toBe(0);
      expect(signedIn.padL).toBe("268px");
      expect(signedIn.sideW).toBeGreaterThan(200);
      expect(signedIn.header).toBe("none");
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);
});
