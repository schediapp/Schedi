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
  parseSquarePaymentNote,
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

describe("Square payment confirm", () => {
  async function readySeller() {
    const key = await tokenKey();
    const cipher = await encryptSquareTokens(key.raw, { accessToken: "sq_at", refreshToken: "sq_rt" });
    return {
      envBase: {
        SQUARE_TOKEN_KEY: key.b64,
        SQUARE_APPLICATION_ID: "sq0idp-test",
        SQUARE_APPLICATION_SECRET: "secret",
      },
      connection: {
        merchantId: "MERCHANT",
        cipher,
        expiresAt: new Date(Date.now() + 10 * 86400000).toISOString(),
        locationId: "LOC",
      },
    };
  }

  function confirmRequest(body: Record<string, unknown>, ip: string) {
    return new Request("https://schedi.app/api/square/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify(body),
    });
  }

  function squareCalls(orderId: string, paymentId: string, payment: Record<string, unknown>) {
    const calls: string[] = [];
    const squareFetch = vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/v2/orders/" + orderId)) {
        return jsonResponse({
          order: { id: orderId, state: "COMPLETED", tenders: [{ type: "CARD", payment_id: paymentId }] },
        });
      }
      if (u.includes("/v2/payments/" + paymentId)) return jsonResponse({ payment });
      return jsonResponse({ errors: [{ code: "NOT_FOUND" }] }, 404);
    });
    return { calls, squareFetch };
  }

  it("marks the booking paid from a COMPLETED Square payment", async () => {
    const seller = await readySeller();
    const store = kv({
      ["sqord:ord_1"]: JSON.stringify({ tenantId: TENANT, bookingIds: [BOOKING_ID], kind: "full" }),
    });
    const rows = [booking({ squareOrderId: "ord_1" })];
    let saved: Array<Record<string, unknown>> = [];
    const { calls, squareFetch } = squareCalls("ord_1", "pay_1", {
      id: "pay_1",
      status: "COMPLETED",
      order_id: "ord_1",
      amount_money: { amount: 2500, currency: "USD" },
    });
    const res = await handleSquareHttp(
      confirmRequest({ tenantId: TENANT, bookingId: BOOKING_ID }, "203.0.113.10"),
      { ...seller.envBase, AUTH_KV: store },
      "",
      "/api/square/confirm",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        loadConnection: async () => seller.connection,
        loadAppointments: async () => rows.map((row) => ({ ...row })),
        saveAppointments: async (_env: unknown, _token: string, tenantId: string, appointments: Array<Record<string, unknown>>) => {
          saved = appointments.map((row) => ({ ...row, tenantId }));
        },
        squareFetch,
      },
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(data).toEqual({ ok: true, paid: true, status: "COMPLETED" });
    expect(saved[0]).toMatchObject({
      paymentStatus: "PAID",
      paidMethod: "square",
      paymentMethod: "square",
      squarePaymentId: "pay_1",
      squareOrderId: "ord_1",
      squareAmountCents: 2500,
      squareCurrency: "USD",
    });
    expect(calls.some((url) => url.includes("/v2/orders/ord_1"))).toBe(true);
    expect(calls.some((url) => url.includes("/v2/payments/pay_1"))).toBe(true);
    expect(store.store.get("sqpay:pay_1")).toContain(BOOKING_ID);
  });

  it("does not mark a booking paid while the Square payment is still pending", async () => {
    const seller = await readySeller();
    const store = kv();
    let saves = 0;
    const { squareFetch } = squareCalls("ord_1", "pay_pending", {
      id: "pay_pending",
      status: "PENDING",
      order_id: "ord_1",
      amount_money: { amount: 2500, currency: "USD" },
    });
    const res = await handleSquareHttp(
      confirmRequest({ tenantId: TENANT, bookingId: BOOKING_ID }, "203.0.113.11"),
      { ...seller.envBase, AUTH_KV: store },
      "",
      "/api/square/confirm",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        loadConnection: async () => seller.connection,
        loadAppointments: async () => [booking({ squareOrderId: "ord_1" })],
        saveAppointments: async () => { saves += 1; },
        squareFetch,
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, paid: false, status: "PENDING" });
    expect(saves).toBe(0);
    expect(store.store.has("sqpay:pay_pending")).toBe(false);
  });

  it("does not treat NOT PAID or UNPAID as a Square payment", async () => {
    const seller = await readySeller();
    const squareFetch = vi.fn();
    const res = await handleSquareHttp(
      confirmRequest({ tenantId: TENANT, bookingId: BOOKING_ID }, "203.0.113.19"),
      { ...seller.envBase, AUTH_KV: kv() },
      "",
      "/api/square/confirm",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        loadAppointments: async () => [booking({ paymentStatus: "NOT PAID", paidMethod: "square" })],
        squareFetch,
      },
    );
    expect(await res.json()).toEqual({ ok: true, paid: false, status: "UNPAID" });
    const unpaid = await handleSquareHttp(
      confirmRequest({ tenantId: TENANT, bookingId: BOOKING_ID }, "203.0.113.20"),
      { ...seller.envBase, AUTH_KV: kv() },
      "",
      "/api/square/confirm",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        loadAppointments: async () => [booking({ paymentStatus: "UNPAID" })],
        squareFetch,
      },
    );
    expect(await unpaid.json()).toEqual({ ok: true, paid: false, status: "UNPAID" });
    expect(squareFetch).not.toHaveBeenCalled();
  });

  it("follows a tender id when Square omits payment_id", async () => {
    const seller = await readySeller();
    let saved: Record<string, unknown> | null = null;
    const calls: string[] = [];
    const squareFetch = vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/v2/orders/ord_t")) {
        return jsonResponse({ order: { id: "ord_t", state: "COMPLETED", tenders: [{ id: "pay_tender", type: "CARD" }] } });
      }
      if (u.includes("/v2/payments/pay_tender")) {
        return jsonResponse({
          payment: { id: "pay_tender", status: "COMPLETED", order_id: "ord_t", amount_money: { amount: 2500, currency: "USD" } },
        });
      }
      return jsonResponse({}, 404);
    });
    const res = await handleSquareHttp(
      confirmRequest({ tenantId: TENANT, bookingId: BOOKING_ID }, "203.0.113.21"),
      { ...seller.envBase, AUTH_KV: kv() },
      "",
      "/api/square/confirm",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        loadConnection: async () => seller.connection,
        loadAppointments: async () => [booking({ squareOrderId: "ord_t" })],
        saveAppointments: async (_env: unknown, _token: string, _tenantId: string, appointments: Array<Record<string, unknown>>) => {
          saved = appointments[0];
        },
        squareFetch,
      },
    );
    expect(await res.json()).toEqual({ ok: true, paid: true, status: "COMPLETED" });
    expect(saved).toMatchObject({ squarePaymentId: "pay_tender", squareAmountCents: 2500 });
    expect(calls.some((url) => url.includes("/v2/payments/pay_tender"))).toBe(true);
  });

  it("treats a second confirm of the same completed payment as a no-op", async () => {
    const seller = await readySeller();
    const store = kv({
      ["sqord:ord_1"]: JSON.stringify({ tenantId: TENANT, bookingIds: [BOOKING_ID], kind: "full" }),
    });
    let rows = [booking({ squareOrderId: "ord_1" })];
    let saves = 0;
    let fetches = 0;
    const squareFetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/v2/orders/ord_1")) {
        return jsonResponse({ order: { id: "ord_1", state: "COMPLETED", tenders: [{ payment_id: "pay_1" }] } });
      }
      if (u.includes("/v2/payments/pay_1")) {
        fetches += 1;
        return jsonResponse({
          payment: {
            id: "pay_1",
            status: "COMPLETED",
            order_id: "ord_1",
            amount_money: { amount: fetches === 1 ? 2500 : 1, currency: "USD" },
          },
        });
      }
      return jsonResponse({}, 404);
    });
    const deps = {
      json: (body: unknown, status = 200) => jsonResponse(body, status),
      loadConnection: async () => seller.connection,
      loadAppointments: async () => rows.map((row) => ({ ...row })),
      saveAppointments: async (_env: unknown, _token: string, _tenantId: string, appointments: Array<Record<string, unknown>>) => {
        saves += 1;
        rows = appointments.map((row) => ({ ...row }));
      },
      squareFetch,
    };
    const env = { ...seller.envBase, AUTH_KV: store };
    const first = await handleSquareHttp(confirmRequest({ tenantId: TENANT, bookingId: BOOKING_ID }, "203.0.113.12"), env, "", "/api/square/confirm", deps);
    const second = await handleSquareHttp(confirmRequest({ tenantId: TENANT, bookingId: BOOKING_ID }, "203.0.113.12"), env, "", "/api/square/confirm", deps);
    expect(await first.json()).toEqual({ ok: true, paid: true, status: "COMPLETED" });
    expect(await second.json()).toEqual({ ok: true, paid: true, status: "COMPLETED" });
    expect(saves).toBe(1);
    expect(rows[0].squareAmountCents).toBe(2500);
    expect(rows[0].squarePaymentId).toBe("pay_1");
    expect(rows[0].paymentStatus).toBe("PAID");
  });

  it("returns 404 when the booking is unknown", async () => {
    const seller = await readySeller();
    const squareFetch = vi.fn();
    const res = await handleSquareHttp(
      confirmRequest({ tenantId: TENANT, bookingId: BOOKING_ID, amountCents: 1, paymentId: "spoof" }, "203.0.113.13"),
      { ...seller.envBase, AUTH_KV: kv() },
      "",
      "/api/square/confirm",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        loadConnection: async () => seller.connection,
        loadAppointments: async () => [],
        squareFetch,
      },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "booking_not_found", paid: false });
    expect(squareFetch).not.toHaveBeenCalled();
  });

  it("uses the Square payment amount and id, never the client's", async () => {
    const seller = await readySeller();
    const store = kv({
      ["sqord:ord_real"]: JSON.stringify({ tenantId: TENANT, bookingIds: [BOOKING_ID], kind: "full" }),
      ["sqord:spoof_order"]: JSON.stringify({ tenantId: TENANT, bookingIds: [BOOKING_ID], kind: "full" }),
    });
    let saved: Record<string, unknown> | null = null;
    const calls: string[] = [];
    const squareFetch = vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/v2/orders/ord_real")) {
        return jsonResponse({ order: { id: "ord_real", tenders: [{ payment_id: "pay_real" }] } });
      }
      if (u.includes("/v2/payments/pay_real")) {
        return jsonResponse({
          payment: { id: "pay_real", status: "COMPLETED", order_id: "ord_real", amount_money: { amount: 6400, currency: "USD" } },
        });
      }
      if (u.includes("spoof")) {
        return jsonResponse({
          payment: { id: "spoof", status: "COMPLETED", amount_money: { amount: 1, currency: "USD" } },
        });
      }
      return jsonResponse({}, 404);
    });
    const res = await handleSquareHttp(
      confirmRequest({
        tenantId: TENANT,
        bookingId: BOOKING_ID,
        amountCents: 1,
        paymentId: "spoof",
        orderId: "spoof_order",
        status: "COMPLETED",
      }, "203.0.113.14"),
      { ...seller.envBase, AUTH_KV: store },
      "",
      "/api/square/confirm",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        loadConnection: async () => seller.connection,
        loadAppointments: async () => [booking({ squareOrderId: "ord_real", paymentStatus: "AWAITING SQUARE" })],
        saveAppointments: async (_env: unknown, _token: string, _tenantId: string, appointments: Array<Record<string, unknown>>) => {
          saved = appointments[0];
        },
        squareFetch,
      },
    );
    expect(await res.json()).toEqual({ ok: true, paid: true, status: "COMPLETED" });
    expect(saved).toMatchObject({ squarePaymentId: "pay_real", squareAmountCents: 6400, squareOrderId: "ord_real" });
    expect(calls.join(" ")).not.toContain("spoof");
    expect(saved).not.toMatchObject({ squareAmountCents: 1, squarePaymentId: "spoof" });
  });

  it("lets an owner session confirm and rejects a bad session or a burst", async () => {
    const seller = await readySeller();
    const store = kv({
      ["sqord:ord_1"]: JSON.stringify({ tenantId: TENANT, bookingIds: [BOOKING_ID], kind: "full" }),
    });
    putSession(store);
    store.store.set("session:other-token", JSON.stringify({
      role: "owner",
      tenantId: "someone-else",
      exp: Date.now() + 3_600_000,
    }));
    const { squareFetch } = squareCalls("ord_1", "pay_1", {
      id: "pay_1",
      status: "COMPLETED",
      order_id: "ord_1",
      amount_money: { amount: 2500, currency: "USD" },
    });
    const deps = {
      json: (body: unknown, status = 200) => jsonResponse(body, status),
      loadConnection: async () => seller.connection,
      loadAppointments: async () => [booking({ squareOrderId: "ord_1" })],
      saveAppointments: async () => {},
      squareFetch,
    };
    const env = { ...seller.envBase, AUTH_KV: store };
    const ok = await handleSquareHttp(
      confirmRequest({ tenantId: TENANT, session: "owner-token", bookingId: BOOKING_ID }, "203.0.113.15"),
      env,
      "",
      "/api/square/confirm",
      deps,
    );
    expect(await ok.json()).toMatchObject({ ok: true, paid: true, status: "COMPLETED" });
    const forbidden = await handleSquareHttp(
      confirmRequest({ tenantId: TENANT, session: "other-token", bookingId: BOOKING_ID }, "203.0.113.16"),
      env,
      "",
      "/api/square/confirm",
      deps,
    );
    expect(forbidden.status).toBe(403);
    const limited = await handleSquareHttp(
      confirmRequest({ tenantId: TENANT, bookingId: BOOKING_ID }, "203.0.113.17"),
      env,
      "",
      "/api/square/confirm",
      { ...deps, rateLimitOk: async () => false },
    );
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toBe("rate_limited");
  });

  it("finds the order from the sqbk mapping when the appointment has no squareOrderId", async () => {
    const seller = await readySeller();
    const store = kv({
      ["sqord:ord_9"]: JSON.stringify({ tenantId: TENANT, bookingIds: [BOOKING_ID], kind: "full" }),
      ["sqbk:" + TENANT + ":" + BOOKING_ID]: JSON.stringify({ orderId: "ord_9", kind: "full" }),
    });
    let saved: Record<string, unknown> | null = null;
    const { squareFetch } = squareCalls("ord_9", "pay_9", {
      id: "pay_9",
      status: "COMPLETED",
      order_id: "ord_9",
      amount_money: { amount: 1800, currency: "USD" },
    });
    const res = await handleSquareHttp(
      confirmRequest({ tenantId: TENANT, bookingId: BOOKING_ID }, "203.0.113.18"),
      { ...seller.envBase, AUTH_KV: store },
      "",
      "/api/square/confirm",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        loadConnection: async () => seller.connection,
        loadAppointments: async () => [booking()],
        saveAppointments: async (_env: unknown, _token: string, _tenantId: string, appointments: Array<Record<string, unknown>>) => {
          saved = appointments[0];
        },
        squareFetch,
      },
    );
    expect(await res.json()).toEqual({ ok: true, paid: true, status: "COMPLETED" });
    expect(saved).toMatchObject({ squareOrderId: "ord_9", squarePaymentId: "pay_9", squareAmountCents: 1800, paymentStatus: "PAID" });
  });
});

