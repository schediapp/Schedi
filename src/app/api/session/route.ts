import { cookies } from "next/headers";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { redirectTo } from "@/lib/http";
import { verifyOwnerSession } from "@/lib/owner-session";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

const EMAIL_SIGN_IN_REFUSED =
  "Open the portal from Schedi while you are signed in. An email address alone does not open it.";

export async function POST(request: Request) {
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const store = getStore();

  if (intent !== "sign-out") {
    return redirectTo(request, "/portal", { error: EMAIL_SIGN_IN_REFUSED });
  }

  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value || "";
  const parsed = verifyOwnerSession(token, process.env.SCHEDI_CONNECT_PAID_SECRET || "");
  if (parsed) store.deleteSession(parsed.sid);
  const response = redirectTo(request, "/portal");
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(request), maxAge: 0 });
  return response;
}
