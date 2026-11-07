import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { POST, GET } from "../src/app/api/admin/sqlite-snapshot/route";
import { SchediError } from "../src/lib/errors";
import {
  BACKUP_SECRET_HEADER,
  BACKUP_SECRET_MIN_LENGTH,
  snapshotSqliteDatabase,
} from "../src/lib/sqlite-snapshot";

const dirs: string[] = [];
const priorEnv = {
  backup: process.env.SCHEDI_CONNECT_BACKUP_SECRET,
  paid: process.env.SCHEDI_CONNECT_PAID_SECRET,
  path: process.env.SCHEDI_DB_PATH,
};
const SECRET = "b".repeat(BACKUP_SECRET_MIN_LENGTH);

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "schedi-snapshot-test-"));
  dirs.push(dir);
  return dir;
}

function walDatabase(dir: string): { path: string; db: DatabaseSync } {
  const path = join(dir, "live.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA wal_autocheckpoint = 0");
  db.exec("CREATE TABLE owners (id TEXT PRIMARY KEY, email TEXT)");
  db.exec("INSERT INTO owners (id, email) VALUES ('owner-1', 'kept@example.com')");
  return { path, db };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (priorEnv.backup == null) delete process.env.SCHEDI_CONNECT_BACKUP_SECRET;
  else process.env.SCHEDI_CONNECT_BACKUP_SECRET = priorEnv.backup;
  if (priorEnv.paid == null) delete process.env.SCHEDI_CONNECT_PAID_SECRET;
  else process.env.SCHEDI_CONNECT_PAID_SECRET = priorEnv.paid;
  if (priorEnv.path == null) delete process.env.SCHEDI_DB_PATH;
  else process.env.SCHEDI_DB_PATH = priorEnv.path;
});

function openSnapshot(bytes: Buffer, dir: string): DatabaseSync {
  const path = join(dir, "restored.sqlite");
  writeFileSync(path, bytes);
  return new DatabaseSync(path, { readOnly: true });
}

