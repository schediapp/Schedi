import { cookies } from "next/headers";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { SchediError } from "@/lib/errors";
import { errorMessage, redirectTo } from "@/lib/http";
import { uniqueSlug } from "@/lib/slug";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const form = await request.formData();
  const intent = String(form.get("intent") || "sign-in");
  const store = getStore();

  if (intent === "sign-out") {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (token) store.deleteSession(token);
    const response = redirectTo(request, "/portal");
    response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(request), maxAge: 0 });
    return response;
  }

  try {
    const email = String(form.get("email") || "").trim().toLowerCase();
    if (!email.includes("@")) throw new SchediError("Enter a valid email.", 400);

    let owner = store.getOwnerByEmail(email);
    if (!owner) {
      const ownerName = String(form.get("owner_name") || "").trim();
      const businessName = String(form.get("business_name") || "").trim();
      if (ownerName.length < 2 || businessName.length < 2) {
        throw new SchediError("Add your name and business to create an account.", 400);
      }
      owner = store.createOwner({ email, name: ownerName });
      const business = store.createBusiness({
        ownerId: owner.id,
        name: businessName,
        slug: uniqueSlug(businessName, (candidate) => store.getBusinessBySlug(candidate) != null),
        plan: "free",
        subscriptionStatus: "none",
      });
      store.createService({
        businessId: business.id,
        name: "Appointment",
        durationMinutes: 60,
        priceCents: 7500,
      });
    }

    const token = store.createSession(owner.id);
    const response = redirectTo(request, "/portal");
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(request));
    return response;
  } catch (error) {
    return redirectTo(request, "/portal", { error: errorMessage(error) });
  }
}
