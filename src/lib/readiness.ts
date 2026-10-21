import { isCardPlanPro } from "./plan-entitlement";
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
 * A connected account can take a client charge when Stripe reports
 * charges_enabled, or the Accounts v2 card_payments capability is active.
 * An explicit charges_enabled: false always wins.
 */
export function connectedChargesEnabled(account: MerchantCapabilityAccount & { charges_enabled?: boolean | null }): boolean {
  if (account.charges_enabled === false) return false;
  if (account.charges_enabled === true) return true;
  return readCapabilityStatuses(account).cardPaymentsStatus === "active";
}

/**
 * Live card checkout stays off until the connected account can take charges.
 * Payout status does not gate the charge. charges_enabled is the gate.
 */
export function isCardCheckoutReady(
  business: Pick<Business, "plan" | "subscriptionStatus" | "cardPaymentsStatus">,
): boolean {
  return isCardPlanPro(business) && business.cardPaymentsStatus === "active";
}

export function planIncludesCards(plan: Plan): boolean {
  return plan === "pro";
}
