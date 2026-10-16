import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
  "appointmentReportNoShow",
  "appointmentReportRange",
  "appointmentReportSampleVisits",
  "appointmentReportModel",
  "appointmentReportCsv",
  "appointmentReportChartSvg",
  "appointmentReportAvgLabel",
  "bookingPaymentState",
];

const lib = names.map((name) => extractFunction(html, name)).join("\n");
const api = new Function(`${lib}; return { reportTodayIso, reportShiftIso, appointmentReportRange, appointmentReportSampleVisits, appointmentReportModel, appointmentReportCsv, appointmentReportChartSvg, appointmentReportNoShow, bookingPaymentState };`)() as {
  reportTodayIso: (tz: string, now: Date) => string;
  reportShiftIso: (iso: string, days: number) => string;
  appointmentReportRange: (preset: string, today: string, from?: string, to?: string) => { from: string; to: string; label: string; clamped?: boolean };
  appointmentReportSampleVisits: (from: string, to: string) => { total: number; days: number; sample: boolean };
  appointmentReportModel: (rows: unknown[], range: { from: string; to: string }, pay: (row: unknown) => string) => {
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
    noShow: { available: boolean; reason: string };
    rows: unknown[];
  };
  appointmentReportCsv: (model: { rows: unknown[] }, pay: (row: unknown) => string) => string;
  appointmentReportChartSvg: (weeks: { start: string; bookings: number; revenue: number }[], field: string, format: (n: number) => string, label: string) => string;
  appointmentReportNoShow: () => { available: boolean; label: string; reason: string };
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
    expect(model.noShow.available).toBe(false);
    expect(model.noShow.reason).toMatch(/do not have a no-show field/);
  });

  it("exports only the range and includes the computed fields", () => {
    const rows = [
      { id: "in", clientName: 'Ada "A"', date: "2026-10-13", time: "9:00 AM", status: "accepted", paymentStatus: "PAID", amount: 20, serviceName: "Cut" },
      { id: "out", date: "2026-10-01", status: "accepted", amount: 80, paymentStatus: "PAID" },
      { id: "late", date: "2026-10-12", status: "cancelled", amount: 40, paymentStatus: "PENDING" },
    ];
    const model = api.appointmentReportModel(rows, range, pay);
    const csv = api.appointmentReportCsv(model, pay);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("payment_state");
    expect(lines[0]).toContain("counts_toward_revenue");
    expect(lines[0]).toContain("confirmed");
    expect(lines[0]).toContain("no_show");
    expect(lines).toHaveLength(3);
    expect(csv).toContain('"Ada ""A"""');
    expect(csv).toContain("paid,20,yes,yes,no,no,not recorded");
    expect(csv).not.toContain("out");
    expect(csv).toContain("not recorded");
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
    expect(api.appointmentReportNoShow().available).toBe(false);
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
    expect(owner).toContain("Appointments do not have a no-show field");
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
