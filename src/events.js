import { PLANS } from './plans.js';

function findBusiness(data, predicate) {
  return data.businesses.find(predicate) || null;
}

function bookingById(data, bookingId) {
  return data.bookings.find((booking) => booking.id === bookingId) || null;
}

export function confirmBooking(data, bookingId) {
  const booking = bookingById(data, bookingId);
  if (!booking || booking.status === 'failed' || booking.status === 'confirmed') return booking;
  booking.status = 'confirmed';
  booking.confirmedAt = new Date().toISOString();
  return booking;
}

export function failBooking(data, bookingId) {
  const booking = bookingById(data, bookingId);
  if (!booking || booking.status === 'confirmed') return booking;
  booking.status = 'failed';
  booking.failedAt = new Date().toISOString();
  return booking;
}

function applySubscription(data, subscription) {
  const businessId = subscription.metadata?.schedi_business_id;
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const business = findBusiness(data, (item) => {
    if (businessId && item.id === businessId) return true;
    if (subscription.id && item.subscriptionId === subscription.id) return true;
    if (customerId && item.stripeCustomerId === customerId) return true;
    return false;
  });
  if (!business) return null;
  business.subscriptionId = subscription.id;
  business.subscriptionStatus = subscription.status === 'deleted' ? 'canceled' : subscription.status;
  business.subscriptionItemId = subscription.items?.data?.[0]?.id || business.subscriptionItemId || null;
  const plan = subscription.metadata?.schedi_plan;
  if (plan && PLANS[plan] && (subscription.status === 'active' || subscription.status === 'trialing')) {
    business.plan = plan;
  }
  return business;
}

export async function applyStripeEvent({ store, stripe, event }) {
  const already = store.read().processedEvents.includes(event.id);
  if (already) return { duplicate: true };

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded' || event.type === 'checkout.session.async_payment_failed') {
    await handleCheckout({ store, stripe, event });
  } else if (event.type === 'payment_intent.payment_failed') {
    const bookingId = event.data?.object?.metadata?.schedi_booking_id;
    if (bookingId) store.update((data) => failBooking(data, bookingId));
  } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    if (event.type === 'customer.subscription.deleted') subscription.status = 'canceled';
    store.update((data) => applySubscription(data, subscription));
  } else if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
    if (subscriptionId) {
      store.update((data) => {
        const business = findBusiness(data, (item) => item.subscriptionId === subscriptionId || item.stripeCustomerId === invoice.customer);
        if (!business || business.plan === 'free') return;
        if (business.subscriptionStatus === 'active' || business.subscriptionStatus === 'trialing') {
          business.subscriptionStatus = 'past_due';
        }
      });
    }
  }

  store.update((data) => {
    data.processedEvents.push(event.id);
    if (data.processedEvents.length > 500) data.processedEvents.splice(0, data.processedEvents.length - 500);
  });
  return { duplicate: false };
}

async function handleCheckout({ store, stripe, event }) {
  const session = event.data.object;
  if (session.mode === 'subscription') {
    if (event.type === 'checkout.session.async_payment_failed') return;
    if (session.payment_status !== 'paid' && session.status !== 'complete') return;
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    if (!subscriptionId) return;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    store.update((data) => {
      const business = applySubscription(data, subscription);
      if (business && session.customer && !business.stripeCustomerId) {
        business.stripeCustomerId = session.customer;
      }
    });
    return;
  }

  const bookingId = session.metadata?.schedi_booking_id;
  if (!bookingId) return;
  if (event.type === 'checkout.session.async_payment_failed') {
    store.update((data) => failBooking(data, bookingId));
    return;
  }
  if (session.payment_status !== 'paid' && event.type !== 'checkout.session.async_payment_succeeded') return;

  store.update((data) => {
    const booking = bookingById(data, bookingId);
    if (!booking) return;
    if (event.account && booking.stripeAccountId && event.account !== booking.stripeAccountId) return;
    confirmBooking(data, bookingId);
  });
}

export async function syncSubscriptionCheckout({ store, stripe, businessId, sessionId }) {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.metadata?.schedi_business_id !== businessId) {
    return { error: 'That checkout belongs to a different business.', status: 403 };
  }
  if (session.mode !== 'subscription') {
    return { error: 'That checkout is not a Schedi subscription.', status: 400 };
  }
  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return { pending: true };
  }
  const subscription = await stripe.subscriptions.retrieve(session.subscription);
  store.update((data) => applySubscription(data, subscription));
  return { pending: false };
}

export async function syncBookingCheckout({ store, stripe, booking }) {
  if (!booking.stripeCheckoutSessionId || !booking.stripeAccountId) return booking;
  const session = await stripe.checkout.sessions.retrieve(
    booking.stripeCheckoutSessionId,
    {},
    { stripeAccount: booking.stripeAccountId },
  );
  if (session.payment_status === 'paid') {
    store.update((data) => confirmBooking(data, booking.id));
  }
  return store.read().bookings.find((item) => item.id === booking.id);
}
