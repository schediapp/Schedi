/**
 * Schedi.app "Set up Stripe" hands the signed-in owner to the Connect app.
 * The token only names the business. Plan flags stay out of it. Connect
 * re-reads /billing/connect-plan when the link is opened. The token sits in
 * the URL fragment so Railway's request log does not record it.
 */

export const CONNECT_APP_ORIGIN = "https://schedi-connect-production.up.railway.app";
const HANDOFF_TTL_SECONDS = 2 * 60;

export function connectCardEntitled(tenant) {
  if (!tenant || typeof tenant !== "object") return false;
  if (tenant.complimentaryPro === true || tenant.billingExempt === true) return true;
  const plan = String(tenant.plan || "").toLowerCase();
  const status = String(tenant.subscriptionStatus || "").toLowerCase();
  return plan === "pro" && (status === "active" || status === "trialing");
}

export function connectPlanView(tenant) {
  const entitled = connectCardEntitled(tenant);
  const stored = String((tenant && tenant.plan) || "").toLowerCase();
  const plan = stored === "starter" || stored === "pro" || stored === "free" ? stored : "free";
  const status = String((tenant && tenant.subscriptionStatus) || "none");
  return {
    slug: String((tenant && (tenant.slug || tenant.id)) || "").trim().toLowerCase(),
    name: String((tenant && tenant.name) || "").trim(),
    ownerEmail: String((tenant && tenant.ownerEmail) || "").trim().toLowerCase(),
    ownerName: String((tenant && (tenant.ownerName || tenant.name)) || "").trim(),
    plan: entitled ? "pro" : plan,
    subscriptionStatus: entitled ? "active" : status,
    complimentary: !!(tenant && tenant.complimentaryPro === true),
    billingExempt: !!(tenant && tenant.billingExempt === true),
    cardEntitled: entitled,
  };
}

function bytesToB64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToB64Url(bytes);
}

async function signPayload(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToB64Url(new Uint8Array(sig));
}

export async function signConnectHandoff(claims, secret) {
  const payload = bytesToB64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await signPayload(secret, payload);
  return payload + "." + sig;
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  let out = 0;
  for (let i = 0; i < left.byteLength; i++) out |= left[i] ^ right[i];
  return out === 0;
}

function http(status, body) {
  return { status, body };
}

async function readJson(request) {
  try {
    const data = JSON.parse((await request.text()) || "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function handleConnectHandoff(request, env, deps) {
  if (request.method !== "POST") return http(405, { ok: false, error: "method_not_allowed" });
  const secret = String((env && env.SCHEDI_CONNECT_PAID_SECRET) || "");
  if (!secret) return http(503, { ok: false, error: "connect_not_configured" });
  const data = await readJson(request);
  if (!data) return http(400, { ok: false, error: "invalid_json" });
  const tenantId = String(data.tenantId || data.tenant_id || "").trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(tenantId)) return http(400, { ok: false, error: "invalid_tenant" });

  let allowed = false;
  try {
    allowed = await deps.sessionAllows(data.session, tenantId);
  } catch {
    allowed = false;
  }
  if (allowed === "forbidden") return http(403, { ok: false, error: "forbidden" });
  if (allowed !== true) return http(401, { ok: false, error: "session_required" });

  let tenant = null;
  try {
    tenant = await deps.loadTenant(tenantId);
  } catch {
    return http(502, { ok: false, error: "tenant_lookup_failed" });
  }
  if (!tenant) return http(404, { ok: false, error: "tenant_not_found" });
  if (tenant.__privateLoadFailed) return http(502, { ok: false, error: "private_read_failed" });
  if (!connectCardEntitled(tenant)) return http(403, { ok: false, error: "pro_required" });

  const view = connectPlanView(tenant);
  if (!view.ownerEmail || view.ownerEmail.indexOf("@") < 1) return http(400, { ok: false, error: "owner_email_missing" });
  if (!/^[a-z0-9](?:[a-z0-9-]{0,40})$/.test(view.slug)) return http(400, { ok: false, error: "invalid_tenant" });

  const now = typeof deps.now === "function" ? deps.now() : Date.now();
  const claims = {
    v: 1,
    slug: view.slug,
    email: view.ownerEmail,
    ownerName: view.ownerName.slice(0, 80),
    businessName: view.name.slice(0, 80),
    nonce: randomNonce(),
    exp: Math.floor(now / 1000) + HANDOFF_TTL_SECONDS,
  };
  const token = await signConnectHandoff(claims, secret);
  return http(200, {
    ok: true,
    url: CONNECT_APP_ORIGIN + "/api/connect/handoff#t=" + encodeURIComponent(token),
  });
}

export async function handleConnectPlan(request, env, deps) {
  if (request.method !== "POST") return http(405, { ok: false, error: "method_not_allowed" });
  const expected = String((env && env.SCHEDI_CONNECT_PAID_SECRET) || "");
  const header = String(request.headers.get("x-schedi-connect-secret") || "");
  if (!expected || !timingSafeEqual(expected, header)) return http(401, { ok: false, error: "unauthorized" });
  const data = await readJson(request);
  if (!data) return http(400, { ok: false, error: "invalid_json" });
  const slug = String(data.slug || "").trim();
  const email = String(data.email || "").trim().toLowerCase();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(slug)) return http(400, { ok: false, error: "invalid_tenant" });

  let tenant = null;
  try {
    tenant = await deps.loadBySlug(slug);
  } catch {
    return http(502, { ok: false, error: "tenant_lookup_failed" });
  }
  if (!tenant) return http(404, { ok: false, error: "tenant_not_found" });
  if (tenant.__privateLoadFailed) return http(502, { ok: false, error: "private_read_failed" });
  const view = connectPlanView(tenant);
  if (!view.ownerEmail || view.ownerEmail.indexOf("@") < 1) {
    return http(409, { ok: false, error: "owner_email_missing" });
  }
  if (email && view.ownerEmail !== email) return http(404, { ok: false, error: "tenant_not_found" });
  return http(200, { ok: true, ...view });
}
