import type Stripe from "stripe";
import { durableCardPayLink, type CardPayKind } from "./card-pay-link";
import { SchediError } from "./errors";
import { isCardCheckoutReady } from "./readiness";
import { assertNoForbiddenKeys } from "./statement";
import type { Business } from "./types";

const PUBLIC_ORIGINS = new Set(["https://schedi.app", "https://www.schedi.app"]);

export interface PublicCardCheckoutInput {
  slug: string;
  tenantId: string;
  bookingIds: string[];
  email: string;
  serviceName: string;
  amountCents: number;
  chargeKind: "deposit" | "full";
  returnOrigin: string;
}

export function publicReturnOrigin(value: string): string {
  const origin = String(value || "").trim().replace(/\/$/, "");
  if (!PUBLIC_ORIGINS.has(origin)) {
    throw new SchediError("Card checkout must return to schedi.app.", 400);
  }
  return origin;
}

export function publicCardReturnUrl(
  origin: string,
  slug: string,
  kind: CardPayKind,
  bookingId: string,
  flag: "success" | "cancel",
): string {
  const base = publicReturnOrigin(origin);
  const url = new URL(`${base}/${slug}/`);
  url.searchParams.set("pay", flag);
  url.searchParams.set("kind", kind);
  url.searchParams.set("booking", bookingId);
  return url.toString();
}

function payKind(chargeKind: "deposit" | "full"): CardPayKind {
  return chargeKind === "deposit" ? "deposit" : "card";
}

function chargeMetadata(business: Business, input: PublicCardCheckoutInput): Record<string, string> {
  return {
    kind: "booking_payment",
    purpose: payKind(input.chargeKind),
    tenantId: input.tenantId.slice(0, 80),
    bookingIds: input.bookingIds.join(",").slice(0, 480),
    schedi_booking_id: input.bookingIds[0] ?? "",
    schedi_business_id: business.id,
    schedi_public_booking: "1",
    charge_kind: input.chargeKind,
    business_name: business.name.slice(0, 120),
  };
}

/**
 * Direct-charge Payment Link on the connected account.
 * buy.stripe.com URLs stay short when copied or emailed, unlike Checkout Session hashes.
 * Returns null when this business cannot take a direct charge yet.
 */
export async function createConnectPaymentLink(
  stripe: Stripe,
  business: Business | null,
  input: PublicCardCheckoutInput,
): Promise<{ url: string; durableUrl: string } | null> {
  if (!business?.stripeAccountId || !isCardCheckoutReady(business)) return null;
  if (business.slug !== input.slug && business.id !== input.tenantId) return null;

  const kind = payKind(input.chargeKind);
  const metadata = chargeMetadata(business, input);
  const productName =
    input.chargeKind === "deposit"
      ? `${business.name} deposit — ${input.serviceName}`.slice(0, 120)
      : `${business.name} — ${input.serviceName}`.slice(0, 120);
  const description =
    input.chargeKind === "deposit"
      ? `Deposit for ${input.serviceName} at ${business.name}. The rest is collected in person.`
      : `${input.serviceName} at ${business.name}.`;
  const successUrl = publicCardReturnUrl(input.returnOrigin, business.slug, kind, input.bookingIds[0] ?? "", "success");
  const idempotency = `schedi_public_${input.bookingIds[0]}_${input.amountCents}_${input.chargeKind}`.slice(0, 200);

  const priceParams: Stripe.PriceCreateParams = {
    currency: "usd",
    unit_amount: input.amountCents,
    product_data: { name: productName },
  };
  assertNoForbiddenKeys(priceParams);
  assertNoForbiddenKeys(metadata);
  const price = await stripe.prices.create(priceParams, {
    stripeAccount: business.stripeAccountId,
    idempotencyKey: `${idempotency}_price`.slice(0, 255),
  });

  const paymentIntentData: Stripe.PaymentLinkCreateParams.PaymentIntentData = {
    description: description.slice(0, 500),
    metadata,
    setup_future_usage: "off_session",
  };
  // after_completion.type is Stripe's redirect enum, not a charge-routing key.
  assertNoForbiddenKeys(paymentIntentData);
  const linkParams: Stripe.PaymentLinkCreateParams = {
    line_items: [{ price: price.id, quantity: 1 }],
    metadata,
    payment_intent_data: paymentIntentData,
    after_completion: {
      type: "redirect",
      redirect: { url: successUrl },
    },
    restrictions: { completed_sessions: { limit: 1 } },
    customer_creation: "always",
    inactive_message: "This payment link was already used. Open the booking page link again to pay.",
  };

  const link = await stripe.paymentLinks.create(linkParams, {
    stripeAccount: business.stripeAccountId,
    idempotencyKey: `${idempotency}_link`.slice(0, 255),
  });
  if (!link.url) throw new SchediError("Stripe did not return a payment link.", 502);

  return {
    url: link.url,
    durableUrl: durableCardPayLink(business.slug, input.bookingIds, kind),
  };
}
