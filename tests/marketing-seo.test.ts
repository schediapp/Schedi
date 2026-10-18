import { describe, expect, it, vi, afterEach } from "vitest";
import { MARKETING_PAGES, escapeHtml, publicPaths } from "../worker/content";
import { handleRequest, tenantFromFirestore, type SchediEnv } from "../worker/handler";
import { copyWordCount, renderMarketingPage, renderSitemap } from "../worker/render";

const SHELL = "<!DOCTYPE html><html><head><title>Schedi</title></head><body>app</body></html>";

function ctx() {
  return { waitUntil() {} };
}

function envWith(assets?: SchediEnv["ASSETS"]): SchediEnv {
  return {
    FIREBASE_PROJECT_ID: "siteforge-97699",
    ASSETS: assets,
  };
}

function shellAssets(): SchediEnv["ASSETS"] {
  return {
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      if (path === "/index.html") {
        return new Response(SHELL, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public marketing routes", () => {
  it("lists every public route in the sitemap once", () => {
    const xml = renderSitemap();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    const opens = xml.match(/<url>/g) ?? [];
    const closes = xml.match(/<\/url>/g) ?? [];
    expect(opens.length).toBe(closes.length);
    expect(opens.length).toBe(publicPaths().length);
    for (const path of publicPaths()) {
      const loc = path === "/" ? "https://schedi.app/" : `https://schedi.app${path}`;
      expect(xml).toContain(`<loc>${loc}</loc>`);
    }
    expect(xml).not.toMatch(/\/portal/);
    expect(xml).not.toMatch(/\/admin/);
    expect(xml).not.toMatch(/\/billing/);
    expect(xml).not.toMatch(/\/api[/<]/);
    expect(new Set(publicPaths()).size).toBe(publicPaths().length);
  });

  it.each(MARKETING_PAGES.map((page) => [page.path, page] as const))(
    "%s returns HTML with its title, H1, and canonical",
    async (path, page) => {
      const response = await handleRequest(new Request(`https://schedi.app${path}`), envWith(shellAssets()), ctx());
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/text\/html/);
      const html = await response.text();
      expect(page.title.length).toBeLessThan(60);
      expect(page.description.length).toBeLessThan(155);
      expect(html).toContain(`<title>${escapeHtml(page.title)}</title>`);
      expect(html.match(/<h1\b/g)?.length).toBe(1);
      expect(html).toContain(`<h1>${page.h1}</h1>`);
      const canonical = path === "/" ? "https://schedi.app/" : `https://schedi.app${path}`;
      expect(html).toContain(`<link rel="canonical" href="${canonical}">`);
      const description = escapeHtml(page.description);
      const title = escapeHtml(page.title);
      expect(html).toContain(`<meta name="description" content="${description}">`);
      expect(html).toContain(`<meta property="og:title" content="${title}">`);
      expect(html).toContain(`<meta property="og:url" content="${canonical}">`);
      expect(html).toContain(`<meta name="twitter:title" content="${title}">`);
      expect(html).toContain(`<meta name="twitter:description" content="${description}">`);
      expect(html).toContain('name="robots" content="index, follow"');
      expect(html).toContain('aria-label="Schedi for"');
      expect(html).toContain('rel="preload"');
      expect(html).toContain("as=\"style\"");
      for (const image of html.match(/<img\b[^>]*>/g) ?? []) {
        expect(image).toMatch(/\balt="/);
        if (!image.includes('class="hero"')) expect(image).toContain('loading="lazy"');
      }
      for (const video of html.match(/<video\b[^>]*>/g) ?? []) {
        expect(video).toContain('preload="none"');
      }
      if (page.path.startsWith("/for/")) {
        const words = copyWordCount(html);
        expect(words).toBeGreaterThanOrEqual(300);
        expect(words).toBeLessThanOrEqual(500);
        expect(html).toContain('href="/pricing"');
        expect(html).toContain('href="/"');
        expect(html).toContain('href="/signup"');
        expect(html).toContain('"@type":"FAQPage"');
      }
      if (page.faqs.length) expect(html).toContain('"@type":"FAQPage"');
      if (page.softwareJsonLd) {
        expect(html).toContain('"@type":"SoftwareApplication"');
        expect(html).toContain('"@type":"Organization"');
        expect(html).toContain('"price":"0"');
        expect(html).toContain('"price":"29"');
        expect(html).toContain('"price":"49"');
      }
    },
  );
});

describe("crawler files and app routes", () => {
  it("serves robots.txt with the sitemap and private disallows", async () => {
    const response = await handleRequest(new Request("https://schedi.app/robots.txt"), envWith(shellAssets()), ctx());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/plain/);
    const text = await response.text();
    expect(text).toContain("Sitemap: https://schedi.app/sitemap.xml");
    expect(text).toContain("Disallow: /portal");
    expect(text).toContain("Disallow: /admin");
    expect(text).toContain("Disallow: /billing");
    expect(text).toContain("Disallow: /api");
    expect(text).not.toContain("<title>");
  });

  it("serves sitemap.xml as xml that lists the public routes", async () => {
    const response = await handleRequest(new Request("https://schedi.app/sitemap.xml"), envWith(shellAssets()), ctx());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/xml/);
    const xml = await response.text();
    expect(xml.match(/<url>/g)?.length).toBe(publicPaths().length);
    expect(xml).toContain("https://schedi.app/for/barbers");
  });

  it("returns a real 404 for unknown marketing paths", async () => {
    for (const path of ["/for/plumbers", "/for", "/pricing/extra", "/terms/extra", "/this-is-not-a-page/extra"]) {
      const response = await handleRequest(new Request(`https://schedi.app${path}`), envWith(shellAssets()), ctx());
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type")).toMatch(/text\/html/);
      const html = await response.text();
      expect(html).toContain("<h1>Page not found</h1>");
      expect(html).toContain("noindex");
    }
  });

  it("serves /portal/help on the app with noindex and keeps the owner query", async () => {
    const shell = "<!DOCTYPE html><html><head><title>Schedi</title></head><body>app<script>name=\"robots\"</script></body></html>";
    const assets: SchediEnv["ASSETS"] = {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        if (path === "/index.html") return new Response(shell, { headers: { "content-type": "text/html; charset=utf-8" } });
        return new Response("missing", { status: 404 });
      },
    };
    const query = "demo=1&portal=preview&dash=hours&biz=harbor-demo&tenant=harbor";
    for (const path of ["/portal/help", "/portal/help/", "/portal", "/portal/hours"]) {
      const response = await handleRequest(new Request(`https://schedi.app${path}?${query}`), envWith(assets), ctx());
      expect(response.status, path).toBe(200);
      expect(response.headers.get("location"), path).toBeNull();
      expect(response.headers.get("x-robots-tag"), path).toContain("noindex");
      const html = await response.text();
      expect(html, path).toContain("<title>Schedi</title>");
      expect(html, path).toContain('content="noindex, follow"');
      expect(html.slice(0, html.indexOf("</head>")), path).toContain('name="robots"');
    }
    const marketing = await handleRequest(
      new Request(`https://schedi.app/help?${query}`),
      envWith(assets),
      ctx(),
    );
    expect(marketing.status).toBe(200);
    expect(marketing.headers.get("location")).toBeNull();
    const helpHtml = await marketing.text();
    expect(helpHtml).toContain("Schedi help | Business portal steps");
    expect(helpHtml).not.toContain("Back to portal");
  });

  it("keeps SPA deep links and sends noindex on non-public app routes", async () => {
    const env = envWith(shellAssets());
    env.FIREBASE_PROJECT_ID = "";
    for (const path of ["/signup", "/help/booking", "/reset", "/portal", "/admin", "/bright-cuts", "/bright-cuts/manage/token"]) {
      const response = await handleRequest(new Request(`https://schedi.app${path}`), env, ctx());
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html).toContain("app");
      expect(html).toContain('content="noindex, follow"');
      expect(response.headers.get("x-robots-tag")).toContain("noindex");
    }
  });

  it("redirects /?portal=login to /login and keeps other params", async () => {
    const response = await handleRequest(new Request("https://schedi.app/?portal=login&forgot=1"), envWith(shellAssets()), ctx());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://schedi.app/login?forgot=1");
  });

  it("opens the business portal shell for /login", async () => {
    for (const path of ["/login", "/login/", "/LOGIN"]) {
      const response = await handleRequest(new Request("https://schedi.app" + path), envWith(shellAssets()), ctx());
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("<title>Schedi</title>");
      expect(html).not.toContain("Clients book on your page");
    }
  });

  it("marketing Log in links point to /login", () => {
    for (const page of MARKETING_PAGES) {
      const html = renderMarketingPage(page);
      expect(html).not.toContain("portal=login");
      expect(html).toContain('href="/login"');
    }
  });

  it("redirects www to the apex and keeps the path", async () => {
    const response = await handleRequest(
      new Request("https://www.schedi.app/pricing?from=home"),
      envWith(shellAssets()),
      ctx(),
    );
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://schedi.app/pricing?from=home");
  });

  it("does not HTML-fallback API routes", async () => {
    const response = await handleRequest(
      new Request("https://schedi.app/api/send-booking-email"),
      envWith(shellAssets()),
      ctx(),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    const body = await response.json();
    expect(body).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses an HTML fallback for a missing favicon", async () => {
    const response = await handleRequest(new Request("https://schedi.app/favicon.ico"), envWith(shellAssets()), ctx());
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/image\/x-icon/);
    expect(await response.text()).not.toContain("<title>");
  });

  it("returns 304 when a conditional asset request matches the ETag", async () => {
    const etag = '"logo-v1"';
    let forwarded: string | null = null;
    const assets: SchediEnv["ASSETS"] = {
      async fetch(request: Request) {
        forwarded = request.headers.get("if-none-match");
        const path = new URL(request.url).pathname;
        if (path === "/assets/logo-dark.svg" && forwarded === etag) {
          return new Response(null, {
            status: 304,
            statusText: "Not Modified",
            headers: {
              ETag: etag,
              "Cache-Control": "public, max-age=86400",
              "Content-Length": "1200",
              "Content-Type": "image/svg+xml",
            },
          });
        }
        return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
      },
    };
    const response = await handleRequest(
      new Request("https://schedi.app/assets/logo-dark.svg", {
        headers: { "If-None-Match": etag },
      }),
      envWith(assets),
      ctx(),
    );
    expect(forwarded).toBe(etag);
    expect(response.status).toBe(304);
    expect(response.statusText).toBe("Not Modified");
    expect(response.headers.get("etag")).toBe(etag);
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-length")).toBe("1200");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("passes other 3xx asset responses through with security headers", async () => {
    const assets: SchediEnv["ASSETS"] = {
      async fetch() {
        return new Response("moved", {
          status: 301,
          headers: {
            Location: "https://schedi.app/assets/logo-dark.svg",
            "Cache-Control": "public, max-age=3600",
            "Content-Type": "text/plain; charset=utf-8",
          },
        });
      },
    };
    const response = await handleRequest(
      new Request("https://schedi.app/assets/logo.svg"),
      envWith(assets),
      ctx(),
    );
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://schedi.app/assets/logo-dark.svg");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("moved");
  });

  it("indexes a tenant page only when seoPublic is true", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const target = String(input);
      expect(target).toContain("tenants/bright-cuts");
      expect(target).not.toContain("ownerEmail");
      return new Response(
        JSON.stringify({
          fields: {
            name: { stringValue: "Bright Cuts" },
            industry: { stringValue: "Barber" },
            slug: { stringValue: "bright-cuts" },
            seoPublic: { booleanValue: true },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleRequest(new Request("https://schedi.app/bright-cuts"), envWith(shellAssets()), ctx());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Book an Appointment | Bright Cuts</title>");
    expect(html).toContain("https://schedi.app/bright-cuts/");
    expect(html).not.toContain("noindex");
    expect(response.headers.get("x-robots-tag")).toBeNull();
  });

  it("reads seoPublic from a Firestore document and ignores other fields", () => {
    expect(
      tenantFromFirestore({
        fields: {
          name: { stringValue: "Bright Cuts" },
          industry: { stringValue: "Barber" },
          slug: { stringValue: "Bright-Cuts" },
          ownerEmail: { stringValue: "hidden@example.com" },
          seoPublic: { booleanValue: true },
        },
      }),
    ).toEqual({ name: "Bright Cuts", industry: "Barber", slug: "bright-cuts", seoPublic: true });
  });
});

import { renderMarketingTheme, THEME_SCRIPT_PATH } from "../worker/render";
describe("marketing theme toggle", () => {
  it("uses the app's schedi.theme key and never redirects", () => {
    const js = renderMarketingTheme();
    expect(THEME_SCRIPT_PATH).toBe("/marketing-theme.js");
    expect(js).toContain('"schedi.theme"');
    expect(js).not.toMatch(/location|replace\(|href\s*=/);
  });
});

describe("social preview image", () => {
  it("marketing pages use the 1200x630 PNG", () => {
    for (const page of MARKETING_PAGES) {
      const html = renderMarketingPage(page);
      expect(html).toContain('<meta property="og:image" content="https://schedi.app/assets/og/schedi-og.png">');
      expect(html).toContain('<meta name="twitter:image" content="https://schedi.app/assets/og/schedi-og.png">');
      expect(html).toContain('<meta property="og:image:width" content="1200">');
      expect(html).not.toContain('og:image" content="https://schedi.app/assets/marketing/hero.svg');
    }
  });
});
