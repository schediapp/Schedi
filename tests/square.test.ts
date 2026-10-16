import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workers/schedi-email-worker/src/firebase-admin.js", () => ({
  adminAccessToken: vi.fn(async () => "access"),
  adminAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer access", "Content-Type": "application/json" })),
}));

// @ts-expect-error plain JS worker module
import {
  SQUARE_SCOPES,
  applyRefundApiResult,
  applySquarePaymentUpdate,
  buildAuthorizeUrl,
  buildPaymentLinkBody,
  decryptSquareTokens,
  encryptSquareTokens,
  handleSquareHttp,
  readVerifiedSquareEvent,
  squareTokenKeyBytes,
  squareWebhookSignature,
  validateOauthState,
} from "../workers/schedi-email-worker/src/square.js";
// @ts-expect-error plain JS worker module
import { persistTenantAppointments, sanitizeBooking, savePrivateAppointments } from "../workers/schedi-email-worker/src/private-bookings.js";
// @ts-expect-error plain JS worker module
import { privateView } from "../workers/schedi-email-worker/src/tenant-private.js";

const TENANT = "acme";
const BOOKING_ID = "BK-SQ000001";

function kv(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function booking(extra: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    tenantId: TENANT,
    manageToken: "mtBKSQ000001xxxxxxxxxxxx",
    clientName: "Client",
    clientEmail: "client@example.com",
    clientPhone: "555-0100",
    serviceName: "Haircut",
    date: "2026-10-20",
    time: "10:00 AM",
    status: "pending",
    durationMins: 60,
    paymentMethod: "square",
    paymentStatus: "AWAITING SQUARE",
    createdAt: "2026-10-15T18:48:48.000Z",
    ...extra,
  };
}

function putSession(store: ReturnType<typeof kv>, token = "owner-token") {
  store.store.set("session:" + token, JSON.stringify({
    role: "owner",
    tenantId: TENANT,
    exp: Date.now() + 3_600_000,
  }));
}

async function tokenKey() {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return { raw, b64: btoa(binary) };
}

let restoreFetch: typeof fetch;

beforeEach(() => {
  restoreFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = restoreFetch;
  vi.clearAllMocks();
});

describe("Square OAuth state", () => {
  const now = 1_700_000_000_000;
  const record = { state: "abc", tenantId: TENANT, session: "sess", expiresAt: now + 1000 };

  it("rejects a missing, mismatched, or expired state", () => {
    expect(validateOauthState(null, "abc", now)).toEqual({ ok: false, reason: "missing" });
    expect(validateOauthState(record, "", now)).toEqual({ ok: false, reason: "missing" });
    expect(validateOauthState(record, "abd", now)).toEqual({ ok: false, reason: "mismatch" });
    expect(validateOauthState({ ...record, expiresAt: now }, "abc", now)).toEqual({ ok: false, reason: "expired" });
    expect(validateOauthState({ ...record, tenantId: "../x" }, "abc", now)).toEqual({ ok: false, reason: "missing" });
  });

  it("accepts a matching unexpired state tied to the tenant", () => {
    expect(validateOauthState(record, "abc", now)).toEqual({ ok: true, tenantId: TENANT, session: "sess" });
  });

  it("builds a sandbox authorize URL without an application-fee scope", () => {
    const url = new URL(buildAuthorizeUrl({ SQUARE_APPLICATION_ID: "sq0idp-test" }, "state123"));
    expect(url.host).toBe("connect.squareupsandbox.com");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("session")).toBe("false");
    expect(url.searchParams.get("client_id")).toBe("sq0idp-test");
    expect(url.searchParams.get("state")).toBe("state123");
    expect(url.searchParams.get("scope")).toBe(SQUARE_SCOPES.join(" "));
    expect(url.searchParams.get("scope")).not.toContain("PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS");
    expect(url.searchParams.get("redirect_uri")).toBe("https://schedi.app/api/square/callback");
  });

  it("uses the production host only when SQUARE_ENVIRONMENT is production", () => {
    const url = buildAuthorizeUrl({ SQUARE_ENVIRONMENT: "production", SQUARE_APPLICATION_ID: "sq0idp-live" }, "s");
    expect(url.startsWith("https://connect.squareup.com/oauth2/authorize")).toBe(true);
  });

  it("does not exchange a code when the callback state is unknown", async () => {
    const squareFetch = vi.fn();
    const res = await handleSquareHttp(
      new Request("https://schedi.app/api/square/callback?code=authcode&state=missing"),
      { AUTH_KV: kv(), SQUARE_TOKEN_KEY: (await tokenKey()).b64 },
      "",
      "/api/square/callback",
      { squareFetch },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("square=error");
    expect(squareFetch).not.toHaveBeenCalled();
  });
});

