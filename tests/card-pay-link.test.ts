import { describe, expect, it } from "vitest";
import { durableCardPayLink, isStripePayUrl, visibleCardPayLink } from "../src/lib/card-pay-link";

describe("durable card pay links", () => {
  it("builds a short schedi.app link and never a checkout session hash", () => {
    const link = durableCardPayLink("axeldelcidphotography", ["BK-CB126C75", "BK-SECOND01"], "deposit");
    expect(link).toBe(
      "https://schedi.app/axeldelcidphotography/?pay=checkout&booking=BK-CB126C75&bookings=BK-SECOND01&kind=deposit",
    );
    expect(link.includes("#")).toBe(false);
    expect(link.includes("checkout.stripe.com")).toBe(false);
  });

  it("rejects a slug or id that could change the host", () => {
    expect(durableCardPayLink("https://evil.test", ["BK-CB126C75"], "card")).toBe("");
    expect(durableCardPayLink("ok-slug", ["../admin"], "card")).toBe("");
    expect(durableCardPayLink("ok-slug", ["BK-CB126C75"], "full" as "card")).toBe("");
  });

  it("shows buy.stripe.com and hides the long checkout session URL", () => {
    const durable = "https://schedi.app/northwind/?pay=checkout&booking=BK-ABC12345&kind=card";
    expect(visibleCardPayLink("https://buy.stripe.com/test_abc", durable)).toBe("https://buy.stripe.com/test_abc");
    expect(visibleCardPayLink("https://pay.stripe.com/test_abc", durable)).toBe("https://pay.stripe.com/test_abc");
    expect(visibleCardPayLink("https://checkout.stripe.com/c/pay/cs_live_secret#fid", durable)).toBe(durable);
    expect(isStripePayUrl("https://checkout.stripe.com/c/pay/cs_test")).toBe(true);
    expect(isStripePayUrl("https://schedi.app/northwind/?pay=checkout&booking=BK-ABC12345&kind=card")).toBe(false);
    expect(isStripePayUrl("http://checkout.stripe.com/c/pay/cs_test")).toBe(false);
  });
});
