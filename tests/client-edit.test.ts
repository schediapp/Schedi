import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleClientsHttp, sanitizeClientInput, sanitizeClientTags, upsertClientsFromBookings } from "../workers/schedi-email-worker/src/private-clients.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const worker = readFileSync(new URL("../workers/schedi-email-worker/src/private-clients.js", import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;

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

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

function post(body: unknown, origin = "https://schedi.app") {
  return new Request("https://schedi.app/api/clients", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function call(env: { AUTH_KV: ReturnType<typeof memoryKv> }, body: unknown) {
  const res = await handleClientsHttp(post(body), env, "https://schedi.app", { isAllowedOrigin: () => true });
  return { status: res.status, data: await res.json() as Record<string, unknown> };
}

async function ownerEnv(tenantId = "harbor-demo") {
  const kv = memoryKv();
  const exp = Date.now() + 60 * 60 * 1000;
  await kv.put("session:tok", JSON.stringify({ role: "owner", tenantId, exp }));
  return { AUTH_KV: kv, RL_CLIENTS: null };
}

describe("client edit allow list", () => {
  it("keeps notes and tags and drops every other field", () => {
    const res = sanitizeClientInput({
      name: "Maya Chen",
      email: "Maya@Example.com",
      phone: "(555) 201-0142",
      notes: "Likes a low fade",
      tags: [" fade ", "regular", "fade", "", { evil: true }, "tuesday"],
      role: "admin",
      appointments: [{ id: "HB-1001", clientName: "Changed" }],
      id: "cl_hijack",
    });
    expect(res.error).toBeUndefined();
    expect(res.client).toEqual({
      name: "Maya Chen",
      email: "maya@example.com",
      phone: "(555) 201-0142",
      notes: "Likes a low fade",
      tags: ["fade", "regular", "tuesday"],
    });
    expect(Object.keys(res.client || {}).sort()).toEqual(["email", "name", "notes", "phone", "tags"]);
    expect(sanitizeClientTags("regular, fade\nregular")).toEqual(["regular", "fade"]);
    expect(sanitizeClientInput({ name: "", email: "maya@example.com" }).error).toBe("missing_name");
    expect(sanitizeClientInput({ name: "Maya", email: "not-an-email" }).error).toBe("invalid_email");
    expect(sanitizeClientInput({ name: "Maya", phone: "555" }).error).toBe("invalid_phone");
    expect(sanitizeClientInput({ name: "Maya" }).error).toBe("missing_contact");
  });

  it("saves an owner update with notes and tags and does not rewrite bookings", async () => {
    const env = await ownerEnv();
    const added = await call(env, {
      action: "add",
      session: "tok",
      tenantId: "harbor-demo",
      client: { name: "Maya Chen", email: "maya@example.com", phone: "(555) 201-0142", notes: "Likes a low fade", tags: ["fade"], appointments: [{ clientName: "Nope" }] },
    });
    expect(added.status).toBe(200);
    const created = added.data.client as { id: string; notes: string; tags: string[] };
    expect(created.notes).toBe("Likes a low fade");
    expect(created.tags).toEqual(["fade"]);
    expect(created).not.toHaveProperty("appointments");

    const updated = await call(env, {
      action: "update",
      session: "tok",
      tenantId: "harbor-demo",
      clientId: created.id,
      client: {
        name: "Maya R. Chen",
        email: "maya@example.com",
        phone: "(555) 201-0142",
        notes: "Books on Tuesdays",
        tags: "regular, fade, tuesday",
        role: "admin",
        appointments: [{ id: "HB-1001", clientName: "Maya R. Chen" }],
      },
    });
    expect(updated.status).toBe(200);
    expect(updated.data.client).toMatchObject({
      id: created.id,
      name: "Maya R. Chen",
      notes: "Books on Tuesdays",
      tags: ["regular", "fade", "tuesday"],
    });
    expect(updated.data.client).not.toHaveProperty("role");
    expect(updated.data.client).not.toHaveProperty("appointments");

    const stored = JSON.parse(env.AUTH_KV.store.get("privateClients:harbor-demo") || "{}");
    expect(stored.clients).toHaveLength(1);
    expect(stored.clients[0].tags).toEqual(["regular", "fade", "tuesday"]);
    expect(stored.clients[0].notes).toBe("Books on Tuesdays");
    expect(JSON.stringify(stored)).not.toContain("HB-1001");
    expect(JSON.stringify(stored)).not.toContain("admin");
    const keys = [...env.AUTH_KV.store.keys()].filter((key) => key.startsWith("private") || key.includes("booking") || key.includes("appointment"));
    expect(keys).toEqual(["privateClients:harbor-demo"]);

    const denied = await call(env, { action: "update", session: "", tenantId: "harbor-demo", clientId: created.id, client: { name: "Maya", email: "maya@example.com" } });
    expect(denied.status).toBe(401);
    const badEmail = await call(env, {
      action: "update",
      session: "tok",
      tenantId: "harbor-demo",
      clientId: created.id,
      client: { name: "Maya", email: "nope", phone: "(555) 201-0142" },
    });
    expect(badEmail.status).toBe(400);
    expect(badEmail.data.error).toBe("invalid_email");
    const afterReject = JSON.parse(env.AUTH_KV.store.get("privateClients:harbor-demo") || "{}");
    expect(afterReject.clients[0].name).toBe("Maya R. Chen");
  });

  it("leaves saved notes and tags alone when bookings are upserted", async () => {
    const env = await ownerEnv("harbor-demo");
    await env.AUTH_KV.put("privateClients:harbor-demo", JSON.stringify({
      clients: [{ id: "cl_maya", name: "Maya Chen", email: "maya@example.com", phone: "(555) 201-0142", notes: "Likes a low fade", tags: ["regular", "fade"], source: "manual" }],
    }));
    const result = await upsertClientsFromBookings(env, "harbor-demo", [{
      clientName: "Maya Changed",
      clientEmail: "maya@example.com",
      clientPhone: "(555) 201-0142",
      status: "accepted",
      date: "2026-10-20",
    }]);
    expect(result.added).toBe(0);
    const stored = JSON.parse(env.AUTH_KV.store.get("privateClients:harbor-demo") || "{}");
    expect(stored.clients[0].name).toBe("Maya Chen");
    expect(stored.clients[0].notes).toBe("Likes a low fade");
    expect(stored.clients[0].tags).toEqual(["regular", "fade"]);
  });

  it("keeps the edit path off the roster save", () => {
    const update = worker.slice(worker.indexOf("if (action === 'update')"), worker.indexOf("error: 'unknown_action'"));
    expect(update).toContain("sanitizeClientInput");
    expect(update).toContain("notes:");
    expect(update).toContain("tags:");
    expect(update).not.toContain("appointment");
    expect(update).not.toContain("saveState");
    const save = extractFunction(html, "saveOwnerClientEdit");
    expect(save).toContain("action: 'update'");
    expect(save).toContain("notes:");
    expect(save).toContain("tags:");
    expect(save).not.toContain("saveState");
    expect(save).not.toContain("appointments");
    const demo = extractFunction(html, "schediDemoClientsApi");
    expect(demo).toContain("action === 'update'");
    expect(demo).not.toContain("appointments");
    expect(demo).not.toContain("saveState");
    const emailStart = html.indexOf("var CLIENT_EMAIL_RE");
    const emailLine = html.slice(emailStart, html.indexOf("\n", emailStart));
    const validate = new Function(`${emailLine}\n${extractFunction(html, "clientCleanText")}\n${extractFunction(html, "clientPhoneKey")}\n${extractFunction(html, "clientTagList")}\n${extractFunction(html, "validateClientRow")}; return validateClientRow;`)() as (raw: unknown) => { client?: { notes: string; tags: string[]; name: string }; error?: string; empty?: boolean };
    const ok = validate({ name: "Maya", email: "maya@example.com", phone: "(555) 201-0142", notes: "Private note", tags: "fade, regular", role: "admin" });
    expect(ok.client).toEqual({ name: "Maya", email: "maya@example.com", phone: "(555) 201-0142", notes: "Private note", tags: ["fade", "regular"] });
    expect(validate({ name: "", email: "maya@example.com", phone: "(555) 201-0142" }).error).toBe("missing_name");
    expect(validate({ name: "Maya", email: "nope", phone: "(555) 201-0142" }).error).toBe("invalid_email");
    expect(validate({ name: "Maya", email: "", phone: "12" }).error).toBe("invalid_phone");
  });
});

const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

describe.skipIf(!chrome)("client edit demo", () => {
  it("edits a client locally and leaves booked visits unchanged", async () => {
    mkdirSync("/opt/cursor/artifacts/screenshots", { recursive: true });
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
      const file = path === "/" || path === "/portal-preview" ? "/index.html" : path;
      const full = join(root, file);
      if (!full.startsWith(root) || !existsSync(full)) {
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
    const requests: { url: string; method: string }[] = [];
    const errors: string[] = [];
    try {
      const page = await browser.newPage();
      page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`http://127.0.0.1:${port}/portal-preview`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => document.getElementById("schediStatToday")?.textContent === "2", { timeout: 20000 });
      const before = await page.evaluate(() => {
        const w = window as unknown as { schediDashGo: (page: string) => void; getTenant: () => { appointments: { id: string; clientName?: string; clientPhone?: string; clientEmail?: string }[] } };
        w.schediDashGo("clients");
        return w.getTenant().appointments.map((row) => ({ id: row.id, clientName: row.clientName || "", clientPhone: row.clientPhone || "", clientEmail: row.clientEmail || "" }));
      });
      await page.waitForFunction(() => document.getElementById("clientListBody")?.textContent?.includes("Maya Chen"), { timeout: 10000 });
      const invalid = await page.evaluate(() => {
        const w = window as unknown as { startOwnerClientEdit: (id: string) => void; getTenant: () => { appointments: unknown[] } };
        const booked = JSON.stringify(w.getTenant().appointments);
        w.startOwnerClientEdit("CL-MAYA");
        (document.getElementById("clientEditName") as HTMLInputElement).value = "";
        (document.getElementById("clientEditEmail") as HTMLInputElement).value = "not-an-email";
        (document.getElementById("clientEditPhone") as HTMLInputElement).value = "12";
        (document.querySelector(".sd-client-edit") as HTMLFormElement).requestSubmit();
        return {
          error: document.getElementById("clientEditError")?.textContent || "",
          invalidName: document.getElementById("clientEditName")?.classList.contains("is-invalid") === true,
          stillMaya: document.getElementById("clientListBody")?.textContent?.includes("Maya Chen") === true,
          bookedSame: JSON.stringify(w.getTenant().appointments) === booked,
        };
      });
      expect(invalid.error).toContain("Enter the client's name.");
      expect(invalid.invalidName).toBe(true);
      expect(invalid.stillMaya).toBe(true);
      expect(invalid.bookedSame).toBe(true);
      const emailError = await page.evaluate(() => {
        (document.getElementById("clientEditName") as HTMLInputElement).value = "Maya R. Chen";
        (document.getElementById("clientEditPhone") as HTMLInputElement).value = "(555) 201-0142";
        (document.getElementById("clientEditEmail") as HTMLInputElement).value = "not-an-email";
        (document.querySelector(".sd-client-edit") as HTMLFormElement).requestSubmit();
        return document.getElementById("clientEditError")?.textContent || "";
      });
      expect(emailError).toContain("does not look right");
      await page.evaluate(() => {
        (document.getElementById("clientEditEmail") as HTMLInputElement).value = "maya@example.com";
        (document.getElementById("clientEditNotes") as HTMLTextAreaElement).value = "Likes a low fade. Books on Tuesdays.";
        (document.getElementById("clientEditTags") as HTMLInputElement).value = "regular, fade, tuesday";
        document.getElementById("clientEditEmail")?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const shot = async (name: string, theme: "dark" | "light", width: number) => {
        await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
        const placed = await page.evaluate((mode) => {
          document.documentElement.classList.toggle("schedi-light", mode === "light");
          const toast = document.getElementById("toastContainer");
          if (toast) toast.style.display = "none";
          const card = (document.querySelector(".sd-client-edit") || document.querySelector(".sd-client-detail"))?.closest(".sd-client") || document.querySelector(".sd-client");
          const bar = document.getElementById("schediDashTabbar");
          const barH = bar && getComputedStyle(bar).display !== "none" ? bar.getBoundingClientRect().height : 0;
          const topBar = 76;
          if (card) {
            const rect = card.getBoundingClientRect();
            const visibleBottom = window.innerHeight - barH - 12;
            let delta = rect.top - topBar;
            if (rect.bottom - delta > visibleBottom) delta += (rect.bottom - delta) - visibleBottom;
            if (rect.top - delta < topBar) delta = rect.top - topBar;
            window.scrollBy(0, delta);
          }
          const save = document.querySelector(".sd-client-save");
          if (!save) return null;
          const rect = save.getBoundingClientRect();
          const barTop = bar && getComputedStyle(bar).display !== "none" ? bar.getBoundingClientRect().top : window.innerHeight;
          return { top: rect.top, bottom: rect.bottom, barTop };
        }, theme);
        if (name.startsWith("client-edit-")) {
          expect(placed?.top).toBeGreaterThan(60);
          expect(placed && placed.bottom).toBeLessThan((placed?.barTop || 900) - 4);
        }
        await page.screenshot({ path: `/opt/cursor/artifacts/screenshots/${name}.png` });
      };
      await shot("client-edit-1280-dark", "dark", 1280);
      await shot("client-edit-1280-light", "light", 1280);
      await shot("client-edit-412-dark", "dark", 412);
      await shot("client-edit-412-light", "light", 412);
      const layout = await page.evaluate(() => {
        const form = document.querySelector(".sd-client-edit") as HTMLElement;
        const save = form.querySelector("button[type='submit']") as HTMLElement;
        const phone = getComputedStyle(form).gridTemplateColumns;
        const saveHeight = save.getBoundingClientRect().height;
        document.documentElement.classList.remove("schedi-light");
        const darkName = getComputedStyle(document.querySelector(".sd-client-name") as HTMLElement).color;
        document.documentElement.classList.add("schedi-light");
        const lightName = getComputedStyle(document.querySelector(".sd-client-name") as HTMLElement).color;
        document.documentElement.classList.remove("schedi-light");
        return { phone, saveHeight, darkName, lightName };
      });
      expect(layout.phone.split(" ").length).toBe(1);
      expect(layout.saveHeight).toBeGreaterThanOrEqual(44);
      expect(layout.darkName).not.toBe(layout.lightName);
      await page.setViewport({ width: 1280, height: 900 });
      const saved = await page.evaluate(async () => {
        const w = window as unknown as {
          getTenant: () => { appointments: { id: string; clientName?: string; clientPhone?: string; clientEmail?: string }[] };
          openClientRecurring: (id: string) => void;
          closeOwnerRecurringModal: () => void;
        };
        const booked = w.getTenant().appointments.map((row) => ({ id: row.id, clientName: row.clientName || "", clientPhone: row.clientPhone || "", clientEmail: row.clientEmail || "" }));
        (document.querySelector(".sd-client-edit") as HTMLFormElement).requestSubmit();
        for (let i = 0; i < 20 && document.querySelector(".sd-client-edit"); i++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        w.openClientRecurring("CL-MAYA");
        const prefill = {
          name: (document.getElementById("ownerRecurClient") as HTMLInputElement).value,
          phone: (document.getElementById("ownerRecurPhone") as HTMLInputElement).value,
          email: (document.getElementById("ownerRecurEmail") as HTMLInputElement).value,
        };
        w.closeOwnerRecurringModal();
        const maya = w.getTenant().appointments.find((row) => row.id === "HB-1001");
        return {
          list: document.getElementById("clientListBody")?.textContent || "",
          editing: !!document.querySelector(".sd-client-edit"),
          prefill,
          maya,
          bookedSame: JSON.stringify(w.getTenant().appointments.map((row) => ({ id: row.id, clientName: row.clientName || "", clientPhone: row.clientPhone || "", clientEmail: row.clientEmail || "" }))) === JSON.stringify(booked),
        };
      });
      expect(saved.editing).toBe(false);
      expect(saved.list).toContain("Maya R. Chen");
      expect(saved.list).toContain("Books on Tuesdays");
      expect(saved.list).toContain("tuesday");
      expect(saved.prefill).toEqual({ name: "Maya R. Chen", phone: "(555) 201-0142", email: "maya@example.com" });
      expect(saved.maya).toMatchObject({ clientName: "Maya Chen", clientPhone: "(555) 201-0142", clientEmail: "maya@example.com" });
      expect(saved.bookedSame).toBe(true);
      expect(before.find((row) => row.id === "HB-1001")?.clientName).toBe("Maya Chen");
      await shot("client-saved-1280-dark", "dark", 1280);
      await shot("client-saved-1280-light", "light", 1280);
      await shot("client-saved-412-dark", "dark", 412);
      await shot("client-saved-412-light", "light", 412);
      const desktop = await page.evaluate(() => {
        const formGone = !document.querySelector(".sd-client-edit");
        return { formGone, columns: getComputedStyle(document.querySelector(".sd-client") as HTMLElement).display };
      });
      expect(desktop.formGone).toBe(true);
      await page.setViewport({ width: 1280, height: 900 });
      const wide = await page.evaluate(() => {
        const w = window as unknown as { startOwnerClientEdit: (id: string) => void; cancelOwnerClientEdit: () => void };
        w.startOwnerClientEdit("CL-LUIS");
        const columns = getComputedStyle(document.querySelector(".sd-client-edit") as HTMLElement).gridTemplateColumns;
        w.cancelOwnerClientEdit();
        return columns.split(" ").length;
      });
      expect(wide).toBe(2);
      const writes = requests.filter((request) => !["GET", "HEAD", "OPTIONS"].includes(request.method));
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 60000);
});
