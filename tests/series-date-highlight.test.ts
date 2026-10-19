import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
const chrome = ["/usr/local/bin/google-chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/google/chrome/chrome"].find((path) => existsSync(path));

function bookingTemplate(source: string): string {
  const marker = "return `<!DOCTYPE html>";
  const start = source.indexOf(marker);
  const openTick = start + "return ".length;
  const end = source.indexOf("</html>`", openTick);
  return source.slice(openTick, end + "</html>`".length);
}

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

function sliceBetween(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  const stop = source.indexOf(end, at + start.length);
  if (at < 0 || stop < 0) throw new Error("missing slice " + start);
  return source.slice(at, stop);
}

const template = bookingTemplate(html);
const FIRST = "2027-06-15";
const JUNE = "2027-06-22";
const JUNE_OTHER = "2027-06-29";
const JULY = "2027-07-08";
const OPEN = ["09:00 AM", "10:00 AM", "04:00 PM"];

type HighlightApi = {
  add: (iso: string) => void;
  remove: (iso: string) => void;
  stage: (iso: string, time: string) => void;
  confirm: (iso: string) => void;
  setTime: (time: string) => void;
  next: () => void;
  prev: () => void;
  grid: () => string;
  row: () => string;
  stored: (iso: string) => string | undefined;
  month: () => string;
};

function highlightApi(initialTime: string): HighlightApi {
  const openMap: Record<string, string[]> = {
    [JUNE]: OPEN.slice(),
    [JUNE_OTHER]: OPEN.slice(),
    [JULY]: OPEN.slice(),
  };
  return new Function(
    "openMap",
    "initialTime",
    `var window = {};
     var selectedDateStr = ${JSON.stringify(FIRST)};
     var selectedTime = initialTime;
     var customDates = {};
     var customDatePending = {};
     var customDateConfirmed = {};
     var customViewYear = null;
     var customViewMonth = null;
     var seriesTimeChoice = {};
     var seriesSkipped = {};
     var MAX_SERIES_VISITS = 12;
     var tenantData = {};
     var grid = { innerHTML: "" };
     var title = { textContent: "" };
     var note = { textContent: "" };
     var list = { innerHTML: "" };
     var document = {
       getElementById: function (id) {
         if (id === "customDatesGrid") return grid;
         if (id === "customMonthTitle") return title;
         if (id === "customDatesCountNote") return note;
         if (id === "customDatesList") return list;
         return null;
       }
     };
     function bizTodayIso() { return "2026-10-01"; }
     function localISODate() { return "2026-10-01"; }
     function resolveHoursForDate() { return { closed: false, ranges: [] }; }
     function isDateFullyBlocked() { return null; }
     function openTimesForDate(date) { return (openMap[date] || []).slice(); }
     function updateRecurrencePreview() { renderCustomDatesPicker(); }
     ${extractFunction(template, "escHtml")}
     ${extractFunction(template, "prettyDatePub")}
     ${extractFunction(template, "seriesDateRowHtml")}
     ${extractFunction(template, "renderCustomDatesPicker")}
     ${sliceBetween(template, "function clearCustomDate", "window.updateRecurrencePreview")}
     renderCustomDatesPicker();
     return {
       add: function (iso) { window.toggleCustomDate(iso); },
       remove: function (iso) { window.removeSeriesVisit(iso); },
       stage: function (iso, time) { window.stageVisitTime(iso, time); },
       confirm: function (iso) { window.confirmVisitTime(iso); },
       setTime: function (time) { selectedTime = time; },
       next: function () { window.customNextMonth(); },
       prev: function () { window.customPrevMonth(); },
       grid: function () { return grid.innerHTML; },
       row: function () { return list.innerHTML; },
       stored: function (iso) { return Object.prototype.hasOwnProperty.call(customDates, iso) ? customDates[iso] : undefined; },
       month: function () { return title.textContent; }
     };`,
  )(openMap, initialTime) as HighlightApi;
}

function dayButton(grid: string, iso: string): string {
  const marker = "toggleCustomDate('" + iso + "')";
  const at = grid.indexOf(marker);
  expect(at, iso).toBeGreaterThanOrEqual(0);
  const open = grid.lastIndexOf("<button", at);
  const close = grid.indexOf("</button>", at);
  return grid.slice(open, close);
}

