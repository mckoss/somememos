// The store's view of a driver: statements cached per SQL text, and
// `run`/`get`/`all` shortcuts. Internal to this package.

import type { SqlDriver, SqlParams, SqlRow, SqlRunResult, SqlStatement } from './driver.js';

export class Db {
  readonly driver: SqlDriver;
  private readonly cache = new Map<string, SqlStatement>();

  constructor(driver: SqlDriver) {
    this.driver = driver;
  }

  get location(): string {
    return this.driver.location;
  }

  get inTransaction(): boolean {
    return this.driver.inTransaction;
  }

  exec(sql: string): void {
    this.driver.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    let statement = this.cache.get(sql);
    if (!statement) {
      statement = this.driver.prepare(sql);
      this.cache.set(sql, statement);
    }
    return statement;
  }

  run(sql: string, params?: SqlParams): SqlRunResult {
    return this.prepare(sql).run(params);
  }

  get<T = SqlRow>(sql: string, params?: SqlParams): T | undefined {
    return this.prepare(sql).get<T>(params);
  }

  all<T = SqlRow>(sql: string, params?: SqlParams): T[] {
    return this.prepare(sql).all<T>(params);
  }

  /** Runs `fn` atomically: a transaction, or a savepoint inside an open one. */
  transaction<T>(fn: () => T): T {
    return this.driver.transaction(fn);
  }

  close(): void {
    this.cache.clear();
    this.driver.close();
  }
}

/** Runs `fn` atomically on `db` (a transaction, or a savepoint inside one). */
export function atomic<T>(db: Db, fn: () => T): T {
  return db.transaction(fn);
}
