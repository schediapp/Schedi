import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../src/lib/csp";

function directive(policy: string, name: string): string {
  const found = policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `) || part === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

describe("content security policy", () => {
  it("lets form posts follow redirects to Stripe Checkout and the billing portal", () => {
    const formAction = directive(contentSecurityPolicy(), "form-action");
    expect(formAction).toBe(
      "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
    );
  });

  it("keeps form submissions off every other origin", () => {
    const formAction = directive(contentSecurityPolicy(), "form-action");
    expect(formAction).not.toContain("*");
    expect(formAction.split(" ")).not.toContain("https:");
    expect(formAction.split(" ")).not.toContain("http:");
  });
});
