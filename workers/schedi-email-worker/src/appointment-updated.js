/**
 * Decides whether an owner edit of a confirmed appointment should email the client.
 * A date or time change is a reschedule (the existing reschedule email). Other
 * client-facing edits are an "Appointment updated" email. Internal edits are quiet.
 * The page builds the message; the worker uses the same rules to refuse a send
 * that should not go out.
 */

const PAY_LABELS = {
  card: 'Card',
  cashapp: 'Cash App',
  zelle: 'Zelle',
  venmo: 'Venmo',
  paypal: 'PayPal',
  square: 'Square',
  cash: 'Cash',
  later: 'Pay at appointment',
};

const CLIENT_FIELDS = [
  { key: 'service', label: 'Service', keys: ['serviceName'] },
  { key: 'staff', label: 'Staff', keys: ['staffName', 'staff', 'providerName', 'provider', 'assignedStaff'] },
  { key: 'location', label: 'Location', keys: ['location', 'serviceLocation', 'place', 'appointmentAddress'] },
  { key: 'note', label: 'Note', keys: ['notesToClient', 'noteToClient', 'clientNote', 'clientNotes', 'notes', 'note'] },
];

function addressWord(value) {
  if (value === true) return 'show';
  if (value === false) return 'hide';
  const s = String(value).trim().toLowerCase();
  if (!s) return null;
  if (s === '0' || s === 'false' || s === 'hide' || s === 'hidden' || s === 'off' || s === 'no' || s === 'private' || s === 'internal') return 'hide';
  if (s === '1' || s === 'true' || s === 'show' || s === 'public' || s === 'on' || s === 'yes' || s === 'visible') return 'show';
  return null;
}

function readOneAddressPref(key, value) {
  if (value == null || value === '') return null;
  if (key === 'hideAddress') {
    if (value === true) return 'hide';
    if (value === false) return 'show';
    const s = String(value).trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on' || s === 'hide' || s === 'hidden' || s === 'private' || s === 'internal') return 'hide';
    if (s === '0' || s === 'false' || s === 'no' || s === 'off' || s === 'show' || s === 'public' || s === 'visible') return 'show';
    return null;
  }
  return addressWord(value);
}

/** 'show' | 'hide' | null. null means the owner has no preference saved. */
export function readAddressDisplay(tenant) {
  if (!tenant || typeof tenant !== 'object') return null;
  const sources = [tenant, tenant.notifications];
  const keys = ['addressDisplay', 'showAddress', 'hideAddress'];
  for (let s = 0; s < sources.length; s++) {
    const src = sources[s];
    if (!src || typeof src !== 'object') continue;
    for (let i = 0; i < keys.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(src, keys[i])) continue;
      const pref = readOneAddressPref(keys[i], src[keys[i]]);
      if (pref) return pref;
    }
  }
  return null;
}

export function clientFacingAddress(tenant) {
  if (!tenant || typeof tenant !== 'object') return '';
  if (readAddressDisplay(tenant) === 'hide') return '';
  return String(tenant.address || tenant.location || tenant.businessAddress || tenant.businessLocation || '').trim();
}

export function appointmentIsClientConfirmed(booking) {
  if (!booking || typeof booking !== 'object') return false;
  if (booking.walkIn === true) return false;
  if (booking.cancelled === true || booking.noShow === true) return false;
  const status = String(booking.status || '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled' || status === 'denied' || status === 'pending') return false;
  if (status === 'no_show' || status === 'noshow' || status === 'no-show') return false;
  return true;
}

