/**
 * Owner subscriptions (Starter $29/mo, Pro $49/mo) are month-to-month.
 * The short line sits next to subscribe and cancel actions. Terms use the full paragraphs.
 */
export const OWNER_SUBSCRIPTION_POLICY_SHORT =
  "Cancel anytime. Cancellation takes effect at the end of the current paid billing period; you keep access until then and are not charged again. New subscribers may request a full refund of the first payment within 15 days. Renewal payments are not refunded or prorated, except at Schedi's discretion for billing errors or service outages. Complimentary plans are unaffected.";

export const OWNER_SUBSCRIPTION_POLICY_TERMS = [
  "Schedi owner subscriptions (Starter $29/mo and Pro $49/mo) are month-to-month, with no contract.",
  "Cancel anytime. Cancellation takes effect at the end of the current paid billing period; the owner keeps access until then and is not charged again.",
  "New subscribers may request a full refund of their first payment within 15 days by emailing admin@schedi.app with the business name and the charge date.",
  "Renewal payments are not refunded or prorated, except at Schedi's discretion for billing errors or service outages.",
  "Complimentary plans are unaffected.",
  "This covers Schedi plan fees, not a client's appointment deposit or a payment a business collects from its own customer.",
] as const;

export function formatPeriodEnd(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function planStaysActiveUntil(iso: string): string {
  return `Your plan stays active until ${formatPeriodEnd(iso)}`;
}

export interface SubscriptionPeriodSource {
  cancel_at_period_end?: boolean | null;
  cancel_at?: number | null;
  current_period_end?: number | null;
  items?: {
    data?: Array<{ current_period_end?: number | null } | null | undefined> | null;
  } | null;
}

function unixToIso(unix: number | null | undefined): string | null {
  if (unix == null || !Number.isFinite(unix) || unix <= 0) return null;
  return new Date(unix * 1000).toISOString();
}

/** Period end shown after a cancel-at-period-end request. Prefer Stripe's cancel_at when the cancel is scheduled. */
export function subscriptionPeriodEndIso(subscription: SubscriptionPeriodSource): string | null {
  if (subscription.cancel_at_period_end && subscription.cancel_at) {
    return unixToIso(subscription.cancel_at);
  }
  const itemEnd = subscription.items?.data?.[0]?.current_period_end;
  return unixToIso(subscription.current_period_end) ?? unixToIso(itemEnd) ?? unixToIso(subscription.cancel_at);
}
