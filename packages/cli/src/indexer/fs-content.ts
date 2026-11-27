// A `storage.ContentStore` over a brain's directory: what feeds core's index
// pass and engine in the CLI. Lists markdown files only (./walk.ts), with
// size and nanosecond mtime as the fingerprint, so an unchanged file is never
// read.

import { mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { markdown, type storage } from '@somememos/core';
import { type WalkedFile, fingerprint, statFile, walkMarkdown } from './walk.js';

function toEntry(file: WalkedFile): storage.ContentEntry {
  return { path: file.path, size: file.size, mtime: file.mtime, fingerprint: fingerprint(file) };
}

/** The absolute path of a brain-relative path; throws for one that leaves the brain. */
function inside(root: string, path: string): string {
  const normalized = markdown.normalizePath(path);
  if (normalized === null || normalized === '' || normalized !== path || path.startsWith('/')) {
    throw new RangeError(`not a normalized brain-relative path: ${path}`);
  }
  return join(root, ...normalized.split('/'));
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR';
}

/** A content store over the files under `root`. Writes create folders as needed. */
export function createFsContentStore(root: string): storage.ContentStore {
  const stat = (path: string): storage.ContentEntry | undefined => {
    const file = statFile(inside(root, path), path);
    return file ? toEntry(file) : undefined;
  };
  return {
    list: () => walkMarkdown(root).map(toEntry),
    stat,
    read(path) {
      try {
        return readFileSync(inside(root, path), 'utf8');
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    write(path, text, options) {
      const full = inside(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text, 'utf8');
      if (options?.mtime !== undefined) utimesSync(full, options.mtime, options.mtime);
      const entry = stat(path);
      if (!entry) throw new Error(`wrote ${path} but cannot stat it`);
      return entry;
    },
    remove(path) {
      const full = inside(root, path);
      if (!statFile(full, path)) return false;
      rmSync(full);
      return true;
    },
    rename(from, to) {
      const source = inside(root, from);
      const target = inside(root, to);
      if (!statFile(source, from)) throw new RangeError(`no such file: ${from}`);
      if (statFile(target, to)) throw new RangeError(`already exists: ${to}`);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(source, target);
    },
  };
}
