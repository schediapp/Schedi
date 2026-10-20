import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;

function extractFunction(source: string, name: string): string {
  const assigned = source.indexOf("window." + name + " = function");
  const declared = source.indexOf("function " + name);
  const start = assigned >= 0 ? assigned : declared;
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

function pageFns(names: string[]) {
  const src = names.map((name) => extractFunction(html, name)).join("\n");
  return new Function(`${src}\nreturn { ${names.join(", ")} };`)() as Record<string, (...args: any[]) => any>;
}

const page = pageFns([
  "esc",
  "hasPricedAmount",
  "roundMoney",
  "showPublicAddressOn",
  "getTenantLocation",
  "publicTenantLocation",
  "readAddressDisplay",
  "clientFacingAddress",
  "appointmentIsClientConfirmed",
  "appointmentUpdatedText",
  "appointmentUpdatedLocationValue",
  "appointmentUpdatedCents",
  "appointmentUpdatedPriceFromCents",
  "appointmentPriceText",
  "appointmentUpdatedPaid",
  "appointmentUpdatedPayKey",
  "appointmentUpdatedPayFact",
  "appointmentPaymentDetail",
  "appointmentUpdatedPaySame",
  "appointmentClientChanges",
  "appointmentUpdatedVisibleRows",
  "appointmentEditMailPlan",
  "getTenantPublicBookingSlug",
  "appointmentManageUrl",
  "seriesManagePlainNote",
  "formatFriendlyLocalDateEmail",
  "formatConfirmEmailCalParts",
  "confirmEmailPriceLabel",
  "clientEmailShellHtml",
  "clientEmailDateCardHtml",
  "clientEmailRowsHtml",
  "clientEmailButtonHtml",
  "appointmentUpdatedChangeRowHtml",
  "ownerContactPhrase",
  "businessReplyTo",
  "buildAppointmentUpdatedEmail",
]);

import {
  appointmentClientChanges,
  appointmentEditMailPlan,
  appointmentIsClientConfirmed,
  appointmentPaymentDetail,
  appointmentPriceText,
  clientFacingAddress,
  readAddressDisplay,
} from "../workers/schedi-email-worker/src/appointment-updated.js";
import { handleBookingMailPost, mailContentProblem } from "../workers/schedi-email-worker/src/booking-mail.js";

const hoisted = vi.hoisted(() => ({
  bookings: [] as Record<string, unknown>[],
  readSession: vi.fn(async () => ({ role: "owner", tenantId: "harbor", email: "owner@example.com" })),
}));

vi.mock("../workers/schedi-email-worker/src/rate-limit.js", () => ({
  rateLimitOk: vi.fn(async () => true),
}));
vi.mock("../workers/schedi-email-worker/src/owner-auth.js", () => ({
  readSession: (...args: unknown[]) => hoisted.readSession(...args),
}));
vi.mock("../workers/schedi-email-worker/src/private-bookings.js", () => ({
  loadPrivateAppointments: vi.fn(async () => hoisted.bookings),
}));

function confirmed(extra: Record<string, unknown> = {}) {
  return {
    id: "HB-1001",
    clientName: "Maya Chen",
    clientEmail: "maya@example.com",
    serviceName: "Cut & style",
    amount: 65,
    date: "2026-10-20",
    time: "09:00 AM",
    status: "accepted",
    paymentStatus: "PAID VIA CARD",
    paidMethod: "card",
    durationMins: 45,
    manageToken: "manage-token-0001",
    ...extra,
  };
}

const tenant = {
  id: "harbor",
  slug: "harbor",
  name: "Harbor Studio",
  address: "18 Harbor Lane, Brooklyn, NY",
  ownerName: "Avery",
  ownerEmail: "avery@example.com",
  notifications: { replyTo: "avery@example.com" },
};

describe("appointment edit mail plan", () => {
  const pairs: Array<[string, Record<string, unknown>, Record<string, unknown>, { notify?: boolean; tenant?: Record<string, unknown> }, string]> = [
    ["service change", confirmed(), confirmed({ serviceName: "Color" }), { notify: true, tenant }, "updated"],
    ["price 65 vs 65.00 is quiet", confirmed({ amount: 65 }), confirmed({ amount: "65.00" }), { notify: true, tenant }, "none"],
    ["price change", confirmed({ amount: 65 }), confirmed({ amount: 80 }), { notify: true, tenant }, "updated"],
    ["blank price", confirmed({ amount: 65 }), confirmed({ amount: null }), { notify: true, tenant }, "updated"],
    ["staff", confirmed(), confirmed({ staffName: "Sam" }), { notify: true, tenant }, "updated"],
    ["note to the client", confirmed(), confirmed({ notesToClient: "Bring a photo." }), { notify: true, tenant }, "updated"],
    ["internal note only", confirmed({ internalNote: "old" }), confirmed({ internalNote: "new", ownerNote: "x" }), { notify: true, tenant }, "none"],
    ["client name only", confirmed(), confirmed({ clientName: "Maya C." }), { notify: true, tenant }, "none"],
    ["date change is the reschedule email only", confirmed(), confirmed({ date: "2026-10-21", serviceName: "Color" }), { notify: true, tenant }, "reschedule"],
    ["time change", confirmed(), confirmed({ time: "10:00 AM" }), { notify: true, tenant }, "reschedule"],
    ["checkbox off", confirmed(), confirmed({ serviceName: "Color" }), { notify: false, tenant }, "none"],
    ["pending", confirmed({ status: "pending" }), confirmed({ status: "pending", serviceName: "Color" }), { notify: true, tenant }, "none"],
    ["walk-in", confirmed({ walkIn: true }), confirmed({ walkIn: true, serviceName: "Color" }), { notify: true, tenant }, "none"],
    ["cancelled", confirmed({ status: "cancelled" }), confirmed({ status: "cancelled", serviceName: "Color" }), { notify: true, tenant }, "none"],
    ["no-show", confirmed({ noShow: true }), confirmed({ noShow: true, amount: 10 }), { notify: true, tenant }, "none"],
    ["no email", confirmed({ clientEmail: "" }), confirmed({ clientEmail: "", serviceName: "Color" }), { notify: true, tenant }, "none"],
    ["location shown", confirmed(), confirmed({ location: "Studio B" }), { notify: true, tenant }, "updated"],
    ["hidden location only", confirmed(), confirmed({ location: "Studio B" }), { notify: true, tenant: { ...tenant, addressDisplay: "hide" } }, "none"],
    ["hidden location plus service", confirmed(), confirmed({ location: "Studio B", serviceName: "Color" }), { notify: true, tenant: { ...tenant, addressDisplay: "hide" } }, "updated"],
    ["public address toggle off hides a location change", confirmed({ location: "18 Harbor Lane, Brooklyn, NY" }), confirmed({ location: "22 Dock Street, Brooklyn, NY" }), { notify: true, tenant: { ...tenant, showPublicAddress: false } }, "none"],
    ["public address toggle off hides an address change", confirmed({ address: "18 Harbor Lane, Brooklyn, NY" }), confirmed({ address: "22 Dock Street, Brooklyn, NY" }), { notify: true, tenant: { ...tenant, showPublicAddress: false } }, "none"],
    ["public address toggle off still reports the service", confirmed({ location: "18 Harbor Lane, Brooklyn, NY" }), confirmed({ location: "22 Dock Street, Brooklyn, NY", serviceName: "Color" }), { notify: true, tenant: { ...tenant, showPublicAddress: false } }, "updated"],
    ["public address toggle on still reports the location", confirmed({ location: "Front desk" }), confirmed({ location: "Studio B" }), { notify: true, tenant: { ...tenant, showPublicAddress: true } }, "updated"],
    ["payment method", confirmed(), confirmed({ paymentStatus: "PAID VENMO", paymentMethod: "venmo", paidMethod: "venmo", paymentOptionLabel: "Venmo" }), { notify: true, tenant }, "updated"],
    ["same card rewritten by the edit form", confirmed(), confirmed({ paymentStatus: "PAID VIA CARD", paymentMethod: "card", paymentOptionLabel: "Card", paidMethod: "card" }), { notify: true, tenant }, "none"],
  ];

  it.each(pairs)("%s", (_name, before, after, opts, plan) => {
    expect(page.appointmentEditMailPlan(before, after, opts)).toBe(plan);
    expect(appointmentEditMailPlan(before, after, opts)).toBe(plan);
    expect(page.appointmentClientChanges(before, after)).toEqual(appointmentClientChanges(before, after));
  });

  it("treats a blank status as confirmed and keeps price wording stable", () => {
    const before = confirmed({ status: "" });
    const after = confirmed({ status: "", amount: 65 });
    expect(page.appointmentIsClientConfirmed(before)).toBe(true);
    expect(appointmentIsClientConfirmed(before)).toBe(true);
    expect(page.appointmentPriceText(65)).toBe("$65");
    expect(appointmentPriceText("65.00")).toBe(page.appointmentPriceText("65.00"));
    expect(page.appointmentPaymentDetail(before)).toBe(appointmentPaymentDetail(after));
  });

  it("reads an address display preference and hides the address when asked", () => {
    expect(page.readAddressDisplay(tenant)).toBe(null);
    expect(readAddressDisplay({ showAddress: false })).toBe("hide");
    expect(page.readAddressDisplay({ notifications: { hideAddress: true } })).toBe("hide");
    expect(readAddressDisplay({ addressDisplay: "public" })).toBe("show");
    expect(page.clientFacingAddress(tenant)).toBe("18 Harbor Lane, Brooklyn, NY");
    expect(clientFacingAddress({ ...tenant, addressDisplay: "hidden" })).toBe("");
    expect(page.clientFacingAddress({ ...tenant, showAddress: false })).toBe(clientFacingAddress({ ...tenant, showAddress: false }));
    expect(page.readAddressDisplay({ ...tenant, showPublicAddress: false })).toBe("hide");
    expect(readAddressDisplay({ ...tenant, showPublicAddress: false, addressDisplay: "public" })).toBe("hide");
    expect(page.readAddressDisplay({ ...tenant, showPublicAddress: true })).toBe(readAddressDisplay({ ...tenant, showPublicAddress: true }));
    expect(page.clientFacingAddress({ ...tenant, showPublicAddress: false })).toBe("");
    expect(clientFacingAddress({ ...tenant, showPublicAddress: false })).toBe("");
    expect(extractFunction(html, "readAddressDisplay")).toContain("showPublicAddressOn");
  });

  it("drops a hidden location from the change list and keeps the service", () => {
    const changes = page.appointmentClientChanges(confirmed(), confirmed({ location: "Studio B", serviceName: "Color" }));
    expect(changes.rows.map((row: { key: string }) => row.key)).toEqual(["service", "location"]);
    const hidden = { ...tenant, notifications: { addressDisplay: "hide" } };
    expect(page.appointmentEditMailPlan(confirmed(), confirmed({ location: "Studio B", serviceName: "Color" }), { notify: true, tenant: hidden })).toBe("updated");
  });
});

describe("appointment updated email", () => {
  it("summarises the change as a before and after list and passes the worker allowlist", () => {
    const before = confirmed();
    const after = confirmed({ serviceName: "Color", amount: 90, notesToClient: "Use the side door." });
    const mail = page.buildAppointmentUpdatedEmail(tenant, after, before);
    const builder = extractFunction(html, "buildAppointmentUpdatedEmail");
    expect(mail.subject).toBe("Appointment updated — Harbor Studio");
    expect(mail.text).toContain("changed a few things on your booking. The date and time stayed the same.");
    expect(mail.text).toContain("What changed");
    expect(mail.text).toContain("Before: Cut & style");
    expect(mail.text).toContain("Now: Color");
    expect(mail.text).toContain("Before: $65");
    expect(mail.text).toContain("Now: $90");
    expect(mail.text).toContain("Before: —");
    expect(mail.text).toContain("Now: Use the side door.");
    expect(mail.text).toContain("Manage my booking");
    expect(mail.text).toContain("https://schedi.app/harbor/manage/manage-token-0001");
    expect(mail.text).not.toContain("Add to calendar");
    expect(mail.text).not.toContain("18 Harbor Lane");
    expect(mail.html).toContain("WHAT CHANGED");
    expect(mail.html).toContain(">Before<");
    expect(mail.html).toContain(">Now<");
    expect(mail.html).toContain("<s>Cut &amp; style</s>");
    expect(mail.html).toContain(">Color<");
    expect(mail.html).toContain("Manage my booking");
    expect(mail.html).toContain("https://schedi.app/harbor/manage/manage-token-0001");
    for (const banned of [
      "Reschedule or cancel",
      "Manage / reschedule / cancel",
      "Here's everything you need",
      "Can you still make it",
      "See you tomorrow",
      "email-calendar-check.png",
      "email-calendar-reschedule.png",
      "18 Harbor Lane",
    ]) {
      expect(mail.html).not.toContain(banned);
      expect(mail.text).not.toContain(banned);
    }
    for (const shared of ["clientEmailShellHtml", "clientEmailDateCardHtml", "clientEmailRowsHtml", "clientEmailButtonHtml"]) {
      expect(builder).not.toContain(shared);
    }
    expect(mailContentProblem(mail.html, mail.text, { paymentLinks: new Set() })).toBe("");
  });

  it("uses the singular line for one change and omits a hidden address", () => {
    const hidden = { ...tenant, addressDisplay: "hide" };
    const mail = page.buildAppointmentUpdatedEmail(hidden, confirmed({ serviceName: "Color", location: "Studio B" }), confirmed({ location: "Front desk" }));
    expect(mail.text).toContain("changed one thing on your booking. The date and time stayed the same.");
    expect(mail.text).toContain("Before: Cut & style");
    expect(mail.text).toContain("Now: Color");
    expect(mail.text).not.toContain("Location");
    expect(mail.text).not.toContain("Harbor Lane");
    expect(mail.html).not.toContain("Harbor Lane");
    expect(mail.html).not.toContain("Studio B");
    expect(mail.html).toContain("Manage my booking");
    expect(mailContentProblem(mail.html, mail.text, { paymentLinks: new Set() })).toBe("");
  });

  it("leaves the address out of What changed when the public address toggle is off", () => {
    const hidden = { ...tenant, showPublicAddress: false };
    const before = confirmed({
      location: "18 Harbor Lane, Brooklyn, NY",
      appointmentAddress: "18 Harbor Lane, Brooklyn, NY",
      address: "18 Harbor Lane, Brooklyn, NY",
    });
    const after = confirmed({
      serviceName: "Color",
      location: "22 Dock Street, Brooklyn, NY",
      appointmentAddress: "22 Dock Street, Brooklyn, NY",
      address: "22 Dock Street, Brooklyn, NY",
    });
    const mail = page.buildAppointmentUpdatedEmail(hidden, after, before);
    expect(mail.subject).toBe("Appointment updated — Harbor Studio");
    expect(mail.text).toContain("changed one thing on your booking");
    expect(mail.text).toContain("Now: Color");
    expect(mail.text).not.toContain("Location");
    for (const secret of ["18 Harbor Lane", "22 Dock Street", "Brooklyn"]) {
      expect(mail.text).not.toContain(secret);
      expect(mail.html).not.toContain(secret);
      expect(mail.subject).not.toContain(secret);
    }
    expect(page.appointmentEditMailPlan(before, after, { notify: true, tenant: hidden })).toBe("updated");
    expect(appointmentEditMailPlan(before, after, { notify: true, tenant: hidden })).toBe("updated");

    const addressOnly = page.buildAppointmentUpdatedEmail(
      hidden,
      confirmed({ address: "22 Dock Street, Brooklyn, NY" }),
      confirmed({ address: "18 Harbor Lane, Brooklyn, NY" }),
    );
    expect(addressOnly.text).not.toContain("Harbor Lane");
    expect(addressOnly.text).not.toContain("Dock Street");
    expect(addressOnly.html).not.toContain("Harbor Lane");
    expect(addressOnly.html).not.toContain("Dock Street");
    expect(addressOnly.html).not.toContain("Location");
  });
});

describe("booking_update worker", () => {
  const sendResend = vi.fn(async () => ({ ok: true, id: "mail_1" }));

  function deps() {
    return {
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
      isAllowedOrigin: () => true,
      getTenantById: async () => ({ name: "Harbor Studio", ownerEmail: "avery@example.com", ownerName: "Avery", notifications: { replyTo: "avery@example.com" } }),
      firebaseAnonymousToken: async () => "token",
      sendResend,
      sendBookingConfirmationSms: async () => ({ ok: true }),
      ownerNotifyEnabledForTenant: () => false,
      escapeHtml: (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c)),
      safeTenantId: (value: unknown) => (/^[A-Za-z0-9_-]{1,80}$/.test(String(value || "").trim()) ? String(value).trim() : ""),
      sleep: async () => {},
    };
  }

  async function post(body: Record<string, unknown>) {
    const request = new Request("https://schedi.app/api/send-booking-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const response = await handleBookingMailPost(request, { AUTH_KV: null }, "https://schedi.app", deps());
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  it("sends a confirmed update and rejects a hyphen subject, a client token, a walk-in, and a pending booking", async () => {
    sendResend.mockClear();
    const mail = page.buildAppointmentUpdatedEmail(tenant, confirmed({ serviceName: "Color" }), confirmed());
    hoisted.bookings = [confirmed({ serviceName: "Color" })];
    const ok = await post({
      tenantId: "harbor",
      bookingId: "HB-1001",
      session: "owner-session-token",
      type: "booking_update",
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(sendResend).toHaveBeenCalledTimes(1);
    const sent = sendResend.mock.calls[0][1] as { to: string; subject: string };
    expect(sent.to).toBe("maya@example.com");
    expect(sent.subject).toBe("Appointment updated — Harbor Studio");

    const hyphen = await post({ ...{
      tenantId: "harbor", bookingId: "HB-1001", session: "owner-session-token", type: "booking_update",
      subject: "Appointment updated - Harbor Studio", html: mail.html, text: mail.text,
    } });
    expect(hyphen.body.error).toBe("subject_not_allowed");

    const client = await post({
      tenantId: "harbor",
      bookingId: "HB-1001",
      manageToken: "manage-token-0001",
      type: "booking_update",
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    expect(client.status).toBe(401);
    expect(client.body.error).toBe("session_required");

    hoisted.bookings = [confirmed({ walkIn: true, serviceName: "Color" })];
    const walkIn = await post({
      tenantId: "harbor", bookingId: "HB-1001", session: "owner-session-token", type: "booking_update",
      subject: mail.subject, html: mail.html, text: mail.text,
    });
    expect(walkIn.body).toMatchObject({ ok: true, skipped: true, reason: "walk_in" });

    hoisted.bookings = [confirmed({ status: "pending", serviceName: "Color" })];
    const pending = await post({
      tenantId: "harbor", bookingId: "HB-1001", session: "owner-session-token", type: "booking_update",
      subject: mail.subject, html: mail.html, text: mail.text,
    });
    expect(pending.body).toMatchObject({ ok: true, skipped: true, reason: "not_confirmed" });
    expect(sendResend).toHaveBeenCalledTimes(1);
  });
});

describe("owner dashboard edit and list chrome", () => {
  const cssStart = html.indexOf('<style id="schediNewDashStyle">');
  const css = html.slice(cssStart, html.indexOf("</style>", cssStart));

  it("offers the client email option only on the edit save path", () => {
    expect(html).toContain("Email the client about this change");
    expect(html).toContain('id="manEmailClient"');
    const submit = extractFunction(html, "handleManualBookingSubmit");
    expect(submit).toContain("appointmentEditMailPlan");
    expect(submit).toContain("sendAppointmentUpdatedEmail");
    expect(submit).toContain("sendClientRescheduleEmail");
    expect(submit.indexOf("sendClientRescheduleEmail")).toBeLessThan(submit.indexOf("sendAppointmentUpdatedEmail"));
    expect(extractFunction(html, "manualBookingFormSnapshot")).not.toContain("manEmailClient");
    const reschedule = extractFunction(html, "handleTenantRescheduleSubmit");
    expect(reschedule).toContain("sendClientRescheduleEmail");
    expect(reschedule).not.toContain("sendAppointmentUpdatedEmail");
    expect(extractFunction(html, "buildAppointmentUpdatedEmail")).toContain("Appointment updated");
    expect(extractFunction(html, "sendAppointmentUpdatedEmail")).toContain("'booking_update'");
  });

  it("lays the filter row out in a column, keeps one search clear, and uses an emerald hover", () => {
    expect(html).not.toContain("hover:bg-slate-900/40");
    expect(css).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(css).toContain(".sd-roster-bar");
    expect(css).toContain("::-webkit-search-cancel-button");
    expect(css).toContain("rgba(16, 185, 129, 0.12)");
    expect(css).toContain("rgba(5, 150, 105, 0.1)");
    expect(html).toContain('id="rosterSearchClear"');
  });
});

const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

describe.skipIf(!chrome)("appointment updated dashboard browser", () => {
  it("has no overflow, one search clear, a tidy filter row, and a slate/emerald hover", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json",
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
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const tab = await browser.newPage();
      const errors: string[] = [];
      tab.on("pageerror", (error) => errors.push(String(error)));
      await tab.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await tab.waitForFunction(() => document.body.textContent?.includes("Maya Chen"), { timeout: 20000 });
      await tab.evaluate(() => (window as unknown as { schediDashGo: (page: string) => void }).schediDashGo("appointments"));
      await tab.waitForSelector("#tenantRosterTableBody tr.roster-row");

      const widths = [390, 768, 1024, 1280, 1920];
      for (const theme of ["dark", "light"] as const) {
        await tab.evaluate((next) => (window as unknown as { setSchediTheme: (theme: string) => void }).setSchediTheme(next), theme);
        for (const width of widths) {
          await tab.setViewport({ width, height: 900 });
          const view = await tab.evaluate((nextTheme) => {
            const pages = ["appointments", "clients"];
            const go = (window as unknown as { schediDashGo: (page: string) => void }).schediDashGo;
            const overflows: string[] = [];
            for (const pageName of pages) {
              go(pageName);
              const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
              if (overflow > 1) overflows.push(pageName + ":" + overflow);
            }
            go("appointments");
            (window as unknown as { setRosterCalendarView: (view: string) => void }).setRosterCalendarView("week");
            const weekOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
            (window as unknown as { setRosterCalendarView: (view: string) => void }).setRosterCalendarView("list");
            const filter = document.getElementById("rosterPayFilter");
            const filterDisplay = filter ? getComputedStyle(filter).display : "";
            const columns = filter ? getComputedStyle(filter).gridTemplateColumns : "";
            return { overflows, weekOverflow, filterDisplay, columns, theme: nextTheme };
          }, theme);
          expect(view.overflows, `${width} ${theme}`).toEqual([]);
          expect(view.weekOverflow, `week ${width} ${theme}`).toBeLessThanOrEqual(1);
          if (width === 1024) {
            expect(view.filterDisplay).toBe("grid");
            expect(view.columns.split(" ").length).toBe(3);
          }
          if (width === 390) expect(view.filterDisplay).toBe("none");
        }
      }

      await tab.setViewport({ width: 1280, height: 900 });
      await tab.evaluate(() => {
        (window as unknown as { setSchediTheme: (theme: string) => void }).setSchediTheme("dark");
        (window as unknown as { schediDashGo: (page: string) => void }).schediDashGo("appointments");
        const input = document.getElementById("rosterSearchInput") as HTMLInputElement;
        input.value = "Maya";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await tab.waitForFunction(() => {
        const clear = document.getElementById("rosterSearchClear");
        return !!clear && !clear.hidden;
      });
      const search = await tab.evaluate(() => {
        const input = document.getElementById("rosterSearchInput") as HTMLInputElement;
        const field = document.getElementById("rosterSearchField");
        const cancel = getComputedStyle(input, "::-webkit-search-cancel-button");
        const visibleClears = field ? [...field.querySelectorAll("button")].filter((button) => {
          const style = getComputedStyle(button);
          return style.display !== "none" && style.visibility !== "hidden" && !button.hidden;
        }).length : 0;
        return { display: cancel.display, width: cancel.width, visibleClears, type: input.type, role: input.getAttribute("role") };
      });
      expect(search.type).toBe("text");
      expect(search.role).toBe("searchbox");
      expect(search.visibleClears).toBe(1);

      await tab.evaluate(() => {
        const input = document.getElementById("rosterSearchInput") as HTMLInputElement;
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await tab.waitForFunction(() => document.getElementById("rosterSearchClear")?.hidden === true);
      const rowColor = async (want: string) => {
        await tab.hover("#tenantRosterTableBody tr.roster-row td");
        await tab.waitForFunction((expected) => {
          const row = document.querySelector("#tenantRosterTableBody tr.roster-row");
          if (!row || !row.matches(":hover")) return false;
          return getComputedStyle(row).backgroundColor.replace(/\s/g, "") === expected;
        }, {}, want);
      };
      await rowColor("rgba(16,185,129,0.12)");

      await tab.evaluate(() => (window as unknown as { setSchediTheme: (theme: string) => void }).setSchediTheme("light"));
      await rowColor("rgba(5,150,105,0.1)");

      const emailBox = await tab.evaluate(() => {
        const open = (window as unknown as { openEditAppointment: (id: string) => void }).openEditAppointment;
        open("HB-1001");
        const confirmedBox = document.getElementById("manEmailClientBox");
        const confirmedChecked = (document.getElementById("manEmailClient") as HTMLInputElement).checked;
        const confirmedHidden = confirmedBox?.classList.contains("hidden");
        open("HB-1002");
        const pendingHidden = document.getElementById("manEmailClientBox")?.classList.contains("hidden");
        open("HB-1003");
        const walkHidden = document.getElementById("manEmailClientBox")?.classList.contains("hidden");
        (window as unknown as { closeManualBookingModal: () => void }).closeManualBookingModal();
        return {
          label: confirmedBox?.textContent || "",
          confirmedChecked,
          confirmedHidden,
          pendingHidden,
          walkHidden,
        };
      });
      expect(emailBox.label).toContain("Email the client about this change");
      expect(emailBox.confirmedChecked).toBe(true);
      expect(emailBox.confirmedHidden).toBe(false);
      expect(emailBox.pendingHidden).toBe(true);
      expect(emailBox.walkHidden).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120000);
});
