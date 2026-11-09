import { createHash } from "node:crypto";
import { SchediError } from "./errors.ts";
import type { SqlDatabase } from "./sql.ts";

export const SNAPSHOT_FORMAT = "schedi-connect-snapshot-v1";

const TABLES = [
  { name: "owners", pk: "id" },
  { name: "businesses", pk: "id" },
  { name: "services", pk: "id" },
  { name: "bookings", pk: "id" },
  { name: "sessions", pk: "token" },
  { name: "stripe_events", pk: "id" },
  { name: "connect_handoffs", pk: "nonce" },
  { name: "maintenance", pk: "id" },
  { name: "state_fence", pk: "key" },
  { name: "callback_outbox", pk: "id" },
] as const;

export const EXPECTED_COLUMNS: Record<SnapshotTable, string[]> = {
  owners: ["id", "email", "name", "stripe_customer_id", "created_at", "ownership_generation"],
  businesses: [
    "id", "owner_id", "name", "slug", "plan", "subscription_status", "stripe_subscription_id",
    "cancel_at_period_end", "current_period_end", "stripe_account_id", "card_payments_status",
    "payouts_status", "deposit_enabled", "deposit_amount_cents", "cash_app", "zelle", "venmo",
    "paypal", "pay_at_appointment", "country", "created_at", "complimentary_pro", "billing_exempt",
    "stripe_account_id_missing", "stripe_account_missing_at",
  ],
  services: ["id", "business_id", "name", "duration_minutes", "price_cents"],
  bookings: [
    "id", "business_id", "service_id", "client_name", "client_email", "starts_at", "payment_method",
    "charge_kind", "amount_cents", "status", "stripe_checkout_session_id", "stripe_payment_intent_id", "created_at",
  ],
  sessions: ["token", "owner_id", "expires_at", "ownership_generation"],
  stripe_events: ["id", "processed_at", "state"],
  connect_handoffs: ["nonce", "expires_at"],
  maintenance: ["id", "frozen", "frozen_at", "admitted"],
  state_fence: ["key", "observed_at", "event_id", "rank"],
  callback_outbox: ["id", "kind", "payload", "state", "observed_at", "updated_at"],
};

export type SnapshotTable = (typeof TABLES)[number]["name"];
export type SnapshotRow = Record<string, string | number | null>;

export interface ConnectSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  takenAt: string;
  tables: Record<SnapshotTable, SnapshotRow[]>;
  checksum: string;
}

export interface SnapshotReport {
  ok: boolean;
  applied: boolean;
  checksum: string;
  counts: Record<SnapshotTable, number>;
  error?: string;
}

function assertTableName(name: string): SnapshotTable {
  const found = TABLES.find((table) => table.name === name);
  if (!found) throw new SchediError("Unknown snapshot table.", 400);
  return found.name;
}

function readTables(db: SqlDatabase): Record<SnapshotTable, SnapshotRow[]> {
  const tables = {} as Record<SnapshotTable, SnapshotRow[]>;
  for (const table of TABLES) {
    tables[table.name] = db
      .prepare(`SELECT * FROM ${table.name} ORDER BY ${table.pk}`)
      .all() as SnapshotRow[];
  }
  return tables;
}

function normalizeRow(row: SnapshotRow): SnapshotRow {
  const out: SnapshotRow = {};
  for (const key of Object.keys(row).sort()) out[key] = row[key];
  return out;
}

