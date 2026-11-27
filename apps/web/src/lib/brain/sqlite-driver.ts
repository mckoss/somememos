// The SQLite driver for the browser: `SqlDriver` (@somememos/sqlite-store)
// over the official WebAssembly build's synchronous `oo1` API. It runs inside
// a dedicated Web Worker (./worker.ts), and also in Node for unit tests
// (`@sqlite.org/sqlite-wasm` has an in-memory Node build).
//
// How it meets the guarantees in packages/sqlite-store/src/driver.ts:
//
// - Named parameters: the store passes `{ item }` for `:item`; oo1 wants the
//   prefix in the key, so each key gets `:` here. Bindings are cleared before
//   every run, so a placeholder never keeps a value from a previous run.
// - Values: oo1 binds an integer-valued number as a 64-bit INTEGER and any
//   other number as a REAL; a bigint as an INTEGER (it throws for one that
//   doesn't fit in 64 bits). It reads INTEGER as a number when it is a safe
//   integer and as a bigint otherwise, never a rounded number. BLOBs are read
//   into a fresh Uint8Array (a copy of wasm memory), so callers may keep them.
// - `inTransaction` is `sqlite3_get_autocommit() == 0`, so a `BEGIN IMMEDIATE`
//   opened with `exec` (the store's long index transaction) counts too.
// - `transaction(fn)` nests as uniquely named savepoints, rolls back exactly
//   its own level on a throw, and refuses an async `fn`.
// - No busy timeout or WAL: the OPFS SAH pool VFS holds its files exclusively
//   (one worker, one tab: see ./open.ts), so there is never a second
//   connection to wait for.

import type { Database, PreparedStatement, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type {
  SqlDriver,
  SqlParams,
  SqlRow,
  SqlRunResult,
  SqlStatement,
  SqlValue,
} from '@somememos/sqlite-store';

export interface Oo1Driver extends SqlDriver {
  /** The underlying oo1 database, for anything the driver doesn't cover. */
  readonly db: Database;
}

function toBinding(params: SqlParams): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const key of Object.keys(params)) {
    out[key.startsWith(':') || key.startsWith('$') || key.startsWith('@') ? key : `:${key}`] =
      params[key] as SqlValue;
  }
  return out;
}

function hasKeys(params: SqlParams | undefined): params is SqlParams {
  if (!params) return false;
  for (const _ in params) return true;
  return false;
}

/** Wraps an open oo1 database. `location` names it in messages. */
export function wrapOo1Database(sqlite3: Sqlite3Static, db: Database, location: string): Oo1Driver {
  const { capi } = sqlite3;
  let savepoints = 0;

  const prepared: PreparedStatement[] = [];

  const begin = (stmt: PreparedStatement, params: SqlParams | undefined): void => {
    stmt.clearBindings();
    if (hasKeys(params)) stmt.bind(toBinding(params));
  };

  const wrap = (stmt: PreparedStatement): SqlStatement => ({
    run(params?: SqlParams): SqlRunResult {
      begin(stmt, params);
      try {
        while (stmt.step()) {
          // A statement that returns rows (RETURNING) runs to completion.
        }
      } finally {
        stmt.resetNoThrow();
      }
      return {
        changes: capi.sqlite3_changes(db),
        lastInsertRowid: Number(capi.sqlite3_last_insert_rowid(db)),
      };
    },
    get<T = SqlRow>(params?: SqlParams): T | undefined {
      begin(stmt, params);
      try {
        return stmt.step() ? (stmt.get({}) as T) : undefined;
      } finally {
        stmt.resetNoThrow();
      }
    },
    all<T = SqlRow>(params?: SqlParams): T[] {
      begin(stmt, params);
      const rows: T[] = [];
      try {
        while (stmt.step()) rows.push(stmt.get({}) as T);
      } finally {
        stmt.resetNoThrow();
      }
      return rows;
    },
  });

  const driver: Oo1Driver = {
    location,
    db,
    get inTransaction() {
      return db.isOpen() && capi.sqlite3_get_autocommit(db) === 0;
    },
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): SqlStatement {
      const stmt = db.prepare(sql);
      prepared.push(stmt);
      return wrap(stmt);
    },
    transaction<T>(fn: () => T): T {
      const outer = !driver.inTransaction;
      const savepoint = `sp_${++savepoints}`;
      db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      try {
        const result = fn();
        if (result instanceof Promise) {
          // Don't leave the caller's promise unobserved.
          result.catch(() => undefined);
          throw new TypeError('transaction(fn): fn must be synchronous');
        }
        db.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        if (driver.inTransaction) {
          if (outer) db.exec('ROLLBACK');
          else db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        }
        throw error;
      }
    },
    close(): void {
      if (!db.isOpen()) return;
      for (const stmt of prepared.splice(0)) {
        try {
          stmt.finalize();
        } catch {
          // Already finalized.
        }
      }
      db.close();
    },
  };
  return driver;
}

/**
 * Opens a database with oo1 and wraps it. `vfs` names a registered VFS
 * (`opfs-sahpool`); omit it for the default (in memory for `:memory:`).
 * Temp tables live in memory, so they never take a slot in the SAH pool.
 */
export function openOo1Database(
  sqlite3: Sqlite3Static,
  filename: string,
  options: { vfs?: string; location?: string } = {},
): Oo1Driver {
  const db = options.vfs
    ? new sqlite3.oo1.DB({ filename, flags: 'c', vfs: options.vfs })
    : new sqlite3.oo1.DB(filename, 'c');
  try {
    db.exec('PRAGMA temp_store = MEMORY');
    return wrapOo1Database(sqlite3, db, options.location ?? filename);
  } catch (error) {
    db.close();
    throw error;
  }
}
