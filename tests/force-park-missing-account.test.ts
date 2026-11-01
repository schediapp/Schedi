import { readFileSync } from "node:fs";
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { forceParkMissingConnectedAccount, SCHEDI_PLATFORM_ACCOUNT_ID } from "../src/lib/connect";
import { SchediError } from "../src/lib/errors";
import { createFakeStripe, memoryStore, seedProBusiness } from "./helpers";

const STALE_ID = "acct_1UNlXiGitAq7DPgt";

function missingAccountError(accountId: string) {
  return Object.assign(new Error(`No such account: '${accountId}'`), {
    code: "resource_missing",
    statusCode: 404,
  });
}

describe("admin force-park of a missing connected account", () => {
  it("uses the same connect secret header as the readiness backfill", () => {
    const route = readFileSync(new URL("../src/app/api/admin/force-park-missing-account/route.ts", import.meta.url), "utf8");
    const backfill = readFileSync(new URL("../src/app/api/admin/connect-ready-backfill/route.ts", import.meta.url), "utf8");
    expect(route).toContain("connectAdminAuthorized");
    expect(route).toContain('request.headers.get("x-schedi-connect-secret")');
    expect(route).toContain("process.env.SCHEDI_CONNECT_PAID_SECRET");
    expect(backfill).toContain('request.headers.get("x-schedi-connect-secret")');
    expect(backfill).toContain("process.env.SCHEDI_CONNECT_PAID_SECRET");
  });

  it("parks immediately when Stripe says the account is gone, without the live-key gate or the hour timer", async () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store, {
      slug: "schedi",
      stripeAccountId: STALE_ID,
      cardPaymentsStatus: "active",
      payoutsStatus: "active",
    });
    const stripe = createFakeStripe();
    let platformLookups = 0;
    stripe.v2.core.accounts.retrieve = (async () => {
      throw missingAccountError(STALE_ID);
    }) as typeof stripe.v2.core.accounts.retrieve;
    stripe.accounts = {
      retrieve: async () => {
        platformLookups += 1;
        return { id: SCHEDI_PLATFORM_ACCOUNT_ID };
      },
    } as typeof stripe.accounts;
    const previousSecret = process.env.SCHEDI_CONNECT_PAID_SECRET;
    process.env.SCHEDI_CONNECT_PAID_SECRET = "connect-secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      const result = await forceParkMissingConnectedAccount(store, stripe, { slug: "Schedi" });
      expect(platformLookups).toBe(0);
      expect(result).toMatchObject({
        ok: true,
        parked: true,
        alreadyCleared: false,
        published: true,
        slug: "schedi",
        businessId: business.id,
        stripeAccountIdMissing: STALE_ID,
      });
      const saved = store.getBusiness(business.id);
      expect(saved.stripeAccountId).toBeNull();
      expect(saved.stripeAccountIdMissing).toBe(STALE_ID);
      expect(saved.stripeAccountMissingAt).toBeNull();
      expect(saved.cardPaymentsStatus).toBeNull();
      expect(saved.payoutsStatus).toBeNull();
      const published = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(published).toEqual({ slug: "schedi", ready: false, status: "not_started" });
      expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-schedi-connect-secret": "connect-secret" });
    } finally {
      fetchSpy.mockRestore();
      if (previousSecret === undefined) delete process.env.SCHEDI_CONNECT_PAID_SECRET;
      else process.env.SCHEDI_CONNECT_PAID_SECRET = previousSecret;
    }
  });

  it("parks a miss that was already noted without waiting out the hour", async () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store, { slug: "schedi", stripeAccountId: STALE_ID });
    const notedAt = Date.parse("2026-11-01T12:00:00.000Z");
    store.noteStripeAccountMiss(business.id, notedAt);
    const stripe = createFakeStripe();
    stripe.v2.core.accounts.retrieve = (async () => {
      throw missingAccountError(STALE_ID);
    }) as typeof stripe.v2.core.accounts.retrieve;
    const published: Array<{ slug: string; ready: boolean; status?: string }> = [];
    const result = await forceParkMissingConnectedAccount(
      store,
      stripe,
      { businessId: business.id },
      async (slug, ready, status) => {
        published.push({ slug, ready, status });
      },
    );
    expect(result.parked).toBe(true);
    expect(result.stripeAccountIdMissing).toBe(STALE_ID);
    expect(store.getBusiness(business.id).stripeAccountMissingAt).toBeNull();
    expect(published).toEqual([{ slug: "schedi", ready: false, status: "not_started" }]);
  });

  it("does not park when Stripe still has the connected account", async () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store, { slug: "schedi", stripeAccountId: STALE_ID, cardPaymentsStatus: "active" });
    store.noteStripeAccountMiss(business.id, Date.parse("2026-11-01T12:00:00.000Z"));
    const stripe = createFakeStripe();
    stripe.v2.core.accounts.retrieve = (async () => ({
      id: STALE_ID,
      configuration: { merchant: { capabilities: { card_payments: { status: "active" } } } },
    })) as typeof stripe.v2.core.accounts.retrieve;
    const published: string[] = [];
    const error = await forceParkMissingConnectedAccount(store, stripe, { slug: "schedi", businessId: business.id }, async () => {
      published.push("published");
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchediError);
    expect(error).toMatchObject({ status: 409, message: "Connected account still exists. Refusing to park." });
    const saved = store.getBusiness(business.id);
    expect(saved.stripeAccountId).toBe(STALE_ID);
    expect(saved.stripeAccountIdMissing ?? null).toBeNull();
    expect(saved.cardPaymentsStatus).toBe("active");
    expect(published).toEqual([]);
  });

  it("does not park on a Stripe error that is not a missing account", async () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store, { slug: "schedi", stripeAccountId: STALE_ID });
    const stripe = createFakeStripe();
    stripe.v2.core.accounts.retrieve = (async () => {
      throw Object.assign(new Error("The account was not found"), { statusCode: 404 });
    }) as typeof stripe.v2.core.accounts.retrieve;
    await expect(forceParkMissingConnectedAccount(store, stripe, { slug: "schedi" }, async () => {
      throw new Error("should not publish");
    })).rejects.toThrow(/Could not confirm the connected account is missing/);
    expect(store.getBusiness(business.id).stripeAccountId).toBe(STALE_ID);
  });

  it("returns already-cleared and does not call Stripe when the account id is gone", async () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store, {
      slug: "schedi",
      stripeAccountId: STALE_ID,
    });
    store.parkMissingStripeAccount(business.id);
    let retrieves = 0;
    const stripe = {
      v2: {
        core: {
          accounts: {
            retrieve: async () => {
              retrieves += 1;
              return { id: STALE_ID };
            },
          },
        },
      },
    } as unknown as Stripe;
    const result = await forceParkMissingConnectedAccount(store, stripe, { slug: "schedi" }, async () => {
      throw new Error("should not publish");
    });
    expect(retrieves).toBe(0);
    expect(result).toMatchObject({
      ok: true,
      parked: false,
      alreadyCleared: true,
      published: false,
      slug: "schedi",
      stripeAccountIdMissing: STALE_ID,
    });
  });

  it("rejects an unknown slug, a slug/id mismatch, and a body with neither", async () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store, { slug: "schedi", stripeAccountId: STALE_ID });
    const stripe = createFakeStripe();
    await expect(forceParkMissingConnectedAccount(store, stripe, { slug: "missing" })).rejects.toMatchObject({ status: 404 });
    await expect(forceParkMissingConnectedAccount(store, stripe, { slug: "other", businessId: business.id })).rejects.toMatchObject({
      status: 400,
      message: "Business slug and id do not match.",
    });
    await expect(forceParkMissingConnectedAccount(store, stripe, {})).rejects.toMatchObject({ status: 400 });
    expect(store.getBusiness(business.id).stripeAccountId).toBe(STALE_ID);
  });

  it("keeps the parked id when publishing connect-ready fails", async () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store, { slug: "schedi", stripeAccountId: STALE_ID });
    const stripe = createFakeStripe();
    stripe.v2.core.accounts.retrieve = (async () => {
      throw missingAccountError(STALE_ID);
    }) as typeof stripe.v2.core.accounts.retrieve;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await forceParkMissingConnectedAccount(store, stripe, { slug: "schedi" }, async () => {
        throw new Error("publish down");
      });
      expect(result.parked).toBe(true);
      expect(result.published).toBe(false);
      expect(store.getBusiness(business.id).stripeAccountId).toBeNull();
      expect(store.getBusiness(business.id).stripeAccountIdMissing).toBe(STALE_ID);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
