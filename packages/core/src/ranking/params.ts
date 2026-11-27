// Ranking parameters (PLAN.md section 5; IMPLEMENTATION.md task 1.12).
//
// Every value here is a PLACEHOLDER until `somememos eval` measures it. The
// project's rule is that no ranking parameter is chosen by intuition, so each
// default below is the simplest neutral choice, not a tuned one, and every one
// can be overridden per call (and per experiment setting).

import type { Bm25fParamsOverride } from '../keyword/bm25f.js';
import type { MatchMode } from '../keyword/search.js';
import type { NoteRole } from '../storage/types.js';
import type { BrainConfig } from '../storage/config.js';
import { UNIT_WEIGHTS, assertValidWeights, type Weights } from '../timescore/weights.js';

/** The four ranking modes (PLAN.md section 5 table). */
export type RankMode = 'hot' | 'trending' | 'neglected' | 'all';

export const RANK_MODES: readonly RankMode[] = Object.freeze([
  'hot',
  'trending',
  'neglected',
  'all',
]);

/** Whether `mode` is a ranking mode. */
export function isRankMode(mode: unknown): mode is RankMode {
  return typeof mode === 'string' && (RANK_MODES as readonly string[]).includes(mode);
}

/**
 * How a keyword search combines relevance `r` with a mode's activation signal.
 *
 * - `'sum'`: rank key `ln(r) + alpha · signal`. For `hot` this is PLAN's
 *   `ln(r) + α · L_h`; for `trending` and `neglected` the signal is the
 *   difference of two log scores (`L_week − L_month`, `L_year − L_month`).
 * - `'rerank'`: "relevance, then signal" read literally: take the
 *   `rerankDepth` most relevant notes, order them by the signal (ties by
 *   relevance), and put the remaining notes after them in relevance order.
 *   `alpha` is unused.
 */
export type KeywordCombination = 'sum' | 'rerank';

/** Which way activation spreads across `[[links]]`. `'off'` disables spreading. */
export type SpreadDirection = 'off' | 'outgoing' | 'backlinks' | 'both';

/**
 * The value used for a candidate whose signal is EMPTY (no events, or no
 * events of a weighted kind), in a keyword search where it still matches.
 *
 * - `relative`: the lowest finite signal among this search's candidates,
 *   plus `offset` (in log units; `-Math.LN2` means "half as active as the
 *   least active match", the placeholder default; with 0, a single active
 *   match would gain nothing over inactive ones). Time-invariant, but it
 *   depends on the candidate set. When no candidate has a finite signal,
 *   every candidate's activation term is 0 (relevance only).
 * - `absolute`: a fixed signal value. For `hot` it is a log score, so it only
 *   makes sense for one half-life and one epoch range; mainly for experiments.
 */
export type ActivationFloor =
  | { readonly mode: 'relative'; readonly offset: number }
  | { readonly mode: 'absolute'; readonly value: number };

/** Which half-life (by name, as folded) drives each mode. */
export interface ModeHalfLives {
  /** `hot` (and `all` without keywords) ranks by `L_hot`. */
  readonly hot: string;
  /** `trending` is `L_trendingFast − L_trendingSlow`. */
  readonly trendingFast: string;
  readonly trendingSlow: string;
  /** `neglected` is `L_neglectedLong − L_neglectedShort`. */
  readonly neglectedLong: string;
  readonly neglectedShort: string;
}

/** Link spreading: computed at query time, one hop, never stored. */
export interface SpreadingParams {
  readonly direction: SpreadDirection;
  /** Strength β ≥ 0: neighbors count as `ln β + combine(L_neighbor)`. β = 0 is off. */
  readonly beta: number;
}

