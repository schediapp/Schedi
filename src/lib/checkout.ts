import type Stripe from "stripe";
import { SchediError } from "./errors";
import { assertNoForbiddenKeys, integrationIdentifier } from "./statement";
import type { ChargeKind } from "./types";

export interface DirectChargeInput {
  stripeAccountId: string;
  businessName: string;
  serviceName: string;
  amountCents: number;
  chargeKind: ChargeKind;
  bookingId: string;
  businessId: string;
  clientEmail: string;
  successUrl: string;
  cancelUrl: string;
}

export function buildDirectChargeRequest(input: DirectChargeInput): {
  params: Stripe.Checkout.SessionCreateParams;
  options: Stripe.RequestOptions;
} {
  const description =
    input.chargeKind === "deposit"
      ? `Deposit for ${input.serviceName} at ${input.businessName}. The rest is collected in person.`
      : `${input.serviceName} at ${input.businessName}.`;

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    customer_email: input.clientEmail,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: input.amountCents,
          product_data: {
            name:
              input.chargeKind === "deposit"
                ? `${input.businessName} deposit — ${input.serviceName}`
                : `${input.businessName} — ${input.serviceName}`,
            description,
          },
        },
      },
    ],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: {
      schedi_booking_id: input.bookingId,
      schedi_business_id: input.businessId,
      charge_kind: input.chargeKind,
      business_name: input.businessName,
    },
    payment_intent_data: {
      description: `${input.businessName}: ${input.serviceName}`,
      metadata: {
        schedi_booking_id: input.bookingId,
        schedi_business_id: input.businessId,
        business_name: input.businessName,
        charge_kind: input.chargeKind,
      },
    },
    integration_identifier: integrationIdentifier("schedi_booking"),
  };

  assertNoForbiddenKeys(params);
  if (!input.stripeAccountId) {
    throw new SchediError("This business has no connected account.", 409);
  }

  return {
    params,
    options: {
      stripeAccount: input.stripeAccountId,
      idempotencyKey: `schedi_charge_${input.bookingId}`,
    },
  };
}

export async function createDirectChargeCheckout(
  stripe: Stripe,
  input: DirectChargeInput,
): Promise<Stripe.Checkout.Session> {
  const { params, options } = buildDirectChargeRequest(input);
  const session = await stripe.checkout.sessions.create(params, options);
  if (!session.url) throw new SchediError("Stripe did not return a checkout URL.", 502);
  return session;
}
