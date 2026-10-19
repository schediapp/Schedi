function roundMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function priced(value) {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

function validPi(value) {
  const s = String(value || '').trim();
  return /^pi_[A-Za-z0-9]+$/.test(s) ? s : '';
}

function paidCardState(booking) {
  const status = String((booking && booking.paymentStatus) || '').toUpperCase();
  if (!booking) return false;
  if (status.indexOf('PAID') === -1 || status.indexOf('UNPAID') !== -1 || status.indexOf('AWAITING') !== -1) return false;
  const method = String(booking.paidMethod || booking.paymentMethod || '').toLowerCase();
  return method === 'card';
}

/**
 * A Connect checkout or payment link already recorded on this visit.
 * Same payment intent is a replay. A visit already showing that paid state,
 * with no stored intent yet, is also a replay.
 */
export function cardPaymentAlreadyRecorded(booking, purpose, paymentIntentId) {
  if (!paidCardState(booking)) return false;
  const status = String(booking.paymentStatus || '').toUpperCase();
  const deposit = purpose === 'deposit';
  const sameKind = deposit
    ? status.indexOf('DEPOSIT') !== -1 && booking.depositPaid === true
    : status.indexOf('DEPOSIT') === -1;
  if (!sameKind) return false;
  const stored = validPi(booking.stripePaymentIntentId);
  const incoming = validPi(paymentIntentId);
  if (stored && incoming && stored !== incoming) return false;
  return true;
}

function dollarsFromCents(cents) {
  if (cents === null || cents === undefined || cents === '') return null;
  const n = Number(cents);
  if (!Number.isFinite(n) || n < 0) return null;
  return roundMoney(n / 100);
}

/**
 * Mark one booking paid from a successful card checkout.
 * Full payment stores the amount paid. A deposit stores that amount as the deposit
 * and leaves the service price on the booking. Replays return duplicate.
 */
export function applyCardCheckoutPayment(booking, input) {
  if (!booking || typeof booking !== 'object') return { booking, changed: false, duplicate: false };
  const spec = input || {};
  const purpose = spec.purpose === 'deposit' ? 'deposit' : 'card';
  const paymentIntentId = validPi(spec.paymentIntentId);
  if (cardPaymentAlreadyRecorded(booking, purpose, paymentIntentId)) {
    return { booking, changed: false, duplicate: true };
  }
  const next = Object.assign({}, booking);
  const paid = dollarsFromCents(spec.amountCents);
  next.paymentMethod = 'card';
  next.paidMethod = 'card';
  if (paymentIntentId) next.stripePaymentIntentId = paymentIntentId;
  if (spec.stripeCustomerId) next.stripeCustomerId = String(spec.stripeCustomerId);
  if (spec.stripePaymentMethodId) next.stripePaymentMethodId = String(spec.stripePaymentMethodId);
  if (purpose === 'deposit') {
    let deposit = paid;
    if (deposit == null && Number(booking.depositAmount) > 0) deposit = roundMoney(booking.depositAmount);
    if (deposit == null && Number(spec.quotedDeposit) > 0) deposit = roundMoney(spec.quotedDeposit);
    if (deposit != null) next.depositAmount = deposit;
    next.depositPaid = true;
    const price = priced(booking.amount)
      ? roundMoney(booking.amount)
      : (priced(spec.catalogPrice) ? roundMoney(spec.catalogPrice) : null);
    if (price != null) next.amount = price;
    if (price != null && deposit != null) next.balanceDue = roundMoney(Math.max(0, price - deposit));
    next.paymentOptionLabel = 'Card deposit';
    next.paymentStatus = 'DEPOSIT PAID';
  } else {
    const price = paid != null
      ? paid
      : (priced(booking.amount) ? roundMoney(booking.amount) : (priced(spec.catalogPrice) ? roundMoney(spec.catalogPrice) : null));
    if (price != null) next.amount = price;
    else delete next.amount;
    const label = String(next.paymentOptionLabel || '');
    if (!label || /await|checkout/i.test(label)) next.paymentOptionLabel = 'Card';
    next.paymentStatus = 'PAID VIA CARD';
  }
  return { booking: next, changed: true, duplicate: false };
}

/** Per-booking cents. One visit gets the checkout total. Splits win when present. */
export function centsByBooking(bookingIds, amountCents, splits) {
  const map = {};
  const ids = Array.isArray(bookingIds) ? bookingIds.map((id) => String(id || '')).filter(Boolean) : [];
  const parts = String(splits || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length) {
    for (const part of parts) {
      const bits = part.split(':');
      const id = String(bits[0] || '').trim();
      const cents = Math.round(Number(bits[1]));
      if (id && Number.isFinite(cents) && cents >= 0) map[id] = cents;
    }
    return map;
  }
  if (ids.length === 1 && amountCents !== null && amountCents !== undefined && amountCents !== '') {
    const cents = Math.round(Number(amountCents));
    if (Number.isFinite(cents) && cents >= 0) map[ids[0]] = cents;
  }
  return map;
}
