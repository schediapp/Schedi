import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from './auth.js';
import { applyStripeEvent, syncBookingCheckout, syncSubscriptionCheckout } from './events.js';
import { isPublicPagePaused, MANUAL_METHODS, manualMethodReady, PLANS } from './plans.js';
import {
  accountSessionParams,
  assertConnectedAccountParams,
  assertDirectCharge,
  assertSubscriptionCheckout,
  cardPaymentsLive,
  connectedAccountParams,
  directChargeParams,
  readCapabilityStatus,
  subscriptionCheckoutParams,
} from './payloads.js';
import { slugify } from './statements.js';

function id() {
  return crypto.randomUUID();
}

function fail(status, error) {
  return { status, body: { error } };
}

export function blankPayments() {
  return {
    cashapp: { enabled: false, handle: '' },
    zelle: { enabled: false, handle: '' },
    venmo: { enabled: false, handle: '' },
    paypal: { enabled: false, handle: '' },
    payAtAppointment: { enabled: true },
  };
}

function businessById(data, businessId) {
  return data.businesses.find((business) => business.id === businessId) || null;
}

function businessBySlug(data, slug) {
  return data.businesses.find((business) => business.slug === slug) || null;
}

export function publicBusinessView(business, account) {
  const live = Boolean(account && cardPaymentsLive(account));
  const paused = isPublicPagePaused(business);
  const cardAvailable = !paused && business.plan === 'pro' && business.cardsEnabled && live;
  const methods = {};
  for (const method of MANUAL_METHODS) {
    methods[method] = {
      enabled: manualMethodReady(business, method),
      handle: method === 'pay_at_appointment' ? '' : business.payments?.[method]?.handle || '',
    };
  }
  return {
    name: business.name,
    slug: business.slug,
    paused,
    services: business.services.map((service) => ({
      id: service.id,
      name: service.name,
      priceCents: service.priceCents,
      durationMin: service.durationMin,
    })),
    methods,
    card: { available: cardAvailable },
    deposit: {
      available: cardAvailable && Boolean(business.deposit?.enabled),
      amountCents: business.deposit?.amountCents || 0,
    },
  };
}

export function ownerView(business, { publishableKey, simulate }) {
  const status = {
    cardPayments: business.cardPaymentsStatus,
    payouts: business.payoutsStatus,
  };
  const live = status.cardPayments === 'active' && status.payouts === 'active';
  return {
    business: {
      id: business.id,
      name: business.name,
      email: business.email,
      slug: business.slug,
      country: business.country,
      entityType: business.entityType,
      plan: business.plan,
      subscriptionStatus: business.subscriptionStatus,
      paused: isPublicPagePaused(business),
      cardsEnabled: business.cardsEnabled,
      connected: Boolean(business.connectedAccountId),
      connectedAccountId: business.connectedAccountId,
      cardPaymentsStatus: status.cardPayments,
      payoutsStatus: status.payouts,
      cardLive: live,
      deposit: business.deposit,
      payments: business.payments,
      services: business.services,
    },
    plans: Object.values(PLANS).map((plan) => ({
      id: plan.id,
      name: plan.name,
      amountCents: plan.amountCents,
    })),
    publishableKey: publishableKey || '',
    simulate: Boolean(simulate),
    dashboardUrl: 'https://dashboard.stripe.com',
  };
}

function rememberCapabilities(business, account) {
  const status = readCapabilityStatus(account);
  business.cardPaymentsStatus = status.cardPayments;
  business.payoutsStatus = status.payouts;
}

async function loadAccount(stripe, business) {
  if (!stripe || !business.connectedAccountId) return null;
  const account = await stripe.v2.core.accounts.retrieve(business.connectedAccountId, {
    include: ['configuration.merchant', 'identity', 'defaults'],
  });
  return account;
}

