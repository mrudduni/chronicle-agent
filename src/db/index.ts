/**
 * SQLite access. One file holds all state: the conversation log, derived
 * memory, the job queue and traces.
 *
 * Why node:sqlite: it ships with Node 22+, so `npm install` never has to
 * compile a native module (better-sqlite3 often fails on Windows without build
 * tools). FTS5 is compiled in, which is what keyword search needs.
 *
 * Why SQLite at all: memory here is per user and small (thousands of rows,
 * not millions). A single local file is fast, has nothing to run, and keeps
 * the user's data on their machine.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./schema";

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL lets the UI read history while a background job is writing.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  migrate(db);
  return db;
}

/**
 * Runs pending migrations in order. PRAGMA user_version records how far the
 * file has got, so restarting never re-applies a migration.
 */
function migrate(db: Db) {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Runs fn inside a transaction. node:sqlite has no helper for this. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** JSON columns are stored as TEXT; this reads them back without crashing on null. */
export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
