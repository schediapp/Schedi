import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { handleRequest, tenantFromFirestore, type SchediEnv } from "../worker/handler";
import { localBusinessJsonLd } from "../worker/local-business";
import { publicBusinessAddress } from "../workers/schedi-email-worker/src/booking-ics.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

function firestoreDoc(show: boolean | undefined) {
  const fields: Record<string, unknown> = {
    name: { stringValue: "Bright Cuts" },
    slug: { stringValue: "bright-cuts" },
    industry: { stringValue: "Barber" },
    seoPublic: { booleanValue: true },
    address: { stringValue: "10 Main St" },
    city: { stringValue: "Austin" },
    state: { stringValue: "TX" },
  };
  if (show !== undefined) fields.showPublicAddress = { booleanValue: show };
  return { fields };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public address setting", () => {
  it("defaults to shown and adds the Your page toggle in both portals", () => {
    for (const source of [html, hq]) {
      expect(source).toContain('id="tenantShowAddressLabel">Show my address on my booking page');
      expect(source).toContain('id="tenantShowAddress" class="sd-pay-switch" role="switch"');
      expect(source).toContain("tenant.showPublicAddress = !showAddrEl || !!showAddrEl.checked");
      expect(source).toContain("return !tenant || tenant.showPublicAddress !== false");
      const saveAt = source.indexOf("window.handleUpdateShiftsSubmit");
      const save = source.slice(saveAt, source.indexOf("function canManageBlockedTimes", saveAt));
      expect(save.indexOf("tenant.showPublicAddress")).toBeGreaterThan(-1);
      expect(save.indexOf("tenant.showPublicAddress")).toBeLessThan(save.indexOf("saveState()"));
      expect(source).toContain('id="manageAddressLink"');
      expect(source).toContain('id="resWhereLine"');
      expect(source).toContain("function paintConfirmationWhere");
      expect(source).toContain("if (publicTenant.showPublicAddress === false)");
      expect(source).toContain("var shareAddress = tenant.showPublicAddress !== false");
      expect(source).toContain("var address = publicTenantLocation(tenant)");
      expect(source).toContain("var loc = publicTenantLocation(tenant)");
    }
  });

  it("keeps a missing flag public and omits the address when the owner turns it off", () => {
    const shown = tenantFromFirestore(firestoreDoc(undefined));
    expect(shown?.streetAddress).toBe("10 Main St");
    expect(shown?.city).toBe("Austin");
    expect(localBusinessJsonLd(shown!, "https://schedi.app/bright-cuts").address).toMatchObject({
      streetAddress: "10 Main St",
      addressLocality: "Austin",
      addressRegion: "TX",
    });

    const explicit = tenantFromFirestore(firestoreDoc(true));
    expect(explicit?.streetAddress).toBe("10 Main St");

    const hidden = tenantFromFirestore(firestoreDoc(false));
    expect(hidden?.streetAddress).toBeUndefined();
    expect(hidden?.city).toBeUndefined();
    expect(hidden?.region).toBeUndefined();
    const json = JSON.stringify(localBusinessJsonLd(hidden!, "https://schedi.app/bright-cuts"));
    expect(json).not.toContain("streetAddress");
    expect(json).not.toContain("addressLocality");
    expect(json).not.toContain("PostalAddress");
    expect(json).toContain("Bright Cuts");
  });

  it("asks Firestore for the flag before building public JSON-LD", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const target = String(input);
      expect(target).toContain("mask.fieldPaths=showPublicAddress");
      return new Response(JSON.stringify(firestoreDoc(false)), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleRequest(
      new Request("https://schedi.app/bright-cuts"),
      { FIREBASE_PROJECT_ID: "siteforge-97699", ASSETS: shellAssets() },
      { waitUntil() {} },
    );
    const body = await response.text();
    expect(body).not.toContain("10 Main St");
    expect(body).not.toContain("streetAddress");
    expect(body).toContain("Bright Cuts");
  });

  it("leaves the address out of client calendar files when the owner hides it", () => {
    const tenant = { name: "Harbor Studio", address: "18 Harbor Lane, Brooklyn, NY", timezone: "America/New_York" };
    expect(publicBusinessAddress(tenant)).toBe("18 Harbor Lane, Brooklyn, NY");
    expect(publicBusinessAddress({ ...tenant, showPublicAddress: true })).toBe("18 Harbor Lane, Brooklyn, NY");
    expect(publicBusinessAddress({ ...tenant, showPublicAddress: false })).toBe("");
    expect(publicBusinessAddress({ showPublicAddress: false, location: "18 Harbor Lane" })).toBe("");
  });
});

