import { describe, expect, it, vi, afterEach } from "vitest";
import { MARKETING_PAGES, publicPaths } from "../worker/content";
import { handleRequest, type SchediEnv } from "../worker/handler";
import { localBusinessJsonLd } from "../worker/local-business";
import { assertJsonLdDocuments } from "../worker/jsonld-check";
import { indexNowPayload, submitIndexNow } from "../worker/indexnow";
import { renderLlms, renderMarketingPage, renderRobots, renderSitemap } from "../worker/render";

const SHELL = "<!DOCTYPE html><html><head><title>Schedi</title></head><body>app</body></html>";
const HELD = "Connect your Square account";

function ctx() {
  return { waitUntil() {} };
}

function envWith(assets?: SchediEnv["ASSETS"], extra: Partial<SchediEnv> = {}): SchediEnv {
  return { FIREBASE_PROJECT_ID: "siteforge-97699", ASSETS: assets, ...extra };
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

function visible(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("answer pages and crawler files", () => {
  it("keeps held-for-later copy out of HTML, llms.txt, and JSON-LD", () => {
    const llms = renderLlms();
    expect(llms).not.toContain("Held for later");
    expect(llms).not.toContain("not for publishing");
    expect(llms).not.toContain(HELD);
    expect(llms).not.toContain("Square");
    expect(llms.toLowerCase()).not.toContain("text message");
    expect(llms).not.toContain("SMS");
    for (const page of MARKETING_PAGES) {
      const html = renderMarketingPage(page);
      expect(html, page.path).not.toContain("Held for later");
      expect(html, page.path).not.toContain(HELD);
      expect(html, page.path).not.toContain("[CONFIRM]");
      expect(html, page.path).not.toContain("Does Schedi work with Square");
      expect(html, page.path).not.toContain("Does Schedi send text message");
      expect(html, page.path).not.toContain("add-to-calendar");
      expect(html, page.path).not.toContain("not for publishing");
      if (html.includes("application/ld+json")) {
        expect(assertJsonLdDocuments(html), page.path).toEqual([]);
      }
    }
  });

  it("publishes one compare hub and the answer pages", () => {
    const paths = publicPaths();
    expect(paths).toContain("/compare");
    expect(paths).toContain("/features");
    expect(paths).toContain("/for/barbers");
    expect(paths).toContain("/for/cleaning-services");
    expect(paths).not.toContain("/compare/booksy");
    expect(paths).not.toContain("/for/salons");
    expect(paths.some((path) => path.includes("square"))).toBe(false);

    const xml = renderSitemap();
    expect(xml).toContain("https://schedi.app/compare");
    expect(xml).toContain("https://schedi.app/features");
    expect(xml).toContain("https://schedi.app/for/barbers");
    expect(xml).toContain("https://schedi.app/for/cleaning-services");
    expect(xml).toContain("https://schedi.app/pricing");
    expect(xml).toContain("https://schedi.app/help");
    expect(xml).not.toContain("/compare/booksy");
    expect(xml).not.toContain("square-appointments");
    expect(xml).not.toContain("/for/salons");

    const robots = renderRobots();
    for (const agent of ["*", "GPTBot", "PerplexityBot", "ClaudeBot", "Google-Extended", "Bingbot"]) {
      expect(robots).toContain(`User-agent: ${agent}`);
    }
    expect(robots.match(/Disallow: \/portal/g)?.length).toBe(6);
    expect(robots.match(/Disallow: \/api/g)?.length).toBe(6);
    expect(robots).toContain("Sitemap: https://schedi.app/sitemap.xml");

    const llms = renderLlms();
    expect(llms).toContain("$0");
    expect(llms).toContain("$29");
    expect(llms).toContain("$49");
    expect(llms).toContain("admin@schedi.app");
    expect(llms).toContain("15 days");
    expect(llms).toContain("https://schedi.app/compare");
    expect(llms).toContain("https://schedi.app/for/barbers");
    expect(llms).toContain("https://schedi.app/for/cleaning-services");
  });

  it("keeps cited competitor prices and omits unconfirmed Schedi claims", () => {
    const compare = renderMarketingPage(MARKETING_PAGES.find((page) => page.path === "/compare")!);
    const text = visible(compare);
    expect(text).toContain("Prices as of Oct 2026");
    expect(text).toContain("https://getsquire.com/pricing");
    expect(text).toContain("$30 a month");
    expect(text).toContain("$50 a month");
    expect(text).toContain("$150 a month");
    expect(text).toContain("$250 a month");
    expect(text).toContain("https://biz.booksy.com/en-us/pricing");
    expect(text).toContain("$29.99 a month");
    expect(text).toContain("2.69% + $0.30");
    expect(text).toContain("2.49% + $0.10");
    expect(text).toContain("2.49% + $0.20");
    expect(text).toContain("https://www.vagaro.com/pro/pricing");
    expect(text).toContain("$30.00 a month");
    expect(text).toContain("$23.99 a month");
    expect(text).toContain("https://acuityscheduling.com/pricing");
    expect(text).toContain("$16 / $20");
    expect(text).toContain("$27 / $34");
    expect(text).toContain("$55 / $69");
    expect(text).toContain("https://www.getjobber.com/pricing/");
    expect(text).toContain("$49 a month with no commitment");
    expect(text).toContain("$139 / $119 / $99");
    expect(text).toContain("$199 / $169 / $149");
    expect(text).toContain('id="squire"');
    expect(text).toContain('id="booksy"');
    expect(text).toContain('id="vagaro"');
    expect(text).toContain('id="acuity"');
    expect(text).toContain('id="jobber"');
    expect(compare).not.toContain("card deposit");
    expect(compare).not.toContain("Schedi works with Square");
    expect(compare).toContain('"unitCode":"MON"');

    for (const path of ["/for/barbers", "/for/cleaning-services", "/features"]) {
      const html = renderMarketingPage(MARKETING_PAGES.find((page) => page.path === path)!);
      const body = visible(html);
      expect(body, path).toContain("$0");
      expect(body, path).toContain("$29");
      expect(body, path).toContain("$49");
      expect(html, path).not.toContain("card deposit");
      expect(html, path).not.toContain("service address");
    }
    const cleaning = visible(renderMarketingPage(MARKETING_PAGES.find((page) => page.path === "/for/cleaning-services")!));
    expect(cleaning).toContain("Schedi does not calculate drive time");
    expect(cleaning).toContain("does not manage multiple cleaners or crews");
  });

  it("serves llms.txt, robots, and the compare page without JavaScript", async () => {
    const env = envWith(shellAssets());
    const llms = await handleRequest(new Request("https://schedi.app/llms.txt"), env, ctx());
    expect(llms.status).toBe(200);
    expect(llms.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await llms.text()).toContain("Free: $0");

    const compare = await handleRequest(new Request("https://schedi.app/compare"), env, ctx());
    expect(compare.status).toBe(200);
    const html = await compare.text();
    expect(html).toContain("<h1>Schedi vs other booking tools</h1>");
    expect(html).toContain('rel="canonical" href="https://schedi.app/compare"');
    expect(html).toContain("static.cloudflareinsights.com/beacon.min.js");
    expect(html).not.toContain("msvalidate.01");
  });

  it("adds the Bing meta tag only when the token is set", async () => {
    const off = await handleRequest(new Request("https://schedi.app/pricing"), envWith(shellAssets()), ctx());
    expect(await off.text()).not.toContain("msvalidate.01");
    const on = await handleRequest(
      new Request("https://schedi.app/pricing"),
      envWith(shellAssets(), { BING_SITE_VERIFICATION: "ABCDEF1234567890" }),
      ctx(),
    );
    expect(await on.text()).toContain('<meta name="msvalidate.01" content="ABCDEF1234567890">');
  });
});

describe("canonical redirects", () => {
  it("sends duplicates to one canonical URL and keeps preview hosts", async () => {
    const env = envWith(shellAssets());
    const cases: [string, number, string | null][] = [
      ["https://www.schedi.app/pricing?from=home", 301, "https://schedi.app/pricing"],
      ["https://www.schedi.app/pricing/?utm=newsletter", 301, "https://schedi.app/pricing"],
      ["https://schedi.app/pricing/", 301, "https://schedi.app/pricing"],
      ["https://schedi.app/pricing?utm_source=ad", 301, "https://schedi.app/pricing"],
      ["https://schedi.app/index.html", 301, "https://schedi.app/"],
      ["https://schedi.app/index.html?utm=1", 301, "https://schedi.app/"],
      ["http://schedi.app/pricing", 301, "https://schedi.app/pricing"],
      ["https://www.schedi.app/?portal=login", 301, "https://schedi.app/?portal=login"],
      ["https://schedi-web-preview.example.workers.dev/pricing/", 301, "https://schedi-web-preview.example.workers.dev/pricing"],
      ["https://schedi-web-preview.example.workers.dev/pricing?utm=1", 301, "https://schedi-web-preview.example.workers.dev/pricing"],
      ["https://schedi.app//pricing", 301, "https://schedi.app/pricing"],
      ["https://schedi.app/faq", 301, "https://schedi.app/help"],
      ["https://schedi.app/faq/", 301, "https://schedi.app/help"],
      ["https://schedi.app/faq?utm_source=ad&demo=1", 301, "https://schedi.app/help?demo=1"],
      ["https://schedi.app/bright-cuts?utm_source=ad&gclid=1", 301, "https://schedi.app/bright-cuts"],
      ["https://schedi.app/bright-cuts?utm_campaign=spring&demo=1", 301, "https://schedi.app/bright-cuts?demo=1"],
      ["https://schedi.app/llms.txt?fbclid=abc&ref=ig", 301, "https://schedi.app/llms.txt"],
    ];
    for (const [input, status, location] of cases) {
      const response = await handleRequest(new Request(input), env, ctx());
      expect(response.status, input).toBe(status);
      expect(response.headers.get("location"), input).toBe(location);
    }

    const demo = await handleRequest(new Request("https://schedi.app/pricing?demo=1"), env, ctx());
    expect(demo.status).toBe(200);
    const demoHtml = await demo.text();
    expect(demoHtml).toContain('rel="canonical" href="https://schedi.app/pricing"');
    expect(demoHtml).not.toContain("beacon.min.js");

    const preview = await handleRequest(
      new Request("https://schedi-web-preview.example.workers.dev/pricing"),
      env,
      ctx(),
    );
    expect(preview.status).toBe(200);
    const previewHtml = await preview.text();
    expect(previewHtml).toContain('rel="canonical" href="https://schedi.app/pricing"');
    expect(preview.headers.get("location")).toBeNull();

    const login = await handleRequest(new Request("https://schedi.app/?portal=login"), env, ctx());
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("https://schedi.app/login");

    const upper = await handleRequest(new Request("https://schedi.app/LOGIN"), env, ctx());
    expect(upper.status).toBe(200);

    const tenantDemo = await handleRequest(
      new Request("https://schedi.app/bright-cuts?demo=1"),
      envWith(shellAssets(), { FIREBASE_PROJECT_ID: "" }),
      ctx(),
    );
    expect(tenantDemo.status).toBe(200);
  });
});

describe("copy corrections", () => {
  it("does not present card checkout or deposits as available today", () => {
    const banned = [
      "Card checkout and card deposits are Pro settings",
      "Pro can turn on card checkout",
      "Pro can also turn on Credit",
      "Pro adds card checkout",
      "On Pro you can require a card deposit",
      "On Pro, a card deposit can be required",
      "with card payments and deposits",
      "Card checkout is not offered",
      "Take cards and deposits",
      "cards on Pro",
      "small team",
    ];
    for (const page of MARKETING_PAGES) {
      const html = renderMarketingPage(page);
      for (const phrase of banned) {
        expect(html, `${page.path} ${phrase}`).not.toContain(phrase);
      }
    }
    const help = renderMarketingPage(MARKETING_PAGES.find((page) => page.path === "/help")!);
    expect(help).toContain("Starter doesn't include card checkout.");
    const pricing = visible(renderMarketingPage(MARKETING_PAGES.find((page) => page.path === "/pricing")!));
    const refundAt = pricing.indexOf("Is there a contract, and what are the cancellation and refund terms?");
    const refund = pricing.slice(refundAt, pricing.indexOf("</p>", refundAt));
    expect(refund.match(/month-to-month/g)?.length).toBe(1);
    expect(pricing).toContain("admin@schedi.app");
    const footer = renderMarketingPage(MARKETING_PAGES[0]);
    expect(footer).toContain("run by one owner");
  });

  it("links competitor sources with nofollow", () => {
    const compare = renderMarketingPage(MARKETING_PAGES.find((page) => page.path === "/compare")!);
    for (const href of [
      "https://getsquire.com/pricing",
      "https://biz.booksy.com/en-us/pricing",
      "https://www.vagaro.com/pro/pricing",
      "https://acuityscheduling.com/pricing",
      "https://www.getjobber.com/pricing/",
    ]) {
      expect(compare).toContain(`<a href="${href}" rel="nofollow noopener noreferrer">`);
    }
  });
});

describe("IndexNow", () => {
  it("does not call fetch unless production gating passes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await submitIndexNow({ INDEXNOW_ENABLED: "false", INDEXNOW_HOST: "schedi.app", INDEXNOW_KEY: "a".repeat(32) }, ["https://schedi.app/"])).toEqual({
      submitted: false,
      reason: "disabled",
    });
    expect(await submitIndexNow({ INDEXNOW_ENABLED: "true", INDEXNOW_HOST: "schedi-web-preview.workers.dev", INDEXNOW_KEY: "ab".repeat(16) }, ["https://schedi.app/"])).toEqual({
      submitted: false,
      reason: "host",
    });
    expect(await submitIndexNow({ INDEXNOW_ENABLED: "true", INDEXNOW_HOST: "schedi.app", INDEXNOW_KEY: "short" }, ["https://schedi.app/"])).toEqual({
      submitted: false,
      reason: "key",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the sitemap payload when the gate is open", async () => {
    const key = "ab".repeat(16);
    const urls = ["https://schedi.app/", "https://schedi.app/pricing"];
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await submitIndexNow({ INDEXNOW_ENABLED: "true", INDEXNOW_HOST: "schedi.app", INDEXNOW_KEY: key }, urls);
    expect(result).toEqual({ submitted: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe("https://api.indexnow.org/indexnow");
    expect(JSON.parse(String(init.body))).toEqual(indexNowPayload(key, urls));
  });

  it("serves the key file only when a valid key is configured", async () => {
    const key = "cd".repeat(32);
    const missing = await handleRequest(new Request(`https://schedi.app/${key}.txt`), envWith(shellAssets()), ctx());
    expect(missing.status).toBe(404);

    const present = await handleRequest(
      new Request(`https://schedi.app/${key}.txt`),
      envWith(shellAssets(), { INDEXNOW_KEY: key }),
      ctx(),
    );
    expect(present.status).toBe(200);
    expect(await present.text()).toBe(key);
    const robots = renderRobots();
    expect(robots).not.toContain(key);
  });
});

describe("LocalBusiness JSON-LD", () => {
  it("includes address and price only when the tenant has them", () => {
    const bare = localBusinessJsonLd(
      { name: "Bright Cuts", industry: "Barber", slug: "bright-cuts", seoPublic: true, services: [{ name: "Haircut" }] },
      "https://schedi.app/bright-cuts",
    );
    expect(JSON.stringify(bare)).not.toContain("streetAddress");
    expect(JSON.stringify(bare)).not.toContain("addressLocality");
    expect(JSON.stringify(bare)).not.toContain("price");
    expect(JSON.stringify(bare)).not.toContain("telephone");

    const full = localBusinessJsonLd(
      {
        name: "Bright Cuts",
        industry: "Barber",
        slug: "bright-cuts",
        seoPublic: true,
        streetAddress: "10 Main St",
        city: "Austin",
        region: "TX",
        services: [{ name: "Haircut", price: 35 }, { name: "Free consult", price: 0 }],
      },
      "https://schedi.app/bright-cuts",
    );
    expect(full.address).toMatchObject({ streetAddress: "10 Main St", addressLocality: "Austin", addressRegion: "TX" });
    expect(JSON.stringify(full)).toContain('"price":"35"');
    expect(JSON.stringify(full)).toContain('"price":"0"');
    expect(assertJsonLdDocuments(`<script type="application/ld+json">${JSON.stringify(full)}</script>`)).toEqual([]);
  });

  it("reads address and services from Firestore without the owner email", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const target = String(input);
      expect(target).toContain("mask.fieldPaths=services");
      expect(target).toContain("mask.fieldPaths=address");
      expect(target).not.toContain("ownerEmail");
      return new Response(
        JSON.stringify({
          fields: {
            name: { stringValue: "Bright Cuts" },
            industry: { stringValue: "Barber" },
            slug: { stringValue: "bright-cuts" },
            seoPublic: { booleanValue: true },
            address: { stringValue: "10 Main St" },
            city: { stringValue: "Austin" },
            services: {
              arrayValue: {
                values: [
                  {
                    mapValue: {
                      fields: {
                        name: { stringValue: "Haircut" },
                        price: { integerValue: "35" },
                      },
                    },
                  },
                ],
              },
            },
            ownerEmail: { stringValue: "hidden@example.com" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleRequest(new Request("https://schedi.app/bright-cuts"), envWith(shellAssets()), ctx());
    const html = await response.text();
    expect(html).toContain("Book an appointment with Bright Cuts. Barber appointments with live online scheduling.");
    expect(html).not.toContain("instant confirmation");
    expect(html).not.toContain("Services services");
    expect(html).toContain('"streetAddress":"10 Main St"');
    expect(html).toContain('"addressLocality":"Austin"');
    expect(html).toContain('"price":"35"');
    expect(html).not.toContain("hidden@example.com");
    expect(html).toContain('rel="canonical" href="https://schedi.app/bright-cuts"');
  });
});
