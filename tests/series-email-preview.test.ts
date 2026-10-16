import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("series email preview", () => {
  it("keeps Allow recurring appointments in Emails and adds a local preview", () => {
    const start = html.indexOf('id="tenantSectionNotifications"');
    const end = html.indexOf('id="tenantSectionClients"');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const section = html.slice(start, end);
    expect(section).toContain("Allow recurring appointments");
    expect(section).toContain('id="tenantAllowRecurringCheck"');
    expect(section).toContain('id="sdSeriesPreviewOpen"');
    expect(section).toContain("Preview email");
    expect(section.indexOf("Allow recurring appointments")).toBeLessThan(section.indexOf('id="sdSeriesPreviewOpen"'));
    expect(section).toContain('role="dialog"');
    expect(section).toContain("Nothing is sent.");

    const fn = html.indexOf("function schediSeriesEmailSample");
    const fnEnd = html.indexOf("var seriesPreviewReturn", fn);
    const template = html.indexOf("return `<!DOCTYPE html>");
    expect(fn).toBeGreaterThan(0);
    expect(fnEnd).toBeGreaterThan(fn);
    expect(template).toBeGreaterThan(fnEnd);
    const body = html.slice(fn, fnEnd);
    expect(body).toContain("Your visits are booked");
    expect(body).toContain("Manage / reschedule / cancel");
    expect(body).toContain("', and ' + hidden + ' more'");
    expect(body).not.toContain("Pro only");
    expect(body).not.toContain("schedi-qa@agentmail.to");
    const opener = html.indexOf("window.openSeriesEmailPreview");
    expect(opener).toBeGreaterThan(fnEnd);
    expect(opener).toBeLessThan(template);
    expect(html.slice(opener, opener + 900)).toContain("frame.srcdoc = schediSeriesEmailSample");
    const templateBody = html.slice(template);
    expect(templateBody).not.toContain("sdSeriesPreviewOpen");
    expect(templateBody).not.toContain("schediSeriesEmailSample");
  });
});
