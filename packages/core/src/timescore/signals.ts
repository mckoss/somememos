// Derived signals (PLAN.md section 3; the post's "What's trending").
//
// The difference of two stored log scores with different half-lives does not
// depend on `now`, so it can be stored and indexed and never needs rescoring.
//
// EMPTY handling: if either score is EMPTY the signal is EMPTY (-Infinity), so
// an item without activity sorts last and the result is never NaN. Both
// scores are folded from the same events, so in consistent data they are
// EMPTY together; a lone EMPTY can only come from inconsistent data, and is
// treated as "no signal" rather than +Infinity.
//
// The post adds two refinements that change the number but not the order:
// divide by `steadyRatio` so that 1.0 means an item's usual pace, and rank only
// items with enough recent activity (for example the 100 highest week
// scores), because an item whose only event is today has the highest ratio
// of all.

import { HALF_LIVES } from './halfLives.js';
import { EMPTY, type LogScore } from './timescore.js';

/** `a − b` for two stored log scores, or EMPTY if either is EMPTY. */
export function logScoreDifference(a: LogScore, b: LogScore): number {
  if (a === EMPTY || b === EMPTY) return EMPTY;
  return a - b;
}

/** Trending (heating up): `L_week − L_month`. Higher is hotter. */
export function trending(week: LogScore, month: LogScore): number {
  return logScoreDifference(week, month);
}

/** Neglected (cooling but important): `L_year − L_month`. Higher is more neglected. */
export function neglected(year: LogScore, month: LogScore): number {
  return logScoreDifference(year, month);
}

/**
 * The current ratio of the two decayed scores, `S_a(now) / S_b(now)`, from
 * their stored difference `d = L_a − L_b`:
 * `e^(d − now · (1/h_a − 1/h_b) · ln 2)`. EMPTY `d` gives 0.
 */
export function ratioAt(d: number, now: number, halfLifeA: number, halfLifeB: number): number {
  return Math.exp(d - now * (1 / halfLifeA - 1 / halfLifeB) * Math.LN2);
}

/**
 * The ratio `S_a / S_b` of an item with steady activity (one value-1 event
 * every `interval`, forever), measured just after an event:
 * `(1 − 2^(−interval/h_b)) / (1 − 2^(−interval/h_a))`.
 */
export function steadyRatio(halfLifeA: number, halfLifeB: number, interval: number): number {
  return (
    -Math.expm1((-interval * Math.LN2) / halfLifeB) /
    -Math.expm1((-interval * Math.LN2) / halfLifeA)
  );
}

/** `steadyRatio` for trending (week over month) with daily activity. */
export const STEADY_TRENDING_RATIO = steadyRatio(HALF_LIVES.week, HALF_LIVES.month, 86_400);
