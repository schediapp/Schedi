import type Stripe from "stripe";
import { confirmBooking, failBooking } from "./bookings.ts";
import { noticeFromCheckoutSession, recordConnectCardPayment, type ConnectCardPaidNotice } from "./connect-card-payment.ts";
import type { ConnectConfig } from "./connect-config.ts";
import { publishStripeConnectReady } from "./connect-ready.ts";
import type { Store } from "./db.ts";
import { SchediError } from "./errors.ts";
import { connectedChargesEnabled, readCapabilityStatuses, type MerchantCapabilityAccount } from "./readiness.ts";
import { applySubscriptionState } from "./subscription-state.ts";

export interface StripeEventDeps {
  recordPublicCardPayment?: (notice: ConnectCardPaidNotice) => Promise<void>;
  publishConnectReady?: (slug: string, ready: boolean, observedAt?: string) => Promise<void>;
  now?: number;
  config?: ConnectConfig;
  /** Test hook. Throws once inside the local fence transaction, before the row write. */
  failLocalWrite?: boolean;
}

/** Same-second cross-type order on one subscription fence. A higher rank wins. */
export function stripeEventRank(type: string): number {
  if (type === "customer.subscription.deleted") return 30;
  if (type === "customer.subscription.updated") return 20;
  if (type === "checkout.session.completed") return 15;
  if (type === "invoice.payment_failed") return 10;
  if (type === "account.updated") return 10;
  return 0;
}

function commitLocal(
  store: Store,
  key: string,
  observedAt: string,
  eventId: string,
  rank: number,
  write: () => void,
  deps?: StripeEventDeps,
): "apply" | "retry" | "stale" {
  return store.transaction(() => {
    const decision = store.advanceFence(key, observedAt, eventId, rank);
    if (decision !== "apply") return decision;
    if (deps?.failLocalWrite) {
      deps.failLocalWrite = false;
      throw new Error("injected_local_write_failure");
    }
    write();
    return "apply";
  });
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const legacy = (invoice as { subscription?: unknown }).subscription;
  if (typeof legacy === "string" && legacy) return legacy;
  if (legacy && typeof legacy === "object" && typeof (legacy as { id?: unknown }).id === "string") {
    return (legacy as { id: string }).id;
  }
  const parent = (invoice as { parent?: { subscription_details?: { subscription?: unknown } } }).parent;
  const current = parent?.subscription_details?.subscription;
  if (typeof current === "string" && current) return current;
  if (current && typeof current === "object" && typeof (current as { id?: unknown }).id === "string") {
    return (current as { id: string }).id;
  }
  return null;
}

function observedAtFor(event: Stripe.Event, now?: number): string {
  if (typeof event.created === "number" && Number.isFinite(event.created)) {
    return new Date(event.created * 1000).toISOString();
  }
  return new Date(now ?? Date.now()).toISOString();
}

/**
 * Connected-account events are client card payments. They never pause the
 * public page. Owner subscription events on the platform account do.
 */
export async function applyStripeEvent(store: Store, event: Stripe.Event, deps?: StripeEventDeps): Promise<void> {
  const claim = store.claimStripeEvent(event.id, deps?.now);
  if (claim.status === "done") return;
  if (claim.status === "inflight") {
    throw new SchediError("Stripe event is already being processed.", 500);
  }

  try {
    if (event.account) {
      await applyConnectedEvent(store, event, deps);
    } else {
      applyPlatformEvent(store, event, deps);
    }
    store.finishStripeEvent(event.id, claim.at);
  } catch (error) {
    store.releaseStripeEvent(event.id, claim.at);
    throw error;
  }
}

function isPublicSpaCharge(metadata: Stripe.Metadata | null | undefined): boolean {
  return metadata?.schedi_public_booking === "1";
}

/** Public SPA bookings live in Firestore. A missing local row must not fail the webhook. */
function ignoreMissingPublicBooking(error: unknown, metadata: Stripe.Metadata | null | undefined): boolean {
  return isPublicSpaCharge(metadata) && error instanceof SchediError && error.status === 404;
}

