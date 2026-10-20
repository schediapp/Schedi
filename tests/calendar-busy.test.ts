import { describe, expect, it } from "vitest";
import {
  bookingOverlapsBusy,
  coarsenBusyBlocks,
  hostIsBlocked,
  ipIsPrivate,
  maskCalendarUrl,
  mergeBusyBlocks,
  normalizeCalendarUrl,
  parseBusyBlocks,
} from "../workers/schedi-email-worker/src/calendar-ics.js";
import { buildOwnerFeedIcs, googleCalendarDatesParam } from "../workers/schedi-email-worker/src/booking-ics.js";
import {
  busyBlocksForTenant,
  fetchCalendarText,
  handleCalendarBusy,
  handleCalendarFeeds,
  handleOwnerFeed,
  resolveHostPublic,
} from "../workers/schedi-email-worker/src/calendar-sync.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const TZ = "America/New_York";

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700308T020000",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "DTSTART:19701101T020000",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

function calendar(events: string) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Schedi//Test//EN", VTIMEZONE, events, "END:VCALENDAR"].join("\r\n");
}

function blocks(events: string, extra?: { now?: Date; horizonDays?: number; timeZone?: string }) {
  return parseBusyBlocks(calendar(events), { now: NOW, timeZone: TZ, horizonDays: 90, ...extra });
}

