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
}

export interface BrainHost {
  /** Every brain operation: search, lists, read, save, log, status. */
  readonly engine: engine.Engine;
  /** Bring files into the brain, then index them. The first import of an
   *  empty brain is its baseline and logs no events. */
  importFiles(files: readonly ImportFile[]): Promise<ImportResult>;
  /** Replace the brain's folder roles (and other config), then re-index. */
  updateConfig(config: engine.Engine['config']): Promise<void>;
  storageInfo(): Promise<StorageInfo>;
  /** Ask the browser to keep the data. Returns whether it agreed. */
  requestPersistence(): Promise<boolean>;
  /** Delete all local data for this brain. */
  reset(): Promise<void>;
}

let host: Promise<BrainHost> | undefined;

/** The brain for this browser tab. Safe to call from anywhere in the UI;
 *  resolves once the brain is open. Only call it in the browser. */
export function getBrainHost(): Promise<BrainHost> {
  host ??= import('./open.ts').then((m) => m.openBrainHost());
  return host;
}
