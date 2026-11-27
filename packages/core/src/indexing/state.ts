// What the indexer remembers between passes, beyond the notes table.
//
// Derived (index meta, deleted by `resetIndex` and rebuilt by the next pass):
// - `indexer.baseline`: set by the first pass over an empty index. Its absence
//   means the next pass is a baseline pass, which logs no events.
// - `indexer.files`: every indexed file's stat fingerprint (size and
//   nanosecond mtime), so an unchanged file is never read.
// - `indexer.links:<path>`: the note's distinct raw link targets, so links can
//   be re-resolved (and diffed) without reading the file again.
//
// Durable (meta beside the event log, never deleted):
// - `indexer.firstIndexedAt`: when the brain was first indexed (Unix seconds).
//   `import-git` stops there.
// - `indexer.uncommitted`: paths the index pass saw change that no change
//   record covers yet. `commit` writes a change record for them and clears them.
// - `indexer.pendingRemote`: notes sync is about to write (path → the content
//   hash it writes, or null for a remove), recorded before the first write.
//   The pass that follows treats a note whose hash equals its pending hash as
//   a change from elsewhere and logs nothing for it, even if the copy crashed
//   before the no-logging pass sync runs (`record: false`). Every pass that
//   indexes clears what it found here.

import type { MetaStore } from '../storage/types.js';

export const META_BASELINE = 'indexer.baseline';
export const META_FILES = 'indexer.files';
export const META_LINKS_PREFIX = 'indexer.links:';
export const META_FIRST_INDEXED = 'indexer.firstIndexedAt';
export const META_UNCOMMITTED = 'indexer.uncommitted';
export const META_PENDING_REMOTE = 'indexer.pendingRemote';

type Meta = MetaStore;

function parseJson<T>(text: string | undefined, fallback: T): T {
  if (text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Path → stat fingerprint of every file indexed by the last pass. */
export async function readFingerprints(indexMeta: Meta): Promise<Record<string, string>> {
  return parseJson<Record<string, string>>(await indexMeta.get(META_FILES), {});
}

export async function writeFingerprints(
  indexMeta: Meta,
  fingerprints: Readonly<Record<string, string>>,
): Promise<void> {
  await indexMeta.set(META_FILES, JSON.stringify(fingerprints));
}

/** A note's raw link targets as last indexed; `[]` when none are recorded. */
export async function readLinkTargets(indexMeta: Meta, path: string): Promise<string[]> {
  return parseJson<string[]>(await indexMeta.get(META_LINKS_PREFIX + path), []);
}

export async function writeLinkTargets(
  indexMeta: Meta,
  path: string,
  targets: readonly string[],
): Promise<void> {
  if (targets.length === 0) await indexMeta.delete(META_LINKS_PREFIX + path);
  else await indexMeta.set(META_LINKS_PREFIX + path, JSON.stringify(targets));
}

export async function deleteLinkTargets(indexMeta: Meta, path: string): Promise<void> {
  await indexMeta.delete(META_LINKS_PREFIX + path);
}

/** When the brain was first indexed (Unix seconds), or null if never. */
export async function firstIndexedAt(meta: Meta): Promise<number | null> {
  const value = await meta.get(META_FIRST_INDEXED);
  return value === undefined ? null : Number(value);
}

/**
 * Paths changed since the last change record (sorted). Written only by the
 * index pass and `commit`, both while holding the index write lock.
 */
export async function readUncommitted(meta: Meta): Promise<string[]> {
  return parseJson<string[]>(await meta.get(META_UNCOMMITTED), []);
}

export async function writeUncommitted(meta: Meta, paths: Iterable<string>): Promise<void> {
  const sorted = [...new Set(paths)].sort();
  if (sorted.length === 0) await meta.delete(META_UNCOMMITTED);
  else await meta.set(META_UNCOMMITTED, JSON.stringify(sorted));
}

/** Notes sync is writing: path → the hash written, or null for a remove. */
export type PendingRemote = Record<string, string | null>;

/** The notes sync recorded as being written from elsewhere (see the top of this file). */
export async function readPendingRemote(meta: Meta): Promise<PendingRemote> {
  const value = parseJson<unknown>(await meta.get(META_PENDING_REMOTE), {});
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: PendingRemote = {};
  for (const [path, hash] of Object.entries(value as Record<string, unknown>)) {
    if (typeof hash === 'string' || hash === null) out[path] = hash;
  }
  return out;
}

/**
 * Records, durably and before writing, that sync is about to write these
 * notes from elsewhere. A later entry for the same path replaces the earlier.
 */
export async function addPendingRemote(meta: Meta, entries: PendingRemote): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  await meta.set(
    META_PENDING_REMOTE,
    JSON.stringify({ ...(await readPendingRemote(meta)), ...entries }),
  );
}

/** Forgets the pending entries in `seen` (those still holding the same value). */
export async function clearPendingRemote(meta: Meta, seen: PendingRemote): Promise<void> {
  const current = await readPendingRemote(meta);
  for (const [path, hash] of Object.entries(seen)) {
    if (current[path] === hash) delete current[path];
  }
  if (Object.keys(current).length === 0) await meta.delete(META_PENDING_REMOTE);
  else await meta.set(META_PENDING_REMOTE, JSON.stringify(current));
}
