import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

describe("agency HQ dashboard shell", () => {
  it("keeps the newhq flag, demo businesses, and schedi.app guard", () => {
    expect(hq).toContain("flag === '1' || flag === 'true' || flag === 'on'");
    expect(hq).toContain("host !== 'schedi.app' && host !== 'www.schedi.app'");
    expect(hq).toContain("window.__SCHEDI_HQ_DEMO = true");
    expect(hq).toContain("id: 'harbor-demo'");
    expect(hq).toContain("id: 'northwind-demo'");
    expect(hq).toContain("id: 'lumen-demo'");
    expect(hq).toContain("Harbor Studio");
    expect(hq).toContain("Northwind Clinic");
    expect(hq).toContain("Lumen Studio");
  });

  it("matches the owner dashboard tabs and leaves proposal cards out", () => {
    expect(hq).toContain('id="hqDash"');
    expect(hq).toContain('id="schediHqDashStyle"');
    expect(hq).toContain('id="hqDashTabbar"');
    expect(hq).toContain(">Overview<");
    expect(hq).toContain(">Directory<");
    expect(hq).toContain(">Billing<");
    expect(hq).toContain(">Email<");
    expect(hq).toContain('aria-label="Add business"');
    expect(hq).toContain("function hqDashPaint");
    expect(hq).toContain("openProvisionModal()");
    expect(hq).toContain("loginAsTenantOwner(");
    expect(hq).toContain("toggleSubscriptionPause(");
    expect(hq).toContain("deleteAgencyTenant(");
    expect(hq).toContain("Open booking page");
    expect(hq).toContain("Edit profile");
    expect(hq).toContain("Edit HQ tags");
    expect(hq).toContain("Email welcome");
    expect(hq).toContain("Booking page live");
    expect(hq).toContain("Complimentary Pro");
    expect(hq).toContain("Log in to portal");
    expect(hq).not.toContain("Failed payments");
    expect(hq).not.toContain("Email activity");
    expect(hq).not.toContain("pending requests");
    const cssStart = hq.indexOf('<style id="schediHqDashStyle">');
    const css = hq.slice(cssStart, hq.indexOf("</style>", cssStart));
    expect(css).toContain("html.schedi-newhq #hqDashTabbar");
    expect(css).toContain("--hq-tab-slot");
    expect(css).toContain("width: 52px");
    expect(css).toContain("width: 48px");
  });
});

