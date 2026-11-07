import { handleAdminSnapshot } from "@/connect/server";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/sqlite-snapshot — consistent logical copy of the Connect tables.
 * Read-only aside from the additive schema migration Store already applies.
 * The body is the customer database. Do not log it.
 */
export async function GET(request: Request) {
  return handleAdminSnapshot(request, getStore(), process.env.SCHEDI_CONNECT_PAID_SECRET);
}
