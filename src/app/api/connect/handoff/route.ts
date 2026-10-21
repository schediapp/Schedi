import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { acceptConnectHandoff } from "@/lib/connect-handoff";
import { enableCardPayments } from "@/lib/connect";
import { errorMessage, redirectTo } from "@/lib/http";
import { fetchSchediPlan } from "@/lib/plan-entitlement";
import { getStore } from "@/lib/store";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

const HANDOFF_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>Stripe setup</title>
</head>
<body>
<p>Taking you to Stripe setup…</p>
<script>
(function () {
  var search = new URLSearchParams(location.search);
  var fromQuery = search.get("t");
  if (fromQuery) {
    location.replace(location.pathname + "#t=" + encodeURIComponent(fromQuery));
    return;
  }
  var hash = location.hash || "";
  if (hash.charAt(0) === "#") hash = hash.slice(1);
  var token = hash.slice(0, 2) === "t=" ? hash.slice(2) : "";
  try { token = decodeURIComponent(token); } catch (err) { token = ""; }
  if (!token) {
    location.replace("/portal?error=" + encodeURIComponent("This Stripe setup link is not valid. Nothing was charged."));
    return;
  }
  var form = document.createElement("form");
  form.method = "POST";
  form.action = location.pathname;
  var input = document.createElement("input");
  input.type = "hidden";
  input.name = "t";
  input.value = token;
  form.appendChild(input);
  document.body.appendChild(form);
  history.replaceState(null, "", location.pathname);
  form.submit();
})();
</script>
</body>
</html>`;

/**
 * The token arrives in the URL fragment, which the browser does not send.
 * This page posts it in the body, then the redirect locations stay clean.
 */
export function GET() {
  return new NextResponse(HANDOFF_PAGE, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export async function POST(request: Request) {
  const form = await request.formData();
  const token = String(form.get("t") || "");
  const store = getStore();
  const accepted = await acceptConnectHandoff(
    store,
    token,
    process.env.SCHEDI_CONNECT_PAID_SECRET || "",
    (query) => fetchSchediPlan(query),
  );
  if (!accepted.ok) {
    return redirectTo(request, "/portal", { error: accepted.error });
  }

  const session = store.createSession(accepted.ownerId);
  let destination = redirectTo(request, "/portal#stripe-setup");
  try {
    await enableCardPayments(store, getStripe(), accepted.ownerId);
  } catch (error) {
    destination = redirectTo(request, "/portal", {
      error: errorMessage(error),
      source: "connect",
    });
  }
  destination.cookies.set(SESSION_COOKIE, session, sessionCookieOptions(request));
  return destination;
}
