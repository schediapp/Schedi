import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;
const chrome = ["/usr/bin/google-chrome", "/usr/local/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

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

function helpApi() {
  const start = html.indexOf("var SCHEDI_HELP_VIDEOS");
  const end = html.indexOf("// Only one help video plays");
  const sandbox: {
    owner?: string;
    client?: string;
    guide?: { slug: string; file: string; poster: string; title: string; kind: string; aud: string };
    card?: string;
    filled?: string;
    groups?: [string, string[]][];
  } = {};
  runInNewContext(`${html.slice(start, end)}
    function esc(v) {
      return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }
    this.owner = schediHelpVideosHtml("owner");
    this.client = schediHelpVideosHtml("client");
    this.guide = SCHEDI_HELP_VIDEOS.filter(function (v) { return v.slug === "owner-20-booking-alerts-iphone"; })[0];
    this.card = schediHelpGuideCard(this.guide);
    this.filled = schediHelpGuideCard(Object.assign({}, this.guide, { file: "owner-20-booking-alerts-iphone.mp4", poster: "owner-20-booking-alerts-iphone.jpg" }));
    this.groups = SCHEDI_HELP_VIDEO_GROUPS;
  `, sandbox);
  return sandbox;
}

describe("Booking alerts on iPhone help guide", () => {
  const help = helpApi();

  it("sits in the owner video list with an empty video slot", () => {
    expect(help.guide).toMatchObject({
      slug: "owner-20-booking-alerts-iphone",
      file: "",
      poster: "",
      title: "Booking alerts on iPhone",
      kind: "guide",
      aud: "owner",
    });
    const group = help.groups?.find((entry) => entry[1].includes("owner-20-booking-alerts-iphone"));
    expect(group?.[0]).toBe("Emails and Pro features");
    expect(help.owner).toContain('id="owner-20-booking-alerts-iphone"');
    expect(help.owner).toContain('class="schedi-help-guide');
    expect(help.card).toContain('data-video-slug="owner-20-booking-alerts-iphone"');
    expect(help.card).toContain("hidden");
    expect(help.card).not.toContain("<video");
    expect(help.filled).toContain("<video");
    expect(help.filled).toContain('src="/assets/help-videos/owner-20-booking-alerts-iphone.mp4"');
    expect(help.filled).toContain('data-video-slug="owner-20-booking-alerts-iphone"');
    expect(help.client).not.toContain("Booking alerts on iPhone");
  });

  it("covers the iPhone steps, troubleshooting, and short Android and desktop notes", () => {
    const card = help.card || "";
    expect(card).toContain("Requires iOS 16.4 or later.");
    expect(card).toContain("https://schedi.app/login");
    expect(card).toContain("Tap Share, then Add to Home Screen.");
    expect(card).toContain("Open Schedi from the Home Screen icon and sign in.");
    expect(card).toContain("Tap the bell, or go to Emails &gt; Booking alerts, and turn on the switch.");
    expect(card).toContain("Tap Allow on the iOS prompt.");
    expect(card).toContain("To test it, tap Send test alert.");
    expect(card).toContain("If alerts are blocked: Settings &gt; Notifications &gt; Schedi &gt; Allow.");
    expect(card).toContain("Focus / Do Not Disturb can hide alerts.");
    expect(card).toContain("Alerts only arrive in the Home Screen app, not in Safari tabs.");
    expect(card).toContain("Re-adding to the Home Screen means re-enabling alerts.");
    expect(card).toContain(">Android<");
    expect(card).toContain("Open Schedi in Chrome.");
    expect(card).toContain(">Desktop<");
    expect(card).toContain("Use Chrome, Edge, Firefox, or Safari.");
    expect(extractFunction(html, "showHelpPage")).toContain('href="#owner-20-booking-alerts-iphone"');
  });

  it("links the guide from the bell and the Booking alerts help text", () => {
    const cardStart = html.indexOf('id="webPushCard"');
    const card = html.slice(cardStart, html.indexOf("Email Booking Confirmations", cardStart));
    expect(card).toContain('id="webPushHint"');
    expect(card).toContain('id="webPushIphoneHelpLink"');
    expect(card.indexOf('id="webPushHint"')).toBeLessThan(card.indexOf('id="webPushIphoneHelpLink"'));
    expect(card).toContain("How to turn on alerts on iPhone");
    expect(card).toContain('href="/portal/help#owner-20-booking-alerts-iphone"');
    expect(card).toContain("ownerBookingAlertsHelpHref()");
    const pushStart = html.indexOf("Schedi owner booking alerts");
    const push = html.slice(pushStart, html.indexOf("window.schediWebPushToggle", pushStart));
    expect(push).toContain("webPushIphoneHelpLink");
    expect(push).toContain("is-strong");
    expect(push).toContain("st === 'ios-install' || st === 'blocked' || st === 'unsupported'");
    expect(push).toContain("ownerBookingAlertsHelpHref");
    expect(push.indexOf("helpLink")).toBeGreaterThan(push.indexOf("schediOpenBookingAlerts"));
    const href = new Function(`${extractFunction(html, "ownerBookingAlertsHelpHrefFrom")}; return ownerBookingAlertsHelpHrefFrom;`)() as (value: string) => string;
    expect(href("/portal/help?demo=1&portal=preview&dash=emails")).toBe("/portal/help?demo=1&portal=preview&dash=emails#owner-20-booking-alerts-iphone");
    expect(href("")).toBe("/portal/help#owner-20-booking-alerts-iphone");
    expect(html).toContain(".wp-iphone-help");
    expect(html).toContain("html.schedi-light .wp-iphone-help");
    expect(html).toContain("#webPushHint.is-strong .wp-iphone-help");
  });
});

function startServer() {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const file = path === "/" || path === "/portal-preview" || path === "/help" || path === "/portal/help" ? "/index.html" : path;
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
        close: () => new Promise((done, reject) => server.close((error) => error ? reject(error) : done())),
      });
    });
  });
}

