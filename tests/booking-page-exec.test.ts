import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fillBookingDocument } from "../worker/booking-document";

const bookingHtml = readFileSync(new URL("../site/booking.html", import.meta.url), "utf8");
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

const hours = {
  Mon: { open: true, start: "09:00 AM", end: "05:00 PM" },
  Tue: { open: true, start: "09:00 AM", end: "05:00 PM" },
  Wed: { open: true, start: "09:00 AM", end: "05:00 PM" },
  Thu: { open: true, start: "09:00 AM", end: "05:00 PM" },
  Fri: { open: true, start: "09:00 AM", end: "05:00 PM" },
  Sat: { open: true, start: "10:00 AM", end: "02:00 PM" },
  Sun: { open: false, start: "10:00 AM", end: "02:00 PM" },
};

const services = [
  { id: 1, name: "Cut & style", duration: "45 mins", durationMins: 45, price: 65, icon: "fa-scissors" },
];

function fixture(extra: Record<string, unknown> = {}) {
  return {
    id: "bright-cuts",
    name: "Bright Cuts",
    slug: "bright-cuts",
    industry: "Barber",
    timezone: "America/New_York",
    services,
    operatingHours: hours,
    ...extra,
  };
}

function scripts(html: string) {
  const found: { kind: string; code: string; src: boolean }[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const attrs = match[1];
    const type = /type\s*=\s*["']([^"']+)["']/i.exec(attrs);
    found.push({
      kind: type ? type[1] : "classic",
      code: match[2],
      src: /\ssrc\s*=/.test(attrs),
    });
  }
  return found;
}

function assertParses(html: string) {
  for (const script of scripts(html)) {
    if (!script.code.trim() || script.src || script.kind === "application/ld+json") continue;
    if (script.kind === "module") {
      const dir = mkdtempSync(join(tmpdir(), "schedi-book-"));
      const file = join(dir, "module.mjs");
      writeFileSync(file, script.code);
      const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      expect(checked.status, checked.stderr).toBe(0);
      continue;
    }
    expect(() => new Function(script.code)).not.toThrow();
  }
}

describe("booking document scripts", () => {
  it("unescapes template regexes and parses every inline script", () => {
    expect(bookingHtml).toContain("/^https:\\/\\//i");
    expect(bookingHtml).not.toContain("/^https:\\\\/\\\\//i");
    expect(bookingHtml).toContain("function schediBookingsClosed");
    assertParses(bookingHtml);
    const filled = fillBookingDocument(bookingHtml, {
      slug: "bright-cuts",
      fields: fixture({ subscriptionStatus: "active", acceptingBookings: true }),
    });
    assertParses(filled);
  });

  it("hides a rejected slot and does not offer times the server would refuse", () => {
    const start = bookingHtml.indexOf("function syncBookingsToFirestore");
    const end = bookingHtml.indexOf("document.getElementById('resCode')", start);
    const fn = bookingHtml.slice(start, end);
    const reject = "out.data.error === 'too_soon' || out.data.error === 'slot_taken' || out.data.error === 'slot_unavailable'";
    expect(fn.split(reject)).toHaveLength(3);
    expect(fn).toContain("document.getElementById('confirmationCard')");
    expect(fn).toContain("confirmCard.classList.add('hidden')");
    expect(fn).toContain("errBox.classList.remove('hidden')");
    expect(fn).toContain("That time is not available. Choose another time.");
    const guard = "if (out && !out.ok && out.data && (" + reject + ")) return;";
    expect(fn.indexOf(guard)).toBeGreaterThan(0);
    expect(fn.indexOf(guard)).toBeLessThan(fn.indexOf("type: 'NEW_BOOKING_SUBMITTED'"));
    expect(bookingHtml).toContain("if (slotInsideNotice(selectedDateStr, t)) { hiddenByNotice++; continue; }");
    expect(bookingHtml).toContain("return startUtc.getTime() < Date.now() + hours * 60 * 60 * 1000;");
    expect(bookingHtml).toContain("var openMins = dayHours ? toMinutes(dayHours.start) : 9 * 60;");
    expect(bookingHtml).toContain("var closeMins = dayHours ? toMinutes(dayHours.end) : 17 * 60;");
    expect(bookingHtml).toContain("if (closeMins === null || closeMins <= openMins) closeMins = 17 * 60;");
    expect(bookingHtml).toContain("start: dayHours && dayHours.start ? dayHours.start : '09:00 AM',");
    expect(bookingHtml).toContain("end: dayHours && dayHours.end ? dayHours.end : '05:00 PM',");
  });
});

