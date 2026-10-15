import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appendOwnerCheckoutPolicy,
  handleOwnerBillingSchedule,
  ownerBillingScheduleAction,
  ownerCheckoutCustomText,
  type PublicBillingDeps,
  type PublicBillingTenant,
  type StripeFormResult,
  type StripeSubscriptionRecord,
} from "../src/lib/public-owner-billing";
import { OWNER_SUBSCRIPTION_POLICY_SHORT } from "../src/lib/subscription-policy";

const PERIOD_END = 1794009600;
const PERIOD_END_ISO = "2026-11-07T00:00:00.000Z";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function subscription(overrides: Partial<StripeSubscriptionRecord> = {}): StripeSubscriptionRecord {
  return {
    id: "sub_owner",
    customer: "cus_owner",
    status: "active",
    cancel_at_period_end: false,
    cancel_at: null,
    items: { data: [{ current_period_end: PERIOD_END }] },
    ...overrides,
  };
}

function deps(options?: {
  tenant?: PublicBillingTenant | null;
  sessionAllows?: PublicBillingDeps["sessionAllows"];
  loadThrows?: boolean;
  stripe?: (path: string, init?: { method?: string; params?: URLSearchParams }) => StripeFormResult;
  saveThrows?: boolean;
}) {
  const calls: Array<{ path: string; method?: string; params?: string }> = [];
  const saved: Array<{ tenantId: string; patch: { cancelAtPeriodEnd: boolean; currentPeriodEnd: string } }> = [];
  let sessionCalls = 0;
  let loadCalls = 0;
  const api: PublicBillingDeps = {
    sessionAllows: async (session, tenantId) => {
      sessionCalls += 1;
      if (options?.sessionAllows) return options.sessionAllows(session, tenantId);
      return session === "owner-token" && tenantId === "glow-studio";
    },
    loadTenant: async () => {
      loadCalls += 1;
      if (options?.loadThrows) throw new Error("firestore down");
      if (options && "tenant" in options) return options.tenant ?? null;
      return {
        stripeCustomerId: "cus_owner",
        stripeSubscriptionId: "sub_owner",
      };
    },
    stripeForm: async (path, init) => {
      calls.push({ path, method: init?.method, params: init?.params?.toString() });
      if (options?.stripe) return options.stripe(path, init);
      if (init?.method === "POST") {
        const cancel = init.params?.get("cancel_at_period_end") === "true";
        return {
          ok: true,
          status: 200,
          data: subscription({
            cancel_at_period_end: cancel,
            cancel_at: cancel ? PERIOD_END : null,
          }),
        };
      }
      return { ok: true, status: 200, data: subscription() };
    },
    saveSchedule: async (tenantId, patch) => {
      if (options?.saveThrows) throw new Error("patch failed");
      saved.push({ tenantId, patch });
    },
  };
  return {
    api,
    calls,
    saved,
    sessionCalls: () => sessionCalls,
    loadCalls: () => loadCalls,
  };
}