export function registerBusiness(store, input) {
  const name = String(input.name || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');
  const country = String(input.country || 'us').trim().toLowerCase();
  const entityType = input.entityType === 'individual' ? 'individual' : 'company';
  if (name.length < 2 || name.length > 80) return fail(400, 'Enter the business name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'Enter a valid email.');
  if (password.length < 8) return fail(400, 'Use at least 8 characters for the password.');
  if (!/^[a-z]{2}$/.test(country)) return fail(400, 'Use a two-letter country code.');

  let sessionId = '';
  let created = null;
  const result = store.update((data) => {
    if (data.businesses.some((business) => business.email === email)) {
      created = { error: 'An owner with that email already exists.' };
      return;
    }
    let slug = slugify(input.slug || name);
    if (data.businesses.some((business) => business.slug === slug)) {
      slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
    }
    created = {
      id: id(),
      name,
      email,
      passwordHash: hashPassword(password),
      slug,
      country,
      entityType,
      plan: 'free',
      subscriptionStatus: 'none',
      subscriptionId: null,
      subscriptionItemId: null,
      stripeCustomerId: null,
      connectedAccountId: null,
      cardsEnabled: false,
      cardPaymentsStatus: null,
      payoutsStatus: null,
      deposit: { enabled: false, amountCents: 2000 },
      payments: blankPayments(),
      services: [],
      createdAt: new Date().toISOString(),
    };
    data.businesses.push(created);
    sessionId = id();
    data.sessions.push({ id: sessionId, businessId: created.id });
  });
  if (created?.error) return fail(409, created.error);
  return { status: 201, sessionId, business: businessById(result, created.id) };
}

export function loginBusiness(store, input) {
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');
  const data = store.read();
  const business = data.businesses.find((item) => item.email === email);
  if (!business || !verifyPassword(password, business.passwordHash)) {
    return fail(401, 'Email or password is incorrect.');
  }
  let sessionId = '';
  store.update((draft) => {
    sessionId = id();
    draft.sessions.push({ id: sessionId, businessId: business.id });
  });
  return { status: 200, sessionId, business };
}

export function logout(store, sessionId) {
  if (!sessionId) return;
  store.update((data) => {
    data.sessions = data.sessions.filter((session) => session.id !== sessionId);
  });
}

export function currentBusiness(store, sessionId) {
  if (!sessionId) return null;
  const data = store.read();
  const session = data.sessions.find((item) => item.id === sessionId);
  if (!session) return null;
  return businessById(data, session.businessId);
}

export async function updateProfile(store, stripe, businessId, input) {
  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 80) return fail(400, 'Enter the business name.');
  store.update((data) => {
    const business = businessById(data, businessId);
    business.name = name;
  });
  const business = businessById(store.read(), businessId);
  if (stripe && business.connectedAccountId) {
    const params = connectedAccountParams(business, '');
    await stripe.v2.core.accounts.update(business.connectedAccountId, {
      display_name: business.name,
      configuration: {
        merchant: { statement_descriptor: params.configuration.merchant.statement_descriptor },
      },
      defaults: { profile: { doing_business_as: business.name } },
      include: ['configuration.merchant'],
    });
  }
  return { status: 200, business };
}

export function addService(store, businessId, input) {
  const name = String(input.name || '').trim();
  const priceCents = Number(input.priceCents);
  const durationMin = Number(input.durationMin || 60);
  if (name.length < 2) return fail(400, 'Name the service.');
  if (!Number.isInteger(priceCents) || priceCents < 50) return fail(400, 'Price must be at least $0.50.');
  if (!Number.isInteger(durationMin) || durationMin < 5 || durationMin > 480) {
    return fail(400, 'Duration must be between 5 and 480 minutes.');
  }
  const service = { id: id(), name, priceCents, durationMin };
  store.update((data) => {
    businessById(data, businessId).services.push(service);
  });
  return { status: 201, service };
}

export function removeService(store, businessId, serviceId) {
  store.update((data) => {
    const business = businessById(data, businessId);
    business.services = business.services.filter((service) => service.id !== serviceId);
  });
  return { status: 200 };
}

export function updatePayments(store, businessId, input) {
  if (input.deposit) {
    const amountCents = Number(input.deposit.amountCents);
    if (!Number.isInteger(amountCents) || amountCents < 50) {
      return fail(400, 'Deposit must be at least $0.50.');
    }
  }
  store.update((data) => {
    const business = businessById(data, businessId);
    for (const method of ['cashapp', 'zelle', 'venmo', 'paypal']) {
      if (!input[method]) continue;
      business.payments[method] = {
        enabled: Boolean(input[method].enabled),
        handle: String(input[method].handle || '').trim().slice(0, 80),
      };
    }
    if (input.payAtAppointment) {
      business.payments.payAtAppointment = { enabled: Boolean(input.payAtAppointment.enabled) };
    }
    if (input.deposit) {
      business.deposit = {
        enabled: Boolean(input.deposit.enabled),
        amountCents: Number(input.deposit.amountCents),
      };
    }
    if (typeof input.cardsEnabled === 'boolean' && business.connectedAccountId) {
      business.cardsEnabled = input.cardsEnabled;
    }
  });
  return { status: 200, business: businessById(store.read(), businessId) };
}

async function ensureCustomer(store, stripe, businessId) {
  const existing = businessById(store.read(), businessId);
  if (existing.stripeCustomerId) return existing.stripeCustomerId;
  const customer = await stripe.customers.create({
    email: existing.email,
    name: existing.name,
    metadata: { schedi_business_id: existing.id },
  });
  store.update((data) => {
    const business = businessById(data, businessId);
    if (!business.stripeCustomerId) business.stripeCustomerId = customer.id;
  });
  return businessById(store.read(), businessId).stripeCustomerId;
}

async function ensurePrice(store, stripe, planId) {
  const cached = store.read().prices[planId];
  if (cached) return cached;
  const plan = PLANS[planId];
  const product = await stripe.products.create({ name: plan.name });
  const price = await stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: plan.amountCents,
    recurring: { interval: 'month' },
  });
  store.update((data) => {
    if (!data.prices[planId]) data.prices[planId] = price.id;
  });
  return store.read().prices[planId];
}

