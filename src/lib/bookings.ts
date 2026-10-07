import type Stripe from "stripe";
import type { Store } from "./db";
import { createDirectChargeCheckout } from "./checkout";
import { SchediError } from "./errors";
import { depositAmountFor, listPaymentOptions } from "./payment-options";
import { isCardCheckoutReady, isPublicPageLive } from "./readiness";
import { upcomingSlots } from "./slots";
import type { Booking, ChargeKind, PaymentMethod } from "./types";

const SLOT_HOLD_MS = 45 * 60 * 1000;

export function takenSlotTimes(store: Store, businessId: string, now: Date): Set<string> {
  const taken = new Set<string>();
  for (const booking of store.listBookings(businessId)) {
    if (booking.status === "confirmed") {
      taken.add(booking.startsAt);
      continue;
    }
    if (booking.status === "pending_payment") {
      const age = now.getTime() - new Date(booking.createdAt).getTime();
      if (age < SLOT_HOLD_MS) taken.add(booking.startsAt);
    }
  }
  return taken;
}

export async function placeBooking(
  store: Store,
  stripe: Stripe | null,
  input: {
    slug: string;
    serviceId: string;
    startsAt: string;
    clientName: string;
    clientEmail: string;
    method: PaymentMethod;
    chargeKind: ChargeKind | null;
    successUrl: string;
    cancelUrl: string;
  },
  now = new Date(),
): Promise<{ booking: Booking; redirectUrl: string | null }> {
  const business = store.getBusinessBySlug(input.slug);
  if (!business) throw new SchediError("Business not found.", 404);
  if (!isPublicPageLive(business.subscriptionStatus)) {
    throw new SchediError("This booking page is paused.", 403);
  }

  const service = store.getService(input.serviceId);
  if (service.businessId !== business.id) throw new SchediError("Service not found.", 404);

  const clientName = input.clientName.trim();
  const clientEmail = input.clientEmail.trim().toLowerCase();
  if (clientName.length < 2) throw new SchediError("Enter your name.", 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) throw new SchediError("Enter a valid email.", 400);

  const offered = upcomingSlots(now, takenSlotTimes(store, business.id, now));
  if (!offered.includes(input.startsAt)) throw new SchediError("Choose an open time.", 400);

  const choice = listPaymentOptions(business, service).find(
    (option) => option.method === input.method && option.chargeKind === input.chargeKind,
  );
  if (!choice) throw new SchediError("That payment method is not available.", 400);

  if (input.method !== "card") {
    const booking = store.createBooking({
      businessId: business.id,
      serviceId: service.id,
      clientName,
      clientEmail,
      startsAt: input.startsAt,
      paymentMethod: input.method,
      chargeKind: null,
      amountCents: service.priceCents,
      status: "confirmed",
    });
    return { booking, redirectUrl: null };
  }

  if (!isCardCheckoutReady(business)) {
    throw new SchediError("Card payments are not available for this business.", 403);
  }
  if (!stripe || !business.stripeAccountId) {
    throw new SchediError("Card payments are not available right now.", 503);
  }

  const amount =
    input.chargeKind === "deposit" ? depositAmountFor(service, business) : service.priceCents;
  if (input.chargeKind === "deposit" && amount == null) {
    throw new SchediError("A card deposit is not available.", 400);
  }

  const booking = store.createBooking({
    businessId: business.id,
    serviceId: service.id,
    clientName,
    clientEmail,
    startsAt: input.startsAt,
    paymentMethod: "card",
    chargeKind: input.chargeKind,
    amountCents: amount ?? service.priceCents,
    status: "pending_payment",
  });

  try {
    const session = await createDirectChargeCheckout(stripe, {
      stripeAccountId: business.stripeAccountId,
      businessName: business.name,
      serviceName: service.name,
      amountCents: booking.amountCents,
      chargeKind: input.chargeKind ?? "full",
      bookingId: booking.id,
      businessId: business.id,
      clientEmail,
      successUrl: input.successUrl.replace("{BOOKING_ID}", booking.id),
      cancelUrl: input.cancelUrl,
    });
    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
    const saved = store.updateBooking(booking.id, {
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: paymentIntentId,
    });
    return { booking: saved, redirectUrl: session.url };
  } catch (error) {
    store.updateBooking(booking.id, { status: "payment_failed" });
    if (error instanceof SchediError) throw error;
    const message = error instanceof Error ? error.message : "The card payment could not be started.";
    throw new SchediError(message, 502);
  }
}

export async function fulfillBookingCheckout(store: Store, stripe: Stripe, booking: Booking): Promise<Booking> {
  if (booking.status === "confirmed" || !booking.stripeCheckoutSessionId) return booking;
  const business = store.getBusiness(booking.businessId);
  if (!business.stripeAccountId) return booking;

  const session = await stripe.checkout.sessions.retrieve(
    booking.stripeCheckoutSessionId,
    {},
    { stripeAccount: business.stripeAccountId },
  );
  if (session.metadata?.schedi_booking_id && session.metadata.schedi_booking_id !== booking.id) return booking;
  if (session.payment_status !== "paid") return booking;

  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : booking.stripePaymentIntentId;
  return store.updateBooking(booking.id, {
    status: "confirmed",
    stripePaymentIntentId: paymentIntentId,
  });
}

export function confirmBooking(store: Store, bookingId: string, paymentIntentId: string | null): void {
  const booking = store.getBooking(bookingId);
  if (booking.status === "confirmed") return;
  store.updateBooking(bookingId, {
    status: "confirmed",
    stripePaymentIntentId: paymentIntentId,
  });
}

export function failBooking(store: Store, bookingId: string): void {
  const booking = store.getBooking(bookingId);
  if (booking.status === "confirmed" || booking.status === "payment_failed") return;
  store.updateBooking(bookingId, { status: "payment_failed" });
}
