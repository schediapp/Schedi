import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;
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
    const file = path === "/" || path === "/portal-preview" || path === "/login" || path === "/portal/help" ? "/index.html" : path;
    let full = join(root, file);
    if ((!existsSync(full) || !full.startsWith(root)) && file.startsWith("/assets/")) full = join(root, "site", file);
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

async function backHrefs(page: { evaluate: (fn: () => string[]) => Promise<string[]> }) {
  return page.evaluate(() => Array.from(document.querySelectorAll("#legalSection a")).filter((el) => (el.textContent || "").trim() === "Back to portal").map((el) => el.getAttribute("href") || ""));
}

describe.skipIf(!chrome)("owner help back to portal", () => {
  it("returns a signed-in owner to the dashboard section and everyone else to /login", async () => {
    const server = await startServer();
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      const origin = `http://127.0.0.1:${server.port}`;
      await page.goto(origin + "/portal/help?dash=billing", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.evaluate(() => {
        localStorage.setItem("schedi.authSession", "owner-session");
        localStorage.setItem("schedi.authMeta", JSON.stringify({ role: "owner", tenantId: "harbor-demo", email: "owner@example.com" }));
      });
      await page.goto(origin + "/portal/help?dash=billing", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => (document.getElementById("legalSection")?.textContent || "").includes("Back to portal"), { timeout: 20000 });
      const signedIn = await backHrefs(page);
      expect(signedIn.length).toBeGreaterThanOrEqual(2);
      for (const href of signedIn) expect(href).toBe("/login?dash=billing");

      await page.click("#legalSection a");
      await page.waitForFunction(() => location.pathname === "/login" && new URLSearchParams(location.search).get("dash") === "billing", { timeout: 20000 });
      const portal = await page.evaluate(() => ({
        path: location.pathname,
        dash: new URLSearchParams(location.search).get("dash"),
        loginHidden: document.getElementById("tenantLoginBox")?.classList.contains("hidden") === true,
        dashShown: document.getElementById("tenantDashboard")?.classList.contains("hidden") === false,
      }));
      expect(portal).toEqual({ path: "/login", dash: "billing", loginHidden: true, dashShown: true });

      await page.evaluate(() => {
        localStorage.removeItem("schedi.authSession");
        localStorage.removeItem("schedi.authMeta");
      });
      await page.goto(origin + "/portal/help?dash=billing", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => (document.getElementById("legalSection")?.textContent || "").includes("Back to portal"), { timeout: 20000 });
      const signedOut = await backHrefs(page);
      expect(signedOut.length).toBeGreaterThanOrEqual(2);
      for (const href of signedOut) expect(href).toBe("/login");
      await page.click("#legalSection a");
      await page.waitForFunction(() => location.pathname === "/login" && !new URLSearchParams(location.search).get("dash"), { timeout: 20000 });
      const login = await page.evaluate(() => ({
        path: location.pathname + location.search,
        loginHidden: document.getElementById("tenantLoginBox")?.classList.contains("hidden") === true,
      }));
      expect(login).toEqual({ path: "/login", loginHidden: false });

      await page.goto(origin + "/portal/help?demo=1&portal=preview&dash=hours&biz=harbor-demo", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => (document.getElementById("legalSection")?.textContent || "").includes("Back to portal"), { timeout: 20000 });
      const preview = await backHrefs(page);
      expect(preview.length).toBeGreaterThanOrEqual(2);
      for (const href of preview) {
        expect(href.startsWith("/portal-preview?")).toBe(true);
        expect(href).toContain("dash=hours");
        expect(href).toContain("demo=1");
      }
    } finally {
      await browser.close();
      await server.close();
    }
  }, 120000);
});
