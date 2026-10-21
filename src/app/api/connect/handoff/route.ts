import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { adoptSchediBusiness, verifyConnectHandoff } from "@/lib/connect-handoff";
import { enableCardPayments } from "@/lib/connect";
import { errorMessage, redirectTo } from "@/lib/http";
import { getStore } from "@/lib/store";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * Signed handoff from schedi.app. Complimentary Pro and active Pro land on
 * Stripe Connect onboarding. This route does not open a subscription Checkout.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("t") || "";
  const claims = verifyConnectHandoff(token, process.env.SCHEDI_CONNECT_PAID_SECRET || "");
  if (!claims) {
    return redirectTo(request, "/portal", { error: "This Stripe setup link is not valid. Nothing was charged." });
  }

  const store = getStore();
  let ownerId = "";
  try {
    ownerId = adoptSchediBusiness(store, claims).ownerId;
  } catch (error) {
    return redirectTo(request, "/portal", { error: errorMessage(error) });
  }

  const session = store.createSession(ownerId);
  let destination = redirectTo(request, "/portal#stripe-setup");
  try {
    await enableCardPayments(store, getStripe(), ownerId);
  } catch (error) {
    destination = redirectTo(request, "/portal", {
      error: errorMessage(error),
      source: "connect",
    });
  }
  destination.cookies.set(SESSION_COOKIE, session, sessionCookieOptions(request));
  return destination;
}
