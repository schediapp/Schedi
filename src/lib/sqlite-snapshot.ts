import { timingSafeEqual } from "node:crypto";
import { chmodSync, createReadStream, lstatSync, mkdtempSync, readdirSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Worker } from "node:worker_threads";
import { backup } from "node:sqlite";
import { SchediError } from "./errors";

/**
 * Online backup of the Connect SQLite file.
 *
 * `node:sqlite` `backup` is sqlite3_backup_init/step/finish. It is asynchronous
 * and has been in Node since 22.16.0 (also 23.8.0). It is separate from a vacuum rewrite.
 * Official docs: https://nodejs.org/docs/latest-v22.x/api/sqlite.html
 * and https://nodejs.org/docs/latest-v24.x/api/sqlite.html
 * CI installs Node 22. This process must export `backup` or the route fails closed.
 *
 * The copy runs in a worker thread so the Next.js event loop is not inside SQLite.
 * A wall-clock deadline and request abort terminate that worker. DatabaseSync
 * `timeout` is only the lock wait. Another connection's commits can restart the
 * backup; the deadline stops a restart loop. The source is opened read-only.
 * The live file is not read or duplicated with a filesystem copy, and its WAL is not checkpointed.
 * The destination journal is set to delete so the download is one file.
 * One backup and its download are admitted per process. A second replica has its own lock.
 */
export const SQLITE_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
export const SQLITE_SNAPSHOT_DEADLINE_MS = 20_000;
export const BACKUP_SECRET_HEADER = "x-schedi-connect-backup-secret";
export const BACKUP_SECRET_MIN_LENGTH = 32;
const SECRET_MAX_LENGTH = 512;
const LOCK_TIMEOUT_MS = 2_000;
const PAGE_RATE = 16;
const STREAM_HIGH_WATER_BYTES = 64 * 1024;
const STALE_DIR_LIMIT = 20;
const ASCII_SECRET = /^[\x21-\x7E]+$/;
const STALE_DIR_NAME = /^schedi-sqlite-snapshot-[A-Za-z0-9]{6}$/;
const WORKER_HEAP_MB = 64;

const WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync, statSync, statfsSync } from "node:fs";
import { dirname } from "node:path";

const input = workerData;
let sent = false;
const fail = (code) => {
  if (sent) return;
  sent = true;
  parentPort.postMessage({ ok: false, code });
  throw new Error("backup-stop");
};
const occupied = (path) => {
  let total = 0;
  let found = false;
  for (const candidate of [path, path + "-wal", path + "-shm"]) {
    try {
      const info = lstatSync(candidate);
      if (info.isSymbolicLink()) fail("failed");
      if (!info.isFile()) continue;
      found = candidate === path || found;
      total += info.size;
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      fail("missing");
    }
  }
  if (!found) fail("missing");
  return total;
};
const guard = (pageBytes) => {
  if (Date.now() > input.deadlineAt) fail("timeout");
  if (pageBytes > input.maxBytes) fail("too_large");
  if (occupied(input.sourcePath) > input.maxBytes) fail("too_large");
  try {
    const space = statfsSync(dirname(input.snapshotPath));
    if (Number(space.bavail) * Number(space.bsize) < input.maxBytes) fail("full");
  } catch {
    fail("full");
  }
};

