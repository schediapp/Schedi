import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
const plan = readFileSync(new URL("../docs/calendar-sync-plan.md", import.meta.url), "utf8");
const TEMPLATE = "return `<!DOCTYPE html>";

function extractFunction(source: string, name: string): string {
  const start = source.indexOf("function " + name);
  if (start < 0) throw new Error("missing " + name);
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

const owner = html.slice(0, html.indexOf(TEMPLATE));
const names = ["calendarHostLooksPrivate", "calendarFeedUrlError", "calendarSyncConnected", "calendarMaskUrl"];
const lib = names.map((name) => extractFunction(owner, name)).join("\n");
const api = new Function(
  `${lib}; return { calendarHostLooksPrivate, calendarFeedUrlError, calendarSyncConnected, calendarMaskUrl };`,
)() as {
  calendarHostLooksPrivate: (host: string) => boolean;
  calendarFeedUrlError: (raw: unknown) => string;
  calendarSyncConnected: (sync: unknown) => boolean;
  calendarMaskUrl: (raw: string) => string;
};

describe("calendar feed helpers", () => {
  it("treats a saved feed as connected and ignores the old provider shape", () => {
    expect(api.calendarSyncConnected(null)).toBe(false);
    expect(api.calendarSyncConnected({})).toBe(false);
    expect(api.calendarSyncConnected({ feedCount: 1, feeds: [] })).toBe(true);
    expect(api.calendarSyncConnected({
      feeds: [{ id: "abc", masked: "calendar.google.com/…/basic.ics" }],
    })).toBe(true);
    expect(api.calendarSyncConnected({
      google: { connected: true, email: "ada@example.com" },
    })).toBe(false);
  });

  it("accepts https and webcal links and rejects private addresses", () => {
    expect(api.calendarFeedUrlError("")).toBe("Paste a calendar link.");
    expect(api.calendarFeedUrlError("http://calendar.google.com/calendar/ical/secret.ics")).toBe("Use an https or webcal link.");
    expect(api.calendarFeedUrlError("https://user:pass@calendar.google.com/secret.ics")).toBe("Remove the username and password from the link.");
    expect(api.calendarFeedUrlError("https://localhost/basic.ics")).toBe("That address cannot be used.");
    expect(api.calendarFeedUrlError("https://127.0.0.1/basic.ics")).toBe("That address cannot be used.");
    expect(api.calendarFeedUrlError("https://10.1.2.3/basic.ics")).toBe("That address cannot be used.");
    expect(api.calendarFeedUrlError("https://192.168.1.9/basic.ics")).toBe("That address cannot be used.");
    expect(api.calendarFeedUrlError("https://calendar.google.com:8443/basic.ics")).toBe("Use a calendar link on port 443 or 80.");
    expect(api.calendarFeedUrlError("webcal://calendar.google.com/calendar/ical/secret/basic.ics")).toBe("");
    expect(api.calendarMaskUrl("https://calendar.google.com/calendar/ical/secret-token/basic.ics")).toBe("calendar.google.com/…/basic.ics");
    expect(api.calendarMaskUrl("https://calendar.google.com/calendar/ical/secret-token/basic.ics")).not.toContain("secret-token");
  });

  it("shows masked feeds and a subscribe link without the old connect mock", () => {
    expect(owner).toContain("Keep busy times off the book");
    expect(owner).toContain("Secret address in iCal format");
    expect(owner).toContain("Share the calendar with a public link");
    expect(owner).toContain("Publish the calendar and paste the ICS link");
    expect(owner).toContain("Copy link");
    expect(owner).toContain("Reset link");
    expect(owner).toContain("/api/calendar-feeds");
    expect(owner).toContain("Busy on a connected calendar");
    const calendarSync = owner.slice(owner.indexOf("function calendarSyncConnected"), owner.indexOf("function schediSetupSteps"))
      + owner.slice(owner.indexOf("function applyCalendarFeedView"), owner.indexOf("function hoursWeekStored"));
    expect(calendarSync).toContain("Keep busy times off the book");
    expect(calendarSync).not.toContain("Coming soon");
    expect(owner).not.toContain("app-specific password");
    expect(owner).not.toContain("This preview does not save the password.");
    expect(owner).not.toContain("data-busy-write=");
    expect(owner).not.toContain("calendarSyncProviders");
    expect(owner).not.toContain("encodeURIComponent(googleDates)");
    expect(owner).toContain("googleDates.split('/').map(encodeURIComponent).join('/')");
    expect(owner).toContain('class="sd-busy-url sd-busy-break"');
    expect(owner).toContain('class="sd-busy-hint sd-busy-break"');
    expect(owner).toContain('class="sd-busy-status sd-busy-break"');
    const busyCss = owner.slice(owner.indexOf("#tenantPortalSection.schedi-newdash .sd-busy {"), owner.indexOf("#tenantPortalSection.schedi-newdash .sd-pay-settings"));
    expect(busyCss).toContain("min-width: 0;");
    expect(busyCss).toContain("overflow-wrap: anywhere;");
    expect(busyCss).toContain("word-break: break-all;");
    expect(busyCss).toContain("#tenantPortalSection.schedi-newdash .sd-busy-field input");
    expect(busyCss).toContain("max-width: 100%;");
    const page = html.slice(html.indexOf(TEMPLATE));
    expect(page).toContain("function refreshExternalBusy");
    expect(page).toContain("https://schedi.app/api/calendar-busy?tenant=");
    expect(page).toContain("return 'Busy'");
    expect(page).toContain("out.data.error === 'slot_taken'");
    expect(page).not.toContain("Keep busy times off the book");
    expect(page).not.toContain("encodeURIComponent(googleDates)");
    expect(hq).not.toContain("encodeURIComponent(googleDates)");
    expect(hq).toContain("googleDates.split('/').map(encodeURIComponent).join('/')");
  });
});

describe("calendar sync plan", () => {
  it("covers providers, storage, busy times, and the buffer", () => {
    expect(plan).toContain("calendar.freebusy");
    expect(plan).toContain("calendar.events");
    expect(plan).toContain("calendar.calendarlist.readonly");
    expect(plan).toContain("Google Cloud Console");
    expect(plan).toContain("Calendars.ReadWrite");
    expect(plan).toContain("app-specific password");
    expect(plan).toContain("private/data/tenants");
    expect(plan).toContain("appointmentBufferMins");
    expect(plan).toContain("slotTaken");
    expect(plan).toContain("CALENDAR_KV");
  });
});

const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));
const root = new URL("..", import.meta.url).pathname;
const FEED = "ebce806ccb5b4db9b60e63a801a2d7c30780414ff31b0297";