export function checksumTables(tables: Record<SnapshotTable, SnapshotRow[]>): string {
  const canonical = TABLES.map((table) => ({
    name: table.name,
    rows: (tables[table.name] || []).map(normalizeRow),
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function countsOf(tables: Record<SnapshotTable, SnapshotRow[]>): Record<SnapshotTable, number> {
  const counts = {} as Record<SnapshotTable, number>;
  for (const table of TABLES) counts[table.name] = tables[table.name]?.length || 0;
  return counts;
}

/** Read every Connect table inside one immediate transaction. */
export function captureSnapshot(db: SqlDatabase, now = new Date().toISOString()): ConnectSnapshot {
  return db.transaction(() => {
    const tables = readTables(db);
    return {
      format: SNAPSHOT_FORMAT,
      takenAt: now,
      tables,
      checksum: checksumTables(tables),
    };
  });
}

export function parseSnapshot(value: unknown): ConnectSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SchediError("Snapshot must be a JSON object.", 400);
  }
  const body = value as Partial<ConnectSnapshot>;
  if (body.format !== SNAPSHOT_FORMAT) throw new SchediError("Unsupported snapshot format.", 400);
  if (!body.tables || typeof body.tables !== "object") throw new SchediError("Snapshot is missing tables.", 400);
  const tables = {} as Record<SnapshotTable, SnapshotRow[]>;
  for (const table of TABLES) {
    const rows = (body.tables as Record<string, unknown>)[table.name];
    if (!Array.isArray(rows)) throw new SchediError(`Snapshot is missing ${table.name}.`, 400);
    tables[table.name] = rows.map((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new SchediError(`Snapshot row ${table.name}[${index}] is not an object.`, 400);
      }
      const out: SnapshotRow = {};
      for (const [key, cell] of Object.entries(row)) {
        if (!/^[a-z_]+$/.test(key)) throw new SchediError("Snapshot column name is not allowed.", 400);
        if (cell != null && typeof cell !== "string" && typeof cell !== "number") {
          throw new SchediError("Snapshot values must be text, numbers, or null.", 400);
        }
        out[key] = cell as string | number | null;
      }
      if (out[table.pk] == null || out[table.pk] === "") {
        throw new SchediError(`Snapshot row ${table.name}[${index}] has no primary key.`, 400);
      }
      return out;
    });
  }
  const checksum = typeof body.checksum === "string" ? body.checksum : "";
  if (!/^[a-f0-9]{64}$/.test(checksum) || checksum !== checksumTables(tables)) {
    throw new SchediError("Snapshot checksum does not match its rows.", 400);
  }
  return {
    format: SNAPSHOT_FORMAT,
    takenAt: typeof body.takenAt === "string" ? body.takenAt : "",
    tables,
    checksum,
  };
}

function tableColumns(db: SqlDatabase, table: SnapshotTable): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${assertTableName(table)})`).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function insertRow(db: SqlDatabase, table: SnapshotTable, row: SnapshotRow): void {
  const known = tableColumns(db, table);
  const keys = Object.keys(row).filter((key) => known.has(key)).sort();
  if (!keys.length) throw new SchediError(`Snapshot row for ${table} matches no columns.`, 400);
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
  db.prepare(sql).run(...keys.map((key) => row[key]));
}

export function databaseCounts(db: SqlDatabase): Record<SnapshotTable, number> {
  const counts = {} as Record<SnapshotTable, number>;
  for (const table of TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table.name}`).get() as { n: number };
    counts[table.name] = Number(row.n);
  }
  return counts;
}

export function databaseIsEmpty(db: SqlDatabase): boolean {
  for (const table of TABLES) {
    if (table.name === "maintenance") continue;
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table.name}`).get() as { n: number };
    if (Number(row.n) !== 0) return false;
  }
  return true;
}

export function schemaParity(db: SqlDatabase): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const table of TABLES) {
    const rows = db.prepare(`PRAGMA table_info(${table.name})`).all() as { name: string }[];
    const names = new Set(rows.map((row) => row.name));
    for (const column of EXPECTED_COLUMNS[table.name]) {
      if (!names.has(column)) missing.push(`${table.name}.${column}`);
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * dry-run checks the payload and writes nothing.
 * empty-only inserts into a database whose Connect tables are all empty.
 * A non-empty database is refused so a restore cannot overwrite live rows.
 */
export function restoreSnapshot(
  db: SqlDatabase,
  snapshot: ConnectSnapshot,
  mode: "dry-run" | "empty-only",
): SnapshotReport {
  const checked = parseSnapshot(snapshot);
  const parity = schemaParity(db);
  const report: SnapshotReport = {
    ok: parity.ok,
    applied: false,
    checksum: checked.checksum,
    counts: countsOf(checked.tables),
    error: parity.ok ? undefined : `schema_mismatch:${parity.missing.join(",")}`,
  };
  if (mode === "dry-run") return report;
  if (!parity.ok) throw new SchediError("Destination schema does not match this snapshot.", 409);
  if (mode !== "empty-only") throw new SchediError("Unsupported restore mode.", 400);

  return db.transaction(() => {
    if (!databaseIsEmpty(db)) throw new SchediError("Database is not empty. Restore was not applied.", 409);
    db.prepare("DELETE FROM maintenance").run();
    for (const table of TABLES) {
      for (const row of checked.tables[table.name]) insertRow(db, table.name, row);
    }
    const reread = readTables(db);
    const checksum = checksumTables(reread);
    if (checksum !== checked.checksum) {
      throw new SchediError("Restored rows do not match the snapshot checksum.", 500);
    }
    return {
      ok: true,
      applied: true,
      checksum,
      counts: countsOf(reread),
    };
  });
}

export function pragmaChecks(db: SqlDatabase): { integrity: string; foreignKeyViolations: number } {
  const integrityRows = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
  const integrity = integrityRows.map((row) => row.integrity_check).join(",") || "missing";
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  return { integrity, foreignKeyViolations: foreignKeys.length };
}
