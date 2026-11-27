// Where the worker keeps the brain's two databases: in the origin private
// file system (OPFS) through SQLite's `opfs-sahpool` VFS, or in memory when
// OPFS is unavailable. Worker-only (sync access handles exist only in
// dedicated workers).
//
// The SAH pool VFS needs no cross-origin isolation (no COOP/COEP headers),
// unlike SQLite's other OPFS VFS. It holds every file in its pool open with an
// exclusive sync access handle for as long as the worker lives, so only one
// worker in the origin can use it at a time (./open.ts elects that one).

import type { SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { DatabaseProvider } from './brain-service.ts';
import { openOo1Database, type Oo1Driver } from './sqlite-driver.ts';

/** The pool's OPFS directory. All files in it belong to the VFS. */
export const POOL_DIRECTORY = '.somememos-sahpool';
/** The brain's databases, by their names inside the pool. */
export const EVENTS_FILE = '/brain/events.sqlite';
export const INDEX_FILE = '/brain/index.sqlite';
/** Two databases, their rollback journals, and room to spare. */
const MIN_CAPACITY = 8;

/**
 * Settings for the databases on the device. The SAH pool already gives this
 * worker the files exclusively, so SQLite may too: in EXCLUSIVE locking mode
 * it keeps its page cache between transactions instead of re-reading pages
 * after every commit (search over 1,000 notes about 2.5 times faster). The
 * rollback journal is truncated rather than deleted, which in the pool saves
 * re-assigning a file slot on every commit. `synchronous` stays FULL.
 */
const DEVICE_PRAGMAS = `
  PRAGMA locking_mode = EXCLUSIVE;
  PRAGMA journal_mode = TRUNCATE;
  PRAGMA cache_size = -16384;
`;

/** Applies `DEVICE_PRAGMAS` to a database in the SAH pool; returns it. */
export function tuneForDevice(driver: Oo1Driver): Oo1Driver {
  driver.exec(DEVICE_PRAGMAS);
  return driver;
}

/** The pool's files are held by another worker (another tab of this app). */
export class StorageBusyError extends Error {
  override name = 'StorageBusyError';
}

function isBusy(error: unknown): boolean {
  const e = error as { name?: unknown; message?: unknown } | null;
  return (
    e?.name === 'NoModificationAllowedError' ||
    (typeof e?.message === 'string' && /access handle|NoModificationAllowed/i.test(e.message))
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface InstallOptions {
  readonly directory?: string;
  readonly capacity?: number;
  /** How long to keep retrying while another worker holds the files. Default 10 s. */
  readonly busyWaitMs?: number;
}

/**
 * Installs the SAH pool VFS, waiting (up to `busyWaitMs`) while another worker
 * still holds its files, as happens for a moment after the tab that owned the
 * brain closes. Throws `StorageBusyError` if they stay held.
 *
 * `preserveOnInitFailure` matters: without it, a failed install *deletes the
 * pool*, so a second tab that couldn't get the files would wipe the brain.
 */
export async function installSahPool(
  sqlite3: Sqlite3Static,
  options: InstallOptions = {},
): Promise<SAHPoolUtil> {
  const deadline = Date.now() + (options.busyWaitMs ?? 10_000);
  for (let attempt = 0; ; attempt++) {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({
        directory: options.directory ?? POOL_DIRECTORY,
        initialCapacity: options.capacity ?? MIN_CAPACITY,
        preserveOnInitFailure: true,
        ...({ forceReinitIfPreviouslyFailed: true } as object),
      });
      await pool.reserveMinimumCapacity(options.capacity ?? MIN_CAPACITY);
      return pool;
    } catch (error) {
      if (!isBusy(error)) throw error;
      if (Date.now() >= deadline) {
        throw new StorageBusyError(
          'The brain is open in another tab or window of this app, which holds its files.',
        );
      }
      await sleep(Math.min(100 * 2 ** attempt, 1000));
    }
  }
}

/** The brain's databases in the SAH pool. */
export function opfsProvider(sqlite3: Sqlite3Static, pool: SAHPoolUtil): DatabaseProvider {
  const vfs = pool.vfsName;
  return {
    storage: { kind: 'device' },
    open() {
      const events = tuneForDevice(
        openOo1Database(sqlite3, EVENTS_FILE, { vfs, location: `opfs:${EVENTS_FILE}` }),
      );
      try {
        const index = tuneForDevice(
          openOo1Database(sqlite3, INDEX_FILE, { vfs, location: `opfs:${INDEX_FILE}` }),
        );
        return { events, index };
      } catch (error) {
        events.close();
        throw error;
      }
    },
    async wipe() {
      for (const name of pool.getFileNames()) {
        if (name.startsWith('/brain/')) pool.unlink(name);
      }
    },
  };
}

/** Both databases in memory: lost when the worker ends. */
export function memoryProvider(sqlite3: Sqlite3Static, reason: string): DatabaseProvider {
  return {
    storage: { kind: 'memory', reason },
    open() {
      return {
        events: openOo1Database(sqlite3, ':memory:', { location: 'memory:events' }),
        index: openOo1Database(sqlite3, ':memory:', { location: 'memory:index' }),
      };
    },
    async wipe() {
      // Closing an in-memory database deletes it.
    },
  };
}
