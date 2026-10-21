import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MARKETING_PAGES } from "../worker/content";
import {
  CROSS_ORIGIN_OPENER_POLICY,
  CROSS_ORIGIN_RESOURCE_POLICY,
  EMBEDDABLE_RESOURCE_POLICY,
  PERMISSIONS_POLICY,
  STRICT_TRANSPORT_SECURITY,
  contentSecurityPolicy,
  handleRequest,
  marketingContentSecurityPolicy,
  type SchediEnv,
} from "../worker/handler";
import { hqLoginDocument } from "../worker/public-shell";
import { renderMarketingPage, renderRobots, renderSecurityTxt, SECURITY_TXT_EXPIRES } from "../worker/render";

const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));

const HEADERS = readFileSync(new URL("../site/_headers", import.meta.url), "utf8");
const INDEX = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const HQ = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");

const SHARED_HEADERS = [
  `Strict-Transport-Security: ${STRICT_TRANSPORT_SECURITY}`,
  `Permissions-Policy: ${PERMISSIONS_POLICY}`,
  `Cross-Origin-Opener-Policy: ${CROSS_ORIGIN_OPENER_POLICY}`,
  `Cross-Origin-Resource-Policy: ${CROSS_ORIGIN_RESOURCE_POLICY}`,
];

function ctx() {
  return { waitUntil() {} };
}

