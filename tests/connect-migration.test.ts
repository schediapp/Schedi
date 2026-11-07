import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";
import { handleConnectRequest } from "../src/connect/server";
import { PORTAL_CSS } from "../src/connect/portal-css";
import { splitSql } from "../src/connect/durable-sql";
import { openStore } from "../src/lib/node-sqlite";
import { applyStripeEvent } from "../src/lib/webhooks";
import { memoryStore, seedProBusiness } from "./helpers";
// @ts-expect-error plain JS module
import { connectAppOrigin, connectPublicCheckoutUrl } from "../workers/schedi-email-worker/src/connect-origin.js";

const PLATFORM_SECRET = "whsec_platform_test_secret";
const CONNECT_SECRET = "whsec_connect_test_secret";
const stripe = new Stripe("sk_test_signature_only");

function signedEvent(payload: string, secret: string): { payload: string; header: string } {
  return {
    payload,
    header: stripe.webhooks.generateTestHeaderString({ payload, secret }),
  };
}

function eventBody(partial: Record<string, unknown>): string {
  return JSON.stringify({
    id: "evt_test",
    object: "event",
    api_version: "2026-09-30.endive",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    ...partial,
  });
}

describe("stripe webhook safety", () => {
  it("accepts either signing secret and rejects a raw-body or secret mismatch", async () => {
    const store = memoryStore();
    const { owner } = seedProBusiness(store, { email: "fail@example.com", slug: "fail" });
    store.setOwnerCustomer(owner.id, "cus_fail");
    const payload = eventBody({
      id: "evt_invoice",
      type: "invoice.payment_failed",
      data: { object: { object: "invoice", customer: "cus_fail" } },
    });
    const platform = signedEvent(payload, PLATFORM_SECRET);
    const connect = signedEvent(payload, CONNECT_SECRET);
    const env = { STRIPE_WEBHOOK_SECRET: PLATFORM_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT_SECRET };

    const fromPlatform = await handleConnectRequest(
      new Request("https://connect.test/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": platform.header },
        body: platform.payload,
      }),
      { store, env, stripe },
    );
    expect(fromPlatform.status).toBe(200);
    expect(store.getBusinessByOwner(owner.id)?.subscriptionStatus).toBe("past_due");

    store.setSubscription(owner.id, { status: "active", plan: "pro" });
    const replayPayload = eventBody({
      id: "evt_invoice_connect_secret",
      type: "invoice.payment_failed",
      data: { object: { object: "invoice", customer: "cus_fail" } },
    });
    const fromConnect = signedEvent(replayPayload, CONNECT_SECRET);
    const accepted = await handleConnectRequest(
      new Request("https://connect.test/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": fromConnect.header },
        body: fromConnect.payload,
      }),
      { store, env, stripe },
    );
    expect(accepted.status).toBe(200);

    const flipped = platform.payload.replace("cus_fail", "cus_evil");
    const rejected = await handleConnectRequest(
      new Request("https://connect.test/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": platform.header },
        body: flipped,
      }),
      { store, env, stripe },
    );
    expect(rejected.status).toBe(400);
    const missing = await handleConnectRequest(
      new Request("https://connect.test/api/webhooks/stripe", { method: "POST", body: payload }),
      { store, env, stripe },
    );
    expect(missing.status).toBe(400);
    const wrong = signedEvent(payload, "whsec_other");
    const denied = await handleConnectRequest(
      new Request("https://connect.test/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": wrong.header },
        body: wrong.payload,
      }),
      { store, env, stripe },
    );
    expect(denied.status).toBe(400);
    expect(store.getOwnerByStripeCustomer("cus_evil")).toBeNull();
  });

  it("does not apply a connected card failure to the owner subscription", async () => {
    const store = memoryStore();
    const { business, service } = seedProBusiness(store);
    const booking = store.createBooking({
      businessId: business.id,
      serviceId: service.id,
      clientName: "Casey",
      clientEmail: "casey@example.com",
      startsAt: "2026-10-06T13:00:00.000Z",
      paymentMethod: "card",
      chargeKind: "full",
      amountCents: 8000,
      status: "pending_payment",
    });
    const payload = eventBody({
      id: "evt_connected_fail",
      type: "payment_intent.payment_failed",
      account: business.stripeAccountId,
      data: { object: { object: "payment_intent", metadata: { schedi_booking_id: booking.id } } },
    });
    const signed = signedEvent(payload, CONNECT_SECRET);
    const response = await handleConnectRequest(
      new Request("https://connect.test/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": signed.header },
        body: signed.payload,
      }),
      {
        store,
        env: { STRIPE_WEBHOOK_SECRET: PLATFORM_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT_SECRET },
        stripe,
      },
    );
    expect(response.status).toBe(200);
    expect(store.getBooking(booking.id).status).toBe("payment_failed");
    expect(store.getBusiness(business.id).subscriptionStatus).toBe("active");
    const again = await handleConnectRequest(
      new Request("https://connect.test/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": signed.header },
        body: signed.payload,
      }),
      {
        store,
        env: { STRIPE_WEBHOOK_SECRET: PLATFORM_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT_SECRET },
        stripe,
      },
    );
    expect(again.status).toBe(200);
    expect(store.hasStripeEvent("evt_connected_fail")).toBe(true);
  });

  it("ignores an unpaid checkout and a replay, and retries a failed delivery once", async () => {
    const store = memoryStore();
    const { business, service } = seedProBusiness(store);
    const booking = store.createBooking({
      businessId: business.id,
      serviceId: service.id,
      clientName: "Casey",
      clientEmail: "casey@example.com",
      startsAt: "2026-10-06T13:00:00.000Z",
      paymentMethod: "card",
      chargeKind: "deposit",
      amountCents: 2500,
      status: "pending_payment",
    });
    const unpaid = {
      id: "evt_unpaid",
      type: "checkout.session.completed",
      account: "acct_northwind",
      data: {
        object: {
          mode: "payment",
          payment_status: "unpaid",
          metadata: { schedi_booking_id: booking.id },
        },
      },
    };
    await applyStripeEvent(store, unpaid as never);
    await applyStripeEvent(store, unpaid as never);
    expect(store.getBooking(booking.id).status).toBe("pending_payment");
    expect(store.hasStripeEvent("evt_unpaid")).toBe(true);

    let calls = 0;
    const paid = {
      id: "evt_retry",
      type: "checkout.session.completed",
      account: "acct_northwind",
      data: {
        object: {
          mode: "payment",
          payment_status: "paid",
          payment_intent: "pi_retry",
          metadata: {
            schedi_public_booking: "1",
            kind: "booking_payment",
            tenantId: "harbor",
            bookingIds: "HB-1003",
            schedi_booking_id: "HB-1003",
          },
        },
      },
    };
    await expect(
      applyStripeEvent(store, paid as never, {
        recordPublicCardPayment: async () => {
          calls += 1;
          throw new Error("schedi.app unavailable");
        },
      }),
    ).rejects.toThrow(/unavailable/);
    expect(store.hasStripeEvent("evt_retry")).toBe(false);
    await applyStripeEvent(store, paid as never, {
      recordPublicCardPayment: async () => {
        calls += 1;
      },
    });
    await applyStripeEvent(store, paid as never, {
      recordPublicCardPayment: async () => {
        calls += 1;
      },
    });
    expect(calls).toBe(2);
    expect(store.getBooking(booking.id).status).toBe("pending_payment");
  });

  it("does not run side effects for an in-flight delivery and reclaims a stale one", async () => {
    const store = memoryStore();
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const event = {
      id: "evt_flight",
      type: "checkout.session.completed",
      account: "acct_northwind",
      data: {
        object: {
          mode: "payment",
          payment_status: "paid",
          metadata: {
            schedi_public_booking: "1",
            kind: "booking_payment",
            tenantId: "harbor",
            bookingIds: "HB-9",
          },
        },
      },
    };
    let calls = 0;
    const first = applyStripeEvent(store, event as never, {
      recordPublicCardPayment: async () => {
        calls += 1;
        started();
        await gate;
      },
    });
    await ready;
    await expect(
      applyStripeEvent(store, event as never, {
        recordPublicCardPayment: async () => {
          calls += 1;
        },
      }),
    ).rejects.toMatchObject({ status: 500 });
    release();
    await first;
    expect(calls).toBe(1);

    const stale = store.claimStripeEvent("evt_stale", Date.now() - 10 * 60_000);
    expect(stale.status).toBe("claimed");
    await expect(applyStripeEvent(store, { ...event, id: "evt_stale" } as never, {
      recordPublicCardPayment: async () => {
        calls += 1;
      },
    })).rejects.toMatchObject({ status: 500 });
    expect(calls).toBe(1);
    store.freezeWriters();
    while (store.maintenance().admitted > 0) store.releaseAdmit();
    expect(store.releaseProcessingClaims()).toBe(1);
    await applyStripeEvent(store, { ...event, id: "evt_stale" } as never, {
      recordPublicCardPayment: async () => {
        calls += 1;
      },
    });
    expect(calls).toBe(2);
    expect(store.hasStripeEvent("evt_stale")).toBe(true);
  });
});

