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
