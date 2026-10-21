import type Stripe from "stripe";
import type { Store } from "./db";
import { SchediError } from "./errors";
import { publishStripeConnectReady } from "./connect-ready";
import { applySchediPlan, fetchSchediPlan, isCardPlanPro } from "./plan-entitlement";
import { connectedChargesEnabled, readCapabilityStatuses } from "./readiness";
import { assertNoForbiddenKeys, cardStatementDescriptor } from "./statement";
import type { Business, Owner } from "./types";

const ACCOUNT_INCLUDE = ["configuration.merchant", "identity", "defaults"] as const;

export function buildMerchantAccountParams(
  business: Business,
  owner: Owner,
): Stripe.V2.Core.AccountCreateParams {
  const statement = cardStatementDescriptor(business.name);
  const params: Stripe.V2.Core.AccountCreateParams = {
    contact_email: owner.email,
    display_name: business.name,
    dashboard: "full",
    identity: {
      country: business.country.toLowerCase(),
      business_details: {
        registered_name: business.name,
      },
    },
    defaults: {
      responsibilities: {
        fees_collector: "stripe",
        losses_collector: "stripe",
      },
      profile: {
        doing_business_as: business.name,
        product_description: "Appointments booked by clients on the business's Schedi page.",
      },
    },
    configuration: {
      merchant: {
        capabilities: {
          card_payments: { requested: true },
        },
        ...(statement
          ? {
              statement_descriptor: {
                descriptor: statement.descriptor,
                prefix: statement.prefix,
              },
            }
          : {}),
      },
    },
    metadata: {
      schedi_business_id: business.id,
    },
    include: [...ACCOUNT_INCLUDE],
  };

  assertNoForbiddenKeys(params);
  if (params.configuration?.customer || params.configuration?.recipient) {
    throw new Error("Connected accounts are merchant-only.");
  }
  return params;
}

export async function enableCardPayments(
  store: Store,
  stripe: Stripe,
  ownerId: string,
): Promise<{ accountId: string; created: boolean }> {
  const existing = store.getBusinessByOwner(ownerId);
  if (!existing) throw new SchediError("Business not found.", 404);
  const ownerForPlan = store.getOwner(ownerId);
  const remotePlan = await fetchSchediPlan({ slug: existing.slug, email: ownerForPlan.email });
  const business = applySchediPlan(store, existing, remotePlan, ownerForPlan.email);
  if (!isCardPlanPro(business)) {
    throw new SchediError("Card payments are available on an active Pro subscription.", 403);
  }
  if (business.stripeAccountId) {
    return { accountId: business.stripeAccountId, created: false };
  }

  const owner = ownerForPlan;
  // Stripe stores the first response for an idempotency key for 24 hours, including
  // failures. v1 keys from earlier attempts must not be reused after a fix.
  const account = await stripe.v2.core.accounts.create(buildMerchantAccountParams(business, owner), {
    idempotencyKey: `schedi_connect_v2_${business.id}`,
  });
  const saved = store.setStripeAccount(business.id, account.id, readCapabilityStatuses(account));
  await publishStripeConnectReady(saved.slug, connectedChargesEnabled(account)).catch((error) => {
    console.error("Could not publish stripeConnectReady:", error instanceof Error ? error.message : "unknown error");
  });
  return { accountId: account.id, created: true };
}

export function embeddedAccountSessionParams(accountId: string): Stripe.AccountSessionCreateParams {
  return {
    account: accountId,
    components: {
      account_onboarding: { enabled: true },
      notification_banner: { enabled: true },
      account_management: { enabled: true },
      payments: {
        enabled: true,
        features: {
          refund_management: true,
          dispute_management: true,
          capture_payments: true,
          destination_on_behalf_of_charge_management: false,
        },
      },
      payouts: {
        enabled: true,
        features: {
          standard_payouts: true,
          edit_payout_schedule: true,
        },
      },
    },
  };
}

export async function createEmbeddedAccountSession(stripe: Stripe, accountId: string) {
  return stripe.accountSessions.create(embeddedAccountSessionParams(accountId));
}

function missingConnectedAccount(error: unknown): boolean {
  const err = error as {
    code?: string;
    statusCode?: number;
    message?: string;
    raw?: { code?: string; statusCode?: number; message?: string };
  };
  const code = String(err?.code || err?.raw?.code || "");
  const status = Number(err?.statusCode || err?.raw?.statusCode || 0);
  const message = String(err?.message || err?.raw?.message || "");
  if (code === "resource_missing") return true;
  if (/no such account/i.test(message)) return true;
  return status === 404 && /account/i.test(message) && /not found/i.test(message);
}

export async function refreshMerchantCapabilities(
  store: Store,
  stripe: Stripe,
  business: Business,
): Promise<Business> {
  if (!business.stripeAccountId) return business;
  let account: Awaited<ReturnType<Stripe["v2"]["core"]["accounts"]["retrieve"]>>;
  try {
    account = await stripe.v2.core.accounts.retrieve(business.stripeAccountId, {
      include: ["configuration.merchant"],
    });
  } catch (error) {
    if (!missingConnectedAccount(error)) throw error;
    const stale = business.stripeAccountId;
    console.error(`Connected account ${stale} was not found. Clearing it so capability refresh stops retrying.`);
    const saved = store.setStripeAccount(business.id, null, {
      cardPaymentsStatus: null,
      payoutsStatus: null,
    });
    await publishStripeConnectReady(saved.slug, false, "not_started").catch((publishError) => {
      console.error("Could not publish stripeConnectReady:", publishError instanceof Error ? publishError.message : "unknown error");
    });
    return saved;
  }
  const saved = store.setCapabilities(business.id, readCapabilityStatuses(account));
  await publishStripeConnectReady(saved.slug, connectedChargesEnabled(account)).catch((error) => {
    console.error("Could not publish stripeConnectReady:", error instanceof Error ? error.message : "unknown error");
  });
  return saved;
}
