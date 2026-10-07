import Stripe from "stripe";
import { SchediError } from "./errors";

export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: "2026-09-30.endive",
  });
}

let client: Stripe | null = null;

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new SchediError("STRIPE_SECRET_KEY is not set.", 500);
  if (!client) client = createStripeClient(key);
  return client;
}

export function stripeOrNull(): Stripe | null {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return getStripe();
}
