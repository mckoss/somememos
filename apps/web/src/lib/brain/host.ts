// The contract between the web UI and whatever runs the brain.
//
// Pages and components call `getBrainHost()` and use only the `BrainHost`
// interface. They never import the engine, the stores or a worker directly, so
// the implementation behind this file can change without touching the UI.
import type { engine, indexing } from '@somememos/core';
import type {
  BlogSettingsInput,
  BlogSettingsView,
  BlogSlugCheck,
  ConfigConflictView,
  ConflictChoice,
  ConnectPlan,
  ConnectRequest,
  NoteSyncState,
  RemoteBrain,
  ServerAvailability,
  SyncConflictView,
  SyncView,
} from '../sync/types.ts';

export type * from '../sync/types.ts';

/** One file to bring into the brain, with a brain-relative path. */
export interface ImportFile {
  readonly path: string;
  readonly text: string;
  /** Unix seconds. Defaults to now. */
  readonly mtime?: number;
}

/** How far an import has got, for a progress bar. */
export interface ImportProgress {
  /** 'writing' while files are stored, 'indexing' once they all are, 'done' at the end. */
  readonly phase: 'writing' | 'indexing' | 'done';
  /** Files looked at so far (imported + skipped). */
  readonly done: number;
  /** Files in the import, or null when they come from an iterable of unknown length. */
  readonly total: number | null;
  readonly imported: number;
  readonly skipped: number;
}

export interface ImportOptions {
  /** Called as the import moves along (after each chunk, and once per phase). */
  readonly onProgress?: (progress: ImportProgress) => void;
}

export interface ImportResult {
  /** Markdown files written to the brain. */
  readonly imported: number;
  /** Files left out: not markdown, in an excluded folder, or unreadable. */
  readonly skipped: number;
  readonly index: indexing.IndexSummary;
}

/** Where the brain's data lives on this device, and how safe it is. */
export interface StorageInfo {
  /** 'memory' is lost on reload; 'device' survives it. */
  readonly kind: 'memory' | 'device';
  /** True once the browser has promised not to evict the data. */
  readonly persisted: boolean;
  /** Bytes used and available to the app, when the browser reports them. */
  readonly usage?: number;
  readonly quota?: number;
  /** Why the data is only in memory (`kind: 'memory'`), in words for the person. */
  readonly reason?: string;
  /**
   * Which tab runs the brain. Only one tab at a time can open the data on
   * the device; the others forward their requests to it ('other-tab').
   */
  readonly runsIn: 'this-tab' | 'other-tab';
}

/** Something changed the brain, in this tab or another one. */
export interface BrainChange {
  readonly source: 'this-tab' | 'other-tab';
  /**
   * The operation: an engine method (`saveNote`), or `importFiles`,
   * `updateConfig`, `reset`; `sync` when a sync brought or sent changes, and
   * `syncStatus` when only the sync status changed (nothing to re-read).
   */
  readonly operation: string;
  /** For `sync` and `syncStatus`: the new sync status. */
  readonly sync?: SyncView;
}

/**
 * Sync with the server the app was loaded from (PLAN.md section 7). It runs
 * in the brain's worker, in the tab that owns the brain; every tab sees its
 * status through `subscribe` (`BrainChange.sync`). The access token is passed
 * in only to the calls that take one and is kept on the device, in the
 * brain's own storage; nothing here ever returns it.
 */
