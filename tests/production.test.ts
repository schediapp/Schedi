import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { shouldSeedDemo } from "../src/lib/seed-policy";
import { constructVerifiedEvent } from "../src/lib/webhook-signature";

const stripe = new Stripe("sk_test_schedi");
const payload = JSON.stringify({
  id: "evt_test",
  object: "event",
  type: "checkout.session.completed",
  data: { object: {} },
});

function header(secret: string) {
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}

describe("production webhook secrets", () => {
  it("accepts the connected-account signing secret", () => {
    const event = constructVerifiedEvent(stripe, payload, header("whsec_connect"), {
      STRIPE_WEBHOOK_SECRET: "whsec_platform",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect",
    });
    expect(event.id).toBe("evt_test");
  });

  it("accepts the platform signing secret", () => {
    const event = constructVerifiedEvent(stripe, payload, header("whsec_platform"), {
      STRIPE_WEBHOOK_SECRET: "whsec_platform",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect",
    });
    expect(event.id).toBe("evt_test");
  });

  it("rejects a signature that matches neither secret", () => {
    expect(() =>
      constructVerifiedEvent(stripe, payload, header("whsec_other"), {
        STRIPE_WEBHOOK_SECRET: "whsec_platform",
        STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect",
      }),
    ).toThrow(/signature/i);
  });

  it("requires a signing secret", () => {
    expect(() => constructVerifiedEvent(stripe, payload, header("whsec_platform"), {})).toThrow(
      /STRIPE_WEBHOOK_SECRET is not set/,
    );
  });
});

describe("demo seed policy", () => {
  it("skips demo businesses in production unless seeding is requested", () => {
    expect(shouldSeedDemo({ NODE_ENV: "production" })).toBe(false);
    expect(shouldSeedDemo({ NODE_ENV: "production", SCHEDI_SEED: "1" })).toBe(true);
    expect(shouldSeedDemo({ NODE_ENV: "development" })).toBe(true);
    expect(shouldSeedDemo({ NODE_ENV: "development", SCHEDI_SEED: "0" })).toBe(false);
  });
});
