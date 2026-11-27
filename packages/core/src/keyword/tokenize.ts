// Tokenizer for keyword search. It is shared by indexing, querying and
// snippets, so all three see exactly the same terms on every platform.
//
// Rules (deterministic and locale-independent; no `toLocale*` calls):
//
// 1. Each code point is folded on its own: Unicode NFKD, then every combining
//    mark (\p{M}) is dropped, then `toLowerCase()` (the locale-independent
//    Unicode default mapping). So `Café` → `cafe`, `ﬁle` → `file`, `①` → `1`,
//    `Ⅻ` → `xii`. A combining mark in the source text (`e` + U+0301) is dropped
//    without breaking the word.
// 2. A token is a maximal run of letters and digits (\p{L} or \p{N}) after
//    folding. Everything else separates tokens. Letters and digits stay
//    together: `v1` and `mp3` are single tokens.
// 3. Identifiers:
//    - `snake_case`, `kebab-case`, `dotted.name`, `path/to/x`: split at the
//      punctuation → `snake` `case`, `kebab` `case`, ...
//    - `camelCase` and `PascalCase` are NOT split: `camelCase` → `camelcase`.
//      Splitting would add terms that no positional phrase can line up with,
//      and the same query typed the same way matches either way.
//    - `v1.2.3` → `v1` `2` `3`. A quoted query `"v1.2.3"` is a phrase over
//      those positions, so it matches the version exactly.
// 4. Apostrophes (U+0027 ', U+2019 ’, U+02BC ʼ) between two letters are
//    removed and the word stays whole: `don't` → `dont`, `Ada's` → `adas`
//    (which the stemmer then turns into `ada`). Any other apostrophe, such as
//    a trailing possessive `students'`, is a separator.
// 5. No stop words are removed. Scripts without spaces (Chinese, Japanese,
//    Thai) are not segmented: each run of such letters is one token.
//
// Each token carries its ordinal position (0, 1, 2, ... within the text) and
// its UTF-16 code unit offsets `[start, end)` in the original, unfolded text.
// A single source character that folds into several tokens (`℀` → `a/c`)
// gives each of them that character's span.

/** A token: its folded text, ordinal position, and offsets in the source. */
export interface Token {
  /** Folded (and, after `analyze`, possibly stemmed) term text. */
  readonly text: string;
  /** Ordinal position of the token within the text: 0, 1, 2, ... */
  readonly position: number;
  /** UTF-16 offset of the token's first code unit in the original text. */
  readonly start: number;
  /** UTF-16 offset just past the token's last code unit in the original text. */
  readonly end: number;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;
const MARKS = /\p{M}/gu;
const APOSTROPHES = new Set(["'", '’', 'ʼ']);

/** Folds one code point (or a short string) the way the tokenizer does. */
export function foldText(text: string): string {
  return text.normalize('NFKD').replace(MARKS, '').toLowerCase();
}

interface Unit {
  readonly original: string;
  readonly folded: string;
  readonly start: number;
  readonly end: number;
}

function units(text: string): Unit[] {
  const out: Unit[] = [];
  let offset = 0;
  for (const cp of text) {
    out.push({ original: cp, folded: foldText(cp), start: offset, end: offset + cp.length });
    offset += cp.length;
  }
  return out;
}

/** Splits `text` into folded tokens. No stemming; see `analyze` for that. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const us = units(text);
  let current = '';
  let start = -1;
  let end = -1;

  const flush = (): void => {
    if (current.length > 0) {
      tokens.push({ text: current, position: tokens.length, start, end });
    }
    current = '';
    start = -1;
  };

  for (let i = 0; i < us.length; i++) {
    const u = us[i]!;
    if (u.folded.length === 0) {
      // A combining mark (or anything that folds away) does not break a word.
      if (MARK.test(u.original) && current.length > 0) end = u.end;
      continue;
    }
    if (APOSTROPHES.has(u.original) && current.length > 0) {
      const prev = current[current.length - 1]!;
      const next = us[i + 1];
      if (LETTER.test(prev) && next !== undefined && LETTER.test(next.folded[0] ?? '')) {
        continue; // Inner apostrophe: drop it and keep the word whole.
      }
    }
    for (const ch of u.folded) {
      if (WORD_CHAR.test(ch)) {
        if (current.length === 0) start = u.start;
        current += ch;
        end = u.end;
      } else {
        flush();
      }
    }
  }
  flush();
  return tokens;
}
