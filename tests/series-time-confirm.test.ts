import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/google/chrome/chrome"].find((path) => existsSync(path));

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

function runtimeSource(source: string): string {
  return source.replace(/\\\\/g, "\\");
}

function sliceBetween(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  const stop = source.indexOf(end, at + start.length);
  if (at < 0 || stop < 0) throw new Error("missing slice " + start);
  return source.slice(at, stop);
}

const template = bookingTemplate(html);
const FIRST = "2027-06-15";
const EXTRA = "2027-06-22";
const OPEN = ["09:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "04:00 PM"];

function contrast(fg: string, bg: string): number {
  const lum = (hex: string) => {
    const n = hex.replace("#", "");
    const chan = [0, 2, 4].map((i) => {
      const c = parseInt(n.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
  };
  const lighter = Math.max(lum(fg), lum(bg));
  const darker = Math.min(lum(fg), lum(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

type VisitApi = {
  add: (iso: string) => void;
  stage: (iso: string, time: string) => void;
  confirm: (iso: string, time?: string) => void;
  remove: (iso: string) => void;
  reason: () => string;
  entries: (freq?: string) => Array<{ date: string; time: string }>;
  times: (freq?: string) => Array<string | undefined>;
  row: () => string;
  blocked: () => boolean;
  setOpen: (iso: string, times: string[]) => void;
  setFreq: (freq: string) => void;
};

function visitApi(): VisitApi {
  const openMap: Record<string, string[]> = { [EXTRA]: OPEN.slice() };
  let freqNow = "custom";
  const button = {
    disabled: false,
    attrs: {} as Record<string, string>,
    getAttribute(name: string) { return this.attrs[name] || null; },
    setAttribute(name: string, value: string) { this.attrs[name] = value; },
    removeAttribute(name: string) { delete this.attrs[name]; },
  };
  const note = {
    textContent: "",
    classList: {
      toggle(name: string, force?: boolean) {
        if (name === "hidden") note.hidden = force == null ? !note.hidden : force;
      },
    },
    hidden: true,
  };
  const list = { innerHTML: "" };
  const document = {
    getElementById(id: string) {
      if (id === "pubSubmitBtn") return button;
      if (id === "seriesTimeBlock") return note;
      if (id === "customDatesList") return list;
      return null;
    },
  };
  const api = new Function(
    "document",
    "openMap",
    `var window = {};
     var selectedDateStr = ${JSON.stringify(FIRST)};
     var selectedTime = "02:00 PM";
     var customDates = {};
     var customDatePending = {};
     var customDateConfirmed = {};
     var seriesTimeChoice = {};
     var seriesSkipped = {};
     var MAX_SERIES_VISITS = 12;
     var freqNow = "custom";
     function openTimesForDate(date) { return (openMap[date] || []).slice(); }
     function getSelectedRecurrenceFreq() { return freqNow; }
     function getSelectedRecurrenceCount() { return 2; }
     function recurrenceEnabled() { return true; }
     function updateRecurrencePreview() {
       var list = document.getElementById("customDatesList");
       if (list && getSelectedRecurrenceFreq() === "custom") {
         list.innerHTML = Object.keys(customDates).sort().map(function (d) {
           return seriesDateRowHtml(d, customDates[d], customDatePending[d] || "", !!customDateConfirmed[d]);
         }).join("");
       }
       paintSeriesSubmitGate();
     }
     ${extractFunction(template, "escHtml")}
     ${extractFunction(template, "localISODate")}
     ${extractFunction(template, "addDaysISO")}
     ${extractFunction(template, "addMonthsISO")}
     ${extractFunction(template, "generateRecurringDates")}
     ${extractFunction(template, "prettyDatePub")}
     ${extractFunction(template, "buildSeriesEntries")}
     ${extractFunction(template, "confirmedSeriesTimes")}
     ${extractFunction(template, "syncGeneratedSeriesChoices")}
     ${extractFunction(template, "seriesUnresolvedReason")}
     ${extractFunction(template, "paintSeriesSubmitGate")}
     ${extractFunction(template, "seriesDateRowHtml")}
     ${sliceBetween(template, "function clearCustomDate", "window.customPrevMonth")}
     return {
       add: function (iso) { freqNow = "custom"; window.toggleCustomDate(iso); },
       stage: function (iso, time) { window.stageVisitTime(iso, time); },
       confirm: function (iso) { window.confirmVisitTime(iso); },
       remove: function (iso) { window.removeSeriesVisit(iso); },
       reason: function () { return seriesUnresolvedReason(); },
       entries: function (freq) { if (freq) freqNow = freq; return buildSeriesEntries(freq || freqNow); },
       times: function (freq) { return confirmedSeriesTimes(buildSeriesEntries(freq || freqNow)); },
       row: function () { return document.getElementById("customDatesList").innerHTML; },
       blocked: function () { return document.getElementById("pubSubmitBtn").disabled; },
       setOpen: function (iso, times) { openMap[iso] = times.slice(); },
       setFreq: function (freq) { freqNow = freq; }
     };`,
  )(document, openMap) as VisitApi;
  return api;
}

describe("series replacement times", () => {
  it("resolves an unavailable date only after Use this time, and blocks submit until then", () => {
    const page = visitApi();
    page.add(EXTRA);
    const flagged = page.row();
    expect(flagged).toContain("Not available at 02:00 PM");
    expect(flagged).not.toContain(">Use this time</button>");
    for (const slot of OPEN) expect(flagged).toContain('value="' + slot + '"');
    expect(flagged).not.toContain('value="02:00 PM"');
    expect(flagged).not.toContain("02:00 PM (not available)");
    expect(page.reason()).toBe("Pick an available time for " + new Date(2027, 5, 22).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + ".");
    expect(page.blocked()).toBe(true);

    page.stage(EXTRA, "04:00 PM");
    const choosing = page.row();
    expect(choosing).toContain("Not available at 02:00 PM");
    expect(choosing).toContain(">Use this time</button>");
    expect(choosing).toContain('value="04:00 PM" selected');
    expect(page.blocked()).toBe(true);
    expect(page.times("custom")[1]).toBe("02:00 PM");

    page.confirm(EXTRA);
    const done = page.row();
    expect(done).toContain("is-confirmed");
    expect(done).toContain("Confirmed at 04:00 PM");
    expect(done).not.toContain(">Use this time</button>");
    expect(done).not.toContain("Not available at 02:00 PM");
    expect(page.reason()).toBe("");
    expect(page.blocked()).toBe(false);
    expect(page.times("custom")).toEqual(["02:00 PM", "04:00 PM"]);
  });

  it("keeps the book button blocked until the replacement is confirmed or the date is removed", () => {
    const page = visitApi();
    page.add(EXTRA);
    expect(page.blocked()).toBe(true);
    page.remove(EXTRA);
    expect(page.row()).toBe("");
    expect(page.reason()).toBe("");
    expect(page.blocked()).toBe(false);
  });

  it("puts the confirmed per-date time on each booking, the email line, and the summary", () => {
    const page = visitApi();
    page.add(EXTRA);
    page.stage(EXTRA, "04:00 PM");
    page.confirm(EXTRA);
    const entries = page.entries("custom");
    expect(entries).toEqual([
      { date: FIRST, time: "02:00 PM" },
      { date: EXTRA, time: "04:00 PM" },
    ]);
    expect(page.times("custom")).toEqual(["02:00 PM", "04:00 PM"]);
    const submit = sliceBetween(template, "window.handlePublicBookingSubmit = function", "function syncBookingsToFirestore");
    expect(submit).toContain("var seriesBlock = seriesUnresolvedReason();");
    expect(submit.indexOf("seriesUnresolvedReason()")).toBeLessThan(submit.indexOf("var seriesEntries = buildSeriesEntries(recFreq);"));
    expect(submit).toContain("times: confirmedSeriesTimes(seriesEntries)");
    expect(submit).toContain("time: confirmedSeriesTimes(seriesEntries)[idx] || selectedTime");
    expect(template).toContain("var tm = (rec.times && rec.times[di]) || booking.time;");
    expect(template).toContain("seriesEntries.map(function (en) { return en.date + ' @ ' + en.time; })");
    expect(hq).toContain("times: confirmedSeriesTimes(seriesEntries)");
    expect(hq).toContain(">Use this time</button>");
  });

  it("lists only that day's open slots, dropping hours, duration, and the buffer", () => {
    const hours: Record<string, { open: boolean; start: string; end: string }> = {};
    for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      hours[day] = day === "Sun"
        ? { open: false, start: "09:00 AM", end: "05:00 PM" }
        : { open: true, start: "09:00 AM", end: "05:00 PM" };
    }
    const tenantData = {
      timezone: "America/New_York",
      slotInterval: 60,
      appointmentBufferMins: 15,
      minNoticeHours: 0,
      operatingHours: hours,
      blockedTimes: [],
      blockedRules: [],
      services: [{ id: "cut", name: "Cut", duration: "60 min" }],
      publicSlots: [{ date: "2027-06-15", time: "02:00 PM", durationMins: 60, cancelled: false, status: "confirmed", serviceName: "Cut" }],
    };
    const open = new Function(
      "tenantData",
      `function cartDurationMins() { return duration; }
       var duration = 60;
       ${runtimeSource([
         "toMinutes", "fromMinutes", "closedOnLabel", "resolveHoursForDate", "timeWithinResolvedRanges", "getSlotIntervalMins",
         "parseDurationMins", "overlaps", "appointmentBufferMins", "bufferedOverlap", "dateInBlockedRange",
         "dateBlockConflictReason", "isDateFullyBlocked", "getPubTimezone", "localISODate", "zonedNow",
         "getMinNoticeHoursPub", "slotInsideNotice", "noticeReasonText", "appointmentSpanMins",
         "slotConflictReason", "openTimesForDate",
       ].map((name) => extractFunction(template, name)).join("\n"))}
       return function (date, mins, buffer) {
         duration = mins;
         tenantData.appointmentBufferMins = buffer;
         return openTimesForDate(date);
       };`,
    )(tenantData) as (date: string, mins: number, buffer: number) => string[];

    const withBuffer = open("2027-06-15", 60, 15);
    expect(withBuffer).not.toContain("02:00 PM");
    expect(withBuffer).not.toContain("01:00 PM");
    expect(withBuffer).not.toContain("03:00 PM");
    expect(withBuffer).toContain("12:00 PM");
    expect(withBuffer).toContain("04:00 PM");
    expect(withBuffer.every((slot) => slot >= "09:00 AM" || slot.includes("AM") || slot.includes("PM"))).toBe(true);

    const noBuffer = open("2027-06-15", 60, 0);
    expect(noBuffer).toContain("01:00 PM");
    expect(noBuffer).toContain("03:00 PM");
    expect(noBuffer).not.toContain("02:00 PM");

    const longVisit = open("2027-06-16", 120, 0);
    expect(longVisit).not.toContain("04:00 PM");
    expect(longVisit).toContain("03:00 PM");

    expect(open("2027-06-20", 60, 15)).toEqual([]);
  });

  it("keeps the confirm action and the block reason at AA contrast", () => {
    expect(contrast("#ffffff", "#047857")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#6ee7b7", "#0f1728")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#047857", "#ecfdf5")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#fecdd3", "#4c0519")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#9f1239", "#fff1f2")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#be123c", "#fff1f2")).toBeGreaterThanOrEqual(4.5);
    for (const source of [html, hq]) {
      expect(source).toContain(".series-date-confirm {");
      expect(source).toContain("color: #ffffff");
      expect(source).toContain("background: #047857");
      expect(source).toContain("html.schedi-light.schedi-newbook .series-date-confirm");
      expect(source).toContain("html.schedi-light.schedi-newbook #seriesTimeBlock");
    }
  });
});

describe.skipIf(!chrome)("series date row layout", () => {
  it("keeps the replacement row inside 390, 1280, and 1920", async () => {
    const start = template.indexOf("/* series-date-contrast */");
    const end = template.indexOf("/* /series-date-contrast */");
    const css = template.slice(start, end) + `
      .flex { display: flex; } .flex-wrap { flex-wrap: wrap; } .items-center { align-items: center; }
      .gap-2 { gap: 8px; } .min-w-\\[7rem\\] { min-width: 7rem; } .ml-auto { margin-left: auto; }
      .rounded-lg, .rounded-xl { border-radius: 12px; } .p-2 { padding: 8px; }
      .px-2 { padding-left: 8px; padding-right: 8px; } .py-1 { padding-top: 4px; padding-bottom: 4px; }
      .font-bold { font-weight: 700; } body { margin: 0; }
    `;
    const row = `<ul id="customDatesList" style="margin:0;padding:0;list-style:none">
      <li class="series-date-row is-unavailable flex flex-wrap items-center gap-2 p-2 rounded-xl border">
        <span class="series-date-label font-bold min-w-[7rem]">Wed, Sep 30</span>
        <select class="series-date-time"><option>04:00 PM</option></select>
        <span class="series-date-warn">Not available at 02:00 PM</span>
        <button type="button" class="series-date-confirm px-2 py-1 rounded-lg">Use this time</button>
        <button type="button" class="series-date-remove ml-auto px-2 py-1 rounded-lg">Remove</button>
      </li>
    </ul>
    <p id="seriesTimeBlock">Pick an available time for Wed, Sep 30.</p>`;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      for (const klass of ["", "schedi-light", "schedi-newbook", "schedi-light schedi-newbook"]) {
        await page.setContent(`<!DOCTYPE html><html class="${klass}"><head><style>${css}</style></head><body><main style="max-width:100%;padding:16px;box-sizing:border-box">${row}</main></body></html>`);
        for (const width of [390, 1280, 1920]) {
          await page.setViewport({ width, height: 900 });
          const fit = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
          }));
          expect(fit.scroll, klass + " " + width).toBeLessThanOrEqual(fit.client + 1);
        }
      }
    } finally {
      await browser.close();
    }
  });
});
