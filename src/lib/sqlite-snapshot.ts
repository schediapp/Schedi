import { timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SchediError } from "./errors";

/**
 * Online backup of the Connect SQLite file.
 *
 * node:sqlite exposes no backup() method. VACUUM INTO copies through SQLite's
 * backup API into a new file and leaves the source unchanged. The destination
 * is one database file in rollback-journal mode: committed WAL frames are
 * inside it, and it does not need the source -wal or -shm. Uncommitted
 * transactions are not included. The copy is a consistent committed image.
 * It does not checkpoint or truncate the source WAL, and it does not stop
 * other writers. In WAL mode a writer can commit while the copy runs; that
 * commit is either fully in the image or fully out of it. On a rollback
 * journal, an exclusive lock makes this return "Database is busy." after a
 * short wait instead of freezing the process.
 *
 * The live database is opened read-only and is never passed to readFile.
 * Only the finished snapshot file is read, then deleted. The request cannot
 * choose a path or SQL. A crash can leave a mode-0700 directory under the
 * temp root; the request path removes it when it finishes.
 */
export const SQLITE_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
export const BACKUP_SECRET_HEADER = "x-schedi-connect-backup-secret";
export const BACKUP_SECRET_MIN_LENGTH = 32;
const BUSY_TIMEOUT_MS = 2_000;
const SECRET_MAX_LENGTH = 512;

export interface SqliteSnapshotOptions {
  maxBytes?: number;
  timeoutMs?: number;
  workRoot?: string;
  inspectSnapshotFile?: (path: string) => void;
}

/** True only for a configured secret of bounded length. There is no default. */
export function backupSecretConfigured(secret: string | undefined): boolean {
  return typeof secret === "string" && secret.length >= BACKUP_SECRET_MIN_LENGTH && secret.length <= SECRET_MAX_LENGTH;
}

/** Dedicated backup secret. Empty, short, or mismatched values fail closed. */
export function backupSecretAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!backupSecretConfigured(secret) || typeof secret !== "string") return false;
  if (typeof header !== "string" || header.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(secret));
}

export function snapshotSqliteDatabase(sourcePath: string, options: SqliteSnapshotOptions = {}): Buffer {
  assertSourcePath(sourcePath);
  const maxBytes = capBytes(options.maxBytes);
  const timeoutMs = capTimeout(options.timeoutMs);
  const occupied = occupiedBytes(sourcePath);
  if (occupied > maxBytes) throw new SchediError("Database is too large to snapshot.", 413);

  const workRoot = options.workRoot ?? tmpdir();
  assertWorkRoot(workRoot);
  const workDir = mkdtempSync(/*turbopackIgnore: true*/ join(workRoot, "schedi-sqlite-snapshot-"));
  const snapshotPath = join(workDir, "snapshot.sqlite");
  try {
    chmodSync(/*turbopackIgnore: true*/ workDir, 0o700);
    copyWithVacuum(sourcePath, snapshotPath, timeoutMs);
    chmodSync(/*turbopackIgnore: true*/ snapshotPath, 0o600);
    const snapshotSize = statSync(/*turbopackIgnore: true*/ snapshotPath).size;
    if (snapshotSize > maxBytes) throw new SchediError("Database is too large to snapshot.", 413);
    assertSnapshotIntegrity(snapshotPath);
    options.inspectSnapshotFile?.(snapshotPath);
    return readFileSync(/*turbopackIgnore: true*/ snapshotPath);
  } catch (error) {
    throw asSnapshotError(error);
  } finally {
    rmSync(/*turbopackIgnore: true*/ workDir, { recursive: true, force: true });
  }
}

function capBytes(value: number | undefined): number {
  if (value == null) return SQLITE_SNAPSHOT_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > SQLITE_SNAPSHOT_MAX_BYTES) {
    throw new SchediError("Could not snapshot the database.", 500);
  }
  return value;
}

function capTimeout(value: number | undefined): number {
  if (value == null) return BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > BUSY_TIMEOUT_MS) {
    throw new SchediError("Could not snapshot the database.", 500);
  }
  return value;
}

function assertSourcePath(path: string): void {
  if (!path || path === ":memory:" || path.includes("\0") || hasUnsafeSegment(path)) {
    throw new SchediError("Database file is not available.", 404);
  }
}

function assertWorkRoot(path: string): void {
  if (!path || path.includes("\0") || hasUnsafeSegment(path)) {
    throw new SchediError("Could not snapshot the database.", 500);
  }
  const info = statSync(/*turbopackIgnore: true*/ path);
  if (!info.isDirectory()) throw new SchediError("Could not snapshot the database.", 500);
}

function hasUnsafeSegment(path: string): boolean {
  return path.split(/[/\\]/).includes("..");
}

function occupiedBytes(path: string): number {
  let total = 0;
  let found = false;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const info = statSync(/*turbopackIgnore: true*/ candidate);
      if (!info.isFile()) continue;
      found = candidate === path || found;
      total += info.size;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw new SchediError("Database file is not available.", 404);
    }
  }
  if (!found) throw new SchediError("Database file is missing.", 404);
  return total;
}

function sqlStringLiteral(path: string): string {
  if (!/^[\w./+\-]+$/.test(path)) throw new SchediError("Could not snapshot the database.", 500);
  return `'${path}'`;
}

function copyWithVacuum(sourcePath: string, snapshotPath: string, timeoutMs: number): void {
  const source = new DatabaseSync(sourcePath, { readOnly: true, timeout: timeoutMs });
  try {
    try {
      source.exec("PRAGMA wal_autocheckpoint = 0");
    } catch {
      // A read-only handle may refuse the pragma. The connection default
      // still must not be required to checkpoint before the copy.
    }
    source.exec(`VACUUM INTO ${sqlStringLiteral(snapshotPath)}`);
  } finally {
    source.close();
  }
}

function assertSnapshotIntegrity(snapshotPath: string): void {
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const row = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (!row || row.integrity_check !== "ok") {
      throw new SchediError("Could not snapshot the database.", 500);
    }
    const journal = snapshot.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    if (!journal || journal.journal_mode !== "delete") {
      throw new SchediError("Could not snapshot the database.", 500);
    }
  } finally {
    snapshot.close();
  }
}

function asSnapshotError(error: unknown): SchediError {
  if (error instanceof SchediError) return error;
  const code = String((error as { code?: unknown }).code || "");
  const message = error instanceof Error ? error.message : "";
  if (code === "ENOENT" || /unable to open database file/i.test(message) || message.includes("SQLITE_CANTOPEN")) {
    return new SchediError("Database file is missing.", 404);
  }
  if (code === "SQLITE_BUSY" || /database is locked/i.test(message) || message.includes("SQLITE_BUSY")) {
    return new SchediError("Database is busy.", 503);
  }
  if (/not a database/i.test(message) || message.includes("SQLITE_NOTADB")) {
    return new SchediError("Database file is not a SQLite database.", 404);
  }
  return new SchediError("Could not snapshot the database.", 500);
}
