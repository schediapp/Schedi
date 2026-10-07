import type { Business, Plan, SubscriptionStatus } from "./types";

const PAUSING_STATUSES = new Set<SubscriptionStatus>([
  "past_due",
  "unpaid",
  "canceled",
  "incomplete_expired",
]);

export function pausesPublicPage(status: SubscriptionStatus): boolean {
  return PAUSING_STATUSES.has(status);
}

export function isPublicPageLive(status: SubscriptionStatus): boolean {
  return !pausesPublicPage(status);
}

export interface MerchantCapabilityAccount {
  configuration?: {
    merchant?: {
      capabilities?: {
        card_payments?: { status?: string | null } | null;
        stripe_balance?: {
          payouts?: { status?: string | null } | null;
        } | null;
      } | null;
    } | null;
  } | null;
}

export function readCapabilityStatuses(account: MerchantCapabilityAccount): {
  cardPaymentsStatus: string | null;
  payoutsStatus: string | null;
} {
  const capabilities = account.configuration?.merchant?.capabilities;
  return {
    cardPaymentsStatus: capabilities?.card_payments?.status ?? null,
    payoutsStatus: capabilities?.stripe_balance?.payouts?.status ?? null,
  };
}

/**
 * Live card checkout, including the deposit, stays off until the connected
 * account can take card payments and pay out. Both statuses come from the
 * merchant configuration on Accounts v2.
 */
export function isCardCheckoutReady(
  business: Pick<Business, "plan" | "subscriptionStatus" | "cardPaymentsStatus" | "payoutsStatus">,
): boolean {
  return (
    business.plan === "pro" &&
    business.subscriptionStatus === "active" &&
    business.cardPaymentsStatus === "active" &&
    business.payoutsStatus === "active"
  );
}

export function planIncludesCards(plan: Plan): boolean {
  return plan === "pro";
}
