// Plain-text snippets around the best query match in a section body.
//
// 1. Light markdown cleanup: link and image syntax keep only their text,
//    wiki-links keep their alias (or target), heading / quote / list / task
//    markers, code fences, emphasis markers (`*`, `**`, `__`, `~~`, backticks)
//    and HTML tags are removed. Single `_` is kept, so snake_case survives.
// 2. Whitespace is collapsed to single spaces.
// 3. The window is the run of query-term matches, at most `targetLength`
//    characters long, with the most distinct matched terms (then the most
//    matches; the earliest wins ties). Context is added evenly on both sides
//    to reach about `targetLength`, then both ends move inward to word
//    boundaries. `…` marks a cut at either end.
// 4. With no match, the snippet is the start of the text.
//
// Highlights are UTF-16 offsets of matched tokens within the returned text.

import { type AnalyzerOptions, analyze } from './analyze.js';
import { type ParsedQuery, parseQuery } from './query.js';

export interface SnippetOptions {
  /** Target snippet length in characters, excluding ellipses. Default 160. */
  readonly targetLength?: number;
  /** Analyzer settings; must match the index's. Default: stemming on. */
  readonly analyzer?: Partial<AnalyzerOptions>;
}

export interface Snippet {
  readonly text: string;
  /** `[start, end)` offsets of matched tokens within `text`. */
  readonly highlights: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

export const DEFAULT_SNIPPET_LENGTH = 160;
const ELLIPSIS = '…';

/** Strips common markdown syntax and collapses whitespace. */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/^[ \t]*(```|~~~).*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*(>[ \t]?)+/gm, '')
    .replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/gm, '')
    .replace(/\*\*|__|~~|[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ';
}

/** Builds a snippet of `body` around the best match for `query`. */
export function makeSnippet(
  body: string,
  query: string | ParsedQuery,
  options?: SnippetOptions,
): Snippet {
  const target = Math.max(1, Math.floor(options?.targetLength ?? DEFAULT_SNIPPET_LENGTH));
  const text = markdownToPlainText(body);
  const parsed = typeof query === 'string' ? parseQuery(query, options?.analyzer) : query;
  const terms = new Set(parsed.terms);
  const matches = analyze(text, options?.analyzer).filter((t) => terms.has(t.text));

  // Best window of matches.
  let matchStart = 0;
  let matchEnd = 0;
  if (matches.length > 0) {
    let best = { distinct: -1, count: -1, i: 0, j: 0 };
    for (let i = 0; i < matches.length; i++) {
      const seen = new Set<string>();
      let j = i;
      while (j < matches.length && matches[j]!.end - matches[i]!.start <= target) {
        seen.add(matches[j]!.text);
        j++;
      }
      if (j === i) {
        seen.add(matches[i]!.text);
        j = i + 1; // A single match longer than the target.
      }
      const count = j - i;
      if (seen.size > best.distinct || (seen.size === best.distinct && count > best.count)) {
        best = { distinct: seen.size, count, i, j: j - 1 };
      }
    }
    matchStart = matches[best.i]!.start;
    matchEnd = matches[best.j]!.end;
  }

  let start: number;
  let end: number;
  if (text.length <= target) {
    start = 0;
    end = text.length;
  } else {
    const slack = Math.max(0, target - (matchEnd - matchStart));
    start = Math.max(0, matchStart - Math.floor(slack / 2));
    end = Math.min(text.length, start + Math.max(target, matchEnd - matchStart));
    if (end === text.length) start = Math.max(0, Math.min(start, end - target));
    // Move inward to word boundaries, never past the match region.
    if (start > 0 && !isSpace(text[start - 1])) {
      const next = text.indexOf(' ', start);
      // Past the match start, fall back to it: a token start is a word boundary.
      start = next !== -1 && next < matchStart ? next + 1 : matchStart;
    }
    if (end < text.length && !isSpace(text[end])) {
      const prev = text.lastIndexOf(' ', end);
      end = prev !== -1 && prev >= matchEnd ? prev : Math.max(matchEnd, end);
    }
    while (start < end && isSpace(text[start])) start++;
    while (end > start && isSpace(text[end - 1])) end--;
  }

  const prefix = start > 0 ? ELLIPSIS : '';
  const suffix = end < text.length ? ELLIPSIS : '';
  const highlights = matches
    .filter((m) => m.start >= start && m.end <= end)
    .map((m) => ({ start: m.start - start + prefix.length, end: m.end - start + prefix.length }));
  return { text: prefix + text.slice(start, end) + suffix, highlights };
}
