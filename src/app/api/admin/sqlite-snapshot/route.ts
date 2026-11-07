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
const BODY_MAX_BYTES = 1024;

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
 * Streams one consistent SQLite file. The body is either empty or a JSON
 * object with no fields. It cannot name a path, SQL, or another command.
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
    const download = await snapshotSqliteDatabase(sqliteDatabasePath(), { signal: request.signal });
    request.signal.addEventListener("abort", () => download.release(), { once: true });
    return new NextResponse(download.stream, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": SNAPSHOT_NAME,
        "content-length": String(download.bytes),
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
  const declared = request.headers.get("content-length");
  if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > BODY_MAX_BYTES)) return false;
  if (!request.body) return true;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return false;
  }
  if (total === 0) return true;
  let text = "";
  try {
    text = new TextDecoder("utf8", { fatal: true }).decode(concatBytes(chunks));
  } catch {
    return false;
  }
  if (text.trim() === "") return true;
  try {
    const parsed = JSON.parse(text) as unknown;
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
