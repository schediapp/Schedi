import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

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

function dashCss(source: string): string {
  const marker = '<style id="schediNewDashStyle">';
  const start = source.indexOf(marker);
  const end = source.indexOf("</style>", start);
  return source.slice(start, end);
}

describe("owner dashboard fixes", () => {
  it("defaults hours to the week layout and migrates an old saved choice once", () => {
    const store = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
    };
    const api = new Function(
      "localStorage",
      `var HOURS_LAYOUT_EPOCH = 'schediWeekHoursEpoch';
       var HOURS_LAYOUT_EPOCH_VALUE = '2';
       ${extractFunction(html, "hoursWeekMigrateStored")}
       ${extractFunction(html, "hoursWeekLayoutFromEnv")}
       return { hoursWeekMigrateStored, hoursWeekLayoutFromEnv };`,
    )(localStorage) as {
      hoursWeekMigrateStored: () => void;
      hoursWeekLayoutFromEnv: (search: string, stored: string | null) => boolean;
    };
    expect(api.hoursWeekLayoutFromEnv("", null)).toBe(true);
    expect(api.hoursWeekLayoutFromEnv("", "0")).toBe(false);
    expect(api.hoursWeekLayoutFromEnv("", "1")).toBe(true);
    expect(api.hoursWeekLayoutFromEnv("?weekhours=0", null)).toBe(false);
    store.set("schediWeekHours", "0");
    api.hoursWeekMigrateStored();
    expect(store.get("schediWeekHours")).toBeUndefined();
    expect(store.get("schediWeekHoursEpoch")).toBe("2");
    store.set("schediWeekHours", "0");
    api.hoursWeekMigrateStored();
    expect(store.get("schediWeekHours")).toBe("0");
    expect(extractFunction(html, "hoursWeekLayoutOn")).toContain("hoursWeekMigrateStored()");
    const css = dashCss(html);
    expect(css).toContain(".roster-ref-id");
    expect(css).toContain("grid-row: 2");
    expect(css).toContain("width: 9.25rem");
    expect(css).not.toContain("min-width: 1080px");
    expect(css).toContain("@media (max-width: 1199px)");
    expect(css).toContain(".sd-gateway-paypal { color: #0070E0; }");
    expect(css).toContain(".sd-gateway-paypal { color: #003087; }");
    expect(css).toContain("#webPushCard.wp-card-hit");
    expect(html).toContain('class="fa-brands fa-paypal sd-gateway-paypal text-lg"');
    expect(html).toContain("st === 'on' ? 'fa-bell' : 'fa-bell-slash'");
    const pushStart = html.indexOf("Schedi owner booking alerts");
    const push = html.slice(pushStart, html.indexOf("window.schediWebPushToggle", pushStart));
    expect(push.indexOf("window.schediOpenBookingAlerts")).toBeLessThan(push.indexOf("if (window.__SCHEDI_DEMO) return"));
    expect(push).toContain("schediDashGo('emails')");
  });
});

