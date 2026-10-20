/**
 * Opt-in client cancellation fee.
 * Off unless the business saves cancellationFee.enabled.
 * Free and Starter never call Stripe. Pro charges the platform account
 * only when that booking already has the client's card on file.
 */

const DEFAULT_TZ = 'America/New_York';

export function roundMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

export function tenantPlanName(tenant) {
  if (tenant && (tenant.complimentaryPro === true || tenant.billingExempt === true)) return 'pro';
  const stored = String((tenant && tenant.plan) || '').toLowerCase();
  if (stored === 'free' || stored === 'starter' || stored === 'pro') return stored;
  const n = Number(tenant && tenant.monthlyPrice);
  if (n === 29 || n === 49) return 'starter';
  if (n === 99) return 'pro';
  return 'free';
}

export function readCancellationFeeSettings(tenant) {
  const d = tenant && tenant.cancellationFee;
  if (!d || typeof d !== 'object') return { enabled: false, hours: 24, type: 'percent', percent: 0, amount: 0 };
  let hours = Number(d.hours);
  if (!Number.isFinite(hours)) hours = 24;
  hours = Math.round(hours);
  if (hours < 0) hours = 0;
  if (hours > 720) hours = 720;
  const type = d.type === 'fixed' ? 'fixed' : 'percent';
  const percent = Math.min(100, Math.max(0, Number(d.percent) || 0));
  const amount = Math.max(0, roundMoney(d.amount));
  return { enabled: !!d.enabled, hours, type, percent, amount };
}

export function cancellationFeeActive(settings) {
  if (!settings || !settings.enabled) return false;
  if (settings.type === 'fixed') return settings.amount >= 0.5;
  return settings.percent > 0;
}

export function quoteCancellationFee(settings, price) {
  const p = roundMoney(price);
  if (!cancellationFeeActive(settings)) return { active: false, amount: 0 };
  let fee = settings.type === 'fixed' ? settings.amount : roundMoney((p * settings.percent) / 100);
  if (p > 0 && fee > p) fee = p;
  fee = roundMoney(fee);
  return { active: true, amount: fee };
}

export function cancellationWindowLabel(hours) {
  const n = Math.round(Number(hours) || 0);
  if (n <= 0) return 'at the time of the appointment';
  if (n === 1) return 'within 1 hour of the appointment';
  return 'within ' + n + ' hours of the appointment';
}

export function cancellationFeeSentence(tenant, price) {
  const settings = readCancellationFeeSettings(tenant);
  if (!cancellationFeeActive(settings)) return '';
  const quote = quoteCancellationFee(settings, price);
  let feeDesc = settings.type === 'fixed'
    ? ('$' + settings.amount.toFixed(2))
    : (String(settings.percent) + '% of the service price');
  if (settings.type === 'percent' && quote.amount >= 0.5) feeDesc += ' ($' + quote.amount.toFixed(2) + ')';
  const when = cancellationWindowLabel(settings.hours);
  return 'If you cancel ' + when + ', a cancellation fee of ' + feeDesc + ' applies. Other ways to pay stay available.';
}

export function cancellationPolicyPublic(tenant) {
  const settings = readCancellationFeeSettings(tenant);
  const active = cancellationFeeActive(settings);
  return {
    enabled: active,
    hours: settings.hours,
    type: settings.type,
    percent: settings.percent,
    amount: settings.amount,
    summary: active ? cancellationFeeSentence(tenant, null) : '',
  };
}

export function clientPaidByCard(booking) {
  if (!booking) return false;
  if (booking.depositPaid === true && Number(booking.depositAmount) > 0) return true;
  const method = String(booking.paymentMethod || '').toLowerCase();
  const status = String(booking.paymentStatus || '').toUpperCase();
  if (status === 'DEPOSIT PAID' || status === 'PAID VIA CARD') return true;
  if (method === 'card' && status.indexOf('PAID') !== -1 && status.indexOf('AWAITING') === -1) return true;
  return false;
}

function tenantTimezone(tenant) {
  return String((tenant && (tenant.timezone || tenant.timeZone)) || DEFAULT_TZ).trim() || DEFAULT_TZ;
}

function toMinutes(label) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*$/i.exec(String(label || ''));
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function wallTimeToUtcDate(dateStr, minutesOfDay, timeZone) {
  const p = String(dateStr || '').split('-');
  if (p.length !== 3) return null;
  const y = parseInt(p[0], 10);
  const mo = parseInt(p[1], 10);
  const d = parseInt(p[2], 10);
  if (!y || !mo || !d) return null;
  const mins = minutesOfDay == null ? 0 : minutesOfDay;
  const h = Math.floor(mins / 60);
  const mi = mins % 60;
  const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  function partsInTz(date) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || DEFAULT_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const map = {};
    fmt.formatToParts(date).forEach((part) => {
      if (part.type !== 'literal') map[part.type] = part.value;
    });
    let hour = parseInt(map.hour, 10);
    if (hour === 24) hour = 0;
    return {
      y: parseInt(map.year, 10),
      mo: parseInt(map.month, 10),
      d: parseInt(map.day, 10),
      h: hour,
      mi: parseInt(map.minute, 10),
    };
  }
  const asTz = partsInTz(utc);
  const desiredDay = Date.UTC(y, mo - 1, d);
  const actualDay = Date.UTC(asTz.y, asTz.mo - 1, asTz.d);
  const diffMs = (desiredDay - actualDay) + ((h * 60 + mi) - (asTz.h * 60 + asTz.mi)) * 60000;
  return new Date(utc.getTime() + diffMs);
}

