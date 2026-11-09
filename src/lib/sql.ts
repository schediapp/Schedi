export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlStatement {
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
  run(...params: SqlValue[]): { changes: number };
}

/**
 * Synchronous SQL used by the Connect store. Node's sqlite and a Durable
 * Object's sqlite both implement it. Callers stay synchronous, matching the
 * single-writer file the Railway service uses today.
 */
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  transaction<T>(fn: () => T): T;
}
