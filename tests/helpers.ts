import type Stripe from "stripe";
import { openStore, type Store } from "../src/lib/db";
import type { Business, Service } from "../src/lib/types";

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export function createFakeStripe() {
  const calls: RecordedCall[] = [];
  const record =
    (method: string, impl: (...args: never[]) => unknown) =>
    async (...args: never[]) => {
      calls.push({ method, args });
      return impl(...args);
    };

  const stripe = {
    calls,
    v2: {
      core: {
        accounts: {
          create: record("accounts.create", (async (params: { configuration?: unknown }) => ({
            id: "acct_created",
            ...params,
            id_kept: "acct_created",
            configuration: {
              merchant: {
                capabilities: {
                  card_payments: { status: "restricted" },
                  stripe_balance: { payouts: { status: "restricted" } },
                },
              },
            },
          })) as (...args: never[]) => unknown),
          retrieve: record("accounts.retrieve", (async () => ({
            id: "acct_created",
            configuration: {
              merchant: {
                capabilities: {
                  card_payments: { status: "active" },
                  stripe_balance: { payouts: { status: "active" } },
                },
              },
            },
          })) as (...args: never[]) => unknown),
        },
      },
    },
    accountSessions: {
      create: record("accountSessions.create", (async (params: object) => ({
        client_secret: "cas_test_secret",
        ...params,
      })) as (...args: never[]) => unknown),
    },
    checkout: {
      sessions: {
        create: record("checkout.sessions.create", (async () => ({
          id: "cs_test",
          url: "https://checkout.stripe.com/c/pay/cs_test",
          payment_intent: "pi_test",
        })) as (...args: never[]) => unknown),
        retrieve: record("checkout.sessions.retrieve", (async (_id: string) => ({
          id: "cs_test",
          mode: "subscription",
          status: "complete",
          customer: "cus_existing",
          subscription: "sub_new",
          metadata: { plan: "pro", schedi_owner_id: "ignored" },
          payment_status: "paid",
          payment_intent: "pi_test",
        })) as (...args: never[]) => unknown),
      },
    },
    customers: {
      create: record("customers.create", (async () => ({ id: "cus_new" })) as (...args: never[]) => unknown),
    },
    products: {
      create: record("products.create", (async (params: { metadata?: { schedi_plan?: string } }) => ({
        id: `prod_${params.metadata?.schedi_plan}`,
      })) as (...args: never[]) => unknown),
    },
    prices: {
      list: record("prices.list", (async () => ({ data: [] })) as (...args: never[]) => unknown),
      create: record("prices.create", (async (params: { lookup_key?: string }) => ({
        id: `price_${params.lookup_key}`,
        ...params,
      })) as (...args: never[]) => unknown),
    },
    subscriptions: {
      retrieve: record("subscriptions.retrieve", (async (id: string) => ({
        id,
        status: "active",
        metadata: { plan: "starter", schedi_owner_id: "owner" },
        items: { data: [{ id: "si_1" }] },
      })) as (...args: never[]) => unknown),
      update: record("subscriptions.update", (async (id: string, params: { metadata?: Stripe.MetadataParam }) => ({
        id,
        status: "active",
        metadata: params.metadata,
        items: { data: [{ id: "si_1" }] },
      })) as (...args: never[]) => unknown),
      cancel: record("subscriptions.cancel", (async (id: string) => ({
        id,
        status: "canceled",
        metadata: { plan: "pro" },
      })) as (...args: never[]) => unknown),
    },
    billingPortal: {
      sessions: {
        create: record("billingPortal.sessions.create", (async () => ({
          url: "https://billing.stripe.com/p/session_test",
        })) as (...args: never[]) => unknown),
      },
    },
  };

  return stripe as unknown as Stripe & { calls: RecordedCall[] };
}

export function memoryStore(): Store {
  return openStore(":memory:");
}

export function seedProBusiness(
  store: Store,
  overrides: Partial<Business> & { email?: string; servicePrice?: number } = {},
) {
  const owner = store.createOwner({
    email: overrides.email ?? "owner@example.com",
    name: "Owner",
    stripeCustomerId: null,
  });
  const business = store.createBusiness({
    ownerId: owner.id,
    name: overrides.name ?? "Northwind Cuts",
    slug: overrides.slug ?? "northwind",
    plan: overrides.plan ?? "pro",
    subscriptionStatus: overrides.subscriptionStatus ?? "active",
    stripeSubscriptionId: overrides.stripeSubscriptionId,
    stripeAccountId: "stripeAccountId" in overrides ? overrides.stripeAccountId : "acct_northwind",
    cardPaymentsStatus: "cardPaymentsStatus" in overrides ? overrides.cardPaymentsStatus : "active",
    payoutsStatus: "payoutsStatus" in overrides ? overrides.payoutsStatus : "active",
    depositEnabled: overrides.depositEnabled ?? true,
    depositAmountCents: "depositAmountCents" in overrides ? overrides.depositAmountCents : 2500,
    paypal: overrides.paypal === undefined ? "leo@northwind.example" : overrides.paypal,
    payAtAppointment: overrides.payAtAppointment ?? true,
    cashApp: overrides.cashApp,
    zelle: overrides.zelle,
    venmo: overrides.venmo,
    country: overrides.country ?? "US",
  });
  const service = store.createService({
    businessId: business.id,
    name: "Haircut",
    durationMinutes: 45,
    priceCents: overrides.servicePrice ?? 8000,
  });
  return { owner, business, service };
}

export function keysDeep(value: unknown, found = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    found.add(key);
    keysDeep(child, found);
  }
  return found;
}

export type { Service };
