import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { publicDuplicateRedirect } from "../worker/canonical";
import { shouldCountBookingVisit } from "../worker/page-visits";
import { hqLoginDocument } from "../worker/public-shell";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

function bookOn(search: string) {
  const start = html.indexOf("function schediNewBookOn");
  const end = html.indexOf("function bookingPaymentState");
  return runInNewContext(`${html.slice(start, end)}\nschediNewBookOn();`, {
    window: { location: { search } },
    URLSearchParams,
  }) as boolean;
}

function bookingClass(search: string, baked: boolean) {
  const start = html.indexOf("var SCHEDI_NEWBOOK = ");
  const end = html.indexOf("var PUBLIC_DEPOSIT_METHODS");
  let source = html.slice(start, end);
  source = source.replace("${schediNewBook ? 'true' : 'false'}", baked ? "true" : "false");
  source = source.replace("${(typeof window !== 'undefined' && window.__SCHEDI_DEMO) ? 'true' : 'false'}", "false");
  const classes = new Set<string>(baked ? ["schedi-newbook"] : []);
  runInNewContext(source, {
    location: { search },
    URLSearchParams,
    document: {
      documentElement: {
        classList: {
          toggle(name: string, on: boolean) {
            if (on) classes.add(name);
            else classes.delete(name);
          },
        },
      },
    },
  });
  return classes.has("schedi-newbook");
}

function loginFrame(search: string) {
  const doc = hqLoginDocument();
  const start = doc.indexOf("(function () {");
  const end = doc.indexOf("document.getElementById('hq-login')");
  const classes: string[] = [];
  runInNewContext(doc.slice(start, end), {
    location: { search },
    URLSearchParams,
    document: {
      documentElement: {
        classList: {
          add(name: string) { classes.push(name); },
          toggle(name: string, on: boolean) { if (on && !classes.includes(name)) classes.push(name); },
        },
      },
      head: { appendChild() {} },
      getElementById() { return { textContent: "", addEventListener() {} }; },
      createElement() { return {}; },
    },
    localStorage: { getItem() { return null; }, setItem() {} },
  });
  return classes;
}

function visit(search: string) {
  return shouldCountBookingVisit({
    method: "GET",
    hostname: "schedi.app",
    pathname: "/harbor-studio",
    searchParams: new URLSearchParams(search),
    userAgent: "Mozilla/5.0",
    referer: "",
    secFetchDest: "document",
    secFetchMode: "navigate",
    secPurpose: "",
  });
}

describe("booking page default", () => {
  it("renders the new design unless classicbook or newbook=0", () => {
    expect(bookOn("")).toBe(true);
    expect(bookOn("?newbook=1")).toBe(true);
    expect(bookOn("?newbook=true")).toBe(true);
    expect(bookOn("?classicbook=1")).toBe(false);
    expect(bookOn("?classicbook=true")).toBe(false);
    expect(bookOn("?newbook=0")).toBe(false);
    expect(bookOn("?newbook=1&classicbook=1")).toBe(false);
    expect(bookOn("?classicbook=0")).toBe(true);
  });

  it("lets the booking document honor the same hatch after it is generated", () => {
    expect(bookingClass("", true)).toBe(true);
    expect(bookingClass("?newbook=1", true)).toBe(true);
    expect(bookingClass("?classicbook=1", true)).toBe(false);
    expect(bookingClass("?newbook=0", true)).toBe(false);
    expect(bookingClass("?newbook=1", false)).toBe(true);
    expect(bookingClass("", false)).toBe(false);
  });

  it("keeps classicbook on a booking URL and still counts the visit only on schedi.app", () => {
    expect(publicDuplicateRedirect(new URL("https://schedi.app/bright-cuts?classicbook=1"))).toBeNull();
    expect(publicDuplicateRedirect(new URL("https://schedi.app/bright-cuts/?newbook=1"))).toBeNull();
    expect(publicDuplicateRedirect(new URL("https://www.schedi.app/harbor?classicbook=1"))).toBe("https://schedi.app/harbor?classicbook=1");
    expect(visit("")).toBe(true);
    expect(visit("classicbook=1")).toBe(true);
    expect(visit("newbook=1")).toBe(true);
    expect(shouldCountBookingVisit({
      method: "GET",
      hostname: "schedi-dashboard-preview.axl199.workers.dev",
      pathname: "/harbor-studio",
      searchParams: new URLSearchParams(),
      userAgent: "Mozilla/5.0",
      referer: "",
      secFetchDest: "document",
      secFetchMode: "navigate",
      secPurpose: "",
    })).toBe(false);
  });
});

describe("HQ frame default", () => {
  it("turns the sign-in theme on unless classichq", () => {
    expect(loginFrame("")).toEqual(["schedi-newhq"]);
    expect(loginFrame("?newhq=1")).toEqual(["schedi-newhq"]);
    expect(loginFrame("?classichq=1")).toEqual([]);
    expect(loginFrame("?newhq=1&classichq=1")).toEqual([]);
    expect(loginFrame("?newhq=0")).toEqual([]);
  });

  it("routes the old section links onto the dashboard tabs and leaves proposal cards out", () => {
    expect(hq).toContain("hqGlanceCard: 'overview'");
    expect(hq).toContain("agencyDirectory: 'directory'");
    expect(hq).toContain("agencyBilling: 'billing'");
    expect(hq).toContain("agencyEmail: 'email'");
    expect(hq).toContain("if (document.getElementById('hqDash')) return;");
    expect(hq).toContain("hqDashGo('directory')");
    expect(hq).not.toContain("Failed payments");
    expect(hq).not.toContain("Email activity");
    expect(hq).not.toContain("pending requests");
  });
});

