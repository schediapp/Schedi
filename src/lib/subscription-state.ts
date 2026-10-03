import type Stripe from "stripe";
import type { Store } from "./db";
import type { Plan, SubscriptionStatus } from "./types";

const KNOWN: SubscriptionStatus[] = [
  "none",
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
];

function asStatus(status: string): SubscriptionStatus {
  return (KNOWN as string[]).includes(status) ? (status as SubscriptionStatus) : "incomplete";
}

export function applySubscriptionState(
  store: Store,
  ownerId: string,
  subscription: Pick<Stripe.Subscription, "id" | "status" | "metadata">,
  planOverride?: Plan,
): void {
  const metaPlan = planOverride ?? subscription.metadata?.plan;
  const plan = metaPlan === "starter" || metaPlan === "pro" ? metaPlan : undefined;
  const status = asStatus(subscription.status);

  if (status === "active" || status === "trialing") {
    store.setSubscription(ownerId, {
      status: "active",
      plan,
      stripeSubscriptionId: subscription.id,
    });
    return;
  }

  store.setSubscription(ownerId, {
    status,
    stripeSubscriptionId: subscription.id,
  });
}
