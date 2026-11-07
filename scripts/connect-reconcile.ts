/**
 * Replay plan and apply against a new local SQLite file. No network.
 *
 *   node --experimental-strip-types scripts/connect-reconcile.ts plan --snapshot a.json --events b.json
 *   node --experimental-strip-types scripts/connect-reconcile.ts apply --snapshot a.json --events b.json --dest /tmp/reconciled.sqlite
 *
 * apply refuses an existing dest file. The snapshot must be a frozen, drained export
 * (maintenance.frozen = 1 and admitted = 0). Crashed processing claims are released, then
 * missing events are applied. A second apply of the same inputs does not repeat them.
 */
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { NodeSqliteDatabase } from "../src/lib/node-sqlite.ts";
import { Store } from "../src/lib/db.ts";
import { applyMissingEvents, reconcileEvents, type ReconcileEvent } from "../src/lib/reconcile.ts";
import { parseSnapshot } from "../src/lib/snapshot.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function local(value: string | undefined, label: string): string {
  if (!value || value.includes("://")) fail(`${label} must be a local path.`);
  return value;
}

function readEvents(path: string): ReconcileEvent[] {
  const body = JSON.parse(readFileSync(path, "utf8")) as {
    events?: ReconcileEvent[];
    platformEvents?: ReconcileEvent[];
    connectEvents?: ReconcileEvent[];
  };
  if (Array.isArray(body.events)) return body.events;
  return [...(body.platformEvents || []), ...(body.connectEvents || [])];
}

const command = process.argv[2];
const snapshotPath = local(arg("--snapshot"), "snapshot");
const eventsPath = local(arg("--events"), "events");
const snapshot = parseSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
const events = readEvents(eventsPath);

if (command === "plan") {
  const dir = snapshot.tables;
  const done = new Set((dir.stripe_events || []).filter((row) => row.state === "done" || row.state == null).map((row) => String(row.id)));
  const platform = events.filter((event) => !event.account);
  const connect = events.filter((event) => event.account);
  const missing = (list: ReconcileEvent[]) => list.filter((event) => event.id && !done.has(event.id)).map((event) => event.id);
  const openCheckouts = (dir.bookings || []).filter((row) => row.status === "pending_payment").length;
  console.log(JSON.stringify({
    ok: true,
    platformSeen: platform.length,
    connectSeen: connect.length,
    platformMissing: missing(platform).length,
    connectMissing: missing(connect).length,
    openCheckouts,
    processingClaims: (dir.stripe_events || []).filter((row) => row.state === "processing").length,
  }, null, 2));
} else if (command === "apply") {
  const dest = local(arg("--dest"), "dest");
  if (existsSync(dest)) fail("Refusing to overwrite the destination database.");
  const maintenance = snapshot.tables.maintenance?.[0];
  if (!maintenance || Number(maintenance.frozen) !== 1 || Number(maintenance.admitted) !== 0) {
    fail("Snapshot is not a frozen drained export. Nothing was written.");
  }
  const db = new NodeSqliteDatabase(new DatabaseSync(dest));
  const store = new Store(db);
  const restored = store.restoreConsistentSnapshot(snapshot, "empty-only");
  if (!restored.applied) fail("Restore did not apply.");
  const released = store.releaseProcessingClaims();
  const results = await applyMissingEvents(store, events);
  const again = await applyMissingEvents(store, events);
  const plan = reconcileEvents(store, events);
  const pragma = store.pragmaStatus();
  console.log(JSON.stringify({
    ok: plan.missingIds.length === 0 && again.length === 0 && pragma.integrity === "ok" && pragma.foreignKeyViolations === 0,
    releasedProcessing: released,
    applied: results.length,
    stillMissing: plan.missingIds.length,
    replayed: again.length,
    checksum: store.consistentSnapshot().checksum,
    integrity: pragma.integrity,
    foreignKeyViolations: pragma.foreignKeyViolations,
  }, null, 2));
  if (plan.missingIds.length !== 0 || again.length !== 0) process.exit(1);
} else {
  fail("Use plan or apply.");
}
