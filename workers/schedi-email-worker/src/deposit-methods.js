/**
 * Deposit methods and the public Square switch.
 *
 * Square on the public page is a label only. It does not charge a card.
 * SCHEDI_SQUARE_PUBLIC_ENABLED is the global kill switch. It stays false until
 * Square is turned on later. A business can also leave paymentGateways.square off.
 * Both have to be on before a client can pick Square.
 *
 * "Pay at Appt" stays the public label. The owner roster treats that choice as
 * in-person cash (paidMethod "cash") once the visit is marked paid.
 */

export const SCHEDI_SQUARE_PUBLIC_ENABLED = false;

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

/** Client-facing Square. False while the kill switch is off, even if the business checked it. */
export function squareOfferedToClients(tenant) {
  return SCHEDI_SQUARE_PUBLIC_ENABLED === true && gatewayOn(tenant, 'square');
}

/** Public create must not store a Square choice while the kill switch is off. */
export function squareClientBookingError(booking) {
  const method = String(booking && booking.paymentMethod || '').toLowerCase();
  if (method === 'square' && SCHEDI_SQUARE_PUBLIC_ENABLED !== true) return 'square_unavailable';
  return '';
}

/** Owner badge / filter bucket. Pay at appointment maps to in-person cash. */
export function ownerInPersonMethod(method) {
  const raw = String(method || '').toLowerCase().trim();
  if (raw === 'later' || raw === 'pay at appointment' || raw === 'pay at appt' || raw === 'cash') return 'cash';
  return raw;
}
