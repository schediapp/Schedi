/**
 * Amount still due and the owner's remote pay methods for an owner-sent invoice.
 * Confirmation emails, card quotes, and booking-page checkout do not use this module.
 * An invoice link charges only after the owner has opened one (booking.invoiceOpen).
 */

export function invoiceRoundMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

export function invoiceHasPrice(value) {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

export function invoicePlanName(tenant) {
  if (tenant && (tenant.complimentaryPro === true || tenant.billingExempt === true)) return 'pro';
  const stored = String((tenant && tenant.plan) || '').toLowerCase();
  if (stored === 'free' || stored === 'starter' || stored === 'pro') return stored;
  const n = Number(tenant && tenant.monthlyPrice);
  if (n === 29 || n === 49) return 'starter';
  if (n === 99) return 'pro';
  return 'free';
}

function catalogPrice(tenant, serviceName) {
  const services = Array.isArray(tenant && tenant.services) ? tenant.services : [];
  const svc = services.find((s) => s && s.name === serviceName);
  if (!svc || !invoiceHasPrice(svc.price)) return null;
  return invoiceRoundMoney(svc.price);
}

export function invoicePriceDollars(tenant, booking) {
  if (booking && invoiceHasPrice(booking.amount)) return invoiceRoundMoney(booking.amount);
  return catalogPrice(tenant, booking && booking.serviceName);
}

export function invoiceStatusPaid(booking) {
  const up = String((booking && booking.paymentStatus) || '').toUpperCase();
  if (/\bUNPAID\b/.test(up) || /\bNOT\s+PAID\b/.test(up)) return false;
  if (up.indexOf('PENDING') !== -1 || up.indexOf('AWAITING') !== -1) return false;
  return up.indexOf('PAID') !== -1;
}

/** Deposit collected, balance still open. "DEPOSIT PAID" is not a fully paid visit. */
export function invoiceDepositOnly(booking) {
  if (!booking || booking.depositPaid !== true) return false;
  const deposit = Number(booking.depositAmount);
  if (!Number.isFinite(deposit) || deposit <= 0) return false;
  return String(booking.paymentStatus || '').toUpperCase().indexOf('DEPOSIT') !== -1;
}

export function invoiceCollectedDollars(booking) {
  if (!booking) return 0;
  const status = String(booking.paymentStatus || '').toUpperCase();
  const refundMarked = booking.refunded === true || status.indexOf('REFUND') !== -1;
  const refundRaw = invoiceHasPrice(booking.refundAmount)
    ? booking.refundAmount
    : (invoiceHasPrice(booking.amountRefunded) ? booking.amountRefunded : null);
  const deposit = Number(booking.depositAmount);
  const depositPaid = booking.depositPaid === true && Number.isFinite(deposit) && deposit > 0;
  let gross = 0;
  let known = false;
  if (invoiceDepositOnly(booking)) {
    gross = invoiceRoundMoney(deposit);
    known = true;
  } else if (invoiceStatusPaid(booking)) {
    if (invoiceHasPrice(booking.amount)) gross = invoiceRoundMoney(booking.amount);
    known = true;
  } else if (depositPaid) {
    gross = invoiceRoundMoney(deposit);
    known = true;
  }
  const refund = refundRaw != null ? invoiceRoundMoney(refundRaw) : (refundMarked ? gross : 0);
  if (!known && !refundMarked) return 0;
  return invoiceRoundMoney(Math.max(0, gross - refund));
}

/** Null when nobody has set a price yet. Otherwise price minus what is already collected. */
export function invoiceAmountDue(tenant, booking) {
  const price = invoicePriceDollars(tenant, booking);
  if (price == null) return null;
  return invoiceRoundMoney(Math.max(0, price - invoiceCollectedDollars(booking)));
}

export function invoiceFullyPaid(tenant, booking) {
  if (!invoiceStatusPaid(booking)) return false;
  if (invoiceDepositOnly(booking)) {
    const due = invoiceAmountDue(tenant, booking);
    return due != null && due < 0.5;
  }
  return true;
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

/** Same rules as the booking page's buildVenmoUrl. */
export function invoiceVenmoUrl(handle, link) {
  const explicit = String(link || '').trim();
  if (looksLikeUrl(explicit)) return explicit;
  const user = String(handle || '').trim().replace(/^@/, '');
  if (!user) return '';
  return 'https://venmo.com/u/' + encodeURIComponent(user);
}

/** Same rules as the booking page's buildPaypalUrl. */
export function invoicePaypalUrl(handle, link) {
  const explicit = String(link || '').trim();
  if (looksLikeUrl(explicit)) return explicit;
  const h = String(handle || '').trim();
  if (!h) return '';
  if (looksLikeUrl(h)) return h;
  const lower = h.toLowerCase();
  if (lower.indexOf('paypal.me/') === 0 || lower.indexOf('www.paypal.me/') === 0) {
    return 'https://' + h.replace(/^https?:\/\//i, '');
  }
  if (h.indexOf('@') !== -1 && h.indexOf(' ') === -1) return '';
  const slug = h.replace(/^@/, '').replace(/^paypal\.me\//i, '').replace(/^\//, '');
  if (slug && /^[A-Za-z0-9._-]+$/.test(slug)) return 'https://www.paypal.me/' + encodeURIComponent(slug);
  return '';
}

export function invoiceCashAppUrl(tenant) {
  const raw = String((tenant && (tenant.cashAppTag || tenant.cashappTag)) || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!raw) return '';
  return 'https://cash.app/' + encodeURIComponent('$' + raw);
}

export function invoiceZelleUrl(link) {
  const explicit = String(link || '').trim();
  return looksLikeUrl(explicit) ? explicit : '';
}

function textSet(value) {
  return String(value || '').trim().length > 0;
}

/**
 * Remote methods the owner has turned on and finished setting up.
 * Card is Pro and needs Stripe Connect ready. Square is not on Free and needs Square ready.
 * Venmo, Zelle, Cash App, and PayPal need a saved handle or link. Pay at the appointment is not remote.
 */
export function invoiceRemoteMethods(tenant) {
  const plan = invoicePlanName(tenant);
  if (!tenant || plan === 'free') return [];
  const pg = tenant.paymentGateways && typeof tenant.paymentGateways === 'object' ? tenant.paymentGateways : {};
  const out = [];
  if (plan === 'pro' && pg.card === true && tenant.stripeConnectReady === true) out.push('card');
  if (pg.square === true && tenant.squareReady === true) out.push('square');
  if (pg.cashapp === true && textSet(tenant.cashAppTag || tenant.cashappTag)) out.push('cashapp');
  if (pg.zelle === true && (textSet(tenant.zelleHandle) || textSet(tenant.zelleLink))) out.push('zelle');
  if (pg.venmo === true && (textSet(tenant.venmoHandle) || textSet(tenant.venmoLink))) out.push('venmo');
  if (pg.paypal === true && (textSet(tenant.paypalHandle) || textSet(tenant.paypalLink))) out.push('paypal');
  return out;
}
