import { describe, expect, it } from "vitest";
import { placeBooking } from "../src/lib/bookings";
import { buildDirectChargeRequest } from "../src/lib/checkout";
import { isPublicPageLive } from "../src/lib/readiness";
import { upcomingSlots } from "../src/lib/slots";
import { createFakeStripe, keysDeep, memoryStore, seedProBusiness } from "./helpers";

const now = new Date("2026-10-03T15:00:00.000Z");

describe("direct client charges", () => {
  it("creates a deposit charge on the connected account with no platform fee", async () => {
    const store = memoryStore();
    const { business, service } = seedProBusiness(store);
    const stripe = createFakeStripe();
    const slot = upcomingSlots(now, new Set())[0]!;

    const { booking, redirectUrl } = await placeBooking(
      store,
      stripe,
      {
        slug: business.slug,
        serviceId: service.id,
        startsAt: slot,
        clientName: "Casey Client",
        clientEmail: "casey@example.com",
        method: "card",
        chargeKind: "deposit",
        successUrl: "https://schedi.test/b/northwind/booked?booking={BOOKING_ID}&session_id={CHECKOUT_SESSION_ID}",
        cancelUrl: "https://schedi.test/b/northwind?canceled=1",
      },
      now,
    );

    expect(redirectUrl).toBe("https://checkout.stripe.com/c/pay/cs_test");
    expect(booking.status).toBe("pending_payment");
    expect(booking.amountCents).toBe(2500);
    const call = stripe.calls.find((entry) => entry.method === "checkout.sessions.create");
    const params = call?.args[0] as {
      mode: string;
      line_items: Array<{ price_data: { unit_amount: number; product_data: { name: string; description: string } } }>;
      payment_intent_data: { description: string };
      integration_identifier: string;
      success_url: string;
    };
    const options = call?.args[1] as { stripeAccount?: string };
    expect(params.mode).toBe("payment");
    expect(params.line_items[0]?.price_data.unit_amount).toBe(2500);
    expect(params.line_items[0]?.price_data.product_data.name).toContain("Northwind Cuts");
    expect(params.line_items[0]?.price_data.product_data.description).toContain("collected in person");
    expect(params.payment_intent_data.description).toContain("Northwind Cuts");
    expect(params.integration_identifier).toMatch(/^schedi_booking_[a-z]{8}$/);
    expect(params.success_url).toContain(booking.id);
    expect(params.success_url).toContain("{CHECKOUT_SESSION_ID}");
    expect(options.stripeAccount).toBe("acct_northwind");
    expect(options).not.toHaveProperty("application_fee_amount");
    const keys = keysDeep(params);
    expect(keys.has("application_fee_amount")).toBe(false);
    expect(keys.has("application_fee_percent")).toBe(false);
    expect(keys.has("transfer_data")).toBe(false);
    expect(keys.has("on_behalf_of")).toBe(false);
    expect(keys.has("customer_account")).toBe(false);
    expect(keys.has("payment_method_types")).toBe(false);
    expect(isPublicPageLive(store.getBusiness(business.id).subscriptionStatus)).toBe(true);
  });

  it("charges the full service price on the connected account when the client pays in full", () => {
    const request = buildDirectChargeRequest({
      stripeAccountId: "acct_northwind",
      businessName: "Northwind Cuts",
      serviceName: "Haircut",
      amountCents: 8000,
      chargeKind: "full",
      bookingId: "book_1",
      businessId: "biz_1",
      clientEmail: "casey@example.com",
      successUrl: "https://schedi.test/ok",
      cancelUrl: "https://schedi.test/cancel",
    });
    expect(request.params.line_items?.[0]).toMatchObject({
      price_data: { unit_amount: 8000, product_data: { name: "Northwind Cuts — Haircut" } },
    });
    expect(request.options).toMatchObject({ stripeAccount: "acct_northwind" });
    expect(keysDeep(request.params).has("application_fee_amount")).toBe(false);
  });

  it("hides a failed card attempt from the public page status", async () => {
    const store = memoryStore();
    const { business, service } = seedProBusiness(store);
    const stripe = createFakeStripe();
    stripe.checkout.sessions.create = (async () => {
      throw new Error("Your card was declined.");
    }) as typeof stripe.checkout.sessions.create;
    const slot = upcomingSlots(now, new Set())[0]!;

    await expect(
      placeBooking(
        store,
        stripe,
        {
          slug: business.slug,
          serviceId: service.id,
          startsAt: slot,
          clientName: "Casey Client",
          clientEmail: "casey@example.com",
          method: "card",
          chargeKind: "full",
          successUrl: "https://schedi.test/ok?booking={BOOKING_ID}",
          cancelUrl: "https://schedi.test/cancel",
        },
        now,
      ),
    ).rejects.toThrow(/declined/);

    const latest = store.listBookings(business.id)[0]!;
    expect(latest.status).toBe("payment_failed");
    expect(store.getBusiness(business.id).subscriptionStatus).toBe("active");
    expect(isPublicPageLive(store.getBusiness(business.id).subscriptionStatus)).toBe(true);
  });

  it("confirms Cash App, Zelle, Venmo, PayPal, and pay-at-appointment without Stripe", async () => {
    const store = memoryStore();
    const { business, service } = seedProBusiness(store, {
      cashApp: "$north",
      zelle: "zelle@north.test",
      venmo: "@north",
      paypal: "leo@northwind.example",
      cardPaymentsStatus: "pending",
      payoutsStatus: "pending",
    });
    const methods = ["cash_app", "zelle", "venmo", "paypal", "pay_at_appointment"] as const;
    const slots = upcomingSlots(now, new Set());

    for (const [index, method] of methods.entries()) {
      const result = await placeBooking(
        store,
        null,
        {
          slug: business.slug,
          serviceId: service.id,
          startsAt: slots[index]!,
          clientName: "Casey Client",
          clientEmail: `casey${index}@example.com`,
          method,
          chargeKind: null,
          successUrl: "https://schedi.test/ok",
          cancelUrl: "https://schedi.test/cancel",
        },
        now,
      );
      expect(result.redirectUrl).toBeNull();
      expect(result.booking.status).toBe("confirmed");
      expect(result.booking.paymentMethod).toBe(method);
    }
  });

  it("does not start a card checkout before both capabilities are active", async () => {
    const store = memoryStore();
    const { business, service } = seedProBusiness(store, { payoutsStatus: "pending" });
    const stripe = createFakeStripe();
    const slot = upcomingSlots(now, new Set())[0]!;

    await expect(
      placeBooking(
        store,
        stripe,
        {
          slug: business.slug,
          serviceId: service.id,
          startsAt: slot,
          clientName: "Casey Client",
          clientEmail: "casey@example.com",
          method: "card",
          chargeKind: "full",
          successUrl: "https://schedi.test/ok",
          cancelUrl: "https://schedi.test/cancel",
        },
        now,
      ),
    ).rejects.toThrow(/not available/);
    expect(stripe.calls.some((call) => call.method === "checkout.sessions.create")).toBe(false);
  });
});
