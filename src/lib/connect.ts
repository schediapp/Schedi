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

/** Live Schedi platform account. A test key or another platform must not park connected accounts. */
export const SCHEDI_PLATFORM_ACCOUNT_ID = "acct_1ULDZkGh1H5O3dkr";
export const MISSING_ACCOUNT_CONFIRM_MS = 60 * 60 * 1000;

const loggedPlatformRefusal = new Set<string>();

function stripeErrorParts(error: unknown): { code: string; status: number; message: string } {
  const err = error as {
    code?: string;
    statusCode?: number;
    message?: string;
    raw?: { code?: string; statusCode?: number; message?: string };
  };
  return {
    code: String(err?.code || err?.raw?.code || ""),
    status: Number(err?.statusCode || err?.raw?.statusCode || 0),
    message: String(err?.message || err?.raw?.message || ""),
  };
}

/**
 * A missing connected account from accounts.retrieve.
 * The loose 404 "account … not found" wording counts only when the message names
 * the account id this retrieve asked for.
 */
function missingConnectedAccount(error: unknown, accountId: string): boolean {
  const { code, status, message } = stripeErrorParts(error);
  if (/no such account/i.test(message)) return true;
  if (code === "resource_missing" && (/account/i.test(message) || message.includes(accountId))) return true;
  return status === 404 && message.includes(accountId) && /not found/i.test(message);
}

async function platformKeyIsLiveSchedi(stripe: Stripe): Promise<boolean> {
  // Accounts v1 types in this SDK omit livemode. The retrieve payload still includes it.
  const account = await stripe.accounts.retrieve(null) as { id?: string; livemode?: boolean };
  return account.id === SCHEDI_PLATFORM_ACCOUNT_ID && account.livemode === true;
}

function logPlatformRefusal(businessId: string): void {
  if (loggedPlatformRefusal.has(businessId)) return;
  loggedPlatformRefusal.add(businessId);
  console.error(
    `Refusing to park a connected account because this Stripe key does not see live platform ${SCHEDI_PLATFORM_ACCOUNT_ID}.`,
  );
}

async function parkMissingAccount(
  store: Store,
  stripe: Stripe,
  business: Business,
  now: number,
): Promise<Business> {
  const accountId = business.stripeAccountId;
  if (!accountId) return business;
  let platformOk = false;
  try {
    platformOk = await platformKeyIsLiveSchedi(stripe);
  } catch {
    platformOk = false;
  }
  if (!platformOk) {
    logPlatformRefusal(business.id);
    return store.getBusiness(business.id);
  }
  const current = store.getBusiness(business.id);
  if (!current.stripeAccountId) return current;
  const seenAt = Number(current.stripeAccountMissingAt) || 0;
  if (!seenAt) {
    console.error(`Connected account ${accountId} was not found. Waiting an hour for a second miss before parking it.`);
    return store.noteStripeAccountMiss(current.id, now);
  }
  if (now - seenAt < MISSING_ACCOUNT_CONFIRM_MS) return current;
  console.error(`Connected account ${accountId} was not found again after an hour. Parking the id so it can be restored.`);
  const saved = store.parkMissingStripeAccount(current.id);
  await publishStripeConnectReady(saved.slug, false, "not_started").catch((publishError) => {
    console.error("Could not publish stripeConnectReady:", publishError instanceof Error ? publishError.message : "unknown error");
  });
  return saved;
}

export async function refreshMerchantCapabilities(
  store: Store,
  stripe: Stripe,
  business: Business,
  now = Date.now(),
): Promise<Business> {
  if (!business.stripeAccountId) return business;
  let account: Awaited<ReturnType<Stripe["v2"]["core"]["accounts"]["retrieve"]>>;
  try {
    account = await stripe.v2.core.accounts.retrieve(business.stripeAccountId, {
      include: ["configuration.merchant"],
    });
  } catch (error) {
    if (!missingConnectedAccount(error, business.stripeAccountId)) throw error;
    return parkMissingAccount(store, stripe, business, now);
  }
  const saved = store.setCapabilities(business.id, readCapabilityStatuses(account));
  const current = saved.stripeAccountMissingAt ? store.clearStripeAccountMiss(saved.id) : saved;
  await publishStripeConnectReady(current.slug, connectedChargesEnabled(account)).catch((error) => {
    console.error("Could not publish stripeConnectReady:", error instanceof Error ? error.message : "unknown error");
  });
  return current;
}
