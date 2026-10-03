import { currentOwner } from "@/lib/auth";
import { enableCardPayments } from "@/lib/connect";
import { errorMessage, redirectTo } from "@/lib/http";
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
    return redirectTo(request, "/portal", { error: errorMessage(error) });
  }
}
