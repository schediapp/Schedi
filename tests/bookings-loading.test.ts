import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

function extractFunction(source: string, name: string): string {
  const start = source.indexOf("function " + name + "(");
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

function agendaApi() {
  return new Function(
    `${extractFunction(html, "appointmentIsCancelled")}
     ${extractFunction(html, "toMinutes")}
     ${extractFunction(html, "rosterApptSortKey")}
     function rosterPrettyDate(iso) { return String(iso || ""); }
     ${extractFunction(html, "schediVisitOpen")}
     ${extractFunction(html, "schediWaitingRequest")}
     ${extractFunction(html, "schediSortVisits")}
     ${extractFunction(html, "schediComingVisits")}
     ${extractFunction(html, "schediNextVisitLine")}
     ${extractFunction(html, "schediBookingsPhase")}
     return { schediWaitingRequest, schediComingVisits, schediNextVisitLine, schediBookingsPhase };`,
  )() as {
    schediWaitingRequest: (app: { status?: string; cancelled?: boolean; date?: string; time?: string; durationMins?: number } | null, today?: string, nowMins?: number) => boolean;
    schediComingVisits: (apps: { id: string; status?: string; date?: string; time?: string; clientName?: string; durationMins?: number }[], today: string, limit?: number, nowMins?: number) => { id: string }[];
    schediNextVisitLine: (app: { clientName?: string; date?: string; time?: string } | undefined, today: string) => string;
    schediBookingsPhase: (tenant: { _privateBookingsLoaded?: boolean } | null) => string;
  };
}

describe("booking load states", () => {
  it("keeps empty copy behind a finished bookings request and treats a blank status as waiting", () => {
    const render = extractFunction(html, "renderSchediToday");
    const roster = extractFunction(html, "renderTenantRoster");
    const calendar = extractFunction(html, "renderRosterCalendar");
    const refresh = extractFunction(html, "refreshPrivateBookings");
    expect(render).toContain("schediBookingsPhase(tenant)");
    expect(render).toContain("Loading bookings…");
    expect(render).toContain("schediBookingsErrorHtml()");
    expect(render).toContain("schediComingVisits(apps, today, 4, nowMins)");
    expect(render).toContain("schediWaitingRequest(app, today, nowMins)");
    expect(refresh.indexOf("data.ok === false")).toBeLessThan(refresh.indexOf("!Array.isArray(data.tenants)"));
    expect(render).toContain("schediNextVisitLine(coming[0], today)");
    expect(render.indexOf("phase !== 'ready'")).toBeLessThan(render.indexOf("The book is clear."));
    expect(render.indexOf("phase !== 'ready'")).toBeLessThan(render.indexOf("Nobody is waiting on a yes."));
    expect(roster).toContain("schediBookingsPhase(tenant)");
    expect(roster.indexOf("bookingsPhase === 'loading'")).toBeLessThan(roster.indexOf("No client appointments logged yet."));
    expect(calendar.indexOf("phase === 'loading'")).toBeLessThan(calendar.indexOf("No appointments"));
    expect(refresh).toContain("schediSetBookingsLoad('error')");
    expect(refresh).toContain("schediSetBookingsLoad('ready')");
    expect(refresh).toContain("schediSetBookingsLoad('loading')");
    expect(html).toContain('onclick="refreshPrivateBookings()">Retry</button>');

    const api = agendaApi();
    const phaseState = { bookingsLoad: "" as string };
    const session = { value: "" };
    const phase = new Function(
      "platformState",
      "window",
      "schediAuthSession",
      `${extractFunction(html, "schediBookingsPhase")}\nreturn schediBookingsPhase;`,
    )(phaseState, {}, () => session.value) as (tenant: { _privateBookingsLoaded?: boolean } | null) => string;
    expect(phase({ _privateBookingsLoaded: true })).toBe("ready");
    session.value = "signed-in";
    expect(phase({ _privateBookingsLoaded: false })).toBe("loading");
    phaseState.bookingsLoad = "error";
    expect(phase({ _privateBookingsLoaded: false })).toBe("error");
    phaseState.bookingsLoad = "ready";
    expect(phase({ _privateBookingsLoaded: true })).toBe("ready");

    const noon = 12 * 60;
    expect(api.schediWaitingRequest({ status: "pending" })).toBe(true);
    expect(api.schediWaitingRequest({ status: "" })).toBe(true);
    expect(api.schediWaitingRequest({})).toBe(true);
    expect(api.schediWaitingRequest({ status: "   " })).toBe(true);
    expect(api.schediWaitingRequest({ status: "accepted" })).toBe(false);
    expect(api.schediWaitingRequest({ status: "denied" })).toBe(false);
    expect(api.schediWaitingRequest({ status: "", cancelled: true })).toBe(false);
    expect(api.schediWaitingRequest({ status: "pending", date: "2026-10-14", time: "09:00 AM" }, "2026-10-20", noon)).toBe(true);
    expect(api.schediWaitingRequest({ date: "2026-10-14", time: "09:00 AM" }, "2026-10-20", noon)).toBe(false);
    expect(api.schediWaitingRequest({ date: "2026-10-21", time: "09:00 AM" }, "2026-10-20", noon)).toBe(true);
    expect(api.schediWaitingRequest({ date: "2026-10-20", time: "11:00 AM" }, "2026-10-20", 10 * 60)).toBe(true);
    expect(api.schediWaitingRequest({ date: "2026-10-20", time: "11:00 AM" }, "2026-10-20", noon)).toBe(false);
    expect(api.schediWaitingRequest({ date: "2026-10-20", time: "11:30 PM" }, "2026-10-20", 23 * 60)).toBe(true);
    expect(api.schediWaitingRequest({ date: "2026-10-20" }, "2026-10-20", 18 * 60)).toBe(true);
    expect(api.schediWaitingRequest({ date: "2026-10-20", time: "09:00 AM", durationMins: 30 }, "2026-10-20", 9 * 60 + 29)).toBe(true);
    expect(api.schediWaitingRequest({ date: "2026-10-20", time: "09:00 AM", durationMins: 30 }, "2026-10-20", 9 * 60 + 30)).toBe(false);

    const visits = api.schediComingVisits([
      { id: "past", status: "accepted", date: "2026-10-19", time: "09:00 AM", clientName: "Past" },
      { id: "past-blank", date: "2026-10-14", time: "09:00 AM", clientName: "Past Blank" },
      { id: "blank", date: "2026-10-20", time: "11:00 AM", clientName: "No Status" },
      { id: "today-pending", status: "pending", date: "2026-10-20", time: "02:00 PM", clientName: "Today Request" },
      { id: "pending", status: "pending", date: "2026-10-21", time: "09:00 AM", clientName: "Waiting" },
      { id: "later", status: "accepted", date: "2026-10-22", time: "01:00 PM", clientName: "Later" },
      { id: "soon", status: "accepted", date: "2026-10-20", time: "04:00 PM", clientName: "Soon" },
      { id: "early", status: "accepted", date: "2026-10-20", time: "09:00 AM", clientName: "Early" },
      { id: "fifth", status: "accepted", date: "2026-10-23", time: "09:00 AM", clientName: "Fifth" },
      { id: "sixth", status: "accepted", date: "2026-10-24", time: "09:00 AM", clientName: "Sixth" },
      { id: "seventh", status: "accepted", date: "2026-10-25", time: "09:00 AM", clientName: "Seventh" },
      { id: "eighth", status: "accepted", date: "2026-10-26", time: "09:00 AM", clientName: "Eighth" },
    ], "2026-10-20", 4, noon);
    expect(visits.map((row) => row.id)).toEqual(["early", "blank", "today-pending", "soon", "later", "fifth", "sixth", "seventh"]);
    expect(api.schediNextVisitLine({ clientName: "Maya Chen", date: "2026-10-20", time: "09:00 AM" }, "2026-10-20")).toBe("Maya Chen is first, at 09:00 AM.");
    expect(api.schediNextVisitLine({ clientName: "Noah Brooks", date: "2026-10-21", time: "10:00 AM" }, "2026-10-20")).toBe("Noah Brooks is first, 2026-10-21 at 10:00 AM.");
    expect(api.schediNextVisitLine(undefined, "2026-10-20")).toBe("Nothing is lined up yet.");
  });

  it("shows HQ activity only after the counts request finishes", () => {
    const paint = extractFunction(hq, "hqDashPaint");
    const card = extractFunction(hq, "hqDashBizCard");
    const sheet = extractFunction(hq, "hqDashSheetHtml");
    const counts = extractFunction(hq, "refreshAppointmentCounts");
    expect(card).toContain("hqCountsHoldHtml()");
    expect(sheet).toContain("hqCountsHoldHtml()");
    expect(paint).toContain("Loading bookings…");
    expect(paint).toContain("hqCountsPhase()");
    expect(paint.indexOf("countsPhase === 'ready'")).toBeLessThan(paint.indexOf("Nothing needs attention."));
    expect(counts).toContain("platformState.countsLoad = 'error'");
    expect(counts).toContain("platformState.countsLoad = 'ready'");
    expect(counts).toContain("platformState.countsLoad = 'loading'");
    expect(hq).toContain('onclick="refreshAppointmentCounts()">Retry</button>');
    const phase = new Function(
      "platformState",
      "window",
      `${extractFunction(hq, "hqCountsPhase")}\nreturn hqCountsPhase;`,
    )(
      { countsLoad: "", isAgencyMasterLoggedIn: true, tenantHealth: null },
      {},
    ) as () => string;
    const state = { countsLoad: "", isAgencyMasterLoggedIn: true, tenantHealth: null as object | null };
    const read = new Function("platformState", "window", `${extractFunction(hq, "hqCountsPhase")}\nreturn hqCountsPhase;`)(state, {}) as () => string;
    expect(read()).toBe("loading");
    state.countsLoad = "error";
    expect(read()).toBe("error");
    state.countsLoad = "ready";
    expect(read()).toBe("ready");
    expect(phase()).toBe("loading");
  });
});

function startServer(fileFor: (path: string) => string) {
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
    const file = fileFor(path);
    const full = join(root, file);
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
        close: () => new Promise((done, reject) => server.close((error) => error ? reject(error) : done())),
      });
    });
  });
}