describe("connect snapshot", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips rows and refuses a non-empty or tampered restore", () => {
    const source = memoryStore();
    const { business, service } = seedProBusiness(source);
    source.createBooking({
      businessId: business.id,
      serviceId: service.id,
      clientName: "Casey",
      clientEmail: "casey@example.com",
      startsAt: "2026-10-06T13:00:00.000Z",
      paymentMethod: "card",
      chargeKind: "deposit",
      amountCents: 2500,
      status: "confirmed",
    });
    source.markStripeEvent("evt_old");
    const snapshot = source.consistentSnapshot();
    const pragma = source.pragmaStatus();
    expect(pragma).toEqual({ integrity: "ok", foreignKeyViolations: 0 });

    const dry = source.restoreConsistentSnapshot(snapshot, "dry-run");
    expect(dry.applied).toBe(false);
    expect(source.listBookings(business.id)).toHaveLength(1);

    expect(() => source.restoreConsistentSnapshot(snapshot, "empty-only")).toThrow(/not empty/);
    const tampered = { ...snapshot, checksum: "a".repeat(64) };
    expect(() => source.restoreConsistentSnapshot(tampered, "dry-run")).toThrow(/checksum/);

    const restored = memoryStore();
    const report = restored.restoreConsistentSnapshot(snapshot, "empty-only");
    expect(report.applied).toBe(true);
    expect(report.checksum).toBe(snapshot.checksum);
    expect(restored.consistentSnapshot().checksum).toBe(snapshot.checksum);
    expect(restored.getBusinessBySlug("northwind")?.stripeAccountId).toBe("acct_northwind");
    expect(restored.listBookings(restored.getBusinessBySlug("northwind")!.id)[0].status).toBe("confirmed");
    expect(restored.hasStripeEvent("evt_old")).toBe(true);
    expect(restored.pragmaStatus().foreignKeyViolations).toBe(0);
  });

  it("verifies a file copy without changing the source bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "schedi-snap-"));
    dirs.push(dir);
    const path = join(dir, "schedi.sqlite");
    const store = openStore(path);
    seedProBusiness(store);
    const before = readFileSync(path);
    const output = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/connect-snapshot.ts", "roundtrip", path],
      { cwd: join(import.meta.dirname, ".."), encoding: "utf8" },
    );
    const report = JSON.parse(output);
    expect(report.ok).toBe(true);
    expect(report.integrity).toBe("ok");
    expect(report.foreignKeyViolations).toBe(0);
    expect(report.rows.businesses).toBe(1);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(output).not.toContain("@");
  });
});

