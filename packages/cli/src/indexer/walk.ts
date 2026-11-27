// Walking a brain's working tree for markdown files (IMPLEMENTATION.md task 1.7).
//
// Only `stat` is called here; content is read later, and only for files whose
// size or modification time differ from what the last pass recorded.

import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { markdown } from '@somememos/core';
import type { storage } from '@somememos/core';

/** Directories never walked: the sidecar, version control, dependencies, and any dot folder. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set(['.somememos', '.git', 'node_modules']);

/** A markdown file found by the walk, with the stat fields change detection needs. */
export interface WalkedFile {
  /** Brain-relative, `/` separators. */
  readonly path: string;
  readonly role: storage.NoteRole;
  /** For a `dated` file, its date (`YYYY-MM-DD`); otherwise null. */
  readonly date: string | null;
  readonly size: number;
  /** Modification time in nanoseconds, as a decimal string (exact, for change detection). */
  readonly mtimeNs: string;
  /** Modification time in whole Unix seconds (what notes and events record). */
  readonly mtime: number;
}

export interface WalkResult {
  /** Indexable files (role memo, dated or source), by path, in sorted path order. */
  readonly files: ReadonlyMap<string, WalkedFile>;
  /**
   * Paths of `excluded` files. Kept in memory only, so links to them can be
   * dropped; never stored, logged or printed.
   */
  readonly excluded: ReadonlySet<string>;
}

/** The stat fingerprint the indexer compares: size and nanosecond mtime. */
export function fingerprint(file: Pick<WalkedFile, 'size' | 'mtimeNs'>): string {
  return `${file.size}:${file.mtimeNs}`;
}

/**
 * Lists the brain's markdown files and classifies each with `classifier`.
 * Skips `SKIPPED_DIRS`, every directory whose name starts with `.`, and
 * symbolic links. Files whose role is `excluded` go to `excluded`; files with
 * no role (roles are declared and none matched) are ignored.
 */
export function walkBrain(root: string, classifier: markdown.RoleClassifier): WalkResult {
  const found: WalkedFile[] = [];
  const excluded = new Set<string>();

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
      const match = classifier.classify(rel);
      if (!match) continue;
      if (match.role === 'excluded') {
        excluded.add(rel);
        continue;
      }
      let stat;
      try {
        stat = lstatSync(join(dir, name), { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // deleted meanwhile
        throw error;
      }
      found.push({
        path: rel,
        role: match.role,
        date: match.date ?? null,
        size: Number(stat.size),
        mtimeNs: stat.mtimeNs.toString(),
        mtime: Number(stat.mtimeNs / 1_000_000_000n),
      });
    }
  };

  visit(root, '');
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: new Map(found.map((f) => [f.path, f])), excluded };
}
