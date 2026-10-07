import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("public booking card choice", () => {
  it("keeps every payment method choosable when a deposit or cancellation fee is on", () => {
    expect(html).not.toContain("Card deposit</div>");
    expect(html).not.toContain("if (depositQuote.required) selectedPay = 'card'");
    expect(html).not.toContain("booking.paymentMethod = 'card';\n                            booking.paymentStatus = 'AWAITING DEPOSIT'");
    expect(html).toContain("Card is optional");
    expect(html).toContain("Other ways to pay stay available");
    expect(html).toContain("onclick=\"selectPay('cashapp')\"");
    expect(html).toContain("onclick=\"selectPay('zelle')\"");
    expect(html).toContain("onclick=\"selectPay('venmo')\"");
    expect(html).toContain("onclick=\"selectPay('paypal')\"");
    expect(html).toContain("onclick=\"selectPay('later')\"");
  });

  it("opens Stripe from the top window and shows a short payment link on the request card", () => {
    expect(html).toContain('id="resCardPayLink"');
    expect(html).toContain('id="resCheckoutBtn"');
    expect(html).toContain('target="_top"');
    expect(html).toContain("function assignTopStripe");
    expect(html).toContain("function durableCardPayLink");
    expect(html).toContain("pay=checkout");
    const bookingScript = html.split('var STRIPE_CHECKOUT_ENDPOINT')[1] ?? "";
    expect(bookingScript).not.toContain("window.location.href = data.url");
    expect(bookingScript).not.toContain("window.location.href = out.data.url");
  });
});
