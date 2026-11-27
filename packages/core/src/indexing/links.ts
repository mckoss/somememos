// Link rules shared by the index pass and `import-git`, so both log the same
// items for the same text.
//
// - A link into excluded territory is dropped entirely, so it can never
//   become a dangling key that names a private note. "Into excluded
//   territory" means the target resolves to an excluded file, or names a path
//   (as written, or relative to the linking note) whose role is `excluded`.
// - A link or embed of an attachment (a target whose file extension is not
//   `.md`, such as `![[photo.png]]`) is ignored unless it resolves to a note:
//   no dangling item, no mention.
// - A note linking to itself links nothing.

import {
  createLinkResolver,
  danglingDisplay,
  resolutionItem,
  type LinkResolver,
} from '../markdown/resolve.js';
import {
  dirName,
  hasNonMarkdownExtension,
  isMarkdownPath,
  normalizePath,
} from '../markdown/paths.js';
import type { FolderRole } from '../markdown/roles.js';
import type { NoteLink } from '../storage/types.js';

/** A path's configured role (`excluded` included), or null/undefined for none. */
export type RoleOf = (path: string) => FolderRole | null | undefined;

/**
 * Recognizes links into excluded territory. Holds excluded paths in memory
 * only: they are never stored, logged or printed. The set may change (the git
 * import adds and removes paths as history goes); the resolver over it is
 * rebuilt lazily.
 */
export class ExcludedLinks {
  private readonly paths: Set<string>;
  private resolver: LinkResolver | null = null;
  private stale = true;

  constructor(
    private readonly roleOf: RoleOf,
    paths: Iterable<string> = [],
  ) {
    this.paths = new Set(paths);
  }

  /** The number of excluded paths known. */
  get size(): number {
    return this.paths.size;
  }

  add(path: string): void {
    if (!this.paths.has(path)) {
      this.paths.add(path);
      this.stale = true;
    }
  }

  delete(path: string): void {
    if (this.paths.delete(path)) this.stale = true;
  }

  /** True when `target`, linked from `source`, points into excluded territory. */
  has(target: string, source: string): boolean {
    if (this.stale) {
      this.resolver = this.paths.size > 0 ? createLinkResolver(this.paths) : null;
      this.stale = false;
    }
    if (this.resolver?.resolve(target, source).kind === 'resolved') return true;
    const candidates: (string | null)[] = [normalizePath(target)];
    if (!target.startsWith('/')) {
      const folder = dirName(source);
      candidates.push(normalizePath(folder === '' ? target : `${folder}/${target}`));
    }
    for (const c of candidates) {
      if (c === null) continue;
      if (this.roleOf(isMarkdownPath(c) ? c : `${c}.md`) === 'excluded') return true;
    }
    return false;
  }
}

/**
 * True when a target is ignored for link purposes because it names an
 * attachment that is not a note: it has a non-`.md` extension and `resolver`
 * leaves it dangling.
 */
export function isAttachmentLink(target: string, source: string, resolver: LinkResolver): boolean {
  return hasNonMarkdownExtension(target) && resolver.resolve(target, source).kind === 'dangling';
}

/**
 * Whether a link target counts as a link: not into excluded territory and not
 * an attachment. Self-links are dropped later, by `linkItemsOf`.
 */
export function countsAsLink(
  target: string,
  source: string,
  resolver: LinkResolver,
  excluded: ExcludedLinks,
): boolean {
  return !excluded.has(target, source) && !isAttachmentLink(target, source, resolver);
}

/**
 * The distinct link items of `targets` linked from `source`, in first-link
 * order, as stored links: self-links, links into excluded territory and
 * attachment links dropped. A dangling link carries its `display` form
 * (`markdown.danglingDisplay`) as first written in the note.
 */
export function linkItemsOf(
  targets: readonly string[],
  source: string,
  resolver: LinkResolver,
  excluded: ExcludedLinks,
): NoteLink[] {
  const out = new Map<string, NoteLink>();
  for (const target of targets) {
    if (excluded.has(target, source)) continue;
    const r = resolver.resolve(target, source);
    if (r.kind === 'resolved' && r.path === source) continue;
    if (r.kind === 'dangling' && hasNonMarkdownExtension(target)) continue;
    const item = resolutionItem(r);
    if (out.has(item)) continue;
    const display = r.kind === 'dangling' ? danglingDisplay(target) : '';
    out.set(
      item,
      display !== ''
        ? { target: item, dangling: true, display }
        : { target: item, dangling: r.kind === 'dangling' },
    );
  }
  return [...out.values()];
}
