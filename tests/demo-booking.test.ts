import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleRequest, type SchediEnv } from "../worker/handler";
import { MARKETING_PAGES } from "../worker/content";
import { renderMarketingPage } from "../worker/render";
import { DEMO_SCRIPT_PATH, DEMO_SIGNUP_HREF, renderDemoBookingScript } from "../worker/demo-booking";
import { signupAttributionRef } from "../workers/schedi-email-worker/src/signup-ref.js";

const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

const SHELL = "<!DOCTYPE html><html><head><title>Schedi</title></head><body>app</body></html>";

function ctx() {
  return { waitUntil() {} };
}

function env(): SchediEnv {
  return {
    FIREBASE_PROJECT_ID: "siteforge-97699",
    ASSETS: {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        if (path === "/index.html" || path === "/booking.html") {
          return new Response(SHELL, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
      },
    },
  };
}

type FakeEl = {
  id: string;
  innerHTML: string;
  attrs: Record<string, string>;
  parentNode: FakeEl | null;
  listeners: Record<string, (event: { target: FakeEl }) => void>;
  children: FakeEl[];
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, fn: (event: { target: FakeEl }) => void): void;
  querySelectorAll(selector: string): FakeEl[];
};

function element(id = ""): FakeEl {
  const el: FakeEl = {
    id,
    innerHTML: "",
    attrs: {},
    parentNode: null,
    listeners: {},
    children: [],
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
    removeAttribute(name: string) {
      delete this.attrs[name];
    },
    addEventListener(type: string, fn: (event: { target: FakeEl }) => void) {
      this.listeners[type] = fn;
    },
    querySelectorAll(selector: string) {
      const name = selector.replace(/[\[\]]/g, "");
      return this.children.filter((child) => child.getAttribute(name.split("=")[0]) != null);
    },
  };
  return el;
}

function click(panel: FakeEl, name: string, value: string) {
  const target = element();
  target.parentNode = panel;
  target.setAttribute(name, value);
  const listener = panel.listeners.click;
  if (!listener) throw new Error("demo panel has no click listener");
  listener({ target });
}

describe("sample booking demo", () => {
  it("puts a sample-booking call to action on the homepage", () => {
    const home = renderMarketingPage(MARKETING_PAGES.find((page) => page.path === "/")!);
    expect(home).toContain('href="/demo">See a sample booking page</a>');
    expect(home).toContain("Free plan, $0");
    expect(home).not.toContain(DEMO_SIGNUP_HREF);
  });

  it("serves /demo as a public sample and keeps signup attribution", async () => {
    const page = await handleRequest(new Request("https://schedi.app/demo"), env(), ctx());
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Try a sample booking page");
    expect(html).toContain("Fresh Cuts Studio");
    expect(html).toContain('id="demo-panel"');
    expect(html).toContain(`src="${DEMO_SCRIPT_PATH}"`);
    expect(html).toContain(`href="${DEMO_SIGNUP_HREF}"`);
    expect(html).toContain("Nothing you pick is booked.");
    expect(html).not.toContain("$29");
    expect(html).not.toContain("$49");

    const scriptRes = await handleRequest(new Request(`https://schedi.app${DEMO_SCRIPT_PATH}`), env(), ctx());
    expect(scriptRes.status).toBe(200);
    expect(scriptRes.headers.get("content-type")).toMatch(/javascript/);
    const script = await scriptRes.text();
    expect(script).toBe(renderDemoBookingScript());
    expect(script).toContain(DEMO_SIGNUP_HREF);
    expect(script).not.toContain("/api/bookings");
    expect(script).not.toContain("fetch(");

    const signup = await handleRequest(new Request(`https://schedi.app${DEMO_SIGNUP_HREF}`), env(), ctx());
    expect(signup.status).toBe(200);
    expect(signup.headers.get("location")).toBeNull();
  });

  it("walks service, time, and confirm without booking", () => {
    const root = element("demo-book");
    const panel = element("demo-panel");
    panel.parentNode = root;
    for (const step of ["service", "time", "confirm"]) {
      const item = element();
      item.setAttribute("data-step", step);
      item.parentNode = root;
      root.children.push(item);
    }
    const ids: Record<string, FakeEl> = { "demo-book": root, "demo-panel": panel };
    const document = {
      readyState: "complete",
      getElementById(id: string) {
        return ids[id] || null;
      },
      addEventListener() {},
    };
    // The script is a string built for the browser. Run that string, not a second copy of the flow.
    // eslint-disable-next-line no-new-func
    new Function("document", renderDemoBookingScript())(document);

    expect(panel.innerHTML).toContain("Classic cut");
    expect(panel.innerHTML).toContain("Beard trim");
    expect(panel.innerHTML).toContain("Cut and beard");
    expect(panel.innerHTML).not.toContain(DEMO_SIGNUP_HREF);

    click(panel, "data-service", "cut");
    expect(panel.innerHTML).toContain("2. Pick a day and time");
    const dates = [...panel.innerHTML.matchAll(/data-date="([^"]+)"/g)].map((match) => match[1]);
    expect(dates.length).toBeGreaterThan(0);
    for (const iso of dates) {
      const day = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))).getDay();
      expect(day === 0 || day === 1).toBe(false);
    }

    let picked = "";
    for (const iso of dates) {
      click(panel, "data-date", iso);
      const times = [...panel.innerHTML.matchAll(/data-time="([^"]+)"/g)].map((match) => match[1]);
      if (times.length) {
        picked = times[0];
        break;
      }
    }
    expect(picked).not.toBe("");
    click(panel, "data-time", picked);
    expect(panel.innerHTML).toContain("3. Confirm");
    expect(panel.innerHTML).toContain("This sample stops here. Nothing is booked.");
    expect(panel.innerHTML).toContain(`href="${DEMO_SIGNUP_HREF}"`);
    expect(panel.innerHTML).toContain("Create your booking page");
    expect(panel.innerHTML).toContain("Classic cut");
    expect(panel.innerHTML).toContain(picked);
    expect(root.children.find((item) => item.getAttribute("data-step") === "confirm")?.getAttribute("aria-current")).toBe("step");
  });

  it("keeps only a short signup ref", () => {
    expect(signupAttributionRef("demo")).toBe("demo");
    expect(signupAttributionRef(" Demo ")).toBe("demo");
    expect(signupAttributionRef("../demo")).toBe("");
    expect(signupAttributionRef("utm_source")).toBe("");
    expect(signupAttributionRef("spring-ad")).toBe("spring-ad");
    expect(signupAttributionRef("")).toBe("");
    expect(signupAttributionRef("demo demo")).toBe("");
  });
});

