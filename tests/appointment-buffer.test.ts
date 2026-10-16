import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appointmentBufferMins } from "../workers/schedi-email-worker/src/private-bookings.js";
import { sanitizeProfile } from "../workers/schedi-email-worker/src/profile-store.js";

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

function extractAssignment(source: string, name: string): string {
  const match = source.match(new RegExp("var " + name + " = [^;]+;"));
  if (!match) throw new Error("missing " + name);
  return match[0];
}

describe("break after appointments", () => {
  it("defaults a missing break to 15 minutes and keeps a saved break, including none", () => {
    expect(appointmentBufferMins({})).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: null })).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: undefined })).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: "" })).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: 7 })).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: "nope" })).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: 0 })).toBe(0);
    expect(appointmentBufferMins({ appointmentBufferMins: "0" })).toBe(0);
    expect(appointmentBufferMins({ appointmentBufferMins: 15 })).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: "20" })).toBe(20);
    expect(appointmentBufferMins({ appointmentBufferMins: 20 })).toBe(20);
    expect(appointmentBufferMins({ appointmentBufferMins: "30" })).toBe(30);
    expect(appointmentBufferMins({ appointmentBufferMins: 60 })).toBe(60);

    const owner = new Function(
      `${extractAssignment(html, "APPOINTMENT_BUFFER_MINS")}; ${extractAssignment(html, "APPOINTMENT_BUFFER_CHOICES")}; ${extractFunction(html, "getAppointmentBufferMins")}; return getAppointmentBufferMins;`,
    )() as (tenant: { appointmentBufferMins?: unknown }) => number;
    const pub = new Function(
      `${extractFunction(bookingTemplate(html), "appointmentBufferMins")}; return appointmentBufferMins;`,
    )() as (tenant: { appointmentBufferMins?: unknown }) => number;
    for (const value of [undefined, null, "", 0, "0", 15, 20, "20", 30, 45, 7, "nope"]) {
      const tenant = { appointmentBufferMins: value };
      expect(owner(tenant)).toBe(appointmentBufferMins(tenant));
      expect(pub(tenant)).toBe(appointmentBufferMins(tenant));
    }
  });

  it("uses that break in slot checks, including zero and 20 minutes", () => {
    const slotsNeedBuffer = new Function(
      `${extractAssignment(html, "APPOINTMENT_BUFFER_MINS")}; ${extractFunction(html, "slotsNeedBuffer")}; return slotsNeedBuffer;`,
    )() as (start: number, end: number, otherStart: number, otherEnd: number, gap?: number) => boolean;
    expect(slotsNeedBuffer(60, 90, 0, 50, 15)).toBe(true);
    expect(slotsNeedBuffer(60, 90, 0, 50, 20)).toBe(true);
    expect(slotsNeedBuffer(70, 100, 0, 50, 20)).toBe(false);
    expect(slotsNeedBuffer(60, 90, 0, 50, 0)).toBe(false);
    expect(slotsNeedBuffer(40, 70, 0, 50, 0)).toBe(true);
    expect(slotsNeedBuffer(60, 90, 0, 50)).toBe(true);
    expect(slotsNeedBuffer(65, 90, 0, 50)).toBe(false);
    expect(html).toContain('id="tenantBreakAfter"');
    expect(html).toContain('<option value="20">20 minutes</option>');
    expect(html).toContain('<option value="15" selected>15 minutes</option>');
    expect(html).toContain(">None</option>");
    expect(html).toContain("15 minutes is the default");
    expect(html).not.toContain("None is the default");
    expect(html).toContain("appointmentBufferMins: 15");
    expect(html).toContain("breakEl ? breakEl.value : 15");
    expect(html).toContain("tenant.appointmentBufferMins");
    expect(bookingTemplate(html)).toContain("appointmentBufferMins(tenantData)");
    expect(bookingTemplate(html)).not.toContain("tEnd + 15");
    expect(bookingTemplate(html)).not.toContain('id="tenantBreakAfter"');
  });

  it("keeps a saved break on the owner profile", () => {
    const profile = sanitizeProfile({
      name: "Harbor",
      appointmentBufferMins: 20,
      ownerPassword: "nope",
    }, "harbor");
    expect(profile && profile.appointmentBufferMins).toBe(20);
    expect(profile && profile.ownerPassword).toBeUndefined();
    const untouched = sanitizeProfile({ name: "Harbor" }, "harbor");
    expect(untouched && untouched.appointmentBufferMins).toBeUndefined();
  });
});
