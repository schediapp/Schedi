import { refreshMerchantCapabilities } from "./connect";
import { getStore } from "./store";
import { stripeOrNull } from "./stripe";
import type { Business } from "./types";

export async function withFreshCapabilities(business: Business): Promise<Business> {
  const stripe = stripeOrNull();
  if (!stripe || !business.stripeAccountId) return business;
  try {
    return await refreshMerchantCapabilities(getStore(), stripe, business);
  } catch (error) {
    console.error(
      "Could not refresh connected account capabilities:",
      error instanceof Error ? error.message : "unknown error",
    );
    return business;
  }
}
