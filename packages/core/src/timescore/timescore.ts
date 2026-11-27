// TimeScore: a time-weighted score, stored as a single number per item.
//
// TimeScore algorithm courtesy Mike Koss (https://mckoss.com/posts/timescore/).
// The canonical description is that post; PLAN.md section 3 restates it.
//
// Every event is worth its full value when it happens and halves every
// half-life. Rather than fading old events, each event is boosted by
// 2^(time / halfLife) when it is added, and the item stores the natural log of
// the sum (its "log score"). Every item fades at the same rate, so the stored
// numbers never change between events and sorting by them ranks items by their
// current score.
//
// somememos measures time in seconds since the Unix epoch, and half-lives in
// seconds. The epoch must never change.

/** A stored (time-invariant, natural-log) score. */
export type LogScore = number;

/** The stored score of an item with no events yet (`NULL` in SQL). */
export const EMPTY: LogScore = -Infinity;

/**
 * The stored score of a single event: `ln(value · 2^(time / halfLife))`.
 * Throws a RangeError unless `value > 0`.
 */
export function eventScore(value: number, time: number, halfLife: number): LogScore {
  if (!(value > 0)) throw new RangeError(`TimeScore values must be greater than 0, not ${value}`);
  return Math.log(value) + (time * Math.LN2) / halfLife;
}

/**
 * Two stored scores merged into one, as if one item had had both scores'
 * events: `ln(e^a + e^b)`, computed without leaving the log domain.
 * Commutative (exactly) and associative (to rounding).
 */
export function combine(a: LogScore, b: LogScore): LogScore {
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  if (low === -Infinity) return high;
  return high + Math.log1p(Math.exp(low - high));
}

/** Add an event to an item's stored score and return the new stored score. */
export function addEvent(
  logScore: LogScore,
  value: number,
  time: number,
  halfLife: number,
): LogScore {
  return combine(logScore, eventScore(value, time, halfLife));
}

/**
 * An item's decayed score at time `now`, at or after its latest event: the sum
 * of its events' values, each halved for every half-life since it happened.
 */
export function scoreAt(logScore: LogScore, now: number, halfLife: number): number {
  return Math.exp(logScore - (now * Math.LN2) / halfLife);
}

/**
 * Many stored scores merged into one: `ln Σ e^(s_i)`. `EMPTY` entries add
 * nothing, and no scores give `EMPTY`.
 *
 * The result depends only on the multiset of scores, never on their order:
 * they are sorted before summing (smallest first, which is also the most
 * accurate order). For two scores it equals `combine(a, b)` exactly. A
 * left fold of `combine` over the same scores agrees to rounding only.
 */
export function combineAll(scores: Iterable<LogScore>): LogScore {
  const finite: number[] = [];
  for (const s of scores) {
    if (Number.isNaN(s)) return NaN;
    if (s !== -Infinity) finite.push(s);
  }
  if (finite.length === 0) return EMPTY;
  finite.sort((x, y) => x - y);
  const high = finite[finite.length - 1] as number;
  let rest = 0;
  for (let i = 0; i < finite.length - 1; i++) rest += Math.exp((finite[i] as number) - high);
  return high + Math.log1p(rest);
}