export interface SyncHost {
  /** Whether this origin's server offers sync (`GET /api/health`). Needs no token. */
  probe(): Promise<ServerAvailability>;
  /** The brains a token can see. The token is used for this call only. */
  listBrains(token: string): Promise<RemoteBrain[]>;
  /** What connecting would do, before anything changes. */
  plan(request: ConnectRequest): Promise<ConnectPlan>;
  /**
   * Connects: creates the brain if asked, takes the server's folder roles
   * when they differ, stores the token, and starts the first sync (it runs on
   * in the background; watch `status`). A plan that `needsConfirmation` is
   * refused unless `confirmed`.
   */
  connect(request: ConnectRequest, confirmed?: boolean): Promise<SyncView>;
  /** Forgets the token. Notes, activity and the sync record stay. */
  disconnect(): Promise<SyncView>;
  /** Replaces a token the server stopped accepting (checked with the server first). */
  setToken(token: string): Promise<SyncView>;
  status(): Promise<SyncView>;
  /** Syncs now, even while automatic sync is stopped; resolves when it is done. */
  syncNow(): Promise<SyncView>;
  /** After the server turned out to be behind this device: compare everything afresh. */
  startOver(): Promise<SyncView>;
  /** Tells sync that the browser came back online, or the app became visible after a while. */
  hint(kind: 'online' | 'visible'): Promise<void>;
  /** Conflict copies, each with the server's version beside it. */
  conflicts(): Promise<SyncConflictView[]>;
  /** Keeps this device's text, the server's, or both; removes the conflict copy. */
  resolveConflict(path: string, choice: ConflictChoice): Promise<{ kept: string | null }>;
  /** Whether the server has this version (`hash`) of the note at `path`. */
  noteState(path: string, hash: string): Promise<NoteSyncState>;
  /**
   * The shared config (folder roles and the other brain settings) changed
   * here and on another device: both sides, or null when there is no such
   * conflict. Sync stays stopped until `resolveConfigConflict`.
   */
  configConflict(): Promise<ConfigConflictView | null>;
  /** Keeps this device's settings (they replace the server's) or the server's (they replace this device's), then syncs. */
  resolveConfigConflict(choice: 'mine' | 'theirs'): Promise<SyncView>;
  /** The brain's public blog settings on the server (connected only). */
  blogSettings(): Promise<BlogSettingsView>;
  /** Saves them; a public name another blog has is refused with a plain message. */
  saveBlogSettings(settings: BlogSettingsInput): Promise<BlogSettingsView>;
  /** Whether a public name could be used, for live validation. */
  checkBlogSlug(slug: string): Promise<BlogSlugCheck>;
  /** The full public address of a post at `path` when the blog is on; null otherwise or offline. */
  postAddress(path: string): Promise<string | null>;
}

export interface BrainHost {
  /** Every brain operation: search, lists, read, save, log, status. */
  readonly engine: engine.Engine;
  /** Bring files into the brain, then index them. The first import of an
   *  empty brain is its baseline and logs no events. Files are sent to the
   *  worker in chunks, so an async iterable that reads them lazily keeps
   *  memory flat. Non-markdown files, invalid paths and paths the config
   *  excludes are skipped and never stored. */
  importFiles(
    files: readonly ImportFile[] | Iterable<ImportFile> | AsyncIterable<ImportFile>,
    options?: ImportOptions,
  ): Promise<ImportResult>;
  /** Replace the brain's folder roles (and other config), then re-index.
   *  Validated first (a `ConfigError` names every problem). */
  updateConfig(config: engine.Engine['config']): Promise<void>;
  storageInfo(): Promise<StorageInfo>;
  /** Ask the browser to keep the data. Returns whether it agreed. */
  requestPersistence(): Promise<boolean>;
  /** Delete all local data for this brain. */
  reset(): Promise<void>;
  /**
   * Calls `listener` after each operation that may have changed the brain,
   * in this tab or another. Returns a function that stops the calls.
   */
  subscribe(listener: (change: BrainChange) => void): () => void;
  /** Sync with the server. */
  readonly sync: SyncHost;
}

let host: Promise<BrainHost> | undefined;

/** The brain for this browser tab. Safe to call from anywhere in the UI;
 *  resolves once the brain is open. Only call it in the browser. */
export function getBrainHost(): Promise<BrainHost> {
  host ??= import('./open.ts').then((m) => m.openBrainHost());
  // A failed open may be retried.
  host.catch(() => {
    host = undefined;
  });
  return host;
}
