import { NextResponse } from "next/server";
import { SchediError } from "@/lib/errors";
import { sqliteDatabasePath } from "@/lib/db";
import {
  BACKUP_SECRET_HEADER,
  backupSecretAuthorized,
  backupSecretConfigured,
  snapshotSqliteDatabase,
} from "@/lib/sqlite-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SNAPSHOT_NAME = 'attachment; filename="schedi-connect-snapshot.sqlite"';

function methodNotAllowed() {
  return NextResponse.json(
    { ok: false, error: "method_not_allowed" },
    { status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

/**
 * POST /api/admin/sqlite-snapshot
 * One consistent SQLite file. An empty body is the only accepted command.
 */
export async function POST(request: Request) {
  const configured = process.env.SCHEDI_CONNECT_BACKUP_SECRET;
  if (!backupSecretConfigured(configured)) {
    return NextResponse.json(
      { ok: false, error: "Backup is not configured." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  if (!backupSecretAuthorized(request.headers.get(BACKUP_SECRET_HEADER), configured)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  if (!(await emptyCommand(request))) {
    return NextResponse.json(
      { ok: false, error: "This route only copies the database." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const bytes = snapshotSqliteDatabase(sqliteDatabasePath());
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": SNAPSHOT_NAME,
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof SchediError ? error.message : "Could not snapshot the database.";
    const status = error instanceof SchediError ? error.status : 500;
    return NextResponse.json({ ok: false, error: message }, { status, headers: { "cache-control": "no-store" } });
  }
}

async function emptyCommand(request: Request): Promise<boolean> {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > 1024) return false;
  let text = "";
  try {
    text = await request.text();
  } catch {
    return false;
  }
  if (text.length > 1024) return false;
  if (text.trim() === "") return true;
  try {
    const parsed = JSON.parse(text) as unknown;
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}
