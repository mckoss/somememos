// Small helpers for brain-relative paths ('/' separators, no leading '/').
// Written by hand because packages/core may not import Node's `path`.

/** The folder part of a path: `a/b/c.md` -> `a/b`, `c.md` -> ``. */
export function dirName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** The last segment of a path: `a/b/c.md` -> `c.md`. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

const MD_SUFFIX = /\.md$/i;

/** Drops a trailing `.md` (any case). */
export function stripMd(path: string): string {
  return path.replace(MD_SUFFIX, '');
}

/** True when the path ends in `.md` (any case). */
export function isMarkdownPath(path: string): boolean {
  return MD_SUFFIX.test(path);
}

/**
 * Joins and normalizes path segments: drops empty and `.` segments and applies
 * `..`. Returns null if a `..` would climb above the brain root.
 */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join('/');
}
