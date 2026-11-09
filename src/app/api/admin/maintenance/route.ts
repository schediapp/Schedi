import { NextResponse } from "next/server";
import { connectAdminAuthorized } from "@/lib/connect-backfill";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Freeze or reopen every Connect writer on this host.
 * Uses SCHEDI_MIGRATION_SECRET, not the paid-callback secret.
 * Opening writers again requires x-schedi-maintenance-confirm: open-writers.
 */
export async function POST(request: Request) {
  if (!connectAdminAuthorized(request.headers.get("x-schedi-migration-secret"), process.env.SCHEDI_MIGRATION_SECRET)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let body: { mode?: string } = {};
  try {
    body = (await request.json()) as { mode?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Expected a JSON body." }, { status: 400 });
  }
  const store = getStore();
  if (body.mode === "frozen") return NextResponse.json({ ok: true, ...store.freezeWriters() });
  if (body.mode === "open") {
    if (request.headers.get("x-schedi-maintenance-confirm") !== "open-writers") {
      return NextResponse.json({ ok: false, error: "confirm_open_writers" }, { status: 409 });
    }
    return NextResponse.json({ ok: true, ...store.openWriters() });
  }
  return NextResponse.json({ ok: false, error: "Expected mode frozen or open." }, { status: 400 });
}