describe("Square webhook lookup gaps", () => {
  const signatureKey = "whsec_test";
  const notificationUrl = "https://schedi.app/api/webhooks/square";

  async function postEvent(raw: string, deps: Record<string, unknown>, extraEnv: Record<string, unknown> = {}) {
    const signature = await squareWebhookSignature(signatureKey, notificationUrl, raw);
    return handleSquareHttp(
      new Request("https://schedi.app/api/webhooks/square", {
        method: "POST",
        headers: { "x-square-hmacsha256-signature": signature, "Content-Type": "application/json" },
        body: raw,
      }),
      { AUTH_KV: kv(), SQUARE_WEBHOOK_SIGNATURE_KEY: signatureKey, ...extraEnv },
      "",
      "/api/webhooks/square",
      { json: (body: unknown, status = 200) => jsonResponse(body, status), ...deps },
    );
  }

  it("marks paid when payment.created is already COMPLETED", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const raw = JSON.stringify({
      event_id: "evt_created_1",
      type: "payment.created",
      data: {
        object: {
          payment: {
            id: "pay_created",
            status: "COMPLETED",
            order_id: "ord_created",
            note: "schedi|" + TENANT + "|" + BOOKING_ID + "|full",
            amount_money: { amount: 2500, currency: "USD" },
          },
        },
      },
    });
    const res = await postEvent(raw, {
      loadAppointments: async () => [booking()],
      saveAppointments: async (_env: unknown, _token: string, tenantId: string, appointments: Array<Record<string, unknown>>) => {
        saved.push({ tenantId, booking: appointments[0] });
      },
    });
    expect(res.status).toBe(200);
    expect(saved).toHaveLength(1);
    expect(saved[0].booking).toMatchObject({ paymentStatus: "PAID", squarePaymentId: "pay_created", squareAmountCents: 2500 });
  });

  it("ignores payment.created until the payment is COMPLETED", async () => {
    let saves = 0;
    const raw = JSON.stringify({
      event_id: "evt_created_pending",
      type: "payment.created",
      data: { object: { payment: { id: "pay_p", status: "PENDING", note: "schedi|" + TENANT + "|" + BOOKING_ID + "|full" } } },
    });
    const res = await postEvent(raw, {
      loadAppointments: async () => [booking()],
      saveAppointments: async () => { saves += 1; },
    });
    expect(res.status).toBe(200);
    expect(saves).toBe(0);
  });

  it("reads a schedi note wrapped in other text", () => {
    expect(parseSquarePaymentNote("Thanks schedi|" + TENANT + "|" + BOOKING_ID + "|full ok")).toEqual({
      tenantId: TENANT,
      bookingIds: [BOOKING_ID],
      kind: "full",
    });
  });

  it("follows sqord even when the payment note names a different booking", async () => {
    const store = kv({
      ["sqord:ord_1"]: JSON.stringify({ tenantId: TENANT, bookingIds: [BOOKING_ID], kind: "full" }),
    });
    const saved: Array<Record<string, unknown>> = [];
    const raw = JSON.stringify({
      event_id: "evt_note_mismatch",
      type: "payment.updated",
      data: {
        object: {
          payment: {
            id: "pay_map",
            status: "COMPLETED",
            order_id: "ord_1",
            note: "schedi|other|BK-OTHER9999|full",
            amount_money: { amount: 2500, currency: "USD" },
          },
        },
      },
    });
    const signature = await squareWebhookSignature(signatureKey, notificationUrl, raw);
    const res = await handleSquareHttp(
      new Request("https://schedi.app/api/webhooks/square", {
        method: "POST",
        headers: { "x-square-hmacsha256-signature": signature },
        body: raw,
      }),
      { AUTH_KV: store, SQUARE_WEBHOOK_SIGNATURE_KEY: signatureKey },
      "",
      "/api/webhooks/square",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        loadAppointments: async (_env: unknown, tenantId: string) => {
          if (tenantId === "other") return [booking({ id: "BK-OTHER9999", tenantId: "other" })];
          return [booking()];
        },
        saveAppointments: async (_env: unknown, _token: string, tenantId: string, appointments: Array<Record<string, unknown>>) => {
          saved.push({ tenantId, id: appointments[0].id, paymentStatus: appointments[0].paymentStatus });
        },
      },
    );
    expect(res.status).toBe(200);
    expect(saved).toEqual([{ tenantId: TENANT, id: BOOKING_ID, paymentStatus: "PAID" }]);
  });

  it("reconciles order.updated COMPLETED by reading the payment from Square", async () => {
    const key = await tokenKey();
    const cipher = await encryptSquareTokens(key.raw, { accessToken: "sq_at", refreshToken: "sq_rt" });
    const store = kv({
      ["sqord:ord_1"]: JSON.stringify({ tenantId: TENANT, bookingIds: [BOOKING_ID], kind: "full" }),
    });
    const saved: Array<Record<string, unknown>> = [];
    const raw = JSON.stringify({
      event_id: "evt_order_done",
      type: "order.updated",
      data: { object: { order_updated: { order_id: "ord_1", state: "COMPLETED" } } },
    });
    const signature = await squareWebhookSignature(signatureKey, notificationUrl, raw);
    const res = await handleSquareHttp(
      new Request("https://schedi.app/api/webhooks/square", {
        method: "POST",
        headers: { "x-square-hmacsha256-signature": signature },
        body: raw,
      }),
      {
        AUTH_KV: store,
        SQUARE_WEBHOOK_SIGNATURE_KEY: signatureKey,
        SQUARE_TOKEN_KEY: key.b64,
        SQUARE_APPLICATION_ID: "sq0idp-test",
        SQUARE_APPLICATION_SECRET: "secret",
      },
      "",
      "/api/webhooks/square",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        loadConnection: async () => ({
          merchantId: "MERCHANT",
          cipher,
          expiresAt: new Date(Date.now() + 10 * 86400000).toISOString(),
          locationId: "LOC",
        }),
        loadAppointments: async () => [booking({ squareOrderId: "ord_1" })],
        saveAppointments: async (_env: unknown, _token: string, _tenantId: string, appointments: Array<Record<string, unknown>>) => {
          saved.push(appointments[0]);
        },
        squareFetch: vi.fn(async (url: string) => {
          const u = String(url);
          if (u.includes("/v2/orders/ord_1")) {
            return jsonResponse({ order: { id: "ord_1", state: "COMPLETED", tenders: [{ payment_id: "pay_ord" }] } });
          }
          if (u.includes("/v2/payments/pay_ord")) {
            return jsonResponse({
              payment: { id: "pay_ord", status: "COMPLETED", order_id: "ord_1", amount_money: { amount: 2500, currency: "USD" } },
            });
          }
          return jsonResponse({}, 404);
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(saved[0]).toMatchObject({ paymentStatus: "PAID", squarePaymentId: "pay_ord", squareAmountCents: 2500 });
  });

  it("asks Square to retry when the order lookup fails", async () => {
    const key = await tokenKey();
    const cipher = await encryptSquareTokens(key.raw, { accessToken: "sq_at", refreshToken: "sq_rt" });
    const store = kv({
      ["sqord:ord_1"]: JSON.stringify({ tenantId: TENANT, bookingIds: [BOOKING_ID], kind: "full" }),
    });
    let saves = 0;
    const raw = JSON.stringify({
      event_id: "evt_order_retry",
      type: "order.updated",
      data: { object: { order_updated: { order_id: "ord_1", state: "COMPLETED" } } },
    });
    const signature = await squareWebhookSignature(signatureKey, notificationUrl, raw);
    const res = await handleSquareHttp(
      new Request("https://schedi.app/api/webhooks/square", {
        method: "POST",
        headers: { "x-square-hmacsha256-signature": signature },
        body: raw,
      }),
      {
        AUTH_KV: store,
        SQUARE_WEBHOOK_SIGNATURE_KEY: signatureKey,
        SQUARE_TOKEN_KEY: key.b64,
        SQUARE_APPLICATION_ID: "sq0idp-test",
        SQUARE_APPLICATION_SECRET: "secret",
      },
      "",
      "/api/webhooks/square",
      {
        json: (body: unknown, status = 200) => jsonResponse(body, status),
        loadConnection: async () => ({
          merchantId: "MERCHANT",
          cipher,
          expiresAt: new Date(Date.now() + 10 * 86400000).toISOString(),
          locationId: "LOC",
        }),
        loadAppointments: async () => [booking()],
        saveAppointments: async () => { saves += 1; },
        squareFetch: vi.fn(async () => jsonResponse({ errors: [{ code: "SERVICE_UNAVAILABLE" }] }, 503)),
      },
    );
    expect(res.status).toBe(503);
    expect(saves).toBe(0);
  });
});
