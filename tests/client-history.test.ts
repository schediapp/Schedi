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

const names = [
  "clientNormEmail",
  "clientPhoneKey",
  "clientHistoryIso",
  "clientBookingMatches",
  "clientHistoryMinutes",
  "clientHistorySortKey",
  "clientHistoryStatus",
  "clientHistoryPrice",
  "clientPayWord",
  "clientHistoryModel",
  "reportIsCancelled",
  "reportIsDenied",
  "reportAmount",
  "reportMoney",
  "appointmentIsNoShow",
  "appointmentReportNoShow",
];

const lib = names.map((name) => extractFunction(html, name)).join("\n");
const api = new Function(`${lib}; return { clientNormEmail, clientBookingMatches, clientHistoryModel, clientHistoryStatus, clientHistoryPrice, clientPayWord };`)() as {
  clientNormEmail: (value: unknown) => string;
  clientBookingMatches: (client: { email?: string; phone?: string; name?: string } | null, app: Record<string, unknown> | null) => boolean;
  clientHistoryStatus: (app: Record<string, unknown>) => string;
  clientHistoryPrice: (app: Record<string, unknown>) => string;
  clientPayWord: (kind: string) => string;
  clientHistoryModel: (
    client: { email?: string; phone?: string; name?: string },
    appointments: Record<string, unknown>[],
    today: string,
    paymentState: (app: Record<string, unknown>) => string,
    payKind: (app: Record<string, unknown>) => string,
  ) => {
    upcoming: { id?: string; date?: string }[];
    past: { id?: string; date?: string }[];
    paidRevenue: number;
    unpaidRevenue: number;
    revenue: number;
    usualMethod: string;
    usualLabel: string;
    visitCount: number;
    firstVisit: string;
    lastVisit: string;
    noShow: { available: boolean; count: number; label: string };
  };
};

const payState = (app: Record<string, unknown>) => String(app.pay || "unpaid");
const payKind = (app: Record<string, unknown>) => String(app.kind || "unpaid");
const maya = { name: "Maya Chen", email: "maya@example.com", phone: "(555) 201-0142" };

