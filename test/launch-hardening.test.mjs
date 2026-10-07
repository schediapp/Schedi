import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import worker from "../src/index.js";
import {
  applySecurityHeaders,
  bookingSlugFromPath,
  contentSecurityPolicy,
  injectBookingMeta,
  mustNotHtmlFallback,
  tenantFromFirestore,
  toApexUrl,
} from "../src/policy.js";

const root = new URL("..", import.meta.url);
const html = readFileSync(new URL("./public/index.html", root), "utf8");

test("agency defaults no longer point at SiteForge", () => {
  assert.equal(html.includes("client_id_siteforge_paypal_881"), false);
  assert.equal(html.includes("api.siteforge.com"), false);
  assert.match(html, /id="agencyWebhookUrl" value="https:\/\/schedi\.app\/billing\/webhook"/);
  assert.match(html, /id="agencyPaypalId" value=""/);
});

test("booking head is built from real values, not unresolved placeholders", () => {
  assert.equal(html.includes("<title>Book an Appointment | ${safeName}</title>"), false);
  assert.equal(html.includes('content="${metaDesc}"'), false);
  assert.equal(html.includes("https://example.com/"), false);
  assert.match(html, /canonicalUrl = 'https:\/\/schedi\.app\/' \+ esc\(tenant\.slug\)/);
  assert.match(html, /applyPublicBookingDocumentMeta\(tenant\)/);
  assert.match(html, /document\.title = title/);
});

test("inline scripts still parse", () => {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = match[1] || "";
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*"([^"]+)"/i) || [])[1] || "";
    if (type && type !== "module" && !type.includes("javascript")) continue;
    scripts.push(match[2].replace(/\\u003C/g, "\\u003C"));
  }
  assert.ok(scripts.length >= 2);
  const dir = mkdtempSync(join(tmpdir(), "schedi-syntax-"));
  scripts.forEach((source, index) => {
    const file = join(dir, `script-${index}.js`);
    writeFileSync(file, source);
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  });
});

test("crawler files are excluded from the HTML fallback", () => {
  for (const path of ["/robots.txt", "/sitemap.xml", "/favicon.ico", "/manifest.json", "/assets/homescreen-icon.png"]) {
    assert.equal(mustNotHtmlFallback(path), true);
  }
  assert.equal(mustNotHtmlFallback("/signup"), false);
  assert.equal(bookingSlugFromPath("/signup"), null);
  assert.equal(bookingSlugFromPath("/bright-cuts"), "bright-cuts");
  assert.equal(bookingSlugFromPath("/hq-9h7p52"), null);
});

test("www redirects to the apex and keeps the path", () => {
  const dest = toApexUrl(new URL("http://www.schedi.app/signup?plan=pro"));
  assert.equal(dest.toString(), "https://schedi.app/signup?plan=pro");
});

test("booking meta replaces only the document title", () => {
  const source = "<!DOCTYPE html><head><title>Schedi</title><script><title>Schedi</title></script></head>";
  const next = injectBookingMeta(source, {
    name: 'A & B "Cuts"',
    title: 'Book an Appointment | A & B "Cuts"',
    description: "Book an appointment with A & B.",
    canonical: "https://schedi.app/ab-cuts/",
  });
  assert.match(next, /<title>Book an Appointment \| A &amp; B &quot;Cuts&quot;<\/title>/);
  assert.match(next, /<link rel="canonical" href="https:\/\/schedi\.app\/ab-cuts\/">/);
  assert.match(next, /<script><title>Schedi<\/title><\/script>/);
  const headers = new Headers({ "Access-Control-Allow-Origin": "*" });
  applySecurityHeaders(headers, { html: true });
  assert.equal(headers.get("Access-Control-Allow-Origin"), null);
  assert.match(headers.get("Strict-Transport-Security"), /max-age=31536000/);
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.match(headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.match(headers.get("Content-Security-Policy"), /cdn\.tailwindcss\.com/);
});

test("firestore public fields become a title record", () => {
  const tenant = tenantFromFirestore({
    fields: {
      name: { stringValue: "Bright Cuts" },
      industry: { stringValue: "Barber" },
      slug: { stringValue: "Bright-Cuts" },
      ownerEmail: { stringValue: "hidden@example.com" },
    },
  });
  assert.deepEqual(tenant, { name: "Bright Cuts", industry: "Barber", slug: "bright-cuts" });
});

test("Pages _headers sets HSTS and does not open wildcard CORS", () => {
  const headers = readFileSync(new URL("./public/_headers", root), "utf8");
  assert.match(headers, /Strict-Transport-Security: max-age=31536000/);
  assert.doesNotMatch(headers, /Access-Control-Allow-Origin/);
  assert.equal(contentSecurityPolicy().includes("frame-ancestors 'none'"), true);
});

function ctx() {
  return { waitUntil() {} };
}

function envWith(assets) {
  return {
    FIREBASE_PROJECT_ID: "siteforge-97699",
    ASSETS: { fetch: assets },
  };
}

test("worker serves robots.txt instead of the SPA shell", async () => {
  const env = envWith(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/robots.txt") {
      return new Response("User-agent: *\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return new Response("<title>Schedi</title>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
  const res = await worker.fetch(new Request("https://schedi.app/robots.txt"), env, ctx());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  assert.equal(await res.text(), "User-agent: *\n");
  assert.match(res.headers.get("strict-transport-security"), /max-age=31536000/);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("worker refuses an HTML fallback for favicon and manifest", async () => {
  const env = envWith(async () => new Response("<title>Schedi</title>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  }));
  for (const [path, type] of [["/favicon.ico", "image/x-icon"], ["/manifest.json", "application/json"], ["/sitemap.xml", "application/xml"]]) {
    const res = await worker.fetch(new Request(`https://schedi.app${path}`), env, ctx());
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get("content-type"), new RegExp(type.replace("/", "\\/")));
    assert.doesNotMatch(await res.text(), /<title>/);
  }
});

test("worker redirects www to the apex", async () => {
  let fetched = false;
  const env = envWith(async () => {
    fetched = true;
    return new Response("no");
  });
  const res = await worker.fetch(new Request("https://www.schedi.app/help?from=home"), env, ctx());
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "https://schedi.app/help?from=home");
  assert.equal(fetched, false);
  assert.match(res.headers.get("strict-transport-security"), /max-age=31536000/);
});

test("worker injects the public booking title for crawlers", async () => {
  const shell = "<!DOCTYPE html><head><title>Schedi</title></head><body>app</body>";
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const target = String(input);
    assert.match(target, /tenants\/bright-cuts/);
    assert.doesNotMatch(target, /ownerEmail/);
    return new Response(JSON.stringify({
      fields: {
        name: { stringValue: "Bright Cuts" },
        industry: { stringValue: "Barber" },
        slug: { stringValue: "bright-cuts" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const env = envWith(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/index.html") {
        return new Response(shell, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    });
    const res = await worker.fetch(new Request("https://schedi.app/bright-cuts"), env, ctx());
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<title>Book an Appointment \| Bright Cuts<\/title>/);
    assert.match(body, /Book an appointment with Bright Cuts\. Barber services/);
    assert.match(body, /https:\/\/schedi\.app\/bright-cuts\//);
    assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    globalThis.fetch = previous;
  }
});

test("worker does not HTML-fallback API routes", async () => {
  const env = envWith(async () => new Response("missing", { status: 404 }));
  const res = await worker.fetch(new Request("https://schedi.app/api/send-booking-email"), env, ctx());
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /application\/json/);
  const body = await res.json();
  assert.equal(body.error, "not_found");
  assert.equal(body.features, undefined);
});
