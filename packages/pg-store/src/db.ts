// How the stores reach Postgres: one pool shared by every brain, and, inside
// `Stores.indexTransaction`, one dedicated connection that every derived-data
// write uses. Internal to this package.
//
// The transaction's connection is found through an `AsyncLocalStorage`
// (this package is Node-only), one per `Stores`, so the calls `fn` makes,
// however deeply awaited, run on that connection and nothing else does.

import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

/** A pool or a checked-out client: anything that runs a query. */
export type Queryable = pg.Pool | pg.PoolClient | pg.Client;

const INT8_OID = 20;
const NUMERIC_OID = 1700;

/**
 * Type parsers for this package's queries: `bigint` and `numeric` (counts,
 * sums, seqs, Unix seconds) as JavaScript numbers. Every value they carry is
 * a safe integer. Scoped to our queries, so the process-wide `pg.types`
 * defaults are left alone for other users of `pg`.
 */
const TYPES = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8_OID || oid === NUMERIC_OID) return (value: string) => Number(value);
    return pg.types.getTypeParser(oid, format as 'text');
  },
} as unknown as pg.CustomTypesConfig;

/** Runs one parameterized statement with this package's type parsers. */
export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  q: Queryable,
  text: string,
  values: readonly unknown[] = [],
): Promise<pg.QueryResult<R>> {
  return q.query<R>({ text, values: values as unknown[], types: TYPES });
}

/** Runs `fn` in a transaction on a client of `pool`. */
export async function transaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    let result: T;
    try {
      result = await fn(client);
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        broken = rollbackError as Error;
      }
      throw error;
    }
    const commit = await client.query('COMMIT');
    // COMMIT of a transaction an earlier error aborted reports ROLLBACK.
    if (commit.command === 'ROLLBACK') {
      throw new Error('the transaction was aborted by an earlier error; nothing was committed');
    }
    return result;
  } finally {
    client.release(broken);
  }
}

interface TxContext {
  readonly client: pg.PoolClient;
  done: boolean;
}

/**
 * One brain's access to the database. Original data (the event log, change
 * records, durable meta, content) always goes through the pool, in its own
 * transactions, like SQLite's separate `events.sqlite`. Derived data uses the
 * pending index transaction's connection when there is one.
 */
export class BrainDb {
  private readonly tx = new AsyncLocalStorage<TxContext>();
  private closed = false;

  constructor(
    readonly pool: pg.Pool,
    readonly brainId: string,
  ) {}

  close(): void {
    this.closed = true;
  }

  private check(): void {
    if (this.closed) throw new Error('these Postgres stores are closed');
  }

  /** Where a derived-data statement runs: the index transaction's connection, or the pool. */
  private derivedTarget(): Queryable {
    const ctx = this.tx.getStore();
    if (!ctx) return this.pool;
    if (ctx.done) {
      throw new Error('a write was made after its index transaction had finished');
    }
    return ctx.client;
  }

  get inIndexTransaction(): boolean {
    return this.tx.getStore() !== undefined;
  }

  /** A statement on original data. */
  original<R extends pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>> {
    this.check();
    return query<R>(this.pool, text, values);
  }

  /** A transaction on original data. */
  originalAtomic<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    this.check();
    return transaction(this.pool, fn);
  }

  /** A statement on derived data. */
  derived<R extends pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>> {
    this.check();
    return query<R>(this.derivedTarget(), text, values);
  }

  /**
   * Runs `fn` atomically on derived data: inside the pending index
   * transaction (on its connection), or in a transaction of its own. Inside
   * an index transaction no savepoint is taken: every check that can fail
   * runs before the first write, and a database error aborts the whole
   * index transaction, which then cannot commit.
   */
  derivedAtomic<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
    this.check();
    const target = this.derivedTarget();
    if (target !== this.pool) return fn(target);
    return transaction(this.pool, fn);
  }

  /**
   * Runs `fn` with every derived-data call it makes on one connection, in one
   * transaction. Nested calls join the outer one.
   */
  async indexTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
    this.check();
    if (this.tx.getStore()) return await fn();
    return transaction(this.pool, async (client) => {
      const ctx: TxContext = { client, done: false };
      try {
        return await this.tx.run(ctx, async () => await fn());
      } finally {
        ctx.done = true;
      }
    });
  }
}
