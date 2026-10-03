import { describe, expect, it } from "vitest";
import { buildMerchantAccountParams, embeddedAccountSessionParams, enableCardPayments } from "../src/lib/connect";
import { cardStatementDescriptor } from "../src/lib/statement";
import { isCardCheckoutReady } from "../src/lib/readiness";
import { createFakeStripe, memoryStore, seedProBusiness } from "./helpers";

describe("connected account onboarding", () => {
  it("creates an Accounts v2 merchant with full dashboard and Stripe-owned fees and losses", async () => {
    const store = memoryStore();
    const { owner } = seedProBusiness(store, {
      email: "ava@lumen.studio",
      name: "Lumen Studio",
      slug: "lumen",
      stripeAccountId: null,
      cardPaymentsStatus: null,
      payoutsStatus: null,
      depositAmountCents: 5000,
    });
    const stripe = createFakeStripe();

    const result = await enableCardPayments(store, stripe, owner.id);

    expect(result).toEqual({ accountId: "acct_created", created: true });
    const params = stripe.calls[0]?.args[0] as Record<string, unknown>;
    const options = stripe.calls[0]?.args[1] as { idempotencyKey: string };
    expect(stripe.calls[0]?.method).toBe("accounts.create");
    expect(params.dashboard).toBe("full");
    expect(params).not.toHaveProperty("type");
    expect(params.configuration).not.toHaveProperty("customer");
    expect(params.configuration).not.toHaveProperty("recipient");
    expect(params).toMatchObject({
      display_name: "Lumen Studio",
      contact_email: "ava@lumen.studio",
      defaults: {
        responsibilities: { fees_collector: "stripe", losses_collector: "stripe" },
        profile: { doing_business_as: "Lumen Studio" },
      },
      configuration: {
        merchant: {
          capabilities: { card_payments: { requested: true } },
          statement_descriptor: cardStatementDescriptor("Lumen Studio"),
        },
      },
      identity: {
        country: "us",
        business_details: { registered_name: "Lumen Studio" },
      },
    });
    expect(options.idempotencyKey).toContain("schedi_connect_");

    const saved = store.getBusinessByOwner(owner.id)!;
    expect(saved.stripeAccountId).toBe("acct_created");
    expect(isCardCheckoutReady(saved)).toBe(false);

    const again = await enableCardPayments(store, stripe, owner.id);
    expect(again).toEqual({ accountId: "acct_created", created: false });
    expect(stripe.calls.filter((call) => call.method === "accounts.create")).toHaveLength(1);
  });

  it("refuses card onboarding unless the owner is on active Pro", async () => {
    const store = memoryStore();
    const { owner } = seedProBusiness(store, { plan: "starter", stripeAccountId: null });
    await expect(enableCardPayments(store, createFakeStripe(), owner.id)).rejects.toThrow(/active Pro/);
  });

  it("builds the embedded portal session with onboarding, banner, account, payments, and payouts", () => {
    const params = embeddedAccountSessionParams("acct_created");
    expect(params.account).toBe("acct_created");
    expect(params.components.account_onboarding?.enabled).toBe(true);
    expect(params.components.notification_banner?.enabled).toBe(true);
    expect(params.components.account_management?.enabled).toBe(true);
    expect(params.components.payments?.enabled).toBe(true);
    expect(params.components.payments?.features).toMatchObject({
      refund_management: true,
      dispute_management: true,
      destination_on_behalf_of_charge_management: false,
    });
    expect(params.components.payouts?.enabled).toBe(true);
  });

  it("puts the business name on the card statement descriptor", () => {
    expect(cardStatementDescriptor("Lumen Studio")).toEqual({
      descriptor: "LUMEN STUDIO",
      prefix: "LUMENSTUDI",
    });
    expect(cardStatementDescriptor("A&B")).toBeNull();
    const business = {
      id: "biz",
      ownerId: "own",
      name: "Lumen Studio",
      slug: "lumen",
      plan: "pro" as const,
      subscriptionStatus: "active" as const,
      stripeSubscriptionId: null,
      stripeAccountId: null,
      cardPaymentsStatus: null,
      payoutsStatus: null,
      depositEnabled: false,
      depositAmountCents: null,
      cashApp: null,
      zelle: null,
      venmo: null,
      paypal: null,
      payAtAppointment: true,
      country: "US",
    };
    const params = buildMerchantAccountParams(business, {
      id: "own",
      email: "ava@lumen.studio",
      name: "Ava Chen",
      stripeCustomerId: "cus_existing",
    });
    expect(params.configuration?.customer).toBeUndefined();
    expect(params.metadata).toEqual({ schedi_business_id: "biz" });
  });
});
