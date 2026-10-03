import { NextResponse } from "next/server";
import { errorMessage } from "@/lib/http";
import { getStore } from "@/lib/store";
import { getStripe } from "@/lib/stripe";
import { applyStripeEvent } from "@/lib/webhooks";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "STRIPE_WEBHOOK_SECRET is not set." }, { status: 500 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing Stripe signature." }, { status: 400 });

  const payload = await request.text();
  try {
    const event = getStripe().webhooks.constructEvent(payload, signature, secret);
    applyStripeEvent(getStore(), event);
    return NextResponse.json({ received: true });
  } catch (error) {
    const message = errorMessage(error);
    const status = message.toLowerCase().includes("signature") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
