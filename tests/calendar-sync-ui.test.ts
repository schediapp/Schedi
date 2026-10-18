import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
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
const names = [
  "calendarSyncProviders",
  "calendarSyncNormalize",
  "calendarSyncConnected",
  "appleConnectError",
  "calendarSyncDemoSample",
];
const lib = names.map((name) => extractFunction(owner, name)).join("\n");
const api = new Function(
  `${lib}; return { calendarSyncProviders, calendarSyncNormalize, calendarSyncConnected, appleConnectError, calendarSyncDemoSample };`,
)() as {
  calendarSyncProviders: () => { id: string; name: string }[];
  calendarSyncNormalize: (sync: unknown) => Record<string, {
    connected: boolean;
    email: string;
    writeBookings: boolean;
    calendars: { id: string; name: string; checked: boolean }[];
  }>;
  calendarSyncConnected: (sync: unknown) => boolean;
  appleConnectError: (appleId: unknown, password: unknown) => string;
  calendarSyncDemoSample: (providerId: string) => { email?: string; calendars?: { name: string; checked: boolean }[] } | null;
};

describe("calendar sync helpers", () => {
  it("normalizes missing accounts and treats a connection without an email as disconnected", () => {
    const empty = api.calendarSyncNormalize(null);
    expect(api.calendarSyncProviders().map((provider) => provider.id)).toEqual(["google", "microsoft", "apple"]);
    expect(empty.google.connected).toBe(false);
    expect(empty.microsoft.calendars).toEqual([]);
    expect(empty.apple.writeBookings).toBe(true);
    const partial = api.calendarSyncNormalize({
      google: {
        connected: true,
        email: "  ",
        calendars: [{ id: "", name: "Skip" }, { id: "work", name: "Work", checked: true }],
      },
      apple: { connected: true, email: "ada@icloud.com", writeBookings: false, calendars: [] },
    });
    expect(partial.google.connected).toBe(false);
    expect(partial.google.calendars).toEqual([{ id: "work", name: "Work", checked: true }]);
    expect(partial.apple.connected).toBe(true);
    expect(partial.apple.writeBookings).toBe(false);
    expect(api.calendarSyncConnected(partial)).toBe(true);
    expect(api.calendarSyncConnected(null)).toBe(false);
  });

  it("rejects a short Apple password and accepts a 16-character app-specific password", () => {
    expect(api.appleConnectError("", "abcd-efgh-ijkl-mnop")).toBe("Enter an Apple ID.");
    expect(api.appleConnectError("not-an-email", "abcd-efgh-ijkl-mnop")).toBe("Enter an Apple ID that looks like an email.");
    expect(api.appleConnectError("ada@icloud.com", "")).toBe("Enter an app-specific password.");
    expect(api.appleConnectError("ada@icloud.com", "too-short")).toBe("That app-specific password looks too short.");
    expect(api.appleConnectError(" ada@icloud.com ", "abcd efgh ijkl mnop")).toBe("");
  });

  it("uses local demo accounts and does not put provider secrets in the owner script", () => {
    expect(api.calendarSyncDemoSample("google")?.email).toBe("demo@harbor.studio");
    expect(api.calendarSyncDemoSample("microsoft")?.email).toBe("avery.cole@outlook.com");
    expect(api.calendarSyncDemoSample("apple")).toBeNull();
    expect(owner).toContain("Avoid double-booking");
    expect(owner).toContain("Calendars to check for busy times");
    expect(owner).toContain("Add Schedi bookings to my calendar");
    expect(owner).toContain("Coming soon");
    expect(owner).toContain("https://support.apple.com/en-us/102654");
    expect(owner).toContain("This preview does not save the password.");
    expect(owner).not.toContain("calendar.freebusy");
    expect(owner).not.toContain("Calendars.ReadWrite");
    expect(owner).not.toContain("/api/calendar/");
    expect(html.slice(html.indexOf(TEMPLATE))).not.toContain("Avoid double-booking");
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
