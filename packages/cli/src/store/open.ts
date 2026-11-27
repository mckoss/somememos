// Opening a brain's stores: the two SQLite files in `<brain>/.somememos/`.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { keyword, storage } from '@somememos/core';
import { open, type Database } from '../sqlite/database.js';
import { SqliteEventLog, SqliteMeta } from './event-log.js';
import {
  META_ANALYZER,
  META_FOLD_CURSOR,
  META_FOLD_HALF_LIVES,
  SqliteNoteStore,
  SqliteScoreStore,
  SqliteTermIndex,
} from './index-stores.js';
import { INDEX_TABLES, atomic, ensureEventsSchema, ensureIndexSchema } from './schema.js';

/** The sidecar directory inside a brain. */
export const SIDECAR_DIR = '.somememos';
export const EVENTS_FILE = 'events.sqlite';
export const INDEX_FILE = 'index.sqlite';

export interface OpenBrainStoresOptions extends storage.StoresOptions {
  /** How long to wait for another process's write lock, in ms. Default 5000. */
  readonly busyTimeoutMs?: number;
}

/** A brain's SQLite stores. */
export interface BrainStores extends storage.Stores {
  /** The brain's `.somememos/` directory. */
  readonly sidecarDir: string;
  readonly eventsPath: string;
  readonly indexPath: string;
  /** True when `index.sqlite` was created or rebuilt empty on open (new, or a schema change). */
  readonly indexCreated: boolean;
}

/** The paths of a brain's sidecar files. */
export function brainPaths(brainDir: string): {
  sidecarDir: string;
  eventsPath: string;
  indexPath: string;
} {
  const sidecarDir = join(resolve(brainDir), SIDECAR_DIR);
  return {
    sidecarDir,
    eventsPath: join(sidecarDir, EVENTS_FILE),
    indexPath: join(sidecarDir, INDEX_FILE),
  };
}

function readAnalyzer(db: Database): keyword.AnalyzerOptions | undefined {
  const json = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = :key`, {
    key: META_ANALYZER,
  })?.value;
  return json === undefined ? undefined : storage.analyzerFromJson(json);
}

/**
 * Opens (creating as needed) `<brainDir>/.somememos/` and its two files.
 *
 * - `events.sqlite` is checked: a file with another schema version throws
 *   `storage.MigrationRequiredError` and is left untouched.
 * - `index.sqlite` is derived: a file with another schema version is emptied
 *   and recreated (`indexCreated` is then true), to be rebuilt.
 * - The term index keeps the analyzer it was built with. If it holds sections
 *   built with another analyzer than `options.analyzer`,
 *   `terms.analyzerMismatch(options.analyzer)` reports it; call
 *   `resetIndex({ analyzer })` to rebuild.
 *
 * Both files use WAL journaling and a busy timeout, so several processes can
 * use one brain at once. Close the stores when done.
 */
export function openBrainStores(
  brainDir: string,
  options: OpenBrainStoresOptions = {},
): BrainStores {
  const paths = brainPaths(brainDir);
  mkdirSync(paths.sidecarDir, { recursive: true });
  const dbOptions =
    options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs };
  const requested = keyword.resolveAnalyzerOptions(options.analyzer);
  const clock = options.now ?? storage.unixNow;

  const eventsDb = open(paths.eventsPath, dbOptions);
  let indexDb: Database | undefined;
  try {
    ensureEventsSchema(eventsDb);
    indexDb = open(paths.indexPath, dbOptions);
    const idb = indexDb;
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

    const stores: BrainStores = {
      ...paths,
      indexCreated,
      events: new SqliteEventLog(eventsDb, clock),
      meta: new SqliteMeta(eventsDb),
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
          if (idb.raw.isOpen && idb.raw.isTransaction) idb.exec('ROLLBACK');
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
          for (const key of [META_FOLD_CURSOR, META_FOLD_HALF_LIVES]) {
            idb.run(`DELETE FROM meta WHERE key = :key`, { key });
          }
          terms.setAnalyzer(next);
        });
      },

      close(): void {
        if (closed) return;
        closed = true;
        idb.close();
        eventsDb.close();
      },
    };
    return stores;
  } catch (error) {
    indexDb?.close();
    eventsDb.close();
    throw error;
  }
}
