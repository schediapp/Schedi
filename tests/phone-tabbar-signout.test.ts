import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

function startServer() {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".css": "text/css; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const file = path === "/" || path === "/portal-preview" || path === "/login" ? "/index.html" : path;
    let full = join(root, file);
    if ((!existsSync(full) || !full.startsWith(root)) && file.startsWith("/assets/")) {
      full = join(root, "site", file);
    }
    if (!full.startsWith(root) || !existsSync(full) || file.includes("..")) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
    res.end(readFileSync(full));
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        close: () => new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

describe("phone tab bar does not sign out", () => {
  it("keeps Sign out off the tab buttons and serves compiled Tailwind", () => {
    const nav = html.slice(html.indexOf('id="schediDashTabbar"'), html.indexOf('id="schediDashAccountMenu"'));
    expect(nav).not.toContain("handleTenantLogout");
    expect(html).toContain('onclick="schediDashClosePopovers(); handleTenantLogout()"');
    expect(html).toContain('class="sd-danger" onclick="handleTenantLogout()"');
    expect(html).toContain("if (node.closest('#schediDashTabbar'))");
    expect(html).toContain("bottom: calc(68px + env(safe-area-inset-bottom, 0px));");
    expect(html).toContain("z-index: 75;");
    expect(html).toContain('href="/assets/tailwind.css"');
    expect(html).not.toContain("cdn.tailwindcss.com");
    expect(readFileSync(new URL("../site/booking.html", import.meta.url), "utf8")).not.toContain("cdn.tailwindcss.com");
    expect(readFileSync(new URL("../site/hq.html", import.meta.url), "utf8")).not.toContain("cdn.tailwindcss.com");
    expect(existsSync(join(root, "site/assets/tailwind.css"))).toBe(true);
  });
});

describe.skipIf(!chrome)("phone tab bar hit testing", () => {
  it("navigates from Agenda, Clients, Calendar, Add, and More, and signs out only from Sign out", async () => {
    const server = await startServer();
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await page.goto(`http://127.0.0.1:${server.port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.querySelector('#schediDashTabbar button[data-dash-go="today"]'), { timeout: 20000 });
      const top = await page.evaluate(() => {
        const selectors = ["#schediDashTop .sd-text-btn", "#schediDashTop .sd-theme-opt", "#schediDashUserBtnPhone"];
        return selectors.map((selector) => {
          const el = document.querySelector(selector) as HTMLElement;
          const rect = el.getBoundingClientRect();
          return { selector, x: rect.x, right: rect.right, width: rect.width, height: rect.height };
        });
      });
      expect(top[0].right + 6).toBeLessThanOrEqual(top[1].x);
      expect(top[1].right + 6).toBeLessThanOrEqual(top[2].x);
      expect(top[2].right).toBeLessThanOrEqual(382);
      for (const box of top) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(390);
        expect(box.height).toBeGreaterThanOrEqual(40);
      }
      await page.evaluate(() => {
        const win = window as unknown as { handleTenantLogout: (...args: unknown[]) => void; __logoutCalls: number };
        win.__logoutCalls = 0;
        const orig = win.handleTenantLogout;
        win.handleTenantLogout = function () {
          win.__logoutCalls += 1;
          return orig.apply(this, arguments);
        };
      });

      const tabs = [
        '#schediDashTabbar button[data-dash-go="today"]',
        '#schediDashTabbar button[data-dash-go="clients"]',
        '#schediDashTabbar button[data-dash-go="appointments"]',
        "#schediDashTabbar .sd-fab",
        "#schediDashMoreBtn",
      ];
      for (const selector of tabs) {
        await page.click(selector);
        const calls = await page.evaluate(() => (window as unknown as { __logoutCalls: number }).__logoutCalls);
        expect(calls, selector).toBe(0);
      }

      await page.evaluate(() => {
        const sheet = document.getElementById("schediDashMoreSheet");
        if (sheet) sheet.hidden = false;
      });
      const covered = await page.evaluate(() => {
        const tabbar = document.getElementById("schediDashTabbar") as HTMLElement;
        const sign = document.querySelector("#schediDashMoreSheet .sd-danger") as HTMLElement;
        const buttons = Array.from(tabbar.querySelectorAll("button"));
        const hits = buttons.map((btn) => {
          const rect = btn.getBoundingClientRect();
          const el = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          const owner = el && el.closest ? el.closest("button") : null;
          return {
            label: (btn.textContent || btn.getAttribute("aria-label") || "").trim().slice(0, 24),
            hit: owner ? (owner.textContent || owner.getAttribute("aria-label") || owner.id || "").trim().slice(0, 24) : "",
            same: owner === btn,
          };
        });
        const signRect = sign.getBoundingClientRect();
        const tabRect = tabbar.getBoundingClientRect();
        const overlap = signRect.bottom > tabRect.top + 1 && signRect.top < tabRect.bottom - 1 && signRect.right > tabRect.left && signRect.left < tabRect.right;
        return { hits, overlap, signTop: Math.round(signRect.top), tabTop: Math.round(tabRect.top) };
      });
      expect(covered.overlap, JSON.stringify(covered)).toBe(false);
      for (const hit of covered.hits) expect(hit.same, JSON.stringify(hit)).toBe(true);

      for (const selector of tabs) {
        await page.click(selector);
        const calls = await page.evaluate(() => (window as unknown as { __logoutCalls: number }).__logoutCalls);
        expect(calls, "open sheet " + selector).toBe(0);
      }

      await page.evaluate(() => {
        const sheet = document.getElementById("schediDashMoreSheet");
        if (sheet) sheet.hidden = false;
      });
      await page.click("#schediDashMoreSheet .sd-danger");
      const afterSheet = await page.evaluate(() => ({
        calls: (window as unknown as { __logoutCalls: number }).__logoutCalls,
        toast: document.getElementById("toastContainer")?.textContent || "",
      }));
      expect(afterSheet.calls).toBe(1);
      expect(afterSheet.toast).toContain("Demo mode does not sign out");

      await page.click("#schediDashUserBtnPhone");
      const accountClear = await page.evaluate(() => {
        const menu = document.getElementById("schediDashAccountMenu") as HTMLElement;
        const sign = menu.querySelector(".sd-danger") as HTMLElement;
        const tab = document.getElementById("schediDashTabbar") as HTMLElement;
        const signRect = sign.getBoundingClientRect();
        const tabRect = tab.getBoundingClientRect();
        return signRect.bottom <= tabRect.top + 1;
      });
      expect(accountClear).toBe(true);
      await page.click("#schediDashAccountMenu .sd-danger");
      const afterAccount = await page.evaluate(() => (window as unknown as { __logoutCalls: number }).__logoutCalls);
      expect(afterAccount).toBe(2);

      await page.evaluate(() => {
        (window as unknown as { __SCHEDI_DEMO?: boolean }).__SCHEDI_DEMO = false;
        const sheet = document.getElementById("schediDashMoreSheet");
        if (sheet) sheet.hidden = false;
      });
      const destination = page.waitForRequest((request) => request.isNavigationRequest() && request.url().includes("/login"), { timeout: 8000 });
      await page.click("#schediDashMoreSheet .sd-danger");
      expect((await destination).url()).toContain("/login");
    } finally {
      await browser.close();
      await server.close();
    }
  });
});
