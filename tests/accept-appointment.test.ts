import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

function startServer() {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".css": "text/css",
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
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        close: () => new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

describe.skipIf(!chrome)("owner accept on the phone agenda", () => {
  it("saves a pending request, toasts when the save fails, and lists every upcoming visit", async () => {
    const server = await startServer();
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
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      await page.goto(`http://127.0.0.1:${server.port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => (document.getElementById("schediTodayRequests")?.textContent || "").includes("Luis Ortega"), { timeout: 20000 });

      const agenda = await page.evaluate(() => {
        const win = window as unknown as {
          getTenant: () => { appointments: { id: string; clientName?: string; date?: string; time?: string; status?: string; serviceName?: string }[] };
          renderSchediToday: (tenant: unknown) => void;
        };
        const tenant = win.getTenant();
        tenant.appointments.push({ id: "HB-FAR", clientName: "Far Ahead", date: "2099-06-01", time: "09:00 AM", status: "accepted", serviceName: "Cut & style" });
        win.renderSchediToday(tenant);
        const el = document.getElementById("schediTodaySchedule") as HTMLElement;
        const style = getComputedStyle(el);
        return {
          overflow: style.overflowY,
          scrolls: el.scrollHeight > el.clientHeight + 1,
          far: (el.textContent || "").includes("Far Ahead"),
        };
      });
      expect(agenda.overflow).toBe("auto");
      expect(agenda.scrolls).toBe(true);
      expect(agenda.far).toBe(true);

      await page.evaluate(() => {
        const win = window as unknown as {
          __SCHEDI_DEMO: boolean;
          __acceptMode: string;
          __calls: { url: string; action: string; statuses: Record<string, string> }[];
          __releaseAccept: () => void;
          schediAuthSession: () => string;
          fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
        };
        win.__SCHEDI_DEMO = false;
        win.__acceptMode = "hold-first";
        win.__calls = [];
        win.schediAuthSession = () => "owner-session";
        const held = new Promise<void>((resolve) => { win.__releaseAccept = resolve; });
        win.fetch = async (input, init) => {
          const url = typeof input === "string" ? input : String((input as Request).url || "");
          const raw = init && init.body ? String(init.body) : "";
          let parsed: { action?: string; appointments?: { id?: string; status?: string }[] } = {};
          try { parsed = JSON.parse(raw || "{}"); } catch { parsed = {}; }
          const watched = ["HB-1002", "HB-PADDED", "HB-1031", "HB-1004"];
          const statuses: Record<string, string> = {};
          for (const item of parsed.appointments || []) {
            if (item && item.id && watched.includes(item.id)) statuses[item.id] = item.status || "";
          }
          win.__calls.push({ url, action: parsed.action || "", statuses });
          if (parsed.action === "sync" && win.__acceptMode === "hold-first") {
            await held;
            win.__acceptMode = "ok";
          }
          if (parsed.action === "sync" && win.__acceptMode === "fail") {
            return new Response(JSON.stringify({ ok: false, error: "network" }), { status: 500, headers: { "Content-Type": "application/json" } });
          }
          if (parsed.action === "save" && win.__acceptMode === "profile-fail") {
            return new Response(JSON.stringify({ ok: false, error: "profile_write_failed" }), { status: 500, headers: { "Content-Type": "application/json" } });
          }
          return new Response(JSON.stringify({ ok: true, rosterRevision: 3 }), { status: 200, headers: { "Content-Type": "application/json" } });
        };
      });

      const acceptButton = await page.$("#schediTodayRequests button.sd-btn-ok");
      expect(acceptButton).toBeTruthy();
      await acceptButton!.click();
      const earlyToast = await page.$eval("#toastContainer", (el) => el.textContent || "");
      expect(earlyToast).not.toContain("Confirmation email queued");
      await page.evaluate(() => (window as unknown as { __releaseAccept: () => void }).__releaseAccept());
      await page.waitForFunction(() => (document.getElementById("toastContainer")?.textContent || "").includes("Accepted #HB-1002"), { timeout: 8000 });
      const saved = await page.evaluate(() => {
        const win = window as unknown as {
          getTenant: () => { appointments: { id: string; status?: string }[] };
          __calls: { url: string; action: string; statuses: Record<string, string> }[];
        };
        const app = win.getTenant().appointments.find((row) => row.id === "HB-1002");
        const sync = win.__calls.find((call) => call.action === "sync");
        return {
          status: app && app.status,
          waiting: document.getElementById("schediTodayRequests")?.textContent || "",
          syncStatus: sync && sync.statuses["HB-1002"],
          syncBeforeEmail: win.__calls.findIndex((call) => call.action === "sync") < win.__calls.findIndex((call) => call.url.includes("send-booking-email")),
        };
      });
      expect(saved.status).toBe("accepted");
      expect(saved.waiting).not.toContain("Luis Ortega");
      expect(saved.syncStatus).toBe("accepted");
      expect(saved.syncBeforeEmail).toBe(true);

      const padded = await page.evaluate(async () => {
        const win = window as unknown as {
          getTenant: () => { appointments: { id: string; clientName?: string; date?: string; time?: string; status?: string; serviceName?: string; acceptedAt?: string }[]; _privateBookingsLoaded?: boolean };
          renderSchediToday: (tenant: unknown) => void;
          __calls: { action: string; statuses: Record<string, string> }[];
        };
        const box = document.getElementById("toastContainer");
        if (box) box.replaceChildren();
        win.__calls.length = 0;
        const tenant = win.getTenant();
        tenant._privateBookingsLoaded = true;
        tenant.appointments.push({ id: "HB-PADDED", clientName: "Padded Pending", date: "2099-03-02", time: "10:00 AM", status: " pending", serviceName: "Cut & style" });
        win.renderSchediToday(tenant);
        const button = Array.from(document.querySelectorAll("#schediTodayRequests button")).find((el) => (el.getAttribute("onclick") || "").includes("acceptAppointment") && (el.getAttribute("onclick") || "").includes("HB-PADDED")) as HTMLButtonElement | undefined;
        if (!button) return { shown: false };
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
        const app = tenant.appointments.find((row) => row.id === "HB-PADDED");
        const sync = win.__calls.find((call) => call.action === "sync");
        return {
          shown: true,
          status: app && app.status,
          waiting: (document.getElementById("schediTodayRequests")?.textContent || "").includes("Padded Pending"),
          toast: document.getElementById("toastContainer")?.textContent || "",
          syncStatus: sync && sync.statuses["HB-PADDED"],
        };
      });
      expect(padded.shown).toBe(true);
      expect(padded.status).toBe("accepted");
      expect(padded.waiting).toBe(false);
      expect(padded.toast).toContain("Accepted #HB-PADDED");
      expect(padded.syncStatus).toBe("accepted");

      const profile = await page.evaluate(async () => {
        const win = window as unknown as {
          __acceptMode: string;
          __calls: { action: string; statuses: Record<string, string> }[];
          getTenant: () => { appointments: { id: string; status?: string }[] };
        };
        const box = document.getElementById("toastContainer");
        if (box) box.replaceChildren();
        win.__calls.length = 0;
        win.__acceptMode = "profile-fail";
        const button = Array.from(document.querySelectorAll("#schediTodayRequests button")).find((el) => (el.getAttribute("onclick") || "").includes("acceptAppointment") && (el.getAttribute("onclick") || "").includes("HB-1031")) as HTMLButtonElement | undefined;
        if (!button) return { shown: false };
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
        const app = win.getTenant().appointments.find((row) => row.id === "HB-1031");
        return {
          shown: true,
          status: app && app.status,
          toast: document.getElementById("toastContainer")?.textContent || "",
          syncStatus: (win.__calls.find((call) => call.action === "sync") || { statuses: {} }).statuses["HB-1031"],
        };
      });
      expect(profile.shown).toBe(true);
      expect(profile.status).toBe("accepted");
      expect(profile.toast).toContain("Accepted #HB-1031");
      expect(profile.toast).toContain("Saved locally, but cloud sync failed.");
      expect(profile.syncStatus).toBe("accepted");

      const failed = await page.evaluate(async () => {
        const win = window as unknown as {
          __acceptMode: string;
          __calls: { action: string; statuses: Record<string, string> }[];
          getTenant: () => { appointments: { id: string; status?: string }[] };
        };
        const box = document.getElementById("toastContainer");
        if (box) box.replaceChildren();
        win.__calls.length = 0;
        win.__acceptMode = "fail";
        const button = Array.from(document.querySelectorAll("#schediTodayRequests button")).find((el) => (el.getAttribute("onclick") || "").includes("acceptAppointment") && (el.getAttribute("onclick") || "").includes("HB-1004")) as HTMLButtonElement | undefined;
        if (!button) return { shown: false };
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
        const app = win.getTenant().appointments.find((row) => row.id === "HB-1004");
        return {
          shown: true,
          status: app && app.status,
          waiting: (document.getElementById("schediTodayRequests")?.textContent || "").includes("Priya Shah"),
          toast: document.getElementById("toastContainer")?.textContent || "",
        };
      });
      expect(failed.shown).toBe(true);
      expect(failed.status).toBe("pending");
      expect(failed.waiting).toBe(true);
      expect(failed.toast).toContain("Could not save this acceptance to your account");
      expect(failed.toast).not.toContain("Accepted #HB-1004");

      const missing = await page.evaluate(async () => {
        const box = document.getElementById("toastContainer");
        if (box) box.replaceChildren();
        await (window as unknown as { acceptAppointment: (id: string) => Promise<void> }).acceptAppointment("HB-MISSING");
        return document.getElementById("toastContainer")?.textContent || "";
      });
      expect(missing).toContain("That request is no longer waiting");
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  }, 60000);
});
