import { createConnectPaymentLink, publicReturnOrigin } from "@/lib/public-card-checkout";
import { SchediError } from "@/lib/errors";
import { errorMessage } from "@/lib/http";
import { getStore } from "@/lib/store";
import { stripeOrNull } from "@/lib/stripe";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ALLOWED_ORIGINS = new Set(["https://schedi.app", "https://www.schedi.app"]);

function corsHeaders(request: Request): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  const origin = request.headers.get("origin") || "";
  if (ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return headers;
}

function json(request: Request, body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: corsHeaders(request) });
}

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: Request) {
  let payload: Record<string, unknown> = {};
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(request, { ok: false, error: "invalid_json" }, 400);
  }

  const slug = String(payload.slug || payload.tenantId || "").trim().toLowerCase();
  const tenantId = String(payload.tenantId || slug).trim();
  const bookingIds = (Array.isArray(payload.bookingIds) ? payload.bookingIds : [payload.bookingId])
    .map((id) => String(id || "").trim())
    .filter((id) => /^[A-Za-z0-9_-]{4,40}$/.test(id));
  const email = String(payload.email || "").trim().toLowerCase();
  const serviceName = String(payload.serviceName || "Appointment").trim().slice(0, 120) || "Appointment";
  const amountCents = Math.round(Number(payload.amountCents));
  const chargeKind = payload.chargeKind === "full" ? "full" : payload.chargeKind === "deposit" ? "deposit" : "";
  const returnOrigin = String(payload.returnOrigin || "https://schedi.app");

  if (!/^[a-z0-9](?:[a-z0-9-]{0,40})$/.test(slug)) {
    return json(request, { ok: false, error: "invalid_tenant" }, 400);
  }
  if (!bookingIds.length) return json(request, { ok: false, error: "invalid_booking" }, 400);
  if (!Number.isInteger(amountCents) || amountCents < 50 || amountCents > 1_000_000) {
    return json(request, { ok: false, error: "amount_too_small" }, 400);
  }
  if (!chargeKind) return json(request, { ok: false, error: "invalid_charge" }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(request, { ok: false, error: "invalid_email" }, 400);
  }

  let origin: string;
  try {
    origin = publicReturnOrigin(returnOrigin);
  } catch (error) {
    return json(request, { ok: false, error: errorMessage(error) }, error instanceof SchediError ? error.status : 400);
  }

  const stripe = stripeOrNull();
  if (!stripe) return json(request, { ok: false, error: "connect_unavailable" }, 409);

  const store = getStore();
  const business = store.getBusinessBySlug(slug);
  try {
    const created = await createConnectPaymentLink(stripe, business, {
      slug,
      tenantId,
      bookingIds,
      email,
      serviceName,
      amountCents,
      chargeKind,
      returnOrigin: origin,
    });
    if (!created) return json(request, { ok: false, error: "connect_unavailable" }, 409);
    return json(
      request,
      { ok: true, url: created.url, paymentLink: created.url, durableUrl: created.durableUrl, mode: "connect" },
      200,
    );
  } catch (error) {
    const status = error instanceof SchediError ? error.status : 502;
    return json(request, { ok: false, error: errorMessage(error) }, status);
  }
}