async function main() {
try {
  if (Date.now() > input.deadlineAt) fail("timeout");
  const sourceInfo = lstatSync(input.sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) fail("missing");
  const source = new DatabaseSync(input.sourcePath, { readOnly: true, timeout: input.lockTimeoutMs });
  try {
    try { source.exec("PRAGMA wal_autocheckpoint = 0"); } catch { /* read-only may ignore */ }
    const page = source.prepare("PRAGMA page_size").get();
    const pageSize = Number(page && page.page_size) || 4096;
    await backup(source, input.snapshotPath, {
      rate: input.rate,
      progress({ totalPages }) {
        if (input.stepDelayMs > 0) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, input.stepDelayMs);
        }
        const pages = Number(totalPages) || 0;
        guard(pages > 0 && pageSize > 0 ? pages * pageSize : 0);
      },
    });
  } finally {
    source.close();
  }
  if (sent) return;
  chmodSync(input.snapshotPath, 0o600);
  guard(statSync(input.snapshotPath).size);
  const destination = new DatabaseSync(input.snapshotPath);
  try {
    destination.exec("PRAGMA journal_mode = DELETE");
    const integrity = destination.prepare("PRAGMA integrity_check").get();
    const journal = destination.prepare("PRAGMA journal_mode").get();
    if (!integrity || integrity.integrity_check !== "ok") fail("failed");
    if (!journal || journal.journal_mode !== "delete") fail("failed");
  } finally {
    destination.close();
  }
  const bytes = statSync(input.snapshotPath).size;
  guard(bytes);
  chmodSync(input.snapshotPath, 0o600);
  if (!sent) parentPort.postMessage({ ok: true, bytes });
} catch (error) {
  if (sent) return;
  const code = String(error && error.code || "");
  const message = String(error && error.message || "");
  let failure = "failed";
  if (code === "SQLITE_BUSY" || /database is locked/i.test(message) || message.includes("SQLITE_BUSY") || message.trim() === "not an error") failure = "busy";
  else if (/not a database/i.test(message) || message.includes("SQLITE_NOTADB")) failure = "not_database";
  else if (code === "ENOENT" || /unable to open database file/i.test(message) || message.includes("SQLITE_CANTOPEN")) failure = "missing";
  else if (code === "ENOSPC" || message.includes("SQLITE_FULL") || /no space/i.test(message)) failure = "full";
  sent = true;
  parentPort.postMessage({ ok: false, code: failure });
}
}
main();
`;

export interface SqliteSnapshotOptions {
  maxBytes?: number;
  deadlineMs?: number;
  lockTimeoutMs?: number;
  reserveBytes?: number;
  workRoot?: string;
  rate?: number;
  /** Test-only pause between backup steps. The route cannot set it. */
  stepDelayMs?: number;
  signal?: AbortSignal;
  inspectSnapshotFile?: (path: string) => void;
}

export interface SnapshotDownload {
  bytes: number;
  stream: ReadableStream<Uint8Array>;
  release: () => void;
}

let activeRelease: (() => void) | null = null;

/** Drops a leaked in-process admission after a failed test. */
export function releaseActiveSnapshotForTests(): void {
  activeRelease?.();
}

/** ASCII only, so equal character counts cannot reach timingSafeEqual with unequal byte lengths. */
export function backupSecretConfigured(secret: string | undefined): boolean {
  return typeof secret === "string" && ASCII_SECRET.test(secret) && secret.length >= BACKUP_SECRET_MIN_LENGTH && secret.length <= SECRET_MAX_LENGTH;
}

/** Dedicated backup secret. Empty, short, non-ASCII, or mismatched values fail closed. */
export function backupSecretAuthorized(header: string | null, secret: string | undefined): boolean {
  try {
    if (!backupSecretConfigured(secret) || typeof secret !== "string") return false;
    if (typeof header !== "string" || !ASCII_SECRET.test(header) || header.length !== secret.length) return false;
    const left = Buffer.from(header, "utf8");
    const right = Buffer.from(secret, "utf8");
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export async function snapshotSqliteDatabase(
  sourcePath: string,
  options: SqliteSnapshotOptions = {},
): Promise<SnapshotDownload> {
  if (typeof backup !== "function") {
    throw new SchediError("Backup is not available on this runtime.", 503);
  }
  if (activeRelease) throw new SchediError("Another backup is already running.", 429);
  assertSourcePath(sourcePath);
  const maxBytes = boundedInt(options.maxBytes, SQLITE_SNAPSHOT_MAX_BYTES, SQLITE_SNAPSHOT_MAX_BYTES);
  const deadlineMs = boundedInt(options.deadlineMs, SQLITE_SNAPSHOT_DEADLINE_MS, SQLITE_SNAPSHOT_DEADLINE_MS, 1);
  const lockCap = Math.min(LOCK_TIMEOUT_MS, deadlineMs);
  const lockTimeoutMs = boundedInt(options.lockTimeoutMs, lockCap, lockCap, 1);
  const reserveBytes = boundedInt(options.reserveBytes, maxBytes, Number.MAX_SAFE_INTEGER);
  if (reserveBytes < maxBytes) throw new SchediError("Could not snapshot the database.", 500);
  const rate = boundedInt(options.rate, PAGE_RATE, PAGE_RATE, 1);
  const stepDelayMs = boundedInt(options.stepDelayMs, 0, 50, 0);

  let released = false;
  let workDir: string | undefined;
  const release = () => {
    if (released) return;
    released = true;
    if (activeRelease === release) activeRelease = null;
    if (workDir) rmSync(/*turbopackIgnore: true*/ workDir, { recursive: true, force: true });
    workDir = undefined;
  };
  activeRelease = release;

  try {
    if (options.signal?.aborted) throw new SchediError("Backup was cancelled.", 503);
    let sourceInfo;
    try {
      sourceInfo = lstatSync(/*turbopackIgnore: true*/ sourcePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new SchediError("Database file is missing.", 404);
      throw new SchediError("Database file is not available.", 404);
    }
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new SchediError("Database file is missing.", 404);
    }
    const occupied = occupiedBytes(sourcePath);
    if (occupied > maxBytes) throw new SchediError("Database is too large to snapshot.", 413);
    const workRoot = options.workRoot ?? tmpdir();
    assertWorkRoot(workRoot);
    requireFreeSpace(dirnameOf(sourcePath), reserveBytes);
    requireFreeSpace(workRoot, reserveBytes);
    removeStaleWorkDirs(workRoot);
    workDir = mkdtempSync(/*turbopackIgnore: true*/ join(workRoot, "schedi-sqlite-snapshot-"));
    chmodDir(workDir);
    const snapshotPath = join(workDir, "snapshot.sqlite");
    const outcome = await runBackupWorker(
      {
        sourcePath,
        snapshotPath,
        deadlineAt: Date.now() + deadlineMs,
        maxBytes,
        rate,
        lockTimeoutMs,
        stepDelayMs,
      },
      deadlineMs,
      options.signal,
    );
    if (!outcome.ok) throw errorForCode(outcome.code);
    if (!Number.isSafeInteger(outcome.bytes) || outcome.bytes < 1 || outcome.bytes > maxBytes) {
      throw new SchediError("Could not snapshot the database.", 500);
    }
    options.inspectSnapshotFile?.(snapshotPath);
    const nodeStream = createReadStream(/*turbopackIgnore: true*/ snapshotPath, {
      highWaterMark: STREAM_HIGH_WATER_BYTES,
    });
    nodeStream.on("close", release);
    options.signal?.addEventListener("abort", () => {
      nodeStream.destroy();
      release();
    }, { once: true });
    return {
      bytes: outcome.bytes,
      stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      release,
    };
  } catch (error) {
    release();
    throw asSnapshotError(error);
  }
}

function boundedInt(value: number | undefined, fallback: number, max: number, min = 0): number {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new SchediError("Could not snapshot the database.", 500);
  }
  return value;
}

function dirnameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash > 0 ? path.slice(0, slash) : ".";
}

function requireFreeSpace(path: string, bytes: number): void {
  let space: { bavail: number | bigint; bsize: number | bigint };
  try {
    space = statfsSync(/*turbopackIgnore: true*/ path);
  } catch {
    throw new SchediError("Backup storage is full.", 507);
  }
  if (Number(space.bavail) * Number(space.bsize) < bytes) {
    throw new SchediError("Backup storage is full.", 507);
  }
}

function removeStaleWorkDirs(workRoot: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(/*turbopackIgnore: true*/ workRoot);
  } catch {
    return;
  }
  let removed = 0;
  for (const name of names) {
    if (removed >= STALE_DIR_LIMIT || !STALE_DIR_NAME.test(name)) continue;
    const path = join(workRoot, name);
    try {
      const info = lstatSync(/*turbopackIgnore: true*/ path);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      rmSync(/*turbopackIgnore: true*/ path, { recursive: true, force: true });
      removed += 1;
    } catch {
      continue;
    }
  }
}

function chmodDir(path: string): void {
  chmodSync(/*turbopackIgnore: true*/ path, 0o700);
}

interface WorkerInput {
  sourcePath: string;
  snapshotPath: string;
  deadlineAt: number;
  maxBytes: number;
  rate: number;
  lockTimeoutMs: number;
  stepDelayMs: number;
}

interface WorkerSuccess {
  ok: true;
  bytes: number;
}

interface WorkerFailure {
  ok: false;
  code: string;
}

function runBackupWorker(
  input: WorkerInput,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<WorkerSuccess | WorkerFailure> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`), {
      workerData: input,
      resourceLimits: {
        maxOldGenerationSizeMb: WORKER_HEAP_MB,
        maxYoungGenerationSizeMb: 16,
      },
    });
    const finish = (result: WorkerSuccess | WorkerFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate().catch(() => undefined);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "timeout" }), deadlineMs);
    const onAbort = () => finish({ ok: false, code: "cancelled" });
    if (signal?.aborted) {
      finish({ ok: false, code: "cancelled" });
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (message: WorkerSuccess | WorkerFailure) => finish(message));
    worker.on("error", () => finish({ ok: false, code: "failed" }));
    worker.on("exit", () => {
      if (!settled) finish({ ok: false, code: "failed" });
    });
  });
}

