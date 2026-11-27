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

/** For each index of `s`, the index of the next character at or after it that passes `test`, or -1. */
function nextWhere(s: string, test: (c: string) => boolean): Int32Array {
  const next = new Int32Array(s.length + 1);
  next[s.length] = -1;
  for (let i = s.length - 1; i >= 0; i--)
    next[i] = test(s[i] as string) ? i : (next[i + 1] as number);
  return next;
}

/**
 * Replaces, left to right and without overlaps (as a global regex replace
 * does), every match that `at` finds at an occurrence of `start`.
 */
function scanReplace(
  s: string,
  start: string,
  at: (i: number) => { readonly end: number; readonly out: string } | null,
): string {
  let i = s.indexOf(start);
  if (i < 0) return s;
  let out = '';
  let last = 0;
  while (i >= 0) {
    const m = at(i);
    if (m) {
      out += s.slice(last, i) + m.out;
      last = m.end;
      i = s.indexOf(start, m.end);
    } else i = s.indexOf(start, i + 1);
  }
  return out + s.slice(last);
}

/** `[text](url)` (or `![alt](url)` with `bang`) to its text: `/!?\[([^\]]*)\]\([^)]*\)/g`, in linear time. */
function stripLinks(s: string, bang: boolean): string {
  const close = nextWhere(s, (c) => c === ']');
  const paren = nextWhere(s, (c) => c === ')');
  return scanReplace(s, bang ? '!' : '[', (i) => {
    const open = bang ? i + 1 : i;
    if (s[open] !== '[') return null;
    const j = close[open + 1] as number;
    if (j < 0 || s[j + 1] !== '(') return null;
    const k = paren[j + 2] as number;
    return k < 0 ? null : { end: k + 1, out: s.slice(open + 1, j) };
  });
}

/** `[text][ref]` to its text: `/\[([^\]]*)\]\[[^\]]*\]/g`, in linear time. */
function stripRefLinks(s: string): string {
  const close = nextWhere(s, (c) => c === ']');
  return scanReplace(s, '[', (i) => {
    const j = close[i + 1] as number;
    if (j < 0 || s[j + 1] !== '[') return null;
    const k = close[j + 2] as number;
    return k < 0 ? null : { end: k + 1, out: s.slice(i + 1, j) };
  });
}

/** `<https://…>` to its address: `/<((?:https?|mailto):[^>\s]+)>/g`, in linear time. */
function stripAutolinks(s: string): string {
  const stop = nextWhere(s, (c) => c === '>' || /\s/.test(c));
  return scanReplace(s, '<', (i) => {
    const scheme = ['http:', 'https:', 'mailto:'].find((p) => s.startsWith(p, i + 1));
    if (scheme === undefined) return null;
    const from = i + 1 + scheme.length;
    const k = stop[from] as number;
    return k <= from || s[k] !== '>' ? null : { end: k + 1, out: s.slice(i + 1, k) };
  });
}

/** HTML tags removed: `/<\/?[A-Za-z][^>]*>/g`, in linear time. */
function stripTags(s: string): string {
  const gt = nextWhere(s, (c) => c === '>');
  return scanReplace(s, '<', (i) => {
    const q = s[i + 1] === '/' ? i + 2 : i + 1;
    if (!/[A-Za-z]/.test(s[q] ?? '')) return null;
    const k = gt[q + 1] as number;
    return k < 0 ? null : { end: k + 1, out: '' };
  });
}

// Links, autolinks and tags are matched by scanning rather than with the
// equivalent regular expressions, which backtrack: on hostile input (a long
// heading of `[[[[…` or `<a<a…`) they take time quadratic in its length, and
// headings are stripped while a note is indexed, on the server too.
function stripPlain(s: string): string {
  const wiki = s.replace(/!?\[\[([^[\]\n]*)\]\]/g, (_m, inner: string) => {
    const { target, heading, alias } = splitWikiLink(inner);
    return alias ?? (heading ? `${target} > ${heading}` : target);
  });
  return stripTags(stripAutolinks(stripRefLinks(stripLinks(stripLinks(wiki, true), false))))
    .replace(/(\*\*|__)(?=\S)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/==(.+?)==/g, '$1')
    .replace(/\*(?=\S)([^*]+?)\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_]+?)_(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1');
}