describe.skipIf(!chrome)("booking document browser", () => {
  it("renders services and the calendar, and pauses when the flag is missing", async () => {
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const firebaseStub = [
      "export function initializeApp(){return {}}",
      "export function getAuth(){return {currentUser:null}}",
      "export function signInAnonymously(){return Promise.resolve()}",
      "export function getFirestore(){return {}}",
      "export function doc(){return {}}",
      "export function onSnapshot(){return function(){}}",
      "export function collection(){return {}}",
    ].join("\n");
    const pages = new Map<string, string>();
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const body = pages.get(path);
      if (body == null) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    function fulfill(request: import("puppeteer-core").HTTPRequest, status: number, contentType: string, body: string) {
      request.respond({
        status,
        contentType,
        headers: { "access-control-allow-origin": "*", "content-type": contentType },
        body,
      });
    }
    async function open(path: string) {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        if (url.startsWith(`http://127.0.0.1:${port}`)) {
          request.continue();
          return;
        }
        if (url.includes("firebasejs")) {
          fulfill(request, 200, "application/javascript", firebaseStub);
          return;
        }
        if (url.includes("/api/calendar-busy")) {
          fulfill(request, 200, "application/json", '{"ok":true,"blocks":[]}');
          return;
        }
        const type = request.resourceType();
        if (type === "script") {
          fulfill(request, 200, "application/javascript", "");
          return;
        }
        if (type === "stylesheet" || type === "font" || type === "image") {
          fulfill(request, 200, type === "stylesheet" ? "text/css" : "text/plain", "");
          return;
        }
        fulfill(request, 204, "text/plain", "");
      });
      await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: "domcontentloaded", timeout: 15000 });
      return { page, errors };
    }
    try {
      const live = fillBookingDocument(bookingHtml, {
        slug: "bright-cuts",
        fields: fixture({ subscriptionStatus: "active" }),
      });
      pages.set("/bright-cuts", live);
      const opened = await open("/bright-cuts");
      await opened.page.waitForFunction(() => {
        const box = document.getElementById("serviceListContainer");
        const title = document.getElementById("monthTitleLabel");
        const days = document.getElementById("monthCalendarContainer");
        return !!box && (box.textContent || "").includes("Cut & style")
          && !!title && /[A-Za-z]+ \d{4}/.test(title.textContent || "")
          && !!days && (days.textContent || "").includes("1");
      }, { timeout: 10000 });
      expect(opened.errors, opened.errors.join("\n")).toEqual([]);

      const paused = fillBookingDocument(bookingHtml, {
        slug: "bright-cuts",
        fields: fixture({ subscriptionStatus: "paused" }),
      }).replace(/"acceptingBookings":(?:true|false),/, "").replace(/,"acceptingBookings":(?:true|false)/, "");
      expect(paused).toContain('"subscriptionStatus":"paused"');
      expect(paused).not.toMatch(/"acceptingBookings"\s*:/);
      pages.set("/paused", paused);
      const closed = await open("/paused");
      await closed.page.waitForFunction(() => (document.body.textContent || "").includes("not taking appointments"), { timeout: 10000 });
      const stillBooking = await closed.page.$("#serviceListContainer");
      expect(stillBooking).toBeNull();
      expect(closed.errors, closed.errors.join("\n")).toEqual([]);

      const limitedHtml = fillBookingDocument(bookingHtml, {
        slug: "axeldelcidphotography",
        fields: fixture({
          id: "axeldelcidphotography",
          name: "Axel Delcid Photography",
          slug: "axeldelcidphotography",
          subscriptionStatus: "active",
          acceptingBookings: true,
          slotInterval: 60,
          minNoticeHours: 0,
          appointmentBufferMins: 0,
          operatingHours: {
            ...hours,
            Fri: { open: true, start: "11:00 AM", end: "07:00 PM" },
            Sun: { open: true, start: "09:00 AM", end: "05:00 PM" },
          },
          blockedTimes: [{
            startDate: "2026-10-25",
            endDate: "2026-10-25",
            allDay: true,
            note: "Studio closed",
          }],
          specialHours: {
            "2027-09-24": { closed: false, ranges: [{ start: "09:00 AM", end: "05:00 PM" }] },
          },
        }),
      });
      pages.set("/axel", limitedHtml);
      const limited = await browser.newPage();
      await limited.setViewport({ width: 1280, height: 900 });
      await limited.evaluateOnNewDocument(() => {
        const fixed = Date.parse("2026-10-20T15:00:00Z");
        const RealDate = Date;
        class PatchedDate extends RealDate {
          constructor(...args) {
            if (args.length === 0) super(fixed);
            else super(...args);
          }
          static now() { return fixed; }
        }
        PatchedDate.parse = RealDate.parse;
        PatchedDate.UTC = RealDate.UTC;
        window.Date = PatchedDate;
      });
      const hourErrors: string[] = [];
      limited.on("pageerror", (error) => hourErrors.push(String(error)));
      limited.on("console", (msg) => {
        if (msg.type() === "error") hourErrors.push(msg.text());
      });
      await limited.setRequestInterception(true);
      limited.on("request", (request) => {
        const url = request.url();
        if (url.startsWith(`http://127.0.0.1:${port}`)) {
          request.continue();
          return;
        }
        if (url.includes("firebasejs")) {
          fulfill(request, 200, "application/javascript", firebaseStub);
          return;
        }
        if (url.includes("/api/calendar-busy")) {
          fulfill(request, 200, "application/json", '{"ok":true,"blocks":[]}');
          return;
        }
        const type = request.resourceType();
        if (type === "script") {
          fulfill(request, 200, "application/javascript", "");
          return;
        }
        if (type === "stylesheet" || type === "font" || type === "image") {
          fulfill(request, 200, type === "stylesheet" ? "text/css" : "text/plain", "");
          return;
        }
        fulfill(request, 204, "text/plain", "");
      });
      await limited.goto(`http://127.0.0.1:${port}/axel`, { waitUntil: "domcontentloaded", timeout: 15000 });
      await limited.waitForFunction(() => {
        const day = document.querySelector('button[aria-label*="October 25"]');
        return !!day && day.classList.contains("cal-day-away") && (day.textContent || "").includes("Studio closed");
      }, { timeout: 10000 });
      await limited.click('button[aria-label*="October 25"]');
      await limited.waitForFunction(() => (document.getElementById("timeSlotsContainer")?.textContent || "").includes("Unavailable — Studio closed"));
      for (let step = 0; step < 11; step += 1) {
        await limited.click('button[onclick="nextMonth()"]');
      }
      await limited.waitForFunction(() => {
        const title = document.getElementById("monthTitleLabel");
        const day = document.querySelector('button[aria-label*="September 24"]');
        return (title?.textContent || "").includes("September 2027")
          && !!day
          && day.classList.contains("cal-day-special")
          && (day.textContent || "").includes("Special");
      }, { timeout: 10000 });
      await limited.click('button[aria-label*="September 24"]');
      await limited.waitForFunction(() => {
        const text = document.getElementById("timeSlotsContainer")?.textContent || "";
        return text.includes("09:00 AM") && text.includes("04:00 PM") && !text.includes("06:00 PM");
      }, { timeout: 10000 });
      expect(hourErrors, hourErrors.join("\n")).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