describe("connect worker routes", () => {
  it("requires the migration secret and a drained freeze before snapshot", async () => {
    const store = memoryStore();
    seedProBusiness(store);
    const env = { SCHEDI_MIGRATION_SECRET: "migration-secret", SCHEDI_CONNECT_PAID_SECRET: "paid-secret" };
    const denied = await handleConnectRequest(new Request("https://connect.test/api/admin/sqlite-snapshot"), {
      store,
      env,
    });
    expect(denied.status).toBe(401);
    const paidSecret = await handleConnectRequest(
      new Request("https://connect.test/api/admin/sqlite-snapshot", {
        headers: { "x-schedi-connect-secret": "paid-secret", "x-schedi-migration-secret": "paid-secret" },
      }),
      { store, env },
    );
    expect(paidSecret.status).toBe(401);
    const unfrozen = await handleConnectRequest(
      new Request("https://connect.test/api/admin/sqlite-snapshot", {
        headers: { "x-schedi-migration-secret": "migration-secret" },
      }),
      { store, env },
    );
    expect(unfrozen.status).toBe(409);
    const frozen = await handleConnectRequest(
      new Request("https://connect.test/api/admin/maintenance", {
        method: "POST",
        headers: { "x-schedi-migration-secret": "migration-secret", "content-type": "application/json" },
        body: JSON.stringify({ mode: "frozen" }),
      }),
      { store, env },
    );
    expect(frozen.status).toBe(200);
    const snapshotResponse = await handleConnectRequest(
      new Request("https://connect.test/api/admin/sqlite-snapshot", {
        headers: { "x-schedi-migration-secret": "migration-secret" },
      }),
      { store, env },
    );
    expect(snapshotResponse.status).toBe(200);
    expect(snapshotResponse.headers.get("content-disposition")).toContain("schedi-connect-snapshot.json");
    const snapshot = await snapshotResponse.json();
    const before = store.consistentSnapshot().checksum;
    const dry = await handleConnectRequest(
      new Request("https://connect.test/api/admin/sqlite-restore", {
        method: "POST",
        headers: { "x-schedi-migration-secret": "migration-secret", "content-type": "application/json" },
        body: JSON.stringify(snapshot),
      }),
      { store, env },
    );
    expect(dry.status).toBe(200);
    expect((await dry.json()).applied).toBe(false);
    expect(store.consistentSnapshot().checksum).toBe(before);
    const refused = await handleConnectRequest(
      new Request("https://connect.test/api/admin/sqlite-restore", {
        method: "POST",
        headers: {
          "x-schedi-migration-secret": "migration-secret",
          "x-schedi-restore-confirm": "restore-empty-database",
          "content-type": "application/json",
        },
        body: JSON.stringify(snapshot),
      }),
      { store, env },
    );
    expect(refused.status).toBe(409);
  });

  it("sets an HttpOnly session and keeps the handoff token out of the document", async () => {
    const store = memoryStore();
    const body = new URLSearchParams({
      intent: "sign-in",
      email: "owner@example.com",
      owner_name: "Ada Lovelace",
      business_name: "Analytical Engines",
    });
    const signedIn = await handleConnectRequest(
      new Request("https://connect.test/api/session", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
      { store },
    );
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("set-cookie")).toBeNull();
    expect(store.getOwnerByEmail("owner@example.com")).toBeNull();
    const owner = store.createOwner({ email: "owner@example.com", name: "Ada Lovelace" });
    store.createBusiness({ ownerId: owner.id, name: "Analytical Engines", slug: "analytical-engines" });
    const cookie = `schedi_session=${encodeURIComponent(store.createSession(owner.id))}; HttpOnly; Path=/`;
    const portal = await handleConnectRequest(
      new Request("https://connect.test/portal", { headers: { cookie } }),
      { store },
    );
    const html = await portal.text();
    expect(html).toContain("Analytical Engines");
    expect(html).toContain("Subscribe to Pro");
    expect(html).not.toContain("sk_");
    const created = store.getBusinessByOwner(store.getOwnerByEmail("owner@example.com")!.id)!;
    store.setPlanEntitlement(created.id, {
      plan: "pro",
      subscriptionStatus: "active",
      complimentaryPro: false,
      billingExempt: false,
    });
    store.setStripeAccount(created.id, null, { cardPaymentsStatus: null, payoutsStatus: null });
    const proPortal = await handleConnectRequest(
      new Request("https://connect.test/portal", { headers: { cookie } }),
      { store },
    );
    expect(await proPortal.text()).toContain("Set up Stripe");
    const handoff = await handleConnectRequest(new Request("https://connect.test/api/connect/handoff?t=super-secret-token"), {
      store,
    });
    const handoffHtml = await handoff.text();
    expect(handoff.headers.get("referrer-policy")).toBe("no-referrer");
    expect(handoffHtml).toContain("history.replaceState");
    expect(handoffHtml).not.toContain("super-secret-token");
    const script = await (await handleConnectRequest(new Request("https://connect.test/connect-dashboard.js"), { store })).text();
    expect(script).toContain("/api/connect/session");
    expect(script).toContain("account-onboarding");
    expect(script).toContain("notification-banner");
    expect(script).toContain("account-management");
    expect(script).toContain("payments");
    expect(script).toContain("payouts");
    expect(script).not.toContain("sk_");
  });

  it("reflects only schedi.app on public checkout", async () => {
    const store = memoryStore();
    const evil = await handleConnectRequest(
      new Request("https://connect.test/api/public-checkout", {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ slug: "nope" }),
      }),
      { store, stripe: null },
    );
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const allowed = await handleConnectRequest(
      new Request("https://connect.test/api/public-checkout", {
        method: "OPTIONS",
        headers: { origin: "https://schedi.app" },
      }),
      { store },
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://schedi.app");
  });
});

