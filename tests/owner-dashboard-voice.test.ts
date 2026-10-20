import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

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

describe("owner dashboard voice", () => {
  it("rebuilds the today screen, nav, and account words away from the old mockup", () => {
    const panel = html.slice(html.indexOf('id="schediTodayPanel"'), html.indexOf('id="schediDashTabbar"'));
    const glance = panel.indexOf('id="schediGlanceHeading"');
    const pulse = panel.indexOf('class="sd-pulse"');
    const waiting = panel.indexOf(">Waiting on you<");
    const requests = panel.indexOf('id="schediTodayRequests"');
    const coming = panel.indexOf('id="schediAgendaHeading"');
    const schedule = panel.indexOf('id="schediTodaySchedule"');
    const ready = panel.indexOf('id="schediReady"');
    expect(glance).toBeGreaterThan(-1);
    expect(panel.slice(glance, pulse)).toContain(">At a glance<");
    expect(pulse).toBeGreaterThan(glance);
    expect(waiting).toBeGreaterThan(pulse);
    expect(requests).toBeGreaterThan(waiting);
    expect(coming).toBeGreaterThan(requests);
    expect(panel.slice(coming, schedule)).toContain(">Coming up<");
    expect(schedule).toBeGreaterThan(coming);
    expect(ready).toBeGreaterThan(schedule);
    expect(panel).toContain("What's next");
    expect(panel).toContain("people today");
    expect(panel).toContain("still to collect");
    expect(panel).toContain("visits this week");
    expect(panel).toContain('id="schediStatPeople"');
    expect(panel).toContain('id="schediStatOwed"');
    expect(panel).toContain('id="schediStatWeekVisits"');
    expect(panel).not.toContain("Your day");
    expect(panel).not.toContain(">New requests<");
    expect(panel).not.toContain("Today's schedule");
    expect(panel).not.toContain("Finish setting up");
    expect(panel).not.toContain("booked revenue");
    expect(panel).not.toContain("needs follow-up");
    expect(panel).not.toContain('class="sd-stats"');
    expect(panel).not.toContain('id="schediSetupBar"');
    expect(panel.indexOf("Copy booking link")).toBeLessThan(panel.indexOf("Show QR code"));
    expect(panel).toContain("Add appointment");

    const nav = html.slice(html.indexOf('aria-label="Dashboard"'), html.indexOf('id="schediDashTop"'));
    expect(nav.indexOf(">Schedule<")).toBeGreaterThan(-1);
    expect(nav.indexOf(">Schedule<")).toBeLessThan(nav.indexOf(">Setup<"));
    expect(nav.indexOf(">Setup<")).toBeLessThan(nav.indexOf(">Insights<"));
    expect(nav.indexOf('data-dash-go="today"')).toBeLessThan(nav.indexOf('data-dash-go="appointments"'));
    expect(nav.indexOf('data-dash-go="appointments"')).toBeLessThan(nav.indexOf('data-dash-go="clients"'));
    expect(nav.indexOf('data-dash-go="clients"')).toBeLessThan(nav.indexOf('data-dash-go="services"'));
    expect(nav.indexOf('data-dash-go="services"')).toBeLessThan(nav.indexOf('data-dash-go="reports"'));
    expect(nav).toContain(">Agenda<");
    expect(nav).toContain(">Your page<");
    expect(nav).toContain(">Subscription<");
    expect(nav).not.toContain(">Today<");
    expect(nav).not.toContain("Plan &amp; billing");

    const bar = html.slice(html.indexOf('id="schediDashTabbar"'), html.indexOf('id="schediDashAccountMenu"'));
    expect(bar).toContain("sd-fab");
    expect(bar).toContain("fa-plus");
    expect(bar).toContain('aria-label="Add appointment"');
    expect(bar).toContain("schediDashToggleAdd");
    expect(bar.indexOf(">Agenda<")).toBeLessThan(bar.indexOf(">Clients<"));
    expect(bar.indexOf(">Clients<")).toBeLessThan(bar.indexOf("sd-fab"));
    expect(bar.indexOf("sd-fab")).toBeLessThan(bar.indexOf(">Calendar<"));
    expect(bar.indexOf(">Calendar<")).toBeLessThan(bar.indexOf(">More<"));

    const account = html.slice(html.indexOf('id="schediDashAccountMenu"'), html.indexOf('id="schediDashAddMenu"'));
    expect(account).toContain("Login &amp; security");
    expect(account).toContain(">Subscription<");
    expect(account).not.toContain("Account &amp; password");
    expect(account).not.toContain("Plan &amp; billing");
    const sheet = html.slice(html.indexOf('id="schediDashMoreSheet"'), html.indexOf('id="schediQrModal"'));
    expect(sheet).toContain("Login &amp; security");
    expect(sheet).toContain(">Subscription<");
    expect(sheet).not.toContain("Account &amp; password");
    expect(sheet).not.toContain("Plan &amp; billing");

    const steps = extractFunction(html, "schediSetupSteps");
    for (const label of [
      "Put a service on the page",
      "Set the hours you take people",
      "Pick the ways you get paid",
      "Show your logo on the page",
      "Turn the booking calendar on",
      "Connect a calendar to keep times free",
    ]) {
      expect(steps).toContain(label);
    }
    expect(steps).not.toContain("Add a service");
    expect(steps).not.toContain("Set your hours");
    expect(steps).not.toContain("Avoid double-booking");
    expect(steps).toContain("page: 'services'");
    expect(steps).toContain("{ label: 'Set the hours you take people', done: hours, page: 'hours' }");
    expect(steps).toContain("{ label: 'Connect a calendar to keep times free', done: calendarSyncConnected(tenant && tenant.calendarSync), page: 'hours' }");
    expect(steps).toContain("page: 'payments'");
    expect(steps).toContain("{ label: 'Show your logo on the page', done: logo, page: 'profile' }");
    expect(steps).toContain("page: 'appointments'");

    const render = extractFunction(html, "renderSchediToday");
    expect(render).toContain("is-next");
    expect(render).toContain("sd-next-tag");
    expect(render).toContain(">Edit</button>");
    expect(render).toContain("markAppointmentPaid");
    expect(render).toContain("markAppointmentNoShow");
    expect(render).toContain(">Decline</button>");
    expect(render).toContain(">Accept</button>");
    expect(render.indexOf("details class=\"sd-more\"")).toBeLessThan(render.indexOf(">Edit</button>"));
    expect(render).toContain("Get your page ready");
    expect(render).toContain("ready.hidden = done === steps.length");
    expect(render).not.toContain("Finish setting up");
    expect(render).not.toContain("schediStatToday");
    expect(render).not.toContain("schediStatReview");
    expect(html).toContain("Keep busy times off the book");
  });
});