describe("client history matching", () => {
  it("matches a normalized email or a normalized phone, and not a name alone", () => {
    expect(api.clientNormEmail("  Maya@Example.com ")).toBe("maya@example.com");
    expect(api.clientBookingMatches(maya, { clientEmail: "Maya@Example.com", clientPhone: "(555) 999-0000" })).toBe(true);
    expect(api.clientBookingMatches(maya, { clientEmail: "other@example.com", clientPhone: "+1 (555) 201-0142" })).toBe(true);
    expect(api.clientBookingMatches(maya, { email: "maya@example.com" })).toBe(true);
    expect(api.clientBookingMatches(maya, { phone: "5552010142" })).toBe(true);
    expect(api.clientBookingMatches(maya, { clientName: "Maya Chen", clientEmail: "nope@example.com", clientPhone: "555" })).toBe(false);
    expect(api.clientBookingMatches({ name: "Maya Chen", email: "", phone: "" }, { clientName: "Maya Chen", clientEmail: "", clientPhone: "" })).toBe(false);
    expect(api.clientBookingMatches({ email: "", phone: "" }, { clientEmail: "", clientPhone: "" })).toBe(false);
    expect(api.clientBookingMatches(maya, { clientPhone: "555" })).toBe(false);
    expect(api.clientBookingMatches(null, { clientEmail: "maya@example.com" })).toBe(false);
  });

  it("lists upcoming visits before past ones and splits paid and unpaid revenue", () => {
    const rows = [
      { id: "past-cash", date: "2026-09-20", time: "02:00 PM", status: "accepted", clientEmail: "maya@example.com", amount: 80, pay: "paid", kind: "cash" },
      { id: "today", date: "2026-10-16", time: "09:00 AM", status: "accepted", clientEmail: "maya@example.com", amount: 65, pay: "paid", kind: "card" },
      { id: "soon", date: "2026-10-16", time: "04:00 PM", status: "pending", clientEmail: "maya@example.com", amount: 28, pay: "unpaid", kind: "unpaid" },
      { id: "future", date: "2026-10-28", time: "11:00 AM", status: "accepted", clientEmail: "maya@example.com", amount: 120, pay: "unpaid", kind: "unpaid" },
      { id: "cancelled", date: "2026-09-01", time: "09:30 AM", status: "cancelled", clientEmail: "maya@example.com", amount: 65, pay: "paid", kind: "card" },
      { id: "denied", date: "2026-09-05", time: "11:00 AM", status: "denied", clientEmail: "maya@example.com", amount: 40, pay: "unpaid", kind: "unpaid" },
      { id: "other", date: "2026-10-16", clientEmail: "someone@example.com", clientPhone: "5550000000", amount: 500, pay: "paid", kind: "card" },
      { id: "blank-price", date: "2026-10-02", time: "10:00 AM", status: "accepted", clientEmail: "maya@example.com", pay: "paid", kind: "card" },
      { id: "phone-only", date: "2026-08-01", time: "01:00 PM", status: "accepted", clientEmail: "desk@example.com", clientPhone: "555.201.0142", amount: 28, pay: "paid", kind: "cashapp" },
    ];
    const model = api.clientHistoryModel(maya, rows, "2026-10-16", payState, payKind);
    expect(model.upcoming.map((row) => row.id)).toEqual(["today", "soon", "future"]);
    expect(model.past.map((row) => row.id)).toEqual(["blank-price", "past-cash", "denied", "cancelled", "phone-only"]);
    expect(model.paidRevenue).toBe(65 + 80 + 28);
    expect(model.unpaidRevenue).toBe(28 + 120);
    expect(model.revenue).toBe(model.paidRevenue + model.unpaidRevenue);
    expect(model.visitCount).toBe(6);
    expect(model.firstVisit).toBe("2026-08-01");
    expect(model.lastVisit).toBe("2026-10-28");
    expect(model.usualMethod).toBe("card");
    expect(model.usualLabel).toBe("Card (Stripe)");
    expect(model.noShow).toMatchObject({ available: true, count: 0, label: "0" });
    const missed = api.clientHistoryModel(maya, rows.concat([
      { id: "missed", date: "2026-09-12", time: "11:00 AM", status: "accepted", clientEmail: "maya@example.com", amount: 65, pay: "paid", kind: "card", noShow: true },
      { id: "flagged", date: "2026-09-02", time: "11:00 AM", status: "no_show", clientEmail: "maya@example.com", amount: 40, pay: "unpaid", kind: "unpaid" },
    ]), "2026-10-16", payState, payKind);
    expect(missed.noShow).toMatchObject({ available: true, count: 2, label: "2" });
    expect(api.clientHistoryPrice({ amount: null })).toBe("");
    expect(api.clientHistoryPrice({ amount: 28 })).toBe("$28.00");
    expect(api.clientHistoryStatus({ status: "accepted" })).toBe("Confirmed");
    expect(api.clientHistoryStatus({ status: "cancelled" })).toBe("Cancelled");
    expect(api.clientHistoryStatus({ status: "denied" })).toBe("Denied");
    expect(api.clientHistoryStatus({ status: "accepted", noShow: true })).toBe("No-show");
    expect(api.clientHistoryStatus({ status: "no_show" })).toBe("No-show");
  });

  it("picks the most common paid method and breaks ties by the latest visit", () => {
    const rows = [
      { id: "a", date: "2026-10-01", time: "09:00 AM", status: "accepted", clientEmail: "maya@example.com", amount: 10, pay: "paid", kind: "venmo" },
      { id: "b", date: "2026-10-02", time: "09:00 AM", status: "accepted", clientEmail: "maya@example.com", amount: 10, pay: "paid", kind: "cash" },
      { id: "c", date: "2026-10-03", time: "09:00 AM", status: "accepted", clientEmail: "maya@example.com", amount: 10, pay: "paid", kind: "cash" },
      { id: "d", date: "2026-10-04", time: "09:00 AM", status: "accepted", clientEmail: "maya@example.com", amount: 10, pay: "unpaid", kind: "card" },
    ];
    expect(api.clientHistoryModel(maya, rows, "2026-10-16", payState, payKind).usualMethod).toBe("cash");
    const tied = [
      { id: "card", date: "2026-09-01", time: "09:00 AM", status: "accepted", clientEmail: "maya@example.com", amount: 10, pay: "paid", kind: "card" },
      { id: "zelle", date: "2026-10-01", time: "09:00 AM", status: "accepted", clientEmail: "maya@example.com", amount: 10, pay: "paid", kind: "zelle" },
    ];
    const tie = api.clientHistoryModel(maya, tied, "2026-10-16", payState, payKind);
    expect(tie.usualMethod).toBe("zelle");
    expect(tie.usualLabel).toBe("Zelle");
    const sameDay = [
      { id: "cash", date: "2026-10-01", time: "04:00 PM", status: "accepted", clientEmail: "maya@example.com", amount: 10, pay: "paid", kind: "cash" },
      { id: "card", date: "2026-10-01", time: "09:00 AM", status: "accepted", clientEmail: "maya@example.com", amount: 10, pay: "paid", kind: "card" },
    ];
    expect(api.clientHistoryModel(maya, sameDay, "2026-10-16", payState, payKind).usualMethod).toBe("cash");
    const none = api.clientHistoryModel(maya, [{ id: "u", date: "2026-10-01", status: "accepted", clientEmail: "maya@example.com", amount: 10, pay: "unpaid", kind: "unpaid" }], "2026-10-16", payState, payKind);
    expect(none.usualMethod).toBe("");
    expect(none.usualLabel).toBe("");
    expect(api.clientPayWord("cashapp")).toBe("Cash App");
    expect(api.clientPayWord("square")).toBe("Square");
  });

  it("keeps the panel, Book again, and recurring action in the owner script", () => {
    const owner = html.slice(0, html.indexOf(BOOKING_TEMPLATE_SHA_MARKER));
    expect(owner).toContain('id="sdClientPanel"');
    expect(owner).toContain("Visit history");
    expect(owner).toContain("Usually pays ");
    expect(owner).toContain("Book again");
    expect(owner).toContain("New recurring appointment");
    expect(owner).toContain("window.bookClientAgain = function");
    expect(owner).toContain("Book appointment");
    expect(owner).toContain("View history");
    expect(owner).toContain('id="clientHistoryModal"');
    expect(owner).toContain("window.openClientHistory = function");
    expect(owner).toContain("clientHistorySheetPrice");
    expect(owner).toContain("openManualBookingModal({ clientName:");
    expect(owner).toContain("No usual method yet.");
    expect(owner).toContain("No-shows: ");
    expect(owner).toContain("sd-pill-grey");
    expect(owner).toContain("markAppointmentNoShow");
    expect(owner).toContain("undoAppointmentNoShow");
    expect(owner).not.toContain("Appointments do not have a no-show field");
    const modal = owner.slice(owner.indexOf("window.openManualBookingModal = function"), owner.indexOf("window.openEditAppointment"));
    expect(modal).toContain("clientName ? 'Add appointment'");
    expect(modal).toContain("setManualWalkIn(false, false)");
  });
});
