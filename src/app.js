import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { parseCookies, readSession, signSession } from './auth.js';
import {
  addService,
  applyStripeEvent,
  changePlan,
  confirmPlan,
  createAccountSession,
  createBooking,
  currentBusiness,
  enableCards,
  finishCardReturn,
  listBookings,
  loginBusiness,
  logout,
  openBillingPortal,
  ownerView,
  publicPage,
  refreshConnect,
  registerBusiness,
  removeService,
  simulateCapability,
  simulatePay,
  updatePayments,
  updateProfile,
} from './actions.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function sendError(res, result) {
  res.status(result.status).json(result.body);
}

export function createApp({ store, stripe, config }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' https://connect-js.stripe.com https://js.stripe.com https://*.stripe.com",
        "frame-src https://connect-js.stripe.com https://js.stripe.com https://*.stripe.com https://*.stripe.network",
        "connect-src 'self' https://api.stripe.com https://connect-js.stripe.com https://*.stripe.com https://*.stripe.network",
        "img-src 'self' https://*.stripe.com data:",
        "style-src 'self' 'unsafe-inline' https://*.stripe.com",
        "font-src 'self' https://*.stripe.com",
        "worker-src blob:",
      ].join('; '),
    );
    next();
  });

  app.post('/api/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    if (!stripe || !config.webhookSecret) {
      res.status(503).send('Webhook is not configured.');
      return;
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.webhookSecret);
    } catch {
      res.status(400).send('Invalid signature.');
      return;
    }
    try {
      await applyStripeEvent({ store, stripe, event });
      res.json({ received: true });
    } catch {
      res.status(500).send('Webhook handler failed.');
    }
  });

  app.use(express.json({ limit: '100kb' }));
  app.use('/assets', express.static(publicDir));

  function sessionIdFrom(req) {
    const cookies = parseCookies(req.headers.cookie);
    return readSession(cookies.schedi, config.sessionSecret);
  }

  function requireOwner(req, res) {
    const sessionId = sessionIdFrom(req);
    const business = currentBusiness(store, sessionId);
    if (!business) {
      res.status(401).json({ error: 'Sign in required.' });
      return null;
    }
    return { sessionId, business };
  }

  function setCookie(res, sessionId) {
    const signed = encodeURIComponent(signSession(sessionId, config.sessionSecret));
    const secure = config.publicBaseUrl.startsWith('https://') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `schedi=${signed}; HttpOnly; SameSite=Lax; Path=/${secure}`);
  }

  function clearCookie(res) {
    res.setHeader('Set-Cookie', 'schedi=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/auth/register', (req, res) => {
    const result = registerBusiness(store, req.body || {});
    if (result.body?.error) return sendError(res, result);
    setCookie(res, result.sessionId);
    res.status(201).json(ownerView(result.business, config));
  });

  app.post('/api/auth/login', (req, res) => {
    const result = loginBusiness(store, req.body || {});
    if (result.body?.error) return sendError(res, result);
    setCookie(res, result.sessionId);
    res.json(ownerView(result.business, config));
  });

  app.post('/api/auth/logout', (req, res) => {
    logout(store, sessionIdFrom(req));
    clearCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/portal/me', (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    res.json({
      ...ownerView(owner.business, config),
      bookings: listBookings(store, owner.business.id),
    });
  });

  app.patch('/api/portal/profile', async (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    try {
      const result = await updateProfile(store, stripe, owner.business.id, req.body || {});
      if (result.body?.error) return sendError(res, result);
      res.json(ownerView(result.business, config));
    } catch (error) {
      res.status(502).json({ error: error.message || 'Could not update the business name on Stripe.' });
    }
  });

  app.post('/api/portal/services', (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const result = addService(store, owner.business.id, req.body || {});
    if (result.body?.error) return sendError(res, result);
    res.status(201).json({ service: result.service });
  });

  app.delete('/api/portal/services/:serviceId', (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    removeService(store, owner.business.id, req.params.serviceId);
    res.json({ ok: true });
  });

  app.patch('/api/portal/payments', (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const result = updatePayments(store, owner.business.id, req.body || {});
    if (result.body?.error) return sendError(res, result);
    res.json(ownerView(result.business, config));
  });

  app.post('/api/portal/plan', async (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    try {
      const result = await changePlan({
        store,
        stripe,
        config,
        businessId: owner.business.id,
        planId: req.body?.plan,
      });
      if (result.body?.error) return sendError(res, result);
      if (result.checkoutUrl) return res.json({ checkoutUrl: result.checkoutUrl });
      res.json(ownerView(result.business, config));
    } catch (error) {
      res.status(502).json({ error: error.message || 'Could not update the subscription.' });
    }
  });

  app.post('/api/portal/plan/confirm', async (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    try {
      const result = await confirmPlan({
        store,
        stripe,
        businessId: owner.business.id,
        sessionId: req.body?.sessionId,
      });
      if (result.body?.error) return sendError(res, result);
      res.json({ ...ownerView(result.business, config), pending: result.pending });
    } catch (error) {
      res.status(502).json({ error: error.message || 'Could not confirm the subscription.' });
    }
  });

  app.post('/api/portal/billing-portal', async (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    try {
      const result = await openBillingPortal({ store, stripe, config, businessId: owner.business.id });
      if (result.body?.error) return sendError(res, result);
      res.json({ url: result.url });
    } catch (error) {
      res.status(502).json({ error: error.message || 'Could not open billing.' });
    }
  });

  app.post('/api/portal/cards/enable', async (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    try {
      const result = await enableCards({ store, stripe, config, businessId: owner.business.id });
      if (result.body?.error) return sendError(res, result);
      res.status(result.status).json(ownerView(result.business, config));
    } catch (error) {
      res.status(502).json({ error: error.message || 'Could not create the connected account.' });
    }
  });

  app.post('/api/portal/cards/refresh', async (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    try {
      const result = await refreshConnect({ store, stripe, businessId: owner.business.id });
      if (result.body?.error) return sendError(res, result);
      res.json(ownerView(result.business, config));
    } catch (error) {
      res.status(502).json({ error: error.message || 'Could not refresh the connected account.' });
    }
  });

  app.post('/api/portal/account-session', async (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    try {
      const result = await createAccountSession({ store, stripe, businessId: owner.business.id });
      if (result.body?.error) return sendError(res, result);
      res.json({ clientSecret: result.clientSecret });
    } catch (error) {
      res.status(502).json({ error: error.message || 'Could not start embedded Stripe components.' });
    }
  });

  app.post('/api/portal/cards/simulate-status', async (req, res) => {
    if (!config.simulate) return res.status(404).json({ error: 'Not found.' });
    const owner = requireOwner(req, res);
    if (!owner) return;
    const result = await simulateCapability({
      store,
      stripe,
      businessId: owner.business.id,
      cardPayments: req.body?.cardPayments,
      payouts: req.body?.payouts,
    });
    if (result.body?.error) return sendError(res, result);
    res.json(ownerView(result.business, config));
  });

  app.get('/api/dev/stripe-calls', (req, res) => {
    if (!config.simulate) return res.status(404).json({ error: 'Not found.' });
    res.json({ calls: stripe.calls });
  });

  app.post('/api/simulate/checkout/complete', async (req, res) => {
    if (!config.simulate) return res.status(404).json({ error: 'Not found.' });
    try {
      const session = await simulatePay({ store, stripe, sessionId: req.body?.sessionId });
      res.json({
        ok: true,
        returnUrl: String(session.success_url || '').replace('{CHECKOUT_SESSION_ID}', session.id),
      });
    } catch (error) {
      res.status(400).json({ error: error.message || 'Could not complete the simulated payment.' });
    }
  });

  app.get('/api/public/:slug', async (req, res) => {
    try {
      const result = await publicPage({ store, stripe, slug: req.params.slug });
      if (result.body?.error) return sendError(res, result);
      res.json(result.body);
    } catch (error) {
      res.status(502).json({ error: error.message || 'Could not load the booking page.' });
    }
  });

  app.post('/api/public/:slug/bookings', async (req, res) => {
    try {
      const result = await createBooking({
        store,
        stripe,
        config,
        slug: req.params.slug,
        input: req.body || {},
      });
      if (result.body?.error) return sendError(res, result);
      res.status(result.status).json(result.body);
    } catch (error) {
      res.status(502).json({ error: error.message || 'Could not create the booking.' });
    }
  });

  app.get('/api/public/:slug/return', async (req, res) => {
    try {
      const result = await finishCardReturn({
        store,
        stripe,
        slug: req.params.slug,
        sessionId: req.query.session_id,
      });
      if (result.body?.error) return sendError(res, result);
      res.json(result.body);
    } catch (error) {
      res.status(502).json({ error: error.message || 'Could not confirm the card payment.' });
    }
  });

  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'portal.html'));
  });
  app.get('/portal', (_req, res) => {
    res.sendFile(path.join(publicDir, 'portal.html'));
  });
  app.get('/b/:slug', (_req, res) => {
    res.sendFile(path.join(publicDir, 'book.html'));
  });
  app.get('/b/:slug/return', (_req, res) => {
    res.sendFile(path.join(publicDir, 'book.html'));
  });
  app.get('/simulate/checkout', (req, res) => {
    if (!config.simulate) return res.status(404).send('Not found.');
    res.sendFile(path.join(publicDir, 'simulate.html'));
  });

  return app;
}
