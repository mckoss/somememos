// Query parsing. A query is a list of clauses: single terms, and quoted
// phrases. Both go through the same tokenizer and stemmer as indexed text.
//
// - Text outside double quotes yields one term clause per token. Words are
//   not operators: `and`, `or`, `not` and a leading `-` have no meaning.
// - Text inside double quotes ("..." or the curly “...”) yields one phrase
//   clause: its tokens must occur at consecutive positions within one field.
//   A one-token phrase is just a term clause. An unclosed quote runs to the
//   end of the query.
// - Duplicate clauses are dropped, so `cat cat` is the query `cat`.

import { type AnalyzerOptions, analyze } from './analyze.js';

export type QueryClause =
  | { readonly kind: 'term'; readonly term: string }
  | { readonly kind: 'phrase'; readonly terms: readonly string[] };

export interface ParsedQuery {
  readonly clauses: readonly QueryClause[];
  /** The distinct terms of all clauses, in first-seen order. */
  readonly terms: readonly string[];
}

const QUOTES = new Set(['"', '“', '”']);

/** Parses a user query with the given analyzer options. */
export function parseQuery(query: string, options?: Partial<AnalyzerOptions>): ParsedQuery {
  const clauses: QueryClause[] = [];
  const seen = new Set<string>();
  const push = (clause: QueryClause): void => {
    const key = clause.kind === 'term' ? `t:${clause.term}` : `p:${clause.terms.join(' ')}`;
    if (seen.has(key)) return;
    seen.add(key);
    clauses.push(clause);
  };

  let buf = '';
  let inQuote = false;
  const flush = (): void => {
    const terms = analyze(buf, options).map((t) => t.text);
    buf = '';
    if (inQuote && terms.length > 1) {
      push({ kind: 'phrase', terms });
    } else {
      for (const term of terms) push({ kind: 'term', term });
    }
  };
  for (const ch of query) {
    if (QUOTES.has(ch)) {
      flush();
      inQuote = !inQuote;
    } else {
      buf += ch;
    }
  }
  flush();

  const terms: string[] = [];
  const termSet = new Set<string>();
  for (const clause of clauses) {
    for (const term of clause.kind === 'term' ? [clause.term] : clause.terms) {
      if (!termSet.has(term)) {
        termSet.add(term);
        terms.push(term);
      }
    }
  }
  return { clauses, terms };
}

/**
 * Whether `text` matches every clause of `query`: each term occurs in it, and
 * each phrase's terms occur at consecutive positions. The text is analyzed
 * with `options`, which must be the analyzer the query was parsed with. A
 * query with no clauses matches nothing. For searching short texts one by one
 * (change messages), not an index.
 */
export function matchesAllClauses(
  text: string,
  query: ParsedQuery,
  options?: Partial<AnalyzerOptions>,
): boolean {
  if (query.clauses.length === 0) return false;
  const tokens = analyze(text, options).map((t) => t.text);
  const positions = new Map<string, number[]>();
  tokens.forEach((term, i) => {
    let list = positions.get(term);
    if (!list) positions.set(term, (list = []));
    list.push(i);
  });
  return query.clauses.every((clause) => {
    if (clause.kind === 'term') return positions.has(clause.term);
    const [first, ...rest] = clause.terms;
    return (positions.get(first as string) ?? []).some((start) =>
      rest.every((term, j) => tokens[start + j + 1] === term),
    );
  });
}
