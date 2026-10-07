import type Stripe from "stripe";
import { confirmBooking, failBooking } from "./bookings";
import type { Store } from "./db";
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
      confirmBooking(store, bookingId, paymentIntentId);
      return;
    }
    case "checkout.session.async_payment_failed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const bookingId = session.metadata?.schedi_booking_id;
      if (bookingId) failBooking(store, bookingId);
      return;
    }
    case "payment_intent.payment_failed": {
      const intent = event.data.object as Stripe.PaymentIntent;
      const bookingId = intent.metadata?.schedi_booking_id;
      if (bookingId) failBooking(store, bookingId);
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
      });
      return;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const ownerId = ownerIdForSubscription(store, subscription);
      if (!ownerId) return;
      const status = event.type === "customer.subscription.deleted" ? "canceled" : subscription.status;
      applySubscriptionState(store, ownerId, { ...subscription, status });
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
