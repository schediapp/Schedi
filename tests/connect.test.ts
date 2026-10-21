import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildMerchantAccountParams, embeddedAccountSessionParams, enableCardPayments, refreshMerchantCapabilities } from "../src/lib/connect";
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
    expect(options.idempotencyKey).toMatch(/^schedi_connect_v2_/);

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
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
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

  it("clears a stored account once when Stripe says that account does not exist", async () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store, {
      slug: "lumen",
      stripeAccountId: "acct_1UNlXiGitAq7DPgt",
      cardPaymentsStatus: "active",
      payoutsStatus: "active",
    });
    const stripe = createFakeStripe();
    let retrieves = 0;
    stripe.v2.core.accounts.retrieve = (async () => {
      retrieves += 1;
      throw Object.assign(new Error("No such account: 'acct_1UNlXiGitAq7DPgt'"), {
        code: "resource_missing",
        statusCode: 404,
      });
    }) as typeof stripe.v2.core.accounts.retrieve;
    const previousSecret = process.env.SCHEDI_CONNECT_PAID_SECRET;
    process.env.SCHEDI_CONNECT_PAID_SECRET = "connect-secret";
    const logs: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((part) => String(part)).join(" "));
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      const saved = await refreshMerchantCapabilities(store, stripe, business);
      expect(saved.stripeAccountId).toBeNull();
      expect(saved.cardPaymentsStatus).toBeNull();
      expect(saved.payoutsStatus).toBeNull();
      expect(store.getBusiness(business.id).stripeAccountId).toBeNull();
      expect(retrieves).toBe(1);
      expect(logs.filter((line) => line.includes("acct_1UNlXiGitAq7DPgt"))).toHaveLength(1);
      const published = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(published).toMatchObject({ slug: "lumen", ready: false, status: "not_started" });

      logs.length = 0;
      const again = await refreshMerchantCapabilities(store, stripe, saved);
      expect(again.stripeAccountId).toBeNull();
      expect(retrieves).toBe(1);
      expect(logs).toEqual([]);
    } finally {
      errorSpy.mockRestore();
      fetchSpy.mockRestore();
      if (previousSecret === undefined) delete process.env.SCHEDI_CONNECT_PAID_SECRET;
      else process.env.SCHEDI_CONNECT_PAID_SECRET = previousSecret;
    }
  });

  it("still raises when a capability refresh fails for a reason other than a missing account", async () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store, { stripeAccountId: "acct_live" });
    const stripe = createFakeStripe();
    stripe.v2.core.accounts.retrieve = (async () => {
      throw Object.assign(new Error("Stripe is unavailable"), { statusCode: 500 });
    }) as typeof stripe.v2.core.accounts.retrieve;
    await expect(refreshMerchantCapabilities(store, stripe, business)).rejects.toThrow(/unavailable/);
    expect(store.getBusiness(business.id).stripeAccountId).toBe("acct_live");
  });
});

describe("ConnectJS browser loading", () => {
  it("keeps the side-effect ConnectJS loader off the server render", () => {
    const portal = readFileSync(new URL("../src/app/portal/page.tsx", import.meta.url), "utf8");
    const loader = readFileSync(new URL("../src/components/connect-dashboard-loader.tsx", import.meta.url), "utf8");
    const dashboard = readFileSync(new URL("../src/components/connect-dashboard.tsx", import.meta.url), "utf8");
    expect(portal).toContain("ConnectDashboardLoader");
    expect(portal).not.toContain("@stripe/connect-js");
    expect(portal).not.toContain('components/connect-dashboard"');
    expect(loader).toContain("ssr: false");
    expect(dashboard).not.toContain('from "@stripe/connect-js"');
    expect(dashboard).toContain("@stripe/connect-js/pure");
    expect(dashboard).toContain("useEffect");
    expect(dashboard).not.toContain("useMemo");
  });

  it("imports the pure ConnectJS loader on the server without an unhandled rejection", async () => {
    const reasons: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      reasons.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await import("@stripe/connect-js/pure");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(reasons).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
