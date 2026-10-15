import type Stripe from "stripe";
import { confirmBooking, failBooking } from "./bookings";
import type { Store } from "./db";
import { SchediError } from "./errors";
import { applySubscriptionState } from "./subscription-state";

/**
 * Connected-account events are client card payments. They never pause the
 * public page. Owner subscription events on the platform account do.
 */
export function applyStripeEvent(store: Store, event: Stripe.Event): void {
  if (store.hasStripeEvent(event.id)) return;

  if (event.account) {
    applyConnectedEvent(store, event);
  } else {
    applyPlatformEvent(store, event);
  }

  store.markStripeEvent(event.id);
}

function isPublicSpaCharge(metadata: Stripe.Metadata | null | undefined): boolean {
  return metadata?.schedi_public_booking === "1";
}

/** Public SPA bookings live in Firestore. A missing local row must not fail the webhook. */
function ignoreMissingPublicBooking(error: unknown, metadata: Stripe.Metadata | null | undefined): boolean {
  return isPublicSpaCharge(metadata) && error instanceof SchediError && error.status === 404;
}

function applyConnectedEvent(store: Store, event: Stripe.Event): void {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "payment") return;
      if (event.type === "checkout.session.completed" && session.payment_status !== "paid") return;
      const bookingId = session.metadata?.schedi_booking_id;
      if (!bookingId) return;
      const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
      try {
        confirmBooking(store, bookingId, paymentIntentId);
      } catch (error) {
        if (ignoreMissingPublicBooking(error, session.metadata)) return;
        throw error;
      }
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
    default:
      return;
  }
}

function applyPlatformEvent(store: Store, event: Stripe.Event): void {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "subscription" || session.status !== "complete") return;
      const ownerId = session.metadata?.schedi_owner_id;
      const plan = session.metadata?.plan;
      if (!ownerId || (plan !== "starter" && plan !== "pro")) return;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;
      store.setSubscription(ownerId, {
        status: "active",
        plan,
        stripeSubscriptionId: subscriptionId,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
      });
      return;
    }
    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const ownerId = ownerIdForSubscription(store, subscription);
      if (!ownerId) return;
      // Scheduling cancel_at_period_end keeps status active. Access ends only when
      // Stripe deletes the subscription at the end of the paid period.
      if (subscription.status === "canceled") return;
      applySubscriptionState(store, ownerId, subscription);
      return;
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const ownerId = ownerIdForSubscription(store, subscription);
      if (!ownerId) return;
      applySubscriptionState(store, ownerId, {
        ...subscription,
        status: "canceled",
        cancel_at_period_end: false,
      });
      return;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      if (!customerId) return;
      const owner = store.getOwnerByStripeCustomer(customerId);
      if (!owner) return;
      store.setSubscription(owner.id, { status: "past_due" });
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
