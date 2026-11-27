// Keyword scoring, shared by the server, the CLI and the browser: tokenizer,
// Porter stemmer, section analysis, BM25F, query parsing, an in-memory
// reference index and snippets. Storage only keeps the term index; all
// tokenizing and ranking happens here, so results match on every platform.
// Every scoring parameter is a tunable placeholder until `somememos eval`
// measures it.

export { type Token, foldText, tokenize } from './tokenize.js';
export { isStemmable, porterStem } from './porter.js';
export {
  type AnalyzerOptions,
  DEFAULT_ANALYZER_OPTIONS,
  analyze,
  resolveAnalyzerOptions,
  toTerm,
} from './analyze.js';
export {
  type AnalyzedSection,
  FIELDS,
  type Field,
  type FieldPositions,
  type FieldValues,
  type Section,
  type TermEntry,
  analyzeSection,
  fieldValues,
} from './document.js';
export {
  type Bm25fParams,
  type Bm25fParamsOverride,
  type Bm25fSectionInput,
  type CorpusStats,
  DEFAULT_BM25F_PARAMS,
  bm25Idf,
  bm25fPseudoFrequency,
  bm25fScore,
  bm25fTermScore,
  resolveBm25fParams,
  validateBm25fParams,
} from './bm25f.js';
export { type ParsedQuery, type QueryClause, parseQuery } from './query.js';
export {
  type Awaitable,
  type GatheredPostings,
  type MatchMode,
  type Posting,
  type PostingsSource,
  type SearchHit,
  type SearchOptions,
  gatherPostings,
  queryNeedsPositions,
  rankPostings,
  searchSource,
} from './search.js';
export {
  type IndexStatistics,
  MemoryKeywordIndex,
  type MemoryKeywordIndexOptions,
} from './memory-index.js';
export {
  DEFAULT_SNIPPET_LENGTH,
  type Snippet,
  type SnippetOptions,
  makeSnippet,
  markdownToPlainText,
} from './snippet.js';
