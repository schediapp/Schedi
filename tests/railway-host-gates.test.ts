import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportStripeMigrationSet } from "../src/lib/stripe-export";
import { withReadRefresh } from "../src/lib/request-gate";
import { openStore } from "../src/lib/node-sqlite";
import { applyMissingEvents } from "../src/lib/reconcile";
import { applyStripeEvent } from "../src/lib/webhooks";
import { memoryStore, seedProBusiness } from "./helpers";
import { DatabaseSync } from "node:sqlite";

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { value };
    },
  }),
}));

const dir = mkdtempSync(join(tmpdir(), "schedi-railway-"));
process.env.SCHEDI_DB_PATH = join(dir, "schedi.sqlite");
process.env.SCHEDI_MIGRATION_SECRET = "migration-secret";
process.env.SCHEDI_CONNECT_PAID_SECRET = "paid-secret";
process.env.SCHEDI_SEED = "0";
process.env.NODE_ENV = "production";

afterEach(() => {
  cookieJar.clear();
});

describe("Railway Next host gates", () => {
  beforeAll(() => {
    rmSync(process.env.SCHEDI_DB_PATH || "", { force: true });
  });

  it("refuses email sign-in, keeps sign-out, and still opens a session from a verified handoff", async () => {
    const { POST: sessionPost } = await import("../src/app/api/session/route");
    const { POST: handoffPost } = await import("../src/app/api/connect/handoff/route");
    const { signConnectHandoff } = await import("../workers/schedi-email-worker/src/connect-handoff.js");
    const { getStore } = await import("../src/lib/store");
    const store = getStore();
    const taken = await sessionPost(new Request("https://schedi-connect-production.up.railway.app/api/session", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "intent=sign-in&email=owner@example.com&owner_name=Ada&business_name=Engines",
    }));
    expect(taken.status).toBe(303);
    expect(taken.headers.get("set-cookie")).toBeNull();
    expect(store.getOwnerByEmail("owner@example.com")).toBeNull();

    const now = Date.now();
    const token = await signConnectHandoff({
      v: 1,
      slug: "northwind",
      email: "owner@example.com",
      ownerName: "Ada",
      businessName: "Engines",
      nonce: "nonce-handoff-railway-01",
      exp: Math.floor(now / 1000) + 60,
    }, "paid-secret");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      slug: "northwind",
      name: "Engines",
      ownerEmail: "owner@example.com",
      ownerName: "Ada",
      plan: "pro",
      subscriptionStatus: "active",
      cardEntitled: true,
    }), { status: 200 }));
    try {
      const handed = await handoffPost(new Request("https://schedi-connect-production.up.railway.app/api/connect/handoff", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ t: token }),
      }));
      expect(handed.status).toBe(303);
      expect(handed.headers.get("set-cookie") || "").toContain("schedi_session=");
      expect(handed.headers.get("location") || "").toContain("/portal");
      expect(store.getOwnerByEmail("owner@example.com")?.email).toBe("owner@example.com");
    } finally {
      fetchSpy.mockRestore();
    }

    cookieJar.set("schedi_session", "not-the-real-token");
    const signedOut = await sessionPost(new Request("https://schedi-connect-production.up.railway.app/api/session", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "intent=sign-out",
    }));
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("set-cookie") || "").toContain("Max-Age=0");
  });

  it("freezes Railway writers, exports a snapshot, and skips a booking refresh", async () => {
    const { POST: maintenance } = await import("../src/app/api/admin/maintenance/route");
    const { GET: snapshot } = await import("../src/app/api/admin/sqlite-snapshot/route");
    const { POST: webhook } = await import("../src/app/api/webhooks/stripe/route");
    const { getStore } = await import("../src/lib/store");
    const store = getStore();
    const early = await snapshot(new Request("https://schedi-connect-production.up.railway.app/api/admin/sqlite-snapshot", {
      headers: { "x-schedi-migration-secret": "migration-secret" },
    }));
    expect(early.status).toBe(409);
    const frozen = await maintenance(new Request("https://schedi-connect-production.up.railway.app/api/admin/maintenance", {
      method: "POST",
      headers: { "content-type": "application/json", "x-schedi-migration-secret": "migration-secret" },
      body: JSON.stringify({ mode: "frozen" }),
    }));
    expect(frozen.status).toBe(200);
    let refreshed = false;
    const kept = await withReadRefresh(store, "stored", async () => {
      refreshed = true;
      return "fresh";
    });
    expect(kept).toBe("stored");
    expect(refreshed).toBe(false);
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe("sk_test_railway_gate");
    process.env.STRIPE_SECRET_KEY = "sk_test_railway_gate";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_railway_gate";
    const payload = JSON.stringify({
      id: "evt_frozen_host",
      object: "event",
      api_version: "2026-09-30.endive",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "invoice.payment_failed",
      data: { object: { object: "invoice", customer: "cus_missing" } },
    });
    const blocked = await webhook(new Request("https://schedi-connect-production.up.railway.app/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_railway_gate" }) },
      body: payload,
    }));
    expect(blocked.status).toBe(503);
    const copied = await snapshot(new Request("https://schedi-connect-production.up.railway.app/api/admin/sqlite-snapshot", {
      headers: { "x-schedi-migration-secret": "migration-secret" },
    }));
    expect(copied.status).toBe(200);
    const body = await copied.json() as { tables: { owners: unknown[]; maintenance: Array<{ frozen: number; admitted: number }> } };
    expect(body.tables.owners.length).toBeGreaterThan(0);
    expect(body.tables.maintenance[0]?.frozen).toBe(1);
    expect(body.tables.maintenance[0]?.admitted).toBe(0);
    store.openWriters();
  });
});

