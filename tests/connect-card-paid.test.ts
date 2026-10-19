import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { applyCardCheckoutPayment, centsByBooking } from "../workers/schedi-email-worker/src/card-payment.js";
import { handleConnectBookingPaid } from "../workers/schedi-email-worker/src/connect-booking-paid.js";
import { loadPrivateRoster, persistTenantAppointments } from "../workers/schedi-email-worker/src/private-bookings.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

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

const chipApi = new Function(`
  ${extractFunction(html, "esc")}
  ${extractFunction(html, "roundMoney")}
  ${extractFunction(html, "hasPricedAmount")}
  ${extractFunction(html, "formatBookingAmountLabel")}
  ${extractFunction(html, "bookingPaymentState")}
  ${extractFunction(html, "inferPaidMethodFromBooking")}
  ${extractFunction(html, "appointmentPayKind")}
  ${extractFunction(html, "payKindSvg")}
  var ROSTER_PAY_WORDS = { unpaid: "Unpaid", card: "Card", cash: "In person / Cash" };
  ${extractFunction(html, "appointmentIsCancelled")}
  ${extractFunction(html, "appointmentIsNoShow")}
  ${extractFunction(html, "appointmentPaymentSlot")}
  ${extractFunction(html, "appointmentPaidChipMoney")}
  ${extractFunction(html, "appointmentPayMarkup")}
  ${extractFunction(html, "appointmentStatusParts")}
  ${extractFunction(html, "appointmentStatusPriceHtml")}
  ${extractFunction(html, "appointmentStatusLabels")}
  return { appointmentPayMarkup, appointmentStatusLabels };
`)() as {
  appointmentPayMarkup: (app: Record<string, unknown>) => string;
  appointmentStatusLabels: (app: Record<string, unknown>) => string[];
};

function unpaidVisit(extra: Record<string, unknown> = {}) {
  return {
    id: "HB-1003",
    clientName: "Jordan Lee",
    serviceName: "Gloss",
    status: "accepted",
    paymentStatus: "PAY AT APPOINTMENT",
    paymentMethod: "later",
    amount: 80,
    ...extra,
  };
}

describe("connect card payment on the owner dashboard", () => {
  it("marks a full card payment as Card with the amount paid", () => {
    const applied = applyCardCheckoutPayment(unpaidVisit(), {
      purpose: "card",
      amountCents: 8000,
      paymentIntentId: "pi_3NxCard80",
    });
    expect(applied.changed).toBe(true);
    expect(applied.booking.paymentStatus).toBe("PAID VIA CARD");
    expect(applied.booking.paidMethod).toBe("card");
    expect(applied.booking.paymentMethod).toBe("card");
    expect(applied.booking.amount).toBe(80);
    expect(applied.booking.stripePaymentIntentId).toBe("pi_3NxCard80");
    const chip = chipApi.appointmentPayMarkup(applied.booking);
    expect(chip).toContain('aria-label="Card · $80"');
    expect(chip).toContain(">Card<");
    expect(chip).toContain('class="sd-pay-amt"> · $80<');
    expect(chip).toContain("sd-pay-card");
  });

  it("marks a deposit as the deposit amount and ignores a replay", () => {
    const first = applyCardCheckoutPayment(unpaidVisit({ amount: 120, depositAmount: 36 }), {
      purpose: "deposit",
      amountCents: 3600,
      paymentIntentId: "pi_dep",
    });
    expect(first.booking.paymentStatus).toBe("DEPOSIT PAID");
    expect(first.booking.depositPaid).toBe(true);
    expect(first.booking.depositAmount).toBe(36);
    expect(first.booking.amount).toBe(120);
    expect(first.booking.balanceDue).toBe(84);
    expect(first.booking.paidMethod).toBe("card");
    expect(chipApi.appointmentPayMarkup(first.booking)).toContain('aria-label="Card · $36"');
    expect(chipApi.appointmentStatusLabels(first.booking)).toEqual(["Accepted", "Deposit paid · $36"]);
    const replay = applyCardCheckoutPayment(first.booking, {
      purpose: "deposit",
      amountCents: 3600,
      paymentIntentId: "pi_dep",
    });
    expect(replay.duplicate).toBe(true);
    expect(replay.changed).toBe(false);
    expect(replay.booking).toBe(first.booking);
  });

  it("gives one booking the checkout total and keeps split cents", () => {
    expect(centsByBooking(["HB-1003"], 8000, "")).toEqual({ "HB-1003": 8000 });
    expect(centsByBooking(["HB-1", "HB-2"], 10000, "")).toEqual({});
    expect(centsByBooking(["HB-1", "HB-2"], 10000, "HB-1:3600,HB-2:6400")).toEqual({ "HB-1": 3600, "HB-2": 6400 });
  });

  it("rejects a connect paid notice without the shared secret", async () => {
    const markPaid = vi.fn(async () => ({ ok: true }));
    const res = await handleConnectBookingPaid(
      new Request("https://schedi.app/billing/connect-booking-paid", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: "harbor", bookingIds: ["HB-1003"], purpose: "card", amountCents: 8000 }),
      }),
      { SCHEDI_CONNECT_PAID_SECRET: "paid-secret" },
      { json: (body: unknown, status = 200) => Response.json(body, { status }), markPaid },
    );
    expect(res.status).toBe(401);
    expect(markPaid).not.toHaveBeenCalled();
  });

  it("keeps the payment intent on the private roster so a replay does not write again", async () => {
    const store = new Map<string, string>();
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value); },
    };
    const previous = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("identitytoolkit.googleapis.com")) {
        return Response.json({ idToken: "tok" });
      }
      if (url.includes("/slots")) return Response.json({ documents: [] });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const env = { AUTH_KV: kv, FIREBASE_API_KEY: "test-key", FIREBASE_PROJECT_ID: "p", FIREBASE_APP_ID: "p" };
      const visit = unpaidVisit();
      const applied = applyCardCheckoutPayment(visit, {
        purpose: "card",
        amountCents: 8000,
        paymentIntentId: "pi_3NxCard80",
        stripePaymentMethodId: "pm_card",
      });
      await persistTenantAppointments(env, "tok", "harbor", [applied.booking], {
        cards: { "HB-1003": { stripePaymentIntentId: "pi_3NxCard80", stripePaymentMethodId: "pm_card" } },
      });
      const saved = (await loadPrivateRoster(env, "harbor")).appointments.find((row: { id?: string }) => row.id === "HB-1003");
      expect(saved.paymentStatus).toBe("PAID VIA CARD");
      expect(saved.paidMethod).toBe("card");
      expect(saved.amount).toBe(80);
      expect(saved.stripePaymentIntentId).toBe("pi_3NxCard80");
      const replay = applyCardCheckoutPayment(saved, {
        purpose: "card",
        amountCents: 8000,
        paymentIntentId: "pi_3NxCard80",
      });
      expect(replay.duplicate).toBe(true);
      expect(chipApi.appointmentPayMarkup(saved)).toContain("Card · $80");
    } finally {
      globalThis.fetch = previous;
    }
  });
});
