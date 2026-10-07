import { currentOwner } from "@/lib/auth";
import { enableCardPayments } from "@/lib/connect";
import { redirectTo } from "@/lib/http";
import { formatConnectEnableError } from "@/lib/stripe-error";
import { getStore } from "@/lib/store";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const owner = await currentOwner();
  if (!owner) return redirectTo(request, "/portal", { error: "Sign in required." });

  try {
    await enableCardPayments(getStore(), getStripe(), owner.id);
    return redirectTo(request, "/portal");
  } catch (error) {
    const failure = formatConnectEnableError(error);
    if (failure.log) {
      console.error(
        "Card payments could not be turned on:",
        JSON.stringify({
          type: failure.log.type,
          message: failure.log.message,
          code: failure.log.code,
        }),
      );
    } else {
      console.error("Card payments could not be turned on:", failure.message);
    }
    return redirectTo(request, "/portal", {
      error: failure.message,
      code: failure.code,
      source: "connect",
    });
  }
}
