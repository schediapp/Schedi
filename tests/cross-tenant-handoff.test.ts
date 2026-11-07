import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore } from "../src/lib/db";
import { parseSchediPlan } from "../src/lib/plan-entitlement";
import worker from "../workers/schedi-email-worker/src/index.js";
import { resetLocalLimits } from "../workers/schedi-email-worker/src/rate-limit.js";
import { memoryAuthLimits } from "./memory-auth-limit";

const SECRET = "cross-tenant-secret";
const dbPath = join(mkdtempSync(join(tmpdir(), "schedi-takeover-")), "schedi.sqlite");
process.env.SCHEDI_DB_PATH = dbPath;
process.env.SCHEDI_SEED = "0";
process.env.NODE_ENV = "production";
process.env.SCHEDI_CONNECT_PAID_SECRET = SECRET;
delete process.env.STRIPE_SECRET_KEY;

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function memoryKv() {
  const map = new Map<string, string>();
  return {
    map,
    async get(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    async put(key: string, value: string) {
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
  };
}

function sessionCount(): number {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
  db.close();
  return Number(row.n);
}

describe("cross-tenant handoff", () => {
  const docs = new Map<string, { fields: Record<string, unknown> }>();
  const limits = memoryAuthLimits();
  const kv = memoryKv();
  const env = {
    AUTH_KV: kv,
    AUTH_PEPPER: "test-pepper",
    AUTH_RATE_LIMIT: limits.namespace,
    FIREBASE_API_KEY: "test-api-key",
    FIREBASE_PROJECT_ID: "siteforge-97699",
    FIREBASE_APP_ID: "siteforge-97699",
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: "test@test.iam.gserviceaccount.com",
      private_key: privateKey,
    }),
    SCHEDI_CONNECT_PAID_SECRET: SECRET,
    RESEND_API_KEY: "re_test",
  };

  beforeEach(() => {
    docs.clear();
    kv.map.clear();
    limits.store.clear();
    resetLocalLimits();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = String(init?.method || "GET").toUpperCase();
      if (url.hostname === "identitytoolkit.googleapis.com") {
        return Response.json({ idToken: "anon-token" });
      }
      if (url.hostname === "oauth2.googleapis.com") {
        return Response.json({ access_token: "admin-token", expires_in: 3600 });
      }
      if (url.hostname === "api.resend.com") {
        return Response.json({ id: "mail-test" });
      }
      if (url.hostname === "schedi.app" && (url.pathname === "/billing/connect-plan" || url.pathname === "/billing/connect-bind")) {
        return worker.fetch(new Request(url, init), env, { waitUntil() {} });
      }
      if (url.hostname === "firestore.googleapis.com") {
        const key = url.pathname;
        if (method === "GET") {
          const doc = docs.get(key);
          if (!doc) return new Response("{}", { status: 404 });
          return Response.json(doc);
        }
        const body = JSON.parse(String(init?.body || "{}")) as { fields?: Record<string, unknown> };
        if (method === "POST") {
          const id = url.searchParams.get("documentId") || "";
          docs.set(`${key}/${id}`, { fields: body.fields || {} });
          return Response.json({ fields: body.fields || {} });
        }
        if (method === "PATCH") {
          const prev = docs.get(key)?.fields || {};
          const next = { fields: { ...prev, ...(body.fields || {}) } };
          docs.set(key, next);
          return Response.json(next);
        }
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await worker.fetch(new Request(`https://schedi.app${path}`, {
      method: "POST",
      headers: {
        origin: "https://schedi.app",
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.44",
        ...headers,
      },
      body: JSON.stringify(body),
    }), env, { waitUntil() {} });
    const payload = await response.json() as Record<string, unknown>;
    return { status: response.status, payload };
  }

  it("does not take over an existing business when a new Free tenant reuses its email", async () => {
    const store = openStore(dbPath);
    const owner = store.createOwner({ email: "victim@example.com", name: "Victim Owner" });
    const business = store.createBusiness({
      ownerId: owner.id,
      name: "Harbor Cuts",
      slug: "harbor-cuts",
      plan: "pro",
      subscriptionStatus: "active",
      stripeSubscriptionId: "sub_victim",
      stripeAccountId: "acct_victim",
    });
    const service = store.createService({
      businessId: business.id,
      name: "Haircut",
      durationMinutes: 45,
      priceCents: 8000,
    });
    const booking = store.createBooking({
      businessId: business.id,
      serviceId: service.id,
      clientName: "Client",
      clientEmail: "client@example.com",
      startsAt: "2026-12-01T15:00:00.000Z",
      paymentMethod: "pay_at_appointment",
      chargeKind: null,
      amountCents: 8000,
      status: "confirmed",
    });
    const before = {
      id: business.id,
      ownerId: owner.id,
      slug: store.getBusiness(business.id).slug,
      plan: store.getBusiness(business.id).plan,
      stripeSubscriptionId: store.getBusiness(business.id).stripeSubscriptionId,
      stripeAccountId: store.getBusiness(business.id).stripeAccountId,
      services: store.listServices(business.id).map((row) => row.id),
      bookings: store.listBookings(business.id).map((row) => ({ id: row.id, status: row.status, amountCents: row.amountCents })),
    };

    const signup = await post("/billing/signup", {
      businessName: "Attacker Shop",
      ownerName: "Attacker",
      ownerEmail: "victim@example.com",
      plan: "free",
      industry: "Services",
    });
    expect(signup.status).toBe(200);
    expect(signup.payload.slug).toBe("attacker-shop");
    expect(typeof signup.payload.temporaryPassword).toBe("string");
    expect(signup.payload.slug).not.toBe(before.slug);

    const login = await post("/auth/tenant", {
      email: "victim@example.com",
      password: signup.payload.temporaryPassword,
    });
    expect(login.status).toBe(200);
    expect(login.payload.tenantId).toBe("attacker-shop");
    expect(login.payload.role).toBe("owner");

    const handed = await post("/billing/connect-handoff", {
      tenantId: login.payload.tenantId,
      session: login.payload.session,
    });
    expect(handed.status).toBe(200);
    const url = new URL(String(handed.payload.url));
    expect(url.hash.startsWith("#t=")).toBe(true);
    const token = decodeURIComponent(url.hash.slice(3));

    const { POST } = await import("../src/app/api/connect/handoff/route");
    const response = await POST(new Request("https://schedi-connect-production.up.railway.app/api/connect/handoff", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t: token }),
    }));
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location") || "").not.toContain("s2.");
    expect(sessionCount()).toBe(0);

    const after = store.getBusiness(business.id);
    expect(after.slug).toBe(before.slug);
    expect(after.plan).toBe(before.plan);
    expect(after.ownerId).toBe(before.ownerId);
    expect(after.stripeSubscriptionId).toBe("sub_victim");
    expect(after.stripeAccountId).toBe("acct_victim");
    expect(store.listServices(business.id).map((row) => row.id)).toEqual(before.services);
    expect(store.listBookings(business.id).map((row) => row.id)).toEqual([booking.id]);
    expect(store.listBookings(business.id)[0]?.status).toBe("confirmed");
    expect(store.getOwnerByEmail("victim@example.com")?.id).toBe(owner.id);
    expect(store.getBusinessBySlug("attacker-shop")).toBeNull();

    const plan = await post("/billing/connect-plan", {
      slug: "attacker-shop",
      email: "victim@example.com",
    }, { "x-schedi-connect-secret": SECRET });
    expect(plan.status).toBe(200);
    expect(parseSchediPlan(plan.payload)).toMatchObject({
      slug: "attacker-shop",
      ownerEmail: "victim@example.com",
      plan: "free",
      cardEntitled: false,
    });
  });

  it("opens a business only after the credential that created it comes back", async () => {
    const signup = await post("/billing/signup", {
      businessName: "Fresh Shop",
      ownerName: "Fresh Owner",
      ownerEmail: "fresh-owner@example.com",
      plan: "free",
      industry: "Photography",
    });
    expect(signup.status).toBe(200);
    expect(signup.payload.slug).toBe("fresh-shop");
    const login = await post("/auth/tenant", {
      email: "fresh-owner@example.com",
      password: signup.payload.temporaryPassword,
    });
    expect(login.payload.tenantId).toBe("fresh-shop");
    const { POST } = await import("../src/app/api/connect/handoff/route");
    const firstToken = decodeURIComponent(new URL(String((await post("/billing/connect-handoff", {
      tenantId: login.payload.tenantId,
      session: login.payload.session,
    })).payload.url)).hash.slice(3));
    const first = await POST(new Request("https://schedi-connect-production.up.railway.app/api/connect/handoff", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t: firstToken }),
    }));
    expect(first.headers.get("set-cookie") || "").toContain("s2.");
    const store = openStore(dbPath);
    const business = store.getBusinessBySlug("fresh-shop");
    expect(business?.ownerId).toBeTruthy();
    const service = store.createService({
      businessId: business!.id,
      name: "Visit",
      durationMinutes: 30,
      priceCents: 4000,
    });
    const booking = store.createBooking({
      businessId: business!.id,
      serviceId: service.id,
      clientName: "Client",
      clientEmail: "client@example.com",
      startsAt: "2026-12-02T15:00:00.000Z",
      paymentMethod: "pay_at_appointment",
      chargeKind: null,
      amountCents: 4000,
      status: "confirmed",
    });
    const againLogin = await post("/auth/tenant", {
      email: "fresh-owner@example.com",
      password: signup.payload.temporaryPassword,
    });
    const secondToken = decodeURIComponent(new URL(String((await post("/billing/connect-handoff", {
      tenantId: againLogin.payload.tenantId,
      session: againLogin.payload.session,
    })).payload.url)).hash.slice(3));
    const second = await POST(new Request("https://schedi-connect-production.up.railway.app/api/connect/handoff", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t: secondToken }),
    }));
    expect(second.headers.get("set-cookie") || "").toContain("s2.");
    const after = store.getBusiness(business!.id);
    expect(after.slug).toBe("fresh-shop");
    expect(after.ownerId).toBe(business!.ownerId);
    expect(store.listBookings(business!.id).map((row) => row.id)).toEqual([booking.id]);
  });

  it("does not let an owner rename their credential onto another tenant", async () => {
    const victim = await post("/billing/signup", {
      businessName: "Harbor Cuts",
      ownerName: "Victim Owner",
      ownerEmail: "victim-login@example.com",
      plan: "free",
      industry: "Services",
    });
    const attacker = await post("/billing/signup", {
      businessName: "Attacker Shop",
      ownerName: "Attacker",
      ownerEmail: "attacker-login@example.com",
      plan: "free",
      industry: "Services",
    });
    expect(victim.payload.slug).toBe("harbor-cuts");
    expect(attacker.payload.slug).toBe("attacker-shop");
    const attackerLogin = await post("/auth/tenant", {
      email: "attacker-login@example.com",
      password: attacker.payload.temporaryPassword,
    });
    const renamed = await post("/auth/rename", {
      session: attackerLogin.payload.session,
      fromId: "attacker-shop",
      toId: "harbor-cuts",
    });
    expect(renamed.status).toBe(409);
    const victimStill = await post("/auth/tenant", {
      email: "victim-login@example.com",
      password: victim.payload.temporaryPassword,
    });
    expect(victimStill.status).toBe(200);
    expect(victimStill.payload.tenantId).toBe("harbor-cuts");
    const attackerStill = await post("/auth/tenant", {
      email: "attacker-login@example.com",
      password: attacker.payload.temporaryPassword,
    });
    expect(attackerStill.status).toBe(200);
    expect(attackerStill.payload.tenantId).toBe("attacker-shop");
  });
});