describe("Square token encryption", () => {
  it("round-trips access and refresh tokens and rejects the wrong key", async () => {
    const key = await tokenKey();
    const packed = await encryptSquareTokens(key.raw, { accessToken: "sq_at", refreshToken: "sq_rt" });
    expect(packed).not.toContain("sq_at");
    expect(packed).not.toContain("sq_rt");
    expect(await decryptSquareTokens(key.raw, packed)).toEqual({ accessToken: "sq_at", refreshToken: "sq_rt" });
    const other = new Uint8Array(key.raw);
    other[0] ^= 0xff;
    await expect(decryptSquareTokens(other, packed)).rejects.toThrow();
  });

  it("accepts a 32-byte base64 or hex key and rejects anything else", async () => {
    const key = await tokenKey();
    expect(squareTokenKeyBytes(key.b64)?.length).toBe(32);
    const hex = Array.from(key.raw, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(squareTokenKeyBytes(hex)?.length).toBe(32);
    expect(squareTokenKeyBytes("short")).toBeNull();
    expect(squareTokenKeyBytes("")).toBeNull();
  });

  it("keeps ciphertext off the owner private view", () => {
    const view = privateView(TENANT, { squareConnection: { cipher: "secret" }, ownerEmail: "a@b.co" }, "owner");
    expect(view).not.toHaveProperty("squareConnection");
  });
});

describe("Square webhook signature and payment updates", () => {
  const signatureKey = "whsec_test";
  const notificationUrl = "https://schedi.app/api/webhooks/square";

  function paymentEvent(status = "COMPLETED") {
    return JSON.stringify({
      event_id: "evt_pay_1",
      type: "payment.updated",
      data: {
        object: {
          payment: {
            id: "pay_1",
            status,
            order_id: "ord_1",
            note: "schedi|" + TENANT + "|" + BOOKING_ID + "|full",
            amount_money: { amount: 2500, currency: "USD" },
          },
        },
      },
    });
  }

  it("rejects a bad signature and does not return the event", async () => {
    const raw = paymentEvent();
    const verified = await readVerifiedSquareEvent(raw, "bm90LWEtc2lnbmF0dXJl", { SQUARE_WEBHOOK_SIGNATURE_KEY: signatureKey });
    expect(verified.ok).toBe(false);
    expect(verified).not.toHaveProperty("event");
  });

  it("marks the appointment paid when payment.updated is COMPLETED", async () => {
    const raw = paymentEvent();
    const signature = await squareWebhookSignature(signatureKey, notificationUrl, raw);
    const saved: Array<Record<string, unknown>> = [];
    const res = await handleSquareHttp(
      new Request("https://schedi.app/api/webhooks/square", {
        method: "POST",
        headers: { "x-square-hmacsha256-signature": signature, "Content-Type": "application/json" },
        body: raw,
      }),
      { AUTH_KV: kv(), SQUARE_WEBHOOK_SIGNATURE_KEY: signatureKey },
      "",
      "/api/webhooks/square",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        loadAppointments: async () => [booking()],
        saveAppointments: async (_env: unknown, _token: string, tenantId: string, appointments: Array<Record<string, unknown>>) => {
          saved.push({ tenantId, booking: appointments[0] });
        },
      },
    );
    expect(res.status).toBe(200);
    expect(saved).toHaveLength(1);
    expect(saved[0].tenantId).toBe(TENANT);
    expect(saved[0].booking).toMatchObject({
      paymentStatus: "PAID",
      paidMethod: "square",
      paymentMethod: "square",
      squarePaymentId: "pay_1",
      squareAmountCents: 2500,
      squareCurrency: "USD",
    });
  });

  it("ignores a duplicate payment.updated delivery", async () => {
    const raw = paymentEvent();
    const signature = await squareWebhookSignature(signatureKey, notificationUrl, raw);
    const store = kv();
    let saves = 0;
    const deps = {
      json: (body: unknown, status = 200) => jsonResponse(body, status),
      loadAppointments: async () => [booking()],
      saveAppointments: async () => { saves += 1; },
    };
    const env = { AUTH_KV: store, SQUARE_WEBHOOK_SIGNATURE_KEY: signatureKey };
    const post = () => handleSquareHttp(
      new Request("https://schedi.app/api/webhooks/square", {
        method: "POST",
        headers: { "x-square-hmacsha256-signature": signature },
        body: raw,
      }),
      env,
      "",
      "/api/webhooks/square",
      deps,
    );
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect(saves).toBe(1);
  });

  it("leaves an unpaid appointment unchanged when the payment fails", () => {
    const current = booking();
    const applied = applySquarePaymentUpdate(current, { id: "pay_1", status: "FAILED" }, "full");
    expect(applied.changed).toBe(false);
    expect(applied.booking).toBe(current);
    expect(applied.booking.paymentStatus).toBe("AWAITING SQUARE");
  });

  it("treats a second COMPLETED update for the same payment as a duplicate", () => {
    const first = applySquarePaymentUpdate(booking(), {
      id: "pay_1",
      status: "COMPLETED",
      amount_money: { amount: 2500, currency: "USD" },
    }, "full");
    const second = applySquarePaymentUpdate(first.booking, { id: "pay_1", status: "COMPLETED" }, "full");
    expect(first.booking.paymentStatus).toBe("PAID");
    expect(second.duplicate).toBe(true);
    expect(second.changed).toBe(false);
  });

  it("records a deposit as DEPOSIT PAID", () => {
    const applied = applySquarePaymentUpdate(booking({
      paymentStatus: "AWAITING DEPOSIT",
      depositAmount: 10,
      depositPaid: false,
    }), {
      id: "pay_dep",
      status: "COMPLETED",
      amount_money: { amount: 1000, currency: "USD" },
    }, "deposit");
    expect(applied.booking.paymentStatus).toBe("DEPOSIT PAID");
    expect(applied.booking.depositPaid).toBe(true);
    expect(applied.booking.paidMethod).toBe("square");
    expect(applied.booking.paymentMethod).toBe("square");
  });
});

