// The brain inside the worker: the two databases, the stores, the content
// store and the engine, and the host operations the page can't do through
// the engine (import, config, reset). ./worker.ts wires it to messages;
// where the databases live (OPFS or memory) is a `DatabaseProvider`.
//
// Every request runs one at a time, in arrival order, whichever tab sent it.
// An import holds that queue from `importBegin` to `importEnd`, so nothing
// indexes a half-written import (an idle import is abandoned after
// `IMPORT_IDLE_MS`, so a closed tab can't hold the brain forever).

import { engine, markdown, storage, type indexing } from '@somememos/core';
import {
  createSqliteContentStore,
  createSqliteStores,
  type SqlDriver,
} from '@somememos/sqlite-store';
import type { ImportFile } from './host.ts';
import { ENGINE_METHODS, type EngineMethod, type Target, type WorkerStorage } from './protocol.ts';

/** Where the brain's two databases live. */
export interface DatabaseProvider {
  readonly storage: WorkerStorage;
  /** Opens (creating if needed) the original-data and derived databases. */
  open(): { events: SqlDriver; index: SqlDriver };
  /** Deletes both databases. They are closed when this is called. */
  wipe(): Promise<void>;
}

/** The durable meta key that holds the brain's config (beside the event log). */
export const META_CONFIG = 'web.config';

/** An import with no chunk for this long is abandoned and the queue released. */
export const IMPORT_IDLE_MS = 60_000;

/** Written by the index pass when an index that had a baseline was emptied. */
const EMPTY_INDEX_WARNING = 'the index was empty, so changes made since the last pass';

interface ActiveImport {
  readonly id: number;
  /** True when the brain held no notes at `importBegin`: this import is the baseline. */
  readonly baseline: boolean;
  imported: number;
  skipped: number;
  idle: ReturnType<typeof setTimeout> | undefined;
  release(): void;
}

export interface BrainService {
  readonly storage: WorkerStorage;
  readonly config: storage.BrainConfig;
  /** Runs one request (see `HostCalls` in ./protocol.ts for the host methods). */
  handle(target: Target, method: string, args: readonly unknown[]): Promise<unknown>;
  close(): void;
}

const ENGINE_METHOD_SET: ReadonlySet<string> = new Set(ENGINE_METHODS);

function invalid(message: string): never {
  throw new engine.EngineError('invalid-argument', message);
}

