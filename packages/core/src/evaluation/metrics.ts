// Offline ranking metrics (PLAN.md section 5, "Evaluation"; IMPLEMENTATION.md
// task 1.19). They compare setups; they never touch a score.
//
// Conventions. A ranking is a list of item ids, best first; repeats after the
// first occurrence are ignored. A case whose relevant set is empty has no
// defined recall or reciprocal rank: the functions return null for it and
// the aggregates count it as skipped. A relevant item missing from the
// ranking simply is never found (it lowers recall; it can't help MRR).

function distinctPrefix(ranked: readonly string[], k: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of ranked) {
    if (out.length >= k) break;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Share of `relevant` items in the top `k` of `ranked`; null when `relevant` is empty. */
export function recallAtK(
  ranked: readonly string[],
  relevant: Iterable<string>,
  k: number,
): number | null {
  if (!Number.isSafeInteger(k) || k < 1)
    throw new RangeError(`k must be a positive integer, not ${k}`);
  const rel = new Set(relevant);
  if (rel.size === 0) return null;
  let found = 0;
  for (const item of distinctPrefix(ranked, k)) if (rel.has(item)) found++;
  return found / rel.size;
}

/** `1 / position` of the first relevant item (1-based), 0 if none appears; null when `relevant` is empty. */
export function reciprocalRank(
  ranked: readonly string[],
  relevant: Iterable<string>,
): number | null {
  const rel = new Set(relevant);
  if (rel.size === 0) return null;
  const list = distinctPrefix(ranked, Infinity);
  const i = list.findIndex((item) => rel.has(item));
  return i === -1 ? 0 : 1 / (i + 1);
}

/** One ranked case: what the ranking returned and what was right. */
export interface ScoredCase {
  readonly ranked: readonly string[];
  readonly relevant: readonly string[];
}

/** Mean reciprocal rank over the cases with a relevant set; `cases` counts them, `skipped` the rest. */
export function meanReciprocalRank(cases: Iterable<ScoredCase>): {
  readonly mrr: number;
  readonly cases: number;
  readonly skipped: number;
} {
  let sum = 0;
  let n = 0;
  let skipped = 0;
  for (const c of cases) {
    const rr = reciprocalRank(c.ranked, c.relevant);
    if (rr === null) skipped++;
    else {
      sum += rr;
      n++;
    }
  }
  return { mrr: n === 0 ? 0 : sum / n, cases: n, skipped };
}

/** Aggregate metrics over a set of cases. */
export interface Aggregate {
  /** Cases scored (with a non-empty relevant set). */
  readonly cases: number;
  /** Cases skipped because their relevant set was empty. */
  readonly skipped: number;
  /** Mean recall@k, keyed by k. 0 when no case was scored. */
  readonly recall: Readonly<Record<number, number>>;
  /** Mean reciprocal rank. 0 when no case was scored. */
  readonly mrr: number;
}

/** The default cutoffs reported. */
export const DEFAULT_KS: readonly number[] = Object.freeze([1, 5, 10, 20]);

/** Mean recall@k for each k, MRR, and the case counts. */
export function aggregate(
  cases: Iterable<ScoredCase>,
  ks: readonly number[] = DEFAULT_KS,
): Aggregate {
  const sums = new Map<number, number>(ks.map((k) => [k, 0]));
  let rrSum = 0;
  let n = 0;
  let skipped = 0;
  for (const c of cases) {
    const rr = reciprocalRank(c.ranked, c.relevant);
    if (rr === null) {
      skipped++;
      continue;
    }
    n++;
    rrSum += rr;
    for (const k of ks)
      sums.set(k, (sums.get(k) as number) + (recallAtK(c.ranked, c.relevant, k) as number));
  }
  const recall: Record<number, number> = {};
  for (const k of ks) recall[k] = n === 0 ? 0 : (sums.get(k) as number) / n;
  return { cases: n, skipped, recall, mrr: n === 0 ? 0 : rrSum / n };
}
