// Opening the stores over two database files with the `node:sqlite` driver.

import { createSqliteStores, type SqliteStores } from '../stores.js';
import type { storage } from '@somememos/core';
import { open, type Database } from './database.js';

export interface OpenSqliteFilesOptions extends storage.StoresOptions {
  /** The original-data file (the CLI's `events.sqlite`). Created if missing; its folder must exist. */
  readonly eventsPath: string;
  /** The derived file (the CLI's `index.sqlite`). */
  readonly indexPath: string;
  /** How long to wait for another process's write lock, in ms. Default 5000. */
  readonly busyTimeoutMs?: number;
}

export interface SqliteFileStores extends SqliteStores {
  readonly eventsPath: string;
  readonly indexPath: string;
}

/**
 * Opens (creating as needed) the two files with WAL journaling and a busy
 * timeout, so several processes can use them at once, and creates the stores
 * over them (`createSqliteStores`). Close the stores when done.
 */
export function openSqliteFiles(options: OpenSqliteFilesOptions): SqliteFileStores {
  const { eventsPath, indexPath, busyTimeoutMs, ...storesOptions } = options;
  const dbOptions = busyTimeoutMs === undefined ? {} : { busyTimeoutMs };
  const events = open(eventsPath, dbOptions);
  let index: Database | undefined;
  try {
    index = open(indexPath, dbOptions);
    const stores = createSqliteStores({ ...storesOptions, events, index });
    return Object.assign(stores, { eventsPath, indexPath });
  } catch (error) {
    index?.close();
    events.close();
    throw error;
  }
}