describe.skipIf(!chrome)("owner dashboard voice layout", () => {
  it("fits the agenda at 390, 1280, and 1920 without a sideways scroll", async () => {
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
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => {
        const lead = document.getElementById("schediNextLine")?.textContent || "";
        return lead.includes("Maya Chen") && lead.includes("09:00 AM");
      }, { timeout: 20000 });
      const copy = await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll("#schediSetupList .sd-check")).map((node) => (node.textContent || "").trim());
        const first = document.querySelector("#schediTodaySchedule article");
        return {
          lead: document.getElementById("schediNextLine")?.textContent || "",
          glance: document.getElementById("schediGlanceHeading")?.textContent || "",
          heading: document.getElementById("schediAgendaHeading")?.textContent || "",
          waiting: document.getElementById("schediWaitHeading")?.textContent || "",
          ready: document.getElementById("schediSetupTitle")?.textContent || "",
          readyHidden: document.getElementById("schediReady")?.hidden === true,
          count: document.getElementById("schediSetupCount")?.textContent || "",
          pips: document.querySelectorAll("#schediSetupPips li").length,
          donePips: document.querySelectorAll("#schediSetupPips li.is-done").length,
          labels,
          next: first?.classList.contains("is-next") === true,
          nextTag: first?.querySelector(".sd-next-tag")?.textContent || "",
          editBesideMenu: !!first?.querySelector(".sd-more") && (first.textContent || "").includes("Edit"),
          bar: document.getElementById("schediDashTabbar")?.textContent || "",
          fab: (document.querySelector("#schediDashTabbar .sd-fab") as HTMLButtonElement | null)?.getAttribute("aria-label") || "",
        };
      });
      expect(copy.lead).toBe("Maya Chen is first, at 09:00 AM.");
      expect(copy.glance).toBe("At a glance");
      expect(copy.heading).toBe("Coming up");
      expect(copy.waiting).toBe("Waiting on you");
      expect(copy.ready).toBe("Get your page ready");
      expect(copy.readyHidden).toBe(false);
      expect(copy.count).toBe("5 of 6");
      expect(copy.pips).toBe(6);
      expect(copy.donePips).toBe(5);
      expect(copy.labels).toEqual([
        "Put a service on the page",
        "Set the hours you take people",
        "Pick the ways you get paid",
        "Show your logo on the page",
        "Turn the booking calendar on",
        "Connect a calendar to keep times free",
      ]);
      expect(copy.next).toBe(true);
      expect(copy.nextTag).toBe("Next");
      expect(copy.editBesideMenu).toBe(true);
      expect(copy.fab).toBe("Add appointment");
      expect(copy.bar).toContain("Agenda");
      expect(copy.bar).toContain("Clients");
      expect(copy.bar).toContain("Calendar");
      expect(copy.bar).toContain("More");

      const finished = await page.evaluate(() => {
        const win = window as unknown as {
          getTenant: () => { logoUrl?: string };
          renderSchediToday: (tenant: { logoUrl?: string }) => void;
        };
        const tenant = win.getTenant();
        const previous = tenant.logoUrl;
        tenant.logoUrl = "https://example.com/logo.png";
        win.renderSchediToday(tenant);
        const ready = document.getElementById("schediReady");
        const hidden = ready?.hidden === true && getComputedStyle(ready).display === "none";
        const stillThere = ["schediGlanceHeading", "schediWaitHeading", "schediAgendaHeading"].map((id) => {
          const el = document.getElementById(id);
          return !!el && getComputedStyle(el).display !== "none";
        });
        tenant.logoUrl = previous;
        win.renderSchediToday(tenant);
        return { hidden, stillThere, restored: document.getElementById("schediReady")?.hidden === false };
      });
      expect(finished.hidden).toBe(true);
      expect(finished.stillThere).toEqual([true, true, true]);
      expect(finished.restored).toBe(true);

      for (const width of [390, 1280, 1920]) {
        await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => {
            (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(mode);
            (window as unknown as { schediDashGo: (page: string) => void }).schediDashGo("today");
          }, theme);
          const fit = await page.evaluate(() => {
            const pulse = document.querySelector(".sd-pulse-row") as HTMLElement | null;
            const panel = document.getElementById("schediTodayPanel") as HTMLElement | null;
            const side = document.getElementById("schediDashSidebar");
            const box = (id: string) => document.getElementById(id)?.getBoundingClientRect();
            const glance = box("schediGlanceHeading");
            const waiting = box("schediWaitHeading");
            const coming = box("schediAgendaHeading");
            const ready = box("schediReady");
            return {
              page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              pulse: pulse ? pulse.scrollWidth - pulse.clientWidth : 0,
              panel: panel ? panel.scrollWidth - panel.clientWidth : 0,
              side: side ? getComputedStyle(side).display : "",
              order: [glance?.top, waiting?.top, coming?.top, ready?.top],
              left: [glance?.left, waiting?.left, coming?.left, ready?.left],
            };
          });
          expect(fit.page, `${width} ${theme}`).toBeLessThanOrEqual(1);
          expect(fit.pulse, `${width} ${theme}`).toBeLessThanOrEqual(1);
          expect(fit.panel, `${width} ${theme}`).toBeLessThanOrEqual(1);
          expect(fit.side, `${width} ${theme}`).toBe(width === 390 ? "none" : "flex");
          const tops = fit.order.map((value) => value ?? Number.NaN);
          expect(tops[0], `${width} ${theme} glance`).toBeLessThan(tops[1]);
          expect(tops[1], `${width} ${theme} waiting`).toBeLessThan(tops[2]);
          expect(tops[2], `${width} ${theme} coming`).toBeLessThan(tops[3]);
          const lefts = fit.left.map((value) => value ?? Number.NaN);
          expect(Math.abs(lefts[0] - lefts[1]), `${width} ${theme} column`).toBeLessThan(2);
          expect(Math.abs(lefts[1] - lefts[2]), `${width} ${theme} column`).toBeLessThan(2);
          expect(Math.abs(lefts[2] - lefts[3]), `${width} ${theme} column`).toBeLessThan(2);
        }
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);
});