describe.skipIf(!chrome)("agency HQ dashboard browser", () => {
  it("paints demo overview, directory, billing, and email from existing data", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/hq" || path === "/hq/" ? "/site/hq.html" : path;
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
    const errors: string[] = [];
    try {
      const page = await browser.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(`http://127.0.0.1:${port}/hq?demo=1&newhq=1`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => {
        const mrr = document.getElementById("hqdStatMrr");
        return mrr?.textContent === "$49" && document.body.textContent?.includes("Harbor Studio");
      }, { timeout: 20000 });
      const overview = await page.evaluate(() => {
        const text = (id: string) => document.getElementById(id)?.textContent || "";
        return {
          demo: document.documentElement.classList.contains("schedi-hq-demo"),
          newhq: document.documentElement.classList.contains("schedi-newhq"),
          businesses: text("hqdStatBusinesses"),
          mrr: text("hqdStatMrr"),
          month: text("hqdStatMonth"),
          unpaid: text("hqdStatUnpaid"),
          date: text("hqdOverviewDate"),
          attention: document.getElementById("hqdAttention")?.innerText || "",
          latest: document.getElementById("hqdLatest")?.innerText || "",
          body: document.body.innerText,
          tab: document.querySelector("#hqDashTabbar button.is-on")?.textContent || "",
        };
      });
      expect(overview.demo).toBe(true);
      expect(overview.newhq).toBe(true);
      expect(overview.businesses).toBe("3");
      expect(overview.mrr).toBe("$49");
      expect(overview.month).toBe("22");
      expect(overview.unpaid).toBe("3");
      expect(overview.date).toContain("3 businesses");
      expect(overview.attention).toContain("Northwind Clinic");
      expect(overview.attention).toContain("No services");
      expect(overview.attention).toContain("Resume");
      expect(overview.attention).toContain("Harbor Studio");
      expect(overview.attention).toContain("3 unpaid");
      expect(overview.latest).toContain("Oct 15");
      expect(overview.latest).toContain("Oct 12");
      expect(overview.latest).toContain("Lumen Studio");
      expect(overview.body).not.toContain("Failed payments");
      expect(overview.body).not.toContain("Email activity");
      expect(overview.tab).toContain("Overview");
      expect(errors).toEqual([]);

      await page.click('#hqDashTabbar button[data-hqd-go="directory"]');
      await page.waitForFunction(() => !document.getElementById("hqdDirectory")?.hidden);
      const directory = await page.evaluate(() => document.getElementById("hqdDirList")?.innerText || "");
      expect(directory).toContain("Booking page live");
      expect(directory).toContain("Log in to portal");
      expect(directory).toContain("Complimentary");
      await page.click('#hqdDirList summary[aria-label="More actions for Harbor Studio"]');
      const menu = await page.evaluate(() => document.querySelector("#hqdDirList details[open] .hq-more-menu")?.textContent || "");
      expect(menu).toContain("Open booking page");
      expect(menu).toContain("Edit profile");
      expect(menu).toContain("Edit HQ tags");
      expect(menu).toContain("Email welcome");
      expect(menu).toContain("Pause business");
      expect(menu).toContain("Delete business");
      page.once("dialog", (dialog) => dialog.dismiss());
      await page.click('#hqdDirList details[open] .hq-more-danger');
      const stillThere = await page.evaluate(() => document.body.innerText.includes("Harbor Studio"));
      expect(stillThere).toBe(true);

      await page.evaluate(() => (document.querySelector('#hqdDirList .hqd-name') as HTMLButtonElement).click());
      await page.waitForSelector("#hqDashSheet:not([hidden])");
      const sheet = await page.evaluate(() => document.getElementById("hqdSheetBody")?.innerText || "");
      expect(sheet).toContain("Cut & style");
      expect(sheet).toContain("$65");
      expect(sheet).toContain("Avery Cole");
      expect(sheet).toContain("Cash App $HarborStudio");
      expect(sheet).toContain("Since Jan 4, 2026");
      expect(sheet).toContain("Log in to portal");
      await page.click("#hqDashSheet .hqd-close");
      await page.waitForFunction(() => document.getElementById("hqDashSheet")?.hidden);

      await page.click('#hqDashTabbar button[data-hqd-go="billing"]');
      await page.waitForFunction(() => !document.getElementById("hqdBilling")?.hidden);
      const billing = await page.evaluate(() => ({
        mrr: document.getElementById("hqdBillMrr")?.textContent || "",
        text: document.getElementById("hqdBilling")?.innerText || "",
        switched: document.getElementById("agencyAutoDraftEnabled")?.classList.contains("hqd-switch") || false,
      }));
      expect(billing.mrr).toBe("$49.00");
      expect(billing.text).toContain("Complimentary Pro");
      expect(billing.text).toContain("Live Stripe");
      expect(billing.text).toContain("Auto-debit on the 1st");
      expect(billing.switched).toBe(true);
      const lumen = await page.evaluate(() => {
        const card = Array.from(document.querySelectorAll("#hqdBillList article")).find((el) => el.textContent?.includes("Lumen Studio"));
        return !!card?.querySelector("[data-hqd-comp]")?.hasAttribute("checked") || (card?.querySelector("[data-hqd-comp]") as HTMLInputElement | null)?.checked;
      });
      expect(lumen).toBe(true);

      await page.click('#hqDashTabbar button[data-hqd-go="email"]');
      await page.waitForFunction(() => !document.getElementById("hqdEmail")?.hidden);
      const email = await page.evaluate(() => document.getElementById("hqdEmail")?.innerText || "");
      expect(email).toContain("Save sender");
      expect(email).toContain("Send test");
      expect(email).toContain("Resend");
      expect(email).toContain("demo@harbor.studio");
      expect(email).not.toContain("Email activity");

      await page.click("#hqDashTabbar .hqd-fab");
      const provisionOpen = await page.evaluate(() => !document.getElementById("provisionModal")?.classList.contains("hidden"));
      expect(provisionOpen).toBe(true);
      await page.evaluate(() => (window as unknown as { closeProvisionModal: () => void }).closeProvisionModal());

      for (const width of [340, 390, 1280]) {
        await page.setViewport({ width, height: width === 1280 ? 800 : 844 });
        await page.evaluate(() => document.documentElement.classList.remove("schedi-light"));
        const dark = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          light: document.documentElement.classList.contains("schedi-light"),
        }));
        expect(dark.overflow, "dark " + width).toBe(true);
        expect(dark.light).toBe(false);
        await page.click("#hqDashTheme");
        const light = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          light: document.documentElement.classList.contains("schedi-light"),
        }));
        expect(light.light, "light " + width).toBe(true);
        expect(light.overflow, "light " + width).toBe(true);
        await page.click("#hqDashTheme");
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }, 90000);
});
