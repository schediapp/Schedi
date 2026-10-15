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

function extractAssigned(source: string, name: string): string {
  const marker = "window." + name + " = function";
  const start = source.indexOf(marker);
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

const clock = new Function(
  extractFunction(ownerHtml, "fromMinutes") + "\n" +
  extractFunction(ownerHtml, "parseOwnerClock") + "\n" +
  extractFunction(ownerHtml, "ownerClockMinutes") + "\n" +
  extractFunction(ownerHtml, "ownerHoursOrderError") + "\n" +
  extractFunction(ownerHtml, "ownerClockChoices") + "\n" +
  "return { parseOwnerClock, ownerClockMinutes, ownerHoursOrderError, ownerClockChoices };",
)() as {
  parseOwnerClock: (raw: string) => string;
  ownerClockMinutes: (label: string) => number | null;
  ownerHoursOrderError: (start: string, end: string) => string;
  ownerClockChoices: (step: number) => string[];
};

describe("owner clock parser", () => {
  it("normalizes typed times and documents the bare-hour rule", () => {
    const parse = clock.parseOwnerClock;
    expect(parse("9")).toBe("09:00 AM");
    expect(parse("930")).toBe("09:30 AM");
    expect(parse("9:30a")).toBe("09:30 AM");
    expect(parse("9:30 pm")).toBe("09:30 PM");
    expect(parse("17:00")).toBe("05:00 PM");
    expect(parse("5p")).toBe("05:00 PM");
    expect(parse("5")).toBe("05:00 PM");
    expect(parse("7")).toBe("07:00 AM");
    expect(parse("11")).toBe("11:00 AM");
    expect(parse("12")).toBe("12:00 PM");
    expect(parse("12a")).toBe("12:00 AM");
    expect(parse("0")).toBe("12:00 AM");
    expect(parse("00:00")).toBe("12:00 AM");
    expect(parse("6")).toBe("06:00 PM");
    expect(parse("6a")).toBe("06:00 AM");
    expect(parse("930pm")).toBe("09:30 PM");
    expect(parse("13:15")).toBe("01:15 PM");
    expect(parse("9.30")).toBe("09:30 AM");
    expect(parse("9 a.m.")).toBe("09:00 AM");
    expect(parse("9 : 30")).toBe("09:30 AM");
    expect(parse("9:07")).toBe("09:07 AM");
    expect(parse("9:75")).toBe("");
    expect(parse("nope")).toBe("");
    expect(parse("24:00")).toBe("");
    expect(parse("")).toBe("");
    expect(ownerHtml).toContain("7–11 are morning");
    expect(ownerHtml).toContain("1–6 are afternoon");
    expect(ownerHtml).toContain("9 is 9:00 AM and 5 is 5:00 PM");
  });

  it("rejects a close that is not after open", () => {
    expect(clock.ownerHoursOrderError("9", "5")).toBe("");
    expect(clock.ownerHoursOrderError("5p", "9")).toBe("Close needs to be after open.");
    expect(clock.ownerHoursOrderError("9", "9")).toBe("Close needs to be after open.");
    expect(clock.ownerHoursOrderError("17:00", "5")).toBe("Close needs to be after open.");
    expect(clock.ownerHoursOrderError("nope", "5")).toBe("Use a time like 9:30 AM.");
    expect(clock.ownerClockMinutes("09:00 AM")).toBe(9 * 60);
    expect(clock.ownerClockMinutes("05:00 PM")).toBe(17 * 60);
    expect(clock.ownerClockMinutes("12:00 AM")).toBe(0);
  });

  it("lists the full day in the business start-times step", () => {
    const half = clock.ownerClockChoices(30);
    expect(half).toHaveLength(48);
    expect(half[0]).toBe("12:00 AM");
    expect(half).toContain("09:00 AM");
    expect(half).toContain("05:00 PM");
    expect(half).not.toContain("09:15 AM");
    const quarter = clock.ownerClockChoices(15);
    expect(quarter).toHaveLength(96);
    expect(quarter).toContain("09:15 AM");
    const hour = clock.ownerClockChoices(60);
    expect(hour).toHaveLength(24);
    expect(hour).not.toContain("09:30 AM");
    expect(clock.ownerClockChoices(45)).toEqual(half);
    expect(quarter).not.toContain("09:07 AM");
  });
});

describe("owner time combo markup", () => {
  it("uses one large combobox for weekly hours, special hours, and time off", () => {
    expect(ownerHtml).toContain('role="combobox"');
    expect(ownerHtml).toContain("sd-time-input");
    expect(ownerHtml).toContain("ownerTimeComboHtml('shiftStart_' + day");
    expect(ownerHtml).toContain('id="shiftError_${day}"');
    expect(ownerHtml).toContain("Monday");
    expect(ownerHtml).toContain('id="newBlockTime" class="sd-time-input"');
    expect(ownerHtml).toContain('id="newVacStartTime" class="sd-time-input"');
    expect(ownerHtml).toContain('id="newVacEndTime" class="sd-time-input"');
    expect(ownerHtml).toContain("special-hours-start");
    expect(ownerHtml).toContain("special-hours-end");
    expect(ownerHtml).not.toContain('<select id="newBlockTime"');
    expect(ownerHtml).not.toContain('<select class="special-hours-start');
    expect(ownerHtml).toMatch(/body\.schedi-newdash \.sd-time-input \{[^}]*min-height:\s*44px[^}]*font-size:\s*16px/s);
    expect(ownerHtml).toContain("ArrowDown");
    expect(ownerHtml).toContain("aria-activedescendant");
    expect(ownerHtml).toContain("else if (typedTime) ownerTimeCommit(root, typedTime)");
    expect(ownerHtml).toContain("parsed.toLowerCase() === raw.toLowerCase()");
    const save = extractAssigned(ownerHtml, "handleUpdateShiftsSubmit");
    expect(save.indexOf("ownerHoursOrderError")).toBeGreaterThan(-1);
    expect(save.indexOf("ownerHoursOrderError")).toBeLessThan(save.indexOf("saveState()"));
    expect(save).toContain("Fix the hours marked below.");
    const special = extractAssigned(ownerHtml, "handleAddSpecialHoursSubmit");
    expect(special).toContain("ownerHoursOrderError");
    expect(special).not.toContain("Each window needs an end time after its start");
    const dateBlock = extractAssigned(ownerHtml, "handleAddDateBlockSubmit");
    expect(dateBlock).toContain("ownerHoursOrderError");
    expect(dateBlock).toContain("vacTimeError");
    expect(dateBlock).not.toContain("End time must be after start time");
    const outage = extractAssigned(ownerHtml, "handleAddBlockedTimeSubmit");
    expect(outage).toContain("blockTimeError");
    expect(outage).toContain("parseOwnerClock");
    expect(extractFunction(ownerHtml, "populateVacTimeSelects")).not.toContain("innerHTML");
    expect(extractFunction(ownerHtml, "ensureSelectHasValue")).toContain("sd-time-input");
    expect(bookingTemplate).not.toContain("parseOwnerClock");
    expect(bookingTemplate).not.toContain("sd-time-input");
  });
});
