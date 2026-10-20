import { NextResponse } from "next/server";
import { backfillStripeConnectReady, connectAdminAuthorized } from "@/lib/connect-backfill";
import { SchediError } from "@/lib/errors";
import { getStore } from "@/lib/store";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

/** POST /api/admin/connect-ready-backfill — republish charges_enabled for every connected account. */
export async function POST(request: Request) {
  if (!connectAdminAuthorized(request.headers.get("x-schedi-connect-secret"), process.env.SCHEDI_CONNECT_PAID_SECRET)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await backfillStripeConnectReady(getStore(), getStripe());
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof SchediError ? error.message : "Backfill failed.";
    const status = error instanceof SchediError ? error.status : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
