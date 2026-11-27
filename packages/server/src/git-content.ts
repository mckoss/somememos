// A `storage.ContentStore` over a brain repository's working tree: the
// brain's notes on the server. Git is the only copy of note text; the
// database holds the index, the event log and the version table
// (./brains.ts explains how the two stay consistent).
//
// Lists markdown files only, never `.git` or any dot folder, with size and
// nanosecond mtime as the fingerprint (as the CLI's file-system store does),
// so an unchanged file is never read. Refuses any path sync could not carry
// (`sync.syncPathProblem`), so nothing can be written inside `.git`.

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  utimesSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { sync, type storage } from '@somememos/core';

interface Stat {
  readonly size: number;
  readonly mtimeNs: bigint;
}

function statOf(full: string): Stat | undefined {
  let s;
  try {
    s = lstatSync(full, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
  return s.isFile() ? { size: Number(s.size), mtimeNs: s.mtimeNs } : undefined;
}

function entryOf(path: string, s: Stat): storage.ContentEntry {
  return {
    path,
    size: s.size,
    mtime: Number(s.mtimeNs / 1_000_000_000n),
    fingerprint: `${s.size}:${s.mtimeNs}`,
  };
}

/** The content store over `root`, a brain repository's working tree. */
export function createGitContentStore(root: string): storage.ContentStore {
  const inside = (path: string): string => {
    const problem = sync.syncPathProblem(path);
    if (problem !== null) throw new RangeError(`not a note path the server stores: ${problem}`);
    return join(root, ...path.split('/'));
  };

  /** Removes now-empty folders above a removed file, up to the root. */
  const prune = (full: string): void => {
    let dir = dirname(full);
    while (dir.length > root.length && dir.startsWith(root)) {
      try {
        rmdirSync(dir);
      } catch {
        return; // not empty (or gone)
      }
      dir = dirname(dir);
    }
  };

  const stat = (path: string): storage.ContentEntry | undefined => {
    const s = statOf(inside(path));
    return s ? entryOf(path, s) : undefined;
  };

  return {
    list() {
      const found: storage.ContentEntry[] = [];
      const visit = (dir: string, prefix: string): void => {
        let entries: Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue; // .git and every dot folder or file
          const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
          if (entry.isDirectory()) visit(join(dir, entry.name), rel);
          else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
            const s = statOf(join(dir, entry.name));
            if (s) found.push(entryOf(rel, s));
          }
        }
      };
      visit(root, '');
      return found;
    },
    stat,
    read(path) {
      try {
        return readFileSync(inside(path), 'utf8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return undefined;
        throw error;
      }
    },
    write(path, text, options) {
      if (typeof text !== 'string') throw new TypeError('text must be a string');
      const full = inside(path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text, 'utf8');
      if (options?.mtime !== undefined) utimesSync(full, options.mtime, options.mtime);
      const entry = stat(path);
      if (!entry) throw new Error('wrote a note but cannot stat it');
      return entry;
    },
    remove(path) {
      const full = inside(path);
      if (!statOf(full)) return false;
      rmSync(full);
      prune(full);
      return true;
    },
    rename(from, to) {
      const source = inside(from);
      const target = inside(to);
      if (!statOf(source)) throw new RangeError(`no such file: ${from}`);
      if (statOf(target)) throw new RangeError(`already exists: ${to}`);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(source, target);
      prune(source);
    },
  };
}
