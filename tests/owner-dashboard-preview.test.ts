import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { handleRequest, type SchediEnv } from "../worker/handler";
import { renderRobots, renderSitemap } from "../worker/render";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;
const BOOKING_TEMPLATE_SHA = "e07eb14f8d9174a9ceb5788fce33e426c30df12e0ef9361f3cc9640313bba586";
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
    expect(extractFunction(html, "rosterStatusCellHtml")).toContain("appointmentPayMarkup");
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
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain("<title>Schedi</title>");
    expect(preview.headers.get("x-robots-tag")).toContain("noindex");

    for (const path of ["/?demo=1", "/?newdash=1"]) {
      const response = await handleRequest(new Request("https://schedi.app" + path), env(), ctx());
      expect(response.status, path).toBe(200);
      const text = await response.text();
      expect(text, path).toContain("<body>app");
      expect(text, path).toContain("</body>");
      if (path.includes("demo=1")) expect(text, path).toContain("<body>app</body>");
      else expect(text, path).toContain("Cloudflare Web Analytics");
    }

    const home = await handleRequest(new Request("https://schedi.app/"), env(), ctx());
    expect(await home.text()).not.toContain("<body>app</body>");
    expect(renderRobots()).toContain("Disallow: /portal-preview");
    expect(renderSitemap()).not.toContain("portal-preview");
    expect(html).toContain("first === 'portal-preview'");
  });

  it("turns the new dashboard on for the preview and off on production", () => {
    const demo = runHead("/portal-preview", "", "127.0.0.1");
    expect(demo.demo).toBe(true);
    expect(demo.dash).toBe(true);
    expect(demo.classes).toContain("schedi-newdash-boot");

    const compared = runHead("/portal-preview", "?newdash=0", "127.0.0.1");
    expect(compared.demo).toBe(true);
    expect(compared.dash).toBe(false);

    const production = runHead("/login", "", "schedi.app");
    expect(production.demo).toBe(false);
    expect(production.dash).toBe(false);

    const previewHost = runHead("/login", "", "localhost");
    expect(previewHost.dash).toBe(true);

    const forced = runHead("/login", "?newdash=1", "www.schedi.app");
    expect(forced.demo).toBe(false);
    expect(forced.dash).toBe(true);

    const storedOff = runHead("/login", "", "localhost", { schediNewDash: "0" });
    expect(storedOff.dash).toBe(false);
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

  it("places Add appointment directly above New requests on a phone", () => {
    const panel = html.slice(html.indexOf('id="schediTodayPanel"'), html.indexOf('id="schediDashTabbar"'));
    const desktopBtn = panel.indexOf("sd-add-desktop");
    const phoneBtn = panel.indexOf("sd-add-phone");
    const requests = panel.indexOf(">New requests<");
    expect(desktopBtn).toBeGreaterThan(-1);
    expect(phoneBtn).toBeGreaterThan(desktopBtn);
    expect(requests).toBeGreaterThan(phoneBtn);
    expect(panel.slice(phoneBtn, requests)).not.toContain("sd-stats");
    expect(panel.slice(phoneBtn, requests)).not.toContain("Today's schedule");
    const css = dashCss(html);
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
    expect(css).toContain("background: #000000");
    expect(css).toContain("background: #ffffff");
    expect(css).toContain("rgba(0, 140, 255, 0.16)");
    expect(extractFunction(html, "noShowPillHtml")).toContain("sd-pill-rose");
    expect(extractFunction(html, "rosterApptChip")).toContain("sd-pill-rose");
    expect(extractFunction(html, "appointmentPayMarkup")).toContain("sd-pay-");
    expect(extractFunction(html, "renderRosterPayFilter")).toContain("rosterBrandPayClass");
    expect(html).toContain('colspan="8"');
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
    const desktopWeek = css.slice(css.indexOf("@media (min-width: 1024px)"));
    expect(desktopWeek).toContain("repeat(7, minmax(0, 1fr))");
    expect(desktopWeek).toContain("overflow-x: visible");
    expect(css).toContain("repeat(7, minmax(148px, 1fr))");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-hours-week-day .sd-time-input");
    expect(css).toContain("font-size: 11px");
    expect(extractFunction(html, "hoursWeekDayHtml")).toContain("Not applied while closed");
    expect(extractFunction(html, "hoursWeekDayHtml")).toContain("hoursWeekBlockHtml");
    const fromEnv = new Function(
      `${extractFunction(html, "hoursWeekLayoutFromEnv")}; return hoursWeekLayoutFromEnv;`,
    )() as (search: string, stored: string | null) => boolean;
    expect(fromEnv("", null)).toBe(false);
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
    expect(extractFunction(html, "hoursWeekDayHtml")).toContain("openAddBlockedTimeForDay");
    expect(extractFunction(html, "hoursWeekDayHtml")).toContain("copyHoursToOtherDays");
    expect(extractFunction(html, "copyHoursToOtherDays")).not.toContain("saveState");
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
    expect(css).toContain("#tenantPortalSection.schedi-newdash[data-dash=\"hours\"] #tenantHoursShiftBlock");
    expect(css).toContain("#tenantPortalSection.schedi-newdash[data-dash=\"profile\"] #tenantHoursShiftBlock { display: block !important; }");
    expect(css).not.toContain("#tenantHoursShiftBlock { display: none");
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
        const today = document.getElementById("schediStatToday");
        const review = document.getElementById("schediStatReview");
        return today?.textContent === "4" && review?.textContent === "3" && document.body.textContent?.includes("Maya Chen");
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
        let money = 0;
        tenant.appointments.forEach((app) => {
          const status = String(app.status || "").toLowerCase();
          if (status === "cancelled" || status === "canceled" || status === "denied") return;
          if (!app.date || app.date < start || app.date > end) return;
          if (app.amount == null || app.amount === ("" as unknown as number)) return;
          const amount = Number(app.amount);
          if (Number.isFinite(amount)) money += amount;
        });
        return {
          week: document.getElementById("schediStatWeek")?.textContent,
          weekExpected: "$" + money,
          unpaid: document.getElementById("schediStatUnpaid")?.textContent,
          setup: document.getElementById("schediSetupTitle")?.textContent,
          dash: document.body.classList.contains("schedi-newdash"),
          demo: document.getElementById("schediDemoNote")?.hidden === false,
        };
      });
      expect(stats.dash).toBe(true);
      expect(stats.demo).toBe(true);
      expect(stats.setup).toBe("Finish setting up 5 of 6");
      expect(stats.unpaid).toBe("7");
      expect(stats.week).toBe(stats.weekExpected);
      const accept = await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((node) => node.textContent === "Accept");
        if (!button) return "missing";
        (button as HTMLButtonElement).click();
        return document.getElementById("schediStatReview")?.textContent || "";
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
          review: document.getElementById("schediStatReview")?.textContent || "",
        };
      });
      expect(kept).toEqual({ hidden: true, review: "2" });
      const declined = await page.evaluate(() => {
        const button = [...document.querySelectorAll("#schediTodayRequests button")].find((node) => node.textContent === "Decline");
        (button as HTMLButtonElement).click();
        (document.getElementById("denyConfirmBtn") as HTMLButtonElement).click();
        return document.getElementById("schediStatReview")?.textContent || "";
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
        const unpaidBefore = document.getElementById("schediStatUnpaid")?.textContent || "";
        w.markAppointmentPaid("HB-1003");
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
          unpaid: document.getElementById("schediStatUnpaid")?.textContent || "",
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
      expect(Number(paidFlip.unpaid)).toBe(Number(paidFlip.unpaidBefore) - 1);
      expect(paidFlip.pill).toContain("In person / Cash");
      expect(paidFlip.pillClass).toContain("sd-pay-cash");
      expect(paidFlip.maya).toContain("Card (Stripe)");
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
      expect(profile.shown).toBe(7);
      expect(profile.block).toBe("block");
      const profileFields = await page.evaluate(() => ({
        dash: document.getElementById("tenantPortalSection")?.getAttribute("data-dash"),
        booking: getComputedStyle(document.getElementById("tenantProfileFields") as Element).display,
        timeOff: getComputedStyle(document.getElementById("tenantHoursTimeOff") as Element).display,
      }));
      expect(profileFields.dash).toBe("profile");
      expect(profileFields.booking).not.toBe("none");
      expect(profileFields.timeOff).toBe("none");
      await page.$eval("#hoursWeekLayoutBtn", (el) => (el as HTMLButtonElement).click());
      const profileDays = await visible(".sd-hours-day");
      expect(profileDays.shown).toBe(7);
      expect(profileDays.blockH).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 90000);
});
