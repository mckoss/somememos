// Opening a brain's stores: the two SQLite files in `<brain>/.somememos/`,
// through `@somememos/sqlite-store`'s node:sqlite driver. Only the paths and
// the sidecar directory are this module's business.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { storage } from '@somememos/core';
import { type SqliteFileStores, openSqliteFiles } from '@somememos/sqlite-store/node';

/** The sidecar directory inside a brain. */
export const SIDECAR_DIR = '.somememos';
export const EVENTS_FILE = 'events.sqlite';
export const INDEX_FILE = 'index.sqlite';

export interface OpenBrainStoresOptions extends storage.StoresOptions {
  /** How long to wait for another process's write lock, in ms. Default 5000. */
  readonly busyTimeoutMs?: number;
}

/** A brain's SQLite stores. */
export interface BrainStores extends SqliteFileStores {
  /** The brain's `.somememos/` directory. */
  readonly sidecarDir: string;
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

/**
 * Opens (creating as needed) `<brainDir>/.somememos/` and its two files
 * (`openSqliteFiles`: schema checks, the analyzer rule, WAL and a busy
 * timeout, so several processes can use one brain at once). Close the stores
 * when done.
 */
export function openBrainStores(
  brainDir: string,
  options: OpenBrainStoresOptions = {},
): BrainStores {
  const paths = brainPaths(brainDir);
  mkdirSync(paths.sidecarDir, { recursive: true });
  const stores = openSqliteFiles({
    ...options,
    eventsPath: paths.eventsPath,
    indexPath: paths.indexPath,
  });
  return Object.assign(stores, { sidecarDir: paths.sidecarDir });
}
