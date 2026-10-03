export const PLANS = {
  free: { id: 'free', name: 'Free', amountCents: 0 },
  starter: { id: 'starter', name: 'Schedi Starter', amountCents: 2900 },
  pro: { id: 'pro', name: 'Schedi Pro', amountCents: 4900 },
};

const OPEN_SUBSCRIPTION = new Set(['active', 'trialing']);

export function isPublicPagePaused(business) {
  if (!business || business.plan === 'free') return false;
  return !OPEN_SUBSCRIPTION.has(business.subscriptionStatus);
}

export function manualMethodReady(business, method) {
  if (method === 'pay_at_appointment') {
    return Boolean(business.payments?.payAtAppointment?.enabled);
  }
  const entry = business.payments?.[method];
  return Boolean(entry?.enabled && String(entry.handle || '').trim());
}

export const MANUAL_METHODS = ['cashapp', 'zelle', 'venmo', 'paypal', 'pay_at_appointment'];
