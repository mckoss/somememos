// Walking a brain's working tree for markdown files (IMPLEMENTATION.md task 1.7).
//
// Only `stat` is called here; content is read later, and only for files whose
// size or modification time differ from what the last pass recorded.

import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/** Directories never walked: the sidecar, version control, dependencies, and any dot folder. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set(['.somememos', '.git', 'node_modules']);

/** A markdown file found by the walk, with the stat fields change detection needs. */
export interface WalkedFile {
  /** Brain-relative, `/` separators. */
  readonly path: string;
  readonly size: number;
  /** Modification time in nanoseconds, as a decimal string (exact, for change detection). */
  readonly mtimeNs: string;
  /** Modification time in whole Unix seconds (what notes and events record). */
  readonly mtime: number;
}

/** The fingerprint the indexer compares for a file: size and nanosecond mtime. */
export function fingerprint(file: Pick<WalkedFile, 'size' | 'mtimeNs'>): string {
  return `${file.size}:${file.mtimeNs}`;
}

/**
 * Lists every markdown file (`*.md`, any case) under `root`, sorted by path.
 * Skips `SKIPPED_DIRS`, every directory whose name starts with `.`, and
 * symbolic links. Roles are not applied here: the indexer classifies each
 * path, keeps excluded ones in memory only, and ignores role-less ones.
 */
export function walkMarkdown(root: string): WalkedFile[] {
  const found: WalkedFile[] = [];

  const visit = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // A folder removed while we walk, or one we may not read: skip it.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') return;
      throw error;
    }
    for (const entry of entries) {
      const name = entry.name;
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(name) || name.startsWith('.')) continue;
        visit(join(dir, name), rel);
        continue;
      }
      if (!entry.isFile() || !name.toLowerCase().endsWith('.md')) continue;
      const file = statFile(join(dir, name), rel);
      if (file) found.push(file);
    }
  };

  visit(root, '');
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return found;
}

/** Stats one regular file (not a symbolic link); undefined if it is missing or not a file. */
export function statFile(full: string, path: string): WalkedFile | undefined {
  let stat;
  try {
    stat = lstatSync(full, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined; // deleted meanwhile
    throw error;
  }
  if (!stat.isFile()) return undefined;
  return {
    path,
    size: Number(stat.size),
    mtimeNs: stat.mtimeNs.toString(),
    mtime: Number(stat.mtimeNs / 1_000_000_000n),
  };
}