describe("schema compatibility and crash recovery", () => {
  it("opens a f234d253-shaped database without dropping the owner row", () => {
    const path = join(dir, "old.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE owners (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        stripe_customer_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE businesses (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        plan TEXT NOT NULL, subscription_status TEXT NOT NULL, stripe_subscription_id TEXT,
        stripe_account_id TEXT, card_payments_status TEXT, payouts_status TEXT,
        deposit_enabled INTEGER NOT NULL DEFAULT 0, deposit_amount_cents INTEGER,
        cash_app TEXT, zelle TEXT, venmo TEXT, paypal TEXT, pay_at_appointment INTEGER NOT NULL DEFAULT 1,
        country TEXT NOT NULL DEFAULT 'US', created_at TEXT NOT NULL
      );
      CREATE TABLE services (
        id TEXT PRIMARY KEY, business_id TEXT NOT NULL, name TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL, price_cents INTEGER NOT NULL
      );
      CREATE TABLE bookings (
        id TEXT PRIMARY KEY, business_id TEXT NOT NULL, service_id TEXT NOT NULL,
        client_name TEXT NOT NULL, client_email TEXT NOT NULL, starts_at TEXT NOT NULL,
        payment_method TEXT NOT NULL, charge_kind TEXT, amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL, stripe_checkout_session_id TEXT, stripe_payment_intent_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (token TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE stripe_events (id TEXT PRIMARY KEY, processed_at TEXT NOT NULL);
      CREATE TABLE connect_handoffs (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      INSERT INTO owners (id, email, name, created_at) VALUES ('owner-1', 'owner@example.com', 'Ada', '2026-11-01T00:00:00.000Z');
      INSERT INTO stripe_events (id, processed_at) VALUES ('evt_old', '2026-11-01T00:00:00.000Z');
    `);
    raw.close();
    const store = openStore(path);
    expect(store.schemaReport()).toEqual({ ok: true, missing: [] });
    expect(store.getOwnerByEmail("owner@example.com")?.name).toBe("Ada");
    expect(store.hasStripeEvent("evt_old")).toBe(true);
    expect(store.maintenance().frozen).toBe(false);
  });

  it("releases a crashed processing claim only after a drained freeze, then applies the event once", async () => {
    const store = openStore(join(dir, "crash.sqlite"));
    const event = {
      id: "evt_crash",
      type: "invoice.payment_failed",
      created: 1_700_000_000,
      data: { object: { customer: "cus_missing" } },
    };
    const claim = store.claimStripeEvent(event.id);
    expect(claim.status).toBe("claimed");
    await expect(applyStripeEvent(store, event as never)).rejects.toMatchObject({ status: 500 });
    expect(store.hasStripeEvent(event.id)).toBe(false);
    store.freezeWriters();
    expect(store.releaseProcessingClaims()).toBe(1);
    await applyStripeEvent(store, event as never);
    await applyStripeEvent(store, event as never);
    expect(store.hasStripeEvent(event.id)).toBe(true);
  });

  it("lets a same-second subscription deletion beat an update, and not the reverse", async () => {
    const created = 1_700_000_100;
    const forward = memoryStore();
    const first = seedProBusiness(forward, { stripeSubscriptionId: "sub_same" });
    const updated = subscriptionEvent("evt_updated", "customer.subscription.updated", created, first.owner.id, "active");
    const deleted = subscriptionEvent("evt_deleted", "customer.subscription.deleted", created, first.owner.id, "canceled");
    await applyMissingEvents(forward, [deleted, updated]);
    expect(forward.getBusinessByOwner(first.owner.id)?.subscriptionStatus).toBe("canceled");

    const reverse = memoryStore();
    const second = seedProBusiness(reverse, { stripeSubscriptionId: "sub_same" });
    await applyStripeEvent(reverse, updatedFor(second.owner.id) as never);
    await applyStripeEvent(reverse, deletedFor(second.owner.id) as never);
    expect(reverse.getBusinessByOwner(second.owner.id)?.subscriptionStatus).toBe("canceled");
    await applyStripeEvent(reverse, updatedFor(second.owner.id) as never);
    expect(reverse.getBusinessByOwner(second.owner.id)?.subscriptionStatus).toBe("canceled");
  });

  it("keeps a frozen reconcile admitted until the async apply finishes", async () => {
    const store = memoryStore();
    store.freezeWriters();
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const running = (async () => {
      expect(store.beginFrozenWrite()).toBe(true);
      await gate;
      store.releaseAdmit();
    })();
    expect(store.beginFrozenWrite()).toBe(false);
    expect(store.maintenance().admitted).toBe(1);
    releaseGate();
    await running;
    expect(store.maintenance().admitted).toBe(0);
  });

  it("replays a subscription update after the local write rolls back with the fence", async () => {
    const store = memoryStore();
    const seeded = seedProBusiness(store, { stripeSubscriptionId: "sub_same", stripeCustomerId: "cus_same" });
    const event = subscriptionEvent("evt_past_due", "customer.subscription.updated", 1_700_000_200, seeded.owner.id, "past_due");
    const deps = { failLocalWrite: true };
    await expect(applyStripeEvent(store, event as never, deps)).rejects.toThrow(/injected_local_write_failure/);
    expect(store.getBusinessByOwner(seeded.owner.id)?.subscriptionStatus).toBe("active");
    expect(store.hasStripeEvent(event.id)).toBe(false);
    await applyStripeEvent(store, event as never, deps);
    expect(store.getBusinessByOwner(seeded.owner.id)?.subscriptionStatus).toBe("past_due");
    expect(store.hasStripeEvent(event.id)).toBe(true);
  });

  it("does not let an older invoice replace a newer subscription update, deletion, or a different subscription", async () => {
    const newer = 1_700_000_300;
    const older = 1_700_000_100;
    const active = memoryStore();
    const first = seedProBusiness(active, { stripeSubscriptionId: "sub_same" });
    active.setOwnerCustomer(first.owner.id, "cus_same");
    await applyStripeEvent(active, subscriptionEvent("evt_live", "customer.subscription.updated", newer, first.owner.id, "active") as never);
    await applyStripeEvent(active, invoiceEvent("evt_old_invoice", older, "sub_same", "cus_same") as never);
    expect(active.getBusinessByOwner(first.owner.id)?.subscriptionStatus).toBe("active");

    const ended = memoryStore();
    const second = seedProBusiness(ended, { stripeSubscriptionId: "sub_same" });
    ended.setOwnerCustomer(second.owner.id, "cus_same");
    await applyStripeEvent(ended, subscriptionEvent("evt_deleted", "customer.subscription.deleted", newer, second.owner.id, "canceled") as never);
    await applyStripeEvent(ended, invoiceEvent("evt_same_second", newer, "sub_same", "cus_same") as never);
    expect(ended.getBusinessByOwner(second.owner.id)?.subscriptionStatus).toBe("canceled");

    const replaced = memoryStore();
    const third = seedProBusiness(replaced, { stripeSubscriptionId: "sub_new" });
    replaced.setOwnerCustomer(third.owner.id, "cus_same");
    await applyStripeEvent(replaced, invoiceEvent("evt_previous_sub", newer + 10, "sub_old", "cus_same") as never);
    expect(replaced.getBusinessByOwner(third.owner.id)?.subscriptionStatus).toBe("active");
    expect(replaced.getBusinessByOwner(third.owner.id)?.stripeSubscriptionId).toBe("sub_new");

    const recovered = memoryStore();
    const fourth = seedProBusiness(recovered, { stripeSubscriptionId: "sub_same" });
    recovered.setOwnerCustomer(fourth.owner.id, "cus_same");
    await applyStripeEvent(recovered, invoiceEvent("evt_invoice_first", older, "sub_same", "cus_same") as never);
    expect(recovered.getBusinessByOwner(fourth.owner.id)?.subscriptionStatus).toBe("past_due");
    await applyStripeEvent(recovered, subscriptionEvent("evt_recovered", "customer.subscription.updated", newer, fourth.owner.id, "active") as never);
    expect(recovered.getBusinessByOwner(fourth.owner.id)?.subscriptionStatus).toBe("active");
    await applyStripeEvent(recovered, invoiceEvent("evt_invoice_same_second", newer, "sub_same", "cus_same") as never);
    expect(recovered.getBusinessByOwner(fourth.owner.id)?.subscriptionStatus).toBe("active");

    const removed = memoryStore();
    const fifth = seedProBusiness(removed, { stripeSubscriptionId: "sub_same" });
    removed.setOwnerCustomer(fifth.owner.id, "cus_same");
    await applyStripeEvent(removed, invoiceEvent("evt_invoice_before_delete", newer, "sub_same", "cus_same") as never);
    expect(removed.getBusinessByOwner(fifth.owner.id)?.subscriptionStatus).toBe("past_due");
    await applyStripeEvent(removed, subscriptionEvent("evt_delete_same_second", "customer.subscription.deleted", newer, fifth.owner.id, "canceled") as never);
    expect(removed.getBusinessByOwner(fifth.owner.id)?.subscriptionStatus).toBe("canceled");

    const unbound = memoryStore();
    const sixth = seedProBusiness(unbound, { stripeSubscriptionId: "sub_same" });
    unbound.setOwnerCustomer(sixth.owner.id, "cus_same");
    await applyStripeEvent(unbound, invoiceEvent("evt_invoice_unbound", newer, "", "cus_same") as never);
    expect(unbound.getBusinessByOwner(sixth.owner.id)?.subscriptionStatus).toBe("active");
  });

  it("clears a crash-stuck admitted count only while frozen", () => {
    const store = memoryStore();
    store.noteCrashedAdmit();
    expect(() => store.clearStuckAdmitted()).toThrow(/frozen/);
    store.freezeWriters();
    expect(store.clearStuckAdmitted()).toBe(1);
    expect(store.maintenance().admitted).toBe(0);
    store.tryAdmit();
    expect(store.recoverAdmittedAfterRestart()).toBe(0);
    store.openWriters();
    store.tryAdmit();
    expect(store.recoverAdmittedAfterRestart()).toBe(1);
    expect(store.maintenance().admitted).toBe(0);
  });
});

function subscriptionEvent(
  id: string,
  type: string,
  created: number,
  ownerId: string,
  status: string,
) {
  return {
    id,
    type,
    created,
    data: {
      object: {
        id: "sub_same",
        object: "subscription",
        status,
        customer: "cus_same",
        metadata: { schedi_owner_id: ownerId, plan: "pro" },
      },
    },
  };
}

function updatedFor(ownerId: string) {
  return subscriptionEvent("evt_updated", "customer.subscription.updated", 1_700_000_100, ownerId, "active");
}

function deletedFor(ownerId: string) {
  return subscriptionEvent("evt_deleted", "customer.subscription.deleted", 1_700_000_100, ownerId, "canceled");
}

function invoiceEvent(id: string, created: number, subscriptionId: string, customerId: string) {
  return {
    id,
    type: "invoice.payment_failed",
    created,
    data: {
      object: {
        id: "in_" + id,
        object: "invoice",
        customer: customerId,
        subscription: subscriptionId,
      },
    },
  };
}

describe("stripe export pagination", () => {
  it("keeps connected-account events separate from platform events", async () => {
    const pages: Record<string, { data: unknown[]; has_more: boolean }> = {
      "/v1/events?limit=100": {
        data: [{ id: "evt_platform", type: "invoice.payment_failed", created: 10, data: { object: { customer: "cus" } } }],
        has_more: false,
      },
      "/v2/core/accounts?limit=100": {
        data: [{ id: "acct_one" }, { id: "acct_two" }],
        has_more: false,
      },
      "acct_one": {
        data: [{ id: "evt_connect", type: "checkout.session.completed", created: 11, data: { object: { id: "cs" } } }],
        has_more: false,
      },
      "acct_two": { data: [], has_more: false },
    };
    const exported = await exportStripeMigrationSet({
      get: async (path, accountId) => pages[accountId || path] || { data: [], has_more: false },
    });
    expect(exported.accountIds).toEqual(["acct_one", "acct_two"]);
    expect(exported.platformEvents.map((event) => event.id)).toEqual(["evt_platform"]);
    expect(exported.connectEvents[0]).toMatchObject({ id: "evt_connect", account: "acct_one" });
    expect(exported.platformEvents[0]?.account).toBeNull();
  });

  it("follows a v2 next_page_url and does not send starting_after for accounts", async () => {
    const calls: string[] = [];
    const exported = await exportStripeMigrationSet({
      get: async (path) => {
        calls.push(path);
        if (path === "/v2/core/accounts?limit=100") {
          return { data: [{ id: "acct_page" }], next_page_url: "/v2/core/accounts?page=cursor-2" };
        }
        if (path === "/v2/core/accounts?page=cursor-2") {
          return { data: [{ id: "acct_last" }], next_page_url: null };
        }
        return { data: [], has_more: false };
      },
    });
    expect(exported.accountIds).toEqual(["acct_page", "acct_last"]);
    expect(calls.some((path) => path.includes("starting_after"))).toBe(false);
  });
});
