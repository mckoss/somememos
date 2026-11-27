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

import type { storage } from '@somememos/core';

export const META_BASELINE = 'indexer.baseline';
export const META_FILES = 'indexer.files';
export const META_LINKS_PREFIX = 'indexer.links:';
export const META_FIRST_INDEXED = 'indexer.firstIndexedAt';
export const META_UNCOMMITTED = 'indexer.uncommitted';

type Meta = storage.MetaStore;

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
