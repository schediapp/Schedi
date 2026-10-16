import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const templateAt = html.indexOf("return `<!DOCTYPE html>");
const ownerHtml = templateAt > 0 ? html.slice(0, templateAt) : html;
const bookingTemplate = templateAt > 0 ? html.slice(templateAt) : "";

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

const names = [
  "toMinutes",
  "parseOwnerClock",
  "ownerClockMinutes",
  "ownerHoursOrderError",
  "hoursCalParseIso",
  "hoursCalIsoFromParts",
  "hoursCalAddDays",
  "hoursCalAddMonths",
  "hoursCalMonthCells",
  "hoursCalOrder",
  "hoursCalInRange",
  "hoursCalDatesBetween",
  "hoursCalEntryRanges",
  "hoursCalEntryOpen",
  "hoursCalEntryClosed",
  "hoursCalBlockCovers",
  "hoursCalBlockAllDay",
  "hoursCalMarks",
  "hoursCalNoteLabel",
  "hoursCalReleaseDay",
  "hoursCalNewBlockId",
  "hoursCalWriteCustom",
  "hoursCalWriteClosed",
  "hoursCalClearRange",
  "hoursCalUpcoming",
  "hoursCalCoveringBlock",
  "hoursCalExactBlock",
];

const api = new Function(
  names.map((name) => extractFunction(ownerHtml, name)).join("\n") +
    "\nreturn { hoursCalParseIso, hoursCalIsoFromParts, hoursCalAddDays, hoursCalAddMonths, hoursCalMonthCells, hoursCalInRange, hoursCalMarks, hoursCalNoteLabel, hoursCalReleaseDay, hoursCalWriteCustom, hoursCalWriteClosed, hoursCalClearRange, hoursCalUpcoming, hoursCalCoveringBlock, hoursCalExactBlock };",
)() as {
  hoursCalAddDays: (iso: string, n: number) => string;
  hoursCalAddMonths: (iso: string, n: number) => string;
  hoursCalMonthCells: (year: number, month: number) => { iso: string; inMonth: boolean }[];
  hoursCalInRange: (iso: string, start: string, end: string) => boolean;
  hoursCalMarks: (tenant: unknown, iso: string) => { custom: boolean; closed: boolean };
  hoursCalNoteLabel: (note: string) => string;
  hoursCalReleaseDay: (tenant: { blockedTimes?: unknown[] }, iso: string) => unknown;
  hoursCalWriteCustom: (tenant: { specialHours?: Record<string, unknown>; blockedTimes?: unknown[] }, iso: string, start: string, end: string) => string;
  hoursCalWriteClosed: (tenant: { specialHours?: Record<string, unknown>; blockedTimes?: Record<string, unknown>[] }, start: string, end: string, note: string, id: string) => string;
  hoursCalClearRange: (tenant: { specialHours?: Record<string, unknown>; blockedTimes?: unknown[] }, start: string, end: string, id: string) => unknown;
  hoursCalUpcoming: (tenant: unknown, today: string) => { kind: string; id: string | number; start: string; end: string; label: string; closed: boolean; detail: string }[];
  hoursCalCoveringBlock: (tenant: unknown, iso: string) => { id?: string; note?: string } | null;
  hoursCalExactBlock: (tenant: unknown, iso: string) => { id?: string } | null;
};

function tenant(extra: Record<string, unknown> = {}) {
  return {
    specialHours: {} as Record<string, unknown>,
    blockedTimes: [] as Record<string, unknown>[],
    ...extra,
  };
}