describe.skipIf(!chrome)("booking load states in the browser", () => {
  it("shows loading, then an error with Retry, then an empty book only after zero, at 390 and 1280", async () => {
    const server = await startServer((path) => (path === "/" || path === "/portal-preview" ? "/index.html" : path));
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
      await page.goto(`http://127.0.0.1:${server.port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => (document.getElementById("schediNextLine")?.textContent || "").includes("Maya Chen"), { timeout: 20000 });
      const loaded = await page.evaluate(() => {
        const titles = Array.from(document.querySelectorAll("#schediTodaySchedule .sd-row-title")).map((el) => (el.textContent || "").trim());
        const waiting = document.getElementById("schediTodayRequests")?.textContent || "";
        return { titles, waiting, lead: document.getElementById("schediNextLine")?.textContent || "" };
      });
      expect(loaded.lead).toBe("Maya Chen is first, at 09:00 AM.");
      expect(loaded.titles[0]).toContain("Maya Chen");
      expect(loaded.titles).toContain("Jordan Lee · Walk-in");
      expect(loaded.titles.some((name) => name.includes("Noah Brooks"))).toBe(true);
      expect(loaded.titles).not.toContain("Luis Ortega");
      expect(loaded.waiting).toContain("Luis Ortega");
      expect(loaded.waiting).not.toContain("Maya Chen");

      const planted = await page.evaluate(() => {
        const win = window as unknown as {
          getTenant: () => { appointments: { id?: string; status?: string; date?: string; clientName?: string; time?: string; serviceName?: string }[]; _privateBookingsLoaded?: boolean };
          renderSchediToday: (tenant: unknown) => void;
          rosterTodayIso: (tenant: unknown) => string;
        };
        const tenant = win.getTenant();
        const today = win.rosterTodayIso(tenant);
        tenant.appointments.push({ id: "HB-BLANK", clientName: "No Status", date: today, time: "11:30 PM", serviceName: "Cut & style" });
        tenant.appointments.push({ id: "HB-PAST-BLANK", clientName: "Past Blank", date: "2026-10-14", time: "09:00 AM", serviceName: "Cut & style" });
        tenant.appointments.push({ id: "HB-PAST-PENDING", clientName: "Past Pending", date: "2026-10-14", time: "10:00 AM", status: "pending", serviceName: "Cut & style" });
        tenant.appointments.push({ id: "HB-LATER-BLANK", clientName: "Later Blank", date: "2099-01-01", time: "09:00 AM", serviceName: "Cut & style" });
        win.renderSchediToday(tenant);
        const waiting = document.getElementById("schediTodayRequests")?.textContent || "";
        const schedule = document.getElementById("schediTodaySchedule")?.textContent || "";
        return {
          waiting: waiting.includes("No Status"),
          schedule: schedule.includes("No Status"),
          pastWaiting: waiting.includes("Past Blank"),
          pastSchedule: schedule.includes("Past Blank"),
          pastPending: waiting.includes("Past Pending"),
          laterWaiting: waiting.includes("Later Blank"),
          laterSchedule: schedule.includes("Later Blank"),
          todayNames: Array.from(document.querySelectorAll("#schediTodaySchedule .sd-row-title")).map((el) => (el.textContent || "").trim()),
        };
      });
      expect(planted.waiting).toBe(true);
      expect(planted.schedule).toBe(true);
      expect(planted.pastWaiting).toBe(false);
      expect(planted.pastSchedule).toBe(false);
      expect(planted.pastPending).toBe(true);
      expect(planted.laterWaiting).toBe(true);
      expect(planted.laterSchedule).toBe(false);
      expect(planted.todayNames).toContain("Maya Chen");
      expect(planted.todayNames).toContain("Jordan Lee · Walk-in");
      expect(planted.todayNames).toContain("No Status");

      const setTheme = async (mode: "light" | "dark") => {
        await page.evaluate((want) => {
          (window as unknown as { setSchediTheme: (mode: string) => void }).setSchediTheme(want);
        }, mode);
      };
      const paint = async (mode: "loading" | "error" | "empty") => {
        await page.evaluate((kind) => {
          const win = window as unknown as {
            getTenant: () => { appointments: unknown[]; _privateBookingsLoaded?: boolean };
            renderTenantRoster: (tenant: unknown) => void;
            setRosterCalendarView: (view: string) => void;
            schediDashGo: (page: string) => void;
            schediSetBookingsLoad: (load: string) => void;
          };
          const tenant = win.getTenant();
          if (kind === "empty") {
            tenant.appointments = [];
            tenant._privateBookingsLoaded = true;
            win.schediSetBookingsLoad("ready");
          } else {
            tenant._privateBookingsLoaded = false;
            win.schediSetBookingsLoad(kind);
          }
          win.setRosterCalendarView("week");
          win.renderTenantRoster(tenant);
          win.schediDashGo("today");
        }, mode);
      };
      const go = async (view: "today" | "appointments" | "list" | "week") => {
        await page.evaluate((next) => {
          const win = window as unknown as {
            schediDashGo: (page: string) => void;
            setRosterCalendarView: (view: string) => void;
          };
          if (next === "list" || next === "week") win.setRosterCalendarView(next);
          win.schediDashGo(next === "today" ? "today" : "appointments");
        }, view);
      };
      const read = async () => page.evaluate(() => {
        const text = (id: string) => document.getElementById(id)?.textContent || "";
        const buttons = Array.from(document.querySelectorAll(".sd-bookings-retry")) as HTMLButtonElement[];
        const retry = buttons.map((btn) => {
          const box = btn.getBoundingClientRect();
          const style = getComputedStyle(btn);
          return {
            height: box.height,
            shown: style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0,
          };
        }).find((btn) => btn.shown) || null;
        return {
          agenda: text("schediNextLine") + text("schediTodayRequests") + text("schediTodaySchedule"),
          calendar: text("rosterCalendarLabel") + text("rosterCalendarWrap"),
          table: text("tenantRosterTableBody"),
          retry,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
      });

      for (const width of [390, 1280]) {
        await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
        for (const theme of ["dark", "light"] as const) {
          await setTheme(theme);
          await paint("loading");
          await go("today");
          const loadingAgenda = await read();
          expect(loadingAgenda.agenda, `${width} ${theme} agenda`).toContain("Loading bookings…");
          expect(loadingAgenda.agenda, `${width} ${theme} agenda`).not.toContain("Nothing is lined up yet");
          expect(loadingAgenda.agenda, `${width} ${theme} agenda`).not.toContain("The book is clear");
          expect(loadingAgenda.overflow, `${width} ${theme} agenda`).toBe(false);
          await go("week");
          const loadingCalendar = await read();
          expect(loadingCalendar.calendar, `${width} ${theme} calendar`).toContain("Loading bookings…");
          expect(loadingCalendar.calendar, `${width} ${theme} calendar`).not.toContain("No appointments");
          expect(loadingCalendar.overflow, `${width} ${theme} calendar`).toBe(false);
          await go("list");
          const loadingTable = await read();
          expect(loadingTable.table, `${width} ${theme} table`).toContain("Loading bookings…");
          expect(loadingTable.table, `${width} ${theme} table`).not.toContain("No client appointments logged yet");
          expect(loadingTable.overflow, `${width} ${theme} table`).toBe(false);

          await paint("error");
          await go("today");
          const failedAgenda = await read();
          expect(failedAgenda.agenda, `${width} ${theme} error`).toContain("Could not load bookings.");
          expect(failedAgenda.agenda, `${width} ${theme} error`).not.toContain("The book is clear");
          expect(failedAgenda.retry && failedAgenda.retry.height, `${width} ${theme} retry`).toBeGreaterThanOrEqual(44);
          expect(failedAgenda.overflow, `${width} ${theme} error`).toBe(false);
          await go("week");
          const failedCalendar = await read();
          expect(failedCalendar.calendar, `${width} ${theme} calendar error`).toContain("Retry");
          expect(failedCalendar.retry && failedCalendar.retry.height, `${width} ${theme} calendar retry`).toBeGreaterThanOrEqual(44);
          await go("list");
          const failedTable = await read();
          expect(failedTable.table, `${width} ${theme} table error`).toContain("Retry");
          expect(failedTable.retry && failedTable.retry.height, `${width} ${theme} table retry`).toBeGreaterThanOrEqual(44);
          expect(failedTable.overflow, `${width} ${theme} table error`).toBe(false);

          await paint("empty");
          await go("today");
          const emptyAgenda = await read();
          expect(emptyAgenda.agenda, `${width} ${theme} empty`).toContain("Nothing is lined up yet");
          expect(emptyAgenda.agenda, `${width} ${theme} empty`).toContain("The book is clear");
          expect(emptyAgenda.agenda, `${width} ${theme} empty`).not.toContain("Loading bookings…");
          await go("week");
          const emptyCalendar = await read();
          expect(emptyCalendar.calendar, `${width} ${theme} empty calendar`).toContain("No appointments");
          expect(emptyCalendar.overflow, `${width} ${theme} empty calendar`).toBe(false);
          await go("list");
          const emptyTable = await read();
          expect(emptyTable.table, `${width} ${theme} empty table`).toContain("No client appointments logged yet");
          expect(emptyTable.overflow, `${width} ${theme} empty table`).toBe(false);
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  }, 120000);

  it("shows HQ loading, Retry, and a zero book at 390 and 1280", async () => {
    const server = await startServer((path) => (path === "/hq" || path === "/hq/" ? "/site/hq.html" : path));
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
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`http://127.0.0.1:${server.port}/hq?demo=1`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.getElementById("hqdStatMonth")?.textContent === "22", { timeout: 20000 });
      const paint = async (kind: "loading" | "error" | "zero") => {
        await page.evaluate((mode) => {
          const win = window as unknown as {
            hqSetCounts: (load: string, counts: Record<string, number> | null, health: Record<string, { month: number; unpaid: number; lastBooking: string }> | null) => void;
            hqDashPaint: () => void;
          };
          if (mode === "zero") {
            win.hqSetCounts("ready", { "harbor-demo": 0, "northwind-demo": 0, "lumen-demo": 0 }, {
              "harbor-demo": { month: 0, unpaid: 0, lastBooking: "" },
              "northwind-demo": { month: 0, unpaid: 0, lastBooking: "" },
              "lumen-demo": { month: 0, unpaid: 0, lastBooking: "" },
            });
          } else {
            win.hqSetCounts(mode, null, null);
          }
          win.hqDashPaint();
        }, kind);
      };
      const show = async (view: "overview" | "directory") => {
        await page.evaluate((next) => {
          (window as unknown as { hqDashGo: (view: string) => void }).hqDashGo(next);
        }, view);
      };
      const read = async () => page.evaluate(() => {
        const text = (id: string) => document.getElementById(id)?.textContent || "";
        const buttons = Array.from(document.querySelectorAll("#hqDash .hqd-retry")) as HTMLButtonElement[];
        const retry = buttons.map((btn) => {
          const box = btn.getBoundingClientRect();
          const style = getComputedStyle(btn);
          return {
            height: box.height,
            shown: style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0,
          };
        }).find((btn) => btn.shown) || null;
        return {
          directory: text("hqdDirList"),
          latest: text("hqdLatest"),
          month: text("hqdStatMonth"),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          retry,
        };
      });
      for (const width of [390, 1280]) {
        await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate((mode) => {
            const light = document.documentElement.classList.contains("schedi-light");
            if ((mode === "light") !== light) (window as unknown as { toggleSchediTheme: () => void }).toggleSchediTheme();
          }, theme);
          await paint("loading");
          await show("directory");
          const loadingDirectory = await read();
          expect(loadingDirectory.directory, `${width} ${theme} directory`).toContain("Loading bookings…");
          expect(loadingDirectory.directory, `${width} ${theme} directory`).not.toContain("None");
          expect(loadingDirectory.overflow, `${width} ${theme} directory`).toBe(false);
          await show("overview");
          const loadingOverview = await read();
          expect(loadingOverview.latest, `${width} ${theme} activity`).toContain("Loading bookings…");
          expect(loadingOverview.month, `${width} ${theme} month`).toBe("…");
          expect(loadingOverview.overflow, `${width} ${theme} overview`).toBe(false);

          await paint("error");
          await show("directory");
          const failedDirectory = await read();
          expect(failedDirectory.directory, `${width} ${theme} error`).toContain("Could not load bookings.");
          expect(failedDirectory.directory, `${width} ${theme} error`).toContain("Retry");
          expect(failedDirectory.retry && failedDirectory.retry.height, `${width} ${theme} retry`).toBeGreaterThanOrEqual(44);
          expect(failedDirectory.overflow, `${width} ${theme} error`).toBe(false);
          await show("overview");
          const failedOverview = await read();
          expect(failedOverview.latest, `${width} ${theme} activity error`).toContain("Retry");
          expect(failedOverview.retry && failedOverview.retry.height, `${width} ${theme} overview retry`).toBeGreaterThanOrEqual(44);

          await paint("zero");
          await show("directory");
          const zeroDirectory = await read();
          expect(zeroDirectory.directory, `${width} ${theme} zero`).toContain("None");
          expect(zeroDirectory.directory, `${width} ${theme} zero`).toContain("0");
          expect(zeroDirectory.directory, `${width} ${theme} zero`).not.toContain("Loading bookings…");
          expect(zeroDirectory.overflow, `${width} ${theme} zero`).toBe(false);
          await show("overview");
          const zeroOverview = await read();
          expect(zeroOverview.month, `${width} ${theme} zero month`).toBe("0");
          expect(zeroOverview.latest, `${width} ${theme} zero activity`).toContain("None");
          expect(zeroOverview.overflow, `${width} ${theme} zero overview`).toBe(false);
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  }, 120000);
});
