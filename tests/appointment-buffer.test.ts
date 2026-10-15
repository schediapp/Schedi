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

describe("break after appointments", () => {
  it("defaults a missing break to none and keeps a saved break", () => {
    expect(appointmentBufferMins({})).toBe(0);
    expect(appointmentBufferMins({ appointmentBufferMins: null })).toBe(0);
    expect(appointmentBufferMins({ appointmentBufferMins: undefined })).toBe(0);
    expect(appointmentBufferMins({ appointmentBufferMins: "" })).toBe(0);
    expect(appointmentBufferMins({ appointmentBufferMins: 7 })).toBe(0);
    expect(appointmentBufferMins({ appointmentBufferMins: "nope" })).toBe(0);
    expect(appointmentBufferMins({ appointmentBufferMins: 0 })).toBe(0);
    expect(appointmentBufferMins({ appointmentBufferMins: "0" })).toBe(0);
    expect(appointmentBufferMins({ appointmentBufferMins: 15 })).toBe(15);
    expect(appointmentBufferMins({ appointmentBufferMins: "20" })).toBe(20);
    expect(appointmentBufferMins({ appointmentBufferMins: 20 })).toBe(20);
    expect(appointmentBufferMins({ appointmentBufferMins: "30" })).toBe(30);
    expect(appointmentBufferMins({ appointmentBufferMins: 60 })).toBe(60);

    const owner = new Function(
      `${extractFunction(html, "getAppointmentBufferMins")}; var APPOINTMENT_BUFFER_MINS = 0; var APPOINTMENT_BUFFER_CHOICES = [0, 5, 10, 15, 20, 30, 45, 60]; return getAppointmentBufferMins;`,
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
      `${extractFunction(html, "slotsNeedBuffer")}; var APPOINTMENT_BUFFER_MINS = 0; return slotsNeedBuffer;`,
    )() as (start: number, end: number, otherStart: number, otherEnd: number, gap?: number) => boolean;
    expect(slotsNeedBuffer(60, 90, 0, 50, 15)).toBe(true);
    expect(slotsNeedBuffer(60, 90, 0, 50, 20)).toBe(true);
    expect(slotsNeedBuffer(70, 100, 0, 50, 20)).toBe(false);
    expect(slotsNeedBuffer(60, 90, 0, 50, 0)).toBe(false);
    expect(slotsNeedBuffer(40, 70, 0, 50, 0)).toBe(true);
    expect(html).toContain('id="tenantBreakAfter"');
    expect(html).toContain('<option value="20">20 minutes</option>');
    expect(html).toContain(">None</option>");
    expect(html).toContain("None is the default");
    expect(html).not.toContain("Schedi keeps 15 minutes");
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
