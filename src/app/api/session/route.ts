import { cookies } from "next/headers";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { redirectTo } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

const EMAIL_SIGN_IN_REFUSED =
  "Use Set up Stripe in Schedi. An email address alone does not open this portal.";

export async function POST(request: Request) {
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const store = getStore();

  if (intent !== "sign-out") {
    return redirectTo(request, "/portal", { error: EMAIL_SIGN_IN_REFUSED });
  }

  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) store.deleteSession(token);
  const response = redirectTo(request, "/portal");
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(request), maxAge: 0 });
  return response;
}
