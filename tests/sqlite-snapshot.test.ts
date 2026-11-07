import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { GET, POST } from "../src/app/api/admin/sqlite-snapshot/route";
import { SchediError } from "../src/lib/errors";
import {
  BACKUP_SECRET_HEADER,
  BACKUP_SECRET_MIN_LENGTH,
  backupSecretAuthorized,
  backupSecretConfigured,
  releaseActiveSnapshotForTests,
  snapshotSqliteDatabase,
  type SnapshotDownload,
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

async function readDownload(download: SnapshotDownload): Promise<Buffer> {
  const bytes = Buffer.from(await new Response(download.stream).arrayBuffer());
  await download.release();
  return bytes;
}

afterEach(async () => {
  await releaseActiveSnapshotForTests();
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
  it("uses the node:sqlite backup API on this runtime", () => {
    expect(typeof backup).toBe("function");
    expect(process.versions.node.split(".").map(Number)[0]).toBeGreaterThanOrEqual(22);
  });

  it("copies committed WAL rows into one file and leaves the source main bytes unchanged", async () => {
    const dir = tempDir();
    const { path, db } = walDatabase(dir);
    const mainBefore = readFileSync(path);
    const walBefore = statSync(`${path}-wal`).size;
    const masterBefore = JSON.stringify(db.prepare("SELECT type, name, sql FROM sqlite_master").all());
    let mode = 0;
    const workRoot = tempDir();

    const download = await snapshotSqliteDatabase(path, {
      workRoot,
      inspectSnapshotFile(snapshotPath) {
        mode = statSync(snapshotPath).mode & 0o777;
        expect(statSync(join(snapshotPath, "..")).mode & 0o777).toBe(0o700);
      },
    });
    const bytes = await readDownload(download);

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
    } finally {
      restored.close();
      db.close();
    }
  });

  it("keeps a multi-table commit atomic while another connection writes", async () => {
    const dir = tempDir();
    const path = join(dir, "live.sqlite");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.exec("CREATE TABLE owners (id TEXT PRIMARY KEY, email TEXT)");
    db.exec("CREATE TABLE bookings (id TEXT PRIMARY KEY, owner_id TEXT)");
    db.exec("INSERT INTO owners (id, email) VALUES ('owner-1', 'kept@example.com')");
    db.exec("INSERT INTO bookings (id, owner_id) VALUES ('booking-1', 'owner-1')");
    const mainBefore = readFileSync(path);
    const walBefore = statSync(`${path}-wal`).size;
    const stop = new Int32Array(new SharedArrayBuffer(4));
    const writer = new Worker(
      new URL(
        "data:text/javascript," +
          encodeURIComponent(`
            import { parentPort, workerData } from "node:worker_threads";
            import { DatabaseSync } from "node:sqlite";
            const db = new DatabaseSync(workerData.path);
            db.exec("PRAGMA wal_autocheckpoint = 0");
            let n = 0;
            while (Atomics.load(workerData.stop, 0) === 0 && n < 40) {
              db.exec("BEGIN");
              db.exec("INSERT INTO owners (id, email) VALUES ('w" + n + "', 'w" + n + "@example.com')");
              db.exec("INSERT INTO bookings (id, owner_id) VALUES ('b" + n + "', 'w" + n + "')");
              db.exec("COMMIT");
              n += 1;
            }
            db.close();
            parentPort.postMessage({ n });
          `),
      ),
      { workerData: { path, stop } },
    );
    const finished = new Promise((resolve, reject) => {
      writer.once("message", resolve);
      writer.once("error", reject);
    });
    const ticks = { n: 0 };
    const timer = setInterval(() => {
      ticks.n += 1;
    }, 10);
    const download = await snapshotSqliteDatabase(path, { workRoot: tempDir(), stepDelayMs: 15, rate: 1 });
    clearInterval(timer);
    Atomics.store(stop, 0, 1);
    const writerResult = (await finished) as { n: number };
    const bytes = await readDownload(download);
    expect(ticks.n).toBeGreaterThan(2);
    expect(writerResult.n).toBeGreaterThan(0);
    expect(readFileSync(path).equals(mainBefore)).toBe(true);
    expect(statSync(`${path}-wal`).size).toBeGreaterThanOrEqual(walBefore);
    const restored = openSnapshot(bytes, dir);
    try {
      const torn = restored
        .prepare(
          "SELECT count(*) AS n FROM bookings b LEFT JOIN owners o ON o.id = b.owner_id WHERE o.id IS NULL",
        )
        .get() as { n: number };
      expect(torn.n).toBe(0);
      expect(restored.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect((restored.prepare("SELECT count(*) AS n FROM bookings").get() as { n: number }).n).toBeGreaterThan(0);
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
      new URL(
        "data:text/javascript," +
          encodeURIComponent(`
            import { parentPort, workerData } from "node:worker_threads";
            import { DatabaseSync } from "node:sqlite";
            const db = new DatabaseSync(workerData.path);
            db.exec("BEGIN IMMEDIATE");
            db.exec("INSERT INTO owners (id, email) VALUES ('owner-2', 'hidden@example.com')");
            parentPort.postMessage({ ready: true });
            Atomics.wait(workerData.ready, 0, 0);
            db.exec("ROLLBACK");
            db.close();
            parentPort.postMessage({ ok: true });
          `),
      ),
      { workerData: { path, ready } },
    );
    await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    const walBefore = statSync(`${path}-wal`).size;
    const download = await snapshotSqliteDatabase(path, { workRoot: tempDir() });
    const bytes = await readDownload(download);
    expect(statSync(`${path}-wal`).size).toBe(walBefore);
    Atomics.store(ready, 0, 2);
    Atomics.notify(ready, 0);
    const restored = openSnapshot(bytes, dir);
    try {
      expect(restored.prepare("SELECT email FROM owners").all()).toEqual([{ email: "kept@example.com" }]);
      expect(db.prepare("SELECT email FROM owners").all()).toEqual([{ email: "kept@example.com" }]);
    } finally {
      restored.close();
      db.close();
      await worker.terminate();
    }
  });

  it("returns busy instead of waiting out an exclusive lock", async () => {
    const dir = tempDir();
    const path = join(dir, "live.sqlite");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=DELETE");
    db.exec("CREATE TABLE owners (id TEXT PRIMARY KEY, email TEXT)");
    db.exec("INSERT INTO owners (id, email) VALUES ('owner-1', 'kept@example.com')");
    db.exec("BEGIN EXCLUSIVE");
    const started = Date.now();
    const error = await snapshotSqliteDatabase(path, {
      lockTimeoutMs: 200,
      deadlineMs: 1_000,
      workRoot: tempDir(),
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(error).toBeInstanceOf(SchediError);
    expect(error).toMatchObject({ status: 503, message: "Database is busy." });
    expect(String((error as Error).message)).not.toContain(path);
    db.exec("ROLLBACK");
    const download = await snapshotSqliteDatabase(path, { workRoot: tempDir() });
    const bytes = await readDownload(download);
    db.close();
    const restored = openSnapshot(bytes, dir);
    try {
      expect(restored.prepare("SELECT email FROM owners").all()).toEqual([{ email: "kept@example.com" }]);
    } finally {
      restored.close();
    }
  });

  it("stops at the deadline and on abort without leaving a snapshot", async () => {
    const dir = tempDir();
    const { path, db } = walDatabase(dir);
    const mainBefore = readFileSync(path);
    const workRoot = tempDir();
    const timed = await snapshotSqliteDatabase(path, {
      workRoot,
      deadlineMs: 60,
      stepDelayMs: 40,
      rate: 1,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(timed).toMatchObject({ status: 503, message: "Backup timed out." });
    expect(readdirSync(workRoot)).toEqual([]);
    expect(readFileSync(path).equals(mainBefore)).toBe(true);

    const controller = new AbortController();
    const pending = snapshotSqliteDatabase(path, {
      workRoot,
      signal: controller.signal,
      stepDelayMs: 40,
      rate: 1,
      deadlineMs: 5_000,
    });
    setTimeout(() => controller.abort(), 20);
    const cancelled = await pending.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(cancelled).toMatchObject({ status: 503, message: "Backup was cancelled." });
    expect(readdirSync(workRoot)).toEqual([]);
    expect(readFileSync(path).equals(mainBefore)).toBe(true);
    db.close();
  });

  it("admits one download at a time and refuses growth, missing files, and full disks", async () => {
    const dir = tempDir();
    const workRoot = tempDir();
    const { path, db } = walDatabase(dir);
    const stale = join(workRoot, "schedi-sqlite-snapshot-abc123");
    mkdirSync(stale);
    writeFileSync(join(stale, "leftover"), "x");
    symlinkSync(dir, join(workRoot, "schedi-sqlite-snapshot-zzzzzz"));
    writeFileSync(join(workRoot, "schedi-sqlite-snapshot-aaaaaa"), "not-a-directory");

    const first = await snapshotSqliteDatabase(path, { workRoot });
    const overlap = await snapshotSqliteDatabase(path, { workRoot }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(overlap).toMatchObject({ status: 429, message: "Another backup is already running." });
    await readDownload(first);
    expect(readdirSync(workRoot).sort()).toEqual(["schedi-sqlite-snapshot-aaaaaa", "schedi-sqlite-snapshot-zzzzzz"]);

    const full = await snapshotSqliteDatabase(path, { workRoot, reserveBytes: 2 ** 50 }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(full).toMatchObject({ status: 507, message: "Backup storage is full." });
    const missing = await snapshotSqliteDatabase(join(dir, "missing.sqlite"), { workRoot }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(missing).toMatchObject({ status: 404, message: "Database file is missing." });
    const notes = join(dir, "notes.sqlite");
    writeFileSync(notes, "person@example.com");
    const notDb = await snapshotSqliteDatabase(notes, { workRoot }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(notDb).toMatchObject({ status: 404, message: "Database file is not a SQLite database." });
    expect(String((notDb as Error).message)).not.toContain("person@example.com");
    const tooBig = await snapshotSqliteDatabase(path, { workRoot, maxBytes: 80 }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(tooBig).toMatchObject({ status: 413, message: "Database is too large to snapshot." });
    expect(readFileSync(notes).toString()).toBe("person@example.com");
    expect(readdirSync(dir).some((name) => name.includes("snapshot"))).toBe(false);
    db.close();
  });

  it("keeps admission until the web consumer finishes, stalls, or is cancelled", async () => {
    const dir = tempDir();
    const { path, db } = walDatabase(dir);
    db.close();
    const workRoot = tempDir();
    let releases = 0;
    const waiting = await snapshotSqliteDatabase(path, {
      workRoot,
      idleDeadlineMs: 5_000,
      downloadDeadlineMs: 5_000,
      onReleased() {
        releases += 1;
      },
    });
    const early = await snapshotSqliteDatabase(path, { workRoot }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(early).toMatchObject({ status: 429, message: "Another backup is already running." });
    expect(releases).toBe(0);
    await waiting.stream.cancel();
    await waiting.release();
    expect(releases).toBe(1);
    expect(readdirSync(workRoot)).toEqual([]);

    const stalled = await snapshotSqliteDatabase(path, {
      workRoot,
      idleDeadlineMs: 80,
      downloadDeadlineMs: 5_000,
      onReleased() {
        releases += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readdirSync(workRoot)).toEqual([]);
    const afterStall = await snapshotSqliteDatabase(path, { workRoot });
    await readDownload(afterStall);
    expect(releases).toBe(2);
    await stalled.release();
    expect(releases).toBe(2);

    releases = 0;
    const partial = await snapshotSqliteDatabase(path, {
      workRoot,
      idleDeadlineMs: 80,
      downloadDeadlineMs: 5_000,
      streamHighWaterBytes: 32,
      onReleased() {
        releases += 1;
      },
    });
    const reader = partial.stream.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    expect(firstChunk.value?.byteLength).toBeGreaterThan(0);
    const during = await snapshotSqliteDatabase(path, { workRoot }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(during).toMatchObject({ status: 429 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(releases).toBe(1);
    const afterPartial = await snapshotSqliteDatabase(path, { workRoot });
    await readDownload(afterPartial);
    await partial.release();
    expect(releases).toBe(1);

    const slow = await snapshotSqliteDatabase(path, {
      workRoot,
      idleDeadlineMs: 160,
      downloadDeadlineMs: 160,
      streamHighWaterBytes: 32,
    });
    const slowReader = slow.stream.getReader();
    let received = 0;
    const started = Date.now();
    while (Date.now() - started < 700) {
      try {
        const next = await slowReader.read();
        if (next.done) break;
        received += next.value?.byteLength ?? 0;
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThan(slow.bytes);
    await slow.release();
    const afterSlow = await snapshotSqliteDatabase(path, { workRoot });
    await readDownload(afterSlow);
  });

  it("distinguishes a source error from a premature close and cleans up once", async () => {
    const dir = tempDir();
    const { path, db } = walDatabase(dir);
    db.close();
    const workRoot = tempDir();
    let releases = 0;
    const errored = await snapshotSqliteDatabase(path, {
      workRoot,
      idleDeadlineMs: 5_000,
      downloadDeadlineMs: 5_000,
      onReleased() {
        releases += 1;
      },
      inspectNodeStream(stream) {
        setImmediate(() => stream.destroy(Object.assign(new Error("read"), { code: "EIO" })));
      },
    });
    await expect(errored.stream.getReader().read()).rejects.toThrow(/Backup download failed/);
    await errored.release();
    expect(releases).toBe(1);
    expect(readdirSync(workRoot)).toEqual([]);

    const closed = await snapshotSqliteDatabase(path, {
      workRoot,
      idleDeadlineMs: 5_000,
      downloadDeadlineMs: 5_000,
      onReleased() {
        releases += 1;
      },
      inspectNodeStream(stream) {
        setImmediate(() => stream.destroy());
      },
    });
    await expect(closed.stream.getReader().read()).rejects.toThrow(/Backup download failed/);
    await closed.release();
    expect(releases).toBe(2);
    const retry = await snapshotSqliteDatabase(path, { workRoot });
    const bytes = await readDownload(retry);
    expect(bytes.subarray(0, 16).toString()).toBe("SQLite format 3\u0000");
  });

  it("rejects a retry while worker teardown is still holding admission", async () => {
    const dir = tempDir();
    const { path, db } = walDatabase(dir);
    db.close();
    const workRoot = tempDir();
    const order: string[] = [];
    const controller = new AbortController();
    const first = snapshotSqliteDatabase(path, {
      workRoot,
      signal: controller.signal,
      stepDelayMs: 20,
      rate: 1,
      deadlineMs: 5_000,
      holdAfterTerminateMs: 250,
      onWorkerTerminated() {
        order.push("exit");
      },
    }).then(
      () => order.push("resolve"),
      () => order.push("reject"),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toContain("exit");
    const during = await snapshotSqliteDatabase(path, { workRoot }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(during).toMatchObject({ status: 429, message: "Another backup is already running." });
    await first;
    expect(order.indexOf("exit")).toBeLessThan(order.indexOf("reject"));
    expect(readdirSync(workRoot)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(readdirSync(workRoot)).toEqual([]);
    const retry = await snapshotSqliteDatabase(path, { workRoot });
    const bytes = await readDownload(retry);
    const restored = openSnapshot(bytes, dir);
    try {
      expect(restored.prepare("SELECT email FROM owners").get()).toEqual({ email: "kept@example.com" });
    } finally {
      restored.close();
    }
  });

  it("rejects a non-ASCII secret without throwing", () => {
    const accented = "é".repeat(BACKUP_SECRET_MIN_LENGTH);
    expect(backupSecretConfigured(accented)).toBe(false);
    expect(backupSecretAuthorized(accented, SECRET)).toBe(false);
    expect(backupSecretAuthorized("\uD800".repeat(BACKUP_SECRET_MIN_LENGTH), SECRET)).toBe(false);
    expect(backupSecretAuthorized(SECRET, SECRET)).toBe(true);
  });
});

describe("sqlite snapshot route", () => {
  it("streams the snapshot and bounds the command body", async () => {
    const dir = tempDir();
    const { path, db } = walDatabase(dir);
    db.close();
    process.env.SCHEDI_DB_PATH = path;
    process.env.SCHEDI_CONNECT_PAID_SECRET = "p".repeat(BACKUP_SECRET_MIN_LENGTH);
    delete process.env.SCHEDI_CONNECT_BACKUP_SECRET;

    const unconfigured = await POST(new Request("https://connect.example/api/admin/sqlite-snapshot", { method: "POST" }));
    expect(unconfigured.status).toBe(503);

    process.env.SCHEDI_CONNECT_BACKUP_SECRET = "é".repeat(BACKUP_SECRET_MIN_LENGTH);
    const unicodeSecret = await POST(
      new Request("https://connect.example/api/admin/sqlite-snapshot", {
        method: "POST",
        headers: { [BACKUP_SECRET_HEADER]: "é".repeat(BACKUP_SECRET_MIN_LENGTH) },
      }),
    );
    expect(unicodeSecret.status).toBe(503);

    process.env.SCHEDI_CONNECT_BACKUP_SECRET = SECRET;
    const unicodeHeader = await POST(
      new Request("https://connect.example/api/admin/sqlite-snapshot", {
        method: "POST",
        headers: { [BACKUP_SECRET_HEADER]: "é".repeat(BACKUP_SECRET_MIN_LENGTH) },
      }),
    );
    expect(unicodeHeader.status).toBe(401);
    const paid = await POST(
      new Request("https://connect.example/api/admin/sqlite-snapshot", {
        method: "POST",
        headers: { "x-schedi-connect-secret": process.env.SCHEDI_CONNECT_PAID_SECRET },
      }),
    );
    expect(paid.status).toBe(401);

    let pulls = 0;
    const huge = new Request("https://connect.example/api/admin/sqlite-snapshot", {
      method: "POST",
      headers: { [BACKUP_SECRET_HEADER]: SECRET },
      body: new ReadableStream({
        pull(controller) {
          pulls += 1;
          if (pulls > 40) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(100));
        },
      }),
      duplex: "half",
    });
    const chunked = await POST(huge);
    expect(chunked.status).toBe(400);
    expect(pulls).toBeLessThan(20);

    let declaredPulls = 0;
    const declared = new Request("https://connect.example/api/admin/sqlite-snapshot", {
      method: "POST",
      headers: { [BACKUP_SECRET_HEADER]: SECRET, "content-length": "999999" },
      body: new ReadableStream({
        pull(controller) {
          declaredPulls += 1;
          if (declaredPulls > 40) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(100));
        },
      }),
      duplex: "half",
    });
    expect((await POST(declared)).status).toBe(400);
    expect(declaredPulls).toBeLessThan(20);

    const before = readFileSync(path);
    const response = await POST(
      new Request("https://connect.example/api/admin/sqlite-snapshot", {
        method: "POST",
        headers: { [BACKUP_SECRET_HEADER]: SECRET },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
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
    const overlap = await POST(
      new Request("https://connect.example/api/admin/sqlite-snapshot", {
        method: "POST",
        headers: { [BACKUP_SECRET_HEADER]: SECRET },
      }),
    );
    expect(overlap.status).toBe(200);
    await overlap.arrayBuffer();
    expect((await GET()).status).toBe(405);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("does not open the store, buffer the live file, or checkpoint", () => {
    const route = readFileSync(new URL("../src/app/api/admin/sqlite-snapshot/route.ts", import.meta.url), "utf8");
    const helper = readFileSync(new URL("../src/lib/sqlite-snapshot.ts", import.meta.url), "utf8");
    expect(route).toContain("SCHEDI_CONNECT_BACKUP_SECRET");
    expect(route).not.toContain("SCHEDI_CONNECT_PAID_SECRET");
    expect(route).not.toContain("openStore");
    expect(route).not.toContain("getStore");
    expect(route).not.toContain("readFile");
    expect(route).not.toContain("new Uint8Array(bytes)");
    expect(route).not.toMatch(/\bfreeze\b/);
    expect(route).not.toContain("console.");
    expect(helper).toContain("backup(source");
    expect(helper).not.toContain("VACUUM INTO");
    expect(helper).not.toContain("wal_checkpoint");
    expect(helper).not.toContain("readFileSync");
    expect(helper).not.toContain("copyFile(");
    expect(helper).not.toContain("copyFileSync");
    expect(helper).toContain("readOnly: true");
  });

  it(
    "serves a compiled Next server from a synthetic database",
    async () => {
      const dir = tempDir();
      const dbPath = join(dir, "synthetic.sqlite");
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE owners (id TEXT PRIMARY KEY, email TEXT)");
      db.exec("INSERT INTO owners (id, email) VALUES ('synthetic', 'synthetic@example.test')");
      db.close();
      const secret = randomBytes(24).toString("hex");
      const repo = join(import.meta.dirname, "..");
      const nextBin = join(repo, "node_modules/next/dist/bin/next");
      await new Promise<void>((resolve, reject) => {
        execFile(process.execPath, [nextBin, "build"], { cwd: repo }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      const port = await new Promise<number>((resolve) => {
        const probe = createServer();
        probe.listen(0, "127.0.0.1", () => {
          const address = probe.address();
          const chosen = typeof address === "object" && address ? address.port : 0;
          probe.close(() => resolve(chosen));
        });
      });
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
        cwd: repo,
        env: {
          ...process.env,
          SCHEDI_DB_PATH: dbPath,
          SCHEDI_CONNECT_BACKUP_SECRET: secret,
        },
        stdio: "ignore",
      });
      try {
        const deadline = Date.now() + 20_000;
        let ready = false;
        while (Date.now() < deadline) {
          try {
            const probe = await fetch(`http://127.0.0.1:${port}/api/admin/sqlite-snapshot`, { method: "GET" });
            if (probe.status === 405) {
              ready = true;
              break;
            }
          } catch {
            // The server is still booting.
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(ready).toBe(true);
        const response = await fetch(`http://127.0.0.1:${port}/api/admin/sqlite-snapshot`, {
          method: "POST",
          headers: { [BACKUP_SECRET_HEADER]: secret },
        });
        expect(response.status).toBe(200);
        const reader = response.body?.getReader();
        expect(reader).toBeTruthy();
        const chunks: Uint8Array[] = [];
        while (reader) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(next.value);
        }
        const bytes = Buffer.concat(chunks);
        expect(bytes.subarray(0, 16).toString()).toBe("SQLite format 3\u0000");
        const restored = openSnapshot(bytes, dir);
        try {
          expect(restored.prepare("SELECT email FROM owners").get()).toEqual({ email: "synthetic@example.test" });
        } finally {
          restored.close();
        }

        const controller = new AbortController();
        const cancelled = fetch(`http://127.0.0.1:${port}/api/admin/sqlite-snapshot`, {
          method: "POST",
          headers: { [BACKUP_SECRET_HEADER]: secret },
          signal: controller.signal,
        });
        controller.abort();
        await cancelled.then(
          async (result) => {
            await result.body?.cancel();
          },
          () => undefined,
        );
        const again = await fetch(`http://127.0.0.1:${port}/api/admin/sqlite-snapshot`, {
          method: "POST",
          headers: { [BACKUP_SECRET_HEADER]: secret },
        });
        expect(again.status).toBe(200);
        const againBytes = Buffer.from(await again.arrayBuffer());
        expect(againBytes.subarray(0, 16).toString()).toBe("SQLite format 3\u0000");
      } finally {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    },
    180_000,
  );
});
