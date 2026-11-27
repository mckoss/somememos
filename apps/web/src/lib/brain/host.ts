// The contract between the web UI and whatever runs the brain.
//
// Pages and components call `getBrainHost()` and use only the `BrainHost`
// interface. They never import the engine, the stores or a worker directly, so
// the implementation behind this file can change without touching the UI.
import type { engine, indexing } from '@somememos/core';

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
  /** The operation: an engine method (`saveNote`), or `importFiles`, `updateConfig`, `reset`. */
  readonly operation: string;
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