describe.skipIf(!chrome)("sample booking demo in the browser", () => {
  it("goes from the homepage to confirm, then to signup with ref=demo", async () => {
    const server = createServer(async (req, res) => {
      const response = await handleRequest(new Request(`https://schedi.app${req.url || "/"}`), env(), ctx());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (key === "strict-transport-security") return;
        headers[key] = value;
      });
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
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
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0", timeout: 20000 });
      await page.click('a[href="/demo"]');
      await page.waitForSelector("#demo-panel button[data-service='cut']", { timeout: 5000 });
      expect(page.url()).toContain("/demo");
      expect(await page.$eval("h1", (el) => el.textContent)).toBe("Try a sample booking page");
      await page.click("button[data-service='cut']");
      await page.waitForSelector("[data-date]", { timeout: 5000 });
      const dates = await page.$$eval("[data-date]", (els) => els.map((el) => el.getAttribute("data-date") || ""));
      let picked = false;
      for (const iso of dates) {
        await page.click(`[data-date="${iso}"]`);
        const count = await page.$$eval("[data-time]", (els) => els.length);
        if (count > 0) {
          await page.click("[data-time]");
          picked = true;
          break;
        }
      }
      expect(picked).toBe(true);
      await page.waitForSelector(`a[href="${DEMO_SIGNUP_HREF}"]`, { timeout: 5000 });
      const gate = await page.$eval("#demo-panel", (el) => el.textContent || "");
      expect(gate).toContain("This sample stops here. Nothing is booked.");
      expect(gate).toContain("Classic cut");
      const href = await page.$eval(`#demo-panel a[href="${DEMO_SIGNUP_HREF}"]`, (el) => el.getAttribute("href"));
      expect(href).toBe(DEMO_SIGNUP_HREF);
      await page.click(`#demo-panel a[href="${DEMO_SIGNUP_HREF}"]`);
      await page.waitForFunction(() => location.pathname === "/signup", { timeout: 5000 });
      const landed = new URL(page.url());
      expect(landed.pathname).toBe("/signup");
      expect(landed.searchParams.get("ref")).toBe("demo");
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
