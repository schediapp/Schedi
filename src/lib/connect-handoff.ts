import { createHmac, timingSafeEqual } from "node:crypto";
import type { Store } from "./db";
import { SchediError } from "./errors";
import { applySchediPlan, type SchediPlanRecord } from "./plan-entitlement";
import type { Business } from "./types";

export interface HandoffClaims {
  v: 1;
  slug: string;
  email: string;
  ownerName: string;
  businessName: string;
  nonce: string;
  exp: number;
}

const HANDOFF_MAX_MS = 2 * 60 * 1000 + 30_000;

export function verifyConnectHandoff(token: string, secret: string, nowMs = Date.now()): HandoffClaims | null {
  const expected = String(secret || "");
  if (!expected) return null;
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const digest = createHmac("sha256", expected).update(parts[0]).digest();
  let given: Buffer;
  try {
    given = Buffer.from(parts[1], "base64url");
  } catch {
    return null;
  }
  if (given.length !== digest.length || !timingSafeEqual(given, digest)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  const slug = String(row.slug || "").trim().toLowerCase();
  const email = String(row.email || "").trim().toLowerCase();
  const nonce = String(row.nonce || "");
  const exp = Number(row.exp);
  if (row.v !== 1) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,40})$/.test(slug)) return null;
  if (!email.includes("@") || email.length > 160) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return null;
  if (!Number.isFinite(exp) || exp * 1000 < nowMs - 30_000) return null;
  if (exp * 1000 > nowMs + HANDOFF_MAX_MS) return null;
  return {
    v: 1,
    slug,
    email,
    ownerName: String(row.ownerName || "").trim().slice(0, 80),
    businessName: String(row.businessName || "").trim().slice(0, 80),
    nonce,
    exp,
  };
}

function planSlug(remote: SchediPlanRecord, fallback: string): string {
  const slug = remote.slug.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,40})$/.test(slug) ? slug : fallback;
}

const OWNERSHIP = "This Schedi sign-in could not be verified for this business. Nothing was charged.";

/**
 * Open a Connect business from a re-checked Schedi plan.
 * Does not create a Stripe customer, subscription, or connected account.
 * Card entitlement stays on the plan lookup. A Free or Starter row is not written as Pro.
 */
export function adoptSchediBusiness(
  store: Store,
  claims: HandoffClaims,
  remote: SchediPlanRecord,
): { ownerId: string; business: Business } {
  const email = claims.email.trim().toLowerCase();
  const remoteEmail = remote.ownerEmail.trim().toLowerCase();
  const slug = planSlug(remote, "");
  if (!remoteEmail.includes("@") || remoteEmail !== email || slug !== claims.slug) {
    throw new SchediError(OWNERSHIP, 403);
  }
  let owner = store.getOwnerByEmail(email);
  if (!owner) {
    const name = (claims.ownerName || remote.ownerName || "").trim();
    if (name.length < 2) throw new SchediError(OWNERSHIP, 403);
    owner = store.createOwner({ email, name });
  }
  const bySlug = store.getBusinessBySlug(slug);
  if (bySlug && bySlug.ownerId !== owner.id) {
    throw new SchediError("This business is already set up for another owner.", 409);
  }
  let business = store.getBusinessByOwner(owner.id);
  if (business && bySlug && business.id !== bySlug.id) {
    throw new SchediError(OWNERSHIP, 403);
  }
  if (!business) {
    business = store.createBusiness({
      ownerId: owner.id,
      name: remote.name || claims.businessName || "Business",
      slug,
      plan: remote.plan,
      subscriptionStatus: remote.subscriptionStatus,
    });
  }
  business = applySchediPlan(store, business, remote, email);
  if (business.slug !== slug) {
    const taken = store.getBusinessBySlug(slug);
    if (taken && taken.id !== business.id) throw new SchediError(OWNERSHIP, 403);
    business = store.setPlanEntitlement(business.id, {
      plan: business.plan,
      subscriptionStatus: business.subscriptionStatus,
      complimentaryPro: business.complimentaryPro === true,
      billingExempt: business.billingExempt === true,
      slug,
    });
  }
  return { ownerId: owner.id, business };
}

export type HandoffLookup = (query: { slug: string; email: string }) => Promise<SchediPlanRecord | null>;

export type ConnectHandoffResult =
  | { ok: true; ownerId: string; business: Business }
  | { ok: false; error: string };

const INVALID_LINK = "This Schedi link is not valid. Nothing was charged.";
const USED_LINK = "This Schedi link was already used. Nothing was charged.";

/**
 * Verify the link, burn its nonce, then accept the plan only from lookup.
 * Lookup is /billing/connect-plan in production. Claims in the token do not grant Pro.
 */
export async function acceptConnectHandoff(
  store: Store,
  token: string,
  secret: string,
  lookup: HandoffLookup,
  nowMs = Date.now(),
): Promise<ConnectHandoffResult> {
  const claims = verifyConnectHandoff(token, secret, nowMs);
  if (!claims) return { ok: false, error: INVALID_LINK };
  const consumed = store.consumeConnectHandoff(claims.nonce, claims.exp * 1000, nowMs);
  if (consumed === "reused") return { ok: false, error: USED_LINK };
  if (consumed !== "ok") return { ok: false, error: INVALID_LINK };

  let remote: SchediPlanRecord | null = null;
  try {
    remote = await lookup({ slug: claims.slug, email: claims.email });
  } catch {
    remote = null;
  }
  const remoteEmail = remote?.ownerEmail.trim().toLowerCase() || "";
  if (!remote || remoteEmail !== claims.email || remote.slug.trim().toLowerCase() !== claims.slug) {
    return { ok: false, error: OWNERSHIP };
  }
  try {
    const adopted = adoptSchediBusiness(store, claims, remote);
    return { ok: true, ownerId: adopted.ownerId, business: adopted.business };
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : INVALID_LINK;
    return { ok: false, error: message };
  }
}