describe.skipIf(!chrome)("owner feed links stay inside the card", () => {
  it("wraps the https and webcal lines, the private iCal field, and a long saved link at 390 and 1280", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".css": "text/css; charset=utf-8",
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
        await page.setViewport({ width, height: 844, isMobile: width < 860, hasTouch: width < 860 });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)))));
        return page.evaluate((token) => {
          const win = window as unknown as {
            getTenant: () => { calendarSync?: unknown };
            schediDashGo: (page: string) => void;
          };
          const tenant = win.getTenant();
          tenant.calendarSync = {
            feedCount: 1,
            feeds: [{
              id: "long-feed",
              masked: "https://calendar.google.com/calendar/ical/" + token + "/basic.ics",
              provider: "Google Calendar",
              lastSynced: Date.now(),
              eventCount: 2,
              error: "",
            }],
            ownerFeed: {
              https: "https://schedi.app/api/owner-feed/" + token + ".ics",
              webcal: "webcal://schedi.app/api/owner-feed/" + token + ".ics",
            },
          };
          win.schediDashGo("hours");
          const input = document.querySelector("#sdBusyCard input[name='calendarUrl']") as HTMLInputElement | null;
          const pasted = "https://calendar.google.com/calendar/ical/" + token + "/basic.ics";
          if (input) input.value = pasted;
          const card = document.getElementById("sdBusyCard") as HTMLElement;
          const box = card.getBoundingClientRect();
          const lines = [...card.querySelectorAll(".sd-busy-url, .sd-busy-break, .sd-busy-field input")].map((el) => {
            const node = el as HTMLElement;
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
              kind: node.tagName,
              className: node.className,
              text: (node.tagName === "INPUT" ? (node as HTMLInputElement).value : node.textContent || "").slice(0, 40),
              right: rect.right,
              left: rect.left,
              scrollWidth: node.scrollWidth,
              clientWidth: node.clientWidth,
              wordBreak: style.wordBreak,
              overflowWrap: style.overflowWrap,
            };
          });
          return {
            cardRight: box.right,
            cardLeft: box.left,
            cardFits: card.scrollWidth - card.clientWidth,
            lines,
            pasted,
          };
        }, FEED);
      };
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      for (const width of [390, 1280]) {
        const layout = await measure(width);
        expect(layout.cardRight - layout.cardLeft).toBeGreaterThan(200);
        expect(layout.cardRight).toBeLessThanOrEqual(width + 1);
        expect(layout.cardFits).toBeLessThanOrEqual(1);
        expect(layout.lines.length).toBeGreaterThanOrEqual(3);
        for (const line of layout.lines) {
          expect(line.right, line.className || line.kind).toBeLessThanOrEqual(layout.cardRight + 1);
          expect(line.left, line.className || line.kind).toBeGreaterThanOrEqual(layout.cardLeft - 1);
          if (line.kind !== "INPUT") {
            expect(line.scrollWidth, line.className).toBeLessThanOrEqual(line.clientWidth + 1);
          }
        }
        const webcal = layout.lines.find((line) => line.text.startsWith("Webcal:"));
        const https = layout.lines.find((line) => line.className.includes("sd-busy-url"));
        const field = layout.lines.find((line) => line.kind === "INPUT");
        expect(webcal?.wordBreak).toBe("break-all");
        expect(webcal?.overflowWrap).toBe("anywhere");
        expect(https?.wordBreak).toBe("break-all");
        expect(field?.text.startsWith("https://calendar.google.com")).toBe(true);
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});
