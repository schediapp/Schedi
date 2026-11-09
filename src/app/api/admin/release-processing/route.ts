import { NextResponse } from "next/server";
import { connectAdminAuthorized } from "@/lib/connect-backfill";
import { SchediError } from "@/lib/errors";
import { errorMessage } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Drop crashed processing claims. Requires a frozen, drained database. */
export async function POST(request: Request) {
  if (!connectAdminAuthorized(request.headers.get("x-schedi-migration-secret"), process.env.SCHEDI_MIGRATION_SECRET)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const released = getStore().releaseProcessingClaims();
    return NextResponse.json({ ok: true, released });
  } catch (error) {
    const status = error instanceof SchediError ? error.status : 409;
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status });
  }
}
