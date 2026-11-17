import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

function between(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error("missing " + startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error("missing end after " + startMarker);
  return source.slice(start, end + endMarker.length);
}

const panel = between(html, 'id="tenantAddHomeScreenHelp"', "</div>");
const help = between(html, 'id="add-to-home-screen"', "</section>");
const install = between(html, "window.addTenantPortalToHomeScreen = function () {", "function renderTenantAdminPortal");

describe("Add to Home Screen instructions", () => {
  it("shows numbered Safari steps under More & settings", () => {
    expect(panel.startsWith('id="tenantAddHomeScreenHelp" class="hidden ')).toBe(true);
    expect(panel).toContain('role="region"');
    expect(panel).toContain("iPhone, in Safari");
    expect(panel).toContain("Use Safari. This does not work inside Instagram, Gmail, or another app.");
    expect(panel).toContain("<strong class=\"text-slate-200\">Open in Safari</strong>");
    expect(panel).toContain('class="list-decimal pl-5 space-y-1 text-slate-200"');
    expect(panel.match(/<li>/g)).toHaveLength(3);
    expect(panel).toContain("fa-solid fa-arrow-up-from-bracket");
    expect(panel).toContain('aria-hidden="true"');
    expect(panel).toContain("(the square with an up arrow) at the bottom of Safari.");
    expect(panel).toContain("On newer iOS it may be under the <strong>...</strong> menu.");
    expect(panel).toContain("Scroll down and tap <strong>Add to Home Screen</strong>.");
    expect(panel).toContain("Rename it if you want, then tap <strong>Add</strong>.");
    expect(panel).toContain("Android:</span> browser menu, then Add to Home screen.");
    expect(panel).not.toContain("iPhone: Share, then Add to Home Screen.");
  });

  it("uses the same steps on the owner help page", () => {
    expect(help).toContain("Add to Home Screen on iPhone");
    expect(help).toContain("Use Safari. This does not work inside Instagram, Gmail, or another app.");
    expect(help).toContain("<strong>Open in Safari</strong>");
    expect(help).toContain("fa-solid fa-arrow-up-from-bracket");
    expect(help).toContain("(the square with an up arrow) at the bottom of Safari.");
    expect(help).toContain("On newer iOS it may be under the <strong>...</strong> menu.");
    expect(help).toContain("Scroll down and tap <strong>Add to Home Screen</strong>.");
    expect(help).toContain("Rename it if you want, then tap <strong>Add</strong>.");
    expect(help).toContain("Android: browser menu, then Add to Home screen.");
    expect(help.match(/<li>/g)).toHaveLength(3);
  });

  it("keeps the Android install prompt and desktop guard", () => {
    expect(install).toContain("if (!schediIsMobileHomeScreenTarget())");
    expect(install).toContain("help.classList.add('hidden')");
    expect(install).toContain("showToast('Available on phones', 'info')");
    expect(install).toContain("if (deferredPortalInstallPrompt)");
    expect(install).toContain("promptEvent.prompt()");
    expect(install).toContain("Could not open the install prompt. Use your browser menu to Add to Home Screen.");
    expect(install).toContain("help.classList.remove('hidden')");
    expect(install).not.toContain("location.assign");
    expect(install).not.toContain("location.href");
  });
});

function startServer() {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".css": "text/css; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const file = path === "/" || path === "/portal-preview" || path === "/portal/help" ? "/index.html" : path;
    const full = join(root, file);
    if (!full.startsWith(root) || !existsSync(full)) {
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

describe.skipIf(!chrome)("Add to Home Screen on an iPhone-sized screen", () => {
  it("reveals the Safari steps from More & settings and leaves the page URL alone", async () => {
    const server = await startServer();
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      // Safari on iPhone has no userAgentData. Chrome's client hint would otherwise mark this page as desktop.
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "userAgentData", { configurable: true, get: () => undefined });
      });
      await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1");
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      await page.goto(`http://127.0.0.1:${server.port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.textContent?.includes("Maya Chen"), { timeout: 20000 });
      await page.evaluate(() => (window as unknown as { schediDashGo: (page: string) => void }).schediDashGo("account"));
      const button = await page.waitForSelector("#tenantAddHomeScreenBtn:not(.hidden)", { timeout: 5000 });
      expect(button).toBeTruthy();
      const hiddenBefore = await page.$eval("#tenantAddHomeScreenHelp", (el) => el.classList.contains("hidden"));
      expect(hiddenBefore).toBe(true);
      await page.click("#tenantAddHomeScreenBtn");
      const steps = await page.$eval("#tenantAddHomeScreenHelp", (el) => ({
        hidden: el.classList.contains("hidden"),
        text: el.textContent || "",
        items: el.querySelectorAll("ol li").length,
        icon: !!el.querySelector(".fa-arrow-up-from-bracket"),
      }));
      expect(steps.hidden).toBe(false);
      expect(steps.items).toBe(3);
      expect(steps.icon).toBe(true);
      expect(steps.text).toContain("Use Safari.");
      expect(steps.text).toContain("Open in Safari");
      expect(steps.text).toContain("Add to Home Screen");
      expect(steps.text).toContain("Android: browser menu, then Add to Home screen.");
      expect(page.url()).toContain("/portal-preview");
      expect(page.url()).not.toContain("portal=login");

      await page.evaluate(() => (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme("light"));
      const light = await page.$eval("#tenantAddHomeScreenHelp", (el) => getComputedStyle(el).color);
      expect(light).not.toBe("rgb(255, 255, 255)");

      await page.goto(`http://127.0.0.1:${server.port}/portal/help`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector("#add-to-home-screen", { timeout: 10000 });
      const written = await page.$eval("#add-to-home-screen", (el) => el.textContent || "");
      expect(written).toContain("Add to Home Screen on iPhone");
      expect(written).toContain("Open in Safari");
      expect(written).toContain("Android: browser menu, then Add to Home screen.");
    } finally {
      await browser.close();
      await server.close();
    }
  }, 60000);
});
