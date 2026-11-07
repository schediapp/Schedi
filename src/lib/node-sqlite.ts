import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, sqliteDatabasePath } from "./db.ts";
import type { SqlDatabase, SqlStatement, SqlValue } from "./sql.ts";

class NodeStatement implements SqlStatement {
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;

  constructor(statement: ReturnType<DatabaseSync["prepare"]>) {
    this.statement = statement;
  }

  get(...params: SqlValue[]): unknown {
    return this.statement.get(...params);
  }

  all(...params: SqlValue[]): unknown[] {
    return this.statement.all(...params);
  }

  run(...params: SqlValue[]): { changes: number } {
    return { changes: Number(this.statement.run(...params).changes) };
  }
}

export class NodeSqliteDatabase implements SqlDatabase {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    return new NodeStatement(this.db.prepare(sql));
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The original error is the one the caller needs.
      }
      throw error;
    }
  }
}

export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  return new Store(new NodeSqliteDatabase(new DatabaseSync(path)));
}

let singleton: Store | null = null;

export function getStore(): Store {
  if (!singleton) singleton = openStore(sqliteDatabasePath());
  return singleton;
}
