import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleRequest, contentSecurityPolicy, marketingContentSecurityPolicy, type SchediEnv } from "../worker/handler";
import {
  PREVIEW_ANALYTICS_HOST,
  WEB_ANALYTICS_CONNECT_ORIGIN,
  WEB_ANALYTICS_SCRIPT_ORIGIN,
  WEB_ANALYTICS_SNIPPET,
  WEB_ANALYTICS_TOKEN,
} from "../worker/web-analytics";

const SHELL = "<!DOCTYPE html><html><head><title>Schedi</title></head><body>app</body></html>";
const PUBLIC_HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const HQ_HTML = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
const HEADERS = readFileSync(new URL("../site/_headers", import.meta.url), "utf8");

function ctx() {
  return { waitUntil() {} };
}

function assets(indexBody: string, hqBody = HQ_HTML): SchediEnv["ASSETS"] {
  return {
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      if (path === "/index.html") {
        return new Response(indexBody, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (path === "/hq.html") {
        return new Response(hqBody, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    },
  };
}

function env(indexBody = SHELL): SchediEnv {
  return { FIREBASE_PROJECT_ID: "siteforge-97699", ASSETS: assets(indexBody) };
}

function directive(policy: string, name: string): string {
  const found = policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `) || part === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

function rawScriptClose(html: string, from: number): number {
  let i = from;
  while (i < html.length) {
    const at = html.indexOf("</script>", i);
    if (at < 0) return -1;
    if (html[at - 1] !== "\\") return at;
    i = at + "</script>".length;
  }
  return -1;
}

describe("cloudflare web analytics snippet", () => {
  it("matches the dashboard snippet", () => {
    expect(WEB_ANALYTICS_SNIPPET).toBe(
      `<!-- Cloudflare Web Analytics --><script type='module' src='${WEB_ANALYTICS_SCRIPT_ORIGIN}/beacon.min.js' data-cf-beacon='{"token": "${WEB_ANALYTICS_TOKEN}"}'></script><!-- End Cloudflare Web Analytics -->`,
    );
    expect(WEB_ANALYTICS_TOKEN).toBe("0dd8dc6f9fab4de484d8c5f5a1f1a57e");
  });

  it.each([
    "/",
    "/help",
    "/pricing",
    "/signup",
    "/login",
    "/help/booking",
    "/bright-cuts",
    "/bright-cuts/manage/token",
    "/portal/help",
  ])("inserts the beacon just before </body> on %s", async (path) => {
    const response = await handleRequest(new Request(`https://schedi.app${path}`), env(), ctx());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(WEB_ANALYTICS_SNIPPET + "</body>");
    expect(html.split(WEB_ANALYTICS_SNIPPET).length - 1).toBe(1);
  });

  it("inserts the beacon on the real shell without splitting a script", async () => {
    const response = await handleRequest(new Request("https://schedi.app/login"), env(PUBLIC_HTML), ctx());
    const html = await response.text();
    const close = html.lastIndexOf("</body>");
    expect(html.slice(close - WEB_ANALYTICS_SNIPPET.length, close)).toBe(WEB_ANALYTICS_SNIPPET);
    expect(html.split(WEB_ANALYTICS_SNIPPET).length - 1).toBe(1);
    expect(html).toContain("function generateStandaloneHtmlForTenant");
  });

  it("inserts the beacon on the HQ sign-in page and the HQ shell", async () => {
    const login = await handleRequest(new Request("https://schedi.app/hq"), env(PUBLIC_HTML), ctx());
    expect(await login.text()).toContain(WEB_ANALYTICS_SNIPPET + "</body>");

    const exp = Date.now() + 60 * 60 * 1000;
    const authed = await handleRequest(
      new Request("https://schedi.app/hq", { headers: { Cookie: "schedi_hq=agency-token" } }),
      {
        ...env(PUBLIC_HTML),
        AUTH_KV: {
          get: async (key: string) =>
            key === "session:agency-token"
              ? JSON.stringify({ role: "agency", email: "hq@example.com", exp })
              : null,
        },
      },
      ctx(),
    );
    const html = await authed.text();
    const close = html.lastIndexOf("</body>");
    expect(html.slice(close - WEB_ANALYTICS_SNIPPET.length, close)).toBe(WEB_ANALYTICS_SNIPPET);
    expect(html).toContain('id="agencyHqSection"');
  });

  it("skips the beacon for ?demo=1 and the preview worker host", async () => {
    const demo = await handleRequest(new Request("https://schedi.app/login?demo=1"), env(PUBLIC_HTML), ctx());
    expect(await demo.text()).not.toContain(WEB_ANALYTICS_SNIPPET);

    const home = await handleRequest(new Request("https://schedi.app/?demo=1"), env(), ctx());
    expect(await home.text()).not.toContain("cloudflareinsights.com");

    const preview = await handleRequest(
      new Request(`https://${PREVIEW_ANALYTICS_HOST}/signup`),
      env(PUBLIC_HTML),
      ctx(),
    );
    expect(await preview.text()).not.toContain(WEB_ANALYTICS_SNIPPET);

    const previewHome = await handleRequest(new Request(`https://${PREVIEW_ANALYTICS_HOST}/`), env(), ctx());
    expect(await previewHome.text()).not.toContain("cloudflareinsights.com");
  });
});

