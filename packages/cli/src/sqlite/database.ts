// A thin, typed wrapper over Node's built-in `node:sqlite` module, for the CLI's
// local (offline) store. It opens databases with WAL journaling and a busy
// timeout, and adds a `transaction(fn)` helper. The storage interfaces that core
// talks to are defined on top of this later; keep this module small.
//
// This file must not use relative imports or non-erasable TypeScript syntax: a
// test loads it directly with Node's type stripping in a child process.

import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';

export type SqlValue = SQLInputValue;
export type SqlOutput = SQLOutputValue;
/** Named parameters: `{ item: 'x' }` binds `:item`, `$item` or `@item`. */
export type Params = Record<string, SqlValue>;
export type Row = Record<string, SqlOutput>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface OpenOptions {
  /** How long a connection waits for a lock before failing with SQLITE_BUSY. Default 5000 ms. */
  busyTimeoutMs?: number;
  /** Open read-only. Default false. */
  readOnly?: boolean;
  /** Use WAL journaling (ignored for in-memory databases). Default true. */
  wal?: boolean;
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface Statement {
  run(params?: Params): RunResult;
  get<T = Row>(params?: Params): T | undefined;
  all<T = Row>(params?: Params): T[];
}

export interface Database {
  /** The file path, or `:memory:`. */
  readonly location: string;
  /** The underlying `node:sqlite` connection, for anything this wrapper doesn't cover. */
  readonly raw: DatabaseSync;
  /** Run one or more statements that take no parameters. */
  exec(sql: string): void;
  /** Prepare a statement. Statements are cached per SQL text. */
  prepare(sql: string): Statement;
  run(sql: string, params?: Params): RunResult;
  get<T = Row>(sql: string, params?: Params): T | undefined;
  all<T = Row>(sql: string, params?: Params): T[];
  /**
   * Run `fn` in a transaction: commit if it returns, roll back if it throws.
   * The outermost level uses `BEGIN IMMEDIATE`, so the write lock is taken up
   * front (waiting up to the busy timeout); nested calls use savepoints.
   * `fn` must be synchronous.
   */
  transaction<T>(fn: (db: Database) => T): T;
  close(): void;
}

type SqliteModule = typeof import('node:sqlite');
let sqliteModule: SqliteModule | undefined;

/**
 * Load `node:sqlite` without printing Node's "SQLite is an experimental
 * feature" warning (printed on Node 22). Only that one warning is filtered,
 * only while the module loads.
 */
export function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (message.includes('SQLite is an experimental feature')) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqliteModule = process.getBuiltinModule('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

function wrapStatement(statement: StatementSync): Statement {
  return {
    run(params = {}) {
      const result = statement.run(params);
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    get<T>(params: Params = {}) {
      return statement.get(params) as T | undefined;
    },
    all<T>(params: Params = {}) {
      return statement.all(params) as T[];
    },
  };
}

/** Open (creating if needed) a database file, or `:memory:`. */
export function open(location: string, options: OpenOptions = {}): Database {
  const { DatabaseSync } = loadSqlite();
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const raw = new DatabaseSync(location, {
    readOnly: options.readOnly ?? false,
    timeout: busyTimeoutMs,
  });
  raw.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  const inMemory = location === ':memory:' || location === '';
  if ((options.wal ?? true) && !inMemory && !options.readOnly) {
    raw.exec('PRAGMA journal_mode = WAL');
  }

  const cache = new Map<string, Statement>();
  let depth = 0;

  const db: Database = {
    location,
    raw,
    exec(sql) {
      raw.exec(sql);
    },
    prepare(sql) {
      let statement = cache.get(sql);
      if (!statement) {
        statement = wrapStatement(raw.prepare(sql));
        cache.set(sql, statement);
      }
      return statement;
    },
    run(sql, params) {
      return db.prepare(sql).run(params);
    },
    get<T>(sql: string, params?: Params) {
      return db.prepare(sql).get<T>(params);
    },
    all<T>(sql: string, params?: Params) {
      return db.prepare(sql).all<T>(params);
    },
    transaction<T>(fn: (db: Database) => T): T {
      const level = depth;
      const savepoint = `sp_${level}`;
      raw.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      depth = level + 1;
      try {
        const result = fn(db);
        if (result instanceof Promise) {
          throw new TypeError('transaction(fn): fn must be synchronous');
        }
        raw.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        if (raw.isOpen && raw.isTransaction) {
          if (level === 0) raw.exec('ROLLBACK');
          else raw.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        }
        throw error;
      } finally {
        depth = level;
      }
    },
    close() {
      cache.clear();
      if (raw.isOpen) raw.close();
    },
  };
  return db;
}

export function close(db: Database): void {
  db.close();
}
