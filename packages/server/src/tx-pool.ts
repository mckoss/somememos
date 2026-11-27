// One Postgres transaction for everything a server request writes.
//
// pg-store writes original data (events, change records, meta) in
// transactions of its own and derived data in an index transaction, which is
// right for a client but not for the server: a sync request's note versions,
// log entries, change records, mutation numbers, index and recorded git
// commit must commit together or not at all. `TransactionPool` is a stand-in
// for a `pg.Pool` that pg-store's stores can be opened over: every query runs
// on the one connection of the transaction in progress (found through an
// AsyncLocalStorage), and pg-store's own BEGIN / COMMIT / ROLLBACK on a
// "connection" from it become SAVEPOINT / RELEASE / ROLLBACK TO, so its
// all-or-nothing batches keep their meaning inside the outer transaction.
//
// The engine runs one call at a time and pg-store issues its statements one
// after another, so the savepoints nest strictly.

import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';

interface Tx {
  readonly client: pg.PoolClient;
  readonly savepoints: string[];
  next: number;
}

type QueryArgs = [unknown, unknown?, unknown?];

/** A `pg.Pool` look-alike over the current transaction's connection. */
export class TransactionPool {
  private readonly current = new AsyncLocalStorage<Tx>();

  constructor(readonly pool: pg.Pool) {}

  /** Runs `fn` inside a transaction on one connection; every query of this pool made by it joins. */
  async run<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (this.current.getStore()) throw new Error('a server transaction is already in progress');
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      try {
        const result = await this.current.run({ client, savepoints: [], next: 0 }, () =>
          fn(client),
        );
        const commit = await client.query('COMMIT');
        if (commit.command === 'ROLLBACK') {
          throw new Error('the transaction was aborted by an earlier error; nothing was committed');
        }
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          broken = rollbackError as Error;
        }
        throw error;
      }
    } finally {
      client.release(broken);
    }
  }

  private tx(): Tx {
    const tx = this.current.getStore();
    if (!tx) throw new Error('database access outside a server transaction');
    return tx;
  }

  /** `pool.query`: on the transaction's connection. */
  query(...args: QueryArgs): Promise<pg.QueryResult> {
    const client = this.tx().client as unknown as {
      query: (...a: QueryArgs) => Promise<pg.QueryResult>;
    };
    return client.query(...args);
  }

  /** `pool.connect`: a view of the transaction's connection whose transactions are savepoints. */
  async connect(): Promise<pg.PoolClient> {
    const tx = this.tx();
    const client = tx.client as unknown as { query: (...a: QueryArgs) => Promise<pg.QueryResult> };
    const view = {
      query: (...args: QueryArgs): Promise<pg.QueryResult> => {
        const text = typeof args[0] === 'string' ? args[0].trim().toUpperCase() : null;
        if (text === 'BEGIN') {
          const name = `sp_${++tx.next}`;
          tx.savepoints.push(name);
          return client.query(`SAVEPOINT ${name}`);
        }
        if (text === 'COMMIT') {
          const name = tx.savepoints.pop();
          if (!name) throw new Error('COMMIT without BEGIN');
          return client.query(`RELEASE SAVEPOINT ${name}`);
        }
        if (text === 'ROLLBACK') {
          const name = tx.savepoints.pop();
          if (!name) throw new Error('ROLLBACK without BEGIN');
          return client
            .query(`ROLLBACK TO SAVEPOINT ${name}`)
            .then(() => client.query(`RELEASE SAVEPOINT ${name}`));
        }
        return client.query(...args);
      },
      release: () => undefined,
    };
    return view as unknown as pg.PoolClient;
  }

  /** Never ends the real pool (it belongs to the server). */
  async end(): Promise<void> {}

  /** As a `pg.Pool`, for `createPgStores`. */
  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}
