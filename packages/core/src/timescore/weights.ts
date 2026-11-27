// Read-time weighting (PLAN.md section 4, "The event log"):
//
//   L(item, h) = logsumexp over kinds k of ( ln w_k + L_k(item, h) )
//
// Scores are stored per kind and unweighted, so changing a weight needs no
// rebuild. Weights are set by experiment (`somememos eval`), not intuition.

import { EVENT_KINDS, type EventKind } from './kinds.js';
import { combineAll, EMPTY, type LogScore } from './timescore.js';

/** An item's log scores for one half-life, by kind. A missing kind has no events. */
export type ScoresByKind = Partial<Record<EventKind, LogScore>>;

/** A weight (>= 0) for every kind. 0 excludes the kind. */
export type Weights = Readonly<Record<EventKind, number>>;

/**
 * Every weight 1. PLAN.md: until an experiment has measured them, every weight
 * is 1. That is a placeholder, not a choice.
 */
export const UNIT_WEIGHTS: Weights = Object.freeze({ read: 1, edit: 1, mention: 1 });

/** Throws a RangeError unless every kind has a finite weight >= 0. */
export function assertValidWeights(weights: Weights): void {
  for (const kind of EVENT_KINDS) {
    const w = weights[kind];
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
      throw new RangeError(`weight for ${kind} must be a finite number >= 0, not ${String(w)}`);
    }
  }
}

/**
 * The weighted total of an item's per-kind log scores for one half-life:
 * `ln Σ_k w_k · e^(L_k)`. A missing kind or an `EMPTY` score adds nothing, and
 * a weight of 0 excludes its kind. Returns `EMPTY` when nothing contributes.
 * Throws a RangeError for a negative, non-finite or missing weight.
 */
export function weightedTotal(scoresByKind: ScoresByKind, weights: Weights): LogScore {
  assertValidWeights(weights);
  const terms: number[] = [];
  for (const kind of EVENT_KINDS) {
    const score = scoresByKind[kind];
    const w = weights[kind];
    if (score === undefined || score === EMPTY || w === 0) continue;
    terms.push(Math.log(w) + score);
  }
  return combineAll(terms);
}
