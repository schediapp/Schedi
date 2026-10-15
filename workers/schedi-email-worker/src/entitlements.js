/**
 * Plan / entitlement lock for owner-session writes.
 *
 * Owners may NOT change billing or plan fields themselves. Those change only through:
 *   - the Stripe flow (owner clicks upgrade -> /billing/checkout -> pays -> webhook sets plan/status),
 *   - the Stripe billing portal (cancel -> customer.subscription.deleted webhook -> paused),
 *   - an agency session.
 * Owners also can't switch on Pro-only features unless the stored (effective) plan is Pro.
 */
import { tenantPlanName } from './cancellation-fee.js';

export { tenantPlanName };

/** Public-doc fields owners can't change. Stored values are kept on owner saves. */
export const OWNER_LOCKED_PUBLIC_KEYS = ['plan', 'subscriptionStatus'];

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Apply the owner lock to an incoming public profile.
 * @param {object} incomingPub  public part of what the owner sent (already split from private keys)
 * @param {object|null} storedPub  current public doc
 * @param {object|null} storedPriv current private doc (complimentaryPro, billingExempt, monthlyPrice...)
 * @returns {{ pub: object, ignored: string[] }}
 */
export function applyOwnerEntitlementLock(incomingPub, storedPub, storedPriv) {
  const pub = Object.assign({}, incomingPub || {});
  const stored = Object.assign({}, storedPub || {}, storedPriv || {});
  const ignored = [];

  for (const k of OWNER_LOCKED_PUBLIC_KEYS) {
    const has = Object.prototype.hasOwnProperty.call(storedPub || {}, k);
    const before = has ? storedPub[k] : undefined;
    const sent = pub[k];
    if (sent !== undefined && JSON.stringify(sent) !== JSON.stringify(before)) ignored.push(k);
    // The public doc is replaced on save, so always write the stored value back (or leave it absent).
    if (has) pub[k] = before;
    else delete pub[k];
  }

  // Effective plan comes from what is stored, never from what the owner sent.
  const plan = tenantPlanName(stored);
  if (plan !== 'pro') {
    // Owners can switch these off, never on, below Pro.
    const storedRecurring = (storedPub || {}).allowRecurringBookings === true;
    if (pub.allowRecurringBookings === true && !storedRecurring) {
      pub.allowRecurringBookings = false;
      ignored.push('allowRecurringBookings');
    }

    const sg = isObj((storedPub || {}).paymentGateways) ? storedPub.paymentGateways : {};
    if (isObj(pub.paymentGateways)) {
      const gw = Object.assign({}, pub.paymentGateways);
      const lockedOn = plan === 'free' ? ['card', 'cashapp', 'zelle', 'venmo', 'paypal'] : ['card'];
      for (const g of lockedOn) {
        if (gw[g] === true && sg[g] !== true) {
          gw[g] = false;
          ignored.push('paymentGateways.' + g);
        }
      }
      if (plan === 'free' && !['card', 'cashapp', 'zelle', 'venmo', 'paypal'].some((g) => gw[g] === true)) {
        gw.later = true;
      }
      pub.paymentGateways = gw;
    }

    const sd = isObj((storedPub || {}).deposit) ? storedPub.deposit : {};
    if (isObj(pub.deposit) && pub.deposit.enabled === true && sd.enabled !== true) {
      pub.deposit = Object.assign({}, pub.deposit, { enabled: false });
      ignored.push('deposit.enabled');
    }

    // Cancellation-fee auto-charge is Pro-only at charge time (cancellation-fee.js); also refuse the
    // explicit auto-charge flag if a client ever sends one.
    if (isObj(pub.cancellationFee)) {
      const sc = isObj((storedPub || {}).cancellationFee) ? storedPub.cancellationFee : {};
      for (const flag of ['autoCharge', 'chargeCard']) {
        if (pub.cancellationFee[flag] === true && sc[flag] !== true) {
          pub.cancellationFee = Object.assign({}, pub.cancellationFee, { [flag]: false });
          ignored.push('cancellationFee.' + flag);
        }
      }
    }

    if (plan === 'free' && Array.isArray(pub.services)) {
      const storedCount = Array.isArray((storedPub || {}).services) ? storedPub.services.length : 0;
      const cap = Math.max(1, storedCount);
      if (pub.services.length > cap) {
        pub.services = pub.services.slice(0, cap);
        ignored.push('services');
      }
    }
  }
  return { pub, ignored };
}

/** Booking-time checks for Pro-only features (public booking create). Returns an error code or ''. */
export function proOnlyBookingError(tenant, booking) {
  if (tenantPlanName(tenant) === 'pro') return '';
  const freq = booking && booking.recurrence && booking.recurrence.frequency;
  if ((freq && freq !== 'once') || (booking && booking.seriesId)) return 'recurring_pro_only';
  if (String((booking && booking.paymentMethod) || '').toLowerCase() === 'card') return 'card_checkout_pro_only';
  return '';
}

const PRICE_TO_PLAN = {
  price_1UMH8jGh1H5O3dkraHpGvCEN: 'starter',
  price_1UMH8jGh1H5O3dkr3fNrA90v: 'pro',
};

/** Plan from a Stripe subscription/invoice object by price id (survives portal plan switches). */
export function planFromStripePrice(obj) {
  const ids = [];
  const push = (p) => { if (p) ids.push(typeof p === 'string' ? p : p.id); };
  const items = obj && obj.items && obj.items.data;
  if (Array.isArray(items)) for (const it of items) push(it && it.price);
  const lines = obj && obj.lines && obj.lines.data;
  if (Array.isArray(lines)) {
    for (const ln of lines) {
      push(ln && ln.price);
      const pd = ln && ln.pricing && ln.pricing.price_details;
      if (pd) push(pd.price);
    }
  }
  for (const id of ids) if (PRICE_TO_PLAN[id]) return PRICE_TO_PLAN[id];
  return '';
}
