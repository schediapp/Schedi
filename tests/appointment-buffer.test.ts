import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appointmentBufferMins } from "../workers/schedi-email-worker/src/private-bookings.js";

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

function bookingTemplate(source: string): string {
  const marker = "return `<!DOCTYPE html>";
  const start = source.indexOf(marker);
  const openTick = start + "return ".length;
  const end = source.indexOf("</html>`", openTick);
  return source.slice(openTick, end + "</html>`".length);
}

describe("break after appointments", () => {
  it("defaults a missing break to 15 minutes and treats zero as no buffer", () => {
    expect(appointmentBufferMins({})).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: null })).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: undefined })).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: "" })).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: 7 })).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: "nope" })).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: 0 })).toBe(0);
    expect(appointmentBufferMins({ appointmentBufferMins: "0" })).toBe(0);
    expect(appointmentBufferMins({ appointmentBufferMins: 15 })).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: "30" })).toBe(30);
    expect(appointmentBufferMins({ appointmentBufferMins: 60 })).toBe(60);

    const owner = new Function(
      `${extractFunction(html, "getAppointmentBufferMins")}; var APPOINTMENT_BUFFER_MINS = 15; var APPOINTMENT_BUFFER_CHOICES = [0, 5, 10, 15, 30, 45, 60]; return getAppointmentBufferMins;`,
    )() as (tenant: { appointmentBufferMins?: unknown }) => number;
    const pub = new Function(
      `${extractFunction(bookingTemplate(html), "appointmentBufferMins")}; return appointmentBufferMins;`,
    )() as (tenant: { appointmentBufferMins?: unknown }) => number;
    for (const value of [undefined, null, "", 0, "0", 15, 30, 45, 7, "nope"]) {
      const tenant = { appointmentBufferMins: value };
      expect(owner(tenant)).toBe(appointmentBufferMins(tenant));
      expect(pub(tenant)).toBe(appointmentBufferMins(tenant));
    }
  });

  it("uses that break in slot checks, including zero", () => {
    const slotsNeedBuffer = new Function(
      `${extractFunction(html, "slotsNeedBuffer")}; var APPOINTMENT_BUFFER_MINS = 15; return slotsNeedBuffer;`,
    )() as (start: number, end: number, otherStart: number, otherEnd: number, gap?: number) => boolean;
    expect(slotsNeedBuffer(60, 90, 0, 50, 15)).toBe(true);
    expect(slotsNeedBuffer(60, 90, 0, 50, 0)).toBe(false);
    expect(slotsNeedBuffer(40, 70, 0, 50, 0)).toBe(true);
    expect(html).toContain('id="tenantBreakAfter"');
    expect(html).toContain(">None</option>");
    expect(html).toContain("tenant.appointmentBufferMins");
    expect(bookingTemplate(html)).toContain("appointmentBufferMins(tenantData)");
    expect(bookingTemplate(html)).not.toContain("tEnd + 15");
  });
});
