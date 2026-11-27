// The in-memory reference index. Tests use it, and the evaluation harness uses
// it to rebuild a keyword index as of a past moment. Storage-backed indexes
// must rank exactly as this one does for the same content.

import { type AnalyzerOptions, resolveAnalyzerOptions } from './analyze.js';
import {
  type Bm25fParams,
  type Bm25fParamsOverride,
  type CorpusStats,
  resolveBm25fParams,
} from './bm25f.js';
import {
  type AnalyzedSection,
  FIELDS,
  type FieldValues,
  type Section,
  analyzeSection,
} from './document.js';
import { type ParsedQuery, parseQuery } from './query.js';
import {
  type Posting,
  type PostingsSource,
  type SearchHit,
  type SearchOptions,
  rankPostings,
} from './search.js';

export interface MemoryKeywordIndexOptions {
  /** Analyzer settings (default: stemming on). Fixed for the index's lifetime. */
  readonly analyzer?: Partial<AnalyzerOptions>;
  /** Default BM25F parameters for `search`; a search may override them further. */
  readonly params?: Bm25fParamsOverride;
}

/** Index-wide statistics, for checks and diagnostics. */
export interface IndexStatistics {
  readonly sectionCount: number;
  /** Σ over sections of each field's length. */
  readonly totalFieldLengths: FieldValues;
  /** Document frequency of every indexed term, sorted by term. */
  readonly documentFrequencies: ReadonlyArray<readonly [string, number]>;
}

export class MemoryKeywordIndex implements PostingsSource {
  readonly analyzer: AnalyzerOptions;
  /** BM25F parameters `search` uses unless a call overrides them. */
  readonly params: Bm25fParams;
  private readonly sections = new Map<string, AnalyzedSection>();
  /** term → section id → posting. */
  private readonly index = new Map<string, Map<string, Posting>>();
  private readonly totals = { title: 0, heading: 0, body: 0 };

  constructor(options?: MemoryKeywordIndexOptions) {
    this.analyzer = resolveAnalyzerOptions(options?.analyzer);
    this.params = resolveBm25fParams(options?.params);
  }

  /** The number of sections in the index. */
  get size(): number {
    return this.sections.size;
  }

  has(id: string): boolean {
    return this.sections.has(id);
  }

  /** Adds a new section. Throws if `id` is already present (use `replace`). */
  add(id: string, section: Section): void {
    if (this.sections.has(id)) throw new Error(`Section already indexed: ${id}`);
    this.insert(id, analyzeSection(section, this.analyzer));
  }

  /** Adds the section, or replaces the one already indexed under `id`. */
  replace(id: string, section: Section): void {
    this.remove(id);
    this.insert(id, analyzeSection(section, this.analyzer));
  }

  /** Removes a section. Returns false if it was not indexed. */
  remove(id: string): boolean {
    const analyzed = this.sections.get(id);
    if (!analyzed) return false;
    this.sections.delete(id);
    for (const f of FIELDS) this.totals[f] -= analyzed.lengths[f];
    for (const term of analyzed.terms.keys()) {
      const list = this.index.get(term)!;
      list.delete(id);
      if (list.size === 0) this.index.delete(term);
    }
    return true;
  }

  private insert(id: string, analyzed: AnalyzedSection): void {
    this.sections.set(id, analyzed);
    for (const f of FIELDS) this.totals[f] += analyzed.lengths[f];
    for (const [term, entry] of analyzed.terms) {
      let list = this.index.get(term);
      if (!list) {
        list = new Map();
        this.index.set(term, list);
      }
      list.set(id, { id, tf: entry.tf, lengths: analyzed.lengths, positions: entry.positions });
    }
  }

  corpusStats(): CorpusStats {
    const n = this.sections.size;
    const avg = (f: keyof FieldValues): number => (n === 0 ? 0 : this.totals[f] / n);
    return {
      sectionCount: n,
      averageFieldLengths: { title: avg('title'), heading: avg('heading'), body: avg('body') },
    };
  }

  documentFrequency(term: string): number {
    return this.index.get(term)?.size ?? 0;
  }

  postings(term: string): Posting[] {
    return [...(this.index.get(term)?.values() ?? [])];
  }

  statistics(): IndexStatistics {
    const documentFrequencies = [...this.index]
      .map(([term, list]) => [term, list.size] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      sectionCount: this.sections.size,
      totalFieldLengths: { ...this.totals },
      documentFrequencies,
    };
  }

  /** Parses a query with this index's analyzer. */
  parse(query: string): ParsedQuery {
    return parseQuery(query, this.analyzer);
  }

  /** Ranks the indexed sections for `query`. Synchronous. */
  search(query: string | ParsedQuery, options?: SearchOptions): SearchHit[] {
    const parsed = typeof query === 'string' ? this.parse(query) : query;
    const documentFrequencies = new Map<string, number>();
    const postings = new Map<string, Posting[]>();
    for (const term of parsed.terms) {
      documentFrequencies.set(term, this.documentFrequency(term));
      postings.set(term, this.postings(term));
    }
    const params = resolveBm25fParams(options?.params, this.params);
    return rankPostings(
      parsed,
      { stats: this.corpusStats(), documentFrequencies, postings },
      { ...options, params },
    );
  }
}
