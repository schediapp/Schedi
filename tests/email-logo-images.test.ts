import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, handleRequest, type SchediEnv } from "../worker/handler";
import { emailRasterSrc, mailContentProblem, SCHEDI_EMAIL_MARK } from "../workers/schedi-email-worker/src/booking-mail.js";
import { handleLogoGet } from "../workers/schedi-email-worker/src/logo-upload.js";

const root = new URL("..", import.meta.url);
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const bookingHtml = readFileSync(new URL("../site/booking.html", import.meta.url), "utf8");
const png = readFileSync(new URL("../site/assets/homescreen-icon.png", import.meta.url));
const emailWrangler = readFileSync(new URL("../workers/schedi-email-worker/wrangler.toml", import.meta.url), "utf8");
const webWrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

const TINY_PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
));
const TINY_SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>');

function extractFunction(source: string, name: string, from = 0): string {
  const start = source.indexOf("function " + name, from);
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

function pageRaster(source: string, from = 0) {
  const body = extractFunction(source, "emailRasterSrc", from);
  return new Function(`${body}; return emailRasterSrc;`)() as (raw: string) => string;
}

function memoryBucket(files: Record<string, { bytes: Uint8Array; type: string }>) {
  return {
    async get(key: string) {
      const hit = files[key];
      return hit ? { body: hit.bytes, httpMetadata: { contentType: hit.type } } : null;
    },
  };
}

describe("booking request email images", () => {
  it("uses the public Schedi PNG and a raster business logo", () => {
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(SCHEDI_EMAIL_MARK).toBe("https://schedi.app/assets/homescreen-icon.png");
    for (const source of [indexHtml, bookingHtml]) {
      expect(source).toContain(SCHEDI_EMAIL_MARK);
      expect(source).not.toContain("email-calendar-check.png");
      expect(source).not.toContain("email-calendar-reschedule.png");
      expect(source).not.toContain("email-calendar-declined.png");
      expect(source).toContain("var bizLogo = emailRasterSrc(");
      expect(source).toContain("var markUrl = bizLogo || schediMark");
      expect(source).toContain('\'<img src="\' + schediMark + \'" width="16"');
      expect(source).toContain('\'<img src="\' + markUrl + \'" width="72"');
    }
    const portal = pageRaster(indexHtml);
    const standalone = pageRaster(bookingHtml);
    const logo = "https://schedi.app/logos/bright-cuts?v=abc123abc123abc123";
    const raster = "https://schedi.app/logos/bright-cuts/email.png?v=abc123abc123abc123";
    for (const fn of [emailRasterSrc, portal, standalone]) {
      expect(fn(SCHEDI_EMAIL_MARK)).toBe(SCHEDI_EMAIL_MARK);
      expect(fn("https://www.schedi.app/assets/homescreen-icon.png")).toBe(SCHEDI_EMAIL_MARK);
      expect(fn(logo)).toBe(raster);
      expect(fn(raster)).toBe(raster);
      expect(fn("https://schedi.app/assets/logo-dark.svg")).toBe("");
      expect(fn("data:image/png;base64,aaaa")).toBe("");
      expect(fn("https://firebasestorage.googleapis.com/v0/b/x/o/logo.png")).toBe("");
      expect(fn("/assets/homescreen-icon.png")).toBe("");
      expect(fn("https://evil.example/assets/homescreen-icon.png")).toBe("");
    }
  });

  it("lets the request email through the mail allowlist only for those raster URLs", () => {
    const logo = "https://schedi.app/logos/bright-cuts/email.png?v=abc123abc123abc123";
    const html = '<!DOCTYPE html><html><body><img src="' + logo + '" width="72" height="72" alt="">'
      + '<img src="' + SCHEDI_EMAIL_MARK + '" width="16" height="16" alt="">Schedi</body></html>';
    expect(mailContentProblem(html, "Request sent https://schedi.app/bright-cuts/", { paymentLinks: new Set() })).toBe("");
    expect(mailContentProblem(
      '<!DOCTYPE html><html><body><img src="https://schedi.app/assets/email-calendar-check.png"></body></html>',
      "",
      { paymentLinks: new Set() },
    )).toBe("");
    expect(mailContentProblem(
      '<!DOCTYPE html><html><body><img src="https://schedi.app/assets/logo-dark.svg"></body></html>',
      "",
      { paymentLinks: new Set() },
    )).toBe("image_not_allowed");
    expect(mailContentProblem(
      '<!DOCTYPE html><html><body><img src="data:image/png;base64,aaaa"></body></html>',
      "",
      { paymentLinks: new Set() },
    )).toBe("bad_scheme");
    expect(mailContentProblem(
      '<!DOCTYPE html><html><body><img src="' + logo.replace("/email.png", "") + '"></body></html>',
      "",
      { paymentLinks: new Set() },
    )).toBe("image_not_allowed");
  });

  it("serves the Schedi PNG with no auth, and does not let the route split or CSP turn it into HTML", async () => {
    expect(emailWrangler).not.toContain("schedi.app/assets");
    expect(emailWrangler).not.toContain("schedi.app/logos");
    expect(webWrangler).toContain("schedi.app/*");
    expect(contentSecurityPolicy(true)).toContain("img-src 'self' data: blob: https:");

    const assets: SchediEnv["ASSETS"] = {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        if (path === "/assets/homescreen-icon.png") {
          return new Response(png, { headers: { "content-type": "image/png" } });
        }
        if (path === "/booking.html" || path === "/index.html") {
          return new Response("<!DOCTYPE html><html><body>booking</body></html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
      },
    };
    const env = { FIREBASE_PROJECT_ID: "", ASSETS: assets };
    const ctx = { waitUntil() {} };
    const image = await handleRequest(new Request(SCHEDI_EMAIL_MARK), env, ctx);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("www-authenticate")).toBeNull();
    expect(image.headers.get("content-security-policy")).toBeNull();
    expect(new Uint8Array(await image.arrayBuffer()).subarray(0, 4)).toEqual(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));

    const missing = await handleRequest(new Request("https://schedi.app/assets/email-calendar-check.png"), env, ctx);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("text/plain");
    expect(await missing.text()).not.toContain("<html");
  });

  it("serves a business logo for email as png or jpeg, and refuses SVG", async () => {
    const pngEnv = {
      LOGO_BUCKET: memoryBucket({
        "logos/bright-cuts.png": { bytes: TINY_PNG, type: "image/png" },
      }),
    };
    const pngRes = await handleLogoGet(new Request("https://schedi.app/logos/bright-cuts/email.png?v=abc123abc123abc123"), pngEnv);
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get("content-type")).toBe("image/png");
    expect(pngRes.headers.get("www-authenticate")).toBeNull();
    expect(pngRes.headers.get("content-security-policy")).toBeNull();
    expect(new Uint8Array(await pngRes.arrayBuffer())).toEqual(TINY_PNG);

    const viaWeb = await handleRequest(
      new Request("https://schedi.app/logos/bright-cuts/email.png?v=abc123abc123abc123"),
      pngEnv,
      { waitUntil() {} },
    );
    expect(viaWeb.status).toBe(200);
    expect(viaWeb.headers.get("content-type")).toBe("image/png");
    expect(viaWeb.headers.get("content-security-policy")).toBeNull();

    const svgEnv = {
      LOGO_BUCKET: memoryBucket({
        "logos/bright-cuts.svg": { bytes: TINY_SVG, type: "image/svg+xml" },
      }),
    };
    const svgPage = await handleLogoGet(new Request("https://schedi.app/logos/bright-cuts"), svgEnv);
    expect(svgPage.status).toBe(200);
    expect(svgPage.headers.get("content-type")).toContain("image/svg+xml");
    expect(svgPage.headers.get("content-security-policy")).toContain("sandbox");
    const svgMail = await handleLogoGet(new Request("https://schedi.app/logos/bright-cuts/email.png"), svgEnv);
    expect(svgMail.status).toBe(404);
    expect(svgMail.headers.get("content-type")).toContain("text/plain");
    expect(await svgMail.text()).not.toContain("<svg");
  });
});
