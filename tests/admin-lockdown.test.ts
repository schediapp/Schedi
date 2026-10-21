import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest, type SchediEnv } from "../worker/handler";
import { bookingPaused, projectPublicBooking } from "../worker/booking-document";
import worker from "../workers/schedi-email-worker/src/index.js";
import { resetLocalLimits } from "../workers/schedi-email-worker/src/rate-limit.js";
import { memoryAuthLimits } from "./memory-auth-limit";

const bookingHtml = readFileSync(new URL("../site/booking.html", import.meta.url), "utf8");
const ownerHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hqHtml = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const trimScript = readFileSync(new URL("../scripts/trim-public-tenant-docs.mjs", import.meta.url), "utf8");
const wrangler = readFileSync(new URL("../workers/schedi-email-worker/wrangler.toml", import.meta.url), "utf8");

const BANNED = ["renderAgencyDashboard", "provision", "Complimentary", "/auth/agency"];

function ctx() {
  return { waitUntil() {} };
}

function assets(): SchediEnv["ASSETS"] {
  return {
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      const body = path === "/booking.html" ? bookingHtml : path === "/hq.html" ? hqHtml : path === "/index.html" ? ownerHtml : "";
      if (!body) return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
      return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  };
}

function env(extra: Partial<SchediEnv> = {}): SchediEnv {
  return { FIREBASE_PROJECT_ID: "siteforge-97699", ASSETS: assets(), ...extra };
}

