import { createHmac, timingSafeEqual } from "node:crypto";
import type { Store } from "./db";
import { SchediError } from "./errors";
import type { Business } from "./types";

export interface HandoffClaims {
  v: 1;
  slug: string;
  email: string;
  ownerName: string;
  businessName: string;
  complimentary: boolean;
  billingExempt: boolean;
  exp: number;
}

function b64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

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
  const exp = Number(row.exp);
  if (row.v !== 1) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,40})$/.test(slug)) return null;
  if (!email.includes("@") || email.length > 160) return null;
  if (!Number.isFinite(exp) || exp * 1000 < nowMs - 30_000) return null;
  if (exp * 1000 > nowMs + 15 * 60 * 1000) return null;
  return {
    v: 1,
    slug,
    email,
    ownerName: String(row.ownerName || "").trim().slice(0, 80),
    businessName: String(row.businessName || "").trim().slice(0, 80),
    complimentary: row.complimentary === true,
    billingExempt: row.billingExempt === true,
    exp,
  };
}

/** Open a Connect business for a signed Schedi handoff. Does not create a Stripe customer or subscription. */
export function adoptSchediBusiness(store: Store, claims: HandoffClaims): { ownerId: string; business: Business } {
  const email = claims.email.trim().toLowerCase();
  const slug = claims.slug.trim().toLowerCase();
  let owner = store.getOwnerByEmail(email);
  if (!owner) {
    const name = claims.ownerName || claims.businessName || "Owner";
    owner = store.createOwner({ email, name });
  }
  const bySlug = store.getBusinessBySlug(slug);
  if (bySlug && bySlug.ownerId !== owner.id) {
    throw new SchediError("This business is already set up for another owner.", 409);
  }
  let business = store.getBusinessByOwner(owner.id);
  if (!business) {
    business = store.createBusiness({
      ownerId: owner.id,
      name: claims.businessName || "Business",
      slug,
      plan: "pro",
      subscriptionStatus: "active",
    });
  }
  business = store.setPlanEntitlement(business.id, {
    plan: "pro",
    subscriptionStatus: "active",
    complimentaryPro: claims.complimentary || claims.billingExempt,
    billingExempt: claims.billingExempt,
    slug,
  });
  return { ownerId: owner.id, business };
}
