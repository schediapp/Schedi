import { currentOwner } from "@/lib/auth";
import { cancelOwnerSubscription, startOwnerSubscription } from "@/lib/billing";
import { errorMessage, publicOrigin, redirectTo } from "@/lib/http";
import { getStore } from "@/lib/store";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const owner = await currentOwner();
  if (!owner) return redirectTo(request, "/portal", { error: "Sign in required." });

  const form = await request.formData();
  const plan = String(form.get("plan") || "");
  const origin = publicOrigin(request);
  const store = getStore();

  try {
    const stripe = getStripe();
    if (plan === "cancel") {
      await cancelOwnerSubscription(store, stripe, owner.id);
      return redirectTo(request, "/portal", { updated: "1" });
    }
    if (plan !== "starter" && plan !== "pro") {
      return redirectTo(request, "/portal", { error: "Choose Starter or Pro." });
    }
    const result = await startOwnerSubscription(store, stripe, owner.id, plan, {
      success: `${origin}/portal?session_id={CHECKOUT_SESSION_ID}`,
      cancel: `${origin}/portal`,
    });
    if (result.kind === "updated") return redirectTo(request, "/portal", { updated: "1" });
    return redirectTo(request, result.url);
  } catch (error) {
    return redirectTo(request, "/portal", { error: errorMessage(error) });
  }
}
