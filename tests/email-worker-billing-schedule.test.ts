import { describe, expect, it, vi, afterEach } from "vitest";
// @ts-expect-error plain JS worker module
import { handleOwnerBillingSchedule, ownerBillingScheduleAction, subscriptionPeriodEndIso, subscriptionScheduleFromStripe } from "../workers/schedi-email-worker/src/owner-billing-schedule.js";
// @ts-expect-error plain JS worker module
import worker from "../workers/schedi-email-worker/src/index.js";

type Deps = Parameters<typeof handleOwnerBillingSchedule>[2];

const PERIOD_END = 1_800_000_000;

function post(path: string, body: unknown, method = "POST") {
  return new Request("https://schedi.app" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeDeps(over: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ path: string; method: string; params?: string }> = [];
  const tenant = {
    id: "acme",
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_1",
    ...(over.tenant as object),
  };
  const sub = { id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: false, current_period_end: PERIOD_END, ...(over.sub as object) };
  const saved: unknown[] = [];
  const deps = {
    sessionAllows: vi.fn(async (session: unknown, tenantId: string) =>
      over.allow !== undefined ? (over.allow as boolean) : session === "good" && tenantId === "acme"),
    loadTenant: vi.fn(async () => (over.noTenant ? null : tenant)),
    stripeForm: vi.fn(async (path: string, init?: { method?: string; params?: URLSearchParams }) => {
      calls.push({ path, method: init?.method || "GET", params: init?.params?.toString() });
      if ((init?.method || "GET") === "GET") return { ok: true, status: 200, data: sub };
      const flag = init?.params?.get("cancel_at_period_end") === "true";
      return { ok: true, status: 200, data: { ...sub, cancel_at_period_end: flag, cancel_at: flag ? PERIOD_END : null } };
    }),
    saveSchedule: vi.fn(async (_id: string, patch: unknown) => { saved.push(patch); }),
  };
  return { deps: deps as unknown as Deps, calls, saved, raw: deps };
}

describe("ownerBillingScheduleAction", () => {
  it("matches only cancel and resume", () => {
    expect(ownerBillingScheduleAction("/billing/cancel")).toBe("cancel");
    expect(ownerBillingScheduleAction("/billing/resume/")).toBe("resume");
    expect(ownerBillingScheduleAction("/billing/checkout")).toBeNull();
    expect(ownerBillingScheduleAction("/billing/portal")).toBeNull();
  });
});

describe("handleOwnerBillingSchedule", () => {
  it("rejects a missing or wrong session before loading the tenant or calling Stripe", async () => {
    for (const session of [undefined, "", "bad"]) {
      const { deps, calls, raw } = makeDeps();
      const res = await handleOwnerBillingSchedule(post("/billing/cancel", { tenantId: "acme", session }), "/billing/cancel", deps);
      expect(res).toEqual({ status: 401, body: { ok: false, error: "session_required" } });
      expect(raw.loadTenant).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    }
  });

  it("rejects an owner session for another tenant", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleOwnerBillingSchedule(post("/billing/cancel", { tenantId: "other", session: "good" }), "/billing/cancel", deps);
    expect(res?.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("requires POST and valid input", async () => {
    const { deps, calls } = makeDeps();
    expect((await handleOwnerBillingSchedule(post("/billing/cancel", null, "GET"), "/billing/cancel", deps))?.status).toBe(405);
    expect((await handleOwnerBillingSchedule(post("/billing/cancel", "{not json"), "/billing/cancel", deps))?.status).toBe(400);
    expect((await handleOwnerBillingSchedule(post("/billing/cancel", { tenantId: "../x", session: "good" }), "/billing/cancel", deps))?.body).toEqual({ ok: false, error: "invalid_tenant" });
    expect(calls).toHaveLength(0);
  });

  it("refuses complimentary and billing-exempt plans without calling Stripe", async () => {
    for (const tenant of [{ complimentaryPro: true }, { billingExempt: true }]) {
      const { deps, calls } = makeDeps({ tenant });
      const res = await handleOwnerBillingSchedule(post("/billing/cancel", { tenantId: "acme", session: "good" }), "/billing/cancel", deps);
      expect(res).toEqual({ status: 400, body: { ok: false, error: "complimentary_no_charge" } });
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses a subscription whose customer does not match the stored customer, without updating it", async () => {
    for (const over of [{ sub: { customer: "cus_other" } }, { tenant: { stripeCustomerId: "" } }]) {
      const { deps, calls } = makeDeps(over);
      const res = await handleOwnerBillingSchedule(post("/billing/cancel", { tenantId: "acme", session: "good" }), "/billing/cancel", deps);
      expect(res?.body).toEqual({ ok: false, error: "customer_mismatch" });
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    }
  });

  it("returns no_subscription when there is nothing to change", async () => {
    const { deps, calls } = makeDeps({ tenant: { stripeSubscriptionId: "" } });
    const res = await handleOwnerBillingSchedule(post("/billing/cancel", { tenantId: "acme", session: "good" }), "/billing/cancel", deps);
    expect(res?.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it("cancel sets cancel_at_period_end=true, never deletes, and returns the period end", async () => {
    const { deps, calls, saved } = makeDeps();
    const res = await handleOwnerBillingSchedule(post("/billing/cancel", { tenantId: "acme", session: "good" }), "/billing/cancel", deps);
    const iso = new Date(PERIOD_END * 1000).toISOString();
    expect(res).toEqual({ status: 200, body: { ok: true, cancelAtPeriodEnd: true, activeUntil: iso, currentPeriodEnd: iso } });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[1]).toEqual({ path: "/v1/subscriptions/sub_1", method: "POST", params: "cancel_at_period_end=true" });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(saved).toEqual([{ cancelAtPeriodEnd: true, currentPeriodEnd: iso }]);
  });

  it("resume only works when a cancel is scheduled", async () => {
    const notScheduled = makeDeps();
    const res1 = await handleOwnerBillingSchedule(post("/billing/resume", { tenantId: "acme", session: "good" }), "/billing/resume", notScheduled.deps);
    expect(res1?.body).toEqual({ ok: false, error: "not_scheduled" });
    expect(notScheduled.calls.filter((c) => c.method === "POST")).toHaveLength(0);

    const scheduled = makeDeps({ sub: { cancel_at_period_end: true, cancel_at: PERIOD_END } });
    const res2 = await handleOwnerBillingSchedule(post("/billing/resume", { tenantId: "acme", session: "good" }), "/billing/resume", scheduled.deps);
    expect(res2).toEqual({ status: 200, body: { ok: true, cancelAtPeriodEnd: false, activeUntil: null, currentPeriodEnd: null } });
    expect(scheduled.calls[1].params).toBe("cancel_at_period_end=false");
    expect(scheduled.saved).toEqual([{ cancelAtPeriodEnd: false, currentPeriodEnd: "" }]);
  });

  it("does not touch an already-canceled subscription", async () => {
    const { deps, calls } = makeDeps({ sub: { status: "canceled" } });
    const res = await handleOwnerBillingSchedule(post("/billing/cancel", { tenantId: "acme", session: "good" }), "/billing/cancel", deps);
    expect(res?.body).toEqual({ ok: false, error: "no_subscription" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("prefers cancel_at for the period end", () => {
    expect(subscriptionPeriodEndIso({ cancel_at_period_end: true, cancel_at: 1000, current_period_end: 2000 })).toBe(new Date(1000_000).toISOString());
    expect(subscriptionPeriodEndIso({ items: { data: [{ current_period_end: 3000 }] } })).toBe(new Date(3000_000).toISOString());
  });
});

describe("subscriptionScheduleFromStripe (customer.subscription.updated)", () => {
  const NOW = 1_700_000_000_000;
  it("reads a billing-portal cancel at period end", () => {
    expect(subscriptionScheduleFromStripe({ status: "active", cancel_at_period_end: true, cancel_at: PERIOD_END, current_period_end: PERIOD_END }, NOW))
      .toEqual({ cancelAtPeriodEnd: true, currentPeriodEnd: new Date(PERIOD_END * 1000).toISOString() });
    expect(subscriptionScheduleFromStripe({ status: "active", cancel_at_period_end: true, items: { data: [{ current_period_end: PERIOD_END }] } }, NOW))
      .toEqual({ cancelAtPeriodEnd: true, currentPeriodEnd: new Date(PERIOD_END * 1000).toISOString() });
  });
  it("reads a cancel_at-only schedule (newer Stripe API versions)", () => {
    expect(subscriptionScheduleFromStripe({ status: "active", cancel_at_period_end: false, cancel_at: PERIOD_END }, NOW))
      .toEqual({ cancelAtPeriodEnd: true, currentPeriodEnd: new Date(PERIOD_END * 1000).toISOString() });
  });
  it("clears the schedule on resume, past cancel_at, or a canceled subscription", () => {
    const clear = { cancelAtPeriodEnd: false, currentPeriodEnd: "" };
    expect(subscriptionScheduleFromStripe({ status: "active", cancel_at_period_end: false, cancel_at: null, current_period_end: PERIOD_END }, NOW)).toEqual(clear);
    expect(subscriptionScheduleFromStripe({ status: "active", cancel_at_period_end: false, cancel_at: 1000 }, NOW)).toEqual(clear);
    expect(subscriptionScheduleFromStripe({ status: "canceled", cancel_at_period_end: true, cancel_at: PERIOD_END }, NOW)).toEqual(clear);
    expect(subscriptionScheduleFromStripe(null, NOW)).toEqual(clear);
  });
});

describe("schedi-email-worker routes", () => {
  afterEach(() => vi.unstubAllGlobals());

  function env() {
    const kv = new Map<string, string>();
    return {
      AUTH_KV: { get: async (k: string) => kv.get(k) ?? null, put: async () => {}, delete: async () => {} },
      STRIPE_SECRET_KEY: "sk_test_dummy",
      FIREBASE_PROJECT_ID: "p",
      FIREBASE_APP_ID: "p",
    };
  }

  it("unauthenticated POST /billing/cancel and /billing/resume return 401 and make no outbound calls", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    for (const path of ["/billing/cancel", "/billing/resume"]) {
      for (const body of [{}, { tenantId: "acme" }, { tenantId: "acme", session: "nope" }]) {
        const res = await worker.fetch(post(path, body), env(), { waitUntil() {} });
        expect(res.status).toBe(body && (body as { tenantId?: string }).tenantId ? 401 : 400);
        expect(await res.json()).toMatchObject({ ok: false });
      }
      const get = await worker.fetch(post(path, null, "GET"), env(), { waitUntil() {} });
      expect(get.status).toBe(405);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("other /billing paths keep their behavior", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const checkout = await worker.fetch(post("/billing/checkout", { tenantId: "acme", plan: "pro" }), env(), { waitUntil() {} });
    expect(checkout.status).toBe(401);
    const portal = await worker.fetch(post("/billing/portal", { tenantId: "acme" }), env(), { waitUntil() {} });
    expect(portal.status).toBe(401);
    const webhook = await worker.fetch(post("/billing/webhook", {}), env(), { waitUntil() {} });
    expect(webhook.status).toBe(500); // no STRIPE_WEBHOOK_SECRET in this env: webhook_secret_missing
    const unknown = await worker.fetch(post("/billing/nope", {}), env(), { waitUntil() {} });
    expect(unknown.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