describe.skipIf(!chrome)("Booking alerts on iPhone help layout", () => {
  it("keeps the guide and the alerts link inside 390, 1280, and 1920 in light and dark", async () => {
    const server = await startServer();
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
      const setTheme = async (mode: "light" | "dark") => {
        await page.evaluate((want) => {
          (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(want);
        }, mode);
      };
      const overflow = () => page.evaluate(() => {
        const guide = document.getElementById("owner-20-booking-alerts-iphone");
        const link = document.getElementById("webPushIphoneHelpLink");
        const card = document.getElementById("webPushCard");
        const helpCard = document.querySelector("#schediDashHelp .sd-help-card");
        const box = (el: Element | null) => {
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {
            scroll: (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth,
            left: rect.left,
            right: rect.right,
            width: rect.width,
          };
        };
        return {
          doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          body: document.body.scrollWidth - document.body.clientWidth,
          guide: box(guide),
          link: link ? { text: link.textContent || "", href: link.getAttribute("href") || "" } : null,
          card: box(card),
          helpCard: box(helpCard),
          width: window.innerWidth,
        };
      });

      for (const width of [390, 1280, 1920]) {
        await page.setViewport({ width, height: 900 });
        for (const mode of ["dark", "light"] as const) {
          await page.goto(`http://127.0.0.1:${server.port}/portal/help#owner-20-booking-alerts-iphone`, { waitUntil: "domcontentloaded", timeout: 45000 });
          await page.waitForSelector("#owner-20-booking-alerts-iphone", { timeout: 20000 });
          await setTheme(mode);
          const helpPage = await overflow();
          const label = `help ${width} ${mode}`;
          expect(helpPage.guide, label).toBeTruthy();
          expect(helpPage.doc, label).toBeLessThanOrEqual(1);
          expect(helpPage.body, label).toBeLessThanOrEqual(1);
          expect(helpPage.guide!.scroll, label).toBeLessThanOrEqual(1);
          expect(helpPage.guide!.left, label).toBeGreaterThanOrEqual(-1);
          expect(helpPage.guide!.right, label).toBeLessThanOrEqual(helpPage.width + 1);
          expect(helpPage.guide!.width, label).toBeGreaterThan(120);
        }
      }

      await page.goto(`http://127.0.0.1:${server.port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      for (const width of [390, 1280, 1920]) {
        await page.setViewport({ width, height: 900 });
        for (const mode of ["dark", "light"] as const) {
          await setTheme(mode);
          await page.evaluate(() => {
            (window as unknown as { schediDashGo: (page: string) => void }).schediDashGo("appointments");
            const button = document.getElementById("rosterAlertsBtn");
            if (button) button.style.display = "inline-flex";
            button?.scrollIntoView({ block: "center" });
          });
          await page.click("#rosterAlertsBtn");
          await page.waitForFunction(() => {
            const card = document.getElementById("webPushCard");
            return document.getElementById("tenantPortalSection")?.getAttribute("data-dash") === "emails"
              && !!card
              && !card.classList.contains("hidden");
          }, { timeout: 5000 });
          const alerts = await overflow();
          const label = `alerts ${width} ${mode}`;
          expect(alerts.link?.text, label).toBe("How to turn on alerts on iPhone");
          expect(alerts.link?.href, label).toContain("#owner-20-booking-alerts-iphone");
          expect(alerts.doc, label).toBeLessThanOrEqual(1);
          expect(alerts.body, label).toBeLessThanOrEqual(1);
          expect(alerts.card!.scroll, label).toBeLessThanOrEqual(1);
          expect(alerts.card!.right, label).toBeLessThanOrEqual(alerts.width + 1);
          const hint = await page.$eval("#webPushHint", (el) => el.textContent || "");
          expect(hint, label).toContain("How to turn on alerts on iPhone");

          await page.evaluate(() => (window as unknown as { schediDashHelp: (force: boolean) => void }).schediDashHelp(true));
          await page.waitForSelector("#schediDashHelp:not([hidden]) #owner-20-booking-alerts-iphone", { timeout: 5000 });
          const sheet = await overflow();
          expect(sheet.guide!.scroll, `sheet ${label}`).toBeLessThanOrEqual(1);
          expect(sheet.helpCard!.left, `sheet ${label}`).toBeGreaterThanOrEqual(-1);
          expect(sheet.helpCard!.right, `sheet ${label}`).toBeLessThanOrEqual(sheet.width + 1);
          expect(sheet.doc, `sheet ${label}`).toBeLessThanOrEqual(1);
          await page.evaluate(() => (window as unknown as { schediDashHelp: (force: boolean) => void }).schediDashHelp(false));
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  }, 120000);
});