/** Every ranking parameter, resolved. */
export interface RankingParams {
  /** Per-kind weights applied when scores are read. */
  readonly weights: Weights;
  /** Weight of the activation signal in `ln(r) + alpha · signal`. ≥ 0. */
  readonly alpha: number;
  readonly halfLives: ModeHalfLives;
  /** BM25F overrides for keyword search. */
  readonly keyword: Bm25fParamsOverride;
  /** Keyword match mode: any clause, or all of them. */
  readonly matchMode: MatchMode;
  /** How relevance and signal combine, per mode (`all` is always relevance only). */
  readonly combination: Readonly<Record<'hot' | 'trending' | 'neglected', KeywordCombination>>;
  /** How many of the most relevant notes `'rerank'` reorders. ≥ 1. */
  readonly rerankDepth: number;
  /** What an EMPTY signal counts as in a keyword search. */
  readonly floor: ActivationFloor;
  readonly spreading: SpreadingParams;
  /**
   * Keyword-less `trending` ranks only the `trendingCandidates` items with the
   * highest `L_trendingFast` (the post: "one recent event is all trend").
   */
  readonly trendingCandidates: number;
  /**
   * Keyword-less `neglected` ranks only the `neglectedCandidates` items with
   * the highest `L_neglectedLong`, so an item with one old event and nothing
   * else (the highest `L_year − L_month` of all) doesn't dominate. Time-invariant.
   */
  readonly neglectedCandidates: number;
  /**
   * An extra, time-dependent guard for keyword-less `neglected`: the decayed
   * long score at `now` must be at least this. 0 (default) is off; requires
   * `now` and `halfLifeSeconds` when > 0.
   */
  readonly neglectedMinLongScore: number;
  /** Roles a keyword search returns. Activation lists always show scored notes (memos, blog posts) and dangling items. */
  readonly searchRoles: readonly NoteRole[];
  /** Return at most this many results. Default: all. */
  readonly limit: number | undefined;
  /** "Now" in Unix seconds, used only for time-dependent guards and display. */
  readonly now: number | undefined;
  /** Half-life lengths by name, needed only when `now` is used. */
  readonly halfLifeSeconds: Readonly<Record<string, number>> | undefined;
}

/** A partial `RankingParams`; nested objects are partial too. */
export interface RankingParamsInput {
  readonly weights?: Partial<Weights>;
  readonly alpha?: number;
  readonly halfLives?: Partial<ModeHalfLives>;
  readonly keyword?: Bm25fParamsOverride;
  readonly matchMode?: MatchMode;
  readonly combination?: Partial<RankingParams['combination']>;
  readonly rerankDepth?: number;
  readonly floor?: ActivationFloor;
  readonly spreading?: Partial<SpreadingParams>;
  readonly trendingCandidates?: number;
  readonly neglectedCandidates?: number;
  readonly neglectedMinLongScore?: number;
  readonly searchRoles?: readonly NoteRole[];
  readonly limit?: number;
  readonly now?: number;
  readonly halfLifeSeconds?: Readonly<Record<string, number>>;
}

/** The placeholder defaults. None of them is measured yet. */
export const DEFAULT_RANKING_PARAMS: RankingParams = Object.freeze({
  weights: UNIT_WEIGHTS,
  alpha: 1,
  halfLives: Object.freeze({
    hot: 'week',
    trendingFast: 'week',
    trendingSlow: 'month',
    neglectedLong: 'year',
    neglectedShort: 'month',
  }),
  keyword: Object.freeze({}),
  matchMode: 'any',
  combination: Object.freeze({ hot: 'sum', trending: 'sum', neglected: 'sum' }),
  rerankDepth: 20,
  floor: Object.freeze({ mode: 'relative', offset: -Math.LN2 }),
  spreading: Object.freeze({ direction: 'off', beta: 0.5 }),
  trendingCandidates: 100,
  neglectedCandidates: 100,
  neglectedMinLongScore: 0,
  searchRoles: Object.freeze(['memo', 'dated', 'source', 'blog'] as const),
  limit: undefined,
  now: undefined,
  halfLifeSeconds: undefined,
} satisfies RankingParams);

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, not ${value}`);
  }
}

function nonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0, not ${value}`);
  }
}

