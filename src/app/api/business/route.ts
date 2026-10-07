import { currentOwner } from "@/lib/auth";
import { SchediError } from "@/lib/errors";
import { errorMessage, redirectTo } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const owner = await currentOwner();
  if (!owner) return redirectTo(request, "/portal", { error: "Sign in required." });

  const form = await request.formData();
  const store = getStore();
  const business = store.getBusinessByOwner(owner.id);
  if (!business) return redirectTo(request, "/portal", { error: "Business not found." });

  try {
    const depositEnabled = form.get("deposit_enabled") === "on";
    const rawAmount = String(form.get("deposit_amount") || "").trim();
    let depositAmountCents: number | null = null;
    if (rawAmount) {
      const dollars = Number(rawAmount);
      if (!Number.isFinite(dollars) || dollars < 0.5) {
        throw new SchediError("A deposit is at least $0.50.", 400);
      }
      depositAmountCents = Math.round(dollars * 100);
    }
    if (depositEnabled && depositAmountCents == null) {
      throw new SchediError("Enter a deposit amount.", 400);
    }

    store.updatePaymentSettings(business.id, {
      cashApp: String(form.get("cash_app") || ""),
      zelle: String(form.get("zelle") || ""),
      venmo: String(form.get("venmo") || ""),
      paypal: String(form.get("paypal") || ""),
      payAtAppointment: form.get("pay_at_appointment") === "on",
      depositEnabled,
      depositAmountCents,
    });
    return redirectTo(request, "/portal");
  } catch (error) {
    return redirectTo(request, "/portal", { error: errorMessage(error) });
  }
}