export async function changePlan({ store, stripe, config, businessId, planId }) {
  if (!PLANS[planId]) return fail(400, 'Unknown plan.');
  const business = businessById(store.read(), businessId);
  if (planId === 'free') {
    if (business.subscriptionId && stripe) {
      await stripe.subscriptions.cancel(business.subscriptionId);
    }
    store.update((data) => {
      const current = businessById(data, businessId);
      current.plan = 'free';
      current.subscriptionStatus = 'none';
      current.subscriptionId = null;
      current.subscriptionItemId = null;
    });
    return { status: 200, business: businessById(store.read(), businessId) };
  }
  if (!stripe) return fail(503, 'Add the Stripe secret key before billing a paid plan.');

  const customerId = await ensureCustomer(store, stripe, businessId);
  const priceId = await ensurePrice(store, stripe, planId);
  const current = businessById(store.read(), businessId);
  current.stripeCustomerId = customerId;

  const open = ['active', 'trialing', 'past_due', 'unpaid'].includes(current.subscriptionStatus);
  if (open && current.subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(current.subscriptionId);
    const itemId = subscription.items?.data?.[0]?.id;
    const updated = await stripe.subscriptions.update(current.subscriptionId, {
      items: [{ id: itemId, price: priceId }],
      metadata: { schedi_business_id: current.id, schedi_plan: planId },
      proration_behavior: 'create_prorations',
    });
    store.update((data) => {
      const owner = businessById(data, businessId);
      owner.subscriptionStatus = updated.status;
      owner.subscriptionItemId = updated.items?.data?.[0]?.id || itemId;
      if (updated.status === 'active' || updated.status === 'trialing') owner.plan = planId;
    });
    return { status: 200, business: businessById(store.read(), businessId) };
  }

  const params = subscriptionCheckoutParams({
    business: current,
    priceId,
    planId,
    successUrl: `${config.publicBaseUrl}/portal?plan_return=1&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${config.publicBaseUrl}/portal?plan_canceled=1`,
  });
  assertSubscriptionCheckout(params);
  const session = await stripe.checkout.sessions.create(params, {
    idempotencyKey: `schedi_plan_${current.id}_${planId}_${crypto.randomBytes(4).toString('hex')}`,
  });
  return { status: 200, checkoutUrl: session.url };
}

