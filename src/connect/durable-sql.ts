import type { SqlDatabase, SqlStatement, SqlValue } from "../lib/sql";

export interface DurableSqlCursor {
  toArray(): Array<Record<string, SqlValue | undefined>>;
  readonly rowsWritten: number;
}

export interface DurableSqlStorage {
  exec(query: string, ...bindings: SqlValue[]): DurableSqlCursor;
}

export interface DurableTransactionStorage {
  transactionSync<T>(fn: () => T): T;
}

/** Split a script of statements. Connect schema text has no semicolons inside literals. */
export function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (quote) {
      current += char;
      if (char === quote) {
        if (sql[i + 1] === quote) {
          current += sql[i + 1];
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }
    current += char;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/**
 * Maps Cloudflare Durable Object SQL onto the synchronous store driver.
 * One Durable Object is the single writer, which is the same rule as the
 * Railway SQLite file.
 */
export class DurableObjectSql implements SqlDatabase {
  constructor(
    private readonly sql: DurableSqlStorage,
    private readonly storage: DurableTransactionStorage,
  ) {}

  exec(sql: string): void {
    for (const statement of splitSql(sql)) this.sql.exec(statement);
  }

  prepare(sql: string): SqlStatement {
    return {
      get: (...params: SqlValue[]) => {
        const rows = this.sql.exec(sql, ...params).toArray();
        return rows[0];
      },
      all: (...params: SqlValue[]) => this.sql.exec(sql, ...params).toArray(),
      run: (...params: SqlValue[]) => ({ changes: Number(this.sql.exec(sql, ...params).rowsWritten || 0) }),
    };
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}
