import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function extractFunction(source: string, name: string): string {
  const start = source.indexOf("function " + name);
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

const search = new Function(
  `${extractFunction(html, "bookingPaymentState")}\n${extractFunction(html, "inferPaidMethodFromBooking")}\n${extractFunction(html, "appointmentPayKind")}\n${extractFunction(html, "rosterSearchAppointments")}; return rosterSearchAppointments;`,
)() as (apps: Record<string, unknown>[], query: string) => { id: string }[];

const visits = [
  { id: "HB-1003", clientName: "Jordan Lee", clientPhone: "(555) 201-7730", clientEmail: "jordan@example.com", serviceName: "Beard trim", date: "2026-10-20", time: "02:00 PM", paymentStatus: "PAID", paidMethod: "zelle" },
  { id: "BK-12", clientName: "Maya Chen", clientPhone: "(555) 201-0142", clientEmail: "maya@example.com", serviceName: "Cut & style", date: "2026-10-19", time: "09:00 AM", paymentStatus: "PAID", paidMethod: "cashapp" },
  { id: "HB-1002", clientName: "Luis Ortega", clientPhone: "(555) 201-2288", clientEmail: "luis@example.com", serviceName: "Beard trim", date: "2026-10-20", time: "11:30 AM", paymentStatus: "PAY AT APPOINTMENT" },
  { id: "HB-1044", clientName: "Priya Shah", clientPhone: "(555) 010-4400", clientEmail: "priya@example.com", serviceName: "Color", date: "2026-10-26", time: "04:00 PM", paymentStatus: "PAID", paidMethod: "square" },
  { id: "HB-1050", clientName: "Ava Brooks", clientPhone: "(555) 010-1188", clientEmail: "ava@example.com", serviceName: "Consultation", date: "2026-10-21", time: "01:00 PM", paymentStatus: "PAID IN CASH", paidMethod: "cash" },
  { id: "HB-1060", clientName: "Priya Shah", clientPhone: "(555) 201-9094", clientEmail: "priya@example.com", serviceName: "Consultation", date: "2026-10-20", time: "04:00 PM", paymentStatus: "PENDING ZELLE", paymentMethod: "zelle" },
];

function ids(query: string) {
  return search(visits, query).map((row) => row.id);
}

describe("roster appointment search", () => {
  it("matches reference ids with or without the prefix", () => {
    expect(ids("HB-1003")).toEqual(["HB-1003"]);
    expect(ids("hb-1003")).toEqual(["HB-1003"]);
    expect(ids("1003")).toEqual(["HB-1003"]);
    expect(ids("BK-12")).toEqual(["BK-12"]);
    expect(ids("bk12")).toEqual(["BK-12"]);
  });

  it("matches client, phone, email, and service", () => {
    expect(ids("jordan")).toEqual(["HB-1003"]);
    expect(ids("maya@example.com")).toEqual(["BK-12"]);
    expect(ids("(555) 201-2288")).toEqual(["HB-1002"]);
    expect(ids("5552010142")).toEqual(["BK-12"]);
    expect(ids("beard")).toEqual(["HB-1002", "HB-1003"]);
  });

  it("matches typed dates and weekdays across the whole book", () => {
    expect(ids("2026-10-20")).toEqual(["HB-1002", "HB-1003", "HB-1060"]);
    expect(ids("10/20")).toEqual(["HB-1002", "HB-1003", "HB-1060"]);
    expect(ids("Oct 20")).toEqual(["HB-1002", "HB-1003", "HB-1060"]);
    expect(ids("October 20, 2026")).toEqual(["HB-1002", "HB-1003", "HB-1060"]);
    expect(ids("Monday")).toEqual(["BK-12", "HB-1044"]);
    expect(ids("")).toEqual([]);
  });

  it("matches payment methods and shows an empty result for misses", () => {
    expect(ids("Zelle")).toEqual(["HB-1003", "HB-1060"]);
    expect(ids("cash app")).toEqual(["BK-12"]);
    expect(ids("square")).toEqual(["HB-1044"]);
    expect(ids("in person")).toEqual(["HB-1050"]);
    expect(ids("pay at appt")).toEqual(["HB-1002"]);
    expect(ids("pay at appointment")).toEqual(["HB-1002"]);
    expect(ids("unpaid")).toEqual(["HB-1002", "HB-1060"]);
    expect(ids("paypal")).toEqual([]);
  });
});
