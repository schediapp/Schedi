import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";

const require = createRequire(import.meta.url);
const { unstable_dev } = require("../workers/schedi-email-worker/node_modules/wrangler") as {
  unstable_dev: (script: string, options?: Record<string, unknown>) => Promise<{
    port: number;
    stop: () => Promise<void>;
    fetch: (input?: string, init?: RequestInit) => Promise<Response>;
  }>;
};

const PLATFORM_SECRET = "whsec_platform_workerd";
const stripe = new Stripe("sk_test_workerd");

function start(objectName: string) {
  return unstable_dev("workers/schedi-connect/src/index.ts", {
    config: "workers/schedi-connect/wrangler.jsonc",
    local: true,
    compatibilityDate: "2026-10-03",
    port: 0,
    inspectorPort: 0,
    persist: false,
    logLevel: "error",
    vars: {
      NODE_ENV: "test",
      SCHEDI_SEED: "0",
      CONNECT_OBJECT_NAME: objectName,
      SCHEDI_MIGRATION_SECRET: "migration-secret",
      STRIPE_WEBHOOK_SECRET: PLATFORM_SECRET,
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_workerd",
      SCHEDI_CONNECT_PAID_SECRET: "paid-secret",
      SCHEDI_CONNECT_PAID_URL: "http://127.0.0.1:9/paid",
      SCHEDI_CONNECT_READY_URL: "http://127.0.0.1:9/ready",
      CONNECT_TEST_DELAY_MS: "80",
      STRIPE_SECRET_KEY: "sk_test_workerd",
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_workerd",
    },
    experimental: { disableExperimentalWarning: true },
  });
}

describe("schedi-connect workerd", () => {
  let live: Awaited<ReturnType<typeof start>>;
  let scratch: Awaited<ReturnType<typeof start>>;

  beforeAll(async () => {
    live = await start("schedi-connect-test");
    scratch = await start("schedi-connect-restore-test");
  }, 180_000);

  afterAll(async () => {
    await live?.stop();
    await scratch?.stop();
  });

  it("freezes inside the Durable Object, rejects email sign-in, and restores on a second object", async () => {
    const liveUrl = (path: string) => `http://127.0.0.1:${live.port}${path}`;
    const scratchUrl = (path: string) => `http://127.0.0.1:${scratch.port}${path}`;
    const [first, second] = await Promise.all([
      fetch(liveUrl("/api/health"), { method: "POST" }),
      fetch(liveUrl("/api/health"), { method: "POST" }),
    ]);
    const left = await first.json() as { paidCallbackHost: string; emailSignIn: boolean };
    const right = await second.json() as { paidCallbackHost: string; emailSignIn: boolean };
    expect(left.emailSignIn).toBe(false);
    expect(left.paidCallbackHost).toBe(right.paidCallbackHost);
    expect(left.paidCallbackHost).toBe("127.0.0.1:9");

    const email = await fetch(liveUrl("/api/session"), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "intent=sign-in&email=owner@example.com&owner_name=Ada&business_name=Engines",
    });
    expect(email.status).toBe(303);
    expect(email.headers.get("set-cookie")).toBeNull();

    const freeze = await fetch(liveUrl("/api/admin/maintenance"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-schedi-migration-secret": "migration-secret" },
      body: JSON.stringify({ mode: "frozen" }),
    });
    expect(freeze.status).toBe(200);

    const payload = JSON.stringify({
      id: "evt_workerd",
      object: "event",
      api_version: "2026-09-30.endive",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "invoice.payment_failed",
      data: { object: { object: "invoice", customer: "cus_missing" } },
    });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: PLATFORM_SECRET });
    const webhook = await fetch(liveUrl("/api/webhooks/stripe"), {
      method: "POST",
      headers: { "stripe-signature": header },
      body: payload,
    });
    expect(webhook.status).toBe(503);

    const snapshotResponse = await fetch(liveUrl("/api/admin/sqlite-snapshot"), {
      headers: { "x-schedi-migration-secret": "migration-secret" },
    });
    expect(snapshotResponse.status, await snapshotResponse.clone().text()).toBe(200);
    expect(["ok", "unsupported"]).toContain(snapshotResponse.headers.get("x-schedi-integrity"));
    expect(["0", "-1"]).toContain(snapshotResponse.headers.get("x-schedi-foreign-keys"));
    const snapshot = await snapshotResponse.json() as { checksum: string; tables: { stripe_events: unknown[] } };
    expect(snapshot.tables.stripe_events).toEqual([]);

    const scratchFreeze = await fetch(scratchUrl("/api/admin/maintenance"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-schedi-migration-secret": "migration-secret" },
      body: JSON.stringify({ mode: "frozen" }),
    });
    expect(scratchFreeze.status).toBe(200);
    const restored = await fetch(scratchUrl("/api/admin/sqlite-restore"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-schedi-migration-secret": "migration-secret",
        "x-schedi-restore-confirm": "restore-empty-database",
      },
      body: JSON.stringify(snapshot),
    });
    expect(restored.status).toBe(200);
    const again = await fetch(scratchUrl("/api/admin/sqlite-snapshot"), {
      headers: { "x-schedi-migration-secret": "migration-secret" },
    });
    const copy = await again.json() as { checksum: string };
    expect(copy.checksum).toBe(snapshot.checksum);
  }, 60_000);
});