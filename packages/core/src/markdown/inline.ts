// Inline markdown helpers: code span masking and stripping markup from headings.

/**
 * Replaces every inline code span (backtick run, content, matching run) with
 * spaces, keeping `\n` so offsets and line numbers are unchanged. A backtick
 * run with no matching run of the same length is literal text, as in CommonMark.
 */
export function maskCodeSpans(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`' || isEscaped(text, i)) {
      out += text[i];
      i++;
      continue;
    }
    const runEnd = endOfRun(text, i);
    const n = runEnd - i;
    const close = findRun(text, runEnd, n);
    if (close < 0) {
      out += text.slice(i, runEnd);
      i = runEnd;
      continue;
    }
    out += text.slice(i, close + n).replace(/[^\n]/g, ' ');
    i = close + n;
  }
  return out;
}

/** True if the character at `i` is itself escaped by an odd run of backslashes before it. */
function isEscaped(text: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) n++;
  return n % 2 === 1;
}

function endOfRun(text: string, i: number): number {
  while (text[i] === '`') i++;
  return i;
}

/** Index of the next backtick run of exactly length `n` at or after `from`, or -1. */
function findRun(text: string, from: number, n: number): number {
  let i = text.indexOf('`', from);
  while (i >= 0) {
    const end = endOfRun(text, i);
    if (end - i === n) return i;
    i = text.indexOf('`', end);
  }
  return -1;
}

export interface WikiLinkParts {
  target: string;
  heading?: string;
  alias?: string;
}

/**
 * Splits the inside of `[[...]]` into target, heading and alias. `\|` (used
 * inside tables) counts as `|`. Parts are trimmed; empty parts are dropped.
 */
export function splitWikiLink(inner: string): WikiLinkParts {
  const unescaped = inner.replace(/\\\|/g, '|');
  const bar = unescaped.indexOf('|');
  const left = bar < 0 ? unescaped : unescaped.slice(0, bar);
  const alias = bar < 0 ? '' : unescaped.slice(bar + 1).trim();
  const hash = left.indexOf('#');
  const target = (hash < 0 ? left : left.slice(0, hash)).trim();
  const heading = hash < 0 ? '' : left.slice(hash + 1).trim();
  const parts: WikiLinkParts = { target };
  if (heading !== '') parts.heading = heading;
  if (alias !== '') parts.alias = alias;
  return parts;
}

/**
 * Reduces inline markdown to its plain text, for headings and titles: code
 * spans, emphasis, strikethrough, highlights, links, images, wiki-links,
 * autolinks, HTML tags and backslash escapes. Whitespace is collapsed.
 */
export function stripInlineMarkdown(text: string): string {
  // Code span contents are literal, so they are cut out before anything else.
  const pieces: string[] = [];
  let i = 0;
  let plain = '';
  while (i < text.length) {
    if (text[i] === '`' && !isEscaped(text, i)) {
      const runEnd = endOfRun(text, i);
      const close = findRun(text, runEnd, runEnd - i);
      if (close >= 0) {
        pieces.push(stripPlain(plain), text.slice(runEnd, close).trim());
        plain = '';
        i = close + (runEnd - i);
        continue;
      }
      plain += text.slice(i, runEnd);
      i = runEnd;
      continue;
    }
    plain += text[i];
    i++;
  }
  pieces.push(stripPlain(plain));
  return pieces.join('').replace(/\s+/g, ' ').trim();
}

function stripPlain(s: string): string {
  return s
    .replace(/!?\[\[([^[\]\n]*)\]\]/g, (_m, inner: string) => {
      const { target, heading, alias } = splitWikiLink(inner);
      return alias ?? (heading ? `${target} > ${heading}` : target);
    })
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/(\*\*|__)(?=\S)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/==(.+?)==/g, '$1')
    .replace(/\*(?=\S)([^*]+?)\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_]+?)_(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1');
}