/** Throws a RangeError if a parameter is out of range. */
export function validateRankingParams(p: RankingParams): void {
  assertValidWeights(p.weights);
  nonNegative('alpha', p.alpha);
  for (const [key, name] of Object.entries(p.halfLives)) {
    if (typeof name !== 'string' || name === '') {
      throw new RangeError(`halfLives.${key} must be a half-life name`);
    }
  }
  if (p.matchMode !== 'any' && p.matchMode !== 'all') {
    throw new RangeError(`matchMode must be 'any' or 'all', not ${String(p.matchMode)}`);
  }
  for (const [mode, c] of Object.entries(p.combination)) {
    if (c !== 'sum' && c !== 'rerank') {
      throw new RangeError(`combination.${mode} must be 'sum' or 'rerank', not ${String(c)}`);
    }
  }
  positiveInteger('rerankDepth', p.rerankDepth);
  if (p.floor.mode === 'relative') {
    if (!Number.isFinite(p.floor.offset)) throw new RangeError('floor.offset must be finite');
  } else if (p.floor.mode === 'absolute') {
    if (!Number.isFinite(p.floor.value)) throw new RangeError('floor.value must be finite');
  } else {
    throw new RangeError(`floor.mode must be 'relative' or 'absolute'`);
  }
  if (!['off', 'outgoing', 'backlinks', 'both'].includes(p.spreading.direction)) {
    throw new RangeError(`spreading.direction is invalid: ${String(p.spreading.direction)}`);
  }
  nonNegative('spreading.beta', p.spreading.beta);
  positiveInteger('trendingCandidates', p.trendingCandidates);
  positiveInteger('neglectedCandidates', p.neglectedCandidates);
  nonNegative('neglectedMinLongScore', p.neglectedMinLongScore);
  if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || p.limit < 0)) {
    throw new RangeError(`limit must be an integer >= 0, not ${p.limit}`);
  }
  if (p.now !== undefined && !Number.isFinite(p.now)) throw new RangeError('now must be finite');
  if (p.neglectedMinLongScore > 0 && (p.now === undefined || p.halfLifeSeconds === undefined)) {
    throw new RangeError('neglectedMinLongScore > 0 needs now and halfLifeSeconds');
  }
}

/** Fills `input` in over `base` (default `DEFAULT_RANKING_PARAMS`) and validates. */
export function resolveRankingParams(
  input: RankingParamsInput = {},
  base: RankingParams = DEFAULT_RANKING_PARAMS,
): RankingParams {
  const p: RankingParams = {
    weights: { ...base.weights, ...input.weights },
    alpha: input.alpha ?? base.alpha,
    halfLives: { ...base.halfLives, ...input.halfLives },
    keyword: input.keyword ?? base.keyword,
    matchMode: input.matchMode ?? base.matchMode,
    combination: { ...base.combination, ...input.combination },
    rerankDepth: input.rerankDepth ?? base.rerankDepth,
    floor: input.floor ?? base.floor,
    spreading: { ...base.spreading, ...input.spreading },
    trendingCandidates: input.trendingCandidates ?? base.trendingCandidates,
    neglectedCandidates: input.neglectedCandidates ?? base.neglectedCandidates,
    neglectedMinLongScore: input.neglectedMinLongScore ?? base.neglectedMinLongScore,
    searchRoles: input.searchRoles ?? base.searchRoles,
    limit: 'limit' in input ? input.limit : base.limit,
    now: 'now' in input ? input.now : base.now,
    halfLifeSeconds: 'halfLifeSeconds' in input ? input.halfLifeSeconds : base.halfLifeSeconds,
  };
  validateRankingParams(p);
  return p;
}

/** The ranking parameters a brain's config sets: weights, alpha, keyword params and half-life lengths. */
export function rankingParamsFromConfig(config: BrainConfig): RankingParamsInput {
  return {
    weights: config.weights,
    alpha: config.alpha,
    keyword: config.keyword,
    halfLifeSeconds: config.halfLives,
  };
}

/** Whether spreading changes anything with these parameters. */
export function spreadingActive(p: RankingParams): boolean {
  return p.spreading.direction !== 'off' && p.spreading.beta > 0;
}