function env(): SchediEnv {
  return {
    FIREBASE_PROJECT_ID: "siteforge-97699",
    ASSETS: {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        if (path === "/index.html") {
          return new Response(INDEX, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        if (path.startsWith("/assets/fonts/")) {
          const file = new URL(`../site${path}`, import.meta.url);
          if (!existsSync(file)) return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
          const type = path.endsWith(".css") ? "text/css; charset=utf-8" : "font/woff2";
          return new Response(readFileSync(file), { headers: { "content-type": type } });
        }
        if (path.startsWith("/assets/") || path === "/favicon.ico") {
          const type = path.endsWith(".css")
            ? "text/css; charset=utf-8"
            : path.endsWith(".svg")
              ? "image/svg+xml"
              : path === "/favicon.ico"
                ? "image/x-icon"
                : "image/png";
          return new Response("asset", { headers: { "content-type": type } });
        }
        return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
      },
    },
  };
}

function expectShared(headers: Headers, corp = CROSS_ORIGIN_RESOURCE_POLICY) {
  expect(headers.get("strict-transport-security")).toBe(STRICT_TRANSPORT_SECURITY);
  expect(headers.get("strict-transport-security")).not.toContain("preload");
  expect(headers.get("permissions-policy")).toBe(PERMISSIONS_POLICY);
  expect(headers.get("cross-origin-opener-policy")).toBe(CROSS_ORIGIN_OPENER_POLICY);
  expect(headers.get("cross-origin-resource-policy")).toBe(corp);
  expect(headers.get("x-content-type-options")).toBe("nosniff");
  expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
}

describe("security and accessibility headers", () => {
  it("adds a skip link and self-hosted Inter on the homepage", async () => {
    const response = await handleRequest(new Request("https://schedi.app/"), env(), ctx());
    expect(response.status).toBe(200);
    expectShared(response.headers);
    const html = await response.text();
    const skip = html.indexOf('<a class="skip" href="#content">Skip to content</a>');
    const main = html.indexOf('<main id="content">');
    expect(skip).toBeGreaterThan(-1);
    expect(main).toBeGreaterThan(skip);
    expect(html).toContain('href="/assets/fonts/inter.css"');
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
    expect(response.headers.get("content-security-policy")).toBe(marketingContentSecurityPolicy());
    expect(response.headers.get("content-security-policy")).not.toContain("fonts.googleapis.com");
    expect(response.headers.get("content-security-policy")).not.toContain("fonts.gstatic.com");
  });

  it("keeps unsafe-inline and drops Google font hosts from both policies", () => {
    const app = contentSecurityPolicy(true);
    const marketing = marketingContentSecurityPolicy();
    expect(app).toContain("style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com");
    expect(app).toContain("font-src 'self' data: https://cdnjs.cloudflare.com");
    expect(app).toContain("'unsafe-eval'");
    expect(marketing).toContain("style-src 'self' 'unsafe-inline'");
    expect(marketing).toContain("font-src 'self'");
    expect(marketing).not.toContain("fonts.");
    expect(app).not.toContain("fonts.googleapis.com");
    expect(app).not.toContain("fonts.gstatic.com");
    const home = renderMarketingPage(MARKETING_PAGES.find((page) => page.path === "/")!);
    expect(home).toContain('<a class="skip" href="#content">Skip to content</a>');
    expect(home).toContain('<main id="content">');
  });

  it("links owner and signup fields and repeats the headers on app routes", async () => {
    expect(INDEX).toContain('<label class="block font-semibold text-slate-300 mb-1" for="tenantLoginEmail">Owner Email</label>');
    expect(INDEX).toContain('id="tenantLoginEmail" required autocomplete="email"');
    expect(INDEX).toContain('<label class="block font-semibold text-slate-300 mb-1" for="tenantLoginPassword">Password</label>');
    expect(INDEX).toContain('id="tenantLoginPassword" required autocomplete="current-password"');
    expect(INDEX).toContain('id="signupOwnerEmail" required maxlength="160" autocomplete="email"');
    expect(INDEX).toContain('id="signupBusinessName" required maxlength="80" autocomplete="organization"');
    expect(INDEX).toContain('id="signupOwnerName" required maxlength="80" autocomplete="name"');
    expect(INDEX).toContain('<label class="block text-xs text-slate-300 mb-1" for="pubClientEmail">Email Address *</label>');
    expect(INDEX).toContain('id="pubClientEmail" required autocomplete="email"');
    expect(HQ).toContain('for="pubClientEmail"');
    expect(INDEX).toContain('<label class="block font-semibold text-slate-300 mb-1" for="signupResumeEmail">Owner email</label>');
    expect(INDEX).toContain('id="signupResumeEmail" autocomplete="email"');
    expect(INDEX).toContain('<label class="block font-semibold text-slate-300 mb-1" for="signupResumePassword">Temporary password</label>');
    expect(HQ).toContain('for="agencyMasterEmail"');
    expect(HQ).toContain('id="agencyMasterEmail" name="masterEmail" required autocomplete="email"');
    expect(HQ).toContain('for="agencyMasterPassword"');
    expect(HQ).toContain('for="tenantLoginEmail"');
    expect(HQ).not.toContain("fonts.googleapis.com");
    expect(INDEX).not.toContain("fonts.googleapis.com");
    const hq = hqLoginDocument();
    expect(hq).toContain('autocomplete="email"');
    expect(hq).toContain('autocomplete="current-password"');
    expect(hq).toContain("href = '/assets/fonts/inter.css'");
    expect(hq).not.toContain("fonts.googleapis.com");

    const login = await handleRequest(new Request("https://schedi.app/login"), env(), ctx());
    expect(login.status).toBe(200);
    expectShared(login.headers);
    expect(login.headers.get("content-security-policy")).toBe(contentSecurityPolicy(true));
    expect(login.headers.get("x-robots-tag")).toContain("noindex");
    expect(await login.text()).toContain('for="tenantLoginEmail"');
  });

  it("serves security.txt and noindexes private routes without naming them in robots.txt", async () => {
    const security = await handleRequest(new Request("https://schedi.app/.well-known/security.txt"), env(), ctx());
    expect(security.status).toBe(200);
    expect(security.headers.get("content-type")).toMatch(/text\/plain/);
    expectShared(security.headers);
    expect(await security.text()).toBe(renderSecurityTxt());
    expect(renderSecurityTxt()).toBe(
      [
        "Contact: mailto:hello@schedi.app",
        `Expires: ${SECURITY_TXT_EXPIRES}`,
        "Canonical: https://schedi.app/.well-known/security.txt",
        "Preferred-Languages: en",
        "",
      ].join("\n"),
    );
    expect(SECURITY_TXT_EXPIRES.startsWith("2027-10-21")).toBe(true);

    const robots = renderRobots();
    expect(robots).toContain("Allow: /");
    expect(robots).toContain("Sitemap: https://schedi.app/sitemap.xml");
    expect(robots).not.toMatch(/Disallow: \/(admin|hq|api|portal|billing|agency)/);

    for (const path of ["/admin", "/api", "/billing", "/hq"]) {
      const response = await handleRequest(new Request(`https://schedi.app${path}`), env(), ctx());
      expect(response.headers.get("x-robots-tag"), path).toMatch(/noindex/);
    }
  });

  it("sends the same headers on static font files and in site/_headers", async () => {
    const font = await handleRequest(new Request("https://schedi.app/assets/fonts/inter.css"), env(), ctx());
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toMatch(/text\/css/);
    expectShared(font.headers, EMBEDDABLE_RESOURCE_POLICY);
    const css = await font.text();
    expect(css).toContain("font-family: 'Inter'");
    expect(css).toContain("font-weight: 300 800");
    expect(css).not.toContain("fonts.gstatic.com");
    for (const file of [
      "inter-cyrillic-ext.woff2",
      "inter-cyrillic.woff2",
      "inter-greek-ext.woff2",
      "inter-greek.woff2",
      "inter-vietnamese.woff2",
      "inter-latin-ext.woff2",
      "inter-latin.woff2",
    ]) {
      expect(css).toContain(`/assets/fonts/${file}`);
      expect(existsSync(new URL(`../site/assets/fonts/${file}`, import.meta.url))).toBe(true);
    }
    expect(existsSync(new URL("../site/assets/fonts/OFL.txt", import.meta.url))).toBe(true);

    const policy = contentSecurityPolicy(true);
    expect(HEADERS).toContain(`/index.html\n  Content-Security-Policy: ${policy}\n`);
    expect(HEADERS).toContain(`/hq.html\n  Content-Security-Policy: ${policy}\n`);
    for (const line of SHARED_HEADERS) {
      expect(HEADERS).toContain(line);
    }
    expect(HEADERS).not.toContain("preload");
    expect(HEADERS).not.toContain("fonts.googleapis.com");
    expect(HEADERS).not.toContain("fonts.gstatic.com");
    expect(HEADERS).toContain("/assets/*\n  Cross-Origin-Resource-Policy: cross-origin\n");
    expect(HEADERS).toContain("/favicon.ico\n  Cross-Origin-Resource-Policy: cross-origin\n");
    expect(HEADERS).toContain("/index.html\n  Content-Security-Policy:");
    expect(HEADERS).toContain("  Cross-Origin-Resource-Policy: same-origin\n");
  });

  it("sends cross-origin CORP for embedded assets and same-origin for HTML", async () => {
    for (const path of [
      "/assets/homescreen-icon.png",
      "/assets/og/share.png",
      "/assets/fonts/inter.css",
      "/favicon.ico",
    ]) {
      const response = await handleRequest(new Request(`https://schedi.app${path}`), env(), ctx());
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cross-origin-resource-policy"), path).toBe(EMBEDDABLE_RESOURCE_POLICY);
    }
    const home = await handleRequest(new Request("https://schedi.app/"), env(), ctx());
    expect(home.headers.get("content-type")).toMatch(/text\/html/);
    expect(home.headers.get("cross-origin-resource-policy")).toBe(CROSS_ORIGIN_RESOURCE_POLICY);
    const login = await handleRequest(new Request("https://schedi.app/login"), env(), ctx());
    expect(login.headers.get("content-type")).toMatch(/text\/html/);
    expect(login.headers.get("cross-origin-resource-policy")).toBe(CROSS_ORIGIN_RESOURCE_POLICY);
    const booking = readFileSync(new URL("../site/booking.html", import.meta.url), "utf8");
    expect(booking).toContain('for="pubClientEmail"');
    expect(booking).toContain('id="pubClientEmail"');
  });
});

describe.skipIf(!chrome)("homepage and login in the browser", () => {
  it("shows the skip link, paints Inter, and links the login labels", async () => {
    const server = createServer(async (req, res) => {
      const response = await handleRequest(new Request(`https://schedi.app${req.url || "/"}`), env(), ctx());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (key === "strict-transport-security") return;
        headers[key] = value;
      });
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
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
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0", timeout: 20000 });
      const skip = await page.$eval("a.skip", (el) => ({
        text: el.textContent,
        href: el.getAttribute("href"),
      }));
      expect(skip).toEqual({ text: "Skip to content", href: "#content" });
      expect(await page.$eval("main", (el) => el.id)).toBe("content");
      await page.focus("a.skip");
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        const box = el?.getBoundingClientRect();
        return { text: el?.textContent || "", top: box?.top ?? -1, visible: (box?.height || 0) > 0 };
      });
      expect(focused.text).toBe("Skip to content");
      expect(focused.top).toBeGreaterThanOrEqual(0);
      expect(focused.visible).toBe(true);
      await page.evaluate(() => document.fonts.ready);
      const font = await page.evaluate(() => {
        const family = getComputedStyle(document.body).fontFamily;
        const loaded = [...document.fonts].some((face) => face.family === "Inter" && face.status === "loaded");
        return { family, loaded };
      });
      expect(font.family.toLowerCase()).toContain("inter");
      expect(font.loaded).toBe(true);

      await page.goto(`http://127.0.0.1:${port}/login`, { waitUntil: "domcontentloaded", timeout: 20000 });
      const fields = await page.evaluate(() => {
        const email = document.querySelector("#tenantLoginEmail") as HTMLInputElement | null;
        const password = document.querySelector("#tenantLoginPassword") as HTMLInputElement | null;
        const emailLabel = document.querySelector('label[for="tenantLoginEmail"]');
        const passwordLabel = document.querySelector('label[for="tenantLoginPassword"]');
        return {
          email: email?.getAttribute("autocomplete") || "",
          password: password?.getAttribute("autocomplete") || "",
          emailLabel: emailLabel?.textContent || "",
          passwordLabel: passwordLabel?.textContent || "",
        };
      });
      expect(fields).toEqual({
        email: "email",
        password: "current-password",
        emailLabel: "Owner Email",
        passwordLabel: "Password",
      });
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }, 40000);
});