describe("iCal busy parser", () => {
  it("keeps a timed event and drops titles", () => {
    const parsed = blocks([
      "BEGIN:VEVENT",
      "UID:one@schedi",
      "DTSTART:20261021T150000Z",
      "DTEND:20261021T160000Z",
      "SUMMARY:Secret client call",
      "END:VEVENT",
    ].join("\r\n"));
    expect(parsed).toEqual([{ start: "2026-10-21T15:00:00.000Z", end: "2026-10-21T16:00:00.000Z" }]);
    expect(JSON.stringify(parsed)).not.toContain("Secret");
  });

  it("blocks an all-day date in the business timezone", () => {
    const parsed = blocks([
      "BEGIN:VEVENT",
      "UID:allday@schedi",
      "DTSTART;VALUE=DATE:20261021",
      "DTEND;VALUE=DATE:20261022",
      "SUMMARY:Vacation",
      "END:VEVENT",
    ].join("\r\n"));
    expect(parsed).toEqual([{ start: "2026-10-21T04:00:00.000Z", end: "2026-10-22T04:00:00.000Z" }]);
  });

  it("applies TZID on a timed event", () => {
    const parsed = blocks([
      "BEGIN:VEVENT",
      "UID:tz@schedi",
      "DTSTART;TZID=America/New_York:20261021T090000",
      "DTEND;TZID=America/New_York:20261021T100000",
      "END:VEVENT",
    ].join("\r\n"));
    expect(parsed).toEqual([{ start: "2026-10-21T13:00:00.000Z", end: "2026-10-21T14:00:00.000Z" }]);
  });

  it("expands RRULE inside 90 days, skips EXDATE, and honors RECURRENCE-ID", () => {
    const parsed = blocks([
      "BEGIN:VEVENT",
      "UID:series@schedi",
      "DTSTART;TZID=America/New_York:20261020T090000",
      "DTEND;TZID=America/New_York:20261020T100000",
      "RRULE:FREQ=WEEKLY;COUNT=20",
      "EXDATE;TZID=America/New_York:20261027T090000",
      "SUMMARY:Standup",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:series@schedi",
      "RECURRENCE-ID;TZID=America/New_York:20261103T090000",
      "DTSTART;TZID=America/New_York:20261103T130000",
      "DTEND;TZID=America/New_York:20261103T140000",
      "SUMMARY:Standup moved",
      "END:VEVENT",
    ].join("\r\n"));
    const starts = parsed.map((row) => row.start);
    expect(starts).toContain("2026-10-20T13:00:00.000Z");
    expect(starts).not.toContain("2026-10-27T13:00:00.000Z");
    expect(starts).not.toContain("2026-11-03T14:00:00.000Z");
    expect(parsed).toContainEqual({ start: "2026-11-03T18:00:00.000Z", end: "2026-11-03T19:00:00.000Z" });
    const last = Date.parse(parsed[parsed.length - 1].start);
    expect(last).toBeLessThan(NOW.getTime() + 90 * 24 * 60 * 60 * 1000);
    expect(parsed.length).toBeGreaterThan(8);
    expect(parsed.length).toBeLessThan(20);
  });

  it("skips TRANSPARENT and CANCELLED events, including a cancelled occurrence", () => {
    const parsed = blocks([
      "BEGIN:VEVENT",
      "UID:free@schedi",
      "DTSTART:20261021T150000Z",
      "DTEND:20261021T160000Z",
      "TRANSP:TRANSPARENT",
      "SUMMARY:Show as free",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:gone@schedi",
      "DTSTART:20261022T150000Z",
      "DTEND:20261022T160000Z",
      "STATUS:CANCELLED",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:keep@schedi",
      "DTSTART:20261021T090000Z",
      "DTEND:20261021T100000Z",
      "RRULE:FREQ=DAILY;COUNT=3",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:keep@schedi",
      "RECURRENCE-ID:20261022T090000Z",
      "DTSTART:20261022T090000Z",
      "DTEND:20261022T100000Z",
      "STATUS:CANCELLED",
      "END:VEVENT",
    ].join("\r\n"));
    expect(parsed.map((row) => row.start)).toEqual(["2026-10-21T09:00:00.000Z", "2026-10-23T09:00:00.000Z"]);
  });

  it("drops events outside the next 90 days and merges overlaps", () => {
    const parsed = blocks([
      "BEGIN:VEVENT",
      "UID:old@schedi",
      "DTSTART:20261001T150000Z",
      "DTEND:20261001T160000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:far@schedi",
      "DTSTART:20270201T150000Z",
      "DTEND:20270201T160000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:a@schedi",
      "DTSTART:20261021T150000Z",
      "DTEND:20261021T163000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:b@schedi",
      "DTSTART:20261021T160000Z",
      "DTEND:20261021T170000Z",
      "END:VEVENT",
    ].join("\r\n"));
    expect(parsed).toEqual([{ start: "2026-10-21T15:00:00.000Z", end: "2026-10-21T17:00:00.000Z" }]);
    expect(mergeBusyBlocks([
      { start: "2026-10-21T16:00:00.000Z", end: "2026-10-21T17:00:00.000Z" },
      { start: "2026-10-21T15:00:00.000Z", end: "2026-10-21T16:30:00.000Z" },
    ])).toEqual([{ start: "2026-10-21T15:00:00.000Z", end: "2026-10-21T17:00:00.000Z" }]);
  });

  it("rejects a calendar that is not ICS", () => {
    expect(() => parseBusyBlocks("hello", { now: NOW })).toThrow(/not_ics/);
  });
});

describe("busy overlap", () => {
  const blocks = [{ start: "2026-10-21T15:00:00.000Z", end: "2026-10-21T16:00:00.000Z" }];

  it("rejects a booking that overlaps a busy block, including the buffer", () => {
    expect(bookingOverlapsBusy(blocks, { date: "2026-10-21", time: "11:30 AM", durationMins: 60 }, { timeZone: TZ, bufferMins: 0 })).toBe(true);
    expect(bookingOverlapsBusy(blocks, { date: "2026-10-21", time: "10:00 AM", durationMins: 60 }, { timeZone: TZ, bufferMins: 15 })).toBe(true);
    expect(bookingOverlapsBusy(blocks, { date: "2026-10-21", time: "10:00 AM", durationMins: 45 }, { timeZone: TZ, bufferMins: 0 })).toBe(false);
    expect(bookingOverlapsBusy(blocks, { date: "2026-10-22", time: "11:00 AM", durationMins: 60 }, { timeZone: TZ, bufferMins: 15 })).toBe(false);
  });
});