describe("Square refunds and payment links", () => {
  it("leaves the appointment unchanged when Square rejects the refund", () => {
    const paid = applySquarePaymentUpdate(booking(), {
      id: "pay_1",
      status: "COMPLETED",
      amount_money: { amount: 2500, currency: "USD" },
    }, "full").booking;
    const result = applyRefundApiResult(paid, { ok: false, error: "INSUFFICIENT_FUNDS" });
    expect(result.changed).toBe(false);
    expect(result.error).toBe("INSUFFICIENT_FUNDS");
    expect(result.booking).toBe(paid);
    expect(paid.paymentStatus).toBe("PAID");
    expect(paid.squareRefundStatus).toBeUndefined();
  });

  it("records a completed refund without cancelling the visit", () => {
    const paid = applySquarePaymentUpdate(booking(), {
      id: "pay_1",
      status: "COMPLETED",
      amount_money: { amount: 2500, currency: "USD" },
    }, "full").booking;
    const pending = applyRefundApiResult(paid, {
      ok: true,
      refund: { id: "rf_1", status: "PENDING", amount_money: { amount: 2500, currency: "USD" } },
    });
    expect(pending.changed).toBe(false);
    expect(pending.pending).toBe(true);
    const done = applyRefundApiResult(paid, {
      ok: true,
      refund: { id: "rf_1", status: "COMPLETED", payment_id: "pay_1", amount_money: { amount: 2500, currency: "USD" } },
    });
    expect(done.changed).toBe(true);
    expect(done.booking.squareRefundStatus).toBe("COMPLETED");
    expect(done.booking.squareRefundId).toBe("rf_1");
    expect(done.booking.paymentStatus).toBe("REFUNDED");
    expect(done.booking.cancelled).toBeUndefined();
  });

  it("returns Square's error and does not save when the refund API fails", async () => {
    const key = await tokenKey();
    const cipher = await encryptSquareTokens(key.raw, { accessToken: "sq_at", refreshToken: "sq_rt" });
    const store = kv();
    putSession(store);
    const saved: unknown[] = [];
    const squareFetch = vi.fn(async () => jsonResponse({
      errors: [{ code: "INSUFFICIENT_FUNDS", detail: "The Square balance cannot cover this refund." }],
    }, 400));
    const res = await handleSquareHttp(
      new Request("https://schedi.app/api/square/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: TENANT, session: "owner-token", bookingId: BOOKING_ID, amountCents: 2500 }),
      }),
      {
        AUTH_KV: store,
        SQUARE_TOKEN_KEY: key.b64,
        SQUARE_APPLICATION_ID: "sq0idp-test",
        SQUARE_APPLICATION_SECRET: "secret",
      },
      "https://schedi.app",
      "/api/square/refund",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        loadConnection: async () => ({
          merchantId: "MERCHANT",
          cipher,
          expiresAt: new Date(Date.now() + 10 * 86400000).toISOString(),
          locationId: "LOC",
        }),
        loadAppointments: async () => [booking({
          paymentStatus: "PAID",
          paidMethod: "square",
          squarePaymentId: "pay_1",
          squareAmountCents: 2500,
          squareCurrency: "USD",
        })],
        saveAppointments: async () => { saved.push(true); },
        squareFetch,
      },
    );
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.error).toBe("INSUFFICIENT_FUNDS");
    expect(String(data.message)).toContain("appointment was not changed");
    expect(saved).toHaveLength(0);
    const refundCall = squareFetch.mock.calls[0];
    expect(String(refundCall[0])).toContain("/v2/refunds");
    const body = JSON.parse(String(refundCall[1].body));
    expect(body.payment_id).toBe("pay_1");
    expect(body.amount_money).toEqual({ amount: 2500, currency: "USD" });
    expect(body).not.toHaveProperty("app_fee_money");
  });

  it("builds a payment link with no application fee", () => {
    const body = buildPaymentLinkBody({
      chargeKind: "full",
      bookingIds: [BOOKING_ID],
      tenantId: TENANT,
      locationId: "LOC",
      amountCents: 2500,
      currency: "USD",
      itemName: "Haircut",
      redirectUrl: "https://schedi.app/acme/?pay=success&kind=square&booking=" + BOOKING_ID,
    });
    expect(body).not.toHaveProperty("app_fee_money");
    expect(JSON.stringify(body)).not.toContain("app_fee");
    expect(body.order.location_id).toBe("LOC");
    expect(body.checkout_options.redirect_url).toContain("kind=square");
    expect(body.idempotency_key.startsWith("sqf_")).toBe(true);
    expect(body.idempotency_key.length).toBeLessThanOrEqual(45);
  });

  it("posts a Square payment link and does not call Stripe", async () => {
    const key = await tokenKey();
    const cipher = await encryptSquareTokens(key.raw, { accessToken: "sq_at", refreshToken: "sq_rt" });
    const calls: string[] = [];
    const squareFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      const body = JSON.parse(String(init?.body || "{}"));
      expect(body).not.toHaveProperty("app_fee_money");
      expect(body.order.location_id).toBe("LOC");
      return jsonResponse({
        payment_link: { id: "link_1", url: "https://sandbox.square.link/u/abc", order_id: "ord_9" },
      });
    });
    const res = await handleSquareHttp(
      new Request("https://schedi.app/api/square/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: TENANT, bookingIds: [BOOKING_ID] }),
      }),
      { AUTH_KV: kv(), SQUARE_TOKEN_KEY: key.b64, SQUARE_APPLICATION_ID: "sq0idp-test", SQUARE_APPLICATION_SECRET: "secret" },
      "",
      "/api/square/checkout",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        firebaseAnonymousToken: async () => "tok",
        getTenantById: async () => ({ id: TENANT, name: "Acme", plan: "starter", squareReady: true, slug: "acme" }),
        planName: () => "starter",
        bookingPrice: () => 25,
        depositOn: () => false,
        slugFor: () => "acme",
        loadConnection: async () => ({
          merchantId: "MERCHANT",
          cipher,
          expiresAt: new Date(Date.now() + 10 * 86400000).toISOString(),
          locationId: "LOC",
          locationName: "Main",
        }),
        loadAppointments: async () => [booking()],
        saveAppointments: async () => {},
        squareFetch,
      },
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.url).toBe("https://sandbox.square.link/u/abc");
    expect(calls).toEqual(["https://connect.squareupsandbox.com/v2/online-checkout/payment-links"]);
    expect(calls.join(" ")).not.toContain("stripe.com");
  });

  it("refuses Square checkout on the Free plan", async () => {
    const squareFetch = vi.fn();
    const res = await handleSquareHttp(
      new Request("https://schedi.app/api/square/checkout", {
        method: "POST",
        body: JSON.stringify({ tenantId: TENANT, bookingId: BOOKING_ID }),
      }),
      { AUTH_KV: kv() },
      "",
      "/api/square/checkout",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        firebaseAnonymousToken: async () => "tok",
        getTenantById: async () => ({ id: TENANT, plan: "free", squareReady: true }),
        planName: () => "free",
        squareFetch,
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("square_not_on_free");
    expect(squareFetch).not.toHaveBeenCalled();
  });
});

