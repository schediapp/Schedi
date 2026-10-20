import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
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
const names = ["calendarHostLooksPrivate", "calendarFeedUrlError", "calendarSyncConnected", "calendarMaskUrl"];
const lib = names.map((name) => extractFunction(owner, name)).join("\n");
const api = new Function(
  `${lib}; return { calendarHostLooksPrivate, calendarFeedUrlError, calendarSyncConnected, calendarMaskUrl };`,
)() as {
  calendarHostLooksPrivate: (host: string) => boolean;
  calendarFeedUrlError: (raw: unknown) => string;
  calendarSyncConnected: (sync: unknown) => boolean;
  calendarMaskUrl: (raw: string) => string;
};

describe("calendar feed helpers", () => {
  it("treats a saved feed as connected and ignores the old provider shape", () => {
    expect(api.calendarSyncConnected(null)).toBe(false);
    expect(api.calendarSyncConnected({})).toBe(false);
    expect(api.calendarSyncConnected({ feedCount: 1, feeds: [] })).toBe(true);
    expect(api.calendarSyncConnected({
      feeds: [{ id: "abc", masked: "calendar.google.com/…/basic.ics" }],
    })).toBe(true);
    expect(api.calendarSyncConnected({
      google: { connected: true, email: "ada@example.com" },
    })).toBe(false);
  });

  it("accepts https and webcal links and rejects private addresses", () => {
    expect(api.calendarFeedUrlError("")).toBe("Paste a calendar link.");
    expect(api.calendarFeedUrlError("http://calendar.google.com/calendar/ical/secret.ics")).toBe("Use an https or webcal link.");
    expect(api.calendarFeedUrlError("https://user:pass@calendar.google.com/secret.ics")).toBe("Remove the username and password from the link.");
    expect(api.calendarFeedUrlError("https://localhost/basic.ics")).toBe("That address cannot be used.");
    expect(api.calendarFeedUrlError("https://127.0.0.1/basic.ics")).toBe("That address cannot be used.");
    expect(api.calendarFeedUrlError("https://10.1.2.3/basic.ics")).toBe("That address cannot be used.");
    expect(api.calendarFeedUrlError("https://192.168.1.9/basic.ics")).toBe("That address cannot be used.");
    expect(api.calendarFeedUrlError("https://calendar.google.com:8443/basic.ics")).toBe("Use a calendar link on port 443 or 80.");
    expect(api.calendarFeedUrlError("webcal://calendar.google.com/calendar/ical/secret/basic.ics")).toBe("");
    expect(api.calendarMaskUrl("https://calendar.google.com/calendar/ical/secret-token/basic.ics")).toBe("calendar.google.com/…/basic.ics");
    expect(api.calendarMaskUrl("https://calendar.google.com/calendar/ical/secret-token/basic.ics")).not.toContain("secret-token");
  });

  it("shows masked feeds and a subscribe link without the old connect mock", () => {
    expect(owner).toContain("Keep busy times off the book");
    expect(owner).toContain("Secret address in iCal format");
    expect(owner).toContain("Share the calendar with a public link");
    expect(owner).toContain("Publish the calendar and paste the ICS link");
    expect(owner).toContain("Copy link");
    expect(owner).toContain("Reset link");
    expect(owner).toContain("/api/calendar-feeds");
    expect(owner).toContain("Busy on a connected calendar");
    expect(owner).not.toContain("Coming soon");
    expect(owner).not.toContain("app-specific password");
    expect(owner).not.toContain("This preview does not save the password.");
    expect(owner).not.toContain("data-busy-write=");
    expect(owner).not.toContain("calendarSyncProviders");
    expect(owner).not.toContain("encodeURIComponent(googleDates)");
    expect(owner).toContain("googleDates.split('/').map(encodeURIComponent).join('/')");
    const page = html.slice(html.indexOf(TEMPLATE));
    expect(page).toContain("function refreshExternalBusy");
    expect(page).toContain("https://schedi.app/api/calendar-busy?tenant=");
    expect(page).toContain("return 'Busy'");
    expect(page).toContain("out.data.error === 'slot_taken'");
    expect(page).not.toContain("Keep busy times off the book");
    expect(page).not.toContain("encodeURIComponent(googleDates)");
    expect(hq).not.toContain("encodeURIComponent(googleDates)");
    expect(hq).toContain("googleDates.split('/').map(encodeURIComponent).join('/')");
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
