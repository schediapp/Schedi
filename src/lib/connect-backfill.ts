import { timingSafeEqual } from "node:crypto";
import type Stripe from "stripe";
import type { Store } from "./db";
import { publishStripeConnectReady } from "./connect-ready";
import { connectedChargesEnabled, readCapabilityStatuses, type MerchantCapabilityAccount } from "./readiness";

type ConnectAccount = MerchantCapabilityAccount & { charges_enabled?: boolean | null };

export type ConnectReadyPublish = (slug: string, ready: boolean) => Promise<void>;

export interface ConnectReadyBackfillRow {
  slug: string;
  ready: boolean;
  chargesEnabled: boolean;
}

export interface ConnectReadyBackfillResult {
  checked: number;
  published: ConnectReadyBackfillRow[];
  skipped: number;
  failed: Array<{ slug: string; error: string }>;
}

/** Admin caller for the Connect readiness backfill. An empty secret fails closed. */
export function connectAdminAuthorized(header: string | null, secret: string | undefined): boolean {
  const expected = String(secret || "");
  const given = String(header || "");
  if (!expected || !given) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(given);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * For every Connect business that already has a Stripe account, read
 * charges_enabled and publish stripeConnectReady. Businesses with no
 * account are left Not started and are not published.
 */
export async function backfillStripeConnectReady(
  store: Store,
  stripe: Stripe,
  publish: ConnectReadyPublish = publishStripeConnectReady,
): Promise<ConnectReadyBackfillResult> {
  const published: ConnectReadyBackfillRow[] = [];
  const failed: Array<{ slug: string; error: string }> = [];
  let skipped = 0;
  for (const business of store.listBusinesses()) {
    const accountId = String(business.stripeAccountId || "").trim();
    if (!accountId) {
      skipped += 1;
      continue;
    }
    try {
      const account = await stripe.v2.core.accounts.retrieve(accountId, {
        include: ["configuration.merchant"],
      }) as ConnectAccount;
      const ready = connectedChargesEnabled(account);
      const statuses = readCapabilityStatuses(account);
      if (account.charges_enabled === true && statuses.cardPaymentsStatus !== "active") {
        statuses.cardPaymentsStatus = "active";
      }
      if (account.charges_enabled === false) statuses.cardPaymentsStatus = "inactive";
      store.setCapabilities(business.id, statuses);
      await publish(business.slug, ready);
      published.push({
        slug: business.slug,
        ready,
        chargesEnabled: account.charges_enabled === true,
      });
    } catch (error) {
      failed.push({
        slug: business.slug,
        error: error instanceof Error ? error.message.slice(0, 200) : "stripe_lookup_failed",
      });
    }
  }
  return { checked: published.length + failed.length, published, skipped, failed };
}
