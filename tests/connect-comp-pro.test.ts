import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startOwnerSubscription } from "../src/lib/billing";
import { acceptConnectHandoff, verifyConnectHandoff } from "../src/lib/connect-handoff";
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
const handoffRoute = readFileSync(new URL("../src/app/api/connect/handoff/route.ts", import.meta.url), "utf8");
const NONCE = "nonce-axel-handoff-once";

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

function handoffClaims(now: number, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    slug: "axeldelcidphotography",
    email: "axel@example.com",
    ownerName: "Axel Del Cid",
    businessName: "Axel Del Cid Photography",
    nonce: NONCE,
    exp: Math.floor(now / 1000) + 90,
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

  it("mints a one-time Connect link in the URL fragment and refuses a Free plan without calling Stripe", async () => {
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
    expect(url.search).toBe("");
    expect(url.hash.startsWith("#t=")).toBe(true);
    expect(comp.body.url).not.toContain("checkout.stripe.com");
    expect(comp.body.url).not.toContain("?t=");
    expect(JSON.stringify(comp.body)).not.toContain("cus_should_not_leak");
    const claims = verifyConnectHandoff(decodeURIComponent(url.hash.slice(3)), SECRET, now);
    expect(claims).toMatchObject({
      slug: "axeldelcidphotography",
      email: "axel@example.com",
    });
    expect(claims?.nonce.length).toBeGreaterThan(16);
    expect(claims).not.toHaveProperty("complimentary");
    expect(claims).not.toHaveProperty("billingExempt");
    const ttl = (claims?.exp || 0) - Math.floor(now / 1000);
    expect(ttl).toBeGreaterThan(90);
    expect(ttl).toBeLessThanOrEqual(120);

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

    const privateDown = await handleConnectHandoff(new Request("https://schedi.app/billing/connect-handoff", {
      method: "POST",
      body: JSON.stringify({ tenantId: "axeldelcidphotography", session: "owner-session" }),
    }), { SCHEDI_CONNECT_PAID_SECRET: SECRET }, {
      sessionAllows: async () => true,
      loadTenant: async () => axel({ __privateLoadFailed: true }),
    });
    expect(privateDown).toEqual({ status: 502, body: { ok: false, error: "private_read_failed" } });
  });

  it("rejects a tampered, reused, or long-lived handoff", async () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    const token = await signConnectHandoff(handoffClaims(now), SECRET);
    expect(verifyConnectHandoff(token, SECRET, now)?.email).toBe("axel@example.com");
    expect(verifyConnectHandoff(token.slice(0, -2) + "aa", SECRET, now)).toBeNull();
    expect(verifyConnectHandoff(token, "other-secret", now)).toBeNull();
    expect(verifyConnectHandoff(token, SECRET, now + 20 * 60 * 1000)).toBeNull();

    const tenMinutes = await signConnectHandoff(handoffClaims(now, {
      nonce: "nonce-ten-minute-link",
      exp: Math.floor(now / 1000) + 600,
    }), SECRET);
    expect(verifyConnectHandoff(tenMinutes, SECRET, now)).toBeNull();

    const claimed = await signConnectHandoff(handoffClaims(now, {
      nonce: "nonce-claims-are-not-a-plan",
      complimentary: true,
      billingExempt: true,
    }), SECRET);
    const parsed = verifyConnectHandoff(claimed, SECRET, now);
    expect(parsed).not.toHaveProperty("complimentary");
    expect(parsed).not.toHaveProperty("billingExempt");

    const store = memoryStore();
    const exp = now + 60_000;
    expect(store.consumeConnectHandoff(NONCE, exp, now)).toBe("ok");
    expect(store.consumeConnectHandoff(NONCE, exp, now)).toBe("reused");
    expect(store.consumeConnectHandoff("short", exp, now)).toBe("invalid");
    expect(store.consumeConnectHandoff("nonce-already-expired", now - 60_000, now)).toBe("expired");
  });

  it("turns a Free Connect row into Pro only after the plan lookup, and a second open is refused", async () => {
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
    const token = await signConnectHandoff(handoffClaims(now, { complimentary: true }), SECRET);
    const remote = parseSchediPlan({ ok: true, ...connectPlanView(axel()) });
    const adopted = await acceptConnectHandoff(store, token, SECRET, async () => remote, now);
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.ownerId).toBe(owner.id);
    expect(adopted.business.id).toBe(business.id);
    expect(adopted.business.slug).toBe("axeldelcidphotography");
    expect(adopted.business.plan).toBe("pro");
    expect(adopted.business.subscriptionStatus).toBe("active");
    expect(adopted.business.complimentaryPro).toBe(true);
    expect(adopted.business.stripeSubscriptionId).toBeNull();
    expect(store.getOwner(owner.id).stripeCustomerId).toBeNull();

    const again = await acceptConnectHandoff(store, token, SECRET, async () => remote, now);
    expect(again).toMatchObject({ ok: false });
    if (again.ok) return;
    expect(again.error).toMatch(/already used/);

    const stripe = createFakeStripe();
    const result = await enableCardPayments(store, stripe, owner.id);
    expect(result).toEqual({ accountId: "acct_created", created: true });
    expect(stripe.calls.map((call) => call.method)).toEqual(["accounts.create"]);
    expect(stripe.calls.some((call) => call.method === "checkout.sessions.create")).toBe(false);
  });

  it("ignores a complimentary flag in the link when the plan lookup says Free", async () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store, {
      email: "axel@example.com",
      slug: "free-axel",
      plan: "free",
      subscriptionStatus: "none",
      stripeSubscriptionId: null,
    });
    const now = Date.parse("2026-10-21T12:00:00Z");
    const token = await signConnectHandoff(handoffClaims(now, {
      nonce: "nonce-free-lookup-wins",
      complimentary: true,
      billingExempt: true,
    }), SECRET);
    const freeRemote = parseSchediPlan({
      ok: true,
      ...connectPlanView(axel({ complimentaryPro: false, billingExempt: false, plan: "free", subscriptionStatus: "none" })),
    });
    const first = await acceptConnectHandoff(store, token, SECRET, async () => freeRemote, now);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error).toMatch(/active Pro subscription/);
    expect(store.getBusiness(business.id).plan).toBe("free");
    expect(store.getBusiness(business.id).slug).toBe("free-axel");
    expect(store.getBusiness(business.id).complimentaryPro).toBe(false);

    const second = await acceptConnectHandoff(store, token, SECRET, async () => freeRemote, now);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/already used/);
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

  it("does not grant or revoke a plan when the remote owner email is missing", () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store, {
      email: "axel@example.com",
      slug: "free-axel",
      plan: "free",
      subscriptionStatus: "none",
      stripeSubscriptionId: null,
    });
    store.setPlanEntitlement(business.id, {
      plan: "pro",
      subscriptionStatus: "active",
      complimentaryPro: true,
      billingExempt: false,
    });
    const comped = store.getBusiness(business.id);
    const emptyRevoke = applySchediPlan(store, comped, parseSchediPlan({
      ok: true,
      slug: "stolen-slug",
      ownerEmail: "",
      plan: "free",
      subscriptionStatus: "none",
      cardEntitled: false,
    }), "axel@example.com");
    expect(emptyRevoke.plan).toBe("pro");
    expect(emptyRevoke.complimentaryPro).toBe(true);
    expect(emptyRevoke.slug).toBe("free-axel");

    const emptyGrant = applySchediPlan(store, emptyRevoke, parseSchediPlan({
      ok: true,
      slug: "stolen-slug",
      ownerEmail: "",
      plan: "pro",
      subscriptionStatus: "active",
      complimentary: true,
      cardEntitled: true,
    }), "axel@example.com");
    expect(emptyGrant.slug).toBe("free-axel");
    expect(emptyGrant.stripeSubscriptionId).toBeNull();

    const revoked = applySchediPlan(store, emptyGrant, parseSchediPlan({
      ok: true,
      slug: "free-axel",
      ownerEmail: "axel@example.com",
      plan: "free",
      subscriptionStatus: "none",
      cardEntitled: false,
    }), "axel@example.com");
    expect(revoked.plan).toBe("free");
    expect(revoked.complimentaryPro).toBe(false);
    expect(revoked.slug).toBe("free-axel");
  });

  it("answers the Connect plan lookup from the slug and errors when the private read or owner email is missing", async () => {
    const ok = await handleConnectPlan(new Request("https://schedi.app/billing/connect-plan", {
      method: "POST",
      headers: { "x-schedi-connect-secret": SECRET },
      body: JSON.stringify({ slug: "axeldelcidphotography", email: "axel@example.com" }),
    }), { SCHEDI_CONNECT_PAID_SECRET: SECRET }, {
      loadBySlug: async () => axel(),
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

    let scanned = false;
    const wrongEmail = await handleConnectPlan(new Request("https://schedi.app/billing/connect-plan", {
      method: "POST",
      headers: { "x-schedi-connect-secret": SECRET },
      body: JSON.stringify({ slug: "someone-else", email: "axel@example.com" }),
    }), { SCHEDI_CONNECT_PAID_SECRET: SECRET }, {
      loadBySlug: async () => axel({ id: "someone-else", slug: "someone-else", ownerEmail: "other@example.com", complimentaryPro: false, plan: "free" }),
      loadByEmail: async () => {
        scanned = true;
        return axel();
      },
    });
    expect(wrongEmail).toEqual({ status: 404, body: { ok: false, error: "tenant_not_found" } });
    expect(scanned).toBe(false);

    const privateDown = await handleConnectPlan(new Request("https://schedi.app/billing/connect-plan", {
      method: "POST",
      headers: { "x-schedi-connect-secret": SECRET },
      body: JSON.stringify({ slug: "axeldelcidphotography", email: "axel@example.com" }),
    }), { SCHEDI_CONNECT_PAID_SECRET: SECRET }, {
      loadBySlug: async () => axel({ __privateLoadFailed: true }),
    });
    expect(privateDown.status).toBe(502);
    expect(privateDown.body).toEqual({ ok: false, error: "private_read_failed" });
    expect(JSON.stringify(privateDown.body)).not.toContain("cardEntitled");

    const missingEmail = await handleConnectPlan(new Request("https://schedi.app/billing/connect-plan", {
      method: "POST",
      headers: { "x-schedi-connect-secret": SECRET },
      body: JSON.stringify({ slug: "axeldelcidphotography" }),
    }), { SCHEDI_CONNECT_PAID_SECRET: SECRET }, {
      loadBySlug: async () => axel({ ownerEmail: "" }),
    });
    expect(missingEmail.status).toBe(409);
    expect(missingEmail.body).toEqual({ ok: false, error: "owner_email_missing" });
    expect(JSON.stringify(missingEmail.body)).not.toContain("cus_should_not_leak");

    const denied = await handleConnectPlan(new Request("https://schedi.app/billing/connect-plan", {
      method: "POST",
      headers: { "x-schedi-connect-secret": "nope" },
      body: JSON.stringify({ slug: "axeldelcidphotography", email: "axel@example.com" }),
    }), { SCHEDI_CONNECT_PAID_SECRET: SECRET }, {
      loadBySlug: async () => axel(),
    });
    expect(denied.status).toBe(401);
  });

  it("keeps the Railway portal and the handoff route from trusting a local plan column or a logged token", () => {
    expect(portal).toContain("isCardPlanPro");
    expect(portal).toContain("fetchSchediPlan");
    expect(portal).not.toContain('business.plan !== "pro" || business.subscriptionStatus !== "active"');

    const handoffBlock = worker.slice(
      worker.indexOf("path === '/billing/connect-handoff'"),
      worker.indexOf("path === '/billing/connect-plan'"),
    );
    expect(handoffBlock).toContain("getTenantPlanRecord");
    expect(handoffBlock).not.toContain("getTenantById");
    expect(handoffBlock).not.toContain("listPrivateTenants");

    const planBlock = worker.slice(
      worker.indexOf("path === '/billing/connect-plan'"),
      worker.indexOf("path === '/billing/subscribe'"),
    );
    expect(planBlock).toContain("getTenantPlanRecord");
    expect(planBlock).not.toContain("listPrivateTenants");
    expect(planBlock).not.toContain("findTenantByOwnerEmail");

    const loader = worker.slice(
      worker.indexOf("async function getTenantPlanRecord"),
      worker.indexOf("async function getTenantById"),
    );
    expect(loader).toContain("getPrivateTenant");
    expect(loader).not.toContain("hydrateTenantBookings");

    expect(handoffRoute).toContain("acceptConnectHandoff");
    expect(handoffRoute).toContain("fetchSchediPlan");
    expect(handoffRoute).toContain("formData");
    expect(handoffRoute).toContain("referrer-policy");
    expect(handoffRoute).toContain("history.replaceState");
    expect(handoffRoute).toContain("/portal#stripe-setup");
    expect(handoffRoute).not.toContain('searchParams.get("t")');
    expect(handoffRoute).not.toContain("adoptSchediBusiness");
  });
});
