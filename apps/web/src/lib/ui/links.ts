// `[[wiki link]]` helpers for the UI: what to insert when completing a link,
// and resolving targets with the same rules as the engine (core's resolver).

import { markdown, type engine } from '@somememos/core';

type NoteTitle = engine.NoteTitle;

function baseNameNoMd(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

/**
 * The text to put inside `[[…]]` for a note: its file name when no other note
 * shares it (case-insensitively), else its full path without `.md`.
 */
export function linkTextFor(path: string, titles: readonly Pick<NoteTitle, 'path'>[]): string {
  const name = baseNameNoMd(path);
  const folded = name.toLowerCase();
  const clashes = titles.filter((t) => baseNameNoMd(t.path).toLowerCase() === folded).length;
  return clashes > 1 ? path.replace(/\.md$/i, '') : name;
}

export interface LinkCompletion {
  readonly label: string;
  readonly detail: string;
  /** What goes between `[[` and `]]`. */
  readonly insert: string;
}

/**
 * Notes matching what has been typed after `[[`, best first: titles or file
 * names that start with it, then ones that contain it anywhere.
 */
export function linkCompletions(
  typed: string,
  titles: readonly NoteTitle[],
  limit = 30,
): LinkCompletion[] {
  const q = typed.trim().toLowerCase();
  const scored: { t: NoteTitle; score: number }[] = [];
  for (const t of titles) {
    const title = t.title.toLowerCase();
    const name = baseNameNoMd(t.path).toLowerCase();
    const path = t.path.toLowerCase();
    let score = -1;
    if (q === '') score = 0;
    else if (title.startsWith(q) || name.startsWith(q)) score = 3;
    else if (title.split(/\s+/).some((w) => w.startsWith(q))) score = 2;
    else if (title.includes(q) || path.includes(q)) score = 1;
    if (score >= 0) scored.push({ t, score });
  }
  // Memos first among equals: dated entries and sources are linked less often.
  const roleRank = (t: NoteTitle) =>
    (t.role as string) === 'memo' ? 0 : (t.role as string) === 'dated' ? 2 : 1;
  scored.sort(
    (a, b) =>
      b.score - a.score || roleRank(a.t) - roleRank(b.t) || a.t.title.localeCompare(b.t.title),
  );
  return scored.slice(0, limit).map(({ t }) => ({
    label: t.title,
    detail: t.path,
    insert: linkTextFor(t.path, titles),
  }));
}

/** The partial link target before the cursor, if the cursor is inside an open `[[`. */
export function openLinkBefore(
  lineTextBeforeCursor: string,
): { typed: string; from: number } | null {
  const m = /(?:^|[^\\])\[\[([^[\]|#\n]*)$/.exec(lineTextBeforeCursor);
  if (!m) return null;
  const typed = m[1] ?? '';
  return { typed, from: lineTextBeforeCursor.length - typed.length };
}

export type Resolved =
  | { readonly kind: 'note'; readonly path: string }
  | { readonly kind: 'missing'; readonly target: string };

/** Resolves link targets from one note, with the engine's rules. */
export function createResolver(
  paths: Iterable<string>,
  sourcePath: string,
): (target: string) => Resolved {
  const resolver = markdown.createLinkResolver(paths);
  return (target) => {
    const r = resolver.resolve(target, sourcePath);
    return r.kind === 'resolved' ? { kind: 'note', path: r.path } : { kind: 'missing', target };
  };
}
