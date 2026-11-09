import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../src/lib/db";
import { legacyDigest } from "../src/lib/legacy-import";
import { NodeSqliteDatabase } from "../src/lib/node-sqlite";

const dir = mkdtempSync(join(tmpdir(), "legacy-import-"));
const sourcePath = join(dir, "recovered.sqlite");
const PRE_IMPORT = "pre-import-session-token";

const LEGACY_SQL = `
  CREATE TABLE owners (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    stripe_customer_id TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE businesses (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL, subscription_status TEXT NOT NULL, stripe_subscription_id TEXT,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0, current_period_end TEXT,
    stripe_account_id TEXT, card_payments_status TEXT, payouts_status TEXT,
    deposit_enabled INTEGER NOT NULL DEFAULT 0, deposit_amount_cents INTEGER,
    cash_app TEXT, zelle TEXT, venmo TEXT, paypal TEXT,
    pay_at_appointment INTEGER NOT NULL DEFAULT 1, country TEXT NOT NULL DEFAULT 'US',
    created_at TEXT NOT NULL, complimentary_pro INTEGER NOT NULL DEFAULT 0,
    billing_exempt INTEGER NOT NULL DEFAULT 0, stripe_account_id_missing TEXT,
    stripe_account_missing_at INTEGER
  );
  CREATE TABLE services (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL, name TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL, price_cents INTEGER NOT NULL
  );
  CREATE TABLE bookings (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL, service_id TEXT NOT NULL,
    client_name TEXT NOT NULL, client_email TEXT NOT NULL, starts_at TEXT NOT NULL,
    payment_method TEXT NOT NULL, charge_kind TEXT, amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL, stripe_checkout_session_id TEXT, stripe_payment_intent_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (token TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at TEXT NOT NULL);
  CREATE TABLE stripe_events (id TEXT PRIMARY KEY, processed_at TEXT NOT NULL);
  CREATE TABLE connect_handoffs (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
`;

function buildFixture(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(LEGACY_SQL);
  const owner = db.prepare("INSERT INTO owners (id, email, name, stripe_customer_id, created_at) VALUES (?, ?, ?, ?, ?)");
  owner.run("owner-a", "a@example.test", "Owner A", "cus_test_a", "2026-01-01T00:00:00.000Z");
  owner.run("owner-b", "b@example.test", "Owner B", "cus_test_b", "2026-01-02T00:00:00.000Z");
  const business = db.prepare(
    `INSERT INTO businesses (
      id, owner_id, name, slug, plan, subscription_status, stripe_subscription_id,
      cancel_at_period_end, current_period_end, stripe_account_id, card_payments_status, payouts_status,
      deposit_enabled, deposit_amount_cents, cash_app, zelle, venmo, paypal, pay_at_appointment, country,
      created_at, complimentary_pro, billing_exempt, stripe_account_id_missing, stripe_account_missing_at
    ) VALUES (?, ?, ?, ?, 'pro', ?, ?, 0, NULL, ?, 'active', 'active', 0, NULL, NULL, NULL, NULL, NULL, 1, 'US', ?, ?, ?, NULL, NULL)`,
  );
  business.run("biz-a", "owner-a", "Shop A", "shop-a", "active", "sub_test_a", "acct_test_parked", "2026-01-01T00:00:00.000Z", 0, 0);
  business.run("biz-b", "owner-b", "Shop B", "shop-b", "active", null, "acct_test_current", "2026-01-02T00:00:00.000Z", 1, 1);
  const service = db.prepare("INSERT INTO services (id, business_id, name, duration_minutes, price_cents) VALUES (?, ?, ?, 30, 1000)");
  service.run("svc-a", "biz-a", "Cut A");
  service.run("svc-b", "biz-b", "Cut B");
  const session = db.prepare("INSERT INTO sessions (token, owner_id, expires_at) VALUES (?, 'owner-a', '2099-01-01T00:00:00.000Z')");
  session.run(PRE_IMPORT);
  for (let i = 1; i < 20; i += 1) session.run(`sess-${String(i).padStart(2, "0")}`);
  const handoff = db.prepare("INSERT INTO connect_handoffs (nonce, expires_at) VALUES (?, 1893456000000)");
  handoff.run("handoff-nonce-aaaa");
  handoff.run("handoff-nonce-bbbb");
  const receipt = db.prepare("INSERT INTO stripe_events (id, processed_at) VALUES (?, '2026-01-03T00:00:00.000Z')");
  for (let i = 0; i < 26; i += 1) receipt.run(`evt_${String(i).padStart(2, "0")}`);
  db.close();
}

