import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { securePrivateDirectorySync, securePrivateFileSync } from "../../runtime/private-file.mjs";

/** Transfer ownership only after both schema initialization and loading succeed. */
export function openPrivateDatabase(
  path: string,
  assertSchema: (database: DatabaseSync) => void,
  initialize: (database: DatabaseSync) => void,
  cleanupFailureMessage: string,
): DatabaseSync {
  const existed = existsSync(path);
  if (existed) {
    const existing = new DatabaseSync(path, { readOnly: true });
    try { assertSchema(existing); }
    finally { existing.close(); }
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!existed) securePrivateDirectorySync(parent);
  const database = new DatabaseSync(path);
  try {
    assertSchema(database);
    if (existed) securePrivateDirectorySync(parent);
    securePrivateFileSync(path);
    // Synchronous stores must fail on contention instead of blocking the Reader.
    database.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE;");
    initialize(database);
    return database;
  } catch (error) {
    try { database.close(); }
    catch (closeError) {
      throw new AggregateError([error, closeError], cleanupFailureMessage, { cause: closeError });
    }
    throw error;
  }
}
