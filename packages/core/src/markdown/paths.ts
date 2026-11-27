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

const FILE_EXTENSION = /\.([A-Za-z0-9]{1,10})$/;

/**
 * True when the last segment of a link target ends in a file extension other
 * than `.md` (`photo.png`, `scan.PDF`, `diagram.excalidraw`): a link or embed
 * of an attachment, not of a note. An extension needs at least one letter, so
 * `v1.2` is not one. The indexer ignores such a target unless it resolves to
 * an existing note (`[[node.js]]` with a note `node.js.md`).
 */
export function hasNonMarkdownExtension(target: string): boolean {
  const last = baseName(target.trim());
  const m = FILE_EXTENSION.exec(last);
  if (!m || m.index === 0) return false;
  const ext = (m[1] as string).toLowerCase();
  return ext !== 'md' && /[a-z]/.test(ext);
}