describe("Square booking fields stay server-owned", () => {
  it("drops a client-supplied Square payment id", () => {
    const clean = sanitizeBooking(booking({ squarePaymentId: "spoof", paymentStatus: "PAID", paidMethod: "square" }), TENANT);
    expect(clean.squarePaymentId).toBeUndefined();
    expect(clean.paymentMethod).toBe("square");
    expect(clean.paidMethod).toBe("square");
  });

  it("keeps a Square payment when a stale roster tries to unpay it", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
    const store = kv();
    const env = { AUTH_KV: store, FIREBASE_API_KEY: "test-key", FIREBASE_PROJECT_ID: "siteforge-97699", FIREBASE_APP_ID: "siteforge-97699" };
    const paid = booking({
      paymentStatus: "PAID",
      paidMethod: "square",
      paymentMethod: "square",
      squarePaymentId: "pay_1",
      squareOrderId: "ord_1",
      squareAmountCents: 2500,
      squareCurrency: "USD",
    });
    await savePrivateAppointments(env, TENANT, [paid], 0);
    const saved = await persistTenantAppointments(env, "tok", TENANT, [booking({
      paymentStatus: "AWAITING SQUARE",
      squarePaymentId: "spoof",
      paidMethod: "later",
    })]);
    const kept = saved.find((item: { id: string }) => item.id === BOOKING_ID);
    expect(kept.squarePaymentId).toBe("pay_1");
    expect(kept.squareOrderId).toBe("ord_1");
    expect(kept.paymentStatus).toBe("PAID");
    expect(kept.paidMethod).toBe("square");
    expect(kept.paymentMethod).toBe("square");
  });
});