describe("public booking bundle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ships no agency or owner code in the booking document", () => {
    for (const word of BANNED) expect(bookingHtml, word).not.toContain(word);
    expect(bookingHtml).toContain("__SCHEDI_SAFE_NAME__");
    expect(bookingHtml).not.toContain("renderAgencyDashboard");
    expect(ownerHtml).toContain("function generateStandaloneHtmlForTenant");
  });

  it("serves the booking document on /{slug} and keeps agency strings out", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const target = String(input);
      calls.push(target);
      expect(target).toContain("tenants/bright-cuts");
      expect(target).toContain("mask.fieldPaths=showPublicAddress");
      expect(target).not.toContain("ownerEmail");
      return new Response(JSON.stringify({
        fields: {
          name: { stringValue: "Bright Cuts" },
          industry: { stringValue: "Barber" },
          slug: { stringValue: "bright-cuts" },
          seoPublic: { booleanValue: true },
          showPublicAddress: { booleanValue: false },
          address: { stringValue: "10 Main St" },
          subscriptionStatus: { stringValue: "active" },
          squareMerchantId: { stringValue: "merchant-secret" },
          unpaidDigestWeek: { stringValue: "2026-10-12" },
          ownerEmail: { stringValue: "hidden@example.com" },
          plan: { stringValue: "pro" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const response = await handleRequest(new Request("https://schedi.app/bright-cuts"), env(), ctx());
    expect(response.status).toBe(200);
    const html = await response.text();
    for (const word of BANNED) expect(html, word).not.toContain(word);
    expect(html).toContain("Book an Appointment | Bright Cuts");
    expect(html).not.toContain("10 Main St");
    expect(html).not.toContain("merchant-secret");
    expect(html).not.toContain("unpaidDigestWeek");
    expect(html).toContain('"subscriptionStatus":"active"');
    expect(html).toContain('"acceptingBookings":true');
    expect(html).not.toContain("hidden@example.com");
    expect(calls).toHaveLength(1);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBeNull();
  });

  it("pauses when acceptingBookings is missing and subscriptionStatus is paused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      fields: {
        name: { stringValue: "Northwind Clinic" },
        slug: { stringValue: "northwind" },
        subscriptionStatus: { stringValue: "paused" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const response = await handleRequest(new Request("https://schedi.app/northwind"), env(), ctx());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Northwind Clinic is not taking appointments");
    expect(html).not.toContain("serviceListContainer");
    expect(bookingPaused({ name: "Northwind Clinic", subscriptionStatus: "paused" })).toBe(true);
    expect(bookingPaused({ name: "Bright Cuts", subscriptionStatus: "active" })).toBe(false);
    expect(bookingPaused({ name: "Bright Cuts" })).toBe(false);
    expect(bookingPaused({ name: "Bright Cuts", acceptingBookings: false })).toBe(true);
  });

  it("keeps the owner shell on /login and the HQ shell only after an agency session", async () => {
    const login = await handleRequest(new Request("https://schedi.app/login"), env(), ctx());
    expect(login.status).toBe(200);
    const loginHtml = await login.text();
    expect(loginHtml).toContain("function generateStandaloneHtmlForTenant");
    expect(login.headers.get("cache-control")).toBe("no-store");
    expect(login.headers.get("x-robots-tag")).toContain("noindex");

    const exp = Date.now() + 60 * 60 * 1000;
    const hq = await handleRequest(
      new Request("https://schedi.app/hq", { headers: { Cookie: "schedi_hq=agency-token" } }),
      env({
        AUTH_KV: {
          get: async (key: string) => key === "session:agency-token"
            ? JSON.stringify({ role: "agency", email: "hq@example.com", exp })
            : null,
        },
      }),
      ctx(),
    );
    const hqBody = await hq.text();
    expect(hqBody).toContain('id="agencyHqSection"');
    expect(hqBody).toContain("Agency HQ Master Login");
    expect(hqBody).toContain("html.schedi-newhq #agencyDirectory { order: 2; }");
    expect(hq.headers.get("cache-control")).toBe("no-store");
    expect(hq.headers.get("x-robots-tag")).toContain("noindex");

    const signedOut = await handleRequest(new Request("https://schedi.app/hq"), env(), ctx());
    const signedOutHtml = await signedOut.text();
    expect(signedOutHtml).toContain("/auth/agency");
    expect(signedOutHtml).not.toContain('id="agencyHqSection"');
  });

  it("404s direct shell files and keeps private paths out of robots.txt", async () => {
    for (const path of ["/hq.html", "/admin.html", "/booking.html"]) {
      const response = await handleRequest(new Request("https://schedi.app" + path), env(), ctx());
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain("agencyHqSection");
    }
    const robots = await handleRequest(new Request("https://schedi.app/robots.txt"), env(), ctx());
    const text = await robots.text();
    expect(text).toContain("Allow: /");
    expect(text).toContain("Sitemap: https://schedi.app/sitemap.xml");
    for (const rule of ["/portal", "/portal-preview", "/admin", "/hq", "/agency", "/billing", "/api"]) {
      expect(text).not.toContain("Disallow: " + rule);
      expect(text).not.toContain(rule);
    }
  });
});

describe("booking field projection", () => {
  it("drops address when hidden and drops billing and Square ids", () => {
    const pub = projectPublicBooking({
      name: "Bright Cuts",
      plan: "starter",
      showPublicAddress: false,
      address: "10 Main St",
      city: "Austin",
      subscriptionStatus: "active",
      squareMerchantId: "m1",
      unpaidDigestWeek: "2026-10-12",
      complimentaryPro: true,
      monthlyPrice: 0,
      ownerEmail: "a@b.co",
    });
    expect(pub.plan).toBe("pro");
    expect(pub.address).toBeUndefined();
    expect(pub.city).toBeUndefined();
    expect(pub.subscriptionStatus).toBe("active");
    expect(pub.acceptingBookings).toBe(true);
    expect(pub.squareMerchantId).toBeUndefined();
    expect(pub.unpaidDigestWeek).toBeUndefined();
    expect(pub.ownerEmail).toBeUndefined();
    expect(pub.complimentaryPro).toBeUndefined();
    expect(pub.name).toBe("Bright Cuts");
  });
});

describe("firestore rules and dry-run cleanup", () => {
  it("allows single-doc get and list, and blocks client writes", () => {
    expect(rules).toContain("allow get, list: if true");
    expect(rules).toContain("allow create, update, delete: if false");
    expect(rules).toContain("stripeConnectReady");
    expect(rules).toContain("squareReady");
    expect(rules).toContain("stripeConnectStatus");
    expect(rules).toContain("squareConnectStatus");
    expect(rules).toContain("server-only");
    expect(rules).toMatch(/private\/data\/tenants[\s\S]*allow read, write: if false/);
    expect(rules).toContain("list stays open");
  });

  it("cleanup script has no write path and refuses to run without --dry-run", () => {
    expect(trimScript).toContain("DRY-RUN ONLY");
    expect(trimScript).not.toMatch(/fetch\s*\(/);
    expect(trimScript).not.toMatch(/method:\s*['"]PATCH['"]/);
    expect(trimScript).not.toMatch(/method:\s*['"]DELETE['"]/);
    expect(trimScript).not.toContain("updateMask");
    expect(wrangler).toContain("workers_dev = true");
    expect(wrangler).not.toContain("workers_dev = false");
    expect(wrangler).not.toContain("period = 900");
    expect(wrangler).not.toContain("RL_AUTH_GLOBAL");
    expect(wrangler).not.toContain("RL_AUTH_IP");
    expect(wrangler).not.toContain("RL_AUTH_EMAIL");
    expect(wrangler).not.toContain("limit = 10, period = 60");
    expect(wrangler).not.toContain("limit = 5, period = 60");
    expect(wrangler).toContain('name = "AUTH_RATE_LIMIT"');
    expect(wrangler).toContain('class_name = "AuthRateLimit"');
    expect(wrangler).toContain('new_sqlite_classes = ["AuthRateLimit"]');
    expect(wrangler).toContain('pattern = "schedi.app/api/ops-snapshot*"');
    expect(wrangler).toContain('pattern = "schedi.app/api/resend-events*"');
  });
});

const EXP = Date.now() + 60 * 60 * 1000;

function authEnv() {
  const store = new Map<string, string>([
    ["session:owner-token", JSON.stringify({ role: "owner", email: "owner@example.com", tenantId: "acme", exp: EXP })],
  ]);
  return {
    AUTH_KV: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value); },
      delete: async (key: string) => { store.delete(key); },
    },
    AUTH_PEPPER: "test-pepper",
  };
}

describe("auth rate limits", () => {
  let limits = memoryAuthLimits();

  beforeEach(() => {
    limits = memoryAuthLimits();
    resetLocalLimits();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLocalLimits();
  });

  function authEnvWithLimits() {
    return Object.assign(authEnv(), { AUTH_RATE_LIMIT: limits.namespace });
  }

  async function post(path: string, body: Record<string, unknown>, ip: string) {
    const response = await worker.fetch(new Request("https://schedi.app" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, Origin: "https://schedi.app" },
      body: JSON.stringify(body),
    }), authEnvWithLimits(), { waitUntil() {} });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data: data as { error?: string }, retryAfter: response.headers.get("Retry-After") };
  }

  it("returns 429 rate_limited on the sixth agency sign-in and never logs the password", async () => {
    const password = "s3cret-password-should-not-log";
    const body = { email: "hq@example.com", password };
    for (let i = 0; i < 5; i += 1) {
      const out = await post("/auth/agency", body, "203.0.113.10");
      expect(out.status).toBe(401);
    }
    const blocked = await post("/auth/agency", body, "203.0.113.10");
    expect(blocked.status).toBe(429);
    expect(blocked.data.error).toBe("rate_limited");
    expect(blocked.retryAfter).toMatch(/^(?:[1-9]|[1-5]\d|60)$/);
    const logged = [console.log, console.warn, console.error, console.info]
      .map((fn) => (fn as unknown as { mock?: { calls: unknown[][] } }).mock?.calls || [])
      .flat()
      .join(" ");
    expect(logged).toContain("auth rate limit /auth/agency email");
    expect(logged).not.toContain(password);
    expect(logged).not.toContain("hq@example.com");
  });

  it("limits /auth/tenant per email across IPs and blocks workers.dev auth and ops", async () => {
    const body = { email: "owner@example.com", password: "another-secret" };
    for (let i = 0; i < 5; i += 1) {
      const out = await post("/auth/tenant", body, "203.0.113." + (20 + i));
      expect(out.status).toBe(401);
    }
    const blocked = await post("/auth/tenant", body, "203.0.113.90");
    expect(blocked.status).toBe(429);
    expect(blocked.data.error).toBe("rate_limited");
    expect(blocked.retryAfter).toMatch(/^(?:[1-9]|[1-5]\d|60)$/);

    const devAuth = await worker.fetch(new Request("https://schedi-email-worker.workers.dev/auth/agency", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), authEnv(), { waitUntil() {} });
    expect(devAuth.status).toBe(404);
    const devPasswords = await worker.fetch(new Request("https://schedi-email-worker.workers.dev/api/ops-default-passwords"), authEnv(), { waitUntil() {} });
    expect(devPasswords.status).toBe(404);
    const devOps = await worker.fetch(new Request("https://schedi-email-worker.workers.dev/api/ops-snapshot"), authEnv(), { waitUntil() {} });
    expect(devOps.status).not.toBe(404);
    const devResend = await worker.fetch(new Request("https://schedi-email-worker.workers.dev/api/resend-events", { method: "POST", body: "{}" }), authEnv(), { waitUntil() {} });
    expect(devResend.status).not.toBe(404);
    const appOps = await worker.fetch(new Request("https://schedi.app/api/ops-snapshot"), authEnv(), { waitUntil() {} });
    expect(appOps.status).not.toBe(404);
    const live = await post("/auth/forgot", { identifier: "owner@example.com" }, "203.0.113.77");
    expect(live.status).not.toBe(404);
    expect(typeof worker.scheduled).toBe("function");
  });

  it("caps one IP at 10 sign-ins per minute and does not use a global cap", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < 10; i += 1) {
      const out = await post("/auth/tenant", { email: `person${i}@example.com`, password: "not-logged" }, ip);
      expect(out.status).toBe(401);
    }
    const blocked = await post("/auth/tenant", { email: "person10@example.com", password: "not-logged" }, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.data.error).toBe("rate_limited");
    expect(blocked.retryAfter).toMatch(/^(?:[1-9]|[1-5]\d|60)$/);
    const fresh = await post("/auth/agency", { email: "hq-fresh@example.com", password: "not-logged" }, "198.51.100.8");
    expect(fresh.status).toBe(401);
  });
});
