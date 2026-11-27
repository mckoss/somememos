// BM25F keyword scoring: pure functions, no storage.
//
// For a query term t and a section d with fields f ∈ {title, heading, body}:
//
//   B_f(d)   = (1 − b_f) + b_f · len_f(d) / avglen_f      (B_f = 1 when avglen_f = 0)
//   tf̃(t,d)  = Σ_f  w_f · tf_f(t,d) / B_f(d)
//   idf(t)   = ln(1 + (N − df(t) + 0.5) / (df(t) + 0.5))
//   s(t,d)   = idf(t) · tf̃(t,d) · (k1 + 1) / (k1 + tf̃(t,d))  (0 when tf̃ = 0)
//
//   score(d) = Σ_{t ∈ matched terms of d} s(t,d)
//
// This is the "simple BM25F" of Robertson, Zaragoza and Taylor (2004) and
// Zaragoza et al. (2004): per-field length normalization and weighting are
// applied to the term frequency before the single k1 saturation, so a term
// repeated across fields saturates once instead of being counted per field.
//
// N is the number of sections, df(t) the number of sections containing t in
// any field, and avglen_f the mean length of field f over all N sections
// (sections where the field is empty count as length 0).
//
// The IDF is the Lucene/BM25+ "plus one" variant. For 0 ≤ df ≤ N its argument
// is > 1, so idf > 0: it never goes negative, unlike the classic
// Robertson–Spärck Jones form for terms in more than half of the sections.
// df is clamped to [0, N] so inconsistent statistics cannot make it negative.
//
// Scores are ≥ 0, and > 0 whenever a matched term has tf > 0 in a field with
// positive weight. Higher is better. Query term frequency is ignored: each
// distinct query term counts once.

import { FIELDS, type Field, type FieldValues } from './document.js';

/** BM25F parameters. Every value is a placeholder until `somememos eval` sets it. */
export interface Bm25fParams {
  /** Term-frequency saturation. ≥ 0. */
  readonly k1: number;
  /** Length normalization per field, each in [0, 1]. */
  readonly b: FieldValues;
  /** Field weights, each ≥ 0. */
  readonly weights: FieldValues;
}

/** Partial overrides; unspecified values keep their defaults. */
export interface Bm25fParamsOverride {
  readonly k1?: number;
  readonly b?: Partial<Record<Field, number>>;
  readonly weights?: Partial<Record<Field, number>>;
}

/**
 * Default parameters. PLACEHOLDERS, not measured: k1 and body b are the usual
 * BM25 textbook values; title and heading are short, so they get less length
 * normalization; field weights favour title and heading over body.
 */
export const DEFAULT_BM25F_PARAMS: Bm25fParams = Object.freeze({
  k1: 1.2,
  b: Object.freeze({ title: 0.5, heading: 0.5, body: 0.75 }),
  weights: Object.freeze({ title: 3, heading: 2, body: 1 }),
});

/** Merges overrides onto `base` (default: DEFAULT_BM25F_PARAMS) and validates. */
export function resolveBm25fParams(
  override?: Bm25fParamsOverride,
  base: Bm25fParams = DEFAULT_BM25F_PARAMS,
): Bm25fParams {
  const params: Bm25fParams = {
    k1: override?.k1 ?? base.k1,
    b: { ...base.b, ...override?.b },
    weights: { ...base.weights, ...override?.weights },
  };
  validateBm25fParams(params);
  return params;
}

/** Throws a RangeError if a parameter is outside its allowed range. */
export function validateBm25fParams(params: Bm25fParams): void {
  if (!Number.isFinite(params.k1) || params.k1 < 0) {
    throw new RangeError(`k1 must be a finite number ≥ 0, got ${params.k1}`);
  }
  for (const f of FIELDS) {
    const b = params.b[f];
    if (!Number.isFinite(b) || b < 0 || b > 1) {
      throw new RangeError(`b.${f} must be in [0, 1], got ${b}`);
    }
    const w = params.weights[f];
    if (!Number.isFinite(w) || w < 0) {
      throw new RangeError(`weights.${f} must be a finite number ≥ 0, got ${w}`);
    }
  }
}

/** Corpus statistics the scorer needs. */
export interface CorpusStats {
  /** N: the number of sections in the index. */
  readonly sectionCount: number;
  /** avglen_f: mean field length in tokens over all sections (0 when empty). */
  readonly averageFieldLengths: FieldValues;
}

/** idf(t) = ln(1 + (N − df + 0.5) / (df + 0.5)), with df clamped to [0, N]. Always > 0. */
export function bm25Idf(documentFrequency: number, sectionCount: number): number {
  const n = Math.max(0, sectionCount);
  const df = Math.min(Math.max(0, documentFrequency), n);
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/** tf̃(t,d): the weighted, length-normalized term frequency summed over fields. */
export function bm25fPseudoFrequency(
  tf: FieldValues,
  lengths: FieldValues,
  averageFieldLengths: FieldValues,
  params: Bm25fParams,
): number {
  let total = 0;
  for (const f of FIELDS) {
    const freq = tf[f];
    const weight = params.weights[f];
    if (freq <= 0 || weight <= 0) continue;
    const avg = averageFieldLengths[f];
    const b = params.b[f];
    // A field holding `freq` occurrences has at least `freq` tokens; clamping
    // keeps B_f > 0 even for inconsistent input (len 0 with b = 1).
    const length = Math.max(lengths[f], freq);
    const norm = avg > 0 ? 1 - b + (b * length) / avg : 1;
    total += (weight * freq) / norm;
  }
  return total;
}

/** s(t,d) = idf · tf̃ · (k1 + 1) / (k1 + tf̃), and 0 when tf̃ = 0. */
export function bm25fTermScore(idf: number, pseudoFrequency: number, params: Bm25fParams): number {
  if (pseudoFrequency <= 0) return 0;
  return (idf * pseudoFrequency * (params.k1 + 1)) / (params.k1 + pseudoFrequency);
}

/** Everything needed to score one section for a set of query terms. */
export interface Bm25fSectionInput {
  /** Field lengths of the section in tokens. */
  readonly lengths: FieldValues;
  /** Per-field term frequencies of each query term the section contains. */
  readonly termFrequencies: ReadonlyMap<string, FieldValues>;
}

/**
 * Scores one section: Σ over the distinct `terms` of s(t,d). A term the
 * section lacks adds 0; a term with no document frequency entry is scored
 * as if df = 0.
 */
export function bm25fScore(
  terms: Iterable<string>,
  section: Bm25fSectionInput,
  documentFrequencies: ReadonlyMap<string, number>,
  stats: CorpusStats,
  params: Bm25fParams = DEFAULT_BM25F_PARAMS,
): number {
  let score = 0;
  for (const term of new Set(terms)) {
    const tf = section.termFrequencies.get(term);
    if (!tf) continue;
    const idf = bm25Idf(documentFrequencies.get(term) ?? 0, stats.sectionCount);
    const pf = bm25fPseudoFrequency(tf, section.lengths, stats.averageFieldLengths, params);
    score += bm25fTermScore(idf, pf, params);
  }
  return score;
}
