import type Stripe from "stripe";
import type { Store } from "./db";
import { SchediError } from "./errors";
import { assertNoForbiddenKeys, integrationIdentifier } from "./statement";
import { ownerCheckoutCustomText } from "./public-owner-billing";
import { applySubscriptionState } from "./subscription-state";
import type { Owner, Plan } from "./types";
import { PLANS } from "./types";

export async function ensureOwnerCustomer(store: Store, stripe: Stripe, owner: Owner): Promise<string> {
  if (owner.stripeCustomerId) return owner.stripeCustomerId;

  const customer = await stripe.customers.create(
    {
      email: owner.email,
      name: owner.name,
      metadata: { schedi_owner_id: owner.id },
    },
    { idempotencyKey: `schedi_owner_customer_${owner.id}` },
  );
  return store.setOwnerCustomer(owner.id, customer.id).stripeCustomerId!;
}

async function ensurePlanPrice(stripe: Stripe, plan: "starter" | "pro"): Promise<string> {
  const configured = plan === "starter" ? process.env.STRIPE_PRICE_STARTER : process.env.STRIPE_PRICE_PRO;
  if (configured) return configured;

  const lookupKey = plan === "starter" ? "schedi_starter_monthly" : "schedi_pro_monthly";
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (existing.data[0]) return existing.data[0].id;

  const product = await stripe.products.create(
    {
      name: `Schedi ${PLANS[plan].name}`,
      metadata: { schedi_plan: plan },
    },
    { idempotencyKey: `schedi_product_${plan}` },
  );
  const price = await stripe.prices.create(
    {
      product: product.id,
      currency: "usd",
      unit_amount: PLANS[plan].monthlyCents,
      recurring: { interval: "month" },
      lookup_key: lookupKey,
    },
    { idempotencyKey: `schedi_price_${plan}` },
  );
  return price.id;
}

export async function startOwnerSubscription(
  store: Store,
  stripe: Stripe,
  ownerId: string,
  plan: "starter" | "pro",
  urls: { success: string; cancel: string },
): Promise<{ kind: "checkout"; url: string } | { kind: "updated" } | { kind: "portal"; url: string }> {
  const owner = store.getOwner(ownerId);
  const business = store.getBusinessByOwner(ownerId);
  if (!business) throw new SchediError("Business not found.", 404);

  if (
    business.stripeSubscriptionId &&
    (business.subscriptionStatus === "past_due" || business.subscriptionStatus === "unpaid")
  ) {
    const customerId = await ensureOwnerCustomer(store, stripe, owner);
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: urls.cancel,
    });
    return { kind: "portal", url: portal.url };
  }

  if (business.stripeSubscriptionId && business.subscriptionStatus === "active") {
    await changeSubscriptionPlan(store, stripe, ownerId, plan);
    return { kind: "updated" };
  }

  const customerId = await ensureOwnerCustomer(store, stripe, owner);
  const priceId = await ensurePlanPrice(stripe, plan);
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: urls.success,
    cancel_url: urls.cancel,
    client_reference_id: owner.id,
    metadata: { schedi_owner_id: owner.id, plan },
    subscription_data: {
      metadata: { schedi_owner_id: owner.id, plan },
    },
    custom_text: ownerCheckoutCustomText(),
    integration_identifier: integrationIdentifier("schedi_owner_sub"),
  };
  assertNoForbiddenKeys(params);

  const session = await stripe.checkout.sessions.create(params, {
    idempotencyKey: `schedi_owner_sub_${owner.id}_${plan}_${crypto.randomUUID()}`,
  });
  if (!session.url) throw new SchediError("Stripe did not return a checkout URL.", 502);
  return { kind: "checkout", url: session.url };
}

export async function changeSubscriptionPlan(
  store: Store,
  stripe: Stripe,
  ownerId: string,
  plan: "starter" | "pro",
): Promise<void> {
  const business = store.getBusinessByOwner(ownerId);
  if (!business?.stripeSubscriptionId) throw new SchediError("There is no subscription to change.", 409);
  const priceId = await ensurePlanPrice(stripe, plan);
  const current = await stripe.subscriptions.retrieve(business.stripeSubscriptionId);
  const itemId = current.items.data[0]?.id;
  if (!itemId) throw new SchediError("Subscription has no price.", 409);

  const updateParams: Stripe.SubscriptionUpdateParams = {
    items: [{ id: itemId, price: priceId }],
    metadata: { schedi_owner_id: ownerId, plan },
    proration_behavior: "create_prorations",
  };
  assertNoForbiddenKeys(updateParams);
  const updated = await stripe.subscriptions.update(business.stripeSubscriptionId, updateParams);
  applySubscriptionState(store, ownerId, updated, plan);
}

export async function cancelOwnerSubscription(store: Store, stripe: Stripe, ownerId: string): Promise<void> {
  const business = store.getBusinessByOwner(ownerId);
  if (!business?.stripeSubscriptionId) throw new SchediError("There is no subscription to cancel.", 409);
  const updateParams: Stripe.SubscriptionUpdateParams = { cancel_at_period_end: true };
  assertNoForbiddenKeys(updateParams);
  const updated = await stripe.subscriptions.update(business.stripeSubscriptionId, updateParams);
  applySubscriptionState(store, ownerId, updated);
}

export async function resumeOwnerSubscription(store: Store, stripe: Stripe, ownerId: string): Promise<void> {
  const business = store.getBusinessByOwner(ownerId);
  if (!business?.stripeSubscriptionId) throw new SchediError("There is no subscription to resume.", 409);
  if (!business.cancelAtPeriodEnd) throw new SchediError("This subscription is not scheduled to cancel.", 409);
  const updateParams: Stripe.SubscriptionUpdateParams = { cancel_at_period_end: false };
  assertNoForbiddenKeys(updateParams);
  const updated = await stripe.subscriptions.update(business.stripeSubscriptionId, updateParams);
  applySubscriptionState(store, ownerId, updated);
}

export async function fulfillOwnerCheckout(
  store: Store,
  stripe: Stripe,
  owner: Owner,
  sessionId: string,
): Promise<void> {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.mode !== "subscription" || session.status !== "complete") return;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!customerId || customerId !== owner.stripeCustomerId) return;
  const plan = session.metadata?.plan;
  if (plan !== "starter" && plan !== "pro") return;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;
  store.setSubscription(owner.id, {
    status: "active",
    plan,
    stripeSubscriptionId: subscriptionId,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
  });
}

export function isPaidPlan(plan: Plan): plan is "starter" | "pro" {
  return plan === "starter" || plan === "pro";
}