describe("multi-date calendar highlight", () => {
  it("highlights every chosen date even when no time is stored yet", () => {
    for (const source of [html, hq]) {
      const body = extractFunction(bookingTemplate(source), "renderCustomDatesPicker");
      expect(body).toContain("Object.prototype.hasOwnProperty.call(customDates, iso)");
      expect(body).not.toContain("!!customDates[iso]");
    }

    const page = highlightApi("");
    expect(page.month()).toBe("June 2027");
    page.add(JUNE);
    page.add(JUNE_OTHER);
    expect(page.stored(JUNE)).toBe("");
    expect(page.stored(JUNE_OTHER)).toBe("");

    const june = page.grid();
    for (const iso of [JUNE, JUNE_OTHER]) {
      const button = dayButton(june, iso);
      expect(button).toContain("cal-day-selected");
      expect(button).toContain('aria-pressed="true"');
      expect(button).toContain(">Added<");
      expect(button).not.toContain("disabled");
    }
    const first = dayButton(june, FIRST);
    expect(first).toContain("cal-day-special");
    expect(first).not.toContain("cal-day-selected");

    const untouched = dayButton(june, "2027-06-23");
    expect(untouched).toContain("cal-day-open");
    expect(untouched).not.toContain("cal-day-selected");

    page.add(JULY);
    expect(page.month()).toBe("June 2027");
    page.next();
    expect(page.month()).toBe("July 2027");
    const july = dayButton(page.grid(), JULY);
    expect(july).toContain("cal-day-selected");
    expect(july).toContain('aria-pressed="true"');
    page.prev();
    expect(page.month()).toBe("June 2027");
    const back = page.grid();
    expect(dayButton(back, JUNE)).toContain("cal-day-selected");
    expect(dayButton(back, JUNE_OTHER)).toContain("cal-day-selected");
    expect(page.stored(JUNE)).toBe("");

    page.remove(JUNE);
    expect(page.stored(JUNE)).toBeUndefined();
    expect(dayButton(page.grid(), JUNE)).toContain("cal-day-open");
    expect(dayButton(page.grid(), JUNE_OTHER)).toContain("cal-day-selected");
  });

  it("keeps the Remove button and the Use this time confirm while the date stays highlighted", () => {
    const page = highlightApi("02:00 PM");
    page.add(JUNE);
    expect(page.stored(JUNE)).toBe("02:00 PM");
    expect(dayButton(page.grid(), JUNE)).toContain("cal-day-selected");
    const flagged = page.row();
    expect(flagged).toContain("Not available at 02:00 PM");
    expect(flagged).toContain(">Remove</button>");
    expect(flagged).not.toContain(">Use this time</button>");
    expect(flagged).not.toContain("02:00 PM (not available)");

    page.stage(JUNE, "04:00 PM");
    const choosing = page.row();
    expect(choosing).toContain(">Use this time</button>");
    expect(choosing).toContain(">Remove</button>");
    expect(choosing).toContain("Not available at 02:00 PM");
    expect(dayButton(page.grid(), JUNE)).toContain("cal-day-selected");
    expect(page.stored(JUNE)).toBe("02:00 PM");

    page.confirm(JUNE);
    expect(page.stored(JUNE)).toBe("04:00 PM");
    expect(page.row()).toContain("Confirmed at 04:00 PM");
    expect(page.row()).not.toContain(">Use this time</button>");
    expect(page.row()).toContain(">Remove</button>");
    expect(dayButton(page.grid(), JUNE)).toContain("cal-day-selected");

    page.next();
    page.prev();
    expect(dayButton(page.grid(), JUNE)).toContain("cal-day-selected");
  });
});

describe.skipIf(!chrome)("multi-date selected highlight paint", () => {
  it("paints the selected green in light and dark, including the new booking frame", async () => {
    const start = template.indexOf("/* booking-day-contrast */");
    const end = template.indexOf("/* /booking-day-contrast */");
    const css = template.slice(start, end) + `
      html.schedi-newbook .cal-day { border-radius: 12px; min-height: 3.4rem; }
    `;
    expect(css).toContain(".cal-day-selected { background: #047857;");
    expect(css).toContain("html.schedi-light .cal-day-selected { background: #047857;");
    expect(css).not.toMatch(/html\.schedi-newbook \.cal-day \{[^}]*background/);

    const page = highlightApi("");
    page.add(JUNE);
    page.add(JULY);
    const june = page.grid();
    page.next();
    const july = page.grid();
    page.prev();
    const returned = page.grid();

    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
    try {
      const view = await browser.newPage();
      for (const klass of ["", "schedi-light", "schedi-newbook", "schedi-light schedi-newbook"]) {
        for (const [label, markup] of [["june", june], ["july", july], ["returned", returned]] as const) {
          await view.setContent(`<!DOCTYPE html><html class="${klass}"><head><style>${css}</style></head><body><div id="customDatesGrid">${markup}</div></body></html>`);
          const paint = await view.evaluate((iso) => {
            const button = [...document.querySelectorAll("button")].find((el) => (el.getAttribute("onclick") || "").indexOf(iso) !== -1);
            if (!button) return null;
            const style = getComputedStyle(button);
            return {
              selected: button.classList.contains("cal-day-selected"),
              background: style.backgroundColor,
              color: style.color,
            };
          }, label === "july" ? JULY : JUNE);
          expect(paint, klass + " " + label).not.toBeNull();
          expect(paint?.selected, klass + " " + label).toBe(true);
          expect(paint?.background, klass + " " + label).toBe("rgb(4, 120, 87)");
          expect(paint?.color, klass + " " + label).toBe("rgb(255, 255, 255)");
        }
      }
    } finally {
      await browser.close();
    }
  });
});
