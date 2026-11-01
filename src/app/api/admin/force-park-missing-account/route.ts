import { NextResponse } from "next/server";
import { connectAdminAuthorized } from "@/lib/connect-backfill";
import { forceParkMissingConnectedAccount } from "@/lib/connect";
import { SchediError } from "@/lib/errors";
import { getStore } from "@/lib/store";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

function jsonString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** POST /api/admin/force-park-missing-account — park a connected account Stripe says is gone. */
export async function POST(request: Request) {
  if (!connectAdminAuthorized(request.headers.get("x-schedi-connect-secret"), process.env.SCHEDI_CONNECT_PAID_SECRET)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Expected a JSON body." }, { status: 400 });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return NextResponse.json({ ok: false, error: "Expected a JSON object." }, { status: 400 });
  }
  const body = payload as { slug?: unknown; businessId?: unknown };
  try {
    const result = await forceParkMissingConnectedAccount(getStore(), getStripe(), {
      slug: jsonString(body.slug),
      businessId: jsonString(body.businessId),
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof SchediError ? error.message : "Could not park the connected account.";
    const status = error instanceof SchediError ? error.status : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
