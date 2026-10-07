import { describe, expect, it } from "vitest";
import { listPaymentOptions } from "../src/lib/payment-options";
import { isCardCheckoutReady, readCapabilityStatuses } from "../src/lib/readiness";
import { zonedTimeToUtc } from "../src/lib/slots";
import type { Business, Service } from "../src/lib/types";

function business(overrides: Partial<Business> = {}): Business {
  return {
    id: "biz",
    ownerId: "own",
    name: "Northwind Cuts",
    slug: "northwind",
    plan: "pro",
    subscriptionStatus: "active",
    stripeSubscriptionId: "sub",
    stripeAccountId: "acct_northwind",
    cardPaymentsStatus: "active",
    payoutsStatus: "active",
    depositEnabled: true,
    depositAmountCents: 2500,
    cashApp: "$north",
    zelle: "zelle@north.test",
    venmo: "@north",
    paypal: "leo@northwind.example",
    payAtAppointment: true,
    country: "US",
    ...overrides,
  };
}

const service: Service = {
  id: "svc",
  businessId: "biz",
  name: "Haircut",
  durationMinutes: 45,
  priceCents: 8000,
};

describe("card checkout gating", () => {
  it("requires active card payments and active payouts on the merchant configuration", () => {
    expect(
      readCapabilityStatuses({
        configuration: {
          merchant: {
            capabilities: {
              card_payments: { status: "active" },
              stripe_balance: { payouts: { status: "active" } },
            },
          },
        },
      }),
    ).toEqual({ cardPaymentsStatus: "active", payoutsStatus: "active" });

    expect(isCardCheckoutReady(business())).toBe(true);
    expect(isCardCheckoutReady(business({ cardPaymentsStatus: "pending" }))).toBe(false);
    expect(isCardCheckoutReady(business({ payoutsStatus: "restricted" }))).toBe(false);
    expect(isCardCheckoutReady(business({ plan: "starter" }))).toBe(false);
    expect(isCardCheckoutReady(business({ subscriptionStatus: "past_due" }))).toBe(false);
    expect(isCardCheckoutReady(business({ subscriptionStatus: "canceled" }))).toBe(false);
  });

  it("shows the card charge and deposit only when checkout is ready, and always keeps the other methods", () => {
    const ready = listPaymentOptions(business(), service).map((option) => option.value);
    expect(ready).toEqual([
      "card:full",
      "card:deposit",
      "cash_app",
      "zelle",
      "venmo",
      "paypal",
      "pay_at_appointment",
    ]);

    const waiting = listPaymentOptions(business({ cardPaymentsStatus: "pending", payoutsStatus: "pending" }), service).map(
      (option) => option.value,
    );
    expect(waiting).not.toContain("card:full");
    expect(waiting).not.toContain("card:deposit");
    expect(waiting).toEqual(["cash_app", "zelle", "venmo", "paypal", "pay_at_appointment"]);

    const noDeposit = listPaymentOptions(business({ depositEnabled: false }), service).map((option) => option.value);
    expect(noDeposit).toContain("card:full");
    expect(noDeposit).not.toContain("card:deposit");
  });

  it("converts a New York appointment time to UTC", () => {
    expect(zonedTimeToUtc(2026, 10, 5, 9).toISOString()).toBe("2026-10-05T13:00:00.000Z");
  });
});