export async function openBrainService(provider: DatabaseProvider): Promise<BrainService> {
  let stores!: ReturnType<typeof createSqliteStores>;
  let events!: SqlDriver;
  let content!: storage.ContentStore;
  let config!: storage.BrainConfig;
  let current!: engine.Engine;

  const openAll = async (): Promise<void> => {
    const dbs = provider.open();
    try {
      stores = createSqliteStores({ events: dbs.events, index: dbs.index });
    } catch (error) {
      dbs.events.close();
      dbs.index.close();
      throw error;
    }
    events = dbs.events;
    content = createSqliteContentStore(dbs.events);
    const saved = await stores.meta.get(META_CONFIG);
    if (saved === undefined) {
      config = storage.defaultBrainConfig(storage.newId());
      await stores.meta.set(META_CONFIG, storage.serializeBrainConfig(config));
    } else {
      config = storage.parseBrainConfig(JSON.parse(saved), 'the saved brain config');
    }
    current = engine.createEngine({ stores, content, config });
  };

  await openAll();

  // --- One request at a time.
  let tail: Promise<unknown> = Promise.resolve();
  const queue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  // --- Import.
  let nextImport = 1;
  let active: ActiveImport | undefined;

  const touch = (imp: ActiveImport): void => {
    if (imp.idle !== undefined) clearTimeout(imp.idle);
    imp.idle = setTimeout(() => {
      if (active === imp) endImport(imp);
    }, IMPORT_IDLE_MS);
  };
  const endImport = (imp: ActiveImport): void => {
    if (imp.idle !== undefined) clearTimeout(imp.idle);
    if (active === imp) active = undefined;
    imp.release();
  };
  const activeImport = (id: unknown): ActiveImport => {
    if (!active || active.id !== id) invalid('no such import (it ended, or was abandoned)');
    return active;
  };

  const importBegin = (): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      void queue(async () => {
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        try {
          const baseline = (await content.list()).length === 0;
          const imp: ActiveImport = {
            id: nextImport++,
            baseline,
            imported: 0,
            skipped: 0,
            idle: undefined,
            release,
          };
          active = imp;
          touch(imp);
          resolve(imp.id);
        } catch (error) {
          reject(error);
          return;
        }
        await held;
      });
    });

  const importChunk = async (
    id: unknown,
    files: unknown,
  ): Promise<{ imported: number; skipped: number }> => {
    const imp = activeImport(id);
    if (!Array.isArray(files)) invalid('files must be an array');
    touch(imp);
    const classifier = markdown.createRoleClassifier(config.roles);
    const now = storage.unixNow();
    let imported = 0;
    let skipped = 0;
    events.exec('BEGIN IMMEDIATE');
    try {
      for (const file of files as ImportFile[]) {
        const path = acceptedPath(file, classifier);
        if (path === null) {
          skipped++;
          continue;
        }
        const mtime =
          typeof file.mtime === 'number' && Number.isFinite(file.mtime) && file.mtime >= 0
            ? Math.min(Math.floor(file.mtime), now)
            : now;
        await content.write(path, file.text, { mtime });
        imported++;
      }
      events.exec('COMMIT');
    } catch (error) {
      if (events.inTransaction) events.exec('ROLLBACK');
      throw error;
    }
    imp.imported += imported;
    imp.skipped += skipped;
    touch(imp);
    return { imported, skipped };
  };

  const importEnd = async (
    id: unknown,
  ): Promise<{ imported: number; skipped: number; index: indexing.IndexSummary }> => {
    const imp = activeImport(id);
    if (imp.idle !== undefined) clearTimeout(imp.idle);
    try {
      // A brain with no notes before this import takes it as its baseline,
      // even if an index pass already ran over the empty brain.
      if (imp.baseline && imp.imported > 0) await stores.resetIndex();
      const index = await current.index();
      const summary = imp.baseline
        ? { ...index, warnings: index.warnings.filter((w) => !w.startsWith(EMPTY_INDEX_WARNING)) }
        : index;
      return { imported: imp.imported, skipped: imp.skipped, index: summary };
    } finally {
      endImport(imp);
    }
  };

  // --- Config and reset.
  const updateConfig = async (next: unknown): Promise<storage.BrainConfig> => {
    const parsed = storage.parseBrainConfig(next, 'the new config');
    await stores.meta.set(META_CONFIG, storage.serializeBrainConfig(parsed));
    config = parsed;
    current = engine.createEngine({ stores, content, config });
    // Rebuild the derived data from the content and the log: notes whose
    // role is now `excluded` (or none) are not listed, so they leave the
    // index, links into them are dropped, and role, half-life and analyzer
    // changes all take effect.
    await current.index({ rebuild: true });
    return config;
  };

  const reset = async (): Promise<storage.BrainConfig> => {
    stores.close();
    await provider.wipe();
    await openAll();
    return config;
  };

  return {
    storage: provider.storage,
    get config() {
      return config;
    },
    async handle(target, method, args) {
      if (target === 'engine') {
        if (!ENGINE_METHOD_SET.has(method)) invalid(`no such method: ${method}`);
        const fn = current[method as EngineMethod] as (...a: unknown[]) => Promise<unknown>;
        return queue(() => fn.apply(current, [...args]));
      }
      switch (method) {
        case 'importBegin':
          return importBegin();
        case 'importChunk':
          return importChunk(args[0], args[1]);
        case 'importEnd':
          return importEnd(args[0]);
        case 'importAbort':
          if (active && active.id === args[0]) endImport(active);
          return undefined;
        case 'config':
          return config;
        case 'storageKind':
          return provider.storage;
        case 'updateConfig':
          return queue(() => updateConfig(args[0]));
        case 'reset':
          return queue(() => reset());
        default:
          return invalid(`no such method: ${method}`);
      }
    },
    close() {
      if (active) endImport(active);
      stores.close();
    },
  };
}

/** The normalized path to store `file` at, or null to skip it. */
function acceptedPath(file: ImportFile, classifier: markdown.RoleClassifier): string | null {
  if (!file || typeof file !== 'object' || typeof file.text !== 'string') return null;
  if (typeof file.path !== 'string') return null;
  let path: string;
  try {
    path = engine.normalizeNotePath(file.path.replace(/^\/+/, ''));
  } catch {
    return null;
  }
  // Never store excluded content. Markdown with no role is kept: a later
  // config may give its folder one.
  if (classifier.classify(path)?.role === 'excluded') return null;
  return path;
}
