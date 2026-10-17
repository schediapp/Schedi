import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recordedPayMethod, sanitizeBooking } from "../workers/schedi-email-worker/src/private-bookings.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const BOOKING_TEMPLATE_SHA_MARKER = "return `<!DOCTYPE html>";

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

function dashCss(source: string): string {
  const marker = '<style id="schediNewDashStyle">';
  const start = source.indexOf(marker);
  const end = source.indexOf("</style>", start);
  return source.slice(start + marker.length, end);
}

function unscopedSelectors(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const bad: string[] = [];
  function walk(block: string) {
    let i = 0;
    while (i < block.length) {
      while (i < block.length && /\s/.test(block[i])) i++;
      if (i >= block.length) break;
      const brace = block.indexOf("{", i);
      if (brace < 0) break;
      const selector = block.slice(i, brace).trim();
      let depth = 0;
      let j = brace;
      for (; j < block.length; j++) {
        if (block[j] === "{") depth++;
        else if (block[j] === "}") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      const body = block.slice(brace + 1, j - 1);
      if (selector.startsWith("@media") || selector.startsWith("@supports")) walk(body);
      else if (selector.startsWith("@keyframes") || selector.startsWith("@-webkit-keyframes")) {
        if (!selector.includes("schedi-newdash")) bad.push(selector);
      } else {
        for (const part of selector.split(",")) {
          if (!part.includes("schedi-newdash")) bad.push(part.trim());
        }
      }
      i = j;
    }
  }
  walk(clean);
  return bad;
}

const names = [
  "reportTodayIso",
  "reportShiftIso",
  "reportWeekStart",
  "reportPrettyShort",
  "reportMoney",
  "reportAmount",
  "reportIsCancelled",
  "reportIsDenied",
  "appointmentIsNoShow",
  "appointmentReportNoShow",
  "appointmentReportRange",
  "appointmentReportSampleVisits",
  "reportClockMinutes",
  "reportNowParts",
  "reportAppointmentStarted",
  "reportIsDeleted",
  "reportIsPending",
  "reportIsDoneStatus",
  "reportIsConfirmedStatus",
  "reportCancelledAfterConfirm",
  "appointmentCompletionOf",
  "appointmentCompletionSummary",
  "appointmentReportModel",
  "appointmentReportCsv",
  "appointmentReportChartSvg",
  "appointmentReportAvgLabel",
  "bookingPaymentState",
];

const lib = names.map((name) => extractFunction(html, name)).join("\n");
const api = new Function(`${lib}; return { reportTodayIso, reportShiftIso, appointmentReportRange, appointmentReportSampleVisits, appointmentReportModel, appointmentReportCsv, appointmentReportChartSvg, appointmentReportNoShow, bookingPaymentState, appointmentCompletionOf, appointmentCompletionSummary };`)() as {
  reportTodayIso: (tz: string, now: Date) => string;
  reportShiftIso: (iso: string, days: number) => string;
  appointmentReportRange: (preset: string, today: string, from?: string, to?: string) => { from: string; to: string; label: string; clamped?: boolean };
  appointmentReportSampleVisits: (from: string, to: string) => { total: number; days: number; sample: boolean };
  appointmentCompletionOf: (row: unknown, asOf?: { date: string; minutes: number }) => string;
  appointmentCompletionSummary: (rows: unknown[], asOf?: { date: string; minutes: number }) => { done: number; notDone: number; percent: number | null; label: string; detail: string };
  appointmentReportModel: (rows: unknown[], range: { from: string; to: string }, pay: (row: unknown) => string, asOf?: { date: string; minutes: number }) => {
    total: number;
    revenue: number;
    confirmed: number;
    cancelled: number;
    unpaid: number;
    denied: number;
    pending: number;
    weeks: { start: string; bookings: number; revenue: number }[];
    avgBookings: number;
    avgRevenue: number;
    noShow: { available: boolean; count: number; label: string; reason: string };
    rows: unknown[];
    completion: { done: number; notDone: number; percent: number | null; label: string; detail: string };
  };
  appointmentReportCsv: (model: { rows: unknown[] }, pay: (row: unknown) => string) => string;
  appointmentReportChartSvg: (weeks: { start: string; bookings: number; revenue: number }[], field: string, format: (n: number) => string, label: string) => string;
  appointmentReportNoShow: (rows?: unknown[]) => { available: boolean; count: number; label: string; reason: string };
  bookingPaymentState: (row: unknown) => string;
};

const pay = api.bookingPaymentState;

describe("appointment report math", () => {
  const range = api.appointmentReportRange("7", "2026-10-16");

  it("keeps last 7, 30, and 90 days ending on today", () => {
    expect(range).toMatchObject({ from: "2026-10-10", to: "2026-10-16" });
    expect(api.appointmentReportRange("30", "2026-10-16").from).toBe("2026-09-17");
    expect(api.appointmentReportRange("90", "2026-10-16").from).toBe("2026-07-19");
    const custom = api.appointmentReportRange("custom", "2026-10-16", "2026-11-02", "2026-10-01");
    expect(custom.from).toBe("2026-10-01");
    expect(custom.to).toBe("2026-11-02");
    const long = api.appointmentReportRange("custom", "2026-10-16", "2024-01-01", "2026-10-16");
    expect(long.clamped).toBe(true);
    expect(long.to).toBe(api.reportShiftIso("2024-01-01", 366));
  });

  it("uses the business timezone for today", () => {
    const morning = new Date("2026-10-16T03:30:00Z");
    expect(api.reportTodayIso("America/New_York", morning)).toBe("2026-10-15");
    expect(api.reportTodayIso("Asia/Tokyo", morning)).toBe("2026-10-16");
  });

  it("counts revenue, confirmed, cancelled, and unpaid from saved bookings", () => {
    const rows = [
      { id: "a", date: "2026-10-10", amount: 99, status: "cancelled", paymentStatus: "PAID" },
      { id: "b", date: "2026-10-11", amount: 50, status: "denied", paymentStatus: "UNPAID" },
      { id: "c", date: "2026-10-12", amount: 10, status: "pending", paymentStatus: "PENDING CASH APP" },
      { id: "d", date: "2026-10-13", amount: 20, status: "accepted", paymentStatus: "PAID" },
      { id: "e", date: "2026-10-09", amount: 80, status: "accepted", paymentStatus: "PAID" },
      { id: "f", date: "2026-10-16", amount: "15", status: "", paymentStatus: "" },
      { id: "g", date: "nope", amount: 100, status: "accepted" },
    ];
    const model = api.appointmentReportModel(rows, range, pay);
    expect(model.rows.map((row) => (row as { id: string }).id)).toEqual(["a", "b", "c", "d", "f"]);
    expect(model.total).toBe(5);
    expect(model.cancelled).toBe(1);
    expect(model.denied).toBe(1);
    expect(model.revenue).toBe(45);
    expect(model.confirmed).toBe(2);
    expect(model.pending).toBe(1);
    expect(model.unpaid).toBe(2);
    expect(model.weeks.map((week) => week.start)).toEqual(["2026-10-04", "2026-10-11"]);
    expect(model.weeks[0].bookings).toBe(1);
    expect(model.weeks[0].revenue).toBe(0);
    expect(model.weeks[1].bookings).toBe(4);
    expect(model.weeks[1].revenue).toBe(45);
    expect(model.avgBookings).toBe(2.5);
    expect(model.avgRevenue).toBe(22.5);
    expect(model.noShow).toMatchObject({ available: true, count: 0, label: "0" });
    expect(model.noShow.reason).toMatch(/marked no-show/);
  });

  it("counts a no-show flag and a no_show status inside the range", () => {
    const rows = [
      { id: "shown", date: "2026-10-12", amount: 40, status: "accepted", paymentStatus: "PAID", noShow: true },
      { id: "status", date: "2026-10-13", amount: 10, status: "no_show", paymentStatus: "UNPAID" },
      { id: "kept", date: "2026-10-14", amount: 20, status: "accepted", paymentStatus: "PAID" },
      { id: "old", date: "2026-10-01", amount: 80, status: "accepted", noShow: true, paymentStatus: "PAID" },
    ];
    const model = api.appointmentReportModel(rows, range, pay);
    expect(model.rows.map((row) => (row as { id: string }).id)).toEqual(["shown", "status", "kept"]);
    expect(model.noShow).toMatchObject({ available: true, count: 2, label: "2" });
    expect(model.total).toBe(3);
    const csv = api.appointmentReportCsv(model, pay);
    expect(csv).toContain("paid,40,yes,yes,no,no,yes");
    expect(csv).toContain("unpaid,10,yes,yes,no,yes,yes");
    expect(csv).not.toContain("not recorded");
    expect(csv).not.toContain("old");
  });

  it("exports only the range and includes the computed fields", () => {
    const rows = [
      { id: "in", clientName: 'Ada "A"', date: "2026-10-13", time: "9:00 AM", status: "accepted", paymentStatus: "PAID", amount: 20, serviceName: "Cut" },
      { id: "out", date: "2026-10-01", status: "accepted", amount: 80, paymentStatus: "PAID" },
      { id: "late", date: "2026-10-12", status: "cancelled", amount: 40, paymentStatus: "PENDING" },
      { id: "miss", clientName: "Bea", date: "2026-10-14", time: "1:00 PM", status: "accepted", paymentStatus: "PAID", amount: 10, serviceName: "Cut", noShow: true },
    ];
    const model = api.appointmentReportModel(rows, range, pay);
    const csv = api.appointmentReportCsv(model, pay);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("payment_state");
    expect(lines[0]).toContain("counts_toward_revenue");
    expect(lines[0]).toContain("confirmed");
    expect(lines[0]).toContain("no_show");
    expect(lines).toHaveLength(4);
    expect(csv).toContain('"Ada ""A"""');
    expect(csv).toContain("paid,20,yes,yes,no,no,no");
    expect(csv).toContain("paid,10,yes,yes,no,no,yes");
    expect(csv).not.toContain("out");
    expect(csv).not.toContain("not recorded");
  });

  it("builds a bar for each week and a stable sample visit count", () => {
    const model = api.appointmentReportModel(
      [{ date: "2026-10-11", amount: 10, status: "accepted", paymentStatus: "PAID" }],
      range,
      pay
    );
    const svg = api.appointmentReportChartSvg(model.weeks, "bookings", (n) => String(n), "Bookings by week");
    expect(svg.match(/<rect /g)).toHaveLength(2);
    expect(svg).toContain('aria-label="Bookings by week.');
    expect(svg).not.toContain("Pro");
    const sample = api.appointmentReportSampleVisits("2026-10-10", "2026-10-16");
    expect(sample.sample).toBe(true);
    expect(sample.days).toBe(7);
    expect(sample.total).toBeGreaterThan(0);
    expect(api.appointmentReportSampleVisits("2026-10-10", "2026-10-16").total).toBe(sample.total);
    expect(api.appointmentReportNoShow().available).toBe(true);
    expect(api.appointmentReportNoShow().count).toBe(0);
  });

  it("counts completion only for visits that have already started", () => {
    const asOf = { date: "2026-10-16", minutes: 12 * 60 };
    const rows = [
      { id: "done", date: "2026-10-15", time: "9:00 AM", status: "completed" },
      { id: "confirmed", date: "2026-10-16", time: "9:00 AM", status: "accepted" },
      { id: "later", date: "2026-10-16", time: "3:00 PM", status: "accepted" },
      { id: "future", date: "2026-10-17", time: "9:00 AM", status: "completed" },
      { id: "noshow", date: "2026-10-14", time: "9:00 AM", status: "accepted", noShow: true },
      { id: "cancelled", date: "2026-10-14", time: "10:00 AM", status: "cancelled" },
      { id: "pending", date: "2026-10-14", time: "11:00 AM", status: "pending", noShow: true },
      { id: "denied", date: "2026-10-14", time: "12:00 PM", status: "denied" },
      { id: "deleted", date: "2026-10-14", time: "1:00 PM", status: "accepted", deleted: true },
    ];
    expect(api.appointmentCompletionOf(rows[0], asOf)).toBe("done");
    expect(api.appointmentCompletionOf(rows[1], asOf)).toBe("done");
    expect(api.appointmentCompletionOf(rows[2], asOf)).toBe("");
    expect(api.appointmentCompletionOf(rows[3], asOf)).toBe("");
    expect(api.appointmentCompletionOf(rows[4], asOf)).toBe("not_done");
    expect(api.appointmentCompletionOf(rows[5], asOf)).toBe("not_done");
    expect(api.appointmentCompletionOf(rows[6], asOf)).toBe("");
    expect(api.appointmentCompletionOf(rows[7], asOf)).toBe("");
    expect(api.appointmentCompletionOf(rows[8], asOf)).toBe("");
    const model = api.appointmentReportModel(rows, { from: "2026-10-01", to: "2026-10-20" }, pay, asOf);
    expect(model.completion).toMatchObject({
      done: 2,
      notDone: 2,
      percent: 50,
      label: "50%",
      detail: "2 done · 2 not done",
    });
    const empty = api.appointmentReportModel(
      [{ id: "future", date: "2026-10-17", time: "9:00 AM", status: "accepted" }],
      { from: "2026-10-17", to: "2026-10-17" },
      pay,
      asOf,
    );
    expect(empty.completion).toMatchObject({
      done: 0,
      notDone: 0,
      percent: null,
      label: "—",
      detail: "No past appointments in this range.",
    });
    const csv = api.appointmentReportCsv(model, pay);
    expect(csv.split("\n")[0].endsWith("completion")).toBe(true);
    expect(csv).toContain(",done");
    expect(csv).toContain(",not_done");
    const unchecked = api.appointmentReportModel(
      [{ id: "kept", date: "2026-10-14", time: "11:00 PM", status: "accepted" }],
      range,
      pay,
    );
    expect(unchecked.completion.done).toBe(1);
  });
});

describe("reports tab markup", () => {
  const templateAt = html.indexOf(BOOKING_TEMPLATE_SHA_MARKER);
  const owner = html.slice(0, templateAt);
  const template = html.slice(templateAt);

  it("keeps the print path and adds the range, cards, and charts", () => {
    expect(owner).toContain('id="tenantSectionReport"');
    expect(owner).toContain("Export CSV");
    expect(owner).toContain("printAppointmentReport()");
    expect(owner).toContain("Last 7 days");
    expect(owner).toContain("Last 30 days");
    expect(owner).toContain("Last 90 days");
    expect(owner).toContain(">Custom<");
    expect(owner).toContain("Sample data");
    expect(owner).toContain("Mark no-show");
    expect(owner).toContain("sd-pill-grey");
    expect(owner).toContain("Appointments marked no-show in this range.");
    expect(owner).not.toContain("Appointments do not have a no-show field");
    expect(owner).toContain("window.printAppointmentReport");
    expect(owner).toContain("schedi-printing-report");
    expect(owner).toContain("<h1>Appointments Report</h1>");
    expect(owner).toContain("data-report-range");
    expect(extractFunction(owner, "renderTenantReport")).toContain("bookingPaymentState");
    expect(extractFunction(owner, "appointmentReportModel").indexOf("function appointmentReportModel")).toBe(0);
    expect(template).not.toContain("appointmentReportModel");
    expect(template).not.toContain("sd-report-stats");
    expect(owner).not.toMatch(/Reports[\s\S]{0,400}Pro only/);
    expect(unscopedSelectors(dashCss(html))).toEqual([]);
  });
});

describe("no-show booking field", () => {
  it("keeps a saved no-show flag and drops a field that is not on the allow list", () => {
    const kept = sanitizeBooking({ id: "HB-1008", noShow: true, clientName: "Sam", secret: "nope" }, "harbor-demo");
    expect(kept).toMatchObject({ id: "HB-1008", noShow: true, clientName: "Sam" });
    expect(kept).not.toHaveProperty("secret");
    const cleared = sanitizeBooking({ id: "HB-1008", noShow: false }, "harbor-demo");
    expect(cleared && cleared.noShow).toBe(false);
    const absent = sanitizeBooking({ id: "HB-1009", clientName: "Casey" }, "harbor-demo");
    expect(absent).not.toHaveProperty("noShow");
    const square = sanitizeBooking({
      id: "HB-1012",
      paidMethod: "square",
      paymentMethod: "Square",
      paymentOptionLabel: "Square",
    }, "harbor-demo");
    expect(square).toMatchObject({ paidMethod: "square", paymentMethod: "square", paymentOptionLabel: "Square" });
    expect(recordedPayMethod("cash app")).toBe("cashapp");
    expect(recordedPayMethod("not-a-rail")).toBe("");
    const dropped = sanitizeBooking({ id: "HB-1099", paidMethod: "not-a-rail", paymentMethod: "bitcoin" }, "harbor-demo");
    expect(dropped).not.toHaveProperty("paidMethod");
    expect(dropped).not.toHaveProperty("paymentMethod");
    const clearedPay = sanitizeBooking({
      id: "HB-1013",
      paidMethod: "",
      paymentMethod: null,
      paymentOptionLabel: "Was card",
    }, "harbor-demo");
    expect(clearedPay).not.toHaveProperty("paidMethod");
    expect(clearedPay).not.toHaveProperty("paymentMethod");
    expect(clearedPay).toMatchObject({ paymentOptionLabel: "Was card" });
  });
});