describe("cloudflare web analytics CSP", () => {
  it("allows the beacon script and its collect endpoint, and nothing broader", () => {
    const app = contentSecurityPolicy(true);
    const marketing = marketingContentSecurityPolicy();

    expect(directive(app, "script-src")).toBe(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://www.gstatic.com https://static.cloudflareinsights.com",
    );
    expect(directive(app, "connect-src")).toBe(
      "connect-src 'self' https://schedi.app https://schedi-connect-production.up.railway.app https://*.googleapis.com https://*.firebasestorage.app https://*.firebaseio.com wss://*.firebaseio.com https://cloudflareinsights.com",
    );
    expect(directive(marketing, "script-src")).toBe("script-src 'self' https://static.cloudflareinsights.com");
    expect(directive(marketing, "connect-src")).toBe(`connect-src ${WEB_ANALYTICS_CONNECT_ORIGIN}`);
    expect(directive(marketing, "connect-src")).not.toContain("'none'");
    expect(directive(marketing, "connect-src")).not.toContain("*");

    for (const policy of [app, marketing]) {
      expect(directive(policy, "script-src")).toContain(WEB_ANALYTICS_SCRIPT_ORIGIN);
      expect(directive(policy, "connect-src")).toContain(WEB_ANALYTICS_CONNECT_ORIGIN);
      expect(directive(policy, "default-src")).toBe("default-src 'self'");
      expect(directive(policy, "object-src")).toBe("object-src 'none'");
      expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
    }
    expect(directive(app, "form-action")).toBe(
      "form-action 'self' https://schedi.app https://checkout.stripe.com",
    );
    expect(directive(marketing, "form-action")).toBe("form-action 'self'");
    expect(directive(marketing, "frame-src")).toBe("frame-src 'none'");
  });

  it("sends the updated policies on marketing and app responses", async () => {
    const home = await handleRequest(new Request("https://schedi.app/"), env(), ctx());
    expect(home.headers.get("content-security-policy")).toBe(marketingContentSecurityPolicy());

    const login = await handleRequest(new Request("https://schedi.app/login"), env(), ctx());
    expect(login.headers.get("content-security-policy")).toBe(contentSecurityPolicy(true));
  });

  it("keeps the same app policy in site/_headers", () => {
    const policy = contentSecurityPolicy(true);
    expect(HEADERS).toContain(`/index.html\n  Content-Security-Policy: ${policy}\n`);
    expect(HEADERS).toContain(`/hq.html\n  Content-Security-Policy: ${policy}\n`);
    expect(HEADERS).not.toContain("script-src *");
    expect(HEADERS).not.toContain("connect-src *");
  });
});

describe("booking template beacon", () => {
  it.each([
    ["index.html", PUBLIC_HTML],
    ["hq.html", HQ_HTML],
  ])("%s escapes the dashboard snippet and only emits it when the booking document replaces the shell", (name, html) => {
    const fnAt = html.indexOf("function generateStandaloneHtmlForTenant");
    expect(fnAt, name).toBeGreaterThan(0);
    const assignAt = html.indexOf('schediWebAnalytics = "', fnAt);
    expect(assignAt, name).toBeGreaterThan(fnAt);
    const literalEnd = html.indexOf('";', assignAt);
    const literal = html.slice(assignAt + "schediWebAnalytics = ".length, literalEnd + 1);
    const value = Function(`"use strict"; return (${literal});`)() as string;
    expect(value).toBe(WEB_ANALYTICS_SNIPPET);

    const scriptClose = rawScriptClose(html, fnAt);
    expect(scriptClose, name).toBeGreaterThan(literalEnd);
    expect(html.slice(fnAt, scriptClose)).toContain("${schediWebAnalytics}");
    expect(html.slice(fnAt, scriptClose)).toContain("topDocument");
    expect(html).toContain("document.write(generateStandaloneHtmlForTenant(tenant, { topDocument: true }))");
    expect(html).toContain("frame.srcdoc = pageHtml");
  });
});