export function insideCancellationWindow(tenant, booking, settings, nowMs) {
  const startMins = toMinutes(booking && booking.time);
  if (startMins === null || !booking || !booking.date) return false;
  const start = wallTimeToUtcDate(booking.date, startMins, tenantTimezone(tenant));
  if (!start || Number.isNaN(start.getTime())) return false;
  const hours = settings && Number.isFinite(Number(settings.hours)) ? Number(settings.hours) : 24;
  const cutoff = start.getTime() - hours * 3600000;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return now >= cutoff;
}

function validId(value, prefix) {
  const s = String(value || '').trim();
  if (prefix === 'cus' && /^cus_[A-Za-z0-9]+$/.test(s)) return s;
  if (prefix === 'pm' && /^pm_[A-Za-z0-9]+$/.test(s)) return s;
  if (prefix === 'pi' && /^pi_[A-Za-z0-9]+$/.test(s)) return s;
  return '';
}

function feeRecord(status, reason, amount) {
  return {
    cancellationFeeStatus: status,
    cancellationFeeReason: reason,
    cancellationFeeAmount: roundMoney(amount),
    cancellationFeeAt: new Date().toISOString(),
  };
}

/**
 * Decide the fee for a client cancel. Never throws.
 * Returns fields to store on the private booking. Empty object when the rule is off.
 * Does not call Stripe unless the business is Pro, the visit is inside the window,
 * the client already paid by card, and that card is already on file.
 */
export async function applyCancellationFee(env, tenant, booking, stripeRequest, nowMs) {
  try {
    const settings = readCancellationFeeSettings(tenant);
    if (!cancellationFeeActive(settings)) return {};
    const price = roundMoney(booking && booking.amount);
    const quote = quoteCancellationFee(settings, price);
    if (!insideCancellationWindow(tenant, booking, settings, nowMs)) {
      return feeRecord('outside_window', 'outside_window', 0);
    }
    if (tenantPlanName(tenant) !== 'pro') {
      return feeRecord('not_collected', 'shown_only', quote.amount);
    }
    if (quote.amount < 0.5) {
      return feeRecord('not_collected', 'fee_too_small', quote.amount);
    }
    const customer = validId(booking && booking.stripeCustomerId, 'cus');
    const paymentMethod = validId(booking && booking.stripePaymentMethodId, 'pm');
    if (!clientPaidByCard(booking) || !customer || !paymentMethod) {
      return feeRecord('not_collected', 'no_card', quote.amount);
    }
    if (typeof stripeRequest !== 'function') {
      return feeRecord('not_collected', 'charge_failed', quote.amount);
    }
    const cents = Math.round(quote.amount * 100);
    const params = new URLSearchParams();
    params.set('amount', String(cents));
    params.set('currency', 'usd');
    params.set('customer', customer);
    params.set('payment_method', paymentMethod);
    params.set('off_session', 'true');
    params.set('confirm', 'true');
    params.set('description', ('Cancellation fee — ' + String((tenant && tenant.name) || 'Schedi')).slice(0, 120));
    params.set('metadata[kind]', 'cancellation_fee');
    params.set('metadata[tenantId]', String((tenant && tenant.id) || '').slice(0, 80));
    params.set('metadata[bookingId]', String((booking && booking.id) || '').slice(0, 40));
    const idem = ('cfee_' + String((tenant && tenant.id) || '') + '_' + String((booking && booking.id) || '')).slice(0, 200);
    const created = await stripeRequest(env, '/v1/payment_intents', {
      method: 'POST',
      params,
      extraHeaders: { 'Idempotency-Key': idem },
    });
    const status = created && created.ok && created.data ? String(created.data.status || '') : '';
    if (status === 'succeeded' || status === 'processing') {
      const record = feeRecord('collected', 'card', quote.amount);
      const pi = validId(created.data && created.data.id, 'pi');
      if (pi) record.cancellationFeePaymentIntentId = pi;
      return record;
    }
    return feeRecord('not_collected', 'charge_failed', quote.amount);
  } catch (_) {
    const settings = readCancellationFeeSettings(tenant);
    const quote = quoteCancellationFee(settings, booking && booking.amount);
    return feeRecord('not_collected', 'charge_failed', quote.amount);
  }
}