function appointmentText(booking, keys) {
  if (!booking) return '';
  for (let i = 0; i < keys.length; i++) {
    let value = booking[keys[i]];
    if (value == null) continue;
    if (typeof value === 'object') value = value.name || value.label || '';
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function appointmentMoneyCents(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function priceFromCents(cents) {
  if (cents % 100 === 0) return '$' + String(cents / 100);
  return '$' + (cents / 100).toFixed(2);
}

export function appointmentPriceText(amount) {
  const cents = appointmentMoneyCents(amount);
  if (cents == null) return 'No price';
  return priceFromCents(cents);
}

function appointmentPaymentPaid(booking) {
  const up = String((booking && booking.paymentStatus) || '').toUpperCase();
  if (/\bUNPAID\b/.test(up) || /\bNOT\s+PAID\b/.test(up)) return false;
  if (up.indexOf('PAID') !== -1) return true;
  if (up.indexOf('PENDING') !== -1 || up.indexOf('AWAITING') !== -1) return false;
  return false;
}

function appointmentPayMethodKey(booking) {
  const known = { card: 1, cashapp: 1, zelle: 1, venmo: 1, paypal: 1, square: 1, cash: 1, later: 1 };
  function norm(raw) {
    let method = String(raw || '').toLowerCase().trim();
    if (method === 'cash-app' || method === 'cash app') method = 'cashapp';
    if (method === 'in person / cash' || method === 'in person') method = 'cash';
    return known[method] ? method : '';
  }
  const fromMethod = norm(booking && booking.paymentMethod) || norm(booking && booking.paidMethod) || norm(booking && booking.paymentOption);
  if (fromMethod) return fromMethod;
  const blob = String((booking && booking.paymentOptionLabel) || '') + ' ' + String((booking && booking.paymentStatus) || '');
  const lower = blob.toLowerCase();
  if (lower.indexOf('cash app') !== -1 || lower.indexOf('cashapp') !== -1) return 'cashapp';
  if (lower.indexOf('zelle') !== -1) return 'zelle';
  if (lower.indexOf('venmo') !== -1) return 'venmo';
  if (lower.indexOf('paypal') !== -1) return 'paypal';
  if (lower.indexOf('square') !== -1) return 'square';
  if (lower.indexOf('card') !== -1) return 'card';
  if (lower.indexOf('pay at') !== -1 || lower.indexOf('unpaid') !== -1 || lower.indexOf('later') !== -1) return 'later';
  if (lower.indexOf('cash') !== -1) return 'cash';
  return appointmentPaymentPaid(booking) ? 'cash' : 'later';
}

function appointmentPaymentFact(booking) {
  const depCents = appointmentMoneyCents(booking && booking.depositAmount);
  const dep = depCents != null && depCents > 0 ? depCents : null;
  let bal = null;
  if (dep != null && booking && booking.balanceDue != null && booking.balanceDue !== '') {
    bal = appointmentMoneyCents(booking.balanceDue);
  }
  return {
    method: appointmentPayMethodKey(booking),
    paid: appointmentPaymentPaid(booking),
    dep: dep,
    depPaid: !!(booking && booking.depositPaid === true),
    bal: bal,
    code: String((booking && (booking.payCode || booking.paymentCode)) || '').trim(),
  };
}

export function appointmentPaymentDetail(booking) {
  const fact = appointmentPaymentFact(booking || {});
  const parts = [PAY_LABELS[fact.method] || 'Pay at appointment', fact.paid ? 'Paid' : 'Unpaid'];
  if (fact.dep != null) {
    parts.push('Deposit ' + priceFromCents(fact.dep) + (fact.depPaid ? ' paid' : ' due'));
    if (fact.bal != null) parts.push('Balance ' + priceFromCents(fact.bal));
  }
  if (fact.code) parts.push('Code ' + fact.code);
  return parts.join(' · ');
}

function paymentSame(before, after) {
  const left = appointmentPaymentFact(before || {});
  const right = appointmentPaymentFact(after || {});
  return left.method === right.method && left.paid === right.paid && left.dep === right.dep
    && left.depPaid === right.depPaid && left.bal === right.bal && left.code === right.code;
}

export function appointmentClientChanges(before, after) {
  before = before || {};
  after = after || {};
  const schedule = String(before.date || '').trim() !== String(after.date || '').trim()
    || String(before.time || '').trim() !== String(after.time || '').trim();
  const rows = [];
  CLIENT_FIELDS.forEach(function (field) {
    if (field.key === 'service') {
      const from = String(before.serviceName || '').trim();
      const to = String(after.serviceName || '').trim();
      if (from !== to) rows.push({ key: 'service', label: 'Service', from: from, to: to });
      return;
    }
    const from = appointmentText(before, field.keys);
    const to = appointmentText(after, field.keys);
    if (from !== to) rows.push({ key: field.key, label: field.label, from: from, to: to });
  });
  const fromCents = appointmentMoneyCents(before.amount);
  const toCents = appointmentMoneyCents(after.amount);
  if (fromCents !== toCents) {
    rows.splice(1, 0, { key: 'price', label: 'Price', from: appointmentPriceText(before.amount), to: appointmentPriceText(after.amount) });
  }
  if (!paymentSame(before, after)) {
    rows.push({ key: 'payment', label: 'Payment', from: appointmentPaymentDetail(before), to: appointmentPaymentDetail(after) });
  }
  return { schedule: schedule, rows: rows };
}

function visibleChangeRows(rows, tenant) {
  if (readAddressDisplay(tenant) !== 'hide') return rows;
  return rows.filter(function (row) { return row.key !== 'location'; });
}

/**
 * 'reschedule' | 'updated' | 'none'
 * opts.notify false keeps the edit quiet. A schedule change wins, so the client
 * gets the reschedule email and not a second update email.
 */
export function appointmentEditMailPlan(before, after, opts) {
  opts = opts || {};
  if (!opts.notify) return 'none';
  if (!appointmentIsClientConfirmed(before) || !appointmentIsClientConfirmed(after)) return 'none';
  const email = String((after && after.clientEmail) || '').trim();
  if (email.indexOf('@') < 1) return 'none';
  const changes = appointmentClientChanges(before, after);
  if (changes.schedule) return 'reschedule';
  return visibleChangeRows(changes.rows, opts.tenant).length ? 'updated' : 'none';
}
