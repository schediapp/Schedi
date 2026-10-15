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
const BOOKING_TEMPLATE_SHA = "ea64ee5447deb41250a67112608b13fcd787e6a8fcd840d947c7c4bb6d76cd76";
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
  it("leaves the public booking page HTML and CSS unchanged", () => {
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
    expect(fn({ paymentStatus: "PENDING VENMO" })).toBe("unpaid");
    expect(fn("")).toBe("unpaid");
  });

  it("serves the preview shell and keeps production opt-in", async () => {
    const preview = await handleRequest(new Request("https://schedi.app/portal-preview"), env(), ctx());
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain("<title>Schedi</title>");
    expect(preview.headers.get("x-robots-tag")).toContain("noindex");

    for (const path of ["/?demo=1", "/?newdash=1"]) {
      const response = await handleRequest(new Request("https://schedi.app" + path), env(), ctx());
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain("<body>app</body>");
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
        return today?.textContent === "4" && review?.textContent === "2" && document.body.textContent?.includes("Maya Chen");
      }, { timeout: 20000 });
      const stats = await page.evaluate(() => ({
        week: document.getElementById("schediStatWeek")?.textContent,
        unpaid: document.getElementById("schediStatUnpaid")?.textContent,
        setup: document.getElementById("schediSetupTitle")?.textContent,
        dash: document.body.classList.contains("schedi-newdash"),
        demo: document.getElementById("schediDemoNote")?.hidden === false,
      }));
      expect(stats).toEqual({ week: "$478", unpaid: "3", setup: "Finish setting up 4 of 5", dash: true, demo: true });
      const accept = await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((node) => node.textContent === "Accept");
        if (!button) return "missing";
        (button as HTMLButtonElement).click();
        return document.getElementById("schediStatReview")?.textContent || "";
      });
      expect(accept).toBe("1");
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
});
