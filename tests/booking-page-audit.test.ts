import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function contrast(fg: string, bg: string): number {
  const lum = (hex: string) => {
    const n = hex.replace("#", "");
    const chan = [0, 2, 4].map((i) => {
      const c = parseInt(n.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
  };
  const lighter = Math.max(lum(fg), lum(bg));
  const darker = Math.min(lum(fg), lum(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

function contrastBlock(): string {
  const start = html.indexOf("/* booking-day-contrast */");
  const end = html.indexOf("/* /booking-day-contrast */");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("booking calendar contrast", () => {
  it("gives every day state AA text in light and dark mode", () => {
    const css = contrastBlock();
    const states: Array<[string, string, string, string]> = [
      [".cal-day-open {", "#1e293b", "#f8fafc", "#6ee7b7"],
      [".cal-day-special {", "#0c4a6e", "#f0f9ff", "#bae6fd"],
      [".cal-day-away {", "#78350f", "#fffbeb", "#fde68a"],
      [".cal-day-selected {", "#047857", "#ffffff", "#ecfdf5"],
      [".cal-day-disabled {", "#0f172a", "#cbd5e1", "#94a3b8"],
      ["html.schedi-light .cal-day-open {", "#ffffff", "#0f172a", "#047857"],
      ["html.schedi-light .cal-day-special {", "#e0f2fe", "#0c4a6e", "#075985"],
      ["html.schedi-light .cal-day-away {", "#fffbeb", "#78350f", "#92400e"],
      ["html.schedi-light .cal-day-selected {", "#047857", "#ffffff", "#ecfdf5"],
      ["html.schedi-light .cal-day-disabled {", "#e2e8f0", "#1e293b", "#334155"],
    ];
    for (const [marker, bg, num, label] of states) {
      const at = css.indexOf(marker);
      expect(at, marker).toBeGreaterThanOrEqual(0);
      const rule = css.slice(at, at + 420);
      expect(rule).toContain("background: " + bg);
      expect(rule).toContain("color: " + num);
      expect(css).toContain("color: " + label);
      expect(contrast(num, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(label, bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(css).toContain(".cal-day-today");
    expect(html).toContain('class="cal-day cal-day-');
    expect(html).not.toContain("bg-slate-900/90 border-slate-800 text-slate-200 hover:border-emerald-500/50");
  });

  it("shrinks calendar status labels to the day cell on narrow screens", () => {
    const at = html.indexOf("font-size: 20cqw");
    expect(at).toBeGreaterThan(0);
    expect(html.indexOf("font-size: 20cqw", at + 1)).toBe(-1);
    expect(html).not.toContain("font-size: 22cqw");
    const rule = html.slice(at - 450, at + 420);
    expect(rule).toContain("@media (max-width: 639px)");
    expect(rule).toContain("container-type: inline-size");
    expect(rule).toContain("text-transform: none");
    expect(rule).toContain("white-space: normal");
    expect(rule).toContain("overflow-wrap: normal");
    expect(rule).toContain("word-break: keep-all");
    expect(rule).toContain("-webkit-line-clamp: 2");
    expect(rule).toContain("html.schedi-newbook .cal-day-away .cal-day-label");
    expect(html).toContain("(SCHEDI_NEWBOOK && !phoneCal) ? awayShort : 'Away'");
  });

  it("keeps the month title light on the dark calendar bar", () => {
    expect(html).toContain("html.schedi-light #monthTitleLabel { color: #f8fafc !important; }");
    // The bar is slate-900 (#0f172a) at 90% over a white card, about #272e3f.
    expect(contrast("#f8fafc", "#0f172a")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#f8fafc", "#272e3f")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("booking page audit copy", () => {
  it("shows the business time zone and a browser mismatch note", () => {
    expect(html).toContain("Times shown in ");
    expect(html).toContain("Your browser is in ");
    expect(html).toContain("longGeneric");
    expect(html).toContain("shortGeneric");
    expect(html).toContain('id="tzNote"');
    expect(html).toContain('id="resTzNote"');
  });

  it("adds minimum notice choices and hides slots inside the window", () => {
    expect(html).toContain('id="tenantMinNotice"');
    for (const value of ["0", "1", "2", "4", "12", "24", "48"]) {
      expect(html).toContain('value="' + value + '"');
    }
    expect(html).toContain("New businesses are saved at 2 hours.");
    expect(html).toContain("A business with no saved setting keeps none.");
    expect(html).toContain("if (raw == null || raw === '') return 0;");
    expect(html).toContain("minNoticeHours: 2");
    expect(html).toContain("function slotInsideNotice");
    expect(html).toContain("function getMinNoticeHoursPub");
    expect(html).toContain("if (slotInsideNotice(selectedDateStr, t))");
    expect(html).toContain("error === 'too_soon'");
  });

  it("queues the client confirmation email only after create succeeds", () => {
    const start = html.indexOf("function syncBookingsToFirestore");
    expect(start).toBeGreaterThan(0);
    const before = html.slice(Math.max(0, start - 500), start);
    expect(before).not.toContain("queueStandaloneConfirmationEmail");
    const end = html.indexOf("document.getElementById('resCode')", start);
    expect(end).toBeGreaterThan(start);
    const fn = html.slice(start, end);
    const fetchAt = fn.indexOf("fetch('https://schedi.app/api/bookings'");
    const createdAt = fn.indexOf("var created = !!(out && out.ok && out.data && out.data.ok)");
    const queueAt = fn.indexOf("queueStandaloneConfirmationEmail");
    expect(fetchAt).toBeGreaterThan(0);
    expect(createdAt).toBeGreaterThan(fetchAt);
    expect(queueAt).toBeGreaterThan(createdAt);
    expect(fn).toContain("if (created)");
    expect(fn).toContain("emailHandled: created ? emailQueued : true");
    expect(fn.indexOf("queueStandaloneConfirmationEmail")).toBe(fn.lastIndexOf("queueStandaloneConfirmationEmail"));
  });

  it("leads the booking page with logo, cover, name, map address, and hours", () => {
    expect(html).toContain('id="bizHeader"');
    expect(html).toContain('id="bizCover"');
    expect(html).toContain('id="bizLogo"');
    expect(html).toContain('id="bizTitle"');
    expect(html).toContain('id="bizAddress"');
    expect(html).toContain('id="bizHours"');
    expect(html).toContain("maps/search/?api=1&query=");
    expect(html).toContain('id="tenantAddress"');
    expect(html).toContain('id="tenantLogoUrl"');
    expect(html).toContain('id="tenantCoverUrl"');
    const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
    expect(hq).toContain('id="editTenantAddress"');
    expect(html).not.toContain('id="editTenantAddress"');
    expect(html).toContain("function paintBizHeader");
    expect(html).toContain("onclick=\"selectPay('card')\"");
    expect(html).toContain("window.toggleSchediTheme");
  });
});
