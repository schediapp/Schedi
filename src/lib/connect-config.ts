/**
 * Immutable Connect settings for one request. Callers pass this object through.
 * Nothing in the request path writes process.env.
 */
export interface ConnectConfig {
  stripeSecretKey: string;
  platformWebhookSecret: string;
  connectWebhookSecret: string;
  connectPaidSecret: string;
  connectPaidUrl: string;
  connectReadyUrl: string;
  planUrl: string;
  priceStarter: string;
  pricePro: string;
  publishableKey: string;
  publicOrigin: string;
  migrationSecret: string;
  nodeEnv: string;
  /** The worker portal never accepts email-only sign-in. */
  emailSignIn: false;
  testDelayMs: number;
}

const PAID_URL = "https://schedi.app/billing/connect-booking-paid";
const READY_URL = "https://schedi.app/billing/connect-ready";
const PLAN_URL = "https://schedi.app/billing/connect-plan";

function callbackUrl(value: string | undefined, fallback: string, allowLocalHttp: boolean): string {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol === "https:" && !url.username && !url.password) return url.toString().replace(/\/$/, "");
    if (allowLocalHttp && url.protocol === "http:" && local) return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
  return fallback;
}

function origin(value: string | undefined): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function connectConfigFrom(env: Record<string, string | undefined>): ConnectConfig {
  const nodeEnv = env.NODE_ENV || "production";
  const allowLocalHttp = nodeEnv !== "production";
  const delay = Number(env.CONNECT_TEST_DELAY_MS || "0");
  return {
    stripeSecretKey: String(env.STRIPE_SECRET_KEY || ""),
    platformWebhookSecret: String(env.STRIPE_WEBHOOK_SECRET || ""),
    connectWebhookSecret: String(env.STRIPE_CONNECT_WEBHOOK_SECRET || ""),
    connectPaidSecret: String(env.SCHEDI_CONNECT_PAID_SECRET || ""),
    connectPaidUrl: callbackUrl(env.SCHEDI_CONNECT_PAID_URL, PAID_URL, allowLocalHttp),
    connectReadyUrl: callbackUrl(env.SCHEDI_CONNECT_READY_URL, READY_URL, allowLocalHttp),
    planUrl: callbackUrl(env.SCHEDI_PLAN_URL, PLAN_URL, allowLocalHttp),
    priceStarter: String(env.STRIPE_PRICE_STARTER || ""),
    pricePro: String(env.STRIPE_PRICE_PRO || ""),
    publishableKey: String(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || ""),
    publicOrigin: origin(env.CONNECT_PUBLIC_ORIGIN),
    migrationSecret: String(env.SCHEDI_MIGRATION_SECRET || ""),
    nodeEnv,
    emailSignIn: false,
    testDelayMs: Number.isFinite(delay) && delay > 0 && delay <= 2000 ? delay : 0,
  };
}

/** Railway's Node process. Not used by the Durable Object. */
export function connectConfigFromProcess(): ConnectConfig {
  return connectConfigFrom(process.env);
}
