import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { memoryStore, seedProBusiness } from "./helpers";

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

  it("restores a populated relational snapshot and applies one signed webhook under concurrency", async () => {
    const populated = await start("schedi-connect-populated-test");
    try {
      const base = `http://127.0.0.1:${populated.port}`;
      const source = memoryStore();
      const seeded = seedProBusiness(source, { slug: "harbor", stripeAccountId: "acct_harbor" });
      const booking = source.createBooking({
        businessId: seeded.business.id,
        serviceId: seeded.service.id,
        clientName: "Casey",
        clientEmail: "casey@example.com",
        startsAt: "2026-11-08T15:00:00.000Z",
        paymentMethod: "card",
        chargeKind: "full",
        amountCents: 8000,
        status: "pending_payment",
      });
      source.freezeWriters();
      const snapshot = source.consistentSnapshot();
      expect(snapshot.tables.bookings).toHaveLength(1);
      expect(snapshot.tables.services[0]?.business_id).toBe(seeded.business.id);

      const freeze = await fetch(`${base}/api/admin/maintenance`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-schedi-migration-secret": "migration-secret" },
        body: JSON.stringify({ mode: "frozen" }),
      });
      expect(freeze.status).toBe(200);
      const restored = await fetch(`${base}/api/admin/sqlite-restore`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-schedi-migration-secret": "migration-secret",
          "x-schedi-restore-confirm": "restore-empty-database",
        },
        body: JSON.stringify(snapshot),
      });
      expect(restored.status, await restored.clone().text()).toBe(200);
      const opened = await fetch(`${base}/api/admin/maintenance`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-schedi-migration-secret": "migration-secret",
          "x-schedi-maintenance-confirm": "open-writers",
        },
        body: JSON.stringify({ mode: "open" }),
      });
      expect(opened.status).toBe(200);

      const payload = JSON.stringify({
        id: "evt_populated",
        object: "event",
        api_version: "2026-09-30.endive",
        created: 1_700_000_200,
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        type: "checkout.session.completed",
        account: "acct_harbor",
        data: {
          object: {
            object: "checkout.session",
            id: "cs_populated",
            mode: "payment",
            payment_status: "paid",
            payment_intent: "pi_populated",
            metadata: { schedi_booking_id: booking.id },
          },
        },
      });
      const header = stripe.webhooks.generateTestHeaderString({ payload, secret: PLATFORM_SECRET });
      const send = () => fetch(`${base}/api/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": header },
        body: payload,
      });
      const [first, second] = await Promise.all([send(), send()]);
      const statuses = [first.status, second.status].sort();
      expect(statuses.every((status) => status === 200 || status === 500), `${await first.clone().text()} | ${await second.clone().text()}`).toBe(true);
      expect(statuses).toContain(200);
      const replay = await send();
      expect(replay.status).toBe(200);

      const againFreeze = await fetch(`${base}/api/admin/maintenance`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-schedi-migration-secret": "migration-secret" },
        body: JSON.stringify({ mode: "frozen" }),
      });
      expect(againFreeze.status).toBe(200);
      const crashed = await fetch(`${base}/api/admin/maintenance`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-schedi-migration-secret": "migration-secret" },
        body: JSON.stringify({ mode: "note-crash" }),
      });
      expect(crashed.status).toBe(200);
      const blocked = await fetch(`${base}/api/admin/sqlite-snapshot`, {
        headers: { "x-schedi-migration-secret": "migration-secret" },
      });
      expect(blocked.status).toBe(409);
      const cleared = await fetch(`${base}/api/admin/maintenance`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-schedi-migration-secret": "migration-secret",
          "x-schedi-maintenance-confirm": "clear-stuck-admitted",
        },
        body: JSON.stringify({ mode: "clear-admitted" }),
      });
      expect(cleared.status).toBe(200);
      const snap = await fetch(`${base}/api/admin/sqlite-snapshot`, {
        headers: { "x-schedi-migration-secret": "migration-secret" },
      });
      expect(snap.status).toBe(200);
      const body = await snap.json() as {
        tables: {
          owners: unknown[];
          businesses: Array<{ id: string }>;
          services: Array<{ business_id: string }>;
          bookings: Array<{ id: string; status: string; service_id: string }>;
          stripe_events: Array<{ id: string; state: string }>;
        };
      };
      expect(body.tables.owners).toHaveLength(1);
      expect(body.tables.services[0]?.business_id).toBe(body.tables.businesses[0]?.id);
      expect(body.tables.bookings[0]).toMatchObject({ id: booking.id, status: "confirmed", service_id: seeded.service.id });
      expect(body.tables.stripe_events.filter((row) => row.id === "evt_populated" && row.state === "done")).toHaveLength(1);
    } finally {
      await populated.stop();
    }
  }, 120_000);
});