import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startOwnerSubscription } from "../src/lib/billing";
import { adoptSchediBusiness, verifyConnectHandoff } from "../src/lib/connect-handoff";
import { enableCardPayments } from "../src/lib/connect";
import { applySchediPlan, isCardPlanPro, isComplimentaryPro, parseSchediPlan, portalPlanPill } from "../src/lib/plan-entitlement";
import { isCardCheckoutReady } from "../src/lib/readiness";
import { createFakeStripe, memoryStore, seedProBusiness } from "./helpers";
// @ts-expect-error plain JS worker module
import {
  connectCardEntitled,
  connectPlanView,
  handleConnectHandoff,
  handleConnectPlan,
  signConnectHandoff,
} from "../workers/schedi-email-worker/src/connect-handoff.js";

const SECRET = "connect-test-secret";
const portal = readFileSync(new URL("../src/app/portal/page.tsx", import.meta.url), "utf8");
const worker = readFileSync(new URL("../workers/schedi-email-worker/src/index.js", import.meta.url), "utf8");

function axel(overrides: Record<string, unknown> = {}) {
  return {
    id: "axeldelcidphotography",
    slug: "axeldelcidphotography",
    name: "Axel Del Cid Photography",
    ownerName: "Axel Del Cid",
    ownerEmail: "axel@example.com",
    plan: "free",
    subscriptionStatus: "none",
    complimentaryPro: true,
    stripeCustomerId: "cus_should_not_leak",
    ...overrides,
  };
}

