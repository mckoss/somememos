import { porterStem } from './porter.js';
import { type Token, tokenize } from './tokenize.js';

/**
 * How text becomes index terms. The same options must be used to build an
 * index and to query it; a stored index should record them.
 */
export interface AnalyzerOptions {
  /** Porter-stem ASCII-letter tokens. Default true. */
  readonly stem: boolean;
}

export const DEFAULT_ANALYZER_OPTIONS: AnalyzerOptions = Object.freeze({ stem: true });

/** Fills in defaults for analyzer options. */
export function resolveAnalyzerOptions(options?: Partial<AnalyzerOptions>): AnalyzerOptions {
  return { stem: options?.stem ?? DEFAULT_ANALYZER_OPTIONS.stem };
}

/** Turns one folded token into an index term. */
export function toTerm(token: string, options?: Partial<AnalyzerOptions>): string {
  return resolveAnalyzerOptions(options).stem ? porterStem(token) : token;
}

/**
 * Tokenizes `text` and maps each token to its index term (stemmed unless
 * `stem: false`). Positions and offsets are those of `tokenize`.
 */
export function analyze(text: string, options?: Partial<AnalyzerOptions>): Token[] {
  const { stem } = resolveAnalyzerOptions(options);
  const tokens = tokenize(text);
  return stem ? tokens.map((t) => ({ ...t, text: porterStem(t.text) })) : tokens;
}