describe("caller origin defaults", () => {
  it("keeps Railway until CONNECT_APP_ORIGIN is an https origin", () => {
    expect(connectAppOrigin(undefined)).toBe("https://schedi-connect-production.up.railway.app");
    expect(connectPublicCheckoutUrl({})).toBe("https://schedi-connect-production.up.railway.app/api/public-checkout");
    expect(connectAppOrigin({ CONNECT_APP_ORIGIN: "https://connect.schedi.app/extra" })).toBe(
      "https://schedi-connect-production.up.railway.app",
    );
    expect(connectAppOrigin({ CONNECT_APP_ORIGIN: "https://connect.schedi.app" })).toBe("https://connect.schedi.app");
    expect(splitSql("PRAGMA foreign_keys = ON; CREATE TABLE t (id TEXT);")).toEqual([
      "PRAGMA foreign_keys = ON",
      "CREATE TABLE t (id TEXT)",
    ]);
  });

  it("keeps the migration worker off the existing script, routes, and D1 database", () => {
    const config = readFileSync(new URL("../workers/schedi-connect/wrangler.jsonc", import.meta.url), "utf8");
    expect(config).toContain('"name": "schedi-connect-migration"');
    expect(config).toContain('"account_id": "674c2b16e7eac42148f3c06c6e2c954f"');
    expect(config).toContain('"workers_dev": false');
    expect(config).toContain('"preview_urls": false');
    expect(config).toContain('"routes": []');
    expect(config).toContain('"CONNECT_OBJECT_NAME": "schedi-connect-migration"');
    expect(config).not.toContain("d1_databases");
    expect(config).not.toContain("database_id");
    expect(config).not.toContain("kv_namespaces");
    expect(config).not.toContain("r2_buckets");
    expect(config).not.toContain("schedi.app/*");
    expect(config).not.toContain("/billing/*");
    const site = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const routes = site.slice(site.indexOf('"routes"'));
    expect(routes).toContain('"pattern": "schedi.app/*"');
    expect(routes).toContain('"pattern": "www.schedi.app/*"');
    expect(routes).not.toContain("billing");
    expect(routes).not.toContain("auth");
  });

  it("keeps the worker portal CSS aligned with the Next stylesheet", () => {
    const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    expect(PORTAL_CSS).toBe(css);
  });
});
