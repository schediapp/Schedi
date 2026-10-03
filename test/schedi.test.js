import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';
import { createSimulatedStripe } from '../src/simulatedStripe.js';
import { chargeStatement } from '../src/statements.js';
import {
  assertConnectedAccountParams,
  assertDirectCharge,
  assertSubscriptionCheckout,
  cardPaymentsLive,
  connectedAccountParams,
  directChargeParams,
} from '../src/payloads.js';

const webhookSecret = 'whsec_schedi_test_secret';

function hasKey(value, key) {
  if (!value || typeof value !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value).some((entry) => hasKey(entry, key));
}

async function start() {
  const stripe = createSimulatedStripe({ publicBaseUrl: 'http://127.0.0.1' });
  const store = createStore();
  const config = {
    publicBaseUrl: 'http://127.0.0.1',
    publishableKey: '',
    webhookSecret,
    sessionSecret: 'test-session-secret',
    simulate: true,
  };
  const server = createApp({ store, stripe, config }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    stripe,
    store,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function request(base, path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  const setCookie = response.headers.get('set-cookie') || '';
  const match = setCookie.match(/schedi=([^;]+)/);
  return { status: response.status, json, cookie: match ? `schedi=${match[1]}` : cookie || '' };
}

test('statement descriptor carries the business name within card limits', () => {
  const statement = chargeStatement('Northside Salon');
  assert.match(statement.descriptor, /NORTHSIDE/);
  assert.equal(statement.prefix.length >= 2 && statement.prefix.length <= 10, true);
  assert.equal(statement.prefix.length + statement.suffix.length + 2 <= 22, true);
  assert.doesNotMatch(`${statement.descriptor}${statement.prefix}${statement.suffix}`, /[^A-Z0-9 ]/);
});

test('account and charge payloads follow the accepted Connect plan', () => {
  const business = {
    id: 'biz_1',
    name: 'Northside Salon',
    email: 'owner@northside.example',
    slug: 'northside-salon',
    country: 'us',
    entityType: 'company',
    connectedAccountId: 'acct_123',
    stripeCustomerId: 'cus_123',
  };
  const account = connectedAccountParams(business, 'https://schedi.example');
  assertConnectedAccountParams(account);
  assert.equal(account.dashboard, 'full');
  assert.equal(account.defaults.responsibilities.fees_collector, 'stripe');
  assert.equal(account.defaults.responsibilities.losses_collector, 'stripe');
  assert.equal(account.configuration.merchant.capabilities.card_payments.requested, true);
  assert.equal(account.configuration.customer, undefined);
  assert.equal(account.type, undefined);
  assert.equal(account.display_name, 'Northside Salon');
  assert.equal(account.defaults.profile.doing_business_as, 'Northside Salon');

  const charge = directChargeParams({
    business,
    booking: { id: 'book_1', chargeKind: 'deposit' },
    amountCents: 2000,
    title: 'Deposit for Haircut',
    successUrl: 'https://schedi.example/return?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://schedi.example/cancel',
  });
  assertDirectCharge(charge.params, charge.options);
  assert.equal(charge.options.stripeAccount, 'acct_123');
  assert.equal(hasKey(charge.params, 'application_fee_amount'), false);
  assert.match(charge.params.line_items[0].price_data.product_data.name, /Northside Salon/);
  assert.match(charge.params.integration_identifier, /^schedi_book_[a-z]{8}$/);
  assert.equal(cardPaymentsLive({
    configuration: { merchant: { capabilities: {
      card_payments: { status: 'active' },
      stripe_balance: { payouts: { status: 'pending' } },
    } } },
  }), false);
  assert.equal(cardPaymentsLive({
    configuration: { merchant: { capabilities: {
      card_payments: { status: 'active' },
      stripe_balance: { payouts: { status: 'active' } },
    } } },
  }), true);

  assert.throws(() => assertSubscriptionCheckout({ customer_account: 'acct_123', mode: 'subscription' }));
  assertSubscriptionCheckout({
    mode: 'subscription',
    customer: 'cus_123',
    line_items: [{ price: 'price_123', quantity: 1 }],
  });
});

test('Pro card checkout is gated, direct, and separate from the owner subscription', async () => {
  const ctx = await start();
  try {
    const registered = await request(ctx.base, '/api/auth/register', {
      method: 'POST',
      body: { name: 'Northside Salon', email: 'ada@northside.example', password: 'correct-horse', country: 'us' },
    });
    assert.equal(registered.status, 201);
    const cookie = registered.cookie;
    assert.equal(registered.json.business.plan, 'free');
    assert.equal(registered.json.business.paused, false);

    const service = await request(ctx.base, '/api/portal/services', {
      method: 'POST',
      cookie,
      body: { name: 'Haircut', priceCents: 8000, durationMin: 45 },
    });
    assert.equal(service.status, 201);
    const slug = registered.json.business.slug;
    const when = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const hidden = await request(ctx.base, `/api/public/${slug}`);
    assert.equal(hidden.json.card.available, false);
    assert.equal(hidden.json.deposit.available, false);
    assert.equal(hidden.json.methods.pay_at_appointment.enabled, true);

    const manual = await request(ctx.base, `/api/public/${slug}/bookings`, {
      method: 'POST',
      body: {
        serviceId: service.json.service.id,
        clientName: 'Casey Client',
        clientEmail: 'casey@example.com',
        start: when,
        method: 'pay_at_appointment',
      },
    });
    assert.equal(manual.status, 201);
    assert.equal(manual.json.booking.status, 'confirmed');
    assert.equal(ctx.stripe.calls.some((call) => call.name === 'checkout.sessions.create'), false);

    const tooSoon = await request(ctx.base, '/api/portal/cards/enable', { method: 'POST', cookie, body: {} });
    assert.equal(tooSoon.status, 403);

    const starter = await request(ctx.base, '/api/portal/plan', { method: 'POST', cookie, body: { plan: 'starter' } });
    const pro = await request(ctx.base, '/api/portal/plan', { method: 'POST', cookie, body: { plan: 'pro' } });
    assert.equal(starter.status, 200);
    assert.equal(pro.status, 200);
    assert.equal(ctx.stripe.calls.filter((call) => call.name === 'customers.create').length, 1);
    const subscriptionCalls = ctx.stripe.calls.filter((call) => call.name === 'checkout.sessions.create' && call.payload.params.mode === 'subscription');
    assert.equal(subscriptionCalls.length, 2);
    assert.equal(subscriptionCalls[0].payload.params.customer, subscriptionCalls[1].payload.params.customer);
    assert.equal(hasKey(subscriptionCalls[0].payload.params, 'customer_account'), false);
    assert.match(subscriptionCalls[1].payload.params.integration_identifier, /^schedi_sub_[a-z]{8}$/);

    const proSessionId = new URL(pro.json.checkoutUrl).searchParams.get('session_id');
    const paidPlan = await request(ctx.base, '/api/simulate/checkout/complete', {
      method: 'POST',
      body: { sessionId: proSessionId },
    });
    assert.equal(paidPlan.status, 200);
    const owner = await request(ctx.base, '/api/portal/me', { cookie });
    assert.equal(owner.json.business.plan, 'pro');
    assert.equal(owner.json.business.subscriptionStatus, 'active');
    assert.equal(owner.json.business.paused, false);

    const enabled = await request(ctx.base, '/api/portal/cards/enable', { method: 'POST', cookie, body: {} });
    assert.equal(enabled.status, 201);
    assert.equal(enabled.json.business.cardPaymentsStatus, 'pending');
    assert.equal(enabled.json.business.payoutsStatus, 'pending');
    const accountCall = ctx.stripe.calls.find((call) => call.name === 'v2.core.accounts.create');
    assert.equal(accountCall.payload.params.dashboard, 'full');
    assert.equal(accountCall.payload.params.defaults.responsibilities.fees_collector, 'stripe');
    assert.equal(accountCall.payload.params.defaults.responsibilities.losses_collector, 'stripe');
    assert.equal(accountCall.payload.params.configuration.merchant.capabilities.card_payments.requested, true);
    assert.equal(accountCall.payload.params.configuration.customer, undefined);
    assert.equal(accountCall.payload.params.type, undefined);
    assert.equal(accountCall.payload.params.display_name, 'Northside Salon');

    const session = await request(ctx.base, '/api/portal/account-session', { method: 'POST', cookie, body: {} });
    assert.equal(session.status, 200);
    const components = ctx.stripe.calls.find((call) => call.name === 'accountSessions.create').payload.components;
    for (const name of ['account_onboarding', 'notification_banner', 'account_management', 'payments', 'payouts']) {
      assert.equal(components[name].enabled, true);
    }

    const stillHidden = await request(ctx.base, `/api/public/${slug}`);
    assert.equal(stillHidden.json.paused, false);
    assert.equal(stillHidden.json.card.available, false);
    assert.equal(stillHidden.json.deposit.available, false);
    const blocked = await request(ctx.base, `/api/public/${slug}/bookings`, {
      method: 'POST',
      body: {
        serviceId: service.json.service.id,
        clientName: 'Casey Client',
        clientEmail: 'casey@example.com',
        start: when,
        method: 'card',
      },
    });
    assert.equal(blocked.status, 409);

    await request(ctx.base, '/api/portal/payments', {
      method: 'PATCH',
      cookie,
      body: {
        deposit: { enabled: true, amountCents: 2000 },
        zelle: { enabled: true, handle: 'ada@northside.example' },
      },
    });
    const activated = await request(ctx.base, '/api/portal/cards/simulate-status', {
      method: 'POST',
      cookie,
      body: { cardPayments: 'active', payouts: 'active' },
    });
    assert.equal(activated.json.business.cardLive, true);
    const livePage = await request(ctx.base, `/api/public/${slug}`);
    assert.equal(livePage.json.card.available, true);
    assert.equal(livePage.json.deposit.available, true);
    const chargesBeforeZelle = ctx.stripe.calls.filter((call) => call.name === 'checkout.sessions.create').length;
    const zelle = await request(ctx.base, `/api/public/${slug}/bookings`, {
      method: 'POST',
      body: {
        serviceId: service.json.service.id,
        clientName: 'Casey Client',
        clientEmail: 'casey@example.com',
        start: when,
        method: 'zelle',
      },
    });
    assert.equal(zelle.status, 201);
    assert.equal(zelle.json.booking.status, 'confirmed');
    assert.match(zelle.json.booking.instructions, /ada@northside.example/);
    assert.equal(ctx.stripe.calls.filter((call) => call.name === 'checkout.sessions.create').length, chargesBeforeZelle);

    const deposit = await request(ctx.base, `/api/public/${slug}/bookings`, {
      method: 'POST',
      body: {
        serviceId: service.json.service.id,
        clientName: 'Casey Client',
        clientEmail: 'casey@example.com',
        start: when,
        method: 'card',
        deposit: true,
      },
    });
    assert.equal(deposit.status, 201);
    const chargeCall = ctx.stripe.calls.filter((call) => call.name === 'checkout.sessions.create').at(-1);
    assert.equal(chargeCall.payload.params.mode, 'payment');
    assert.equal(chargeCall.payload.options.stripeAccount, enabled.json.business.connectedAccountId);
    assert.equal(hasKey(chargeCall.payload.params, 'application_fee_amount'), false);
    assert.equal(hasKey(chargeCall.payload.params, 'transfer_data'), false);
    assert.equal(chargeCall.payload.params.line_items[0].price_data.unit_amount, 2000);
    assert.match(chargeCall.payload.params.line_items[0].price_data.product_data.name, /Northside Salon/);
    assert.equal(chargeCall.payload.params.payment_intent_data.statement_descriptor_suffix.length > 0, true);

    const chargeSessionId = new URL(deposit.json.checkoutUrl).searchParams.get('session_id');
    await request(ctx.base, '/api/simulate/checkout/complete', { method: 'POST', body: { sessionId: chargeSessionId } });
    const confirmed = await request(ctx.base, `/api/public/${slug}/return?session_id=${chargeSessionId}`);
    assert.equal(confirmed.json.booking.status, 'confirmed');
    assert.equal(confirmed.json.paused, false);
    assert.match(confirmed.json.booking.instructions, /remaining \$60\.00/);

    const full = await request(ctx.base, `/api/public/${slug}/bookings`, {
      method: 'POST',
      body: {
        serviceId: service.json.service.id,
        clientName: 'Riley Client',
        clientEmail: 'riley@example.com',
        start: when,
        method: 'card',
      },
    });
    const fullCall = ctx.stripe.calls.filter((call) => call.name === 'checkout.sessions.create').at(-1);
    assert.equal(fullCall.payload.params.line_items[0].price_data.unit_amount, 8000);
    assert.equal(hasKey(fullCall.payload.params, 'application_fee_amount'), false);
    const failedBookingId = ctx.store.read().bookings.find((booking) => booking.clientEmail === 'riley@example.com').id;
    const failedEvent = {
      id: 'evt_card_failed',
      type: 'payment_intent.payment_failed',
      account: enabled.json.business.connectedAccountId,
      data: { object: { metadata: { schedi_booking_id: failedBookingId } } },
    };
    const header = ctx.stripe.webhooks.generateTestHeaderString({
      payload: JSON.stringify(failedEvent),
      secret: webhookSecret,
    });
    const webhook = await fetch(`${ctx.base}/api/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body: JSON.stringify(failedEvent),
    });
    assert.equal(webhook.status, 200);
    const afterFailure = await request(ctx.base, '/api/portal/me', { cookie });
    assert.equal(afterFailure.json.business.paused, false);
    assert.equal(afterFailure.json.business.subscriptionStatus, 'active');
    assert.equal(ctx.store.read().bookings.find((booking) => booking.id === failedBookingId).status, 'failed');
    const stillOpen = await request(ctx.base, `/api/public/${slug}`);
    assert.equal(stillOpen.json.paused, false);
    assert.equal(stillOpen.json.card.available, true);

    const bad = await fetch(`${ctx.base}/api/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' },
      body: JSON.stringify({ id: 'evt_bad', type: 'payment_intent.payment_failed' }),
    });
    assert.equal(bad.status, 400);

    const subscriptionId = ctx.store.read().businesses[0].subscriptionId;
    const pastDue = {
      id: 'evt_sub_past_due',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subscriptionId,
          status: 'past_due',
          customer: ctx.store.read().businesses[0].stripeCustomerId,
          metadata: { schedi_business_id: ctx.store.read().businesses[0].id, schedi_plan: 'pro' },
        },
      },
    };
    const pastHeader = ctx.stripe.webhooks.generateTestHeaderString({
      payload: JSON.stringify(pastDue),
      secret: webhookSecret,
    });
    const pastResponse = await fetch(`${ctx.base}/api/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': pastHeader },
      body: JSON.stringify(pastDue),
    });
    assert.equal(pastResponse.status, 200);
    const paused = await request(ctx.base, `/api/public/${slug}`);
    assert.equal(paused.json.paused, true);
    assert.equal(paused.json.card.available, false);
    assert.equal(paused.json.deposit.available, false);
    const pausedBook = await request(ctx.base, `/api/public/${slug}/bookings`, {
      method: 'POST',
      body: {
        serviceId: service.json.service.id,
        clientName: 'Casey Client',
        clientEmail: 'casey@example.com',
        start: when,
        method: 'pay_at_appointment',
      },
    });
    assert.equal(pausedBook.status, 403);

    const canceled = {
      id: 'evt_sub_canceled',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: subscriptionId,
          status: 'canceled',
          customer: ctx.store.read().businesses[0].stripeCustomerId,
          metadata: { schedi_business_id: ctx.store.read().businesses[0].id, schedi_plan: 'pro' },
        },
      },
    };
    const cancelHeader = ctx.stripe.webhooks.generateTestHeaderString({
      payload: JSON.stringify(canceled),
      secret: webhookSecret,
    });
    await fetch(`${ctx.base}/api/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': cancelHeader },
      body: JSON.stringify(canceled),
    });
    const canceledPage = await request(ctx.base, `/api/public/${slug}`);
    assert.equal(canceledPage.json.paused, true);

    const free = await request(ctx.base, '/api/portal/plan', { method: 'POST', cookie, body: { plan: 'free' } });
    assert.equal(free.json.business.plan, 'free');
    assert.equal(free.json.business.paused, false);
    const freePage = await request(ctx.base, `/api/public/${slug}`);
    assert.equal(freePage.json.paused, false);
    assert.equal(freePage.json.card.available, false);
    assert.equal(ctx.stripe.calls.filter((call) => call.name === 'customers.create').length, 1);
  } finally {
    await ctx.close();
  }
});