describe("hours calendar mapping", () => {
  it("builds a Sunday-first month and steps across months", () => {
    const cells = api.hoursCalMonthCells(2026, 10);
    expect(cells).toHaveLength(35);
    expect(cells[0]).toEqual({ iso: "2026-09-27", inMonth: false });
    expect(cells[4]).toEqual({ iso: "2026-10-01", inMonth: true });
    expect(cells[34]).toEqual({ iso: "2026-10-31", inMonth: true });
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(31);
    expect(api.hoursCalAddDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(api.hoursCalAddMonths("2026-10-31", 1)).toBe("2026-11-30");
    expect(api.hoursCalInRange("2026-10-21", "2026-10-22", "2026-10-20")).toBe(true);
    expect(api.hoursCalInRange("2026-10-19", "2026-10-20", "2026-10-22")).toBe(false);
    expect(api.hoursCalMonthCells(2026, 13)).toEqual([]);
  });

  it("marks custom hours with a dot and full-day closures as closed", () => {
    const data = tenant({
      specialHours: {
        "2026-10-16": { closed: false, ranges: [{ start: "11:00 AM", end: "03:00 PM" }] },
        "2026-10-17": { closed: true, ranges: [] },
        "2026-10-18": { closed: false, ranges: [] },
        "2026-10-19": [{ start: "09:00 AM", end: "12:00 PM" }, { start: "01:00 PM", end: "04:00 PM" }],
      },
      blockedTimes: [
        { id: "off", startDate: "2026-10-20", endDate: "2026-10-22", allDay: true, startTime: "", endTime: "", note: "Out of studio" },
        { id: "errand", startDate: "2026-10-23", endDate: "2026-10-23", allDay: false, startTime: "01:00 PM", endTime: "02:00 PM", note: "Errand" },
      ],
    });
    expect(api.hoursCalMarks(data, "2026-10-16")).toEqual({ custom: true, closed: false });
    expect(api.hoursCalMarks(data, "2026-10-17")).toEqual({ custom: false, closed: true });
    expect(api.hoursCalMarks(data, "2026-10-18")).toEqual({ custom: false, closed: true });
    expect(api.hoursCalMarks(data, "2026-10-19")).toEqual({ custom: true, closed: false });
    expect(api.hoursCalMarks(data, "2026-10-21")).toEqual({ custom: false, closed: true });
    expect(api.hoursCalMarks(data, "2026-10-23")).toEqual({ custom: false, closed: false });
    expect(api.hoursCalMarks(data, "2026-10-24")).toEqual({ custom: false, closed: false });
  });

  it("writes one custom window and splits an all-day block around that day", () => {
    const data = tenant({
      specialHours: { "2026-10-01": { closed: true, ranges: [] } },
      blockedTimes: [{ id: "off", note: "Out of studio", startDate: "2026-10-20", endDate: "2026-10-22", allDay: true, startTime: "", endTime: "" }],
    });
    expect(api.hoursCalWriteCustom(data, "2026-10-21", "9", "5")).toBe("");
    expect(data.specialHours["2026-10-21"]).toEqual({ closed: false, ranges: [{ start: "09:00 AM", end: "05:00 PM" }] });
    expect(Object.keys(data.specialHours["2026-10-21"] as object).sort()).toEqual(["closed", "ranges"]);
    expect(data.specialHours["2026-10-01"]).toEqual({ closed: true, ranges: [] });
    expect(data.blockedTimes.map((block) => [block.startDate, block.endDate, block.id])).toEqual([
      ["2026-10-20", "2026-10-20", "off-a"],
      ["2026-10-22", "2026-10-22", "off-b"],
    ]);
    const partial = tenant({
      blockedTimes: [{ id: "errand", startDate: "2026-10-23", endDate: "2026-10-23", allDay: false, startTime: "01:00 PM", endTime: "02:00 PM", note: "Errand" }],
    });
    api.hoursCalReleaseDay(partial, "2026-10-23");
    expect(partial.blockedTimes).toHaveLength(1);
  });

  it("rejects a close time that is not after open without writing", () => {
    const data = tenant();
    expect(api.hoursCalWriteCustom(data, "2026-10-16", "5pm", "9")).toBe("Close needs to be after open.");
    expect(api.hoursCalWriteCustom(data, "2026-10-16", "nope", "5")).toBe("Use a time like 9:30 AM.");
    expect(data.specialHours).toEqual({});
    expect(data.blockedTimes).toEqual([]);
    expect(api.hoursCalWriteCustom(data, "bad", "9", "5")).toBe("Pick a date.");
  });

  it("stores a closed range as all-day time off and drops special hours inside it", () => {
    const data = tenant({
      specialHours: {
        "2026-10-20": { closed: false, ranges: [{ start: "11:00 AM", end: "03:00 PM" }] },
        "2026-10-24": { closed: true, ranges: [] },
      },
      blockedTimes: [{ id: "old", note: "Old", startDate: "2026-10-19", endDate: "2026-10-23", allDay: true, startTime: "", endTime: "" }],
    });
    expect(api.hoursCalWriteClosed(data, "2026-10-22", "2026-10-20", "  Holiday  ", "off-1")).toBe("");
    expect(data.specialHours["2026-10-20"]).toBeUndefined();
    expect(data.specialHours["2026-10-24"]).toEqual({ closed: true, ranges: [] });
    const created = data.blockedTimes.find((block) => block.id === "off-1");
    expect(created).toEqual({
      id: "off-1",
      note: "Holiday",
      startDate: "2026-10-20",
      endDate: "2026-10-22",
      allDay: true,
      startTime: "",
      endTime: "",
    });
    expect(Object.keys(created || {}).sort()).toEqual(["allDay", "endDate", "endTime", "id", "note", "startDate", "startTime"]);
    expect(data.blockedTimes.some((block) => block.id === "old")).toBe(false);
    expect(data.blockedTimes.some((block) => block.startDate === "2026-10-19" && block.endDate === "2026-10-19")).toBe(true);
    expect(data.blockedTimes.some((block) => block.startDate === "2026-10-23" && block.endDate === "2026-10-23")).toBe(true);
    const blank = tenant();
    api.hoursCalWriteClosed(blank, "2026-10-05", "2026-10-05", "   ", "day");
    expect(blank.blockedTimes[0].note).toBe("Closed");
    const longNote = "H".repeat(90);
    const clipped = tenant();
    api.hoursCalWriteClosed(clipped, "2026-11-01", "2026-11-02", longNote, "long");
    expect(clipped.blockedTimes[0].note).toHaveLength(80);
    expect(api.hoursCalNoteLabel("")).toBe("Closed");
  });

  it("clears a day back to weekly hours", () => {
    const data = tenant({
      specialHours: { "2026-10-21": { closed: false, ranges: [{ start: "09:00 AM", end: "01:00 PM" }] } },
      blockedTimes: [{ id: "off", note: "Out", startDate: "2026-10-20", endDate: "2026-10-22", allDay: true, startTime: "", endTime: "" }],
    });
    api.hoursCalClearRange(data, "2026-10-21", "2026-10-21", "");
    expect(data.specialHours["2026-10-21"]).toBeUndefined();
    expect(api.hoursCalMarks(data, "2026-10-21").closed).toBe(false);
    expect(api.hoursCalMarks(data, "2026-10-20").closed).toBe(true);
    expect(api.hoursCalMarks(data, "2026-10-22").closed).toBe(true);
  });

  it("lists upcoming special dates and time off without past rows", () => {
    const data = tenant({
      specialHours: {
        "2026-10-01": { closed: true, ranges: [] },
        "2026-10-16": { closed: false, ranges: [{ start: "11:00 AM", end: "03:00 PM" }] },
        "2026-10-18": { closed: true, ranges: [] },
      },
      blockedTimes: [
        { id: "past", note: "Gone", startDate: "2026-09-01", endDate: "2026-09-02", allDay: true, startTime: "", endTime: "" },
        { id: "off", note: "Out of studio", startDate: "2026-10-20", endDate: "2026-10-22", allDay: true, startTime: "", endTime: "" },
        { id: "errand", note: "Errand", startDate: "2026-10-16", endDate: "2026-10-16", allDay: false, startTime: "01:00 PM", endTime: "02:00 PM" },
        { id: "one", note: "Holiday", startDate: "2026-10-30", endDate: "2026-10-30", allDay: true, startTime: "", endTime: "" },
      ],
    });
    const rows = api.hoursCalUpcoming(data, "2026-10-15");
    expect(rows.map((row) => [row.kind, String(row.id), row.label, row.detail])).toEqual([
      ["special", "2026-10-16", "Custom hours", "11:00 AM – 03:00 PM"],
      ["timeoff", "errand", "Errand", "01:00 PM – 02:00 PM"],
      ["special", "2026-10-18", "Closed", "Closed all day"],
      ["timeoff", "off", "Out of studio", "All day"],
      ["timeoff", "one", "Holiday", "All day"],
    ]);
    expect(api.hoursCalCoveringBlock(data, "2026-10-21")?.id).toBe("off");
    expect(api.hoursCalExactBlock(data, "2026-10-30")?.id).toBe("one");
    expect(api.hoursCalExactBlock(data, "2026-10-16")).toBeNull();
    expect(api.hoursCalCoveringBlock(data, "2026-10-16")).toBeNull();
  });

  it("keeps the calendar in the owner portal and out of the public booking page", () => {
    const hoursStart = ownerHtml.indexOf('id="tenantHoursTimeOff"');
    const hoursEnd = ownerHtml.indexOf('id="tenantSectionPayments"');
    const hours = ownerHtml.slice(hoursStart, hoursEnd);
    expect(hours).toContain('id="sdCalGrid"');
    expect(hours).toContain('role="grid"');
    expect(hours).toContain('aria-label="Previous month"');
    expect(hours).toContain('aria-label="Next month"');
    expect(hours).toContain("Open, custom hours");
    expect(hours).toContain('placeholder="Holiday"');
    expect(hours).toContain("Custom hours");
    expect(hours).toContain("hold a date and tap the last day");
    expect(hours).toContain("Add Recurring Outage");
    expect(hours).toContain("Vacation &amp; Date Blocks");
    expect(hours).toContain('id="tenantDateBlocksList"');
    expect(hours).toContain("Add Date Block");
    expect(hours).not.toContain("Add Special Hours");
    expect(ownerHtml).toContain('role="gridcell"');
    expect(ownerHtml).toContain("ArrowLeft");
    expect(ownerHtml).toContain("HOURS_CAL_HOLD_MS = 500");
    expect(ownerHtml).toContain("hoursCalWriteCustom");
    expect(bookingTemplate).not.toContain("hoursCalWriteCustom");
    expect(bookingTemplate).not.toContain("sdCalGrid");
    expect(bookingTemplate).not.toContain("hoursCalMonthCells");
  });
});