describe.skipIf(!chrome)("booking page layout", () => {
  it("fits the default booking page at phone, tablet, and desktop widths in light and dark", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".css": "text/css; charset=utf-8",
      ".jpg": "image/jpeg",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full) || file.includes("..")) {
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
      const shell = await browser.newPage();
      shell.on("pageerror", (error) => errors.push("shell " + String(error)));
      await shell.goto(`http://127.0.0.1:${port}/?demo=1`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await shell.waitForFunction(() => document.title.includes("Harbor Studio") && typeof (window as unknown as { generateStandaloneHtmlForTenant?: unknown }).generateStandaloneHtmlForTenant === "function", { timeout: 20000 });
      const rendered = await shell.evaluate(() => {
        const tenant = (window as unknown as { schediBuildDemoTenant: () => { services: { name: string }[]; logoUrl: string } }).schediBuildDemoTenant();
        tenant.services = [
          { ...(tenant.services[1] as object), name: "Second saved", sortOrder: 1 },
          { ...(tenant.services[2] as object), name: "Third saved", sortOrder: 2 },
          { ...(tenant.services[0] as object), name: "First saved", sortOrder: 0 },
        ] as typeof tenant.services;
        return (window as unknown as { generateStandaloneHtmlForTenant: (row: unknown) => string }).generateStandaloneHtmlForTenant(tenant);
      });
      expect(rendered).toContain("schedi-newbook");
      expect(rendered).toContain("application/ld+json");
      expect(rendered).toContain("First saved");
      const page = await browser.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${port}/assets/tailwind.css`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.setContent(rendered, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => {
        const cal = document.getElementById("monthCalendarContainer");
        const pay = document.getElementById("paymentMethodsGrid");
        const text = pay?.textContent || "";
        return document.documentElement.classList.contains("schedi-newbook")
          && document.body.innerText.includes("First saved")
          && !!cal
          && getComputedStyle(cal).display === "grid"
          && text.includes("Pay at Appt")
          && text.includes("Cash App")
          && text.includes("Zelle");
      }, { timeout: 20000 });
      const order = await page.evaluate(() => Array.from(document.querySelectorAll("#serviceListContainer .font-bold")).map((el) => (el.textContent || "").trim()).filter((text) => text.includes("saved")));
      expect(order.slice(0, 3)).toEqual(["First saved", "Second saved", "Third saved"]);
      const payText = await page.evaluate(() => document.getElementById("paymentMethodsGrid")?.innerText || "");
      expect(payText).toContain("Venmo");
      expect(payText).not.toMatch(/Square/i);
      for (const width of [390, 768, 1024, 1280, 1920]) {
        await page.setViewport({ width, height: width < 800 ? 844 : 900 });
        for (const themeName of ["dark", "light"] as const) {
          await page.evaluate((light) => {
            document.documentElement.classList.toggle("schedi-light", light);
          }, themeName === "light");
          const box = await page.evaluate(() => {
            const root = document.documentElement;
            const nodes = Array.from(document.querySelectorAll("header, main, #pubSubmitBtn, #paymentMethodsGrid, .biz-logo, .biz-logo-initials, .pub-header-logo, .pub-header-initials, .cal-day")).filter((el) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
            const clipped = nodes.filter((el) => {
              const rect = el.getBoundingClientRect();
              return rect.left < -1 || rect.right > root.clientWidth + 1;
            }).map((el) => el.id || el.className);
            return {
              overflow: root.scrollWidth <= root.clientWidth + 1,
              clipped: clipped.slice(0, 6),
              newbook: document.documentElement.classList.contains("schedi-newbook"),
            };
          });
          expect(box.newbook, themeName + " " + width).toBe(true);
          expect(box.overflow, themeName + " " + width).toBe(true);
          expect(box.clipped, themeName + " " + width).toEqual([]);
        }
      }
      expect(errors).toEqual([]);

      const classicShell = await browser.newPage();
      classicShell.on("pageerror", (error) => errors.push("classic shell " + String(error)));
      await classicShell.goto(`http://127.0.0.1:${port}/?demo=1&classicbook=1`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await classicShell.waitForFunction(() => document.title.includes("Harbor Studio") && typeof (window as unknown as { generateStandaloneHtmlForTenant?: unknown }).generateStandaloneHtmlForTenant === "function", { timeout: 20000 });
      const classicHtml = await classicShell.evaluate(() => {
        const tenant = (window as unknown as { schediBuildDemoTenant: () => unknown }).schediBuildDemoTenant();
        return (window as unknown as { generateStandaloneHtmlForTenant: (row: unknown) => string }).generateStandaloneHtmlForTenant(tenant);
      });
      expect(classicHtml).not.toContain('class="dark schedi-newbook"');
      const classic = await browser.newPage();
      classic.on("pageerror", (error) => errors.push("classic " + String(error)));
      await classic.setViewport({ width: 390, height: 844 });
      await classic.goto(`http://127.0.0.1:${port}/assets/tailwind.css`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await classic.setContent(classicHtml, { waitUntil: "domcontentloaded", timeout: 45000 });
      const classicOn = await classic.evaluate(() => document.documentElement.classList.contains("schedi-newbook"));
      expect(classicOn).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }, 180000);
});
