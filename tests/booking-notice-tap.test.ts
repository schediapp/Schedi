import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/google/chrome/chrome"].find((path) => existsSync(path));

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

function rgbContrast(fg: string, bg: string): number {
  const parse = (input: string) => {
    const match = input.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) throw new Error("not a color: " + input);
    return "#" + [1, 2, 3].map((i) => Number(match[i]).toString(16).padStart(2, "0")).join("");
  };
  return contrast(parse(fg), parse(bg));
}

function noticeCss(source: string): string {
  const start = source.indexOf("/* booking-notices */");
  const end = source.indexOf("/* /booking-notices */");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("booking notice contrast and repeat taps", () => {
  it("paints the no-price note and the other light-mode notices at AA", () => {
    for (const source of [html, hq]) {
      const css = noticeCss(source);
      expect(css).toContain("#noPricePayNote");
      expect(css).toContain("background: #0e2134 !important");
      expect(css).toContain("color: #e0f2fe !important");
      expect(css).toContain("html.schedi-light #noPricePayNote");
      expect(css).toContain("background: #e0f2fe !important");
      expect(css).toContain("color: #0c4a6e !important");
      expect(contrast("#e0f2fe", "#0e2134")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#0c4a6e", "#e0f2fe")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#78350f", "#fffbeb")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#1e1b4b", "#eef2ff")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#047857", "#eef2ff")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#9f1239", "#fff1f2")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#0f172a", "#f8fafc")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#334155", "#f8fafc")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#475569", "#f8fafc")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#047857", "#f8fafc")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#be123c", "#f8fafc")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#f8fafc", "#272e3f")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#064e3b", "#ecfdf5")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#075985", "#e0f2fe")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#0c4a6e", "#e0f2fe")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#5b21b6", "#f5f3ff")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#1e40af", "#eff6ff")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#065f46", "#ecfdf5")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#312e81", "#eef2ff")).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#3730a3", "#f8fafc")).toBeGreaterThanOrEqual(4.5);
      expect(source).toContain('id="noPricePayNote" class="pub-note hidden p-3 rounded-xl text-xs" role="status"');
      expect(source).not.toContain('id="noPricePayNote" class="hidden p-3 rounded-xl bg-slate-900/80');
      expect(css).toContain("html.schedi-light #cancelFeeNoticeBox");
      expect(css).toContain("html.schedi-light #bookingErrMsg");
      expect(css).toContain("html.schedi-light #cardPaymentFieldsBox");
      expect(css).toContain("html.schedi-light #recurrencePreviewBox");
      expect(css).toContain("html.schedi-light #customMonthTitle { color: #f8fafc !important; }");
      expect(css).toContain("html.schedi-light .pub-banner-err");
      expect(source).toContain('class="pub-banner pub-banner-ok"');
      expect(source).toContain('class="pub-banner pub-banner-warn"');
      expect(source).toContain('class="pub-banner pub-banner-info"');
      expect(source).toContain('class="pub-banner pub-banner-err"');
    }
  });

  it("covers each repeat option with its own radio instead of a clipped sr-only control", () => {
    for (const source of [html, hq]) {
      const css = noticeCss(source);
      const groupAt = source.indexOf('id="recurrenceFreqGroup"');
      const group = source.slice(groupAt, source.indexOf("recurrenceCustomWrap", groupAt));
      expect(group).not.toContain("sr-only");
      expect(group.match(/class="recurrence-opt"/g) || []).toHaveLength(5);
      expect(group).toContain('value="once"');
      expect(group).toContain('value="weekly"');
      expect(group).toContain('value="biweekly"');
      expect(group).toContain('value="monthly"');
      expect(group).toContain('value="custom"');
      expect(css).toContain("position: absolute");
      expect(css).toContain("inset: 0");
      expect(css).toContain("opacity: 0");
      expect(css).toContain("z-index: 1");
      expect(css).toContain("width: 100%");
      expect(css).toContain("height: 100%");
      expect(css).not.toContain("clip: rect");
    }
  });
});

describe.skipIf(!chrome)("booking page phone taps and notice paint", () => {
  it("taps every repeat option at 390px and keeps the custom-date flow", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".json": "application/json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full) || file.includes("..")) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
      res.end(readFileSync(full));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const shell = await browser.newPage();
      await shell.goto(`http://127.0.0.1:${port}/?demo=1`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await shell.waitForFunction(() => typeof (window as unknown as { generateStandaloneHtmlForTenant?: unknown }).generateStandaloneHtmlForTenant === "function", { timeout: 20000 });
      const rendered = await shell.evaluate(() => {
        const tenant = (window as unknown as { schediBuildDemoTenant: () => { deposit: { enabled: boolean } } }).schediBuildDemoTenant();
        tenant.deposit.enabled = false;
        return (window as unknown as { generateStandaloneHtmlForTenant: (row: unknown) => string }).generateStandaloneHtmlForTenant(tenant);
      });
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      await page.setContent(rendered, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => {
        const span = document.querySelector("#recurrenceFreqGroup .recurrence-opt span") as HTMLElement | null;
        const card = document.getElementById("recurrenceCard");
        return !!span && !!card && !card.classList.contains("hidden") && parseFloat(getComputedStyle(span).paddingTop) > 0;
      }, { timeout: 20000 });

      await page.evaluate(() => document.documentElement.classList.add("schedi-light"));
      await page.click('button[onclick="selectSvc(4)"]');
      await page.waitForFunction(() => {
        const note = document.getElementById("noPricePayNote");
        const fee = document.getElementById("cancelFeeNoticeText");
        return !!note && !note.classList.contains("hidden") && !!fee && (fee.textContent || "").includes("cancellation fee");
      });

      const light = await page.evaluate(() => {
        const shown = ["bookingErrMsg", "cardPaymentFieldsBox", "depositNoticeBox", "payCodeBox", "resSeriesBox", "cashAppPayBox", "zellePayBox", "venmoPayBox", "paypalPayBox", "copyToastNotice", "resCheckoutError"];
        for (const id of shown) document.getElementById(id)?.classList.remove("hidden");
        const err = document.getElementById("bookingErrMsg");
        if (err) err.textContent = "Choose another time.";
        const checkout = document.getElementById("resCheckoutError");
        if (checkout) checkout.textContent = "Card checkout did not open.";
        const banner = document.createElement("div");
        banner.className = "pub-banner pub-banner-warn";
        banner.id = "probeBanner";
        banner.textContent = "Checkout canceled.";
        document.body.appendChild(banner);
        const opaque = (el: HTMLElement) => {
          let node: HTMLElement | null = el;
          while (node) {
            const bg = getComputedStyle(node).backgroundColor;
            const match = bg.match(/rgba?\(\d+,\s*\d+,\s*\d+(?:,\s*([0-9.]+))?\)/);
            if (match && (match[1] === undefined || Number(match[1]) >= 0.98)) return bg;
            node = node.parentElement;
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        const pick = (sel: string) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (!el) return null;
          return { color: getComputedStyle(el).color, background: opaque(el) };
        };
        return {
          note: pick("#noPricePayNote"),
          fee: pick("#cancelFeeNoticeText"),
          feeBox: pick("#cancelFeeNoticeBox"),
          err: pick("#bookingErrMsg"),
          card: pick("#cardPaymentFieldsBox p"),
          cardBox: pick("#cardPaymentFieldsBox"),
          deposit: pick("#depositNoticeBox p"),
          depositAmount: pick("#depositNoticeBox .text-emerald-400"),
          pay: pick("#payCodeInstr"),
          series: pick("#resSeriesBox .font-bold"),
          cash: pick("#cashAppPayBox .font-bold"),
          zelle: pick("#zellePayBox .font-bold"),
          venmo: pick("#venmoPayBox .font-bold"),
          paypal: pick("#paypalPayBox .font-bold"),
          toast: pick("#copyToastNotice"),
          checkout: pick("#resCheckoutError"),
          banner: pick("#probeBanner"),
        };
      });
      for (const [name, pair] of Object.entries(light)) {
        expect(pair, name).toBeTruthy();
        expect(rgbContrast(pair!.color, pair!.background), name + " " + pair!.color + " on " + pair!.background).toBeGreaterThanOrEqual(4.5);
      }

      await page.evaluate(() => document.documentElement.classList.remove("schedi-light"));
      const darkNote = await page.evaluate(() => {
        const el = document.getElementById("noPricePayNote") as HTMLElement;
        const cs = getComputedStyle(el);
        return { color: cs.color, background: cs.backgroundColor };
      });
      expect(rgbContrast(darkNote.color, darkNote.background)).toBeGreaterThanOrEqual(4.5);
      await page.evaluate(() => document.documentElement.classList.add("schedi-light"));

      const covered = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("#recurrenceFreqGroup .recurrence-opt")).map((label) => {
          const span = label.querySelector("span") as HTMLElement;
          const input = label.querySelector("input") as HTMLInputElement;
          span.scrollIntoView({ block: "center" });
          const sr = span.getBoundingClientRect();
          const ir = input.getBoundingClientRect();
          const hit = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2);
          return {
            value: input.value,
            inputW: ir.width,
            inputH: ir.height,
            spanW: sr.width,
            spanH: sr.height,
            hit: hit === input,
          };
        });
      });
      expect(covered.map((row) => row.value)).toEqual(["once", "weekly", "biweekly", "monthly", "custom"]);
      for (const row of covered) {
        expect(row.hit, row.value).toBe(true);
        expect(row.inputW, row.value).toBeGreaterThanOrEqual(row.spanW - 1);
        expect(row.inputH, row.value).toBeGreaterThanOrEqual(row.spanH - 1);
        expect(row.inputW, row.value).toBeGreaterThan(20);
      }

      async function tapValue(value: string) {
        const point = await page.evaluate((freq) => {
          const input = document.querySelector('#recurrenceFreqGroup input[value="' + freq + '"]') as HTMLElement;
          const span = input.parentElement?.querySelector("span") as HTMLElement;
          span.scrollIntoView({ block: "center" });
          const rect = span.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }, value);
        await page.touchscreen.tap(point.x, point.y);
        await page.waitForFunction((freq) => document.querySelector('input[name="pubRecurrenceFreq"]:checked')?.getAttribute("value") === freq, { timeout: 3000 }, value);
      }
      for (const value of ["weekly", "biweekly", "monthly", "once", "custom"]) await tapValue(value);
      expect(await page.$eval("#recurrenceCustomWrap", (el) => el.classList.contains("hidden"))).toBe(false);

      const monthTitle = await page.evaluate(() => {
        const el = document.getElementById("customMonthTitle") as HTMLElement;
        el.scrollIntoView({ block: "center" });
        return getComputedStyle(el).color;
      });
      expect(monthTitle).toBe("rgb(248, 250, 252)");

      const picked = await page.evaluate(() => {
        const day = document.querySelector("#monthCalendarContainer button.cal-day-open:not([disabled])") as HTMLButtonElement | null;
        if (!day) return "";
        day.click();
        return day.getAttribute("aria-label") || day.textContent || "day";
      });
      expect(picked).not.toBe("");
      await page.waitForSelector("#timeSlotsContainer button:not([disabled])");
      await page.click("#timeSlotsContainer button:not([disabled])");

      const dayPoint = await page.evaluate(() => {
        const day = document.querySelector("#customDatesGrid button.cal-day-open:not([disabled])") as HTMLButtonElement | null;
        if (!day) return null;
        day.scrollIntoView({ block: "center" });
        const rect = day.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      expect(dayPoint).toBeTruthy();
      await page.touchscreen.tap(dayPoint!.x, dayPoint!.y);
      const added = await page.evaluate(() => {
        const selected = document.querySelector("#customDatesGrid button.cal-day-selected") as HTMLButtonElement | null;
        return {
          pressed: selected?.getAttribute("aria-pressed") || "",
          label: selected?.getAttribute("aria-label") || "",
        };
      });
      expect(added?.pressed).toBe("true");
      expect(added?.label || "").toMatch(/Added/);

      await page.waitForSelector("#customDatesList .series-date-time");
      const staged = await page.evaluate(() => {
        const select = document.querySelector("#customDatesList .series-date-time") as HTMLSelectElement;
        const values = Array.from(select.options).map((option) => option.value).filter(Boolean);
        const next = values.find((value) => value !== select.value) || values[0];
        select.value = next;
        select.dispatchEvent(new Event("change"));
        const button = document.querySelector("#customDatesList .series-date-confirm") as HTMLButtonElement | null;
        return { next, shown: !!button && button.textContent === "Use this time" };
      });
      expect(staged.shown).toBe(true);
      const usePoint = await page.evaluate(() => {
        const button = document.querySelector("#customDatesList .series-date-confirm") as HTMLElement;
        button.scrollIntoView({ block: "center" });
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await page.touchscreen.tap(usePoint.x, usePoint.y);
      await page.waitForFunction(() => (document.querySelector("#customDatesList .series-date-ok")?.textContent || "").includes("Confirmed at"));

      const removePoint = await page.evaluate(() => {
        const button = document.querySelector("#customDatesList .series-date-remove") as HTMLElement;
        button.scrollIntoView({ block: "center" });
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await page.touchscreen.tap(removePoint.x, removePoint.y);
      await page.waitForFunction(() => !document.querySelector("#customDatesGrid button.cal-day-selected") && !document.querySelector("#customDatesList .series-date-row"));
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }, 120000);
});