function post(path: string, body: unknown, raw?: string): Request {
  return new Request(`https://schedi.app${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

describe("public owner billing cancel and resume", () => {
  it("only claims the SPA cancel and resume paths", () => {
    expect(ownerBillingScheduleAction("/billing/cancel")).toBe("cancel");
    expect(ownerBillingScheduleAction("/billing/resume/")).toBe("resume");
    expect(ownerBillingScheduleAction("/billing/checkout")).toBeNull();
    expect(ownerBillingScheduleAction("/billing/booking-checkout")).toBeNull();
    expect(html).toContain("postSchediBillingAction('/cancel'");
    expect(html).toContain("postSchediBillingAction('/resume'");
    expect(html).toContain("fetch(SCHEDI_BILLING_BASE + path");
    expect(html).toContain("if (data.activeUntil) tenant.currentPeriodEnd = data.activeUntil");
  });

  it("requires the owner session before it loads the tenant", async () => {
    const gate = deps();
    const missing = await handleOwnerBillingSchedule(
      post("/billing/cancel", { tenantId: "glow-studio" }),
      "/billing/cancel",
      gate.api,
    );
    expect(missing).toEqual({ status: 401, body: { ok: false, error: "session_required" } });
    expect(gate.sessionCalls()).toBe(1);
    expect(gate.loadCalls()).toBe(0);
    expect(gate.calls).toHaveLength(0);

    const otherOwner = deps({
      sessionAllows: async (session, tenantId) => session === "owner-token" && tenantId === "other-shop",
    });
    const denied = await handleOwnerBillingSchedule(
      post("/billing/cancel", { tenantId: "glow-studio", session: "owner-token" }),
      "/billing/cancel",
      otherOwner.api,
    );
    expect(denied?.status).toBe(401);
    expect(otherOwner.loadCalls()).toBe(0);
  });

  it("rejects a bad tenant id before checking the session", async () => {
    const gate = deps();
    const bad = await handleOwnerBillingSchedule(
      post("/billing/cancel", { tenantId: "not a tenant", session: "owner-token" }),
      "/billing/cancel",
      gate.api,
    );
    expect(bad).toEqual({ status: 400, body: { ok: false, error: "invalid_tenant" } });
    expect(gate.sessionCalls()).toBe(0);

    const broken = await handleOwnerBillingSchedule(
      post("/billing/resume", {}, "{"),
      "/billing/resume",
      gate.api,
    );
    expect(broken).toEqual({ status: 400, body: { ok: false, error: "invalid_json" } });
  });

  it("schedules cancel_at_period_end and returns the period end", async () => {
    const gate = deps();
    const result = await handleOwnerBillingSchedule(
      post("/billing/cancel", { tenantId: "glow-studio", session: "owner-token" }),
      "/billing/cancel",
      gate.api,
    );

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        activeUntil: PERIOD_END_ISO,
        currentPeriodEnd: PERIOD_END_ISO,
        cancelAtPeriodEnd: true,
      },
    });
    expect(gate.calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(gate.calls[1]).toMatchObject({
      path: "/v1/subscriptions/sub_owner",
      params: "cancel_at_period_end=true",
    });
    expect(gate.calls.some((call) => call.path.includes("DELETE") || call.method === "DELETE")).toBe(false);
    expect(gate.saved).toEqual([
      { tenantId: "glow-studio", patch: { cancelAtPeriodEnd: true, currentPeriodEnd: PERIOD_END_ISO } },
    ]);
  });

  it("reads the period end from the subscription item when Stripe omits cancel_at", async () => {
    const gate = deps({
      stripe: (_path, init) => {
        if (init?.method === "POST") {
          return {
            ok: true,
            status: 200,
            data: subscription({
              cancel_at_period_end: true,
              cancel_at: null,
              current_period_end: null,
              items: { data: [{ current_period_end: PERIOD_END }] },
            }),
          };
        }
        return { ok: true, status: 200, data: subscription() };
      },
    });
    const result = await handleOwnerBillingSchedule(
      post("/billing/cancel", { tenant_id: "glow-studio", session: "owner-token" }),
      "/billing/cancel",
      gate.api,
    );
    expect(result?.body.activeUntil).toBe(PERIOD_END_ISO);
  });

  it("leaves complimentary plans unchanged", async () => {
    const gate = deps({ tenant: { complimentaryPro: true, stripeSubscriptionId: "sub_owner" } });
    const result = await handleOwnerBillingSchedule(
      post("/billing/cancel", { tenantId: "glow-studio", session: "owner-token" }),
      "/billing/cancel",
      gate.api,
    );
    expect(result).toEqual({ status: 400, body: { ok: false, error: "complimentary_no_charge" } });
    expect(gate.calls).toHaveLength(0);
    expect(gate.saved).toHaveLength(0);
  });

  it("resumes only a subscription that is scheduled to cancel", async () => {
    const idle = deps();
    const blocked = await handleOwnerBillingSchedule(
      post("/billing/resume", { tenantId: "glow-studio", session: "owner-token" }),
      "/billing/resume",
      idle.api,
    );
    expect(blocked).toEqual({ status: 409, body: { ok: false, error: "not_scheduled" } });
    expect(idle.calls.some((call) => call.method === "POST")).toBe(false);

    const gate = deps({
      stripe: (_path, init) => {
        if (init?.method === "POST") {
          return { ok: true, status: 200, data: subscription({ cancel_at_period_end: false, cancel_at: null }) };
        }
        return {
          ok: true,
          status: 200,
          data: subscription({ cancel_at_period_end: true, cancel_at: PERIOD_END }),
        };
      },
    });
    const result = await handleOwnerBillingSchedule(
      post("/billing/resume", { tenantId: "glow-studio", session: "owner-token" }),
      "/billing/resume",
      gate.api,
    );
    expect(result?.status).toBe(200);
    expect(result?.body).toMatchObject({ ok: true, cancelAtPeriodEnd: false, activeUntil: null });
    expect(gate.calls[1]?.params).toBe("cancel_at_period_end=false");
    expect(gate.saved[0]?.patch).toEqual({ cancelAtPeriodEnd: false, currentPeriodEnd: "" });
  });

  it("does not update a subscription that belongs to another customer", async () => {
    const gate = deps({
      stripe: () => ({ ok: true, status: 200, data: subscription({ customer: "cus_other" }) }),
    });
    const result = await handleOwnerBillingSchedule(
      post("/billing/cancel", { tenantId: "glow-studio", session: "owner-token" }),
      "/billing/cancel",
      gate.api,
    );
    expect(result).toEqual({ status: 409, body: { ok: false, error: "customer_mismatch" } });
    expect(gate.calls).toHaveLength(1);
  });

  it("still returns the period end when saving the tenant schedule fails", async () => {
    const gate = deps({ saveThrows: true });
    const result = await handleOwnerBillingSchedule(
      post("/billing/cancel", { tenantId: "glow-studio", session: "owner-token" }),
      "/billing/cancel",
      gate.api,
    );
    expect(result?.status).toBe(200);
    expect(result?.body.activeUntil).toBe(PERIOD_END_ISO);
  });

  it("lets an agency session schedule cancellation for the tenant", async () => {
    const gate = deps({
      sessionAllows: async (session) => session === "agency-token",
    });
    const result = await handleOwnerBillingSchedule(
      post("/billing/cancel", { tenantId: "glow-studio", session: "agency-token" }),
      "/billing/cancel",
      gate.api,
    );
    expect(result?.status).toBe(200);
    expect(result?.body.cancelAtPeriodEnd).toBe(true);
  });

  it("puts the short renewal policy on Checkout submit text", () => {
    const params = new URLSearchParams();
    appendOwnerCheckoutPolicy(params);
    expect(params.get("custom_text[submit][message]")).toBe(OWNER_SUBSCRIPTION_POLICY_SHORT);
    expect(ownerCheckoutCustomText()).toEqual({ submit: { message: OWNER_SUBSCRIPTION_POLICY_SHORT } });

    const signup = html.indexOf('id="signupSection"');
    const policy = html.indexOf(OWNER_SUBSCRIPTION_POLICY_SHORT, signup);
    const submit = html.indexOf('id="signupSubmitBtn"', signup);
    expect(policy).toBeGreaterThan(signup);
    expect(policy).toBeLessThan(submit);
    expect(html.indexOf('id="tenantBillingPolicy"')).toBeLessThan(html.indexOf('id="tenantBillingActions"'));
  });
});
