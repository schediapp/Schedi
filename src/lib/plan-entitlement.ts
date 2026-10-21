import type { Store } from "./db";
import type { Business, Plan, SubscriptionStatus } from "./types";
import { PLANS } from "./types";

export interface PlanFacts {
  plan?: string | null;
  subscriptionStatus?: string | null;
  complimentaryPro?: boolean | null;
  billingExempt?: boolean | null;
  stripeSubscriptionId?: string | null;
}

/** Firestore stores these on the private tenant doc. Either one is complimentary Pro. */
export function isComplimentaryPro(facts: PlanFacts | null | undefined): boolean {
  return !!(facts && (facts.complimentaryPro === true || facts.billingExempt === true));
}

/**
 * Card setup is open for complimentary Pro and for an active Pro subscription.
 * A Free SQLite row is not the decision when the Schedi tenant says otherwise.
 */
export function isCardPlanPro(facts: PlanFacts | null | undefined): boolean {
  if (!facts) return false;
  if (isComplimentaryPro(facts)) return true;
  const plan = String(facts.plan || "").toLowerCase();
  const status = String(facts.subscriptionStatus || "").toLowerCase();
  return plan === "pro" && (status === "active" || status === "trialing");
}

export function portalPlanPill(facts: PlanFacts | null | undefined): { title: string; monthlyCents: number } {
  if (isComplimentaryPro(facts)) return { title: "Complimentary Pro", monthlyCents: 0 };
  const plan = String(facts?.plan || "free").toLowerCase();
  const key: Plan = plan === "starter" || plan === "pro" ? plan : "free";
  return { title: PLANS[key].name, monthlyCents: PLANS[key].monthlyCents };
}

const STATUSES = new Set<SubscriptionStatus>([
  "none",
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
]);

export interface SchediPlanRecord {
  slug: string;
  name: string;
  ownerEmail: string;
  ownerName: string;
  plan: Plan;
  subscriptionStatus: SubscriptionStatus;
  complimentary: boolean;
  billingExempt: boolean;
  cardEntitled: boolean;
}

export function parseSchediPlan(value: unknown): SchediPlanRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.ok !== true && row.cardEntitled === undefined && row.plan === undefined) return null;
  const planRaw = String(row.plan || "free").toLowerCase();
  const plan: Plan = planRaw === "starter" || planRaw === "pro" ? planRaw : "free";
  const statusRaw = String(row.subscriptionStatus || "none").toLowerCase();
  const subscriptionStatus: SubscriptionStatus = STATUSES.has(statusRaw as SubscriptionStatus)
    ? (statusRaw as SubscriptionStatus)
    : "none";
  const complimentary = row.complimentary === true || row.complimentaryPro === true;
  const billingExempt = row.billingExempt === true;
  const cardEntitled = row.cardEntitled === true || isCardPlanPro({
    plan,
    subscriptionStatus,
    complimentaryPro: complimentary,
    billingExempt,
  });
  return {
    slug: String(row.slug || "").trim().toLowerCase(),
    name: String(row.name || "").trim(),
    ownerEmail: String(row.ownerEmail || "").trim().toLowerCase(),
    ownerName: String(row.ownerName || "").trim(),
    plan: cardEntitled ? "pro" : plan,
    subscriptionStatus: cardEntitled ? "active" : subscriptionStatus,
    complimentary,
    billingExempt,
    cardEntitled,
  };
}

/**
 * Copy a Schedi tenant plan onto the Connect business.
 * Complimentary and active Pro become Pro here. A paid Connect subscription is left in place
 * when Schedi does not confirm a plan. A revoked comp is written back.
 */
export function applySchediPlan(
  store: Store,
  business: Business,
  remote: SchediPlanRecord | null,
  ownerEmail: string,
): Business {
  if (!remote) return business;
  const email = ownerEmail.trim().toLowerCase();
  if (remote.ownerEmail && email && remote.ownerEmail !== email) return business;

  if (remote.cardEntitled) {
    return store.setPlanEntitlement(business.id, {
      plan: "pro",
      subscriptionStatus: "active",
      complimentaryPro: remote.complimentary || remote.billingExempt,
      billingExempt: remote.billingExempt,
      slug: remote.slug || undefined,
    });
  }

  if (business.stripeSubscriptionId && isCardPlanPro(business) && !isComplimentaryPro(business)) {
    return business;
  }

  return store.setPlanEntitlement(business.id, {
    plan: remote.plan,
    subscriptionStatus: remote.subscriptionStatus,
    complimentaryPro: false,
    billingExempt: false,
  });
}

const PLAN_URL = "https://schedi.app/billing/connect-plan";

/** Ask the Schedi worker for the Firestore plan, including the private comp flags. */
export async function fetchSchediPlan(query: { slug?: string; email?: string }): Promise<SchediPlanRecord | null> {
  const secret = String(process.env.SCHEDI_CONNECT_PAID_SECRET || "");
  if (!secret) return null;
  const slug = String(query.slug || "").trim();
  const email = String(query.email || "").trim().toLowerCase();
  if (!slug && !email) return null;
  try {
    const response = await fetch(process.env.SCHEDI_PLAN_URL || PLAN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-schedi-connect-secret": secret,
      },
      body: JSON.stringify({ slug, email }),
    });
    if (!response.ok) return null;
    return parseSchediPlan(await response.json());
  } catch {
    return null;
  }
}
