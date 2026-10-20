import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");

function bookingTemplate(source: string): string {
  const marker = "return `<!DOCTYPE html>";
  const start = source.indexOf(marker);
  const openTick = start + "return ".length;
  const end = source.indexOf("</html>`", openTick);
  return source.slice(openTick + 1, end);
}

function unescapeTemplate(source: string): string {
  return source.replace(/\\([\\`$])/g, "$1");
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf("function " + name);
  if (start < 0) throw new Error("could not find " + name);
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

const page = unescapeTemplate(bookingTemplate(html));
const hqPage = unescapeTemplate(bookingTemplate(hq));

type Hours = Record<string, { open?: boolean; start?: string; end?: string }>;
type ClosedApi = {
  closedOnLabel: (days: string | string[]) => string;
  resolveHoursForDate: (tenant: { operatingHours?: Hours; specialHours?: Record<string, unknown> }, date: string) => { closed: boolean; reason: string; special: boolean };
  formatPublicHours: (tenant: { operatingHours?: Hours } | null) => string;
  calendar: (hours: Hours, special?: Record<string, unknown>) => string;
  emptySlot: (hours: Hours, date: string) => string;
};

function api(source: string): ClosedApi {
  return new Function(
    `${extractFunction(source, "closedOnLabel")}
     ${extractFunction(source, "resolveHoursForDate")}
     ${extractFunction(source, "formatPublicHours")}
     ${extractFunction(source, "escHtml")}
     ${extractFunction(source, "renderMonthCalendar")}
     ${extractFunction(source, "generateDynamicTimeSlots")}
     function toMinutes() { return null; }
     function paintTimezoneNotes() {}
     function cartDurationMins() { return 60; }
     function bizTodayIso() { return "2027-06-01"; }
     function isDateFullyBlocked() { return null; }
     var SCHEDI_NEWBOOK = true;
     var viewYear = 2027;
     var viewMonth = 5;
     var selectedDateStr = "2027-07-01";
     var selectedTime = null;
     var tenantData = { operatingHours: {} };
     var slots = { innerHTML: "" };
     var info = { textContent: "" };
     var calendarEl = { innerHTML: "" };
     var titleEl = { textContent: "" };
     var document = { getElementById(id) {
       if (id === "monthCalendarContainer") return calendarEl;
       if (id === "monthTitleLabel") return titleEl;
       if (id === "timeSlotsContainer") return slots;
       if (id === "slotCountInfo") return info;
       return null;
     } };
     var window = { matchMedia() { return { matches: false }; } };
     return {
       closedOnLabel,
       resolveHoursForDate,
       formatPublicHours,
       calendar(hours, special) {
         tenantData = { operatingHours: hours, specialHours: special || {} };
         renderMonthCalendar();
         return calendarEl.innerHTML;
       },
       emptySlot(hours, date) {
         tenantData = { operatingHours: hours };
         selectedDateStr = date;
         selectedTime = null;
         generateDynamicTimeSlots();
         return slots.innerHTML;
       },
     };`,
  )() as ClosedApi;
}

const day = (start: string, end: string) => ({ open: true, start, end });
const closed = { open: false, start: "09:00 AM", end: "05:00 PM" };
const week = {
  Mon: day("09:00 AM", "05:00 PM"),
  Tue: day("09:00 AM", "05:00 PM"),
  Wed: day("09:00 AM", "05:00 PM"),
  Thu: day("09:00 AM", "05:00 PM"),
  Fri: day("09:00 AM", "05:00 PM"),
  Sat: day("10:00 AM", "02:00 PM"),
  Sun: closed,
};

function button(markup: string, iso: string): string {
  const found = markup.match(new RegExp(`<button type="button" onclick="selectDate\\('${iso}'\\)[\\s\\S]*?</button>`));
  if (!found) throw new Error("missing day " + iso);
  return found[0];
}

describe("public closed-day notices", () => {
  const pageApi = api(page);

  it("uses the full plural for every weekday, alone or together", () => {
    expect(pageApi.closedOnLabel("Sun")).toBe("Closed on Sundays");
    expect(pageApi.closedOnLabel("Mon")).toBe("Closed on Mondays");
    expect(pageApi.closedOnLabel("Tue")).toBe("Closed on Tuesdays");
    expect(pageApi.closedOnLabel("Wed")).toBe("Closed on Wednesdays");
    expect(pageApi.closedOnLabel("Thu")).toBe("Closed on Thursdays");
    expect(pageApi.closedOnLabel("Fri")).toBe("Closed on Fridays");
    expect(pageApi.closedOnLabel("Sat")).toBe("Closed on Saturdays");
    expect(pageApi.closedOnLabel(["Mon", "Sun"])).toBe("Closed on Sundays and Mondays");
    expect(pageApi.closedOnLabel(["Tue", "Sun", "Mon"])).toBe("Closed on Sundays, Mondays, and Tuesdays");
    expect(page).not.toContain("dayAbbr + 's'");
    expect(hqPage).not.toContain("dayAbbr + 's'");
    expect(html.slice(0, html.indexOf("return `<!DOCTYPE html>"))).not.toContain("dayAbbr + 's'");
  });

  it("says the weekday on a weekly closed day and keeps a one-off closure separate", () => {
    expect(pageApi.resolveHoursForDate({ operatingHours: week }, "2027-06-06")).toMatchObject({
      closed: true,
      special: false,
      reason: "Closed on Sundays",
    });
    expect(pageApi.resolveHoursForDate({ operatingHours: { ...week, Mon: closed } }, "2027-06-07")).toMatchObject({
      closed: true,
      reason: "Closed on Mondays",
    });
    expect(pageApi.resolveHoursForDate({
      operatingHours: week,
      specialHours: { "2027-06-08": { closed: true } },
    }, "2027-06-08")).toMatchObject({
      closed: true,
      special: true,
      reason: "Closed this day",
    });
  });

  it("puts the phrase on the calendar tooltip and aria label", () => {
    const markup = pageApi.calendar({ ...week, Mon: closed });
    const sunday = button(markup, "2027-06-06");
    const monday = button(markup, "2027-06-07");
    const tuesday = button(markup, "2027-06-08");
    expect(sunday).toContain('title="Closed on Sundays"');
    expect(sunday).toContain('aria-label="Closed on Sundays June 6"');
    expect(sunday).toContain(">Closed</span>");
    expect(monday).toContain('title="Closed on Mondays"');
    expect(monday).toContain('aria-label="Closed on Mondays June 7"');
    expect(tuesday).not.toContain("title=");
    expect(tuesday).toContain('aria-label="Open June 8"');

    const special = pageApi.calendar(week, { "2027-06-08": { closed: true } });
    const holiday = button(special, "2027-06-08");
    expect(holiday).not.toContain("Closed on Tuesdays");
    expect(holiday).toContain('aria-label="Closed June 8"');
    expect(holiday).not.toContain("title=");
  });

  it("uses the same phrase when the day has no open times", () => {
    expect(pageApi.emptySlot(week, "2027-06-06")).toContain("Closed on Sundays");
    expect(pageApi.emptySlot({ ...week, Mon: closed }, "2027-06-07")).toContain("Closed on Mondays");
    expect(pageApi.emptySlot(week, "2027-06-06")).not.toContain("Suns");
    expect(pageApi.emptySlot({ ...week, Mon: closed }, "2027-06-07")).not.toContain("Mons");
  });

  it("lists every weekly closed day in the hours summary", () => {
    expect(pageApi.formatPublicHours({ operatingHours: week })).toBe(
      "Mon–Fri 09:00 AM–05:00 PM · Sat 10:00 AM–02:00 PM · Closed on Sundays",
    );
    expect(pageApi.formatPublicHours({ operatingHours: { ...week, Mon: closed } })).toBe(
      "Tue–Fri 09:00 AM–05:00 PM · Sat 10:00 AM–02:00 PM · Closed on Sundays and Mondays",
    );
    expect(pageApi.formatPublicHours({
      operatingHours: { ...week, Mon: closed, Tue: closed },
    })).toBe("Wed–Fri 09:00 AM–05:00 PM · Sat 10:00 AM–02:00 PM · Closed on Sundays, Mondays, and Tuesdays");
    expect(pageApi.formatPublicHours({
      operatingHours: { Mon: closed, Tue: closed, Wed: closed, Thu: closed, Fri: closed, Sat: closed, Sun: closed },
    })).toBe("Closed on Sundays, Mondays, Tuesdays, Wednesdays, Thursdays, Fridays, and Saturdays");
    expect(pageApi.formatPublicHours(null)).toBe("");
    expect(pageApi.formatPublicHours({ operatingHours: {
      Mon: day("09:00 AM", "05:00 PM"),
      Tue: day("09:00 AM", "05:00 PM"),
      Wed: day("09:00 AM", "05:00 PM"),
      Thu: day("09:00 AM", "05:00 PM"),
      Fri: day("09:00 AM", "05:00 PM"),
      Sat: day("09:00 AM", "05:00 PM"),
      Sun: day("09:00 AM", "05:00 PM"),
    } })).toBe("Mon–Sun 09:00 AM–05:00 PM");
  });

  it("keeps the same wording in the HQ copy of the booking page", () => {
    const hqApi = api(hqPage);
    expect(hqApi.closedOnLabel(["Mon", "Sun"])).toBe("Closed on Sundays and Mondays");
    expect(hqApi.formatPublicHours({ operatingHours: { ...week, Mon: closed } })).toContain("Closed on Sundays and Mondays");
    const markup = hqApi.calendar({ ...week, Mon: closed });
    expect(button(markup, "2027-06-07")).toContain('title="Closed on Mondays"');
    expect(hqApi.emptySlot({ ...week, Mon: closed }, "2027-06-07")).toContain("Closed on Mondays");
  });
});
