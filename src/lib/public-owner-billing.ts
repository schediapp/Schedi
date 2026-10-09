import {
  OWNER_SUBSCRIPTION_POLICY_SHORT,
  subscriptionPeriodEndIso,
  type SubscriptionPeriodSource,
} from "./subscription-policy";

/** Stripe Checkout custom_text.submit.message limit. */
export const STRIPE_CHECKOUT_SUBMIT_MESSAGE_MAX = 1200;

/**
 * Text shown on the Stripe-hosted subscribe button before the card is charged.
 * Same short policy as the signup and portal screens.
 */
export function ownerCheckoutCustomText(): { submit: { message: string } } {
  return { submit: { message: OWNER_SUBSCRIPTION_POLICY_SHORT } };
}

/** Form body used by the public billing worker, which posts Checkout sessions as URLSearchParams. */
export function appendOwnerCheckoutPolicy(params: URLSearchParams): void {
  params.set("custom_text[submit][message]", OWNER_SUBSCRIPTION_POLICY_SHORT);
}

export function safePublicTenantId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return "";
  return id;
}

export interface PublicBillingTenant {
  complimentaryPro?: boolean;
  billingExempt?: boolean;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
}

export interface StripeSubscriptionRecord extends SubscriptionPeriodSource {
  id?: string;
  customer?: string | { id?: string } | null;
  status?: string;
}

export interface StripeFormResult {
  ok: boolean;
  status: number;
  data?: StripeSubscriptionRecord;
  error?: string;
}

/**
 * Same gate as the live worker's billingSessionAllows: an agency session may
 * manage any tenant; an owner session may manage only its own tenant id.
 */
export interface PublicBillingDeps {
  sessionAllows(session: unknown, tenantId: string): Promise<boolean>;
  loadTenant(tenantId: string): Promise<PublicBillingTenant | null>;
  stripeForm(path: string, init?: { method?: string; params?: URLSearchParams }): Promise<StripeFormResult>;
  saveSchedule?(tenantId: string, patch: { cancelAtPeriodEnd: boolean; currentPeriodEnd: string }): Promise<void>;
}

export interface BillingHttpResult {
  status: number;
  body: Record<string, unknown>;
}

const CANCEL_PATH = "/billing/cancel";
const RESUME_PATH = "/billing/resume";

export function ownerBillingScheduleAction(path: string): "cancel" | "resume" | null {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized === CANCEL_PATH) return "cancel";
  if (normalized === RESUME_PATH) return "resume";
  return null;
}

function customerIdOf(data: StripeSubscriptionRecord | undefined): string {
  const customer = data?.customer;
  if (typeof customer === "string") return customer;
  if (customer && typeof customer === "object" && typeof customer.id === "string") return customer.id;
  return "";
}

function http(status: number, body: Record<string, unknown>): BillingHttpResult {
  return { status, body };
}

async function readJson(request: Request): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false }> {
  try {
    const data = JSON.parse((await request.text()) || "{}") as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false };
    return { ok: true, data: data as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/**
 * POST /billing/cancel and POST /billing/resume for the public SPA.
 *
 * Live `/billing/*` is served by Cloudflare Worker `schedi-email-worker`, which
 * is not in this repository. Call this from that worker's handleBillingRequest
 * before the not_found response. Auth matches /billing/checkout: the session is
 * checked before the tenant is loaded. Cancellation sets cancel_at_period_end
 * and does not delete the subscription. The SPA reads `activeUntil`.
 */
export async function handleOwnerBillingSchedule(
  request: Request,
  path: string,
  deps: PublicBillingDeps,
): Promise<BillingHttpResult | null> {
  const action = ownerBillingScheduleAction(path);
  if (!action) return null;
  if (request.method !== "POST") return http(405, { ok: false, error: "method_not_allowed" });

  const parsed = await readJson(request);
  if (!parsed.ok) return http(400, { ok: false, error: "invalid_json" });

  const tenantId = safePublicTenantId(parsed.data.tenantId ?? parsed.data.tenant_id);
  if (!tenantId) return http(400, { ok: false, error: "invalid_tenant" });

  let allowed = false;
  try {
    allowed = await deps.sessionAllows(parsed.data.session, tenantId);
  } catch {
    allowed = false;
  }
  if (!allowed) return http(401, { ok: false, error: "session_required" });

  let tenant: PublicBillingTenant | null;
  try {
    tenant = await deps.loadTenant(tenantId);
  } catch {
    return http(502, { ok: false, error: "tenant_lookup_failed" });
  }
  if (!tenant) return http(404, { ok: false, error: "tenant_not_found" });
  if (tenant.complimentaryPro === true || tenant.billingExempt === true) {
    return http(400, { ok: false, error: "complimentary_no_charge" });
  }

  const subscriptionId = String(tenant.stripeSubscriptionId || "").trim();
  if (!subscriptionId) return http(409, { ok: false, error: "no_subscription" });

  const current = await deps.stripeForm(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "GET" });
  if (!current.ok || !current.data) {
    if (current.status === 404) return http(409, { ok: false, error: "no_subscription" });
    return http(502, { ok: false, error: "subscription_lookup_failed" });
  }

  const storedCustomer = String(tenant.stripeCustomerId || "").trim();
  const liveCustomer = customerIdOf(current.data);
  if (storedCustomer && liveCustomer && storedCustomer !== liveCustomer) {
    return http(409, { ok: false, error: "customer_mismatch" });
  }
  if (action === "resume" && current.data.cancel_at_period_end !== true) {
    return http(409, { ok: false, error: "not_scheduled" });
  }

  const params = new URLSearchParams();
  params.set("cancel_at_period_end", action === "cancel" ? "true" : "false");
  const updated = await deps.stripeForm(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "POST",
    params,
  });
  if (!updated.ok || !updated.data) return http(502, { ok: false, error: "subscription_update_failed" });

  const activeUntil = subscriptionPeriodEndIso(updated.data);
  const cancelAtPeriodEnd = action === "cancel";
  if (deps.saveSchedule) {
    try {
      await deps.saveSchedule(tenantId, {
        cancelAtPeriodEnd,
        currentPeriodEnd: cancelAtPeriodEnd ? activeUntil || "" : "",
      });
    } catch {
      // Stripe already recorded the schedule. Still return the period end to the SPA.
    }
  }

  return http(200, {
    ok: true,
    activeUntil: cancelAtPeriodEnd ? activeUntil : null,
    currentPeriodEnd: cancelAtPeriodEnd ? activeUntil : null,
    cancelAtPeriodEnd,
  });
}