describe("calendar URL guard", () => {
  it("allows https and webcal and blocks private hosts", () => {
    expect(normalizeCalendarUrl("https://calendar.google.com/calendar/ical/secret/basic.ics").ok).toBe(true);
    const webcal = normalizeCalendarUrl("webcal://caldav.icloud.com/published/2/abc.ics");
    expect(webcal.ok).toBe(true);
    expect(webcal.url.startsWith("https://")).toBe(true);
    for (const bad of [
      "http://calendar.google.com/basic.ics",
      "https://localhost/basic.ics",
      "https://127.0.0.1/basic.ics",
      "https://10.1.2.3/secret.ics",
      "https://192.168.1.9/a.ics",
      "https://172.16.0.4/a.ics",
      "https://169.254.169.254/latest",
      "https://[::1]/a.ics",
      "https://user:pass@calendar.google.com/a.ics",
      "https://metadata.google.internal/a.ics",
      "file:///etc/passwd",
      "https://2130706433/a.ics",
      "https://calendar.google.com:8443/a.ics",
      "https://calendar.google.com:22/a.ics",
    ]) {
      expect(normalizeCalendarUrl(bad).ok, bad).toBe(false);
    }
    expect(normalizeCalendarUrl("https://calendar.google.com:443/basic.ics").ok).toBe(true);
    expect(normalizeCalendarUrl("https://calendar.example.com:80/basic.ics").ok).toBe(true);
    expect(hostIsBlocked("calendar.google.com")).toBe(false);
    expect(ipIsPrivate("8.8.8.8")).toBe(false);
    expect(ipIsPrivate("127.0.0.1")).toBe(true);
    expect(ipIsPrivate("::1")).toBe(true);
    expect(ipIsPrivate("fd00::1")).toBe(true);
    expect(maskCalendarUrl("https://calendar.google.com/calendar/ical/abc/basic.ics")).toBe("calendar.google.com/…/basic.ics");
  });

  it("rejects a DNS answer that points at a private address and a redirect onto one", async () => {
    const dns = async () => ({ ok: true, async json() { return { Answer: [{ type: 1, data: "10.0.0.5" }] }; } });
    await expect(resolveHostPublic("calendar.example.com", dns)).rejects.toThrow(/blocked_host/);
    const fetched: string[] = [];
    const got = await fetchCalendarText("https://calendar.google.com/calendar/ical/secret/basic.ics", {
      resolve: async () => ["142.250.1.1"],
      fetch: async (url: string) => {
        fetched.push(String(url));
        return {
          status: 302,
          ok: false,
          headers: { get: (name: string) => (name.toLowerCase() === "location" ? "https://127.0.0.1/latest/meta-data" : null) },
          text: async () => "",
        };
      },
    });
    expect(got.ok).toBe(false);
    expect(fetched).toEqual(["https://calendar.google.com/calendar/ical/secret/basic.ics"]);
  });

  it("checks every CNAME hop and every address, and resolves a host only once per fetch", async () => {
    const asked: string[] = [];
    const dns = async (url: string) => {
      const parsed = new URL(String(url));
      const name = parsed.searchParams.get("name");
      const type = parsed.searchParams.get("type");
      asked.push(name + " " + type);
      const chain: Record<string, { type: number; data: string }[]> = {
        "calendar.example.com A": [{ type: 5, data: "a.example.net." }],
        "a.example.net A": [{ type: 5, data: "b.example.net." }],
        "b.example.net A": [{ type: 1, data: "8.8.8.8" }],
        "b.example.net AAAA": [{ type: 28, data: "2001:4860:4860::8888" }],
      };
      return { ok: true, async json() { return { Answer: chain[name + " " + type] || [] }; } };
    };
    await expect(resolveHostPublic("calendar.example.com", dns)).resolves.toEqual(["8.8.8.8", "2001:4860:4860::8888"]);
    expect(asked).toContain("a.example.net A");
    expect(asked).toContain("b.example.net AAAA");

    const poisoned = async (url: string) => {
      const name = new URL(String(url)).searchParams.get("name");
      const rows = name === "calendar.example.com"
        ? [{ type: 5, data: "metadata.google.internal." }, { type: 1, data: "8.8.8.8" }]
        : [{ type: 1, data: "10.1.2.3" }];
      return { ok: true, async json() { return { Answer: rows }; } };
    };
    await expect(resolveHostPublic("calendar.example.com", poisoned)).rejects.toThrow(/blocked_host/);
    const privateHop = async (url: string) => {
      const name = new URL(String(url)).searchParams.get("name");
      const type = new URL(String(url)).searchParams.get("type");
      if (name === "calendar.example.com") return { ok: true, async json() { return { Answer: [{ type: 5, data: "hidden.example.net." }] }; } };
      if (name === "hidden.example.net" && type === "A") return { ok: true, async json() { return { Answer: [{ type: 1, data: "10.9.9.9" }] }; } };
      return { ok: true, async json() { return { Answer: [] }; } };
    };
    await expect(resolveHostPublic("calendar.example.com", privateHop)).rejects.toThrow(/blocked_host/);

    let lookups = 0;
    const fetched: string[] = [];
    const sameHost = await fetchCalendarText("https://calendar.google.com/calendar/ical/secret/basic.ics", {
      resolve: async () => {
        lookups += 1;
        return ["142.250.1.1"];
      },
      fetch: async (url: string) => {
        fetched.push(String(url));
        if (fetched.length === 1) {
          return {
            status: 302,
            ok: false,
            headers: { get: (name: string) => (name.toLowerCase() === "location" ? "https://calendar.google.com/calendar/ical/secret/moved.ics" : null) },
            text: async () => "",
          };
        }
        return {
          status: 200,
          ok: true,
          headers: { get: () => null },
          text: async () => "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
        };
      },
    });
    expect(sameHost.ok).toBe(true);
    expect(lookups).toBe(1);
    expect(fetched).toHaveLength(2);
  });
});