async function applyConnectedEvent(store: Store, event: Stripe.Event, deps?: StripeEventDeps): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "payment") return;
      if (event.type === "checkout.session.completed" && session.payment_status !== "paid") return;
      const bookingId = session.metadata?.schedi_booking_id;
      const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
      if (bookingId) {
        try {
          confirmBooking(store, bookingId, paymentIntentId);
        } catch (error) {
          if (!ignoreMissingPublicBooking(error, session.metadata)) throw error;
        }
      }
      const notice = noticeFromCheckoutSession(session, event.id);
      if (notice) await deliverCardPayment(store, event, notice, deps);
      return;
    }
    case "checkout.session.async_payment_failed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const bookingId = session.metadata?.schedi_booking_id;
      if (!bookingId) return;
      try {
        failBooking(store, bookingId);
      } catch (error) {
        if (ignoreMissingPublicBooking(error, session.metadata)) return;
        throw error;
      }
      return;
    }
    case "payment_intent.payment_failed": {
      const intent = event.data.object as Stripe.PaymentIntent;
      const bookingId = intent.metadata?.schedi_booking_id;
      if (!bookingId) return;
      try {
        failBooking(store, bookingId);
      } catch (error) {
        if (ignoreMissingPublicBooking(error, intent.metadata)) return;
        throw error;
      }
      return;
    }
    case "account.updated": {
      const account = event.data.object as Stripe.Account & MerchantCapabilityAccount & { charges_enabled?: boolean | null };
      const accountId = event.account || account.id;
      if (!accountId) return;
      const business = store.getBusinessByStripeAccount(accountId);
      if (!business) return;
      const observedAt = observedAtFor(event, deps?.now);
      const fenceKey = `account:${accountId}`;
      const ready = connectedChargesEnabled(account);
      const statuses = readCapabilityStatuses(account);
      if (account.charges_enabled === true && statuses.cardPaymentsStatus !== "active") {
        statuses.cardPaymentsStatus = "active";
      }
      if (account.charges_enabled === false) statuses.cardPaymentsStatus = "inactive";
      const decision = commitLocal(store, fenceKey, observedAt, event.id, stripeEventRank(event.type), () => {
        store.setCapabilities(business.id, statuses);
      }, deps);
      if (decision === "stale") return;
      await deliverConnectReady(store, event, business.slug, ready, observedAt, deps);
      return;
    }
    default:
      return;
  }
}

async function deliverCardPayment(
  store: Store,
  event: Stripe.Event,
  notice: ConnectCardPaidNotice,
  deps?: StripeEventDeps,
): Promise<void> {
  const id = `booking_paid:${event.id}`;
  if (store.beginOutbox(id, "booking_paid", JSON.stringify(notice), observedAtFor(event, deps?.now)) === "sent") return;
  const record = deps?.recordPublicCardPayment || ((item: ConnectCardPaidNotice) => recordConnectCardPayment(item, deps?.config));
  await record(notice);
  store.markOutboxSent(id);
}

async function deliverConnectReady(
  store: Store,
  event: Stripe.Event,
  slug: string,
  ready: boolean,
  observedAt: string,
  deps?: StripeEventDeps,
): Promise<void> {
  const id = `connect_ready:${event.id}`;
  const payload = JSON.stringify({ slug, ready, eventId: event.id, observedAt });
  if (store.beginOutbox(id, "connect_ready", payload, observedAt) === "sent") return;
  if (deps?.publishConnectReady) await deps.publishConnectReady(slug, ready, observedAt);
  else await publishStripeConnectReady(slug, ready, undefined, { eventId: event.id, observedAt }, deps?.config);
  store.markOutboxSent(id);
}

function applyPlatformEvent(store: Store, event: Stripe.Event, deps?: StripeEventDeps): void {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "subscription" || session.status !== "complete") return;
      const ownerId = session.metadata?.schedi_owner_id;
      const plan = session.metadata?.plan;
      if (!ownerId || (plan !== "starter" && plan !== "pro")) return;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;
      if (!subscriptionId) return;
      const observedAt = observedAtFor(event, deps?.now);
      commitLocal(store, `subscription:${subscriptionId}`, observedAt, event.id, stripeEventRank(event.type), () => {
        store.setSubscription(ownerId, {
          status: "active",
          plan,
          stripeSubscriptionId: subscriptionId,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: null,
        });
      }, deps);
      return;
    }
    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const ownerId = ownerIdForSubscription(store, subscription);
      if (!ownerId) return;
      // Scheduling cancel_at_period_end keeps status active. Access ends only when
      // Stripe deletes the subscription at the end of the paid period.
      if (subscription.status === "canceled") return;
      const observedAt = observedAtFor(event, deps?.now);
      commitLocal(
        store,
        `subscription:${subscription.id}`,
        observedAt,
        event.id,
        stripeEventRank(event.type),
        () => applySubscriptionState(store, ownerId, subscription),
        deps,
      );
      return;
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const ownerId = ownerIdForSubscription(store, subscription);
      if (!ownerId) return;
      const observedAt = observedAtFor(event, deps?.now);
      commitLocal(
        store,
        `subscription:${subscription.id}`,
        observedAt,
        event.id,
        stripeEventRank(event.type),
        () => applySubscriptionState(store, ownerId, {
          ...subscription,
          status: "canceled",
          cancel_at_period_end: false,
        }),
        deps,
      );
      return;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      const subscriptionId = invoiceSubscriptionId(invoice);
      if (!customerId || !subscriptionId) return;
      const owner = store.getOwnerByStripeCustomer(customerId);
      if (!owner) return;
      const business = store.getBusinessByOwner(owner.id);
      if (!business?.stripeSubscriptionId || business.stripeSubscriptionId !== subscriptionId) return;
      const observedAt = observedAtFor(event, deps?.now);
      commitLocal(
        store,
        `subscription:${subscriptionId}`,
        observedAt,
        event.id,
        stripeEventRank(event.type),
        () => store.setSubscription(owner.id, { status: "past_due" }),
        deps,
      );
      return;
    }
    default:
      return;
  }
}

function ownerIdForSubscription(store: Store, subscription: Stripe.Subscription): string | null {
  const fromMetadata = subscription.metadata?.schedi_owner_id;
  if (fromMetadata) return fromMetadata;
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  if (!customerId) return null;
  return store.getOwnerByStripeCustomer(customerId)?.id ?? null;
}