function startServer() {
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

describe.skipIf(!chrome)("owner dashboard fixes in the browser", () => {
  it("keeps long ref ids inside their column, opens booking alerts, brands PayPal, and starts hours on week", async () => {
    const server = await startServer();
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const errors: string[] = [];
    const overlaps = (a: { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }) => {
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return width > 1 && height > 1;
    };
    try {
      const page = await browser.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      const openDash = async (search = "") => {
        await page.goto(`http://127.0.0.1:${server.port}/portal-preview${search}`, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      };
      const setTheme = async (mode: "light" | "dark") => {
        await page.evaluate((want) => {
          const light = document.documentElement.classList.contains("schedi-light");
          if ((want === "light") !== light) (window as unknown as { toggleSchediTheme: () => void }).toggleSchediTheme();
        }, mode);
      };
      const plantRefs = async () => {
        await page.evaluate(() => {
          const w = window as unknown as {
            getTenant: () => { appointments: { id: string; payCode?: string; clientName?: string }[] };
            setRosterPayFilter: (kind: string) => void;
            schediDashGo: (page: string) => void;
          };
          w.schediDashGo("appointments");
          const row = document.querySelector("#tenantRosterTableBody tr.roster-row");
          const current = row?.getAttribute("data-booking-id") || "";
          const tenant = w.getTenant();
          const app = tenant.appointments.find((item) => item.id === current) || tenant.appointments[0];
          app.id = "BK-CB126C75";
          app.payCode = "";
          app.clientName = "Christopher Montgomery-Bennett";
          const copy = { ...app, id: "BK-A1B2C3D4E5F6-RESCHED-0042", clientName: "Christopher Montgomery-Bennett", payCode: "", status: "pending" };
          tenant.appointments.push(copy);
          w.setRosterPayFilter("all");
        });
        await page.waitForSelector('[data-booking-id="BK-CB126C75"] .roster-ref-id', { timeout: 10000 });
      };
      const measureRefs = () => page.evaluate(() => {
        const box = (el: Element) => {
          const rect = el.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        const read = (id: string) => {
          const row = [...document.querySelectorAll("#tenantRosterTableBody tr.roster-row")].find((el) => el.getAttribute("data-booking-id") === id);
          const ref = row?.querySelector(".roster-ref-id") as HTMLElement | null;
          const client = row?.querySelector(".roster-client-name") as HTMLElement | null;
          const cell = row?.querySelector(".roster-cell-ref") as HTMLElement | null;
          if (!ref || !client || !cell) return null;
          const style = getComputedStyle(ref);
          return {
            text: ref.textContent || "",
            title: ref.getAttribute("title") || "",
            scroll: ref.scrollWidth,
            clientWidth: ref.clientWidth,
            whiteSpace: style.whiteSpace,
            wordBreak: style.wordBreak,
            lines: ref.getClientRects().length,
            ref: box(ref),
            name: box(client),
            cell: box(cell),
            gridRow: getComputedStyle(cell).gridRow,
          };
        };
        const today = document.getElementById("schediTodaySchedule");
        const todayOverflow = today ? today.scrollWidth > today.clientWidth + 1 : false;
        return {
          standard: read("BK-CB126C75"),
          long: read("BK-A1B2C3D4E5F6-RESCHED-0042"),
          todayText: today?.textContent || "",
          todayOverflow,
        };
      });

      await openDash();
      await plantRefs();
      const widthReport: Record<string, { wrap: number; table: number }> = {};
      for (const width of [1100, 1180, 1200, 1280, 1440, 1920]) {
        await page.setViewport({ width, height: 900 });
        for (const mode of ["dark", "light"] as const) {
          await setTheme(mode);
          const measured = await measureRefs();
          const fit = await page.evaluate(() => {
            const wrap = document.getElementById("rosterListWrap") as HTMLElement;
            const table = wrap.querySelector("table") as HTMLElement;
            const actions = document.querySelector('[data-booking-id="BK-A1B2C3D4E5F6-RESCHED-0042"] .roster-actions') as HTMLElement;
            const name = document.querySelector('[data-booking-id="BK-CB126C75"] .roster-client-name-text') as HTMLElement;
            const date = document.querySelector('[data-booking-id="BK-CB126C75"] .roster-cell-when span') as HTMLElement | null;
            const price = document.querySelector('[data-booking-id="BK-CB126C75"] .roster-cell-price') as HTMLElement | null;
            const wrapBox = wrap.getBoundingClientRect();
            const actionBox = actions.getBoundingClientRect();
            return {
              wrap: wrap.clientWidth,
              table: Math.round(table.getBoundingClientRect().width),
              scroll: wrap.scrollWidth,
              actionsInside: actionBox.right <= wrapBox.right + 1 && actionBox.left >= wrapBox.left - 1,
              nameText: name.textContent || "",
              nameScroll: name.scrollWidth,
              nameClient: name.clientWidth,
              dateCut: date ? date.scrollWidth > date.clientWidth + 1 : false,
              priceCut: price ? price.scrollWidth > price.clientWidth + 1 : false,
            };
          });
          if (mode === "dark") widthReport[String(width)] = { wrap: fit.wrap, table: fit.table };
          const label = `${width} ${mode}`;
          expect(fit.scroll, label).toBeLessThanOrEqual(fit.wrap + 1);
          expect(fit.table, label).toBeLessThanOrEqual(fit.wrap + 1);
          expect(fit.actionsInside, label).toBe(true);
          if (width >= 1200) {
            expect(fit.dateCut, label).toBe(false);
            expect(fit.priceCut, label).toBe(false);
          }
          expect(measured.standard, label).toBeTruthy();
          expect(measured.standard?.text).toBe("#BK-CB126C75");
          expect(measured.standard!.scroll, label).toBeLessThanOrEqual(measured.standard!.clientWidth + 1);
          expect(measured.standard?.whiteSpace).toBe("nowrap");
          expect(overlaps(measured.standard!.ref, measured.standard!.name), label).toBe(false);
          expect(measured.long?.text).toBe("#BK-A1B2C3D4E5F6-RESCHED-0042");
          expect(measured.long?.title).toBe("#BK-A1B2C3D4E5F6-RESCHED-0042");
          expect(measured.long?.whiteSpace).toBe("nowrap");
          expect(measured.long?.lines).toBe(1);
          expect(overlaps(measured.long!.ref, measured.long!.name), label).toBe(false);
          expect(fit.nameText).toBe("Christopher Montgomery-Bennett");
          if (width >= 1200) {
            expect(measured.long!.scroll, label).toBeGreaterThan(measured.long!.clientWidth);
            expect(measured.long!.cell.right, label).toBeLessThanOrEqual(measured.long!.name.left + 1);
            if (width < 1600) expect(fit.nameScroll, label).toBeGreaterThan(fit.nameClient);
            else expect(fit.nameScroll, label).toBeLessThanOrEqual(fit.nameClient + 1);
          } else {
            expect(measured.standard?.gridRow.startsWith("2"), label).toBe(true);
            expect(measured.standard!.ref.top, label).toBeGreaterThanOrEqual(measured.standard!.name.bottom - 1);
          }
        }
      }
      console.log("roster widths", JSON.stringify(widthReport));

      await page.setViewport({ width: 800, height: 900 });
      await setTheme("dark");
      const stacked = await measureRefs();
      expect(stacked.standard?.gridRow.startsWith("2")).toBe(true);
      expect(stacked.standard!.ref.top).toBeGreaterThanOrEqual(stacked.standard!.name.bottom - 1);
      expect(overlaps(stacked.standard!.ref, stacked.standard!.name)).toBe(false);
      expect(stacked.standard!.scroll).toBeLessThanOrEqual(stacked.standard!.clientWidth + 1);
      expect(stacked.long?.text).toBe("#BK-A1B2C3D4E5F6-RESCHED-0042");
      expect(stacked.long?.whiteSpace).toBe("nowrap");
      expect(stacked.long?.lines).toBe(1);
      expect(stacked.long!.scroll).toBeLessThanOrEqual(stacked.long!.clientWidth + 1);
      expect(overlaps(stacked.long!.ref, stacked.long!.name)).toBe(false);
      await page.evaluate(() => (window as unknown as { schediDashGo: (page: string) => void }).schediDashGo("today"));
      const today = await page.evaluate(() => {
        const root = document.getElementById("schediTodaySchedule");
        const cards = [...(root?.querySelectorAll("article") || [])];
        return {
          text: root?.textContent || "",
          cards: cards.length,
          overflow: cards.filter((card) => card.scrollWidth > card.clientWidth + 1).length,
        };
      });
      expect(today.cards).toBeGreaterThan(0);
      expect(today.text).not.toContain("BK-CB126C75");
      expect(today.overflow).toBe(0);

      await page.setViewport({ width: 1280, height: 900 });
      await page.evaluate(() => (window as unknown as { schediDashGo: (page: string) => void }).schediDashGo("appointments"));
      await page.evaluate(() => {
        const button = document.getElementById("rosterAlertsBtn");
        if (button) button.style.display = "inline-flex";
      });
      await page.click("#rosterAlertsBtn");
      await page.waitForFunction(() => {
        const card = document.getElementById("webPushCard");
        return document.getElementById("tenantPortalSection")?.getAttribute("data-dash") === "emails"
          && !!card
          && !card.classList.contains("hidden")
          && card.classList.contains("wp-card-hit");
      }, { timeout: 5000 });
      const alerts = await page.evaluate(() => {
        const card = document.getElementById("webPushCard") as HTMLElement;
        const style = getComputedStyle(card);
        const box = card.getBoundingClientRect();
        return {
          dash: document.getElementById("tenantPortalSection")?.getAttribute("data-dash"),
          display: style.display,
          height: box.height,
          title: document.getElementById("webPushTitle")?.textContent || "",
          shadow: style.boxShadow,
        };
      });
      expect(alerts.dash).toBe("emails");
      expect(alerts.display).not.toBe("none");
      expect(alerts.height).toBeGreaterThan(40);
      expect(alerts.title).toBe("Booking alerts");
      expect(alerts.shadow).not.toBe("none");

      await page.evaluate(() => (window as unknown as { schediDashGo: (page: string) => void }).schediDashGo("payments"));
      await page.waitForSelector("#tenantPayPaypalCheck", { timeout: 10000 });
      for (const mode of ["dark", "light"] as const) {
        await setTheme(mode);
        const paypal = await page.evaluate(() => {
          const box = document.getElementById("tenantPayPaypalCheck") as HTMLInputElement;
          const icon = document.querySelector(".sd-gateway-paypal") as HTMLElement;
          const square = document.getElementById("tenantPaySquareCheck") as HTMLInputElement;
          const color = (value: string) => value.replace(/\s+/g, "");
          return {
            disabled: box.disabled,
            opacity: getComputedStyle(box).opacity,
            cursor: getComputedStyle(box).cursor,
            icon: color(getComputedStyle(icon).color),
            squareDisabled: square.disabled,
            squareOpacity: getComputedStyle(square).opacity,
          };
        });
        expect(paypal.disabled).toBe(false);
        expect(paypal.opacity).toBe("1");
        expect(paypal.cursor).toBe("pointer");
        expect(paypal.icon).toBe(mode === "dark" ? "rgb(0,112,224)" : "rgb(0,48,135)");
        expect(paypal.squareDisabled).toBe(false);
        expect(Number(paypal.squareOpacity)).toBeCloseTo(1, 2);
      }
      await setTheme("dark");
      await page.click("#tenantPayPaypalCheck");
      const turnedOn = await page.evaluate(() => {
        const box = document.getElementById("tenantPayPaypalCheck") as HTMLInputElement;
        return { checked: box.checked, background: getComputedStyle(box).backgroundColor.replace(/\s+/g, "") };
      });
      expect(turnedOn.checked).toBe(true);
      expect(turnedOn.background).toBe("rgb(16,185,129)");

      const hoursPage = await browser.newPage();
      hoursPage.on("pageerror", (error) => errors.push(String(error)));
      await hoursPage.evaluateOnNewDocument(() => {
        try {
          localStorage.removeItem("schediWeekHours");
          localStorage.removeItem("schediWeekHoursEpoch");
        } catch (errStore) {}
      });
      for (const width of [390, 1280]) {
        await hoursPage.setViewport({ width, height: 900 });
        for (const mode of ["dark", "light"] as const) {
          await hoursPage.goto(`http://127.0.0.1:${server.port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
          await hoursPage.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
          await hoursPage.evaluate((want) => {
            const light = document.documentElement.classList.contains("schedi-light");
            if ((want === "light") !== light) (window as unknown as { toggleSchediTheme: () => void }).toggleSchediTheme();
          }, mode);
          await hoursPage.evaluate(() => (window as unknown as { schediDashGo: (page: string) => void }).schediDashGo("hours"));
          await hoursPage.waitForSelector(".sd-hours-week-day", { timeout: 10000 });
          const week = await hoursPage.evaluate(() => ({
            pressed: document.getElementById("hoursWeekLayoutBtn")?.getAttribute("aria-pressed"),
            days: document.querySelectorAll(".sd-hours-week-day").length,
            stored: localStorage.getItem("schediWeekHours"),
            epoch: localStorage.getItem("schediWeekHoursEpoch"),
          }));
          expect(week.pressed, `${width} ${mode}`).toBe("true");
          expect(week.days).toBe(7);
          expect(week.stored).toBeNull();
          expect(week.epoch).toBe("2");
        }
      }

      const migrated = await browser.newPage();
      migrated.on("pageerror", (error) => errors.push(String(error)));
      await migrated.evaluateOnNewDocument(() => {
        try {
          localStorage.setItem("schediWeekHours", "0");
          localStorage.removeItem("schediWeekHoursEpoch");
        } catch (errStore) {}
      });
      await migrated.setViewport({ width: 1280, height: 900 });
      await migrated.goto(`http://127.0.0.1:${server.port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await migrated.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await migrated.evaluate(() => (window as unknown as { schediDashGo: (page: string) => void }).schediDashGo("hours"));
      await migrated.waitForSelector(".sd-hours-week-day", { timeout: 10000 });
      const cleared = await migrated.evaluate(() => ({
        pressed: document.getElementById("hoursWeekLayoutBtn")?.getAttribute("aria-pressed"),
        stored: localStorage.getItem("schediWeekHours"),
        epoch: localStorage.getItem("schediWeekHoursEpoch"),
      }));
      expect(cleared.pressed).toBe("true");
      expect(cleared.stored).toBeNull();
      expect(cleared.epoch).toBe("2");

      const remembered = await browser.newPage();
      remembered.on("pageerror", (error) => errors.push(String(error)));
      await remembered.evaluateOnNewDocument(() => {
        try {
          localStorage.setItem("schediWeekHoursEpoch", "2");
          localStorage.setItem("schediWeekHours", "0");
        } catch (errStore) {}
      });
      await remembered.goto(`http://127.0.0.1:${server.port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await remembered.waitForFunction(() => document.body.classList.contains("schedi-newdash"), { timeout: 20000 });
      await remembered.evaluate(() => (window as unknown as { schediDashGo: (page: string) => void }).schediDashGo("hours"));
      await remembered.waitForSelector(".sd-hours-day", { timeout: 10000 });
      const list = await remembered.evaluate(() => ({
        pressed: document.getElementById("hoursWeekLayoutBtn")?.getAttribute("aria-pressed"),
        days: document.querySelectorAll(".sd-hours-day").length,
        stored: localStorage.getItem("schediWeekHours"),
      }));
      expect(list.pressed).toBe("false");
      expect(list.days).toBe(7);
      expect(list.stored).toBe("0");
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  }, 120000);
});