describe("public busy ranges", () => {
  it("publishes 15-minute ranges and merges nearby events", () => {
    expect(coarsenBusyBlocks([
      { start: "2026-10-21T15:07:00.000Z", end: "2026-10-21T15:38:00.000Z" },
    ])).toEqual([{ start: "2026-10-21T15:00:00.000Z", end: "2026-10-21T15:45:00.000Z" }]);
    expect(coarsenBusyBlocks([
      { start: "2026-10-21T15:07:00.000Z", end: "2026-10-21T15:20:00.000Z" },
      { start: "2026-10-21T15:40:00.000Z", end: "2026-10-21T16:05:00.000Z" },
    ])).toEqual([{ start: "2026-10-21T15:00:00.000Z", end: "2026-10-21T16:15:00.000Z" }]);
  });

  it("serves coarsened blocks on the public route and keeps the precise cache for booking checks", async () => {
    const kv = memoryKv();
    const precise = [{ start: "2026-10-21T15:07:00.000Z", end: "2026-10-21T15:38:00.000Z" }];
    await kv.put("calBusy:harbor", JSON.stringify({ syncedAt: Date.now(), blocks: precise, refreshAttemptedAt: Date.now() }));
    await kv.put("calFeeds:harbor", JSON.stringify({
      tenantId: "harbor",
      feeds: [{ id: "feed1", url: "https://calendar.google.com/calendar/ical/secret/basic.ics" }],
    }));
    const env = { AUTH_KV: kv };
    const pub = await handleCalendarBusy(new Request("https://schedi.app/api/calendar-busy?tenant=harbor"), env);
    const body = await pub.json() as { blocks: { start: string; end: string }[] };
    expect(body.blocks).toEqual([{ start: "2026-10-21T15:00:00.000Z", end: "2026-10-21T15:45:00.000Z" }]);
    let fetches = 0;
    const blocks = await busyBlocksForTenant(env, "harbor", {
      freshMs: 120000,
      fetch: async () => { fetches += 1; return { status: 200, ok: true, headers: { get: () => null }, text: async () => "" }; },
    });
    expect(fetches).toBe(0);
    expect(blocks).toEqual(precise);
  });

  it("fetches a stale public booking cache once per two minutes and logs a fail-open timeout", async () => {
    const kv = memoryKv();
    const precise = [{ start: "2026-10-21T15:07:00.000Z", end: "2026-10-21T15:22:00.000Z" }];
    await kv.put("calBusy:harbor", JSON.stringify({ syncedAt: Date.now() - 10 * 60 * 1000, blocks: precise }));
    await kv.put("calFeeds:harbor", JSON.stringify({
      tenantId: "harbor",
      feeds: [{ id: "feed1", url: "https://calendar.google.com/calendar/ical/secret/basic.ics" }],
    }));
    let fetches = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    try {
      const deps = {
        freshMs: 120000,
        timeoutMs: 30,
        resolve: async () => ["8.8.8.8"],
        fetch: async () => {
          fetches += 1;
          await gate;
          return { status: 200, ok: true, headers: { get: () => null }, text: async () => "BEGIN:VCALENDAR" };
        },
      };
      const first = await busyBlocksForTenant({ AUTH_KV: kv }, "harbor", deps);
      const second = await busyBlocksForTenant({ AUTH_KV: kv }, "harbor", deps);
      expect(first).toEqual(precise);
      expect(second).toEqual(precise);
      expect(fetches).toBe(1);
      expect(logs.some((line) => line.includes("refresh_fail_open") && line.includes("timeout"))).toBe(true);
      expect(logs.join("\n")).not.toContain("secret");
    } finally {
      console.log = original;
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  it("runs one feed fetch for five concurrent stale booking checks", async () => {
    const kv = memoryKv();
    const precise = [{ start: "2026-10-21T15:07:00.000Z", end: "2026-10-21T15:22:00.000Z" }];
    await kv.put("calBusy:race", JSON.stringify({ syncedAt: Date.now() - 10 * 60 * 1000, blocks: precise }));
    await kv.put("calFeeds:race", JSON.stringify({
      tenantId: "race",
      feeds: [{ id: "feed1", url: "https://calendar.google.com/calendar/ical/secret/basic.ics" }],
    }));
    let fetches = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deps = {
      freshMs: 120000,
      timeoutMs: 4000,
      resolve: async () => ["8.8.8.8"],
      fetch: async () => {
        fetches += 1;
        await gate;
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => "BEGIN:VCALENDAR" };
      },
    };
    const pending = [0, 1, 2, 3, 4].map(() => busyBlocksForTenant({ AUTH_KV: kv }, "race", deps));
    for (let i = 0; i < 20 && fetches < 1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetches).toBe(1);
    release();
    const rows = await Promise.all(pending);
    expect(fetches).toBe(1);
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row).toEqual(precise);
  });
});

function memoryKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string) { return store.has(key) ? store.get(key)! : null; },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
  };
}

