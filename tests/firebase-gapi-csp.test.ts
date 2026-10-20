import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fillBookingDocument } from "../worker/booking-document";
import { contentSecurityPolicy } from "../worker/handler";

const root = new URL("..", import.meta.url).pathname;
const bookingHtml = readFileSync(new URL("../site/booking.html", import.meta.url), "utf8");
const chrome = ["/usr/bin/google-chrome", "/usr/local/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

const hours = {
  Mon: { open: true, start: "09:00 AM", end: "05:00 PM" },
  Tue: { open: true, start: "09:00 AM", end: "05:00 PM" },
  Wed: { open: true, start: "09:00 AM", end: "05:00 PM" },
  Thu: { open: true, start: "09:00 AM", end: "05:00 PM" },
  Fri: { open: true, start: "09:00 AM", end: "05:00 PM" },
  Sat: { open: true, start: "10:00 AM", end: "02:00 PM" },
  Sun: { open: false, start: "10:00 AM", end: "02:00 PM" },
};

function bookingPage(): string {
  return fillBookingDocument(bookingHtml, {
    slug: "bright-cuts",
    fields: {
      id: "bright-cuts",
      name: "Bright Cuts",
      slug: "bright-cuts",
      industry: "Barber",
      timezone: "America/New_York",
      services: [{ id: 1, name: "Cut & style", duration: "45 mins", durationMins: 45, price: 65, icon: "fa-scissors" }],
      operatingHours: hours,
      subscriptionStatus: "active",
      acceptingBookings: true,
    },
  });
}

describe("firebase auth gapi", () => {
  it("does not call getAuth on the booking page or the dashboards", () => {
    const owner = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
    for (const source of [bookingHtml, owner, hq]) {
      expect(source).not.toMatch(/\bgetAuth\s*\(/);
      expect(source).toContain("initializeAuth(app,");
      expect(source).not.toContain("popupRedirectResolver");
    }
    const policy = contentSecurityPolicy(true);
    expect(policy).not.toContain("apis.google.com");
    expect(policy).not.toContain("firebaseapp.com");
  });
});

describe.skipIf(!chrome)("firebase auth gapi console", () => {
  it("does not log a CSP error for apis.google.com at 390px", async () => {
    const policy = contentSecurityPolicy(true);
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
      ".css": "text/css; charset=utf-8",
    };
    const filled = bookingPage();
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      if (path === "/bright-cuts") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": policy,
        });
        res.end(filled);
        return;
      }
      const file = path === "/login" ? "/index.html" : path === "/hq.html" ? "/site/hq.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full) || !extname(full)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      const headers: Record<string, string> = {
        "content-type": types[extname(full)] || "application/octet-stream",
      };
      if (extname(full) === ".html") headers["content-security-policy"] = policy;
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
      const phone = puppeteer.KnownDevices["iPhone 12"];
      expect(phone.viewport.width).toBe(390);
      for (const path of ["/bright-cuts", "/login", "/hq.html"]) {
        const page = await browser.newPage();
        const consoleErrors: string[] = [];
        const requests: string[] = [];
        page.on("console", (msg) => {
          const text = msg.text();
          if (msg.type() === "error" || /content security policy/i.test(text)) consoleErrors.push(text);
        });
        page.on("request", (request) => requests.push(request.url()));
        await page.emulate(phone);
        await page.evaluateOnNewDocument(() => {
          const bag = window as unknown as { __schediCsp: string[]; __schediDbReady: boolean };
          bag.__schediCsp = [];
          bag.__schediDbReady = false;
          document.addEventListener("securitypolicyviolation", (event) => {
            bag.__schediCsp.push(`${event.blockedURI} ${event.violatedDirective}`);
          });
          window.addEventListener("db_ready", () => {
            bag.__schediDbReady = true;
          });
        });
        await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForFunction(() => (window as unknown as { __schediDbReady?: boolean }).__schediDbReady === true, { timeout: 30000 });
        const seen = await page.evaluate(() => {
          const bag = window as unknown as { __schediCsp: string[] };
          return {
            ua: navigator.userAgent,
            width: window.innerWidth,
            violations: bag.__schediCsp,
          };
        });
        const gapiConsole = consoleErrors.filter((text) => /apis\.google\.com/i.test(text));
        const gapiViolations = seen.violations.filter((text) => /apis\.google\.com/i.test(text));
        const gapiRequests = requests.filter((url) => url.includes("apis.google.com/js/api.js"));
        expect(seen.ua, path).toMatch(/iPhone/i);
        expect(seen.width, path).toBe(390);
        expect(requests.some((url) => url.includes("/firebasejs/11.6.1/firebase-auth.js")), path).toBe(true);
        expect({ path, console: gapiConsole, violations: gapiViolations, requests: gapiRequests }).toEqual({
          path,
          console: [],
          violations: [],
          requests: [],
        });
        await page.close();
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }, 120000);
});
