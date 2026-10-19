import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/google/chrome/chrome"].find((path) => existsSync(path));

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");

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

function seriesCss(source: string): string {
  const start = source.indexOf("/* series-date-contrast */");
  const end = source.indexOf("/* /series-date-contrast */");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function rule(css: string, selector: string): string {
  const at = css.indexOf(selector);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const close = css.indexOf("}", at);
  return css.slice(at, close);
}

describe("series date list contrast", () => {
  it("gives Remove, the date, and the time AA text in light mode on both booking designs", () => {
    // Before this fix, light mode remapped .text-slate-300 to #334155 and .text-white
    // to #0f172a, while the row kept bg-slate-900/80. Over a white card that fill is
    // #3f4555. Remove was 1.08:1 and the date was 1.86:1. The time field already sat
    // on its own white control at 17.85:1. Dark mode was already above 4.5:1
    // (#cbd5e1 on the #0f1728 row is 12.05:1) and stays that way.
    for (const source of [html, hq]) {
      const css = seriesCss(source);
      const darkRemove = rule(css, "#customDatesList .series-date-remove,");
      expect(darkRemove).toContain("color: #cbd5e1");
      expect(darkRemove).toContain("background: transparent");
      expect(darkRemove).toContain("border: 1px solid #334155");
      expect(contrast("#cbd5e1", "#0f1728")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#ffffff", "#0f1728")).toBeGreaterThanOrEqual(4.5);

      for (const prefix of ["html.schedi-light", "html.schedi-light.schedi-newbook"]) {
        const row = rule(css, prefix + " #customDatesList .series-date-row");
        expect(row).toContain("background: #f8fafc");
        expect(row).not.toContain("is-unavailable");
        const remove = rule(css, prefix + " #customDatesList .series-date-remove");
        expect(remove).toContain("color: #334155");
        expect(remove).toContain("background: #ffffff");
        expect(remove).toContain("border-color: #334155");
        expect(contrast("#334155", "#ffffff")).toBeGreaterThanOrEqual(4.5);
        expect(contrast("#334155", "#ffffff")).toBeGreaterThanOrEqual(3);

        const hover = rule(css, prefix + " #customDatesList .series-date-remove:hover");
        expect(hover).toContain("color: #0f172a");
        expect(hover).toContain("background: #e2e8f0");
        expect(hover).toContain("border-color: #0f172a");
        expect(contrast("#0f172a", "#e2e8f0")).toBeGreaterThanOrEqual(4.5);

        const label = rule(css, prefix + " #customDatesList .series-date-label");
        expect(label).toContain("color: #0f172a");
        expect(contrast("#0f172a", "#f8fafc")).toBeGreaterThanOrEqual(4.5);

        const time = rule(css, prefix + " #customDatesList .series-date-time");
        expect(time).toContain("color: #0f172a");
        expect(time).toContain("background: #ffffff");
        expect(time).toContain("border-color: #475569");
        expect(contrast("#0f172a", "#ffffff")).toBeGreaterThanOrEqual(4.5);

        const warn = rule(css, prefix + " #customDatesList .series-date-warn");
        expect(warn).toContain("color: #be123c");
        expect(contrast("#be123c", "#fff1f2")).toBeGreaterThanOrEqual(4.5);
      }

      const rowFn = extractFunction(source, "seriesDateRowHtml");
      expect(rowFn).toContain("series-date-row");
      expect(rowFn).toContain("series-date-label");
      expect(rowFn).toContain("series-date-time");
      expect(rowFn).toContain("series-date-warn");
      expect(rowFn).toContain("Not available at ");
      expect(rowFn).toContain(">Use this time</button>");
      expect(rowFn).toContain('class="series-date-remove ml-auto px-2 py-1 rounded-lg"');
      expect(rowFn).toContain(">Remove</button>");
      expect(rowFn).not.toContain("text-slate-300 hover:text-white");
    }
  });
});

describe.skipIf(!chrome)("series date list computed contrast", () => {
  it("paints a readable Remove control in light mode for the current design and newbook", async () => {
    const css = seriesCss(html);
    const pageCss = `
      ${css}
      html.schedi-light .text-white { color: #0f172a !important; }
      html.schedi-light .text-slate-300 { color: #334155 !important; }
      html.schedi-light .border-slate-700 { border-color: #cbd5e1 !important; }
      .bg-slate-900\\/80 { background-color: rgb(15 23 42 / 0.8); }
      .text-white { color: #ffffff; }
      .text-slate-300 { color: #cbd5e1; }
      .border-slate-700 { border-color: #334155; }
    `;
    const body = `
      <ul id="customDatesList">
        <li class="series-date-row bg-slate-900/80">
          <span class="series-date-label text-white">Thu, Oct 22</span>
          <select class="series-date-time"><option>9:00 AM</option></select>
          <button type="button" class="series-date-remove">Remove</button>
        </li>
      </ul>
    `;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      for (const klass of ["schedi-light", "schedi-light schedi-newbook"]) {
        await page.setContent(`<!DOCTYPE html><html class="${klass}"><head><style>${pageCss}</style></head><body style="background:#ffffff">${body}</body></html>`);
        const colors = await page.evaluate(() => {
          const pick = (sel: string) => {
            const el = document.querySelector(sel) as HTMLElement;
            const cs = getComputedStyle(el);
            return { color: cs.color, background: cs.backgroundColor, border: cs.borderTopColor };
          };
          return {
            remove: pick(".series-date-remove"),
            label: pick(".series-date-label"),
            time: pick(".series-date-time"),
            row: pick(".series-date-row"),
          };
        });
        expect(colors.remove.color, klass).toBe("rgb(51, 65, 85)");
        expect(colors.remove.background, klass).toBe("rgb(255, 255, 255)");
        expect(colors.remove.border, klass).toBe("rgb(51, 65, 85)");
        expect(colors.label.color, klass).toBe("rgb(15, 23, 42)");
        expect(colors.row.background, klass).toBe("rgb(248, 250, 252)");
        expect(colors.time.color, klass).toBe("rgb(15, 23, 42)");
        expect(colors.time.background, klass).toBe("rgb(255, 255, 255)");
      }
    } finally {
      await browser.close();
    }
  });
});
