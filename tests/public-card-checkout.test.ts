import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { createConnectPaymentLink, publicCardReturnUrl, publicReturnOrigin } from "../src/lib/public-card-checkout";
import { SchediError } from "../src/lib/errors";
import { keysDeep, memoryStore, seedProBusiness, type RecordedCall } from "./helpers";

function stripeWithPaymentLinks() {
  const calls: RecordedCall[] = [];
  const stripe = {
    calls,
    prices: {
      create: async (params: object, options: object) => {
        calls.push({ method: "prices.create", args: [params, options] });
        return { id: "price_public" };
      },
    },
    paymentLinks: {
      create: async (params: object, options: object) => {
        calls.push({ method: "paymentLinks.create", args: [params, options] });
        return { id: "plink_public", url: "https://buy.stripe.com/test_public" };
      },
    },
  };
  return stripe as unknown as Stripe & { calls: RecordedCall[] };
}

const input = {
  slug: "northwind",
  tenantId: "northwind",
  bookingIds: ["BK-CB126C75"],
  email: "client@example.com",
  serviceName: "Portrait",
  amountCents: 50,
  chargeKind: "deposit" as const,
  returnOrigin: "https://schedi.app",
};

describe("public card checkout", () => {
  it("creates a direct-charge Payment Link on the connected account", async () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store);
    const stripe = stripeWithPaymentLinks();

    const created = await createConnectPaymentLink(stripe, business, input);

    expect(created?.url).toBe("https://buy.stripe.com/test_public");
    expect(created?.durableUrl).toBe(
      "https://schedi.app/northwind/?pay=checkout&booking=BK-CB126C75&kind=deposit",
    );
    const priceCall = stripe.calls.find((call) => call.method === "prices.create");
    const linkCall = stripe.calls.find((call) => call.method === "paymentLinks.create");
    expect(priceCall?.args[1]).toMatchObject({ stripeAccount: "acct_northwind" });
    expect(linkCall?.args[1]).toMatchObject({ stripeAccount: "acct_northwind" });
    const params = linkCall?.args[0] as Stripe.PaymentLinkCreateParams;
    expect(params.metadata?.kind).toBe("booking_payment");
    expect(params.metadata?.schedi_public_booking).toBe("1");
    expect(params.after_completion).toMatchObject({
      type: "redirect",
      redirect: { url: publicCardReturnUrl("https://schedi.app", "northwind", "deposit", "BK-CB126C75", "success") },
    });
    const keys = keysDeep(params);
    for (const forbidden of ["application_fee_amount", "transfer_data", "on_behalf_of", "payment_method_types"]) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(stripe.calls.some((call) => call.method === "checkout.sessions.create")).toBe(false);
  });

  it("returns null when Connect checkout is not ready, so the SPA can use the platform path", async () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store, { cardPaymentsStatus: "pending" });
    const stripe = stripeWithPaymentLinks();
    expect(await createConnectPaymentLink(stripe, business, input)).toBeNull();
    expect(await createConnectPaymentLink(stripe, null, input)).toBeNull();
    expect(stripe.calls).toHaveLength(0);
  });

  it("only returns clients to schedi.app", () => {
    expect(publicReturnOrigin("https://schedi.app")).toBe("https://schedi.app");
    expect(publicReturnOrigin("https://www.schedi.app/")).toBe("https://www.schedi.app");
    expect(() => publicReturnOrigin("https://evil.test")).toThrow(SchediError);
  });
});
