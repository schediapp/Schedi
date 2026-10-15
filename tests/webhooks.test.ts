import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { isPublicPageLive } from "../src/lib/readiness";
import { applyStripeEvent } from "../src/lib/webhooks";
import { memoryStore, seedProBusiness } from "./helpers";

function event(partial: Record<string, unknown>): Stripe.Event {
  return partial as unknown as Stripe.Event;
}

describe("webhook separation", () => {
  it("confirms a paid direct charge and leaves the public page live", () => {
    const store = memoryStore();
    const { business, service } = seedProBusiness(store);
    const booking = store.createBooking({
      businessId: business.id,
      serviceId: service.id,
      clientName: "Casey",
      clientEmail: "casey@example.com",
      startsAt: "2026-10-06T13:00:00.000Z",
      paymentMethod: "card",
      chargeKind: "deposit",
      amountCents: 2500,
      status: "pending_payment",
    });

    applyStripeEvent(
      store,
      event({
        id: "evt_paid",
        type: "checkout.session.completed",
        account: "acct_northwind",
        data: {
          object: {
            mode: "payment",
            payment_status: "paid",
            payment_intent: "pi_client",
            metadata: { schedi_booking_id: booking.id },
          },
        },
      }),
    );

    expect(store.getBooking(booking.id).status).toBe("confirmed");
    expect(store.getBusiness(business.id).subscriptionStatus).toBe("active");
    expect(isPublicPageLive(store.getBusiness(business.id).subscriptionStatus)).toBe(true);
  });

  it("does not pause the page when a client card fails", () => {
    const store = memoryStore();
    const { business, service } = seedProBusiness(store);
    const booking = store.createBooking({
      businessId: business.id,
      serviceId: service.id,
      clientName: "Casey",
      clientEmail: "casey@example.com",
      startsAt: "2026-10-06T13:00:00.000Z",
      paymentMethod: "card",
      chargeKind: "full",
      amountCents: 8000,
      status: "pending_payment",
    });

    applyStripeEvent(
      store,
      event({
        id: "evt_fail_pi",
        type: "payment_intent.payment_failed",
        account: "acct_northwind",
        data: { object: { metadata: { schedi_booking_id: booking.id } } },
      }),
    );
    applyStripeEvent(
      store,
      event({
        id: "evt_fail_async",
        type: "checkout.session.async_payment_failed",
        account: "acct_northwind",
        data: { object: { metadata: { schedi_booking_id: booking.id } } },
      }),
    );

    expect(store.getBooking(booking.id).status).toBe("payment_failed");
    expect(isPublicPageLive(store.getBusiness(business.id).subscriptionStatus)).toBe(true);
  });

  it("pauses the page when the owner subscription fails or is canceled", () => {
    const store = memoryStore();
    const failed = seedProBusiness(store, { email: "fail@example.com", slug: "fail", stripeSubscriptionId: "sub_fail" });
    store.setOwnerCustomer(failed.owner.id, "cus_fail");
    const canceled = seedProBusiness(store, {
      email: "cancel@example.com",
      slug: "cancel",
      stripeSubscriptionId: "sub_cancel",
    });

    applyStripeEvent(
      store,
      event({
        id: "evt_invoice",
        type: "invoice.payment_failed",
        data: { object: { customer: "cus_fail" } },
      }),
    );
    applyStripeEvent(
      store,
      event({
        id: "evt_deleted",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_cancel",
            status: "canceled",
            metadata: { schedi_owner_id: canceled.owner.id, plan: "pro" },
          },
        },
      }),
    );

    expect(store.getBusiness(failed.business.id).subscriptionStatus).toBe("past_due");
    expect(isPublicPageLive(store.getBusiness(failed.business.id).subscriptionStatus)).toBe(false);
    expect(store.getBusiness(canceled.business.id).subscriptionStatus).toBe("canceled");
    expect(store.getBusiness(canceled.business.id).cancelAtPeriodEnd).toBe(false);
    expect(isPublicPageLive(store.getBusiness(canceled.business.id).subscriptionStatus)).toBe(false);
    expect(store.getBusiness(canceled.business.id).plan).toBe("pro");
  });

  it("keeps access when cancellation is scheduled and ignores a canceled update", () => {
    const store = memoryStore();
    const scheduled = seedProBusiness(store, {
      email: "later@example.com",
      slug: "later",
      stripeSubscriptionId: "sub_later",
    });
    const premature = seedProBusiness(store, {
      email: "early@example.com",
      slug: "early",
      stripeSubscriptionId: "sub_early",
    });

    applyStripeEvent(
      store,
      event({
        id: "evt_cancel_scheduled",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_later",
            status: "active",
            cancel_at_period_end: true,
            cancel_at: 1794009600,
            metadata: { schedi_owner_id: scheduled.owner.id, plan: "pro" },
          },
        },
      }),
    );
    applyStripeEvent(
      store,
      event({
        id: "evt_cancel_request_status",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_early",
            status: "canceled",
            cancel_at_period_end: true,
            metadata: { schedi_owner_id: premature.owner.id, plan: "pro" },
          },
        },
      }),
    );

    const kept = store.getBusiness(scheduled.business.id);
    expect(kept.subscriptionStatus).toBe("active");
    expect(kept.cancelAtPeriodEnd).toBe(true);
    expect(kept.currentPeriodEnd).toBe("2026-11-07T00:00:00.000Z");
    expect(kept.plan).toBe("pro");
    expect(isPublicPageLive(kept.subscriptionStatus)).toBe(true);

    const untouched = store.getBusiness(premature.business.id);
    expect(untouched.subscriptionStatus).toBe("active");
    expect(untouched.cancelAtPeriodEnd).toBe(false);
    expect(isPublicPageLive(untouched.subscriptionStatus)).toBe(true);
  });

  it("activates a platform subscription checkout without touching a connected account", () => {
    const store = memoryStore();
    const { owner, business } = seedProBusiness(store, {
      plan: "free",
      subscriptionStatus: "none",
      stripeAccountId: null,
    });

    applyStripeEvent(
      store,
      event({
        id: "evt_sub",
        type: "checkout.session.completed",
        data: {
          object: {
            mode: "subscription",
            status: "complete",
            subscription: "sub_pro",
            metadata: { schedi_owner_id: owner.id, plan: "pro" },
          },
        },
      }),
    );

    const saved = store.getBusiness(business.id);
    expect(saved.plan).toBe("pro");
    expect(saved.subscriptionStatus).toBe("active");
    expect(saved.stripeSubscriptionId).toBe("sub_pro");
    expect(isPublicPageLive(saved.subscriptionStatus)).toBe(true);
  });

  it("keeps a confirmed booking confirmed if a later failure event arrives", () => {
    const store = memoryStore();
    const { business, service } = seedProBusiness(store);
    const booking = store.createBooking({
      businessId: business.id,
      serviceId: service.id,
      clientName: "Casey",
      clientEmail: "casey@example.com",
      startsAt: "2026-10-06T13:00:00.000Z",
      paymentMethod: "card",
      chargeKind: "full",
      amountCents: 8000,
      status: "confirmed",
    });

    applyStripeEvent(
      store,
      event({
        id: "evt_late_fail",
        type: "payment_intent.payment_failed",
        account: business.stripeAccountId,
        data: { object: { metadata: { schedi_booking_id: booking.id } } },
      }),
    );

    expect(store.getBooking(booking.id).status).toBe("confirmed");
  });

  it("ignores a public SPA charge when that booking is not in the local database", () => {
    const store = memoryStore();
    seedProBusiness(store);
    expect(() =>
      applyStripeEvent(
        store,
        event({
          id: "evt_public_spa",
          type: "checkout.session.completed",
          account: "acct_northwind",
          data: {
            object: {
              mode: "payment",
              payment_status: "paid",
              payment_intent: "pi_public",
              metadata: { schedi_booking_id: "BK-CB126C75", schedi_public_booking: "1" },
            },
          },
        }),
      ),
    ).not.toThrow();
  });
});
