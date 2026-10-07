import { NextResponse } from "next/server";
import { SchediError } from "@/lib/errors";
import { errorMessage } from "@/lib/http";
import { getStore } from "@/lib/store";
import { getStripe } from "@/lib/stripe";
import { constructVerifiedEvent } from "@/lib/webhook-signature";
import { applyStripeEvent } from "@/lib/webhooks";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing Stripe signature." }, { status: 400 });

  const payload = await request.text();
  try {
    const event = constructVerifiedEvent(getStripe(), payload, signature);
    applyStripeEvent(getStore(), event);
    return NextResponse.json({ received: true });
  } catch (error) {
    const message = errorMessage(error);
    const status = error instanceof SchediError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
