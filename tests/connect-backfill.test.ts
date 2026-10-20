import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { backfillStripeConnectReady, connectAdminAuthorized } from "../src/lib/connect-backfill";
import { memoryStore, seedProBusiness } from "./helpers";

describe("Stripe Connect readiness backfill", () => {
  it("refuses the admin call unless the connect secret matches", () => {
    expect(connectAdminAuthorized(null, "connect-secret")).toBe(false);
    expect(connectAdminAuthorized("connect-secret", "")).toBe(false);
    expect(connectAdminAuthorized("nope", "connect-secret")).toBe(false);
    expect(connectAdminAuthorized("connect-secret", "connect-secret")).toBe(true);
  });

  it("publishes charges_enabled for every tenant that has a Stripe account", async () => {
    const store = memoryStore();
    seedProBusiness(store, {
      email: "ready@example.com",
      slug: "ready-shop",
      name: "Ready Shop",
      stripeAccountId: "acct_ready",
      cardPaymentsStatus: "pending",
    });
    seedProBusiness(store, {
      email: "pending@example.com",
      slug: "pending-shop",
      name: "Pending Shop",
      stripeAccountId: "acct_pending",
      cardPaymentsStatus: "active",
    });
    seedProBusiness(store, {
      email: "none@example.com",
      slug: "no-account",
      name: "No Account",
      stripeAccountId: null,
    });

    const retrieved: string[] = [];
    const stripe = {
      v2: {
        core: {
          accounts: {
            retrieve: async (id: string) => {
              retrieved.push(id);
              const chargesEnabled = id === "acct_ready";
              return {
                id,
                charges_enabled: chargesEnabled,
                configuration: {
                  merchant: {
                    capabilities: {
                      card_payments: { status: chargesEnabled ? "restricted" : "active" },
                      stripe_balance: { payouts: { status: "restricted" } },
                    },
                  },
                },
              };
            },
          },
        },
      },
    } as unknown as Stripe;

    const published: Array<{ slug: string; ready: boolean }> = [];
    const result = await backfillStripeConnectReady(store, stripe, async (slug, ready) => {
      published.push({ slug, ready });
    });

    expect(retrieved.sort()).toEqual(["acct_pending", "acct_ready"]);
    expect(result.skipped).toBe(1);
    expect(result.failed).toEqual([]);
    expect(result.checked).toBe(2);
    expect(published).toEqual([
      { slug: "pending-shop", ready: false },
      { slug: "ready-shop", ready: true },
    ]);
    expect(result.published).toEqual([
      { slug: "pending-shop", ready: false, chargesEnabled: false },
      { slug: "ready-shop", ready: true, chargesEnabled: true },
    ]);
    expect(store.getBusinessBySlug("ready-shop")?.cardPaymentsStatus).toBe("active");
    expect(store.getBusinessBySlug("pending-shop")?.cardPaymentsStatus).toBe("inactive");
    expect(store.getBusinessBySlug("no-account")?.stripeAccountId).toBeNull();
  });
});
