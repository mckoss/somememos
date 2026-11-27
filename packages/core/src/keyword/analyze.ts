import { porterStem } from './porter.js';
import { type Token, tokenize } from './tokenize.js';

/**
 * The version of the rules that turn text into terms (the tokenizer and the
 * analyzer). Bump it whenever the terms a text yields change, so every stored
 * index notices it was built under older rules and rebuilds.
 *
 * 1. The original rules.
 * 2. Tokens longer than `MAX_TERM_LENGTH` are no longer terms.
 */
export const ANALYZER_FORMAT = 2;

/**
 * How text becomes index terms. The same options must be used to build an
 * index and to query it; a stored index should record them.
 */
export interface AnalyzerOptions {
  /** Porter-stem ASCII-letter tokens. Default true. */
  readonly stem: boolean;
  /**
   * The rules the index was built under (`ANALYZER_FORMAT`). Not a setting:
   * requested options always resolve to the current rules; only an index
   * stored under older rules records an older number.
   */
  readonly format: number;
}

export const DEFAULT_ANALYZER_OPTIONS: AnalyzerOptions = Object.freeze({
  stem: true,
  format: ANALYZER_FORMAT,
});

/** Fills in defaults for analyzer options. The format is always the current one. */
export function resolveAnalyzerOptions(options?: Partial<AnalyzerOptions>): AnalyzerOptions {
  return { stem: options?.stem ?? DEFAULT_ANALYZER_OPTIONS.stem, format: ANALYZER_FORMAT };
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
