import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerBillingScheduleAction } from "../workers/schedi-email-worker/src/owner-billing-schedule.js";

vi.mock("../workers/schedi-email-worker/src/firebase-admin.js", () => ({
  adminAccessToken: vi.fn(async () => "access"),
  adminAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer access", "Content-Type": "application/json" })),
}));

import worker from "../workers/schedi-email-worker/src/index.js";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const bookingHtml = readFileSync(new URL("../site/booking.html", import.meta.url), "utf8");

const TENANT = "axeldelcidphotography";
const BOOKING = "BK-CB126C75";
const TOKEN = "a".repeat(36);
const STRIPE_URL = "https://checkout.stripe.com/c/pay/cs_test_deposit";
const CONNECT_URL = "https://buy.stripe.com/test_deposit";

function extractFunction(source: string, name: string): string {
  const start = source.indexOf("function " + name);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("could not extract " + name);
}

const page = new Function(
  `${extractFunction(bookingHtml, "schediCardPayHref")}
   ${extractFunction(bookingHtml, "cardPayApiUrl")}
   ${extractFunction(bookingHtml, "cardNowConfirmNote")}
   return { schediCardPayHref, cardPayApiUrl, cardNowConfirmNote };`,
)() as {
  schediCardPayHref: (value: string) => boolean;
  cardPayApiUrl: (slug: string, ids: string[], token: string, kind: string) => string;
  cardNowConfirmNote: (quote: { required?: boolean; deposit?: number; balance?: number | null }, emailed: boolean) => string;
};

function fsValue(value: unknown): unknown {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(fsValue) } };
  if (typeof value === "object") {
    const fields: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) fields[key] = fsValue(item);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function kv(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
  };
}

function payEnv() {
  return {
    FIREBASE_API_KEY: "test-key",
    FIREBASE_PROJECT_ID: "siteforge-97699",
    FIREBASE_APP_ID: "siteforge-97699",
    STRIPE_SECRET_KEY: "sk_test_dummy",
    AUTH_KV: kv({
      ["privateAppts:" + TENANT]: JSON.stringify({
        revision: 1,
        appointments: [{
          id: BOOKING,
          tenantId: TENANT,
          manageToken: TOKEN,
          clientEmail: "client@example.com",
          serviceName: "Portrait Photoshoot",
          paymentMethod: "card",
          paymentStatus: "AWAITING CHECKOUT",
          status: "pending",
          depositAmount: 1,
          depositPaid: false,
          balanceDue: null,
          date: "2026-10-22",
          time: "10:00 AM",
        }],
      }),
    }),
    RL_MAIL: null,
  };
}

function payRequest(query: string) {
  return new Request("https://schedi.app/billing/card-pay" + query, {
    method: "GET",
    headers: { "CF-Connecting-IP": "203.0.113.40" },
  });
}

describe("booking page card confirmation", () => {
  it("does not throw on an unpriced deposit and says when the email has the link", () => {
    for (const html of [indexHtml, bookingHtml]) {
      expect(html).toContain("function cardNowConfirmNote(quote, emailed)");
      expect(html).toContain("We emailed you a secure payment link.");
      expect(html).not.toContain("depositQuote.balance.toFixed");
      expect(html).toContain("cardNowConfirmNote(depositQuote, !!(cardPayUrl && cardMailOn))");
      expect(html).toContain("if (openSchediCardPay(cardPayUrl)) return Promise.resolve();");
      expect(html).toContain("if (cardChargeCents >= 50) startPayNowCheckout = openPayNowCheckout;");
      expect(html).toContain("Pay now");
      expect(html).toContain('id="resCheckoutBtn"');
    }
    const unpriced = page.cardNowConfirmNote({ required: true, deposit: 1, balance: null }, true);
    expect(unpriced).toBe("You'll pay now by card. The deposit is $1.00. The rest is due at the appointment. We emailed you a secure payment link.");
    const priced = page.cardNowConfirmNote({ required: true, deposit: 1, balance: 249 }, true);
    expect(priced).toBe("You'll pay now by card. The deposit is $1.00. $249.00 is due at the appointment. We emailed you a secure payment link.");
    expect(page.cardNowConfirmNote({ required: false }, false)).toBe("You'll pay now by card.");
    expect(() => page.cardNowConfirmNote({ required: true, deposit: 1, balance: null }, false)).not.toThrow();
  });

  it("puts a schedi.app card-pay URL on the email and the Pay now button", () => {
    const url = page.cardPayApiUrl(TENANT, [BOOKING, "BK-SECOND01"], TOKEN, "deposit");
    expect(url).toBe(
      "https://schedi.app/billing/card-pay?t=axeldelcidphotography&b=BK-CB126C75&k=" + TOKEN + "&kind=deposit&ids=BK-SECOND01",
    );
    expect(page.schediCardPayHref(url)).toBe(true);
    expect(page.schediCardPayHref("https://schedi.app/" + TENANT + "/?pay=checkout&booking=" + BOOKING + "&kind=deposit")).toBe(true);
    expect(page.schediCardPayHref("https://checkout.stripe.com/c/pay/cs_test")).toBe(false);
    expect(page.schediCardPayHref("https://schedi.app/" + TENANT + "/")).toBe(false);
    expect(page.cardPayApiUrl(TENANT, [BOOKING], "short", "deposit")).toBe("");
    expect(bookingHtml).toContain("cardPayUrl = cardPayApiUrl(");
    expect(bookingHtml).toContain('>Pay by card</a>');
    expect(ownerBillingScheduleAction("/billing/card-pay")).toBeNull();
  });
});

