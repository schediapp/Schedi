import type { Store } from "./db";
import { subscriptionPeriodEndIso, type SubscriptionPeriodSource } from "./subscription-policy";
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

export interface SubscriptionSnapshot extends SubscriptionPeriodSource {
  id: string;
  status: string;
  metadata?: { plan?: string | null } | null;
}

const ENDED: SubscriptionStatus[] = ["canceled", "incomplete_expired"];

export function applySubscriptionState(
  store: Store,
  ownerId: string,
  subscription: SubscriptionSnapshot,
  planOverride?: Plan,
): void {
  const metaPlan = planOverride ?? subscription.metadata?.plan;
  const plan = metaPlan === "starter" || metaPlan === "pro" ? metaPlan : undefined;
  const status = asStatus(subscription.status);
  const ended = ENDED.includes(status);
  const cancelAtPeriodEnd = ended ? false : Boolean(subscription.cancel_at_period_end);
  const currentPeriodEnd = ended ? null : subscriptionPeriodEndIso(subscription);

  if (status === "active" || status === "trialing") {
    store.setSubscription(ownerId, {
      status: "active",
      plan,
      stripeSubscriptionId: subscription.id,
      cancelAtPeriodEnd,
      currentPeriodEnd,
    });
    return;
  }

  store.setSubscription(ownerId, {
    status,
    stripeSubscriptionId: subscription.id,
    cancelAtPeriodEnd,
    currentPeriodEnd,
  });
}