export async function confirmPlan({ store, stripe, businessId, sessionId }) {
  if (!stripe) return fail(503, 'Stripe is not configured.');
  const result = await syncSubscriptionCheckout({ store, stripe, businessId, sessionId });
  if (result.error) return fail(result.status, result.error);
  return {
    status: 200,
    pending: Boolean(result.pending),
    business: businessById(store.read(), businessId),
  };
}

export async function openBillingPortal({ store, stripe, config, businessId }) {
  const business = businessById(store.read(), businessId);
  if (!business.stripeCustomerId) return fail(400, 'Choose a paid plan before opening billing.');
  if (!stripe) return fail(503, 'Stripe is not configured.');
  const session = await stripe.billingPortal.sessions.create({
    customer: business.stripeCustomerId,
    return_url: `${config.publicBaseUrl}/portal`,
  });
  return { status: 200, url: session.url };
}

export async function enableCards({ store, stripe, config, businessId }) {
  const business = businessById(store.read(), businessId);
  if (business.plan !== 'pro') {
    return fail(403, 'Card payments are available on Pro.');
  }
  if (!business.connectedAccountId && isPublicPagePaused(business)) {
    return fail(403, 'Card payments are available on an active Pro plan.');
  }
  if (!stripe) return fail(503, 'Add the Stripe secret key before turning on card payments.');
  if (business.connectedAccountId) {
    const account = await loadAccount(stripe, business);
    store.update((data) => rememberCapabilities(businessById(data, businessId), account));
    return { status: 200, business: businessById(store.read(), businessId) };
  }

  const params = connectedAccountParams(business, config.publicBaseUrl);
  assertConnectedAccountParams(params);
  const account = await stripe.v2.core.accounts.create(params, {
    idempotencyKey: `schedi_connect_${business.id}`,
  });
  store.update((data) => {
    const current = businessById(data, businessId);
    current.connectedAccountId = account.id;
    current.cardsEnabled = true;
    rememberCapabilities(current, account);
  });
  return { status: 201, business: businessById(store.read(), businessId) };
}

export async function refreshConnect({ store, stripe, businessId }) {
  const business = businessById(store.read(), businessId);
  if (!business.connectedAccountId) return { status: 200, business };
  if (!stripe) return fail(503, 'Stripe is not configured.');
  const account = await loadAccount(stripe, business);
  store.update((data) => rememberCapabilities(businessById(data, businessId), account));
  return { status: 200, business: businessById(store.read(), businessId) };
}

export async function createAccountSession({ store, stripe, businessId }) {
  const business = businessById(store.read(), businessId);
  if (!business.connectedAccountId) return fail(400, 'Turn on card payments before opening Stripe onboarding.');
  if (!stripe) return fail(503, 'Stripe is not configured.');
  const params = accountSessionParams(business.connectedAccountId);
  const session = await stripe.accountSessions.create(params);
  return { status: 200, clientSecret: session.client_secret };
}

export async function publicPage({ store, stripe, slug }) {
  const business = businessBySlug(store.read(), slug);
  if (!business) return fail(404, 'Booking page not found.');
  let account = null;
  if (business.connectedAccountId && stripe && business.plan === 'pro' && business.cardsEnabled && !isPublicPagePaused(business)) {
    account = await loadAccount(stripe, business);
    store.update((data) => rememberCapabilities(businessBySlug(data, slug), account));
  }
  return { status: 200, body: publicBusinessView(businessBySlug(store.read(), slug), account) };
}

