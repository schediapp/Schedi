import { describe, expect, it } from "vitest";
import { cancelOwnerSubscription, ensureOwnerCustomer, resumeOwnerSubscription, startOwnerSubscription } from "../src/lib/billing";
import { isPublicPageLive } from "../src/lib/readiness";
import { planStaysActiveUntil } from "../src/lib/subscription-policy";
import { PLANS } from "../src/lib/types";
import { createFakeStripe, FAKE_PERIOD_END_ISO, keysDeep, memoryStore, seedProBusiness } from "./helpers";

describe("owner subscriptions on the platform account", () => {
  it("reuses one platform customer and does not pass customer_account", async () => {
    const store = memoryStore();
    const { owner } = seedProBusiness(store, {
      plan: "free",
      subscriptionStatus: "none",
      stripeAccountId: null,
      stripeSubscriptionId: null,
    });
    store.setOwnerCustomer(owner.id, "cus_existing");
    const stripe = createFakeStripe();

    const first = await startOwnerSubscription(store, stripe, owner.id, "pro", {
      success: "https://schedi.test/portal?session_id={CHECKOUT_SESSION_ID}",
      cancel: "https://schedi.test/portal",
    });

    expect(first.kind).toBe("checkout");
    expect(stripe.calls.some((call) => call.method === "customers.create")).toBe(false);
    const checkout = stripe.calls.find((call) => call.method === "checkout.sessions.create");
    const params = checkout?.args[0] as {
      mode: string;
      customer: string;
      line_items: Array<{ price: string }>;
      integration_identifier: string;
    };
    const options = checkout?.args[1] as { stripeAccount?: string } | undefined;
    expect(params.mode).toBe("subscription");
    expect(params.customer).toBe("cus_existing");
    expect(params.line_items[0]?.price).toBe("price_schedi_pro_monthly");
    expect(params.integration_identifier).toMatch(/^schedi_owner_sub_[a-z]{8}$/);
    expect(options?.stripeAccount).toBeUndefined();
    expect(keysDeep(params).has("customer_account")).toBe(false);
    expect(keysDeep(params).has("application_fee_amount")).toBe(false);

    const priceCall = stripe.calls.find((call) => call.method === "prices.create");
    expect(priceCall?.args[0]).toMatchObject({
      unit_amount: PLANS.pro.monthlyCents,
      currency: "usd",
      recurring: { interval: "month" },
    });
    expect(PLANS.starter.monthlyCents).toBe(2900);
    expect(PLANS.pro.monthlyCents).toBe(4900);
    expect(PLANS.free.monthlyCents).toBe(0);
  });

  it("creates a customer only when the owner does not already have one", async () => {
    const store = memoryStore();
    const { owner } = seedProBusiness(store, { stripeAccountId: null });
    const stripe = createFakeStripe();
    const first = await ensureOwnerCustomer(store, stripe, owner);
    const second = await ensureOwnerCustomer(store, stripe, store.getOwner(owner.id));
    expect(first).toBe("cus_new");
    expect(second).toBe("cus_new");
    expect(stripe.calls.filter((call) => call.method === "customers.create")).toHaveLength(1);
    expect(store.getOwner(owner.id).stripeCustomerId).toBe("cus_new");
  });

  it("changes an active plan without a second customer or a connected-account charge", async () => {
    const store = memoryStore();
    const { owner } = seedProBusiness(store, {
      plan: "starter",
      stripeSubscriptionId: "sub_starter",
      stripeAccountId: null,
    });
    store.setOwnerCustomer(owner.id, "cus_existing");
    const stripe = createFakeStripe();

    const result = await startOwnerSubscription(store, stripe, owner.id, "pro", {
      success: "https://schedi.test/portal",
      cancel: "https://schedi.test/portal",
    });

    expect(result).toEqual({ kind: "updated" });
    expect(stripe.calls.some((call) => call.method === "customers.create")).toBe(false);
    expect(stripe.calls.some((call) => call.method === "checkout.sessions.create")).toBe(false);
    const update = stripe.calls.find((call) => call.method === "subscriptions.update");
    expect(keysDeep(update?.args[1]).has("customer_account")).toBe(false);
    expect(store.getBusinessByOwner(owner.id)?.plan).toBe("pro");
  });

  it("schedules cancellation at period end and keeps the public page live", async () => {
    const store = memoryStore();
    const { owner, business } = seedProBusiness(store, { stripeSubscriptionId: "sub_pro" });
    const stripe = createFakeStripe();

    await cancelOwnerSubscription(store, stripe, owner.id);

    const saved = store.getBusiness(business.id);
    expect(stripe.calls.some((call) => call.method === "subscriptions.cancel")).toBe(false);
    const update = stripe.calls.find((call) => call.method === "subscriptions.update");
    expect(update?.args[1]).toMatchObject({ cancel_at_period_end: true });
    expect(saved.subscriptionStatus).toBe("active");
    expect(saved.plan).toBe("pro");
    expect(saved.cancelAtPeriodEnd).toBe(true);
    expect(saved.currentPeriodEnd).toBe(FAKE_PERIOD_END_ISO);
    expect(isPublicPageLive(saved.subscriptionStatus)).toBe(true);
    expect(planStaysActiveUntil(saved.currentPeriodEnd!)).toBe("Your plan stays active until November 7, 2026");
  });

  it("resumes a subscription that was scheduled to cancel", async () => {
    const store = memoryStore();
    const { owner, business } = seedProBusiness(store, { stripeSubscriptionId: "sub_pro" });
    const stripe = createFakeStripe();

    await cancelOwnerSubscription(store, stripe, owner.id);
    await resumeOwnerSubscription(store, stripe, owner.id);

    const saved = store.getBusiness(business.id);
    const updates = stripe.calls.filter((call) => call.method === "subscriptions.update");
    expect(updates[1]?.args[1]).toMatchObject({ cancel_at_period_end: false });
    expect(saved.subscriptionStatus).toBe("active");
    expect(saved.cancelAtPeriodEnd).toBe(false);
    expect(isPublicPageLive(saved.subscriptionStatus)).toBe(true);
  });

  it("does not resume a subscription that is not scheduled to cancel", async () => {
    const store = memoryStore();
    const { owner } = seedProBusiness(store, { stripeSubscriptionId: "sub_pro" });
    const stripe = createFakeStripe();
    await expect(resumeOwnerSubscription(store, stripe, owner.id)).rejects.toThrow(/not scheduled to cancel/);
  });
});