function openReadOnly(path: string): NodeSqliteDatabase {
  return new NodeSqliteDatabase(new DatabaseSync(path, { readOnly: true }));
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("legacy 7-table import", () => {
  beforeAll(() => {
    buildFixture(sourcePath);
  });

  it("keeps imported digests, drops sessions and handoffs, and rejects a pre-import token", () => {
    const before = readFileSync(sourcePath);
    const source = openReadOnly(sourcePath);
    const sourceRows = source.prepare("SELECT * FROM owners").all() as Record<string, string | number | null>[];
    const sourceDigest = legacyDigest("owners", sourceRows);
    const destFile = new DatabaseSync(join(dir, "dest.sqlite"));
    const dest = new Store(new NodeSqliteDatabase(destFile));
    const report = dest.importLegacyConnect(source);

    expect(report.sourceCounts).toEqual({
      owners: 2,
      businesses: 2,
      services: 2,
      bookings: 0,
      sessions: 20,
      connect_handoffs: 2,
      stripe_events: 26,
    });
    expect(report.importedCounts).toEqual({
      owners: 2,
      businesses: 2,
      services: 2,
      bookings: 0,
      stripe_events: 26,
    });
    expect(report.excluded).toEqual({ sessions: 20, connect_handoffs: 2 });
    expect(report.digests.owners).toBe(sourceDigest);
    expect(destFile.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(destFile.prepare("SELECT COUNT(*) AS n FROM connect_handoffs").get()).toEqual({ n: 0 });
    expect(destFile.prepare("SELECT COUNT(*) AS n FROM stripe_events WHERE state = 'done'").get()).toEqual({ n: 26 });
    const generations = destFile.prepare("SELECT ownership_generation FROM owners ORDER BY id").all() as { ownership_generation: string }[];
    expect(generations).toHaveLength(2);
    expect(generations[0]?.ownership_generation).toMatch(/^[0-9a-f-]{36}$/);
    expect(generations[0]?.ownership_generation).not.toBe(generations[1]?.ownership_generation);
    expect(dest.getOwnerBySession(PRE_IMPORT)).toBeNull();
    destFile.prepare("INSERT INTO sessions (token, owner_id, expires_at, ownership_generation) VALUES (?, 'owner-a', '2099-01-01T00:00:00.000Z', 'stale')").run(PRE_IMPORT);
    expect(dest.getOwnerBySession(PRE_IMPORT)).toBeNull();
    const fresh = dest.createSession("owner-a");
    expect(dest.getOwnerBySession(fresh)?.id).toBe("owner-a");
    expect(readFileSync(sourcePath).equals(before)).toBe(true);
    expect(dest.consistentSnapshot().tables.connect_handoffs).toEqual([]);
  });

  it("rejects an unexpected table and an unexpected column", () => {
    const extraTable = join(dir, "extra-table.sqlite");
    const extra = new DatabaseSync(extraTable);
    extra.exec(LEGACY_SQL);
    extra.exec("CREATE TABLE notes (id TEXT PRIMARY KEY)");
    extra.close();
    const dest = new Store(new NodeSqliteDatabase(new DatabaseSync(join(dir, "reject-table.sqlite"))));
    expect(() => dest.importLegacyConnect(openReadOnly(extraTable))).toThrow(/legacy_schema:unexpected_table:notes/);
    expect(dest.consistentSnapshot().tables.owners).toEqual([]);

    const extraColumn = join(dir, "extra-column.sqlite");
    const columnDb = new DatabaseSync(extraColumn);
    columnDb.exec(LEGACY_SQL);
    columnDb.exec("ALTER TABLE owners ADD COLUMN extra TEXT");
    columnDb.close();
    const other = new Store(new NodeSqliteDatabase(new DatabaseSync(join(dir, "reject-column.sqlite"))));
    expect(() => other.importLegacyConnect(openReadOnly(extraColumn))).toThrow(/legacy_schema:owners\.extra/);
  });

  it("writes a session-free snapshot from the command", () => {
    const out = join(dir, "import.json");
    const child = spawnSync(process.execPath, [
      "--experimental-strip-types",
      "scripts/connect-legacy-import.ts",
      "--source", sourcePath,
      "--out", out,
      "--expect", "owners=2,businesses=2,services=2,bookings=0,sessions=20,connect_handoffs=2,stripe_events=26",
    ], { cwd: new URL("..", import.meta.url).pathname });
    expect(child.status, child.stderr?.toString()).toBe(0);
    const printed = JSON.parse(child.stdout.toString()) as { excluded: { sessions: number }; sessionsImported: number };
    expect(printed.excluded.sessions).toBe(20);
    expect(printed.sessionsImported).toBe(0);
    expect(child.stdout.toString()).not.toContain("a@example.test");
    expect(child.stdout.toString()).not.toContain(PRE_IMPORT);
    const snapshot = JSON.parse(readFileSync(out, "utf8")) as { tables: { sessions: unknown[]; connect_handoffs: unknown[]; stripe_events: unknown[] } };
    expect(snapshot.tables.sessions).toEqual([]);
    expect(snapshot.tables.connect_handoffs).toEqual([]);
    expect(snapshot.tables.stripe_events).toHaveLength(26);
  });
});