function instructionsFor(business, booking) {
  if (booking.method === 'card') {
    if (booking.chargeKind === 'deposit') {
      const rest = (booking.balanceDueCents / 100).toFixed(2);
      return `${business.name} received the card deposit. Pay the remaining $${rest} at the appointment.`;
    }
    return `${business.name} received the card payment.`;
  }
  const price = (booking.amountCents / 100).toFixed(2);
  if (booking.method === 'pay_at_appointment') {
    return `Pay $${price} to ${business.name} at the appointment.`;
  }
  const labels = { cashapp: 'Cash App', zelle: 'Zelle', venmo: 'Venmo', paypal: 'PayPal' };
  const handle = business.payments[booking.method].handle;
  return `Send $${price} to ${handle} with ${labels[booking.method]}. ${business.name} will confirm it separately. Your appointment is booked.`;
}

function publicBooking(booking, business) {
  return {
    id: booking.id,
    status: booking.status,
    method: booking.method,
    chargeKind: booking.chargeKind,
    amountCents: booking.amountCents,
    balanceDueCents: booking.balanceDueCents,
    serviceName: booking.serviceName,
    start: booking.start,
    instructions: booking.status === 'failed' ? 'The card payment did not go through. The booking page is still open.' : instructionsFor(business, booking),
  };
}

export async function createBooking({ store, stripe, config, slug, input }) {
  const data = store.read();
  const business = businessBySlug(data, slug);
  if (!business) return fail(404, 'Booking page not found.');
  if (isPublicPagePaused(business)) return fail(403, 'This booking page is paused.');

  const service = business.services.find((item) => item.id === input.serviceId);
  if (!service) return fail(400, 'Choose a service.');
  const clientName = String(input.clientName || '').trim();
  const clientEmail = String(input.clientEmail || '').trim().toLowerCase();
  const start = String(input.start || '');
  if (clientName.length < 2) return fail(400, 'Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) return fail(400, 'Enter a valid email.');
  const when = new Date(start);
  if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 60_000) {
    return fail(400, 'Choose a future time.');
  }

  const method = input.method;
  if (MANUAL_METHODS.includes(method)) {
    if (!manualMethodReady(business, method)) return fail(400, 'That payment method is not offered.');
    const booking = {
      id: id(),
      businessId: business.id,
      serviceId: service.id,
      serviceName: service.name,
      clientName,
      clientEmail,
      start: when.toISOString(),
      method,
      chargeKind: 'manual',
      amountCents: service.priceCents,
      balanceDueCents: service.priceCents,
      status: 'confirmed',
      stripeCheckoutSessionId: null,
      stripeAccountId: null,
      createdAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
    };
    store.update((draft) => draft.bookings.push(booking));
    return { status: 201, body: { booking: publicBooking(booking, business) } };
  }

  if (method !== 'card') return fail(400, 'Choose how you will pay.');
  if (business.plan !== 'pro' || !business.cardsEnabled || !business.connectedAccountId) {
    return fail(403, 'Card checkout is not available.');
  }
  if (!stripe) return fail(503, 'Card checkout is not available.');

  const account = await loadAccount(stripe, business);
  store.update((draft) => rememberCapabilities(businessBySlug(draft, slug), account));
  if (!cardPaymentsLive(account)) {
    return fail(409, 'Card checkout is hidden until card payments and payouts are active.');
  }

  const wantDeposit = Boolean(input.deposit);
  if (wantDeposit && !business.deposit?.enabled) return fail(400, 'This business is not collecting a deposit.');
  const amountCents = wantDeposit ? business.deposit.amountCents : service.priceCents;
  if (!Number.isInteger(amountCents) || amountCents < 50 || amountCents > service.priceCents) {
    return fail(400, 'The card amount has to cover at least $0.50 and cannot exceed the service price.');
  }

  const booking = {
    id: id(),
    businessId: business.id,
    serviceId: service.id,
    serviceName: service.name,
    clientName,
    clientEmail,
    start: when.toISOString(),
    method: 'card',
    chargeKind: wantDeposit ? 'deposit' : 'full',
    amountCents,
    balanceDueCents: service.priceCents - amountCents,
    status: 'pending',
    stripeCheckoutSessionId: null,
    stripeAccountId: business.connectedAccountId,
    createdAt: new Date().toISOString(),
  };
  store.update((draft) => draft.bookings.push(booking));

  const title = wantDeposit ? `Deposit for ${service.name}` : service.name;
  const charge = directChargeParams({
    business,
    booking,
    amountCents,
    title,
    successUrl: `${config.publicBaseUrl}/b/${business.slug}/return?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${config.publicBaseUrl}/b/${business.slug}?canceled=1`,
  });
  assertDirectCharge(charge.params, charge.options);

  try {
    const session = await stripe.checkout.sessions.create(charge.params, charge.options);
    store.update((draft) => {
      const saved = draft.bookings.find((item) => item.id === booking.id);
      saved.stripeCheckoutSessionId = session.id;
    });
    return { status: 201, body: { checkoutUrl: session.url, booking: { id: booking.id, status: 'pending' } } };
  } catch (error) {
    store.update((draft) => {
      const saved = draft.bookings.find((item) => item.id === booking.id);
      saved.status = 'failed';
    });
    return fail(502, error.message || 'Could not start card checkout.');
  }
}

