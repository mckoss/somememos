// Where note text lives (PLAN.md section 6, "Web app"; IMPLEMENTATION.md
// task 2.0). The derived stores hold the index; a `ContentStore` holds the
// markdown itself, by brain-relative path. The CLI implements it over the file
// system (packages/cli/src/indexer/fs-content.ts), the browser over a table
// (`@somememos/sqlite-store`'s `SqliteContentStore`) or its private file
// storage, and `createMemoryContentStore` below is the reference for tests.
//
// Content hashes are SHA-256 of the UTF-8 text, in hex, computed with Web
// Crypto (`crypto.subtle`, a global in Node 22 and every browser), so this
// module stays isomorphic.

import type { Awaitable } from './types.js';

/** One stored file, as `ContentStore.list` and `stat` describe it. */
export interface ContentEntry {
  /** Brain-relative, `/` separators, no leading `/`. */
  readonly path: string;
  /** Size in bytes (of the UTF-8 text). */
  readonly size: number;
  /** Modification time, whole Unix seconds. */
  readonly mtime: number;
  /**
   * `contentHash(text)`, when the store knows it without reading the file (a
   * table that stores it). The indexer then trusts it instead of hashing.
   */
  readonly hash?: string;
  /**
   * An opaque token that changes whenever the content may have changed. The
   * indexer skips reading a file whose fingerprint equals the last pass's.
   * Default `${size}:${mtime}:${hash ?? ''}` (see `contentFingerprint`). The
   * file system store uses size and nanosecond mtime.
   */
  readonly fingerprint?: string;
}

export interface ContentWriteOptions {
  /** The modification time to record, whole Unix seconds. Default: the store's clock. */
  readonly mtime?: number;
}

/**
 * Note text by brain-relative path. Every method may return a promise; callers
 * always `await`. Paths are compared exactly (no case folding).
 */
export interface ContentStore {
  /**
   * Every stored file, in any order. A store may hold files that are not
   * markdown (attachments); the indexer ignores paths that don't end in `.md`.
   */
  list(): Awaitable<ContentEntry[]>;
  /** One file's entry, or undefined when there is none. */
  stat(path: string): Awaitable<ContentEntry | undefined>;
  /** The file's text, or undefined when there is none. */
  read(path: string): Awaitable<string | undefined>;
  /** Creates or replaces the file (creating folders as needed). Returns its new entry. */
  write(path: string, text: string, options?: ContentWriteOptions): Awaitable<ContentEntry>;
  /** Deletes the file. Returns false when there was none. */
  remove(path: string): Awaitable<boolean>;
  /**
   * Moves the file, keeping its text and mtime. Throws a RangeError when
   * `from` does not exist or `to` already does.
   */
  rename(from: string, to: string): Awaitable<void>;
}

const encoder = new TextEncoder();

/** The UTF-8 byte length of `text`. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** SHA-256 of a string (as UTF-8) or of bytes, lower-case hex. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** A note's content hash: SHA-256 of its UTF-8 text, hex. */
export function contentHash(text: string): Promise<string> {
  return sha256Hex(text);
}

/** The fingerprint the indexer compares for an entry (see `ContentEntry.fingerprint`). */
export function contentFingerprint(entry: ContentEntry): string {
  return entry.fingerprint ?? `${entry.size}:${entry.mtime}:${entry.hash ?? ''}`;
}

// ---------------------------------------------------------------------------
// In memory

interface MemoryFile {
  text: string;
  size: number;
  mtime: number;
  hash: string;
}

/** The memory content store, plus a synchronous view of its files for tests. */
export interface MemoryContentStore extends ContentStore {
  /** Path to text, sorted by path. */
  snapshot(): Record<string, string>;
}

export interface MemoryContentStoreOptions {
  /** The clock for writes without an mtime, whole Unix seconds. Default: the system clock. */
  readonly now?: () => number;
}

/**
 * An in-memory `ContentStore`. Seed it with `await store.write(...)`. Entries
 * carry their hash, so the indexer never re-hashes an unchanged file.
 */
export function createMemoryContentStore(
  options: MemoryContentStoreOptions = {},
): MemoryContentStore {
  const files = new Map<string, MemoryFile>();
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));
  const entry = (path: string, f: MemoryFile): ContentEntry => ({
    path,
    size: f.size,
    mtime: f.mtime,
    hash: f.hash,
  });
  return {
    list: () => [...files].map(([path, f]) => entry(path, f)),
    stat(path) {
      const f = files.get(path);
      return f ? entry(path, f) : undefined;
    },
    read: (path) => files.get(path)?.text,
    async write(path, text, writeOptions) {
      if (typeof path !== 'string' || path === '') throw new RangeError('path must be non-empty');
      const f: MemoryFile = {
        text,
        size: utf8Length(text),
        mtime: writeOptions?.mtime ?? clock(),
        hash: await contentHash(text),
      };
      files.set(path, f);
      return entry(path, f);
    },
    remove: (path) => files.delete(path),
    rename(from, to) {
      const f = files.get(from);
      if (!f) throw new RangeError(`no such file: ${from}`);
      if (files.has(to)) throw new RangeError(`already exists: ${to}`);
      files.delete(from);
      files.set(to, f);
    },
    snapshot() {
      const out: Record<string, string> = {};
      for (const path of [...files.keys()].sort()) out[path] = (files.get(path) as MemoryFile).text;
      return out;
    },
  };
}
