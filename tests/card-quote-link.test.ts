import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { bookingPayFromSearch, fillBookingDocument } from "../worker/booking-document";
import { handleRequest, type SchediEnv } from "../worker/handler";

vi.mock("../workers/schedi-email-worker/src/firebase-admin.js", () => ({
  adminAccessToken: vi.fn(async () => "access"),
  adminAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer access", "Content-Type": "application/json" })),
}));

import {
  CARD_LINK_LATER_COPY,
  awaitingCardQuote,
  catalogChargeDollars,
  createQuotedPayLink,
  ownerQuotedDollars,
  quoteAmountCents,
  quotedPayEmail,
} from "../workers/schedi-email-worker/src/card-quote-link.js";
import { handlePrivateBookingHttp, loadPrivateRoster } from "../workers/schedi-email-worker/src/private-bookings.js";

const TENANT = "acme";
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const bookingHtml = readFileSync(new URL("../site/booking.html", import.meta.url), "utf8");
const workerIndex = readFileSync(new URL("../workers/schedi-email-worker/src/index.js", import.meta.url), "utf8");

function kv(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function envWith(store = kv()) {
  return {
    FIREBASE_API_KEY: "test-key",
    FIREBASE_PROJECT_ID: "siteforge-97699",
    FIREBASE_APP_ID: "siteforge-97699",
    AUTH_KV: store,
    RL_BOOKING_CREATE: null,
    RL_MAIL: null,
  };
}

let restoreFetch: typeof fetch;

beforeEach(() => {
  restoreFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("identitytoolkit.googleapis.com")) {
      return new Response(JSON.stringify({ idToken: "tok" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = restoreFetch;
  vi.clearAllMocks();
});

function quoteBooking(extra: Record<string, unknown> = {}) {
  return {
    id: "BK-QUOTE1",
    tenantId: TENANT,
    clientName: "Ada Lovelace",
    clientEmail: "ada@example.com",
    clientPhone: "555-0100",
    serviceName: "Consult",
    date: "2026-10-21",
    time: "10:00 AM",
    durationMins: 60,
    paymentMethod: "card",
    paymentStatus: "AWAITING CARD LINK",
    paymentOptionLabel: "Card",
    status: "pending",
    createdAt: "2026-10-20T12:00:00.000Z",
    ...extra,
  };
}

function business(extra: Record<string, unknown> = {}) {
  return {
    id: TENANT,
    name: "Acme",
    slug: "acme",
    plan: "pro",
    ownerEmail: "owner@example.com",
    paymentGateways: { card: true },
    stripeConnectReady: true,
    services: [{ id: "svc1", name: "Consult", durationMins: 60 }],
    ...extra,
  };
}

function deps(biz: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    json,
    isAllowedOrigin: () => true,
    getTenantById: vi.fn(async (env: { AUTH_KV: ReturnType<typeof kv> }, _token: string, tenantId: string) => ({
      ...biz,
      id: tenantId,
      appointments: (await loadPrivateRoster(env, tenantId)).appointments,
    })),
    listAllTenants: vi.fn(async () => []),
    notifyOwnerOfNewBookings: vi.fn(async () => {}),
    sendResend: vi.fn(async () => ({ ok: true })),
    fetchImpl: vi.fn(async () => json({ ok: true, mode: "connect", url: "https://buy.stripe.com/test_quote_abc" })),
    ...extra,
  };
}

function post(body: unknown) {
  return new Request("https://schedi.app/api/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://schedi.app", "CF-Connecting-IP": "203.0.113.90" },
    body: JSON.stringify(body),
  });
}

function putSession(env: ReturnType<typeof envWith>, token: string) {
  env.AUTH_KV.store.set("session:" + token, JSON.stringify({
    role: "owner",
    tenantId: TENANT,
    exp: Date.now() + 3_600_000,
  }));
}

async function seed(env: ReturnType<typeof envWith>, booking = quoteBooking()) {
  await env.AUTH_KV.put("privateAppts:" + TENANT, JSON.stringify({ revision: 1, appointments: [booking] }));
}

describe("quoted card amount", () => {
  it("keeps a catalog price ahead of a stored amount", () => {
    const booking = quoteBooking({ amount: 80, paymentStatus: "AWAITING CARD CHECKOUT" });
    expect(ownerQuotedDollars(booking, 40)).toBeNull();
    expect(ownerQuotedDollars(booking, null)).toBe(80);
    expect(ownerQuotedDollars(quoteBooking(), null)).toBeNull();
    expect(ownerQuotedDollars(quoteBooking({ amount: 0.25, paymentStatus: "AWAITING CARD CHECKOUT" }), null)).toBeNull();
    expect(catalogChargeDollars(
      { services: [{ name: "Consult", price: 40 }] },
      quoteBooking({ amount: 80 }),
    )).toBe(40);
    expect(catalogChargeDollars(
      { services: [{ name: "Consult" }] },
      quoteBooking({ amount: 80 }),
    )).toBeNull();
  });

  it("accepts a quote from fifty cents through ten thousand dollars", () => {
    expect(quoteAmountCents(0.49)).toBe(0);
    expect(quoteAmountCents(0.5)).toBe(50);
    expect(quoteAmountCents(80)).toBe(8000);
    expect(quoteAmountCents(10000.01)).toBe(0);
    expect(awaitingCardQuote(quoteBooking())).toBe(true);
    expect(awaitingCardQuote(quoteBooking({ paymentStatus: "PAID" }))).toBe(false);
  });

  it("uses the short Payment Link and refuses when Connect is unavailable", async () => {
    const connect = vi.fn(async () => json({ ok: true, mode: "connect", url: "https://buy.stripe.com/test_quote_abc" }));
    const ok = await createQuotedPayLink(connect, {
      slug: "acme",
      tenantId: TENANT,
      bookingId: "BK-QUOTE1",
      email: "ada@example.com",
      serviceName: "Consult",
      amountCents: 8000,
    });
    expect(ok).toMatchObject({ url: "https://buy.stripe.com/test_quote_abc", via: "connect", connectStatus: 200 });

    const denied = vi.fn(async () => json({ error: "connect_unavailable" }, 409));
    const refused = await createQuotedPayLink(denied, {
      slug: "acme",
      tenantId: TENANT,
      bookingId: "BK-QUOTE1",
      email: "ada@example.com",
      amountCents: 8000,
    });
    expect(refused).toMatchObject({ url: "", via: "", connectStatus: 409, error: "connect_not_ready" });

    const mail = quotedPayEmail({
      businessName: "Acme",
      serviceName: "Consult",
      amount: 80,
      url: "https://buy.stripe.com/test_quote_abc",
      when: "2026-10-21 at 10:00 AM",
    });
    expect(mail.subject).toBe("Pay by card \u2014 Acme");
    expect(mail.text).toContain("https://buy.stripe.com/test_quote_abc");
    expect(mail.text).toContain("Nothing is charged until you open it.");
    expect(mail.html).toContain("Nothing is charged until you open it.");
  });
});

describe("send_card_link", () => {
  it("emails the Connect link and stores the amount the owner entered", async () => {
    const env = envWith();
    putSession(env, "owner-token");
    await seed(env);
    const used = deps(business());
    const res = await handlePrivateBookingHttp(
      post({ action: "send_card_link", session: "owner-token", tenantId: TENANT, bookingId: "BK-QUOTE1", amount: 80 }),
      env,
      "https://schedi.app",
      "/api/bookings",
      used,
      {},
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.via).toBe("connect");
    expect(data.url).toBe("https://buy.stripe.com/test_quote_abc");
    expect(data.amount).toBe(80);
    const sent = used.sendResend.mock.calls[0][1];
    expect(sent.to).toBe("ada@example.com");
    expect(sent.fromAddress).toBe("bookings@schedi.app");
    expect(sent.text).toContain("https://buy.stripe.com/test_quote_abc");
    expect(sent.text).toContain("Nothing is charged until you open it.");
    const stored = (await loadPrivateRoster(env, TENANT)).appointments[0];
    expect(stored.amount).toBe(80);
    expect(stored.paymentStatus).toBe("AWAITING CARD CHECKOUT");
  });

  it("does not email a link when Connect returns 409", async () => {
    const env = envWith();
    putSession(env, "owner-token");
    await seed(env);
    const used = deps(business(), {
      fetchImpl: vi.fn(async () => json({ error: "connect_unavailable" }, 409)),
    });
    const res = await handlePrivateBookingHttp(
      post({ action: "send_card_link", session: "owner-token", tenantId: TENANT, bookingId: "BK-QUOTE1", amount: 42.5 }),
      env,
      "https://schedi.app",
      "/api/bookings",
      used,
      {},
    );
    const data = await res.json();
    expect(res.status).toBe(409);
    expect(data.error).toBe("connect_not_ready");
    expect(data.message).toBe("Card payments are not ready for this business. Nothing was charged.");
    expect(used.sendResend).not.toHaveBeenCalled();
    const stored = (await loadPrivateRoster(env, TENANT)).appointments[0];
    expect(stored.amount).toBeUndefined();
    expect(stored.paymentStatus).toBe("AWAITING CARD LINK");
  });

  it("refuses before any Stripe call when the connected account is not ready", async () => {
    const env = envWith();
    putSession(env, "owner-token");
    await seed(env);
    const used = deps(business({ stripeConnectReady: false }));
    const res = await handlePrivateBookingHttp(
      post({ action: "send_card_link", session: "owner-token", tenantId: TENANT, bookingId: "BK-QUOTE1", amount: 80 }),
      env,
      "https://schedi.app",
      "/api/bookings",
      used,
      {},
    );
    const data = await res.json();
    expect(res.status).toBe(409);
    expect(data.error).toBe("connect_not_ready");
    expect(used.fetchImpl).not.toHaveBeenCalled();
    expect(used.sendResend).not.toHaveBeenCalled();
  });

  it("refuses a catalog price, a tiny amount, card turned off, and a missing session", async () => {
    const env = envWith();
    putSession(env, "owner-token");
    await seed(env);
    const priced = await handlePrivateBookingHttp(
      post({ action: "send_card_link", session: "owner-token", tenantId: TENANT, bookingId: "BK-QUOTE1", amount: 80 }),
      env,
      "https://schedi.app",
      "/api/bookings",
      deps(business({ services: [{ id: "svc1", name: "Consult", price: 25, durationMins: 60 }] })),
      {},
    );
    expect(priced.status).toBe(400);
    expect((await priced.json()).error).toBe("not_card_quote");

    const tiny = await handlePrivateBookingHttp(
      post({ action: "send_card_link", session: "owner-token", tenantId: TENANT, bookingId: "BK-QUOTE1", amount: 0.1 }),
      env,
      "https://schedi.app",
      "/api/bookings",
      deps(business()),
      {},
    );
    expect(tiny.status).toBe(400);
    expect((await tiny.json()).error).toBe("amount_too_small");

    const off = await handlePrivateBookingHttp(
      post({ action: "send_card_link", session: "owner-token", tenantId: TENANT, bookingId: "BK-QUOTE1", amount: 80 }),
      env,
      "https://schedi.app",
      "/api/bookings",
      deps(business({ paymentGateways: { card: false } })),
      {},
    );
    expect(off.status).toBe(400);
    expect((await off.json()).error).toBe("card_checkout_off");

    const anon = await handlePrivateBookingHttp(
      post({ action: "send_card_link", tenantId: TENANT, bookingId: "BK-QUOTE1", amount: 80 }),
      env,
      "https://schedi.app",
      "/api/bookings",
      deps(business()),
      {},
    );
    expect(anon.status).toBe(401);
  });
});

describe("booking page card copy", () => {
  it("offers card on an unpriced service and says when the client pays now", () => {
    for (const html of [indexHtml, bookingHtml]) {
      expect(html).toContain("function cardPayMode(price, depositRequired, cardOn, plan)");
      expect(html).toContain("You'll pay now by card.");
      expect(html).toContain(CARD_LINK_LATER_COPY);
      expect(html).toContain("You'll pay now by card. Checkout did not open, so we emailed you a secure payment link. Nothing is charged until you open it.");
      expect(html).toContain("if (cardChargeCents >= 50) startPayNowCheckout = openPayNowCheckout;");
      expect(html).not.toContain("This service has no price set, so card checkout is unavailable.");
      expect(html).toContain("return platformAttempt(0);");
      expect(html).toContain("tenantData.stripeConnectReady !== true");
      expect(html).toContain("tenantData.stripeConnectReady === true");
    }
    expect(indexHtml).toContain("Set up Stripe");
    expect(indexHtml).toContain("https://schedi-connect-production.up.railway.app/portal");
    expect(indexHtml).toContain("https://schedi-connect-production.up.railway.app/portal#stripe-setup");
    const syncAt = bookingHtml.indexOf("function syncBookingsToFirestore");
    const sync = bookingHtml.slice(syncAt, bookingHtml.indexOf("document.getElementById('resCode')", syncAt));
    const createdAt = sync.indexOf("var created = !!(out && out.ok && out.data && out.data.ok);");
    const startAt = sync.indexOf("if (startPayNowCheckout)");
    const parentAt = sync.indexOf("if (window.parent === window) return;");
    expect(createdAt).toBeGreaterThan(0);
    expect(startAt).toBeGreaterThan(createdAt);
    expect(parentAt).toBeGreaterThan(startAt);
    const reject = "out.data.error === 'too_soon' || out.data.error === 'slot_taken' || out.data.error === 'slot_unavailable'";
    expect(sync.split(reject)).toHaveLength(3);
    expect(sync.indexOf("if (out && !out.ok && out.data && (" + reject + ")) return;")).toBeLessThan(sync.indexOf("type: 'NEW_BOOKING_SUBMITTED'"));
  });

  it("puts the same sentence in the request email and keeps the pay-now link off that email", () => {
    const statusCheck = indexHtml.indexOf("if (cardPayStatus.indexOf('AWAITING CARD LINK') !== -1)");
    expect(statusCheck).toBeGreaterThan(0);
    const email = indexHtml.slice(statusCheck, statusCheck + 4000);
    expect(email).toContain("cardLinkLater = true");
    expect(email.indexOf("cardPayUrl = candidate")).toBeGreaterThan(0);
    expect(email.indexOf("cardLinkLater = true")).toBeLessThan(email.indexOf("cardPayUrl = candidate"));
    expect(indexHtml.slice(statusCheck, statusCheck + 1200)).toContain(CARD_LINK_LATER_COPY);
    const notes = indexHtml.indexOf("if (cardLinkLater)", statusCheck);
    expect(notes).toBeGreaterThan(statusCheck);
    expect(indexHtml.slice(notes, notes + 600)).toContain("safe(cardLinkLaterCopy)");
  });

  it("charges an owner quote as the full card amount even when a deposit is on", () => {
    const start = workerIndex.indexOf("async function handleBookingCheckout");
    const fn = workerIndex.slice(start, workerIndex.indexOf("\nasync function ", start + 20));
    expect(fn).toContain("if (quotedFull) purpose = 'card'");
    expect(fn).toContain("if (quoted != null) price = quoted");
    expect(fn).toContain("ownerQuotedDollars(booking, catalogChargeDollars(tenant, booking))");
  });
});

describe("email pay link opens Stripe", () => {
  function tenantFetch() {
    return vi.fn(async () => new Response(JSON.stringify({
      fields: {
        name: { stringValue: "Bright Cuts" },
        slug: { stringValue: "bright-cuts" },
        plan: { stringValue: "pro" },
        subscriptionStatus: { stringValue: "active" },
        acceptingBookings: { booleanValue: true },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }

  function pageEnv(): SchediEnv {
    return {
      FIREBASE_PROJECT_ID: "siteforge-97699",
      ASSETS: {
        async fetch(request: Request) {
          const path = new URL(request.url).pathname;
          if (path !== "/booking.html") return new Response("missing", { status: 404 });
          return new Response(bookingHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
        },
      },
    };
  }

  it("keeps only a real checkout flag and booking id", () => {
    expect(bookingPayFromSearch("?pay=checkout&booking=BK-QUOTE01&kind=card&bookings=BK-SECOND1")).toEqual({
      flag: "checkout",
      kind: "card",
      booking: "BK-QUOTE01",
      bookings: "BK-SECOND1",
    });
    expect(bookingPayFromSearch("?pay=checkout%22;alert(1)&booking=%3Cscript%3E")).toEqual({
      flag: "",
      kind: "",
      booking: "",
      bookings: "",
    });
    expect(bookingPayFromSearch("")).toEqual({ flag: "", kind: "", booking: "", bookings: "" });
  });

  it("sends the email pay=checkout link straight to Stripe's card-pay redirect", async () => {
    globalThis.fetch = tenantFetch() as typeof fetch;
    const payUrl = "https://schedi.app/bright-cuts/?pay=checkout&booking=BK-QUOTE01&kind=card&bookings=BK-SECOND1";
    const response = await handleRequest(new Request(payUrl), pageEnv(), { waitUntil() {} });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://schedi.app/billing/card-pay?t=bright-cuts&b=BK-QUOTE01&kind=card&ids=BK-SECOND1",
    );

    const filled = fillBookingDocument(bookingHtml, {
      slug: "bright-cuts",
      fields: { name: "Bright Cuts" },
      pay: "?pay=checkout&booking=BK-QUOTE01&kind=card",
    });
    expect(filled).toContain('var SCHEDULE_PAY_RETURN = "checkout";');
    expect(filled).toContain('class="dark schedi-newbook schedi-pay-handoff"');
    expect(filled).toContain("Taking you to secure payment…");
    expect(filled).toContain("html.schedi-pay-handoff body > main { display: none !important; }");
    expect(filled).not.toContain("__SCHEDI_PAY_FLAG__");

    const plain = fillBookingDocument(bookingHtml, { slug: "bright-cuts", fields: { name: "Bright Cuts" } });
    expect(plain).toContain('var SCHEDULE_PAY_RETURN = "";');
    expect(plain).toContain('class="dark schedi-newbook"');
    expect(plain).not.toContain('class="dark schedi-newbook schedi-pay-handoff"');
    expect(plain).not.toContain('var SCHEDULE_PAY_RETURN = "checkout";');
  });

  it("does not bake a broken pay query into the page script", async () => {
    globalThis.fetch = tenantFetch() as typeof fetch;
    const response = await handleRequest(
      new Request("https://schedi.app/bright-cuts/?pay=checkout%22%3Balert(1)&booking=%3Cscript%3E"),
      pageEnv(),
      { waitUntil() {} },
    );
    const html = await response.text();
    expect(html).toContain('var SCHEDULE_PAY_RETURN = "";');
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain('var SCHEDULE_PAY_BOOKING = "<script>"');
  });
});

describe("owner dashboard quote form", () => {
  it("asks for the amount on the new-dashboard request and sends the existing link action", () => {
    const owner = indexHtml.slice(0, indexHtml.indexOf("return `<!DOCTYPE html>"));
    expect(owner).toContain("function cardQuotePayHtml(app)");
    expect(owner).toContain("cardQuotePayHtml(app)");
    expect(owner).toContain("Enter the price. We\\'ll email the client a secure card payment link.");
    expect(owner).toContain("Send payment link");
    expect(owner).toContain("cardQuoteAmt-");
    expect(owner).toContain("action: 'send_card_link'");
    expect(owner).toContain("paymentStatus = 'AWAITING CARD CHECKOUT'");
    expect(owner).toContain("rememberRosterRevision(tenant, out.data)");
    expect(owner).toContain("The payment link was not sent. Nothing was charged.");
    expect(owner).toContain("Payment link emailed. Nothing is charged until the client opens it.");
    const dashCss = indexHtml.slice(indexHtml.indexOf('<style id="schediNewDashStyle">'), indexHtml.indexOf("</style>", indexHtml.indexOf("schediNewDashStyle")));
    expect(dashCss).toContain("#tenantPortalSection.schedi-newdash .sd-quote-pay");
    expect(dashCss).toContain("#tenantPortalSection.schedi-newdash .sd-quote-amt");
  });
});
