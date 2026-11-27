// `storage.Stores` and `storage.ContentStore` for one brain in the server's
// Postgres database.

import { keyword, storage } from '@somememos/core';
import type pg from 'pg';
import { ensureBrain } from './brains.js';
import { PgContentStore } from './content-store.js';
import { BrainDb, query } from './db.js';
import { PgEventLog, PgMeta } from './event-log.js';
import { PgNoteStore, PgScoreStore, PgTermIndex } from './index-stores.js';
import { ensureMigrated } from './migrate.js';
import { DERIVED_TABLES } from './schema.js';

export interface PgStoresOptions extends storage.StoresOptions {
  /** The pool to use. Shared by every brain; the stores never end it. */
  readonly pool: pg.Pool;
  /** The brain these stores read and write. Its rows are created if missing. */
  readonly brainId: string;
  /**
   * Open for reading only, inside a `READ ONLY` transaction the caller runs
   * (the server's pure reads): no migration, no rows created, and the
   * analyzer read rather than settled. The brain must exist and the schema
   * be migrated. Any write through these stores then fails in Postgres.
   */
  readonly readOnly?: boolean;
}

/** The Postgres stores of one brain. */
export interface PgStores extends storage.Stores {
  readonly brainId: string;
}

async function settleAnalyzer(
  db: BrainDb,
  requested: keyword.AnalyzerOptions,
): Promise<keyword.AnalyzerOptions> {
  return db.derivedAtomic(async (q) => {
    const { rows } = await query<{ analyzer: string | null; has_sections: boolean }>(
      q,
      `SELECT analyzer, EXISTS (SELECT 1 FROM sections WHERE brain_id = $1) AS has_sections
       FROM index_state WHERE brain_id = $1 FOR UPDATE`,
      [db.brainId],
    );
    const row = rows[0];
    const stored = row?.analyzer ? storage.analyzerFromJson(row.analyzer) : undefined;
    // Keep the recorded analyzer while sections exist, as SQLite does.
    if (stored && row?.has_sections) return stored;
    if (!stored || storage.compareAnalyzers(stored, requested)) {
      await query(q, `UPDATE index_state SET analyzer = $2 WHERE brain_id = $1`, [
        db.brainId,
        storage.analyzerToJson(requested),
      ]);
    }
    return requested;
  });
}

/** The analyzer `settleAnalyzer` would settle on, without writing or locking. */
async function readAnalyzer(
  db: BrainDb,
  requested: keyword.AnalyzerOptions,
): Promise<keyword.AnalyzerOptions> {
  const { rows } = await db.derived<{ analyzer: string | null; has_sections: boolean }>(
    `SELECT analyzer, EXISTS (SELECT 1 FROM sections WHERE brain_id = $1) AS has_sections
     FROM index_state WHERE brain_id = $1`,
    [db.brainId],
  );
  const row = rows[0];
  if (!row) throw new RangeError(`no such brain: ${db.brainId}`);
  const stored = row.analyzer ? storage.analyzerFromJson(row.analyzer) : undefined;
  return stored && row.has_sections ? stored : requested;
}

/**
 * Opens one brain's stores over `pool`: applies any pending migrations (once
 * per pool), creates the brain's rows if missing, and settles the term
 * index's analyzer exactly as the SQLite store does (a brain whose index holds
 * sections keeps the analyzer it was built with; `terms.analyzerMismatch`
 * reports a difference, and `resetIndex({ analyzer })` changes it).
 *
 * Original data (events, change records, meta) is written in transactions of
 * its own; derived data joins a pending `indexTransaction`. `close()` only
 * marks the stores closed: the pool belongs to the caller.
 */
export async function createPgStores(options: PgStoresOptions): Promise<PgStores> {
  const { pool, brainId } = options;
  const clock = options.now ?? storage.unixNow;
  const requested = keyword.resolveAnalyzerOptions(options.analyzer);
  const db = new BrainDb(pool, brainId);
  let analyzer: keyword.AnalyzerOptions;
  if (options.readOnly) {
    analyzer = await readAnalyzer(db, requested);
  } else {
    await ensureMigrated(pool);
    await ensureBrain(pool, brainId, clock());
    analyzer = await settleAnalyzer(db, requested);
  }
  const terms = new PgTermIndex(db, analyzer);

  return {
    brainId,
    events: new PgEventLog(db, clock),
    meta: new PgMeta(db, 'brain_meta'),
    scores: new PgScoreStore(db),
    notes: new PgNoteStore(db),
    terms,
    indexMeta: new PgMeta(db, 'index_meta'),

    indexTransaction: (fn) => db.indexTransaction(fn),

    async resetIndex(resetOptions?: { readonly analyzer?: Partial<keyword.AnalyzerOptions> }) {
      const next = resetOptions?.analyzer
        ? keyword.resolveAnalyzerOptions(resetOptions.analyzer)
        : requested;
      await db.derivedAtomic(async (q) => {
        // Lock the fold state first, so a concurrent fold waits and then conflicts.
        await query(q, `SELECT 1 FROM index_state WHERE brain_id = $1 FOR UPDATE`, [brainId]);
        for (const table of DERIVED_TABLES) {
          await query(q, `DELETE FROM ${table} WHERE brain_id = $1`, [brainId]);
        }
        await query(
          q,
          `UPDATE index_state SET fold_cursor = 0, half_lives = NULL, burst_window = NULL
           WHERE brain_id = $1`,
          [brainId],
        );
        await terms.setAnalyzer(q, next);
      });
    },

    close() {
      db.close();
    },
  };
}

export interface PgContentStoreOptions {
  readonly pool: pg.Pool;
  readonly brainId: string;
  /** The clock for writes without an mtime, whole Unix seconds. Default: the system clock. */
  readonly now?: () => number;
}

/** A brain's note text in the `content` table (migrating and creating the brain as needed). */
export async function createPgContentStore(
  options: PgContentStoreOptions,
): Promise<storage.ContentStore> {
  const clock = options.now ?? storage.unixNow;
  await ensureMigrated(options.pool);
  await ensureBrain(options.pool, options.brainId, clock());
  return new PgContentStore(new BrainDb(options.pool, options.brainId), clock);
}
