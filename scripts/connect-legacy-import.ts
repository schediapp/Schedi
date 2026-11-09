/**
 * Offline import of a recovered 7-table Connect SQLite file.
 * It reads only the local path you pass. It does not call Stripe, Railway,
 * Cloudflare, or schedi.app. It prints counts and digests, not rows.
 *
 * Sessions and connect_handoffs are left out. Each owner is stamped with a
 * new ownership generation, so a token from the source cannot sign in.
 *
 *   npm run connect:legacy-import -- --source /path/to/recovered.sqlite --out /tmp/connect-import.json --expect owners=2,businesses=2,services=2,bookings=0,sessions=20,connect_handoffs=2,stripe_events=26
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assertLegacyCounts, legacyCounts, parseExpectedCounts } from "../src/lib/legacy-import.ts";
import { NodeSqliteDatabase, openStore } from "../src/lib/node-sqlite.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const sourcePath = arg("--source");
const out = arg("--out");
const expectArg = arg("--expect");
if (!sourcePath || sourcePath.includes("://") || !out || out.includes("://") || !expectArg) {
  fail("Use --source <sqlite> --out <json> --expect owners=2,businesses=2,services=2,bookings=0,sessions=20,connect_handoffs=2,stripe_events=26");
}
if (!existsSync(sourcePath)) fail("Database file is missing.");
if (existsSync(out)) fail("Refusing to overwrite the output file.");

const before = readFileSync(sourcePath);
const source = new NodeSqliteDatabase(new DatabaseSync(sourcePath, { readOnly: true }));
const dest = openStore(":memory:");
let report;
try {
  assertLegacyCounts(legacyCounts(source), parseExpectedCounts(expectArg));
  report = dest.importLegacyConnect(source);
} catch (error) {
  fail(error instanceof Error ? error.message : "Legacy import failed. No file was written.");
}

if (!readFileSync(sourcePath).equals(before)) fail("Import changed the source file. No file was written.");

const snapshot = dest.consistentSnapshot();
if (snapshot.tables.sessions.length !== 0 || snapshot.tables.connect_handoffs.length !== 0) {
  fail("Import kept a session or handoff. No file was written.");
}
writeFileSync(out, JSON.stringify(snapshot), { mode: 0o600 });
chmodSync(out, 0o600);
console.log(JSON.stringify({
  ok: true,
  sourceCounts: report.sourceCounts,
  importedCounts: report.importedCounts,
  excluded: report.excluded,
  digests: report.digests,
  sessionsImported: snapshot.tables.sessions.length,
  handoffsImported: snapshot.tables.connect_handoffs.length,
}, null, 2));
