import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/google/chrome/chrome"].find((path) => existsSync(path));
const shots = "/tmp/booking-brand";

function contrast(fg: string, bg: string): number {
  const parse = (value: string) => {
    const m = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return [0, 0, 0];
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const lum = (rgb: number[]) => {
    const chan = rgb.map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
  };
  const lighter = Math.max(lum(parse(fg)), lum(parse(bg)));
  const darker = Math.min(lum(parse(fg)), lum(parse(bg)));
  return (lighter + 0.05) / (darker + 0.05);
}

describe.skipIf(!chrome)("booking brand mark and hours", () => {
  it("hides the header initial, shows the Schedi calendar mark, and writes closed days in full", async () => {
    mkdirSync(shots, { recursive: true });
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".css": "text/css; charset=utf-8",
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
    const browser = await puppeteer.default.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    try {
      const shell = await browser.newPage();
      await shell.goto(`http://127.0.0.1:${port}/?demo=1`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await shell.waitForFunction(() => typeof (window as unknown as { generateStandaloneHtmlForTenant?: unknown }).generateStandaloneHtmlForTenant === "function", { timeout: 20000 });
      const rendered = await shell.evaluate(() => {
        const tenant = (window as unknown as { schediBuildDemoTenant: () => Record<string, unknown> }).schediBuildDemoTenant();
        tenant.name = "Northside";
        tenant.logoUrl = "";
        tenant.logo = "";
        tenant.businessLogo = "";
        tenant.operatingHours = {
          Mon: { open: false, start: "09:00 AM", end: "05:00 PM" },
          Tue: { open: true, start: "09:00 AM", end: "06:30 PM" },
          Wed: { open: true, start: "09:00 AM", end: "06:30 PM" },
          Thu: { open: true, start: "09:00 AM", end: "06:30 PM" },
          Fri: { open: true, start: "09:00 AM", end: "06:30 PM" },
          Sat: { open: true, start: "08:00 AM", end: "06:00 PM" },
          Sun: { open: false, start: "10:00 AM", end: "02:00 PM" },
        };
        return (window as unknown as { generateStandaloneHtmlForTenant: (row: unknown) => string }).generateStandaloneHtmlForTenant(tenant);
      });
      const logoPage = await shell.evaluate(() => {
        const tenant = (window as unknown as { schediBuildDemoTenant: () => Record<string, unknown> }).schediBuildDemoTenant();
        tenant.name = "Northside";
        tenant.logoUrl = "https://schedi.app/assets/homescreen-icon.png";
        return (window as unknown as { generateStandaloneHtmlForTenant: (row: unknown) => string }).generateStandaloneHtmlForTenant(tenant);
      });

      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/assets/tailwind.css`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.setContent(rendered, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => (document.getElementById("bizHours")?.textContent || "").includes("Closed on Sundays and Mondays"), { timeout: 20000 });

      const copy = await page.evaluate(() => ({
        hours: document.getElementById("bizHours")?.textContent || "",
        headerHidden: (document.getElementById("pubHeaderMark") as HTMLElement | null)?.hidden === true,
        headerInitials: getComputedStyle(document.getElementById("pubHeaderInitials") as Element).display,
        cardInitials: getComputedStyle(document.getElementById("bizLogoInitials") as Element).display,
        mark: getComputedStyle(document.getElementById("bizSchediMark") as Element).display,
        logo: getComputedStyle(document.getElementById("bizLogo") as Element).display,
        paths: document.querySelector("#bizSchediMark svg")?.innerHTML || "",
      }));
      expect(copy.hours).toBe("Tue–Fri 9:00 AM–6:30 PM · Sat 8:00 AM–6:00 PM · Closed on Sundays and Mondays");
      expect(copy.headerHidden).toBe(true);
      expect(copy.headerInitials).toBe("none");
      expect(copy.cardInitials).toBe("none");
      expect(copy.mark).not.toBe("none");
      expect(copy.logo).toBe("none");
      expect(copy.paths).toContain('fill="#059669"');
      expect(copy.paths).toContain("M62 150 L104 194 L182 108");

      for (const width of [390, 1280]) {
        await page.setViewport({ width, height: width < 800 ? 844 : 900, deviceScaleFactor: 1 });
        for (const themeName of ["dark", "light"] as const) {
          await page.evaluate((light) => {
            (window as unknown as { applySchediTheme?: (mode: string) => void }).applySchediTheme?.(light ? "light" : "dark");
            document.documentElement.classList.toggle("schedi-light", light);
          }, themeName === "light");
          const box = await page.evaluate(() => {
            const mark = document.getElementById("bizSchediMark") as HTMLElement;
            const hours = document.getElementById("bizHours") as HTMLElement;
            const header = document.getElementById("bizHeader") as HTMLElement;
            const badge = document.getElementById("pubHeaderMark") as HTMLElement;
            const markStyle = getComputedStyle(mark);
            const hoursStyle = getComputedStyle(hours);
            const cardStyle = getComputedStyle(header);
            const root = document.documentElement;
            return {
              markWidth: Math.round(mark.getBoundingClientRect().width),
              markDisplay: markStyle.display,
              badgeDisplay: getComputedStyle(badge).display,
              hoursColor: hoursStyle.color,
              cardColor: cardStyle.backgroundColor,
              overflow: root.scrollWidth <= root.clientWidth + 1,
              hoursFits: hours.getBoundingClientRect().right <= root.clientWidth + 1,
            };
          });
          expect(box.badgeDisplay, themeName + " " + width).toBe("none");
          expect(box.markDisplay, themeName + " " + width).not.toBe("none");
          expect(box.markWidth, themeName + " " + width).toBe(width >= 640 ? 64 : 48);
          expect(box.overflow, themeName + " " + width).toBe(true);
          expect(box.hoursFits, themeName + " " + width).toBe(true);
          expect(contrast(box.hoursColor, box.cardColor), themeName + " " + width).toBeGreaterThanOrEqual(4.5);
          await page.screenshot({ path: `${shots}/${themeName}-${width}.png` });
        }
      }

      const withLogo = await browser.newPage();
      await withLogo.setViewport({ width: 1280, height: 900 });
      await withLogo.goto(`http://127.0.0.1:${port}/assets/tailwind.css`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await withLogo.setContent(logoPage, { waitUntil: "domcontentloaded", timeout: 45000 });
      await withLogo.waitForFunction(() => {
        const img = document.getElementById("bizLogo") as HTMLImageElement | null;
        return !!img && !img.hidden && img.src.indexOf("homescreen-icon.png") !== -1;
      }, { timeout: 20000 });
      const uploaded = await withLogo.evaluate(() => ({
        card: (document.getElementById("bizLogo") as HTMLImageElement).hidden,
        header: (document.getElementById("pubHeaderLogo") as HTMLImageElement).hidden,
        headerWrap: (document.getElementById("pubHeaderMark") as HTMLElement).hidden,
        mark: (document.getElementById("bizSchediMark") as HTMLElement).hidden,
        initials: getComputedStyle(document.getElementById("bizLogoInitials") as Element).display,
        headerSrc: (document.getElementById("pubHeaderLogo") as HTMLImageElement).src.indexOf("homescreen-icon.png") !== -1,
      }));
      expect(uploaded.card).toBe(false);
      expect(uploaded.header).toBe(false);
      expect(uploaded.headerWrap).toBe(false);
      expect(uploaded.headerSrc).toBe(true);
      expect(uploaded.mark).toBe(true);
      expect(uploaded.initials).toBe("none");
      await withLogo.screenshot({ path: `${shots}/logo-dark-1280.png` });
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }, 120000);
});
