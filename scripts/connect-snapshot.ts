/**
 * Local Connect database snapshot tool.
 * It reads and writes only the filesystem paths you pass. It does not call
 * Stripe, Railway, Cloudflare, or schedi.app, and it prints counts and a
 * checksum rather than customer rows.
 *
 *   node --experimental-strip-types scripts/connect-snapshot.ts verify <sqlite>
 *   node --experimental-strip-types scripts/connect-snapshot.ts export <sqlite> <out.json>
 *   node --experimental-strip-types scripts/connect-snapshot.ts restore <snapshot.json> <dest.sqlite>
 *   node --experimental-strip-types scripts/connect-snapshot.ts roundtrip <sqlite>
 */
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeSqliteDatabase } from "../src/lib/node-sqlite.ts";
import { Store } from "../src/lib/db.ts";
import { parseSnapshot } from "../src/lib/snapshot.ts";
import { diffSnapshotKeys } from "../src/lib/reconcile.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function localPath(value: string | undefined, label: string): string {
  if (!value || value.includes("://") || value.startsWith("http")) fail(`${label} must be a local file path.`);
  return value;
}

function openCopy(source: string): { store: Store; dir: string } {
  if (!existsSync(source) || !statSync(source).isFile()) fail(`Database file is missing: ${source}`);
  const dir = mkdtempSync(join(tmpdir(), "schedi-snapshot-"));
  const copy = join(dir, "source.sqlite");
  copyFileSync(source, copy);
  const db = new NodeSqliteDatabase(new DatabaseSync(copy));
  return { store: new Store(db), dir };
}

function summary(store: Store) {
  const snapshot = store.consistentSnapshot();
  const pragma = store.pragmaStatus();
  return {
    checksum: snapshot.checksum,
    rows: Object.fromEntries(Object.entries(snapshot.tables).map(([name, rows]) => [name, rows.length])),
    integrity: pragma.integrity,
    foreignKeyViolations: pragma.foreignKeyViolations,
    format: snapshot.format,
  };
}

const [command, first, second] = process.argv.slice(2);

if (command === "verify") {
  const source = localPath(first, "sqlite");
  const before = readFileSync(source);
  const opened = openCopy(source);
  try {
    const report = summary(opened.store);
    if (report.integrity !== "ok" || report.foreignKeyViolations !== 0) fail("Integrity check failed.");
    console.log(JSON.stringify({ ok: true, ...report }, null, 2));
  } finally {
    rmSync(opened.dir, { recursive: true, force: true });
  }
  if (!readFileSync(source).equals(before)) fail("Verify changed the source file.");
} else if (command === "export") {
  const source = localPath(first, "sqlite");
  const dest = localPath(second, "snapshot");
  if (existsSync(dest)) fail("Refusing to overwrite the snapshot file.");
  const before = readFileSync(source);
  const opened = openCopy(source);
  try {
    const snapshot = opened.store.consistentSnapshot();
    const pragma = opened.store.pragmaStatus();
    if (pragma.integrity !== "ok" || pragma.foreignKeyViolations !== 0) fail("Integrity check failed. Nothing was written.");
    writeFileSync(dest, JSON.stringify(snapshot), { mode: 0o600 });
    chmodSync(dest, 0o600);
    console.log(JSON.stringify({
      ok: true,
      checksum: snapshot.checksum,
      rows: Object.fromEntries(Object.entries(snapshot.tables).map(([name, rows]) => [name, rows.length])),
      integrity: pragma.integrity,
      foreignKeyViolations: pragma.foreignKeyViolations,
      bytes: statSync(dest).size,
    }, null, 2));
  } finally {
    rmSync(opened.dir, { recursive: true, force: true });
  }
  if (!readFileSync(source).equals(before)) fail("Export changed the source file.");
} else if (command === "restore") {
  const snapshotPath = localPath(first, "snapshot");
  const dest = localPath(second, "dest");
  if (existsSync(dest)) fail("Refusing to overwrite the destination database.");
  const snapshot = parseSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
  const db = new NodeSqliteDatabase(new DatabaseSync(dest));
  const store = new Store(db);
  const report = store.restoreConsistentSnapshot(snapshot, "empty-only");
  const pragma = store.pragmaStatus();
  if (!report.applied || report.checksum !== snapshot.checksum || pragma.integrity !== "ok" || pragma.foreignKeyViolations !== 0) {
    fail("Restore verification failed.");
  }
  console.log(JSON.stringify({
    ok: true,
    applied: true,
    checksum: report.checksum,
    rows: report.counts,
    integrity: pragma.integrity,
    foreignKeyViolations: pragma.foreignKeyViolations,
  }, null, 2));
} else if (command === "roundtrip") {
  const source = localPath(first, "sqlite");
  const before = readFileSync(source);
  const opened = openCopy(source);
  const dir = mkdtempSync(join(tmpdir(), "schedi-roundtrip-"));
  try {
    const snapshot = opened.store.consistentSnapshot();
    const dest = join(dir, "restored.sqlite");
    const restored = new Store(new NodeSqliteDatabase(new DatabaseSync(dest)));
    const report = restored.restoreConsistentSnapshot(snapshot, "empty-only");
    const again = restored.consistentSnapshot();
    const pragma = restored.pragmaStatus();
    if (again.checksum !== snapshot.checksum || !report.applied || pragma.integrity !== "ok" || pragma.foreignKeyViolations !== 0) {
      fail("Roundtrip checksum did not match.");
    }
    console.log(JSON.stringify({
      ok: true,
      checksum: again.checksum,
      rows: report.counts,
      integrity: pragma.integrity,
      foreignKeyViolations: pragma.foreignKeyViolations,
    }, null, 2));
  } finally {
    rmSync(opened.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
  if (!readFileSync(source).equals(before)) fail("Roundtrip changed the source file.");
} else if (command === "verify-json") {
  const snapshotPath = localPath(first, "snapshot");
  const snapshot = parseSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
  console.log(JSON.stringify({
    ok: true,
    checksum: snapshot.checksum,
    rows: Object.fromEntries(Object.entries(snapshot.tables).map(([name, rows]) => [name, rows.length])),
    format: snapshot.format,
  }, null, 2));
} else if (command === "diff") {
  const left = parseSnapshot(JSON.parse(readFileSync(localPath(first, "before"), "utf8")));
  const right = parseSnapshot(JSON.parse(readFileSync(localPath(second, "after"), "utf8")));
  const keys: Record<string, string> = {
    owners: "id", businesses: "id", services: "id", bookings: "id", sessions: "token",
    stripe_events: "id", connect_handoffs: "nonce", maintenance: "id", state_fence: "key", callback_outbox: "id",
  };
  console.log(JSON.stringify({ ok: true, checksums: [left.checksum, right.checksum], tables: diffSnapshotKeys(left, right, keys) }, null, 2));
} else {
  fail("Use verify, export, restore, or roundtrip.");
}