describe("owner subscribe feed", () => {
  it("hides the private URL, serves bookings, and rotates the token", async () => {
    const kv = memoryKv();
    const env = { AUTH_KV: kv, FIREBASE_PROJECT_ID: "" };
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:busy@example",
      "DTSTART:20261021T150000Z",
      "DTEND:20261021T160000Z",
      "SUMMARY:Hidden title",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const deps = {
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
      isAllowedOrigin: () => true,
      readSession: async (_env: unknown, token: string) => (token === "sess" ? { role: "owner", tenantId: "harbor" } : null),
      getTenant: async () => ({ id: "harbor", name: "Harbor Studio", timezone: "America/New_York", address: "18 Harbor Lane", showPublicAddress: true }),
      fetch: async () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => ics }),
      resolve: async () => ["142.250.1.1"],
    };
    const add = await handleCalendarFeeds(new Request("https://schedi.app/api/calendar-feeds", {
      method: "POST",
      body: JSON.stringify({ action: "add", session: "sess", tenantId: "harbor", url: "https://calendar.google.com/calendar/ical/secret-token/basic.ics" }),
    }), env, "https://schedi.app", deps);
    const added = await add.json() as { ok: boolean; feeds: { masked: string; eventCount: number }[]; ownerFeed: { https: string; webcal: string }; blocks: { start: string }[] };
    expect(added.ok).toBe(true);
    expect(added.feeds[0].masked).toBe("calendar.google.com/…/basic.ics");
    expect(JSON.stringify(added)).not.toContain("secret-token");
    expect(added.feeds[0].eventCount).toBe(1);
    expect(added.blocks[0].start).toBe("2026-10-21T15:00:00.000Z");
    expect(added.ownerFeed.https).toMatch(/^https:\/\/schedi\.app\/api\/owner-feed\/[a-f0-9]{48}\.ics$/);
    expect(added.ownerFeed.webcal.startsWith("webcal://")).toBe(true);

    await kv.put("privateAppts:harbor", JSON.stringify({
      revision: 1,
      appointments: [
        { id: "BK-1", date: "2026-10-21", time: "11:00 AM", durationMins: 45, serviceName: "Cut & style", clientName: "Ada Lovelace", status: "confirmed" },
        { id: "BK-2", date: "2026-10-22", time: "01:00 PM", durationMins: 30, serviceName: "Beard trim", clientName: "Grace Hopper", status: "cancelled", cancelled: true },
      ],
    }));
    const token = added.ownerFeed.https.split("/").pop()!.replace(".ics", "");
    const feed = await handleOwnerFeed(new Request(added.ownerFeed.https), env, token, {
      loadAppointments: async () => JSON.parse((await kv.get("privateAppts:harbor")) || "{}").appointments,
      getTenantById: async () => ({ id: "harbor", name: "Harbor Studio", timezone: "America/New_York", address: "18 Harbor Lane", showPublicAddress: true }),
      firebaseAnonymousToken: async () => "anon",
    });
    const text = await feed.text();
    expect(feed.headers.get("Content-Type")).toContain("text/calendar");
    expect(text).toContain("Ada Lovelace — Cut & style");
    expect(text).toContain("LOCATION:18 Harbor Lane");
    expect(text).not.toContain("Grace Hopper");
    expect(text).not.toContain("Hidden title");

    const hidden = buildOwnerFeedIcs(
      { name: "Harbor Studio", timezone: "America/New_York", address: "18 Harbor Lane", showPublicAddress: false },
      [{ id: "BK-1", date: "2026-10-21", time: "11:00 AM", durationMins: 45, serviceName: "Cut & style", clientName: "Ada Lovelace" }],
      new Date("2026-10-20T12:00:00.000Z"),
    );
    expect(hidden).not.toContain("LOCATION:");
    expect(hidden).toContain("DTSTART:20261021T150000Z");

    const reset = await handleCalendarFeeds(new Request("https://schedi.app/api/calendar-feeds", {
      method: "POST",
      body: JSON.stringify({ action: "reset-feed", session: "sess", tenantId: "harbor" }),
    }), env, "https://schedi.app", deps);
    const rotated = await reset.json() as { ownerFeed: { https: string } };
    expect(rotated.ownerFeed.https).not.toBe(added.ownerFeed.https);
    const stale = await handleOwnerFeed(new Request(added.ownerFeed.https), env, token, {
      loadAppointments: async () => [],
      getTenantById: async () => ({ id: "harbor", name: "Harbor" }),
      firebaseAnonymousToken: async () => "anon",
    });
    expect(stale.status).toBe(404);
    const dates = googleCalendarDatesParam(new Date("2026-10-21T15:00:00.000Z"), new Date("2026-10-21T16:00:00.000Z"));
    expect(dates).toBe("20261021T150000Z/20261021T160000Z");
    expect(dates.includes("%2F")).toBe(false);
  });
});
