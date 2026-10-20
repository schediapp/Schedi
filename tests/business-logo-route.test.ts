import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../worker/handler";

const TINY_PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
));

function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  return {
    objects,
    async put(key: string, body: Uint8Array, opts: { httpMetadata: { contentType: string } }) {
      objects.set(key, { bytes: body, type: opts.httpMetadata.contentType });
    },
    async get(key: string) {
      const hit = objects.get(key);
      return hit ? { body: hit.bytes, httpMetadata: { contentType: hit.type } } : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

function sessionKv(tenantId: string) {
  const rows = new Map<string, string>();
  rows.set("session:tok", JSON.stringify({
    role: "owner",
    tenantId,
    exp: Date.now() + 60 * 60 * 1000,
  }));
  return { async get(key: string) { return rows.get(key) ?? null; } };
}

describe("schedi-web logo route", () => {
  it("rejects a signed-out upload and a missing bucket, and still 404s other APIs", async () => {
    const denied = await handleRequest(new Request("https://schedi.app/api/business-logo", {
      method: "POST",
      headers: { Origin: "https://schedi.app" },
      body: JSON.stringify({ session: "tok", data: Buffer.from(TINY_PNG).toString("base64") }),
    }), { AUTH_KV: sessionKv("harbor-demo") }, { waitUntil() {} });
    expect(denied.status).toBe(503);
    expect(await denied.json()).toMatchObject({ error: "logo_storage_unconfigured" });

    const anon = await handleRequest(new Request("https://schedi.app/api/business-logo", {
      method: "POST",
      body: JSON.stringify({ data: Buffer.from(TINY_PNG).toString("base64") }),
    }), { AUTH_KV: sessionKv("harbor-demo"), LOGO_BUCKET: memoryBucket() }, { waitUntil() {} });
    expect(anon.status).toBe(401);

    const otherApi = await handleRequest(new Request("https://schedi.app/api/send-booking-email"), {}, { waitUntil() {} });
    expect(otherApi.status).toBe(404);
    const missingLogo = await handleRequest(new Request("https://schedi.app/logos/harbor-demo"), {}, { waitUntil() {} });
    expect(missingLogo.status).toBe(404);

    const assets = {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        if (path === "/index.html") {
          return new Response("<!DOCTYPE html><html><head><title>Schedi</title></head><body>app</body></html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response("missing", { status: 404 });
      },
    };
    const home = await handleRequest(new Request("https://schedi.app/"), { ASSETS: assets, FIREBASE_PROJECT_ID: "" }, { waitUntil() {} });
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain("<html");
    expect(homeHtml).not.toContain("logo_storage_unconfigured");
    const booking = await handleRequest(new Request("https://schedi.app/aria-rose"), { ASSETS: assets, FIREBASE_PROJECT_ID: "" }, { waitUntil() {} });
    expect(booking.status).toBe(200);
    const bookingHtml = await booking.text();
    expect(bookingHtml).toContain("<body>app");
    expect(bookingHtml).not.toContain("logo_storage_unconfigured");
  });

  it("stores, serves, and removes a logo only for the owner session", async () => {
    const bucket = memoryBucket();
    const env = { AUTH_KV: sessionKv("harbor-demo"), LOGO_BUCKET: bucket };
    const ctx = { waitUntil() {} };
    const uploaded = await handleRequest(new Request("https://schedi.app/api/business-logo", {
      method: "POST",
      headers: { Origin: "https://schedi.app", "Content-Type": "application/json" },
      body: JSON.stringify({
        session: "tok",
        tenantId: "other-biz",
        data: Buffer.from(TINY_PNG).toString("base64"),
      }),
    }), env, ctx);
    expect(uploaded.status).toBe(200);
    const body = await uploaded.json() as { url: string };
    expect(body.url).toMatch(/^https:\/\/schedi\.app\/logos\/harbor-demo\?v=[a-f0-9]{18}$/);
    expect(bucket.objects.has("logos/other-biz.png")).toBe(false);

    const image = await handleRequest(new Request(body.url), env, ctx);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toContain("immutable");

    const removed = await handleRequest(new Request("https://schedi.app/api/business-logo", {
      method: "POST",
      headers: { Origin: "https://schedi.app", "Content-Type": "application/json" },
      body: JSON.stringify({ session: "tok", remove: true }),
    }), env, ctx);
    expect(removed.status).toBe(200);
    expect(bucket.objects.size).toBe(0);
    const gone = await handleRequest(new Request(body.url), env, ctx);
    expect(gone.status).toBe(404);
  });

  it("accepts an agency session for a listed business and rejects the rest", async () => {
    const bucket = memoryBucket();
    const rows = new Map<string, string>();
    rows.set("session:agency", JSON.stringify({ role: "agency", email: "hq@schedi.app", exp: Date.now() + 60 * 60 * 1000 }));
    rows.set("session:old", JSON.stringify({ role: "owner", tenantId: "harbor-demo", exp: Date.now() - 1000 }));
    const env = {
      AUTH_KV: { async get(key: string) { return rows.get(key) ?? null; } },
      LOGO_BUCKET: bucket,
      FIREBASE_PROJECT_ID: "siteforge-97699",
    };
    const ctx = { waitUntil() {} };
    const png = Buffer.from(TINY_PNG).toString("base64");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/public/data/tenants/axeldelcidphotography?")) return new Response("{}", { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    try {
      const saved = await handleRequest(new Request("https://schedi.app/api/business-logo", {
        method: "POST",
        headers: { Origin: "https://schedi.app", "Content-Type": "application/json" },
        body: JSON.stringify({ session: "agency", tenantId: "axeldelcidphotography", data: png }),
      }), env, ctx);
      expect(saved.status).toBe(200);
      expect((await saved.json() as { url: string }).url).toMatch(/\/logos\/axeldelcidphotography\?v=/);
      expect(bucket.objects.has("logos/axeldelcidphotography.png")).toBe(true);

      const qr = await handleRequest(new Request("https://schedi.app/api/business-logo", {
        method: "POST",
        headers: { Origin: "https://schedi.app", "Content-Type": "application/json" },
        body: JSON.stringify({ session: "agency", tenantId: "axeldelcidphotography", data: png, purpose: "qr" }),
      }), env, ctx);
      expect(qr.status).toBe(200);
      expect([...bucket.objects.keys()].some((key) => key.startsWith("logos/axeldelcidphotography/qr."))).toBe(true);

      const other = await handleRequest(new Request("https://schedi.app/api/business-logo", {
        method: "POST",
        headers: { Origin: "https://schedi.app", "Content-Type": "application/json" },
        body: JSON.stringify({ session: "agency", tenantId: "other-biz", data: png }),
      }), env, ctx);
      expect(other.status).toBe(403);
      expect(bucket.objects.has("logos/other-biz.png")).toBe(false);

      const removed = await handleRequest(new Request("https://schedi.app/api/business-logo", {
        method: "POST",
        headers: { Origin: "https://schedi.app", "Content-Type": "application/json" },
        body: JSON.stringify({ session: "agency", tenantId: "axeldelcidphotography", remove: true }),
      }), env, ctx);
      expect(removed.status).toBe(200);
      expect(bucket.objects.has("logos/axeldelcidphotography.png")).toBe(false);
      expect([...bucket.objects.keys()].some((key) => key.includes("/qr."))).toBe(true);

      const stale = await handleRequest(new Request("https://schedi.app/api/business-logo", {
        method: "POST",
        headers: { Origin: "https://schedi.app", "Content-Type": "application/json" },
        body: JSON.stringify({ session: "old", data: png }),
      }), env, ctx);
      expect(stale.status).toBe(401);
      expect(await stale.json()).toMatchObject({ error: "session_expired" });

      const invalid = await handleRequest(new Request("https://schedi.app/api/business-logo", {
        method: "POST",
        headers: { Origin: "https://schedi.app", "Content-Type": "application/json" },
        body: JSON.stringify({ session: "missing", tenantId: "axeldelcidphotography", data: png }),
      }), env, ctx);
      expect(invalid.status).toBe(401);
      expect(await invalid.json()).toMatchObject({ error: "session_required" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("logo wrangler config", () => {
  it("binds production and preview buckets in wrangler.jsonc and does not track a second preview config", () => {
    const prod = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(prod).toContain('"bucket_name": "schedi-logos"');
    expect(prod).toContain('"bucket_name": "schedi-logos-preview"');
    expect(prod).toContain('"name": "schedi-web-preview"');
    expect(() => readFileSync(new URL("../wrangler.preview.jsonc", import.meta.url), "utf8")).toThrow();
  });
});
