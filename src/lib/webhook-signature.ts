import type Stripe from "stripe";
import { SchediError } from "./errors";

/**
 * Platform subscription events and connected-account card charges arrive on
 * separate Stripe destinations. Each destination has its own signing secret.
 * Either secret may verify a request to /api/webhooks/stripe.
 */
export function webhookSigningSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET];
  const secrets = raw
    .flatMap((value) => (value ?? "").split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(secrets)];
}

export function constructVerifiedEvent(
  stripe: Stripe,
  payload: string,
  signature: string,
  env: NodeJS.ProcessEnv = process.env,
): Stripe.Event {
  const secrets = webhookSigningSecrets(env);
  if (secrets.length === 0) {
    throw new SchediError("STRIPE_WEBHOOK_SECRET is not set.", 500);
  }

  let lastError: unknown;
  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(payload, signature, secret);
    } catch (error) {
      lastError = error;
    }
  }

  const message = lastError instanceof Error && lastError.message ? lastError.message : "Invalid Stripe signature.";
  const status = message.toLowerCase().includes("signature") ? 400 : 500;
  throw new SchediError(message, status);
}
