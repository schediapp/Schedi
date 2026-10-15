/**
 * Read-only daily ops snapshot for internal Schedi agents (Avery support watch, Sales).
 *
 * GET|POST /api/ops-snapshot          Authorization: Bearer <OPS_SNAPSHOT_TOKEN>
 *   ?history=N   return the last N stored daily snapshots from KV (max 60) instead of a live one
 *
 * STRICTLY READ-ONLY toward Firestore and Stripe: only GET requests. Sends no email.
 * emailEngagement is read from KV (emailEvt:e:*), written only by the Resend webhook receiver (email-events.js).
 * The only write is the optional daily KV history entry (opsSnapshot:*) made by the cron.
 * Never returns client/customer PII, passwords/hashes, or card data.
 */

import { listPrivateTenants, mergePrivateInto } from './tenant-private.js';
import { buildEmailEngagement } from './email-events.js';

const OWNER_PRICES = {
  price_1UMH8jGh1H5O3dkraHpGvCEN: { plan: 'starter', amount: 29 },
  price_1UMH8jGh1H5O3dkr3fNrA90v: { plan: 'pro', amount: 49 },
};
const TZ = 'America/New_York';
const HISTORY_PREFIX = 'opsSnapshot:';
const HISTORY_TTL_SEC = 120 * 24 * 3600;

const ADMIN_INBOX_QUERY =
  '(to:admin@schedi.app OR cc:admin@schedi.app) older_than:1d -in:trash -in:spam -in:sent ' +
  '-from:bookings@schedi.app -from:instagram.com -from:buffer.com -from:buffermail.com -schedi-signups';

function etString(ms) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
    }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toISOString();
  }
}

function etDateKey(ms) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  return p; // YYYY-MM-DD
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  if (aa.byteLength !== bb.byteLength) return false;
  let out = 0;
  for (let i = 0; i < aa.byteLength; i++) out |= aa[i] ^ bb[i];
  return out === 0;
}

function opsJson(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}

/* ---------------- Firestore (GET only) ---------------- */

function decodeValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) {
    const o = {};
    const f = v.mapValue.fields || {};
    for (const k of Object.keys(f)) o[k] = decodeValue(f[k]);
    return o;
  }
  return null;
}

