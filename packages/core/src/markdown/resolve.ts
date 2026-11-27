// Resolves a wiki-link target to a note path, or to a dangling key.

import { baseName, dirName, normalizePath, stripMd } from './paths.js';

export type LinkResolution =
  | {
      kind: 'resolved';
      /** The note path the link points to. */
      path: string;
      /** Which rule matched: exact brain path, path relative to the source, or base name. */
      rule: 'exact' | 'relative' | 'name';
      /** True when several notes matched by name and one was picked. */
      ambiguous: boolean;
      /** Every note that matched by name, sorted, when ambiguous. */
      candidates?: string[];
    }
  | {
      kind: 'dangling';
      /** The normalized target text that keys the dangling item. */
      key: string;
    };

export interface LinkResolver {
  /** Resolves `target` (as written in a link, without heading or alias) from `sourcePath`. */
  resolve(target: string, sourcePath: string): LinkResolution;
}

/** Case- and Unicode-normalization-insensitive form used for name matching. */
function fold(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

/**
 * The key of a dangling link: trimmed, any `.md` suffix dropped, Unicode NFC,
 * lower-cased, and inner whitespace runs collapsed to one space.
 */
export function normalizeDanglingKey(target: string): string {
  return fold(stripMd(target.trim()).trim()).replace(/\s+/g, ' ');
}

/** The item a resolution refers to: the resolved path, or the dangling key. */
export function resolutionItem(resolution: LinkResolution): string {
  return resolution.kind === 'resolved' ? resolution.path : resolution.key;
}

function byLengthThenName(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Builds a resolver for a brain's note paths (brain-relative, `/` separators).
 * Lookups use precomputed maps, so each `resolve` costs little more than a few
 * map reads. Rules, in order:
 *
 * 1. `exact`: the target is a brain-relative path, with or without `.md`. A
 *    leading `/` is allowed.
 * 2. `relative`: the target is relative to the source note's folder (`./` and
 *    `../` allowed; climbing above the brain root never matches).
 * 3. `name`: the target's last segment matches a note's file name without
 *    `.md`, ignoring case. A target with folders must also match the end of the
 *    note's path on a segment boundary. With several matches, prefer the source
 *    note's folder, then the shortest path, then alphabetical order, and flag
 *    the result as ambiguous.
 *
 * Anything else is dangling, keyed by `normalizeDanglingKey`.
 */
export function createLinkResolver(paths: Iterable<string>): LinkResolver {
  const exact = new Map<string, string>(); // NFC path -> path
  const byName = new Map<string, string[]>(); // folded base name without .md -> paths
  for (const path of paths) {
    exact.set(path.normalize('NFC'), path);
    const key = fold(stripMd(baseName(path)));
    const list = byName.get(key);
    if (list) list.push(path);
    else byName.set(key, [path]);
  }
  for (const list of byName.values()) list.sort(byLengthThenName);

  const lookup = (candidate: string): string | undefined => {
    const nfc = candidate.normalize('NFC');
    return exact.get(nfc) ?? exact.get(`${nfc}.md`);
  };

  return {
    resolve(rawTarget: string, sourcePath: string): LinkResolution {
      const target = rawTarget.trim();
      const normalized = target === '' ? null : normalizePath(target);

      if (normalized) {
        const hit = lookup(normalized);
        if (hit !== undefined)
          return { kind: 'resolved', path: hit, rule: 'exact', ambiguous: false };
      }

      if (target !== '' && !target.startsWith('/')) {
        const folder = dirName(sourcePath);
        const relative = normalizePath(folder === '' ? target : `${folder}/${target}`);
        if (relative) {
          const hit = lookup(relative);
          if (hit !== undefined) {
            return { kind: 'resolved', path: hit, rule: 'relative', ambiguous: false };
          }
        }
      }

      if (normalized) {
        const wanted = fold(stripMd(normalized));
        let candidates = byName.get(fold(stripMd(baseName(normalized)))) ?? [];
        if (wanted.includes('/')) {
          candidates = candidates.filter((p) => {
            const f = fold(stripMd(p));
            return f === wanted || f.endsWith(`/${wanted}`);
          });
        }
        if (candidates.length === 1) {
          return {
            kind: 'resolved',
            path: candidates[0] as string,
            rule: 'name',
            ambiguous: false,
          };
        }
        if (candidates.length > 1) {
          const folder = dirName(sourcePath);
          const local = candidates.filter((p) => dirName(p) === folder);
          const path = (local[0] ?? candidates[0]) as string;
          return {
            kind: 'resolved',
            path,
            rule: 'name',
            ambiguous: true,
            candidates: [...candidates].sort(),
          };
        }
      }

      return { kind: 'dangling', key: normalizeDanglingKey(target) };
    },
  };
}

/** Resolves one link. Builds a resolver each call: use `createLinkResolver` for many links. */
export function resolveLink(
  target: string,
  sourcePath: string,
  paths: Iterable<string>,
): LinkResolution {
  return createLinkResolver(paths).resolve(target, sourcePath);
}