describe("complimentary Pro counts as Pro for card setup", () => {
  it("treats a comp flag or an active Pro subscription as Pro, and leaves Free and paused Pro out", () => {
    expect(connectCardEntitled(axel())).toBe(true);
    expect(connectCardEntitled({ plan: "starter", billingExempt: true })).toBe(true);
    expect(connectCardEntitled({ plan: "pro", subscriptionStatus: "active" })).toBe(true);
    expect(connectCardEntitled({ plan: "pro", subscriptionStatus: "trialing" })).toBe(true);
    expect(connectCardEntitled({ plan: "pro", subscriptionStatus: "past_due" })).toBe(false);
    expect(connectCardEntitled({ plan: "free", subscriptionStatus: "none" })).toBe(false);
    expect(connectCardEntitled({ plan: "starter", subscriptionStatus: "active" })).toBe(false);
    expect(isCardPlanPro({ plan: "free", complimentaryPro: true })).toBe(true);
    expect(isComplimentaryPro({ billingExempt: true })).toBe(true);
    expect(portalPlanPill({ plan: "free", complimentaryPro: true })).toEqual({ title: "Complimentary Pro", monthlyCents: 0 });
    expect(portalPlanPill({ plan: "pro", subscriptionStatus: "active" })).toEqual({ title: "Pro", monthlyCents: 4900 });
    expect(portalPlanPill({ plan: "free" })).toEqual({ title: "Free", monthlyCents: 0 });
    expect(isCardCheckoutReady({
      plan: "free",
      subscriptionStatus: "none",
      complimentaryPro: true,
      cardPaymentsStatus: "active",
    })).toBe(true);
    expect(isCardCheckoutReady({
      plan: "free",
      subscriptionStatus: "none",
      complimentaryPro: true,
      cardPaymentsStatus: "pending",
    })).toBe(false);
  });

  it("mints a Connect onboarding link for comped Pro and refuses a Free plan without calling Stripe", async () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    const comp = await handleConnectHandoff(new Request("https://schedi.app/billing/connect-handoff", {
      method: "POST",
      body: JSON.stringify({ tenantId: "axeldelcidphotography", session: "owner-session" }),
    }), { SCHEDI_CONNECT_PAID_SECRET: SECRET }, {
      now: () => now,
      sessionAllows: async (session: string, tenantId: string) => session === "owner-session" && tenantId === "axeldelcidphotography",
      loadTenant: async () => axel(),
    });
    expect(comp.status).toBe(200);
    const url = new URL(String(comp.body.url));
    expect(url.origin + url.pathname).toBe("https://schedi-connect-production.up.railway.app/api/connect/handoff");
    expect(comp.body.url).not.toContain("checkout.stripe.com");
    expect(JSON.stringify(comp.body)).not.toContain("cus_should_not_leak");
    const claims = verifyConnectHandoff(url.searchParams.get("t") || "", SECRET, now);
    expect(claims).toMatchObject({
      slug: "axeldelcidphotography",
      email: "axel@example.com",
      complimentary: true,
      billingExempt: false,
    });

    const active = await handleConnectHandoff(new Request("https://schedi.app/billing/connect-handoff", {
      method: "POST",
      body: JSON.stringify({ tenantId: "axeldelcidphotography", session: "owner-session" }),
    }), { SCHEDI_CONNECT_PAID_SECRET: SECRET }, {
      now: () => now,
      sessionAllows: async () => true,
      loadTenant: async () => axel({ complimentaryPro: false, plan: "pro", subscriptionStatus: "active" }),
    });
    expect(active.status).toBe(200);

    const exempt = await handleConnectHandoff(new Request("https://schedi.app/billing/connect-handoff", {
      method: "POST",
      body: JSON.stringify({ tenantId: "axeldelcidphotography", session: "owner-session" }),
    }), { SCHEDI_CONNECT_PAID_SECRET: SECRET }, {
      now: () => now,
      sessionAllows: async () => true,
      loadTenant: async () => axel({ complimentaryPro: false, billingExempt: true, plan: "starter" }),
    });
    expect(exempt.status).toBe(200);

    const free = await handleConnectHandoff(new Request("https://schedi.app/billing/connect-handoff", {
      method: "POST",
      body: JSON.stringify({ tenantId: "axeldelcidphotography", session: "owner-session" }),
    }), { SCHEDI_CONNECT_PAID_SECRET: SECRET }, {
      sessionAllows: async () => true,
      loadTenant: async () => axel({ complimentaryPro: false, plan: "free", subscriptionStatus: "none" }),
    });
    expect(free).toEqual({ status: 403, body: { ok: false, error: "pro_required" } });

    const paused = await handleConnectHandoff(new Request("https://schedi.app/billing/connect-handoff", {
      method: "POST",
      body: JSON.stringify({ tenantId: "axeldelcidphotography", session: "owner-session" }),
    }), { SCHEDI_CONNECT_PAID_SECRET: SECRET }, {
      sessionAllows: async () => true,
      loadTenant: async () => axel({ complimentaryPro: false, plan: "pro", subscriptionStatus: "past_due" }),
    });
    expect(paused.status).toBe(403);

    const signedOut = await handleConnectHandoff(new Request("https://schedi.app/billing/connect-handoff", {
      method: "POST",
      body: JSON.stringify({ tenantId: "axeldelcidphotography" }),
    }), { SCHEDI_CONNECT_PAID_SECRET: SECRET }, {
      sessionAllows: async () => false,
      loadTenant: async () => axel(),
    });
    expect(signedOut.status).toBe(401);
  });

  it("rejects a tampered or expired handoff", async () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    const token = await signConnectHandoff({
      v: 1,
      slug: "axeldelcidphotography",
      email: "axel@example.com",
      ownerName: "Axel",
      businessName: "Axel Del Cid Photography",
      complimentary: true,
      billingExempt: false,
      exp: Math.floor(now / 1000) + 60,
    }, SECRET);
    expect(verifyConnectHandoff(token, SECRET, now)?.complimentary).toBe(true);
    expect(verifyConnectHandoff(token.slice(0, -2) + "aa", SECRET, now)).toBeNull();
    expect(verifyConnectHandoff(token, "other-secret", now)).toBeNull();
    expect(verifyConnectHandoff(token, SECRET, now + 20 * 60 * 1000)).toBeNull();
  });

  it("turns a Free Connect row into Pro and opens Stripe Connect without a subscription checkout", async () => {
    const store = memoryStore();
    const { owner, business } = seedProBusiness(store, {
      email: "axel@example.com",
      name: "Axel Del Cid Photography",
      slug: "free-axel",
      plan: "free",
      subscriptionStatus: "none",
      stripeAccountId: null,
      stripeSubscriptionId: null,
      cardPaymentsStatus: null,
      payoutsStatus: null,
    });
    const now = Date.parse("2026-10-21T12:00:00Z");
    const token = await signConnectHandoff({
      v: 1,
      slug: "axeldelcidphotography",
      email: "axel@example.com",
      ownerName: "Axel Del Cid",
      businessName: "Axel Del Cid Photography",
      complimentary: true,
      billingExempt: false,
      exp: Math.floor(now / 1000) + 600,
    }, SECRET);
    const claims = verifyConnectHandoff(token, SECRET, now);
    expect(claims).toBeTruthy();
    const adopted = adoptSchediBusiness(store, claims!);
    expect(adopted.ownerId).toBe(owner.id);
    expect(adopted.business.id).toBe(business.id);
    expect(adopted.business.slug).toBe("axeldelcidphotography");
    expect(adopted.business.plan).toBe("pro");
    expect(adopted.business.subscriptionStatus).toBe("active");
    expect(adopted.business.complimentaryPro).toBe(true);
    expect(adopted.business.stripeSubscriptionId).toBeNull();
    expect(store.getOwner(owner.id).stripeCustomerId).toBeNull();

    const stripe = createFakeStripe();
    const result = await enableCardPayments(store, stripe, owner.id);
    expect(result).toEqual({ accountId: "acct_created", created: true });
    expect(stripe.calls.map((call) => call.method)).toEqual(["accounts.create"]);
    expect(stripe.calls.some((call) => call.method === "checkout.sessions.create")).toBe(false);
  });

  it("does not open a $49 subscription checkout for complimentary Pro", async () => {
    const store = memoryStore();
    const { owner, business } = seedProBusiness(store, {
      plan: "free",
      subscriptionStatus: "none",
      stripeAccountId: null,
      stripeSubscriptionId: null,
    });
    store.setPlanEntitlement(business.id, {
      plan: "free",
      subscriptionStatus: "none",
      complimentaryPro: true,
      billingExempt: false,
    });
    const stripe = createFakeStripe();
    await expect(startOwnerSubscription(store, stripe, owner.id, "pro", {
      success: "https://schedi.test/portal?session_id={CHECKOUT_SESSION_ID}",
      cancel: "https://schedi.test/portal",
    })).rejects.toThrow(/Nothing was charged/);
    expect(stripe.calls).toEqual([]);
  });

  it("applies a Firestore comp plan onto a Free row and leaves a paid Connect subscription alone", () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store, {
      email: "axel@example.com",
      slug: "free-axel",
      plan: "free",
      subscriptionStatus: "none",
      stripeSubscriptionId: null,
    });
    const remote = parseSchediPlan({ ok: true, ...connectPlanView(axel()) });
    const upgraded = applySchediPlan(store, business, remote, "axel@example.com");
    expect(upgraded.plan).toBe("pro");
    expect(upgraded.complimentaryPro).toBe(true);
    expect(upgraded.slug).toBe("axeldelcidphotography");
    expect(upgraded.stripeSubscriptionId).toBeNull();

    const paid = seedProBusiness(store, {
      email: "paid@example.com",
      slug: "paid-studio",
      plan: "pro",
      subscriptionStatus: "active",
      stripeSubscriptionId: "sub_paid",
    });
    const kept = applySchediPlan(store, paid.business, parseSchediPlan({
      ok: true,
      slug: "paid-studio",
      ownerEmail: "paid@example.com",
      plan: "free",
      subscriptionStatus: "none",
      cardEntitled: false,
    }), "paid@example.com");
    expect(kept.plan).toBe("pro");
    expect(kept.stripeSubscriptionId).toBe("sub_paid");
    expect(kept.complimentaryPro).toBe(false);
  });

  it("answers the Connect plan lookup from the private comp flag and hides Stripe ids", async () => {
    const ok = await handleConnectPlan(new Request("https://schedi.app/billing/connect-plan", {
      method: "POST",
      headers: { "x-schedi-connect-secret": SECRET },
      body: JSON.stringify({ slug: "wrong-slug", email: "axel@example.com" }),
    }), { SCHEDI_CONNECT_PAID_SECRET: SECRET }, {
      loadBySlug: async () => axel({ id: "someone-else", slug: "someone-else", ownerEmail: "other@example.com", complimentaryPro: false, plan: "free" }),
      loadByEmail: async () => axel(),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      ok: true,
      slug: "axeldelcidphotography",
      cardEntitled: true,
      complimentary: true,
      plan: "pro",
      subscriptionStatus: "active",
    });
    expect(JSON.stringify(ok.body)).not.toContain("cus_should_not_leak");

    const denied = await handleConnectPlan(new Request("https://schedi.app/billing/connect-plan", {
      method: "POST",
      headers: { "x-schedi-connect-secret": "nope" },
      body: JSON.stringify({ email: "axel@example.com" }),
    }), { SCHEDI_CONNECT_PAID_SECRET: SECRET }, {
      loadBySlug: async () => axel(),
      loadByEmail: async () => axel(),
    });
    expect(denied.status).toBe(401);
  });

  it("keeps the Railway portal from deciding Pro with only its own plan column", () => {
    expect(portal).toContain("isCardPlanPro");
    expect(portal).toContain("fetchSchediPlan");
    expect(portal).not.toContain('business.plan !== "pro" || business.subscriptionStatus !== "active"');
    expect(worker).toContain("path === '/billing/connect-handoff'");
    expect(worker).toContain("path === '/billing/connect-plan'");
  });
});
