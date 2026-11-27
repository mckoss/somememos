// `storage.Stores` over two SQLite databases, written only against the
// driver interface (./driver.ts), so the same code runs on `node:sqlite` in
// the CLI and on SQLite compiled to WebAssembly in the browser.

import { keyword, storage } from '@somememos/core';
import { atomic, Db } from './db.js';
import type { SqlDriver } from './driver.js';
import { SqliteContentStore } from './content-store.js';
import { SqliteEventLog, SqliteMeta } from './event-log.js';
import {
  META_ANALYZER,
  META_FOLD_BURST_WINDOW,
  META_FOLD_CURSOR,
  META_FOLD_HALF_LIVES,
  SqliteNoteStore,
  SqliteScoreStore,
  SqliteTermIndex,
} from './index-stores.js';
import {
  INDEX_TABLES,
  ensureContentSchema,
  ensureEventsSchema,
  ensureIndexSchema,
} from './schema.js';

export interface SqliteStoresOptions extends storage.StoresOptions {
  /** The original-data database: event log, change records, durable meta. */
  readonly events: SqlDriver;
  /** The derived database: notes, links, term index, scores, index meta. */
  readonly index: SqlDriver;
}

/** The SQLite stores. */
export interface SqliteStores extends storage.Stores {
  /** True when the derived database was created or rebuilt empty on open (new, or a schema change). */
  readonly indexCreated: boolean;
}

function readAnalyzer(db: Db): keyword.AnalyzerOptions | undefined {
  const json = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = :key`, {
    key: META_ANALYZER,
  })?.value;
  return json === undefined ? undefined : storage.analyzerFromJson(json);
}

/**
 * Creates the stores over two open connections (creating the tables as
 * needed). The two may be any two distinct databases: two files (the CLI's
 * `events.sqlite` and `index.sqlite`), or two databases in browser storage.
 *
 * - The original-data database is checked: one with another schema version
 *   throws `storage.MigrationRequiredError` and is left untouched.
 * - The derived database with another schema version is emptied and
 *   recreated (`indexCreated` is then true), to be rebuilt.
 * - The term index keeps the analyzer it was built with. If it holds
 *   sections built with another analyzer than `options.analyzer`,
 *   `terms.analyzerMismatch(options.analyzer)` reports it; call
 *   `resetIndex({ analyzer })` to rebuild.
 *
 * `close()` closes both drivers. On an error the drivers are left open for
 * the caller to close.
 */
export function createSqliteStores(options: SqliteStoresOptions): SqliteStores {
  const edb = new Db(options.events);
  const idb = new Db(options.index);
  const requested = keyword.resolveAnalyzerOptions(options.analyzer);
  const clock = options.now ?? storage.unixNow;

  ensureEventsSchema(edb);
  const indexCreated = ensureIndexSchema(idb);

  // Settle the analyzer: keep the recorded one while sections exist.
  const analyzer = idb.transaction(() => {
    const stored = readAnalyzer(idb);
    const sections = idb.get<{ n: number }>(`SELECT count(*) AS n FROM sections`)?.n ?? 0;
    if (stored && sections > 0) return stored;
    if (!stored || storage.compareAnalyzers(stored, requested)) {
      idb.run(
        `INSERT INTO meta (key, value) VALUES (:key, :value)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        { key: META_ANALYZER, value: storage.analyzerToJson(requested) },
      );
    }
    return requested;
  });

  const terms = new SqliteTermIndex(idb, analyzer);
  let pending = 0;
  let closed = false;

  return {
    indexCreated,
    events: new SqliteEventLog(edb, clock),
    meta: new SqliteMeta(edb),
    scores: new SqliteScoreStore(idb),
    notes: new SqliteNoteStore(idb),
    terms,
    indexMeta: new SqliteMeta(idb),

    async indexTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
      if (pending > 0) return await fn();
      idb.exec('BEGIN IMMEDIATE');
      pending++;
      try {
        const result = await fn();
        idb.exec('COMMIT');
        return result;
      } catch (error) {
        if (idb.inTransaction) idb.exec('ROLLBACK');
        throw error;
      } finally {
        pending--;
      }
    },

    resetIndex(resetOptions?: { readonly analyzer?: Partial<keyword.AnalyzerOptions> }): void {
      const next = resetOptions?.analyzer
        ? keyword.resolveAnalyzerOptions(resetOptions.analyzer)
        : requested;
      atomic(idb, () => {
        for (const table of INDEX_TABLES) idb.exec(`DELETE FROM ${table}`);
        for (const key of [META_FOLD_CURSOR, META_FOLD_HALF_LIVES, META_FOLD_BURST_WINDOW]) {
          idb.run(`DELETE FROM meta WHERE key = :key`, { key });
        }
        terms.setAnalyzer(next);
      });
    },

    close(): void {
      if (closed) return;
      closed = true;
      idb.close();
      edb.close();
    },
  };
}

export interface SqliteContentStoreOptions {
  /** The clock for writes without an mtime, whole Unix seconds. Default: the system clock. */
  readonly now?: () => number;
}

/**
 * A `storage.ContentStore` over the `content` table of the original-data
 * database (created if missing; the event log's tables too, if the database
 * is new). Pass the same driver as `createSqliteStores`'s `events`; it stays
 * usable until the stores are closed.
 */
export function createSqliteContentStore(
  events: SqlDriver,
  options: SqliteContentStoreOptions = {},
): storage.ContentStore {
  const db = new Db(events);
  ensureContentSchema(db);
  return new SqliteContentStore(db, options.now ?? storage.unixNow);
}