function errorForCode(code: string): SchediError {
  if (code === "timeout") return new SchediError("Backup timed out.", 503);
  if (code === "cancelled") return new SchediError("Backup was cancelled.", 503);
  if (code === "busy") return new SchediError("Database is busy.", 503);
  if (code === "too_large") return new SchediError("Database is too large to snapshot.", 413);
  if (code === "full") return new SchediError("Backup storage is full.", 507);
  if (code === "missing") return new SchediError("Database file is missing.", 404);
  if (code === "not_database") return new SchediError("Database file is not a SQLite database.", 404);
  return new SchediError("Could not snapshot the database.", 500);
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
  const info = lstatSync(/*turbopackIgnore: true*/ path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SchediError("Could not snapshot the database.", 500);
}

function hasUnsafeSegment(path: string): boolean {
  return path.split(/[/\\]/).includes("..");
}

function occupiedBytes(path: string): number {
  let total = 0;
  let found = false;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const info = lstatSync(/*turbopackIgnore: true*/ candidate);
      if (info.isSymbolicLink()) throw new SchediError("Database file is not available.", 404);
      if (!info.isFile()) continue;
      found = candidate === path || found;
      total += info.size;
    } catch (error) {
      if (error instanceof SchediError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw new SchediError("Database file is not available.", 404);
    }
  }
  if (!found) throw new SchediError("Database file is missing.", 404);
  return total;
}

function asSnapshotError(error: unknown): SchediError {
  if (error instanceof SchediError) return error;
  return errorForCode("failed");
}

