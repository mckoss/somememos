// Ranking sections for a query over any postings source.
//
// Match semantics. A clause matches a section when its term occurs in any
// field (term clause), or when its terms occur at consecutive positions
// within a single field (phrase clause).
//   - mode 'any' (default): a section matches when at least one clause does.
//   - mode 'all': a section matches only when every clause does.
// A matching section's score is the BM25F sum (see bm25f.ts) over the
// distinct terms of its matching clauses, each term counted once. Terms of a
// phrase that did not match as a phrase contribute nothing. Ties are broken
// by id (ascending, by UTF-16 code units) so results are deterministic.

import type { AnalyzerOptions } from './analyze.js';
import {
  type Bm25fParams,
  type Bm25fParamsOverride,
  type CorpusStats,
  bm25Idf,
  bm25fPseudoFrequency,
  bm25fTermScore,
  resolveBm25fParams,
} from './bm25f.js';
import { FIELDS, type FieldPositions, type FieldValues } from './document.js';
import { type ParsedQuery, type QueryClause, parseQuery } from './query.js';

export type Awaitable<T> = T | Promise<T>;

/** One section's entry in a term's posting list. */
export interface Posting {
  /** Section id. */
  readonly id: string;
  /** Term frequency per field. */
  readonly tf: FieldValues;
  /** The section's field lengths in tokens (the same in every posting of the section). */
  readonly lengths: FieldValues;
  /** Token positions per field. Required only when the query has a phrase. */
  readonly positions?: FieldPositions;
}

/**
 * What the scorer reads from an index. `MemoryKeywordIndex` implements it;
 * a SQLite- or Postgres-backed term index can implement it too, and the same
 * scoring code then ranks identically everywhere.
 */
export interface PostingsSource {
  /** The analyzer the index was built with; queries are parsed with it. */
  readonly analyzer: AnalyzerOptions;
  /** N and the average field lengths over all sections. */
  corpusStats(): Awaitable<CorpusStats>;
  /** The number of sections containing `term` in any field. */
  documentFrequency(term: string): Awaitable<number>;
  /**
   * Every section containing `term`. Positions must be included when
   * `withPositions` is true and may be omitted otherwise.
   */
  postings(
    term: string,
    options: { readonly withPositions: boolean },
  ): Awaitable<Iterable<Posting>>;
}

export type MatchMode = 'any' | 'all';

export interface SearchOptions {
  /** 'any' (default): at least one clause must match. 'all': every clause. */
  readonly mode?: MatchMode;
  /** Return at most this many hits. Default: all matches. */
  readonly limit?: number;
  /** BM25F parameter overrides (defaults: DEFAULT_BM25F_PARAMS). */
  readonly params?: Bm25fParamsOverride;
}

export interface SearchHit {
  readonly id: string;
  /** BM25F score, ≥ 0, higher is better. */
  readonly score: number;
  /** The query terms (index form) that counted toward the score, in query order. */
  readonly matchedTerms: readonly string[];
}

/** The data `rankPostings` needs, gathered from a source for one query. */
export interface GatheredPostings {
  readonly stats: CorpusStats;
  readonly documentFrequencies: ReadonlyMap<string, number>;
  readonly postings: ReadonlyMap<string, Iterable<Posting>>;
}

/** Whether a query needs token positions (it has a phrase clause). */
export function queryNeedsPositions(query: ParsedQuery): boolean {
  return query.clauses.some((c) => c.kind === 'phrase');
}

/** Gathers everything `rankPostings` needs from a source. */
export async function gatherPostings(
  source: PostingsSource,
  query: ParsedQuery,
): Promise<GatheredPostings> {
  const withPositions = queryNeedsPositions(query);
  const documentFrequencies = new Map<string, number>();
  const postings = new Map<string, Iterable<Posting>>();
  const stats = await source.corpusStats();
  for (const term of query.terms) {
    documentFrequencies.set(term, await source.documentFrequency(term));
    postings.set(term, await source.postings(term, { withPositions }));
  }
  return { stats, documentFrequencies, postings };
}

/** Parses (if needed), gathers and ranks: the full search over any source. */
export async function searchSource(
  source: PostingsSource,
  query: string | ParsedQuery,
  options?: SearchOptions,
): Promise<SearchHit[]> {
  const parsed = typeof query === 'string' ? parseQuery(query, source.analyzer) : query;
  resolveBm25fParams(options?.params); // Validate before touching storage.
  const gathered = await gatherPostings(source, parsed);
  return rankPostings(parsed, gathered, options);
}

interface Candidate {
  lengths: FieldValues;
  byTerm: Map<string, Posting>;
}

function phraseMatches(terms: readonly string[], byTerm: ReadonlyMap<string, Posting>): boolean {
  const postings: Posting[] = [];
  for (const term of terms) {
    const p = byTerm.get(term);
    if (!p) return false;
    if (!p.positions) {
      throw new Error(`Phrase query needs token positions, but the posting for "${term}" has none`);
    }
    postings.push(p);
  }
  for (const field of FIELDS) {
    const first = postings[0]!.positions![field];
    if (first.length === 0) continue;
    const rest = postings.slice(1).map((p) => new Set(p.positions![field]));
    for (const start of first) {
      if (rest.every((set, i) => set.has(start + i + 1))) return true;
    }
  }
  return false;
}

function clauseMatches(clause: QueryClause, byTerm: ReadonlyMap<string, Posting>): boolean {
  return clause.kind === 'term' ? byTerm.has(clause.term) : phraseMatches(clause.terms, byTerm);
}

/** Ranks the gathered postings for `query`. Pure and synchronous. */
export function rankPostings(
  query: ParsedQuery,
  gathered: GatheredPostings,
  options?: Omit<SearchOptions, 'params'> & { readonly params?: Bm25fParams | Bm25fParamsOverride },
): SearchHit[] {
  const params = resolveBm25fParams(options?.params);
  const mode = options?.mode ?? 'any';
  if (query.clauses.length === 0) return [];

  const candidates = new Map<string, Candidate>();
  for (const term of query.terms) {
    for (const posting of gathered.postings.get(term) ?? []) {
      let c = candidates.get(posting.id);
      if (!c) {
        c = { lengths: posting.lengths, byTerm: new Map() };
        candidates.set(posting.id, c);
      }
      c.byTerm.set(term, posting);
    }
  }

  const idf = new Map<string, number>();
  for (const term of query.terms) {
    idf.set(
      term,
      bm25Idf(gathered.documentFrequencies.get(term) ?? 0, gathered.stats.sectionCount),
    );
  }

  const hits: SearchHit[] = [];
  for (const [id, c] of candidates) {
    const matched = new Set<string>();
    let matchedClauses = 0;
    for (const clause of query.clauses) {
      if (!clauseMatches(clause, c.byTerm)) continue;
      matchedClauses++;
      if (clause.kind === 'term') matched.add(clause.term);
      else for (const t of clause.terms) matched.add(t);
    }
    if (matchedClauses === 0) continue;
    if (mode === 'all' && matchedClauses < query.clauses.length) continue;

    const matchedTerms = query.terms.filter((t) => matched.has(t));
    let score = 0;
    for (const term of matchedTerms) {
      const posting = c.byTerm.get(term)!;
      const pf = bm25fPseudoFrequency(
        posting.tf,
        c.lengths,
        gathered.stats.averageFieldLengths,
        params,
      );
      score += bm25fTermScore(idf.get(term)!, pf, params);
    }
    hits.push({ id, score, matchedTerms });
  }

  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const limit = options?.limit;
  return limit === undefined ? hits : hits.slice(0, Math.max(0, limit));
}
