import { NextResponse } from "next/server";
import { connectAdminAuthorized } from "@/lib/connect-backfill";
import { SchediError } from "@/lib/errors";
import { readSqliteDatabaseBytes } from "@/lib/sqlite-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/sqlite-download — read-only copy of the Connect SQLite file. */
export async function GET(request: Request) {
  if (!connectAdminAuthorized(request.headers.get("x-schedi-connect-secret"), process.env.SCHEDI_CONNECT_PAID_SECRET)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const bytes = await readSqliteDatabaseBytes();
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="schedi-connect.sqlite"',
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof SchediError ? error.message : "Could not read the database.";
    const status = error instanceof SchediError ? error.status : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