export async function finishCardReturn({ store, stripe, slug, sessionId }) {
  const data = store.read();
  const business = businessBySlug(data, slug);
  if (!business) return fail(404, 'Booking page not found.');
  const booking = data.bookings.find((item) => item.stripeCheckoutSessionId === sessionId && item.businessId === business.id);
  if (!booking) return fail(404, 'Booking not found.');
  if (!stripe) return fail(503, 'Stripe is not configured.');
  const synced = await syncBookingCheckout({ store, stripe, booking });
  const latestBusiness = businessBySlug(store.read(), slug);
  return {
    status: 200,
    body: {
      booking: publicBooking(synced, latestBusiness),
      paused: isPublicPagePaused(latestBusiness),
    },
  };
}

export function listBookings(store, businessId) {
  return store.read().bookings
    .filter((booking) => booking.businessId === businessId)
    .map((booking) => ({
      id: booking.id,
      clientName: booking.clientName,
      clientEmail: booking.clientEmail,
      serviceName: booking.serviceName,
      start: booking.start,
      method: booking.method,
      chargeKind: booking.chargeKind,
      amountCents: booking.amountCents,
      status: booking.status,
    }));
}

export async function simulateCapability({ store, stripe, businessId, cardPayments, payouts }) {
  const business = businessById(store.read(), businessId);
  if (!business.connectedAccountId) return fail(400, 'Turn on card payments first.');
  const account = stripe.accounts.get(business.connectedAccountId);
  if (!account) return fail(404, 'Connected account not found.');
  if (cardPayments) account.configuration.merchant.capabilities.card_payments.status = cardPayments;
  if (payouts) account.configuration.merchant.capabilities.stripe_balance.payouts.status = payouts;
  store.update((data) => rememberCapabilities(businessById(data, businessId), account));
  return { status: 200, business: businessById(store.read(), businessId) };
}

export async function simulatePay({ store, stripe, sessionId }) {
  const session = stripe.markSessionPaid(sessionId);
  const event = {
    id: `evt_${crypto.randomBytes(6).toString('hex')}`,
    type: 'checkout.session.completed',
    account: session.stripeAccount || undefined,
    data: { object: session },
  };
  await applyStripeEvent({ store, stripe, event });
  return session;
}

export { applyStripeEvent };
