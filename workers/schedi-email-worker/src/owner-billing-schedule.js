/**
 * POST /billing/cancel and POST /billing/resume for the owner portal (schedi.app SPA).
 *
 * Same rules as src/lib/public-owner-billing.ts handleOwnerBillingSchedule:
 * - The session is checked before the tenant is loaded (owner of this tenant, or agency).
 * - Complimentary / billing-exempt plans are refused.
 * - The live Stripe subscription must belong to the tenant's stored customer.
 * - Cancel sets cancel_at_period_end=true. Resume sets it back to false, only when a cancel is scheduled.
 *   Nothing here deletes a subscription; access ends when Stripe sends customer.subscription.deleted.
 */

const CANCEL_PATH = '/billing/cancel';
const RESUME_PATH = '/billing/resume';

export function ownerBillingScheduleAction(path) {
  const normalized = String(path || '').replace(/\/+$/, '') || '/';
  if (normalized === CANCEL_PATH) return 'cancel';
  if (normalized === RESUME_PATH) return 'resume';
  return null;
}

function safeTenantId(value) {
  const id = String(value == null ? '' : value).trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return '';
  return id;
}

function customerIdOf(data) {
  const customer = data && data.customer;
  if (typeof customer === 'string') return customer;
  if (customer && typeof customer === 'object' && typeof customer.id === 'string') return customer.id;
  return '';
}

function unixToIso(unix) {
  const n = Number(unix);
  if (unix == null || !Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/** Period end after a cancel-at-period-end request. Prefer Stripe's cancel_at when the cancel is scheduled. */
export function subscriptionPeriodEndIso(sub) {
  if (!sub) return null;
  if (sub.cancel_at_period_end && sub.cancel_at) return unixToIso(sub.cancel_at);
  const item = sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  return unixToIso(sub.current_period_end) || unixToIso(item && item.current_period_end) || unixToIso(sub.cancel_at);
}

/**
 * Cancel schedule carried by a Stripe subscription object (customer.subscription.updated).
 * The Stripe billing portal may set cancel_at_period_end=true, or (newer API versions) only cancel_at.
 * @returns {{ cancelAtPeriodEnd: boolean, currentPeriodEnd: string }}
 */
export function subscriptionScheduleFromStripe(sub, nowMs = Date.now()) {
  if (!sub || typeof sub !== 'object') return { cancelAtPeriodEnd: false, currentPeriodEnd: '' };
  const status = String(sub.status || '');
  if (status === 'canceled' || status === 'incomplete_expired') return { cancelAtPeriodEnd: false, currentPeriodEnd: '' };
  const cancelAt = Number(sub.cancel_at);
  const futureCancelAt = Number.isFinite(cancelAt) && cancelAt > 0 && cancelAt * 1000 > nowMs;
  const scheduled = sub.cancel_at_period_end === true || futureCancelAt;
  if (!scheduled) return { cancelAtPeriodEnd: false, currentPeriodEnd: '' };
  const iso = futureCancelAt ? unixToIso(cancelAt) : subscriptionPeriodEndIso(sub);
  return { cancelAtPeriodEnd: true, currentPeriodEnd: iso || '' };
}

function result(status, body) {
  return { status, body };
}

/**
 * @param {Request} request
 * @param {string} path
 * @param {{
 *   sessionAllows(session: unknown, tenantId: string): Promise<boolean>,
 *   loadTenant(tenantId: string): Promise<object|null>,
 *   stripeForm(path: string, init?: { method?: string, params?: URLSearchParams }): Promise<{ok:boolean,status:number,data?:any}>,
 *   saveSchedule?(tenantId: string, patch: { cancelAtPeriodEnd: boolean, currentPeriodEnd: string }): Promise<void>,
 * }} deps
 * @returns {Promise<{status:number, body:object}|null>} null when the path is not cancel/resume.
 */
export async function handleOwnerBillingSchedule(request, path, deps) {
  const action = ownerBillingScheduleAction(path);
  if (!action) return null;
  if (request.method !== 'POST') return result(405, { ok: false, error: 'method_not_allowed' });

  let data;
  try {
    data = JSON.parse((await request.text()) || '{}');
  } catch (_) {
    return result(400, { ok: false, error: 'invalid_json' });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return result(400, { ok: false, error: 'invalid_json' });

  const tenantId = safeTenantId(data.tenantId != null ? data.tenantId : data.tenant_id);
  if (!tenantId) return result(400, { ok: false, error: 'invalid_tenant' });

  let allowed = false;
  try {
    allowed = await deps.sessionAllows(data.session, tenantId);
  } catch (_) {
    allowed = false;
  }
  if (allowed === 'forbidden') return result(403, { ok: false, error: 'forbidden' });
  if (allowed !== true) return result(401, { ok: false, error: 'session_required' });

  let tenant;
  try {
    tenant = await deps.loadTenant(tenantId);
  } catch (_) {
    return result(502, { ok: false, error: 'tenant_lookup_failed' });
  }
  if (!tenant) return result(404, { ok: false, error: 'tenant_not_found' });
  if (tenant.__privateLoadFailed) return result(502, { ok: false, error: 'tenant_lookup_failed' });
  if (tenant.complimentaryPro === true || tenant.billingExempt === true) {
    return result(400, { ok: false, error: 'complimentary_no_charge' });
  }

  const subscriptionId = String(tenant.stripeSubscriptionId || '').trim();
  if (!subscriptionId) return result(409, { ok: false, error: 'no_subscription' });
  const subPath = '/v1/subscriptions/' + encodeURIComponent(subscriptionId);

  const current = await deps.stripeForm(subPath, { method: 'GET' });
  if (!current || !current.ok || !current.data) {
    if (current && current.status === 404) return result(409, { ok: false, error: 'no_subscription' });
    return result(502, { ok: false, error: 'subscription_lookup_failed' });
  }

  const storedCustomer = String(tenant.stripeCustomerId || '').trim();
  const liveCustomer = customerIdOf(current.data);
  if (!storedCustomer || !liveCustomer || storedCustomer !== liveCustomer) {
    return result(409, { ok: false, error: 'customer_mismatch' });
  }
  const status = String(current.data.status || '');
  if (status === 'canceled' || status === 'incomplete_expired') {
    return result(409, { ok: false, error: 'no_subscription' });
  }
  if (action === 'resume' && current.data.cancel_at_period_end !== true) {
    return result(409, { ok: false, error: 'not_scheduled' });
  }

  const params = new URLSearchParams();
  params.set('cancel_at_period_end', action === 'cancel' ? 'true' : 'false');
  const updated = await deps.stripeForm(subPath, { method: 'POST', params });
  if (!updated || !updated.ok || !updated.data) return result(502, { ok: false, error: 'subscription_update_failed' });

  const cancelAtPeriodEnd = action === 'cancel';
  const activeUntil = cancelAtPeriodEnd ? subscriptionPeriodEndIso(updated.data) : null;
  if (deps.saveSchedule) {
    try {
      await deps.saveSchedule(tenantId, { cancelAtPeriodEnd, currentPeriodEnd: activeUntil || '' });
    } catch (_) {
      // Stripe already recorded the change. The SPA still gets the period end.
    }
  }
  return result(200, { ok: true, cancelAtPeriodEnd, activeUntil, currentPeriodEnd: activeUntil });
}
