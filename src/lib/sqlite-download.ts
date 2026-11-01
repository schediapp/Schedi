import { readFile, stat } from "node:fs/promises";
import { SchediError } from "./errors";
import { sqliteDatabasePath } from "./db";

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0");

/**
 * Read the Connect SQLite file without opening it. Opening the store creates
 * the file and runs schema statements, so this stays a plain read.
 */
export async function readSqliteDatabaseBytes(path = sqliteDatabasePath()): Promise<Buffer> {
  if (!path || path === ":memory:" || path.includes("\0")) {
    throw new SchediError("Database file is not available.", 404);
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new SchediError("Database file is missing.", 404);
  } catch (error) {
    if (error instanceof SchediError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new SchediError("Database file is missing.", 404);
    throw new SchediError("Database file is not available.", 404);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new SchediError("Database file is missing.", 404);
    throw new SchediError("Database file is not available.", 404);
  }
  if (bytes.length < 100 || !bytes.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    throw new SchediError("Database file is not a SQLite database.", 404);
  }
  return bytes;
}