describe("GET /billing/card-pay", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch(connect: { status: number; body: unknown }, stripeUrl = STRIPE_URL) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.includes("identitytoolkit.googleapis.com")) return Response.json({ idToken: "tok" });
      if (url.includes("/private/data/tenants/")) return new Response("{}", { status: 404 });
      if (url.includes("/public/data/tenants/")) {
        return Response.json({
          fields: (fsValue({
            id: TENANT,
            slug: TENANT,
            name: "Axel Del Cid Photography",
            plan: "pro",
            paymentGateways: { card: true },
            deposit: { enabled: true, type: "fixed", amount: 1, percent: 0 },
            services: [{ id: "1", name: "Portrait Photoshoot", durationMins: 60, price: null }],
          }) as { mapValue: { fields: unknown } }).mapValue.fields,
        });
      }
      if (url.includes("/api/public-checkout")) return Response.json(connect.body, { status: connect.status });
      if (url.includes("api.stripe.com/v1/checkout/sessions")) return Response.json({ id: "cs_test_deposit", url: stripeUrl });
      return new Response("unexpected " + url, { status: 500 });
    }));
    return calls;
  }

  it("redirects an unpriced $1 deposit to Stripe after Connect is unavailable", async () => {
    const calls = stubFetch({ status: 409, body: { ok: false, error: "connect_unavailable" } });
    const res = await worker.fetch(
      payRequest("?t=" + TENANT + "&b=" + BOOKING + "&k=" + TOKEN + "&kind=deposit"),
      payEnv(),
      { waitUntil() {} },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(STRIPE_URL);
    expect(calls.some((url) => url.includes("api.stripe.com/v1/checkout/sessions"))).toBe(true);
    expect(calls.some((url) => url.includes("/api/public-checkout"))).toBe(true);
    const stripeCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find((call) => String(call[0]).includes("api.stripe.com"));
    const decoded = decodeURIComponent(String(stripeCall?.[1]?.body || ""));
    expect(decoded).toContain("[unit_amount]=100");
    expect(decoded).toContain("[purpose]=deposit");
  });

  it("prefers the connected account payment link when Connect is ready", async () => {
    stubFetch({ status: 200, body: { ok: true, mode: "connect", url: CONNECT_URL } });
    const res = await worker.fetch(
      payRequest("?t=" + TENANT + "&b=" + BOOKING + "&k=" + TOKEN + "&kind=deposit"),
      payEnv(),
      { waitUntil() {} },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(CONNECT_URL);
  });

  it("rejects a bad token and a non-Stripe checkout URL without leaving the payment page", async () => {
    const calls = stubFetch({ status: 409, body: { ok: false, error: "connect_unavailable" } }, "https://evil.example/phish");
    const bad = await worker.fetch(
      payRequest("?t=" + TENANT + "&b=" + BOOKING + "&k=" + "b".repeat(36) + "&kind=deposit"),
      payEnv(),
      { waitUntil() {} },
    );
    expect(bad.status).toBe(400);
    const badHtml = await bad.text();
    expect(badHtml).toContain("This payment link is not valid.");
    expect(badHtml).not.toContain("/?pay=checkout");
    expect(bad.headers.get("location")).toBeNull();
    expect(calls.some((url) => url.includes("api.stripe.com") || url.includes("public-checkout"))).toBe(false);

    const phish = await worker.fetch(
      payRequest("?t=" + TENANT + "&b=" + BOOKING + "&k=" + TOKEN + "&kind=deposit"),
      payEnv(),
      { waitUntil() {} },
    );
    expect(phish.status).toBeGreaterThanOrEqual(400);
    expect(phish.headers.get("location")).toBeNull();
    expect(await phish.text()).toContain("Nothing was charged.");
  });
});