describe("online SQLite snapshot", () => {
  it("copies committed WAL rows into one file and leaves the source untouched", () => {
    const dir = tempDir();
    const { path, db } = walDatabase(dir);
    const mainBefore = readFileSync(path);
    const walBefore = statSync(`${path}-wal`).size;
    const masterBefore = JSON.stringify(db.prepare("SELECT type, name, sql FROM sqlite_master").all());
    let mode = 0;
    const workRoot = tempDir();

    const bytes = snapshotSqliteDatabase(path, {
      workRoot,
      inspectSnapshotFile(snapshotPath) {
        mode = statSync(snapshotPath).mode & 0o777;
        expect(statSync(join(snapshotPath, "..")).mode & 0o777).toBe(0o700);
        expect(readdirSync(join(snapshotPath, "..")).sort()).toEqual(["snapshot.sqlite"]);
      },
    });

    expect(mode).toBe(0o600);
    expect(readdirSync(workRoot)).toEqual([]);
    expect(readFileSync(path).equals(mainBefore)).toBe(true);
    expect(statSync(`${path}-wal`).size).toBe(walBefore);
    expect(JSON.stringify(db.prepare("SELECT type, name, sql FROM sqlite_master").all())).toBe(masterBefore);
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });

    const rawMain = join(dir, "raw-main.sqlite");
    writeFileSync(rawMain, mainBefore);
    const raw = new DatabaseSync(rawMain, { readOnly: true });
    let rawCount = 0;
    try {
      rawCount = Number((raw.prepare("SELECT count(*) AS n FROM owners").get() as { n: number }).n);
    } catch {
      rawCount = 0;
    } finally {
      raw.close();
    }
    expect(rawCount).toBe(0);

    const restored = openSnapshot(bytes, dir);
    try {
      expect(restored.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(restored.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect(restored.prepare("SELECT email FROM owners").all()).toEqual([{ email: "kept@example.com" }]);
      expect(readdirSync(dir).some((name) => name.startsWith("restored.sqlite-"))).toBe(false);
    } finally {
      restored.close();
      db.close();
    }
  });

  it("omits an uncommitted row and does not shrink the source WAL", async () => {
    const dir = tempDir();
    const { path, db } = walDatabase(dir);
    const ready = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(
      `
      const { workerData, parentPort } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData.path);
      db.exec("PRAGMA busy_timeout = 1000");
      try {
        db.exec("BEGIN IMMEDIATE");
        db.exec("INSERT INTO owners (id, email) VALUES ('owner-2', 'hidden@example.com')");
        Atomics.store(workerData.ready, 0, 1);
        Atomics.notify(workerData.ready, 0);
        Atomics.wait(workerData.ready, 0, 1);
        db.exec("ROLLBACK");
        parentPort.postMessage({ ok: true });
      } catch (error) {
        parentPort.postMessage({ ok: false, message: String(error && error.message || error) });
      } finally {
        db.close();
      }
      `,
      { eval: true, workerData: { path, ready } },
    );
    const finished = new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    const woke = Atomics.wait(ready, 0, 0, 2000);
    expect(woke).not.toBe("timed-out");
    const walBefore = statSync(`${path}-wal`).size;
    const bytes = snapshotSqliteDatabase(path, { workRoot: tempDir() });
    expect(statSync(`${path}-wal`).size).toBe(walBefore);
    Atomics.store(ready, 0, 2);
    Atomics.notify(ready, 0);
    await expect(finished).resolves.toEqual({ ok: true });

    const restored = openSnapshot(bytes, dir);
    try {
      expect(restored.prepare("SELECT email FROM owners ORDER BY email").all()).toEqual([{ email: "kept@example.com" }]);
      expect(db.prepare("SELECT email FROM owners").all()).toEqual([{ email: "kept@example.com" }]);
    } finally {
      restored.close();
      db.close();
    }
  });

  it("returns busy instead of waiting out an exclusive lock", () => {
    const dir = tempDir();
    const path = join(dir, "live.sqlite");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=DELETE");
    db.exec("CREATE TABLE owners (id TEXT PRIMARY KEY, email TEXT)");
    db.exec("INSERT INTO owners (id, email) VALUES ('owner-1', 'kept@example.com')");
    db.exec("BEGIN EXCLUSIVE");
    const started = Date.now();
    const error = (() => {
      try {
        snapshotSqliteDatabase(path, { timeoutMs: 200, workRoot: tempDir() });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(error).toBeInstanceOf(SchediError);
    expect(error).toMatchObject({ status: 503, message: "Database is busy." });
    expect(String((error as Error).message)).not.toContain(path);
    db.exec("ROLLBACK");
    const bytes = snapshotSqliteDatabase(path, { workRoot: tempDir() });
    db.close();
    const restored = openSnapshot(bytes, dir);
    try {
      expect(restored.prepare("SELECT email FROM owners").all()).toEqual([{ email: "kept@example.com" }]);
    } finally {
      restored.close();
    }
  });

  it("refuses oversized, missing, and non-database files without leaving a snapshot behind", () => {
    const dir = tempDir();
    const workRoot = tempDir();
    const missing = join(dir, "missing.sqlite");
    expect(() => snapshotSqliteDatabase(missing, { workRoot })).toThrowError(
      expect.objectContaining({ status: 404, message: "Database file is missing." }),
    );

    const notes = join(dir, "notes.sqlite");
    writeFileSync(notes, "person@example.com");
    const refused = (() => {
      try {
        snapshotSqliteDatabase(notes, { workRoot });
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(refused).toMatchObject({ status: 404, message: "Database file is not a SQLite database." });
    expect(String((refused as Error).message)).not.toContain("person@example.com");
    expect(readFileSync(notes).toString()).toBe("person@example.com");

    const { path, db } = walDatabase(dir);
    expect(() => snapshotSqliteDatabase(path, { maxBytes: 80, workRoot })).toThrowError(
      expect.objectContaining({ status: 413, message: "Database is too large to snapshot." }),
    );
    db.close();
    expect(readdirSync(workRoot)).toEqual([]);
    expect(readdirSync(dir).some((name) => name.includes("snapshot"))).toBe(false);
  });
});

describe("sqlite snapshot route", () => {
  it("accepts only the dedicated backup secret and an empty command", async () => {
    const dir = tempDir();
    const { path, db } = walDatabase(dir);
    db.close();
    process.env.SCHEDI_DB_PATH = path;
    process.env.SCHEDI_CONNECT_PAID_SECRET = "p".repeat(BACKUP_SECRET_MIN_LENGTH);
    delete process.env.SCHEDI_CONNECT_BACKUP_SECRET;

    const unconfigured = await POST(new Request("https://connect.example/api/admin/sqlite-snapshot", { method: "POST" }));
    expect(unconfigured.status).toBe(503);
    await expect(unconfigured.json()).resolves.toEqual({ ok: false, error: "Backup is not configured." });

    process.env.SCHEDI_CONNECT_BACKUP_SECRET = "short-secret";
    const weak = await POST(
      new Request("https://connect.example/api/admin/sqlite-snapshot", {
        method: "POST",
        headers: { [BACKUP_SECRET_HEADER]: "short-secret" },
      }),
    );
    expect(weak.status).toBe(503);

    process.env.SCHEDI_CONNECT_BACKUP_SECRET = SECRET;
    const paid = await POST(
      new Request("https://connect.example/api/admin/sqlite-snapshot", {
        method: "POST",
        headers: { "x-schedi-connect-secret": process.env.SCHEDI_CONNECT_PAID_SECRET },
      }),
    );
    expect(paid.status).toBe(401);
    const wrong = await POST(
      new Request("https://connect.example/api/admin/sqlite-snapshot", {
        method: "POST",
        headers: { [BACKUP_SECRET_HEADER]: "c".repeat(BACKUP_SECRET_MIN_LENGTH) },
      }),
    );
    expect(wrong.status).toBe(401);

    const before = readFileSync(path);
    for (const body of [
      JSON.stringify({ freeze: true }),
      JSON.stringify({ import: true }),
      JSON.stringify({ sql: "DROP TABLE owners" }),
      JSON.stringify({ path: "/tmp/other.sqlite" }),
      JSON.stringify({ ok: true }),
    ]) {
      const refused = await POST(
        new Request("https://connect.example/api/admin/sqlite-snapshot", {
          method: "POST",
          headers: { [BACKUP_SECRET_HEADER]: SECRET, "content-type": "application/json" },
          body,
        }),
      );
      expect(refused.status).toBe(400);
      await expect(refused.json()).resolves.toEqual({ ok: false, error: "This route only copies the database." });
    }
    expect(readFileSync(path).equals(before)).toBe(true);

    const response = await POST(
      new Request("https://connect.example/api/admin/sqlite-snapshot", {
        method: "POST",
        headers: { [BACKUP_SECRET_HEADER]: SECRET },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="schedi-connect-snapshot.sqlite"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(bytes.subarray(0, 16).toString()).toBe("SQLite format 3\u0000");
    expect(bytes.toString("utf8")).not.toContain(SECRET);
    const restored = openSnapshot(bytes, dir);
    try {
      expect(restored.prepare("SELECT email FROM owners").all()).toEqual([{ email: "kept@example.com" }]);
    } finally {
      restored.close();
    }

    const get = await GET();
    expect(get.status).toBe(405);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("does not open the store, read the live file, or accept a freeze", () => {
    const route = readFileSync(new URL("../src/app/api/admin/sqlite-snapshot/route.ts", import.meta.url), "utf8");
    const helper = readFileSync(new URL("../src/lib/sqlite-snapshot.ts", import.meta.url), "utf8");
    expect(route).toContain("SCHEDI_CONNECT_BACKUP_SECRET");
    expect(route).not.toContain("SCHEDI_CONNECT_PAID_SECRET");
    expect(route).not.toContain("openStore");
    expect(route).not.toContain("getStore");
    expect(route).not.toContain("readSqliteDatabaseBytes");
    expect(route).not.toContain("request-gate");
    expect(route).not.toMatch(/\bfreeze\b/);
    expect(route).not.toContain("console.");
    expect(helper).not.toContain("readFileSync(sourcePath)");
    expect(helper).not.toContain("wal_checkpoint");
    expect(helper).toContain("VACUUM INTO");
    expect(helper).toContain("readOnly: true");
  });
});
