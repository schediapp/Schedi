import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleLogoUpload, sanitizeLogoSvg, sniffLogo } from "../workers/schedi-email-worker/src/logo-upload.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deps(session: unknown) {
  return {
    json,
    isAllowedOrigin: () => true,
    readSession: async () => session,
  };
}

function post(data: string, origin = "https://schedi.app") {
  return new Request("https://schedi.app/api/logo-upload", {
    method: "POST",
    headers: origin ? { Origin: origin } : {},
    body: JSON.stringify({ session: "tok", data }),
  });
}

const owner = { role: "owner", tenantId: "harbor-demo" };

describe("logo upload", () => {
  it("keeps a plain SVG and rejects scripts, handlers, and remote links", () => {
    const clean = sanitizeLogoSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10z" fill="#111"/></svg>');
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.svg).toContain("<path");
    expect(sanitizeLogoSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').ok).toBe(false);
    expect(sanitizeLogoSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>').ok).toBe(false);
    expect(sanitizeLogoSvg('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/a.png"/></svg>').ok).toBe(false);
    expect(sanitizeLogoSvg("<div>nope</div>").ok).toBe(false);
  });

  it("recognizes PNG bytes and rejects a renamed text file", () => {
    const png = Uint8Array.from(Buffer.from(TINY_PNG, "base64"));
    expect(sniffLogo(png)).toBe("image/png");
    expect(sniffLogo(new TextEncoder().encode("<html></html>"))).toBe("");
  });

  it("requires an owner session and a configured bucket", async () => {
    const denied = await handleLogoUpload(post(TINY_PNG), {}, "https://schedi.app", deps(null));
    expect(denied.status).toBe(401);
    const unconfigured = await handleLogoUpload(post(TINY_PNG), {}, "https://schedi.app", deps(owner));
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ error: "logo_storage_unconfigured" });
    const foreign = await handleLogoUpload(post(TINY_PNG), { LOGO_BUCKET: { put: async () => {} }, LOGO_PUBLIC_BASE: "https://logos.example.test" }, "https://schedi.app", deps({ role: "agency", tenantId: "hq" }));
    expect(foreign.status).toBe(401);
  });

  it("stores a PNG and returns the public URL for that business", async () => {
    const puts: { key: string; type: string }[] = [];
    const env = {
      LOGO_PUBLIC_BASE: "https://logos.example.test/",
      LOGO_BUCKET: {
        async put(key: string, _body: unknown, opts: { httpMetadata: { contentType: string } }) {
          puts.push({ key, type: opts.httpMetadata.contentType });
        },
        async delete() {},
      },
    };
    const res = await handleLogoUpload(post(TINY_PNG), env, "https://schedi.app", deps(owner));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, url: "https://logos.example.test/logos/harbor-demo.png" });
    expect(puts).toEqual([{ key: "logos/harbor-demo.png", type: "image/png" }]);
  });

  it("crops to a square no wider than 512 and the demo does not upload", () => {
    const crop = new Function(`${extractFunction(html, "logoCropSource")}; return logoCropSource;`)() as (
      w: number, h: number, stage: number, zoom: number, x: number, y: number,
    ) => { out: number; sw: number };
    const wide = crop(1000, 400, 280, 1, -200, 0);
    expect(wide.out).toBeLessThanOrEqual(512);
    expect(wide.sw).toBeGreaterThan(0);
    const store = extractFunction(html, "storeLogoBlob");
    expect(store.indexOf("__SCHEDI_DEMO")).toBeLessThan(store.indexOf("api/logo-upload"));
    expect(extractFunction(html, "logoUploadMessage")).toContain("This demo shows your logo here only");
    expect(html).toContain('id="logoUploadDrop"');
    expect(html).toContain('id="logoCropCanvas"');
    expect(html).toContain("Or paste a link");
  });
});
