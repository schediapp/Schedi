import { NextResponse } from "next/server";
import { connectAdminAuthorized } from "@/lib/connect-backfill";
import { connectConfigFromProcess } from "@/lib/connect-config";
import { applyMissingEvents, reconcileEvents, type ReconcileEvent } from "@/lib/reconcile";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Compare or apply an operator event export. Apply runs only while this host
 * is frozen and drained, so it does not open the other writers.
 */
export async function POST(request: Request) {
  if (!connectAdminAuthorized(request.headers.get("x-schedi-migration-secret"), process.env.SCHEDI_MIGRATION_SECRET)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let payload: { events?: ReconcileEvent[]; apply?: boolean } = {};
  try {
    payload = (await request.json()) as { events?: ReconcileEvent[]; apply?: boolean };
  } catch {
    return NextResponse.json({ ok: false, error: "Expected a JSON body." }, { status: 400 });
  }
  const store = getStore();
  const events = Array.isArray(payload.events) ? payload.events : [];
  const plan = reconcileEvents(store, events);
  if (payload.apply !== true) return NextResponse.json({ ok: true, applied: false, ...plan });
  const state = store.maintenance();
  if (!state.frozen || state.admitted !== 0) {
    return NextResponse.json({ ok: false, error: "freeze_required", ...plan }, { status: 409 });
  }
  const results = await applyMissingEvents(store, events, { config: connectConfigFromProcess() });
  return NextResponse.json({ ok: true, applied: true, ...plan, results });
}