async function readTenantsRaw(env, deps) {
  const projectId = String(env.FIREBASE_PROJECT_ID || 'siteforge-97699').trim();
  const appId = String(env.FIREBASE_APP_ID || 'siteforge-97699').trim();
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/artifacts/${appId}/public/data/tenants`;
  let headers = {};
  try {
    const h = await deps.adminAuthHeaders(env);
    headers = { Authorization: h.Authorization };
  } catch (_) {
    headers = {}; // public tenant docs are public-read; private fields need Admin (merge below will fail)
  }
  const out = [];
  let pageToken = '';
  let pages = 0;
  do {
    const url = base + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(url, { method: 'GET', headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('firestore_list_failed:' + res.status);
    for (const doc of data.documents || []) {
      const t = {};
      const fields = doc.fields || {};
      for (const k of Object.keys(fields)) t[k] = decodeValue(fields[k]);
      t.__docId = String(doc.name || '').split('/').pop();
      t.__createTime = doc.createTime || null;
      t.__updateTime = doc.updateTime || null;
      out.push(t);
    }
    pageToken = data.nextPageToken || '';
    pages++;
  } while (pageToken && pages < 20);
  // Owner contact + billing fields live in the Admin-only private tenant docs.
  const privateMap = await listPrivateTenants(env);
  for (const t of out) {
    if (privateMap[t.__docId]) mergePrivateInto(t, privateMap[t.__docId]);
  }
  return out;
}

const SAFE_LOCATION_KEYS = ['city', 'state', 'businessCity', 'businessState', 'location', 'region', 'zip', 'postalCode'];

function pickReferralFields(t) {
  const out = {};
  for (const k of Object.keys(t)) {
    if (/refer|referral|promo|invitedBy|affiliate/i.test(k) && !/password|hash|secret|token/i.test(k)) {
      const v = t[k];
      if (v === null || v === '' || (typeof v === 'object' && !Object.keys(v || {}).length)) continue;
      out[k] = typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v;
    }
  }
  return out;
}

function pickPauseFields(t) {
  const out = {};
  for (const k of Object.keys(t)) {
    if (/pause|suspend|disabledReason|statusReason/i.test(k)) {
      const v = t[k];
      if (v === null || v === '') continue;
      out[k] = typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v;
    }
  }
  return out;
}

function tenantSlug(t) {
  return String(t.slug || t.id || t.__docId || '');
}

function tenantCreatedAt(t) {
  return t.createdAt || t.created || t.signupAt || t.__createTime || null;
}

function isComplimentary(t) {
  return t.complimentaryPro === true || t.billingExempt === true;
}

function isActive(t) {
  return String(t.subscriptionStatus || '') === 'active';
}

/* ---------------- Stripe (GET only) ---------------- */

async function stripeGet(deps, env, path) {
  return deps.stripeRequest(env, path, { method: 'GET' });
}

function invoicePriceIds(inv) {
  const ids = [];
  const lines = (inv && inv.lines && inv.lines.data) || [];
  for (const l of lines) {
    if (l.price && l.price.id) ids.push(l.price.id);
    if (l.plan && l.plan.id) ids.push(l.plan.id);
    if (l.pricing && l.pricing.price_details && l.pricing.price_details.price) ids.push(l.pricing.price_details.price);
  }
  return ids;
}

function subscriptionPriceIds(sub) {
  const ids = [];
  for (const it of (sub && sub.items && sub.items.data) || []) {
    if (it.price && it.price.id) ids.push(it.price.id);
    if (it.plan && it.plan.id) ids.push(it.plan.id);
  }
  if (sub && sub.plan && sub.plan.id) ids.push(sub.plan.id);
  return ids;
}

function invoiceSubscriptionId(inv) {
  if (!inv) return '';
  if (typeof inv.subscription === 'string') return inv.subscription;
  if (inv.subscription && inv.subscription.id) return inv.subscription.id;
  const p = inv.parent && inv.parent.subscription_details;
  if (p && typeof p.subscription === 'string') return p.subscription;
  if (p && p.subscription && p.subscription.id) return p.subscription.id;
  return '';
}

function invoiceMetadata(inv) {
  if (inv.subscription_details && inv.subscription_details.metadata) return inv.subscription_details.metadata;
  const p = inv.parent && inv.parent.subscription_details;
  if (p && p.metadata) return p.metadata;
  const l = inv.lines && inv.lines.data && inv.lines.data[0];
  return (l && l.metadata) || {};
}

async function listEvents(deps, env, types, sinceSec) {
  const out = [];
  let startingAfter = '';
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams();
    qs.set('limit', '100');
    qs.set('created[gte]', String(sinceSec));
    for (const t of types) qs.append('types[]', t);
    if (startingAfter) qs.set('starting_after', startingAfter);
    const r = await stripeGet(deps, env, '/v1/events?' + qs.toString());
    if (!r.ok) return { ok: false, error: r.error || 'stripe_error', status: r.status, events: out };
    const data = (r.data && r.data.data) || [];
    out.push(...data);
    if (!r.data.has_more || !data.length) break;
    startingAfter = data[data.length - 1].id;
  }
  return { ok: true, events: out };
}

/* ---------------- Sections ---------------- */

function buildTenantSection(tenants, nowMs) {
  const d7 = nowMs - 7 * 864e5;
  const d30 = nowMs - 30 * 864e5;
  const totals = { totalPages: tenants.length, active: 0, paused: 0, free: 0, starterPaid: 0, proPaid: 0, complimentary: 0, createdLast7d: 0, createdLast30d: 0 };
  const fieldsFound = { city: false, state: false, referral: false, createdAtField: false };
  const items = tenants.map((t) => {
    const plan = String(t.plan || 'free').toLowerCase();
    const comp = isComplimentary(t);
    if (isActive(t)) totals.active++; else totals.paused++;
    if (comp) totals.complimentary++;
    else if (plan === 'pro') totals.proPaid++;
    else if (plan === 'starter') totals.starterPaid++;
    else totals.free++;
    const created = tenantCreatedAt(t);
    const cMs = created ? Date.parse(created) : NaN;
    if (Number.isFinite(cMs) && cMs >= d7) totals.createdLast7d++;
    if (Number.isFinite(cMs) && cMs >= d30) totals.createdLast30d++;
    if (t.createdAt) fieldsFound.createdAtField = true;
    const loc = {};
    for (const k of SAFE_LOCATION_KEYS) if (t[k] !== undefined && t[k] !== null && t[k] !== '') loc[k] = t[k];
    if (loc.city || loc.businessCity) fieldsFound.city = true;
    if (loc.state || loc.businessState) fieldsFound.state = true;
    const ref = pickReferralFields(t);
    if (Object.keys(ref).length) fieldsFound.referral = true;
    return {
      slug: tenantSlug(t),
      businessName: String(t.name || t.businessName || ''),
      plan,
      paidPlan: !comp && (plan === 'starter' || plan === 'pro'),
      subscriptionStatus: String(t.subscriptionStatus || ''),
      complimentary: comp,
      paymentForm: String(t.paymentForm || ''),
      hasStripeSubscription: !!t.stripeSubscriptionId,
      createdAt: created,
      createdAtSource: t.createdAt ? 'field' : 'firestore_doc_createTime',
      ownerName: String(t.ownerName || ''),
      ownerEmail: String(t.ownerEmail || ''),
      ownerPhone: String(t.ownerPhone || ''),
      industry: String(t.industry || t.category || ''),
      location: loc,
      referral: ref,
      bookingUrl: 'https://schedi.app/' + encodeURIComponent(tenantSlug(t)),
    };
  });
  items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return { totals, fieldsFound, items };
}

async function buildPausedSection(env, deps, tenants) {
  const paused = tenants.filter((t) => !isActive(t));
  const items = [];
  let lookups = 0;
  for (const t of paused) {
    const explicit = pickPauseFields(t);
    let reason = '';
    let stripeStatus = null;
    if (t.stripeSubscriptionId && lookups < 25) {
      lookups++;
      const r = await stripeGet(deps, env, '/v1/subscriptions/' + encodeURIComponent(t.stripeSubscriptionId));
      if (r.ok && r.data) {
        const s = r.data;
        stripeStatus = s.status;
        const cd = s.cancellation_details || {};
        if (s.status === 'active' || s.status === 'trialing') reason = 'Paused manually (Stripe subscription still ' + s.status + ')';
        else reason = 'Stripe subscription ' + s.status + (cd.reason ? ' (' + cd.reason + ')' : '') + (s.canceled_at ? ' at ' + etString(s.canceled_at * 1000) : '');
      } else {
        reason = 'Stripe subscription lookup failed (' + (r.status || '?') + ')';
      }
    } else if (!t.stripeSubscriptionId) {
      reason = 'No Stripe subscription on file: paused from Agency HQ or never subscribed';
    }
    if (Object.keys(explicit).length) reason = (reason ? reason + '; ' : '') + 'fields: ' + JSON.stringify(explicit);
    items.push({
      slug: tenantSlug(t),
      businessName: String(t.name || ''),
      plan: String(t.plan || ''),
      subscriptionStatus: String(t.subscriptionStatus || '(missing)'),
      complimentary: isComplimentary(t),
      stripeSubscriptionStatus: stripeStatus,
      reason: reason || 'unknown',
      lastUpdated: t.__updateTime || null,
    });
  }
  return {
    count: items.length,
    definition: 'tenant docs whose subscriptionStatus is not "active" (public booking page is off)',
    pauseReasonField: 'none exists on tenant docs; reason is derived from the linked Stripe subscription when there is one',
    items,
  };
}

function tenantForStripe(tenants, { tenantId, customerId, subscriptionId }) {
  return tenants.find((t) =>
    (tenantId && tenantSlug(t) === tenantId) ||
    (subscriptionId && t.stripeSubscriptionId === subscriptionId) ||
    (customerId && t.stripeCustomerId === customerId)
  ) || null;
}

async function buildBillingSection(env, deps, tenants, nowMs) {
  const sinceSec = Math.floor(nowMs / 1000) - 24 * 3600;
  const types = [
    'invoice.payment_failed', 'invoice.voided', 'invoice.marked_uncollectible',
    'customer.subscription.deleted', 'customer.subscription.updated',
  ];
  const ev = await listEvents(deps, env, types, sinceSec);
  const result = {
    windowStart: new Date(sinceSec * 1000).toISOString(),
    windowStartET: etString(sinceSec * 1000),
    ok: ev.ok,
    error: ev.ok ? undefined : ev.error,
    failedInvoices24h: { count: 0, items: [] },
    subscriptionChanges24h: { count: 0, items: [] },
    nonOwnerPlanEventsIgnored: 0,
    currentPastDueOrUnpaid: { count: 0, items: [] },
  };
  const subCache = new Map();
  async function getSub(id) {
    if (!id) return null;
    if (subCache.has(id)) return subCache.get(id);
    const r = await stripeGet(deps, env, '/v1/subscriptions/' + encodeURIComponent(id));
    const v = r.ok ? r.data : null;
    subCache.set(id, v);
    return v;
  }
  const invoices = new Map();
  for (const e of ev.events || []) {
    const obj = (e.data && e.data.object) || {};
    if (e.type.startsWith('invoice.')) {
      const subId = invoiceSubscriptionId(obj);
      let priceIds = invoicePriceIds(obj);
      let meta = invoiceMetadata(obj);
      if (!priceIds.some((p) => OWNER_PRICES[p]) && subId) {
        const sub = await getSub(subId);
        if (sub) { priceIds = priceIds.concat(subscriptionPriceIds(sub)); meta = Object.assign({}, sub.metadata || {}, meta); }
      }
      const owner = priceIds.map((p) => OWNER_PRICES[p]).find(Boolean);
      if (!owner) { result.nonOwnerPlanEventsIgnored++; continue; }
      const kind = e.type === 'invoice.payment_failed' ? 'payment_failed' : e.type === 'invoice.voided' ? 'voided' : 'uncollectible';
      const customerId = typeof obj.customer === 'string' ? obj.customer : (obj.customer && obj.customer.id) || '';
      const tenant = tenantForStripe(tenants, { tenantId: meta.tenantId, customerId, subscriptionId: subId });
      const prev = invoices.get(obj.id);
      if (prev) {
        prev.events.push(kind);
        if (e.created * 1000 > prev.lastEventMs) { prev.lastEventMs = e.created * 1000; prev.status = kind; prev.invoiceStatus = obj.status || prev.invoiceStatus; }
        continue;
      }
      invoices.set(obj.id, {
        invoiceId: obj.id,
        slug: tenant ? tenantSlug(tenant) : String(meta.tenantId || meta.slug || ''),
        businessName: tenant ? String(tenant.name || '') : String(meta.businessName || ''),
        email: String(obj.customer_email || (tenant && tenant.ownerEmail) || ''),
        plan: owner.plan,
        amount: Number(obj.amount_due || obj.total || 0) / 100,
        currency: String(obj.currency || 'usd'),
        status: kind,
        invoiceStatus: obj.status || '',
        attemptCount: obj.attempt_count || 0,
        nextRetryET: obj.next_payment_attempt ? etString(obj.next_payment_attempt * 1000) : null,
        events: [kind],
        lastEventMs: e.created * 1000,
      });
    } else {
      const prevAttrs = (e.data && e.data.previous_attributes) || {};
      const becameBad = e.type === 'customer.subscription.deleted' ||
        (('status' in prevAttrs) && ['past_due', 'unpaid', 'canceled'].includes(obj.status));
      if (!becameBad) continue;
      const priceIds = subscriptionPriceIds(obj);
      const owner = priceIds.map((p) => OWNER_PRICES[p]).find(Boolean);
      if (!owner) { result.nonOwnerPlanEventsIgnored++; continue; }
      const customerId = typeof obj.customer === 'string' ? obj.customer : '';
      const meta = obj.metadata || {};
      const tenant = tenantForStripe(tenants, { tenantId: meta.tenantId, customerId, subscriptionId: obj.id });
      result.subscriptionChanges24h.items.push({
        subscriptionId: obj.id,
        slug: tenant ? tenantSlug(tenant) : String(meta.tenantId || ''),
        businessName: tenant ? String(tenant.name || '') : String(meta.businessName || ''),
        email: String((tenant && tenant.ownerEmail) || meta.ownerEmail || ''),
        plan: owner.plan,
        amount: owner.amount,
        status: e.type === 'customer.subscription.deleted' ? 'canceled' : obj.status,
        previousStatus: prevAttrs.status || null,
        cancellationReason: (obj.cancellation_details && obj.cancellation_details.reason) || null,
        time: new Date(e.created * 1000).toISOString(),
        timeET: etString(e.created * 1000),
      });
    }
  }
  result.failedInvoices24h.items = [...invoices.values()]
    .sort((a, b) => b.lastEventMs - a.lastEventMs)
    .map((x) => {
      const { lastEventMs, ...rest } = x;
      return Object.assign(rest, { time: new Date(lastEventMs).toISOString(), timeET: etString(lastEventMs) });
    });
  result.failedInvoices24h.count = result.failedInvoices24h.items.length;
  result.subscriptionChanges24h.count = result.subscriptionChanges24h.items.length;

  for (const status of ['past_due', 'unpaid']) {
    const r = await stripeGet(deps, env, '/v1/subscriptions?limit=100&status=' + status);
    if (!r.ok) continue;
    for (const s of (r.data && r.data.data) || []) {
      const owner = subscriptionPriceIds(s).map((p) => OWNER_PRICES[p]).find(Boolean);
      if (!owner) continue;
      const tenant = tenantForStripe(tenants, { tenantId: (s.metadata || {}).tenantId, customerId: typeof s.customer === 'string' ? s.customer : '', subscriptionId: s.id });
      result.currentPastDueOrUnpaid.items.push({
        subscriptionId: s.id,
        slug: tenant ? tenantSlug(tenant) : String((s.metadata || {}).tenantId || ''),
        email: String((tenant && tenant.ownerEmail) || ''),
        plan: owner.plan,
        amount: owner.amount,
        status: s.status,
      });
    }
  }
  result.currentPastDueOrUnpaid.count = result.currentPastDueOrUnpaid.items.length;
  return result;
}

async function buildConnectSection(env, deps, tenants) {
  const items = [];
  const all = [];
  let startingAfter = '';
  let error = null;
  for (let page = 0; page < 5; page++) {
    const r = await stripeGet(deps, env, '/v1/accounts?limit=100' + (startingAfter ? '&starting_after=' + encodeURIComponent(startingAfter) : ''));
    if (!r.ok) { error = r.error || ('stripe_' + r.status); break; }
    const data = (r.data && r.data.data) || [];
    all.push(...data);
    if (!r.data.has_more || !data.length) break;
    startingAfter = data[data.length - 1].id;
  }
  for (const a of all) {
    const caps = a.capabilities || {};
    const card = caps.card_payments || 'inactive';
    const transfers = caps.transfers || null;
    const payoutsEnabled = !!a.payouts_enabled;
    const cardReady = card === 'active' && payoutsEnabled;
    const tenant = tenants.find((t) => (a.metadata && a.metadata.tenantId && tenantSlug(t) === a.metadata.tenantId) ||
      Object.values(t).some((v) => v === a.id));
    if (!cardReady) {
      const req = a.requirements || {};
      items.push({
        accountId: a.id,
        slug: tenant ? tenantSlug(tenant) : String((a.metadata && a.metadata.tenantId) || ''),
        businessName: tenant ? String(tenant.name || '') : '',
        card_payments: card,
        transfers,
        payouts_enabled: payoutsEnabled,
        charges_enabled: !!a.charges_enabled,
        details_submitted: !!a.details_submitted,
        currentlyDueCount: (req.currently_due || []).length,
        disabledReason: req.disabled_reason || null,
      });
    }
  }
  const live = all.length > 0;
  return {
    live,
    note: live ? 'connected accounts found on the platform' : (error ? 'Connect not live (accounts list unavailable: ' + error + ')' : 'Connect not live: 0 connected accounts on the platform'),
    connectedAccounts: all.length,
    notCardReady: { count: items.length, definition: 'capabilities.card_payments != active OR payouts_enabled false', items },
  };
}

async function buildReferralSection(env, tenantSection) {
  const withRef = tenantSection.items.filter((t) => Object.keys(t.referral || {}).length);
  let kvKeys = 0;
  try {
    if (env.AUTH_KV && env.AUTH_KV.list) {
      for (const prefix of ['referral', 'referrals:', 'ref:']) {
        const l = await env.AUTH_KV.list({ prefix, limit: 100 });
        kvKeys += (l.keys || []).length;
      }
    }
  } catch (_) {}
  const live = withRef.length > 0 || kvKeys > 0;
  return {
    live,
    note: live ? 'referral data found' : 'Referral bonus backend not built in production: no referral fields on tenant docs and no referral keys in KV',
    tenantsWithReferralFields: withRef.length,
    kvReferralKeys: kvKeys,
    items: withRef.map((t) => ({ slug: t.slug, referral: t.referral })),
  };
}

export async function buildOpsSnapshot(env, deps) {
  const nowMs = Date.now();
  const errors = [];
  let tenants = [];
  try { tenants = await readTenantsRaw(env, deps); } catch (e) { errors.push('tenants: ' + String(e && e.message || e)); }

  const tenantSection = buildTenantSection(tenants, nowMs);
  let paused = { count: null, items: [] };
  let billing = { ok: false };
  let connect = { live: false, notCardReady: { count: 0, items: [] } };
  let referrals = { live: false };
  try { paused = await buildPausedSection(env, deps, tenants); } catch (e) { errors.push('paused: ' + String(e && e.message || e)); }
  try { billing = await buildBillingSection(env, deps, tenants, nowMs); } catch (e) { errors.push('billing: ' + String(e && e.message || e)); }
  try { connect = await buildConnectSection(env, deps, tenants); } catch (e) { errors.push('connect: ' + String(e && e.message || e)); }
  try { referrals = await buildReferralSection(env, tenantSection); } catch (e) { errors.push('referrals: ' + String(e && e.message || e)); }
  let emailEngagement = { notes: ['not built'] };
  try { emailEngagement = await buildEmailEngagement(env, tenants, nowMs); } catch (e) { errors.push('emailEngagement: ' + String(e && e.message || e)); }
  const ee24 = emailEngagement.last24h || {};
  const ee7 = emailEngagement.last7d || {};

  return {
    ok: errors.length === 0,
    generatedAt: new Date(nowMs).toISOString(),
    generatedAtET: etString(nowMs),
    readOnly: true,
    summary: {
      pausedPages: paused.count,
      failedInvoices24h: billing.failedInvoices24h ? billing.failedInvoices24h.count : null,
      subscriptionsWentBad24h: billing.subscriptionChanges24h ? billing.subscriptionChanges24h.count : null,
      currentPastDueOrUnpaid: billing.currentPastDueOrUnpaid ? billing.currentPastDueOrUnpaid.count : null,
      connectLive: connect.live,
      connectNotCardReady: connect.notCardReady ? connect.notCardReady.count : null,
      adminInboxUnanswered: 'count with Gmail (see adminInbox.query)',
      totalPages: tenantSection.totals.totalPages,
      referralsLive: referrals.live,
      emailOpens24h: ee24.opens ?? null,
      emailUniqueOpened24h: ee24.uniqueOpened ?? null,
      emailClicks24h: ee24.clicks ?? null,
      emailOpens7d: ee7.opens ?? null,
      emailClicks7d: ee7.clicks ?? null,
      emailBouncesOrComplaints7d: (ee7.bounced ?? 0) + (ee7.complained ?? 0),
      emailTrackingWebhookConfigured: !!emailEngagement.webhookConfigured,
    },
    pausedPages: paused,
    failedInvoices24h: billing.failedInvoices24h || { count: null, items: [] },
    subscriptionChanges24h: billing.subscriptionChanges24h || { count: null, items: [] },
    currentPastDueOrUnpaid: billing.currentPastDueOrUnpaid || { count: null, items: [] },
    billingMeta: { ok: billing.ok, error: billing.error, windowStartET: billing.windowStartET, nonOwnerPlanEventsIgnored: billing.nonOwnerPlanEventsIgnored, ownerPrices: OWNER_PRICES },
    connect,
    adminInbox: {
      note: 'Not counted by the worker (it cannot read Gmail). Count it with the Gmail connector on axl199@gmail.com.',
      query: ADMIN_INBOX_QUERY,
      unansweredRule: 'A thread is unanswered when no message from axl199@gmail.com (label SENT) comes after the newest inbound message, and that inbound message is older than 24h.',
    },
    tenants: tenantSection,
    referrals,
    emailEngagement,
    errors,
  };
}

export async function handleOpsSnapshotHttp(request, env, deps) {
  if (request.method !== 'GET' && request.method !== 'POST') return opsJson({ ok: false, error: 'method_not_allowed' }, 405);
  const expected = String(env.OPS_SNAPSHOT_TOKEN || '').trim();
  const auth = String(request.headers.get('Authorization') || '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!expected || !given || !timingSafeEqualStr(given, expected)) return opsJson({ ok: false, error: 'unauthorized' }, 401);
  const url = new URL(request.url);
  const history = Math.min(60, Math.max(0, parseInt(url.searchParams.get('history') || '0', 10) || 0));
  if (history > 0) {
    if (!env.AUTH_KV) return opsJson({ ok: false, error: 'no_kv' }, 500);
    const l = await env.AUTH_KV.list({ prefix: HISTORY_PREFIX + 'day:', limit: 1000 });
    const names = (l.keys || []).map((k) => k.name).sort().reverse().slice(0, history);
    const items = [];
    for (const n of names) {
      const v = await env.AUTH_KV.get(n, 'json');
      if (v) items.push(v);
    }
    return opsJson({ ok: true, count: items.length, items }, 200);
  }
  try {
    const snap = await buildOpsSnapshot(env, deps);
    return opsJson(snap, 200);
  } catch (e) {
    return opsJson({ ok: false, error: 'snapshot_failed' }, 500);
  }
}

/** Daily cron: store one snapshot per ET day in KV (opsSnapshot:day:YYYY-MM-DD). */
export async function runOpsSnapshotCron(event, env, deps) {
  const ms = (event && event.scheduledTime) || Date.now();
  if (new Date(ms).getUTCHours() !== 12) return { skipped: true }; // 8am EDT / 7am EST
  if (!env.AUTH_KV) return { skipped: true, reason: 'no_kv' };
  const snap = await buildOpsSnapshot(env, deps);
  const day = etDateKey(ms);
  await env.AUTH_KV.put(HISTORY_PREFIX + 'day:' + day, JSON.stringify(snap), { expirationTtl: HISTORY_TTL_SEC });
  return { stored: day, summary: snap.summary };
}
