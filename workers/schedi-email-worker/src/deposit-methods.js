/**
 * Deposit methods and the public Square switch.
 *
 * Square is on. A client can pay with Square only when this business has
 * connected its own Square merchant (squareReady). Schedi never charges a
 * platform Square account. When Stripe and Square are both ready, cardProcessor
 * picks the one clients see. Missing cardProcessor means Stripe.
 *
 * "Pay at Appt" stays the public label. The owner roster treats that choice as
 * in-person cash (paidMethod "cash") once the visit is marked paid.
 */

export const SCHEDI_SQUARE_PUBLIC_ENABLED = true;

export const DEPOSIT_METHOD_KEYS = ['card', 'cashapp', 'zelle', 'venmo', 'paypal'];

function gateways(tenant) {
  const pg = tenant && tenant.paymentGateways;
  return pg && typeof pg === 'object' ? pg : {};
}

export function gatewayOn(tenant, key) {
  return gateways(tenant)[key] === true;
}

/**
 * Methods that may collect a deposit.
 * A missing deposit.methods object means "whatever the owner already turned on"
 * for card, Cash App, Zelle, Venmo, and PayPal. An explicit false stays off.
 * Pay at appointment and Square are never deposit methods.
 */
export function depositMethodMap(tenant) {
  const stored = tenant && tenant.deposit && tenant.deposit.methods;
  const explicit = !!(stored && typeof stored === 'object' && !Array.isArray(stored));
  const out = {};
  for (const key of DEPOSIT_METHOD_KEYS) {
    const on = gatewayOn(tenant, key);
    if (explicit && typeof stored[key] === 'boolean') out[key] = stored[key] === true && on;
    else out[key] = on;
  }
  return out;
}

export function methodAcceptsDeposit(tenant, method) {
  const raw = String(method || '').toLowerCase().trim();
  const key = raw === 'cash-app' || raw === 'cash app' ? 'cashapp' : raw;
  if (!DEPOSIT_METHOD_KEYS.includes(key)) return false;
  return depositMethodMap(tenant)[key] === true;
}

/** Public flag written when this tenant's own Square OAuth is complete and a location is active. */
export function squareMerchantReady(tenant) {
  return !!(tenant && tenant.squareReady === true);
}

function planName(tenant) {
  if (tenant && (tenant.complimentaryPro === true || tenant.billingExempt === true)) return 'pro';
  const stored = String((tenant && tenant.plan) || '').toLowerCase();
  if (stored === 'free' || stored === 'starter' || stored === 'pro') return stored;
  return '';
}

/** Owner setting. Stripe is the default when both card rails are ready. */
export function cardProcessorPreference(tenant) {
  return String((tenant && tenant.cardProcessor) || '').toLowerCase() === 'square' ? 'square' : 'stripe';
}

export function stripeRailReady(tenant) {
  return planName(tenant) === 'pro' && gatewayOn(tenant, 'card') && !!(tenant && tenant.stripeConnectReady === true);
}

export function squareRailReady(tenant) {
  return SCHEDI_SQUARE_PUBLIC_ENABLED === true && gatewayOn(tenant, 'square') && squareMerchantReady(tenant);
}

export function bothCardRailsReady(tenant) {
  return stripeRailReady(tenant) && squareRailReady(tenant);
}

/** The one card rail clients should see. Empty when neither merchant is ready. */
export function activeCardRail(tenant) {
  const stripe = stripeRailReady(tenant);
  const square = squareRailReady(tenant);
  if (stripe && square) return cardProcessorPreference(tenant);
  if (square) return 'square';
  if (stripe) return 'stripe';
  return '';
}

/**
 * Client-facing Square. Offered only for this tenant's own connected merchant,
 * and only when it is the active card rail.
 */
export function squareOfferedToClients(tenant) {
  return activeCardRail(tenant) === 'square';
}

/** Public create must not store a Square choice unless this tenant can take the charge. */
export function squareClientBookingError(booking, tenant) {
  const method = String(booking && booking.paymentMethod || '').toLowerCase();
  if (method !== 'square') return '';
  if (SCHEDI_SQUARE_PUBLIC_ENABLED !== true) return 'square_unavailable';
  if (!squareMerchantReady(tenant) || !gatewayOn(tenant, 'square')) return 'square_not_ready';
  if (activeCardRail(tenant) !== 'square') return 'square_not_offered';
  return '';
}

/** Owner badge / filter bucket. Pay at appointment maps to in-person cash. */
export function ownerInPersonMethod(method) {
  const raw = String(method || '').toLowerCase().trim();
  if (raw === 'later' || raw === 'pay at appointment' || raw === 'pay at appt' || raw === 'cash') return 'cash';
  return raw;
}