function shellAssets(): SchediEnv["ASSETS"] {
  return {
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      if (path === "/index.html" || path === "/booking.html") {
        return new Response("<!DOCTYPE html><html><head><title>Schedi</title></head><body>app</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("missing", { status: 404 });
    },
  };
}

describe.skipIf(!chrome)("public address on the booking page", () => {
  it("saves the toggle and hides the address on the booking, manage, and confirmation pages", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json",
    };
    const server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
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
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => typeof (window as unknown as { schediDashGo?: unknown }).schediDashGo === "function", { timeout: 20000 });
      await page.evaluate(() => (window as unknown as { schediDashGo: (tab: string) => void }).schediDashGo("profile"));
      await page.waitForSelector("#tenantShowAddress");
      const before = await page.evaluate(() => {
        const box = document.getElementById("tenantShowAddress") as HTMLInputElement;
        const label = document.getElementById("tenantShowAddressLabel");
        return {
          checked: box.checked,
          role: box.getAttribute("role"),
          label: label?.textContent || "",
          address: (document.getElementById("tenantAddress") as HTMLInputElement).value,
          stored: (window as unknown as { getTenant: () => { showPublicAddress?: boolean; address?: string } }).getTenant().showPublicAddress,
        };
      });
      expect(before.checked).toBe(true);
      expect(before.role).toBe("switch");
      expect(before.label).toBe("Show my address on my booking page");
      expect(before.address).toContain("18 Harbor Lane");
      expect(before.stored).not.toBe(false);

      await page.click("#tenantShowAddress");
      await page.click("#tenantHoursSaveBtn");
      await page.waitForFunction(() => (window as unknown as { getTenant: () => { showPublicAddress?: boolean } }).getTenant().showPublicAddress === false);
      const savedOff = await page.evaluate(() => {
        const tenant = (window as unknown as { getTenant: () => { showPublicAddress?: boolean; address?: string } }).getTenant();
        const html = (window as unknown as { generateStandaloneHtmlForTenant: (row: unknown) => string }).generateStandaloneHtmlForTenant(tenant);
        const main = document.createElement("div");
        (window as unknown as { renderManageAppointment: (node: HTMLElement, row: unknown, appt: unknown) => void }).renderManageAppointment(main, tenant, {
          id: "HB-1",
          date: "2026-11-02",
          time: "10:00 AM",
          serviceName: "Consultation",
          manageToken: "abcdefghijklmnopqrst",
        });
        return {
          flag: tenant.showPublicAddress,
          address: tenant.address,
          html,
          manage: main.innerHTML,
        };
      });
      expect(savedOff.flag).toBe(false);
      expect(savedOff.address).toContain("18 Harbor Lane");
      expect(savedOff.html).not.toContain("18 Harbor Lane");
      expect(savedOff.html).not.toContain("streetAddress");
      expect(savedOff.html).not.toContain("maps/search/?api=1&query=18");
      expect(savedOff.manage).not.toContain("18 Harbor Lane");
      expect(savedOff.manage).not.toContain("manageAddressLink");

      const hidden = await page.evaluate(async (source) => {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
        frame.srcdoc = source.replace(/<script\s+src=["']https?:[^"']+["'][^>]*><\/script>/gi, "").replace(/<link\b[^>]*>/gi, "");
        document.body.appendChild(frame);
        await new Promise<void>((resolve) => { frame.onload = () => resolve(); });
        const doc = frame.contentDocument as Document;
        const view = frame.contentWindow as Window & { paintConfirmationWhere: () => void; getPubLocation: () => string };
        view.paintConfirmationWhere();
        const link = doc.getElementById("bizAddress") as HTMLAnchorElement | null;
        const where = doc.getElementById("resWhereLine");
        const maps = Array.from(doc.querySelectorAll("a")).some((node) => (node.getAttribute("href") || "").includes("maps"));
        return {
          hidden: !link || link.hidden,
          href: link?.getAttribute("href") || "",
          whereHidden: !!where && where.classList.contains("hidden"),
          whereText: where?.textContent || "",
          maps,
          location: view.getPubLocation(),
        };
      }, savedOff.html);
      expect(hidden.hidden).toBe(true);
      expect(hidden.href).toBe("");
      expect(hidden.whereHidden).toBe(true);
      expect(hidden.whereText).toBe("");
      expect(hidden.maps).toBe(false);
      expect(hidden.location).toBe("");

      await page.click("#tenantShowAddress");
      await page.click("#tenantHoursSaveBtn");
      await page.waitForFunction(() => (window as unknown as { getTenant: () => { showPublicAddress?: boolean } }).getTenant().showPublicAddress !== false);
      const savedOn = await page.evaluate(() => {
        const tenant = (window as unknown as { getTenant: () => { showPublicAddress?: boolean; address?: string } }).getTenant();
        const html = (window as unknown as { generateStandaloneHtmlForTenant: (row: unknown) => string }).generateStandaloneHtmlForTenant(tenant);
        const main = document.createElement("div");
        (window as unknown as { renderManageAppointment: (node: HTMLElement, row: unknown, appt: unknown) => void }).renderManageAppointment(main, tenant, {
          id: "HB-1",
          date: "2026-11-02",
          time: "10:00 AM",
          serviceName: "Consultation",
          manageToken: "abcdefghijklmnopqrst",
        });
        return { flag: tenant.showPublicAddress, address: tenant.address, html, manage: main.innerHTML };
      });
      expect(savedOn.flag).not.toBe(false);
      expect(savedOn.address).toContain("18 Harbor Lane");
      expect(savedOn.html).toContain("18 Harbor Lane");
      expect(savedOn.html).toContain("streetAddress");
      expect(savedOn.manage).toContain("18 Harbor Lane");
      expect(savedOn.manage).toContain("maps/search");

      const shown = await page.evaluate(async (source) => {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
        frame.srcdoc = source.replace(/<script\s+src=["']https?:[^"']+["'][^>]*><\/script>/gi, "").replace(/<link\b[^>]*>/gi, "");
        document.body.appendChild(frame);
        await new Promise<void>((resolve) => { frame.onload = () => resolve(); });
        const doc = frame.contentDocument as Document;
        const view = frame.contentWindow as Window & { paintConfirmationWhere: () => void };
        view.paintConfirmationWhere();
        const link = doc.getElementById("bizAddress") as HTMLAnchorElement;
        const where = doc.getElementById("resWhereLine") as HTMLElement;
        const map = where.querySelector("a") as HTMLAnchorElement | null;
        return {
          hidden: link.hidden,
          text: link.textContent || "",
          href: link.getAttribute("href") || "",
          whereText: where.textContent || "",
          map: map?.getAttribute("href") || "",
        };
      }, savedOn.html);
      expect(shown.hidden).toBe(false);
      expect(shown.text).toContain("18 Harbor Lane");
      expect(shown.href).toContain("maps/search");
      expect(shown.whereText).toContain("18 Harbor Lane");
      expect(shown.map).toContain("maps/search");
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }, 120000);
});
