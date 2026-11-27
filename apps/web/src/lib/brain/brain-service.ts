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
import { SyncController, type SyncEventMessage } from './sync-controller.ts';
import { ZipWriter } from './zip.ts';

/** The event log's name inside an export archive, beside the notes. */
export const EXPORT_LOG_NAME = 'events.jsonl';

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

export interface BrainServiceOptions {
  /** The app's origin, where the server's `/api` is. Without it there is no sync. */
  readonly origin?: string;
  /** Receives sync status changes, to pass to the page. */
  readonly emit?: (event: SyncEventMessage) => void;
}

/** Engine calls after which the brain may have something new to sync. */
const CHANGE_METHODS: ReadonlySet<string> = new Set([
  'saveNote',
  'renameNote',
  'deleteNote',
  'commit',
  'importLog',
  'ensureDiary',
  'index',
]);

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

export async function openBrainService(
  provider: DatabaseProvider,
  options: BrainServiceOptions = {},
): Promise<BrainService> {
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
    // A config change interrupted before its re-index finished is finished now.
    await engine.reconcileConfig({ stores, content, config });
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

  // --- Export everything (PLAN.md section 2: the markdown plus the event log).
  // Every file in the content table, whatever its folder's role: notes in a
  // folder excluded after they were stored are still the person's files on
  // this device. (An import never stores excluded files, so those were never
  // here.) Notes are read one at a time into the zip's Blob, never joined
  // into one string; only the event log is built as one text, by the engine.
  const exportArchive = (): Promise<{ archive: Blob; notes: number; records: number }> =>
    queue(async () => {
      const zip = new ZipWriter();
      const entries = [...(await content.list())].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      let notes = 0;
      for (const entry of entries) {
        const text = await content.read(entry.path);
        if (text === undefined) continue;
        zip.add(entry.path, text, new Date(entry.mtime * 1000));
        notes++;
      }
      const log = await current.exportLog();
      zip.add(EXPORT_LOG_NAME, log);
      let records = 0;
      for (let i = log.indexOf('\n'); i >= 0; i = log.indexOf('\n', i + 1)) records++;
      return { archive: zip.finish(), notes, records };
    });

  // --- Config and reset.
  const updateConfig = async (next: unknown): Promise<storage.BrainConfig> => {
    const parsed = storage.parseBrainConfig(next, 'the new config');
    // Core's one way to change a config (engine.applyConfigChange): edits made
    // before are logged under the old roles, then the derived data is rebuilt
    // under the new ones, logging nothing. Notes whose role is now `excluded`
    // (or none) leave the index but stay in the content table; links into
    // them are dropped; role, half-life and analyzer changes take effect.
    await stores.meta.set(META_CONFIG, storage.serializeBrainConfig(parsed));
    await engine.applyConfigChange({ stores, content, from: config, to: parsed });
    config = parsed;
    current = engine.createEngine({ stores, content, config });
    return config;
  };

  const reset = async (): Promise<storage.BrainConfig> => {
    stores.close();
    await provider.wipe();
    await openAll();
    return config;
  };

  // --- Sync (./sync-controller.ts). The token and the sync record live in
  // the events database's meta, so a reset wipes them with everything else.
  const sync = new SyncController({
    engine: () => current,
    meta: () => stores.meta,
    content: () => content,
    config: () => config,
    queue,
    updateConfig: (next) => queue(() => updateConfig(next)),
    emit: (event) => options.emit?.(event),
    origin: options.origin ?? '',
    online: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
  });
  if (options.origin) await sync.start();

  const syncCall = (method: string, args: readonly unknown[]): Promise<unknown> => {
    if (!options.origin) invalid('sync is not available here');
    switch (method) {
      case 'syncProbe':
        return sync.probe();
      case 'syncListBrains':
        return sync.listBrains(args[0]);
      case 'syncPlan':
        return sync.plan(args[0] as Parameters<SyncController['plan']>[0]);
      case 'syncConnect':
        return sync.connect(args[0] as Parameters<SyncController['connect']>[0], args[1]);
      case 'syncDisconnect':
        return sync.disconnect();
      case 'syncSetToken':
        return sync.setToken(args[0]);
      case 'syncView':
        return sync.status();
      case 'syncNow':
        return sync.syncNow();
      case 'syncStartOver':
        return sync.startOver();
      case 'syncHint':
        sync.hint(args[0]);
        return Promise.resolve(undefined);
      case 'syncConflicts':
        return sync.conflicts();
      case 'syncResolve':
        return sync.resolve(args[0], args[1]);
      case 'syncNoteState':
        return sync.noteState(args[0], args[1]);
      case 'syncBlogSettings':
        return sync.blogSettings();
      case 'syncSaveBlogSettings':
        return sync.saveBlogSettings(args[0]);
      case 'syncCheckBlogSlug':
        return sync.checkBlogSlug(args[0]);
      case 'syncPostAddress':
        return sync.postAddress(args[0]);
      case 'syncConfigConflict':
        return Promise.resolve(sync.configConflictView());
      case 'syncResolveConfig':
        return sync.resolveConfigConflict(args[0]);
      default:
        return invalid(`no such method: ${method}`);
    }
  };

  /** Tells sync what an engine call did. */
  const afterEngineCall = (method: string, value: unknown): void => {
    if (!options.origin) return;
    if (method === 'readNote') {
      if ((value as { recorded?: unknown } | null)?.recorded === true) sync.noteChange('read');
      return;
    }
    if (!CHANGE_METHODS.has(method)) return;
    const status = (value as { status?: unknown; created?: unknown; committed?: unknown } | null)
      ?.status;
    if (method === 'saveNote' && status !== 'saved') return;
    if (method === 'ensureDiary' && (value as { created?: unknown }).created !== true) return;
    if (method === 'commit' && (value as { committed?: unknown }).committed !== true) return;
    sync.noteChange('change');
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
        const value = await queue(() => fn.apply(current, [...args]));
        afterEngineCall(method, value);
        return value;
      }
      if (method.startsWith('sync')) return syncCall(method, args);
      switch (method) {
        case 'importBegin':
          return importBegin();
        case 'importChunk':
          return importChunk(args[0], args[1]);
        case 'importEnd': {
          const result = await importEnd(args[0]);
          if (options.origin && result.imported > 0) sync.noteChange('change');
          return result;
        }
        case 'importAbort':
          if (active && active.id === args[0]) endImport(active);
          return undefined;
        case 'exportArchive':
          return exportArchive();
        case 'config':
          return config;
        case 'storageKind':
          return provider.storage;
        case 'updateConfig': {
          const next = await queue(() => updateConfig(args[0]));
          // A connected device sends the change to the server soon (the shared config).
          if (options.origin) sync.noteChange('change');
          return next;
        }
        case 'reset': {
          const next = await queue(() => reset());
          if (options.origin) await sync.reload();
          return next;
        }
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
