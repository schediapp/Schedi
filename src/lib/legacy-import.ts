import { createHash } from "node:crypto";
import { SchediError } from "./errors.ts";
import { databaseIsEmpty } from "./snapshot.ts";
import type { SqlDatabase, SqlValue } from "./sql.ts";

/** Recovered Connect file. Receipts are stripe_events. Sessions and handoffs are not imported. */
export const LEGACY_TABLES = [
  "owners",
  "businesses",
  "services",
  "bookings",
  "sessions",
  "connect_handoffs",
  "stripe_events",
] as const;

export type LegacyTable = (typeof LEGACY_TABLES)[number];

export const IMPORTED_TABLES = ["owners", "businesses", "services", "bookings", "stripe_events"] as const;
export type ImportedTable = (typeof IMPORTED_TABLES)[number];

const PRIMARY_KEYS: Record<LegacyTable, string> = {
  owners: "id",
  businesses: "id",
  services: "id",
  bookings: "id",
  sessions: "token",
  connect_handoffs: "nonce",
  stripe_events: "id",
};

/** Columns of the deployed 7-table file. ownership_generation and stripe_events.state are not part of it. */
export const LEGACY_COLUMNS: Record<LegacyTable, string[]> = {
  owners: ["id", "email", "name", "stripe_customer_id", "created_at"],
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
  sessions: ["token", "owner_id", "expires_at"],
  connect_handoffs: ["nonce", "expires_at"],
  stripe_events: ["id", "processed_at"],
};

export interface LegacyImportReport {
  sourceCounts: Record<LegacyTable, number>;
  importedCounts: Record<ImportedTable, number>;
  excluded: { sessions: number; connect_handoffs: number };
  digests: Record<ImportedTable, string>;
}

function schemaError(detail: string): SchediError {
  return new SchediError(`legacy_schema:${detail}`, 400);
}

function columnsOf(db: SqlDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((row) => row.name);
}

export function assertLegacyConnectSchema(db: SqlDatabase): void {
  const present = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
      .map((row) => row.name),
  );
  for (const table of LEGACY_TABLES) {
    if (!present.has(table)) throw schemaError(`missing:${table}`);
  }
  for (const name of present) {
    if (!LEGACY_TABLES.includes(name as LegacyTable)) throw schemaError(`unexpected_table:${name}`);
  }
  for (const table of LEGACY_TABLES) {
    const found = new Set(columnsOf(db, table));
    const expected = LEGACY_COLUMNS[table];
    for (const column of expected) {
      if (!found.has(column)) throw schemaError(`${table}.${column}`);
    }
    for (const column of found) {
      if (!expected.includes(column)) throw schemaError(`${table}.${column}`);
    }
  }
}

function rowsOf(db: SqlDatabase, table: LegacyTable): Record<string, SqlValue>[] {
  return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, SqlValue>[];
}

function countOf(db: SqlDatabase, table: LegacyTable): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return Number(row.n);
}

export function legacyCounts(db: SqlDatabase): Record<LegacyTable, number> {
  assertLegacyConnectSchema(db);
  const counts = {} as Record<LegacyTable, number>;
  for (const table of LEGACY_TABLES) counts[table] = countOf(db, table);
  return counts;
}

export function parseExpectedCounts(value: string): Record<LegacyTable, number> {
  const parsed = {} as Record<LegacyTable, number>;
  for (const part of value.split(",")) {
    const [name, raw] = part.split("=");
    if (!LEGACY_TABLES.includes(name as LegacyTable) || raw == null || !/^\d+$/.test(raw)) {
      throw new SchediError("Expected counts must be the 7 legacy tables as name=count pairs.", 400);
    }
    parsed[name as LegacyTable] = Number(raw);
  }
  for (const table of LEGACY_TABLES) {
    if (!Number.isInteger(parsed[table])) {
      throw new SchediError("Expected counts must name every legacy table.", 400);
    }
  }
  return parsed;
}

export function assertLegacyCounts(actual: Record<LegacyTable, number>, expected: Record<LegacyTable, number>): void {
  for (const table of LEGACY_TABLES) {
    if (actual[table] !== expected[table]) {
      throw new SchediError(`legacy_counts:${table}:${actual[table]}!=${expected[table]}`, 409);
    }
  }
}

/** Digest of the legacy columns only, so a new generation or receipt state does not change it. */
export function legacyDigest(table: ImportedTable, rows: Record<string, SqlValue>[]): string {
  const pk = PRIMARY_KEYS[table];
  const columns = LEGACY_COLUMNS[table];
  const canonical = rows
    .map((row) => {
      const out: Record<string, SqlValue> = {};
      for (const column of columns) out[column] = row[column] ?? null;
      return out;
    })
    .sort((left, right) => String(left[pk]).localeCompare(String(right[pk])));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function digestsOf(db: SqlDatabase): Record<ImportedTable, string> {
  const digests = {} as Record<ImportedTable, string>;
  for (const table of IMPORTED_TABLES) digests[table] = legacyDigest(table, rowsOf(db, table));
  return digests;
}

/**
 * Copy owners, businesses, services, bookings, and stripe_events into an empty
 * Connect database. Each owner gets a new ownership generation. Sessions and
 * handoffs in the source are counted and then left behind.
 */
export function importLegacyConnectDatabase(source: SqlDatabase, dest: SqlDatabase): LegacyImportReport {
  assertLegacyConnectSchema(source);
  if (!databaseIsEmpty(dest)) throw new SchediError("Destination is not empty.", 409);
  const sourceCounts = legacyCounts(source);
  const sourceDigests = digestsOf(source);
  const owners = rowsOf(source, "owners");
  const generations = new Map<string, string>();
  for (const owner of owners) generations.set(String(owner.id), crypto.randomUUID());

  dest.transaction(() => {
    insertCopied(dest, "owners", owners, (row) => ({ ownership_generation: generations.get(String(row.id)) || "" }));
    insertCopied(dest, "businesses", rowsOf(source, "businesses"));
    insertCopied(dest, "services", rowsOf(source, "services"));
    insertCopied(dest, "bookings", rowsOf(source, "bookings"));
    insertCopied(dest, "stripe_events", rowsOf(source, "stripe_events"), () => ({ state: "done" }));
    const imported = digestsOf(dest);
    for (const table of IMPORTED_TABLES) {
      if (imported[table] !== sourceDigests[table]) {
        throw new SchediError(`legacy_digest:${table}`, 500);
      }
    }
  });

  return {
    sourceCounts,
    importedCounts: {
      owners: countOf(dest, "owners"),
      businesses: countOf(dest, "businesses"),
      services: countOf(dest, "services"),
      bookings: countOf(dest, "bookings"),
      stripe_events: countOf(dest, "stripe_events"),
    },
    excluded: {
      sessions: sourceCounts.sessions,
      connect_handoffs: sourceCounts.connect_handoffs,
    },
    digests: sourceDigests,
  };
}

function insertCopied(
  dest: SqlDatabase,
  table: ImportedTable,
  rows: Record<string, SqlValue>[],
  extra?: (row: Record<string, SqlValue>) => Record<string, SqlValue>,
): void {
  if (!rows.length) return;
  const columns = [...LEGACY_COLUMNS[table]];
  const sample = extra ? extra(rows[0]) : {};
  for (const key of Object.keys(sample)) columns.push(key);
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  const statement = dest.prepare(sql);
  for (const row of rows) {
    const added = extra ? extra(row) : {};
    statement.run(...columns.map((column) => (column in added ? added[column] : row[column] ?? null)));
  }
}
