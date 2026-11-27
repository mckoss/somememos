// The SQLite driver interface: the small, synchronous surface the SQL store
// needs from a database connection. Two drivers implement it:
//
// - `node:sqlite` (`@somememos/sqlite-store/node`, `openNodeDatabase`), for
//   the CLI.
// - The official SQLite WebAssembly build's synchronous `oo1` API, inside a
//   Web Worker (milestone 2, the web app). Its `DB` maps onto this almost
//   one to one: `exec(sql)`, `prepare(sql)` with `bind`/`step`/`get`, and
//   `sqlite3.capi.sqlite3_get_autocommit(db.pointer) === 0` for
//   `inTransaction`.
//
// What a driver must guarantee:
//
// - Synchronous. Every method returns its result directly; nothing returns a
//   promise.
// - Named parameters. The store writes `:name` placeholders only, and passes
//   parameters as an object keyed by the bare name: `{ item: 'x' }` binds
//   `:item`. (oo1 wants the prefix in the key: the driver adds `:`.) Every
//   placeholder in the statement gets a key; extra keys are not passed.
// - Values. Bound: `null`, `string`, `number`, `bigint`, `Uint8Array`. An
//   integer-valued `number` must end up stored as an INTEGER (bind it as an
//   integer, or as a REAL that the column's INTEGER affinity converts
//   losslessly). Read back: TEXT as `string`, REAL as `number`, NULL as
//   `null`, BLOB as a `Uint8Array` (a copy the caller may keep), and INTEGER
//   as a `number` whenever it is a safe integer (|n| <= 2^53 - 1). Values the
//   store writes (seqs, Unix seconds, counts, lengths) exceed 2^31 but never
//   2^53; a driver may return a `bigint` or throw for larger ones, never a
//   rounded number.
// - Rows are plain objects keyed by column name (the `AS` alias when given).
// - `run` reports `changes` (rows changed by that statement) and
//   `lastInsertRowid` (the rowid of the last insert on the connection), both
//   as numbers.
// - `exec(sql)` runs one or more statements with no parameters, including
//   `BEGIN IMMEDIATE`, `COMMIT`, `ROLLBACK`, `SAVEPOINT x`, `RELEASE x` and
//   `ROLLBACK TO x`. The store opens a long transaction this way around an
//   async index pass (`Stores.indexTransaction`).
// - `inTransaction` is true exactly when the connection is not in autocommit
//   mode (`sqlite3_get_autocommit() == 0`): inside `BEGIN`, a savepoint, or
//   `transaction(fn)`.
// - `transaction(fn)` runs `fn` synchronously and returns its value. When
//   the connection is not in a transaction it wraps `fn` in
//   `BEGIN IMMEDIATE` … `COMMIT` (taking the write lock up front, waiting up
//   to the busy timeout for another connection's lock). When it already is
//   (a nested call, or a transaction opened with `exec`), it wraps `fn` in a
//   uniquely named `SAVEPOINT` … `RELEASE`, so it joins the outer
//   transaction: its writes commit only when the outer one does. If `fn`
//   throws, the driver rolls back exactly its own level (`ROLLBACK`, or
//   `ROLLBACK TO` and `RELEASE` the savepoint) and rethrows; the outer
//   transaction stays open. If `fn` returns a promise, that is a bug: roll
//   back and throw a TypeError.
// - Statements returned by `prepare` stay valid until `close()`, which
//   finalizes them. The store caches one statement per SQL text, so a driver
//   need not.
// - Several connections (several processes) may use one database file at
//   once. A file-backed driver must set a busy timeout so a writer waits for
//   another's lock instead of failing at once; the Node driver also uses WAL.
//   A browser driver that holds the file exclusively (OPFS SAH pool) needs
//   neither.
// - The SQLite build has `WITHOUT ROWID` tables (any SQLite since 3.8.2).
//   No extensions (FTS, JSON, math functions) are needed.

/** A value bound to a parameter or read from a column. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** Named parameters: `{ item: 'x' }` binds `:item`. */
export type SqlParams = Readonly<Record<string, SqlValue>>;

/** A result row, keyed by column name. */
export type SqlRow = Record<string, SqlValue>;

export interface SqlRunResult {
  /** Rows inserted, updated or deleted by the statement. */
  readonly changes: number;
  /** The rowid of the most recent insert on this connection. */
  readonly lastInsertRowid: number;
}

/** A prepared statement. May be run any number of times, with fresh parameters each time. */
export interface SqlStatement {
  run(params?: SqlParams): SqlRunResult;
  /** The first row, or undefined. */
  get<T = SqlRow>(params?: SqlParams): T | undefined;
  /** Every row. */
  all<T = SqlRow>(params?: SqlParams): T[];
}

/** An open database connection. See the guarantees above. */
export interface SqlDriver {
  /** A name for messages: the file path, `:memory:`, or a browser storage name. */
  readonly location: string;
  /** True when the connection is inside a transaction (not in autocommit mode). */
  readonly inTransaction: boolean;
  /** Runs statements that take no parameters. */
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Runs `fn` atomically: a transaction, or a savepoint inside one. */
  transaction<T>(fn: () => T): T;
  close(): void;
}
