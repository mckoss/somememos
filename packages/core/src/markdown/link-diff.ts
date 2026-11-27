// Which link targets an edit added: the source of `mention` events.

import type { WikiLink } from './links.js';
import { resolutionItem, type LinkResolver } from './resolve.js';

/** Distinct link items (resolved paths or dangling keys) of a note, in first-link order. */
export function linkItems(
  links: Iterable<Pick<WikiLink, 'target'>>,
  sourcePath: string,
  resolver: LinkResolver,
): string[] {
  const seen = new Set<string>();
  for (const link of links) {
    const resolution = resolver.resolve(link.target, sourcePath);
    // A note linking to itself does not mention anything new.
    if (resolution.kind === 'resolved' && resolution.path === sourcePath) continue;
    seen.add(resolutionItem(resolution));
  }
  return [...seen];
}

/**
 * The link items the new version of a note has and the old version lacks, in
 * the order they first appear in the new version. Each item appears once,
 * however often it is linked. Both versions are resolved with the same
 * resolver (the brain as it is now), so rewording a link to the same note
 * (`[[Foo]]` to `[[memos/foo|Foo]]`) adds nothing. Pass `[]` as `oldLinks` for
 * a new note. Embeds count as links.
 */
export function addedLinkItems(
  oldLinks: Iterable<Pick<WikiLink, 'target'>>,
  newLinks: Iterable<Pick<WikiLink, 'target'>>,
  sourcePath: string,
  resolver: LinkResolver,
): string[] {
  const before = new Set(linkItems(oldLinks, sourcePath, resolver));
  return linkItems(newLinks, sourcePath, resolver).filter((item) => !before.has(item));
}
