import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sqliteDatabasePath } from "../src/lib/db";
import { SchediError } from "../src/lib/errors";
import { readSqliteDatabaseBytes } from "../src/lib/sqlite-download";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "schedi-sqlite-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SQLite admin download", () => {
  it("resolves SCHEDI_DB_PATH and falls back to the store default", () => {
    expect(sqliteDatabasePath({ SCHEDI_DB_PATH: "  /data/schedi.sqlite  " })).toBe("/data/schedi.sqlite");
    expect(sqliteDatabasePath({})).toBe("data/schedi.sqlite");
    expect(sqliteDatabasePath({ SCHEDI_DB_PATH: "   " })).toBe("data/schedi.sqlite");
  });

  it("returns the file bytes and does not create or rewrite anything", async () => {
    const dir = tempDir();
    const path = join(dir, "schedi.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE businesses (id TEXT PRIMARY KEY); INSERT INTO businesses (id) VALUES ('schedi');");
    db.close();
    const before = statSync(path);
    const original = readFileSync(path);
    const siblings = readdirSync(dir).sort();

    const bytes = await readSqliteDatabaseBytes(path);

    const after = statSync(path);
    expect(bytes.equals(original)).toBe(true);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(dir).sort()).toEqual(siblings);
    const copy = join(dir, "copy.sqlite");
    writeFileSync(copy, bytes);
    const opened = new DatabaseSync(copy, { readOnly: true });
    try {
      expect(opened.prepare("SELECT id FROM businesses").get()).toEqual({ id: "schedi" });
    } finally {
      opened.close();
    }
  });

  it("refuses a missing file without creating it", async () => {
    const dir = tempDir();
    const path = join(dir, "missing.sqlite");
    const error = await readSqliteDatabaseBytes(path).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchediError);
    expect(error).toMatchObject({ status: 404, message: "Database file is missing." });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses an in-memory path and a file that is not SQLite", async () => {
    await expect(readSqliteDatabaseBytes(":memory:")).rejects.toMatchObject({
      status: 404,
      message: "Database file is not available.",
    });
    const dir = tempDir();
    const path = join(dir, "notes.txt");
    writeFileSync(path, "not a database");
    const before = readFileSync(path);
    await expect(readSqliteDatabaseBytes(path)).rejects.toMatchObject({
      status: 404,
      message: "Database file is not a SQLite database.",
    });
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("guards the download route with the connect secret and a read-only response", () => {
    const route = readFileSync(new URL("../src/app/api/admin/sqlite-download/route.ts", import.meta.url), "utf8");
    const reader = readFileSync(new URL("../src/lib/sqlite-download.ts", import.meta.url), "utf8");
    expect(route).toContain("export async function GET");
    expect(route).toContain('dynamic = "force-dynamic"');
    expect(route).toContain("connectAdminAuthorized");
    expect(route).toContain('request.headers.get("x-schedi-connect-secret")');
    expect(route).toContain("process.env.SCHEDI_CONNECT_PAID_SECRET");
    expect(route).toContain('content-type": "application/octet-stream"');
    expect(route).toContain('attachment; filename="schedi-connect.sqlite"');
    expect(route).not.toContain("getStore");
    expect(route).not.toContain("openStore");
    expect(reader).not.toContain("writeFile");
    expect(reader).not.toContain("truncate");
    expect(reader).not.toContain("DatabaseSync");
    expect(reader).not.toContain("openStore");
  });
});
