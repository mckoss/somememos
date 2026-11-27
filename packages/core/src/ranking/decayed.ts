// Display helper: turn a result's log scores into "score now" numbers (each
// event worth 1 when it happened, halved every half-life since). For display
// and explanation only; ranking never uses decayed values.

import { HALF_LIVES } from '../timescore/halfLives.js';
import { EVENT_KINDS, type EventKind } from '../timescore/kinds.js';
import { ratioAt, steadyRatio } from '../timescore/signals.js';
import { EMPTY, scoreAt } from '../timescore/timescore.js';
import { DEFAULT_RANKING_PARAMS, type ModeHalfLives } from './params.js';
import type { RankComponents } from './rank.js';

export interface DecayedView {
  /** Weighted activation now, per half-life (after spreading). */
  readonly activation: Readonly<Record<string, number>>;
  /** Unweighted per-kind scores now, per half-life. */
  readonly kinds: Readonly<Record<string, Partial<Record<EventKind, number>>>>;
  /** `S_fast(now) / S_slow(now)`; 0 without a trending signal. */
  readonly trendingRatio: number;
  /** `trendingRatio` divided by its steady value for daily activity: 1.0 is the item's usual pace. */
  readonly trendingPace: number;
  /** `S_long(now) / S_short(now)`; 0 without a neglected signal. */
  readonly neglectedRatio: number;
}

const DAY = 86_400;

/**
 * The decayed view of a result's components at `now`. `halfLifeSeconds`
 * gives each half-life's length (default `timescore.HALF_LIVES`); half-lives
 * it lacks are left out.
 */
export function decayed(
  components: Pick<RankComponents, 'activation' | 'kinds' | 'trending' | 'neglected'>,
  now: number,
  halfLifeSeconds: Readonly<Record<string, number>> = HALF_LIVES,
  modeHalfLives: ModeHalfLives = DEFAULT_RANKING_PARAMS.halfLives,
): DecayedView {
  const activation: Record<string, number> = {};
  for (const [name, L] of Object.entries(components.activation)) {
    const h = halfLifeSeconds[name];
    if (h !== undefined) activation[name] = L === EMPTY ? 0 : scoreAt(L, now, h);
  }
  const kinds: Record<string, Partial<Record<EventKind, number>>> = {};
  for (const [name, byKind] of Object.entries(components.kinds)) {
    const h = halfLifeSeconds[name];
    if (h === undefined) continue;
    const out: Partial<Record<EventKind, number>> = {};
    for (const kind of EVENT_KINDS) {
      const L = byKind[kind];
      if (L !== undefined) out[kind] = scoreAt(L, now, h);
    }
    kinds[name] = out;
  }
  const ratio = (d: number, a: string, b: string): number => {
    const ha = halfLifeSeconds[a];
    const hb = halfLifeSeconds[b];
    if (ha === undefined || hb === undefined || d === EMPTY) return 0;
    return ratioAt(d, now, ha, hb);
  };
  const m = modeHalfLives;
  const trendingRatio = ratio(components.trending, m.trendingFast, m.trendingSlow);
  const fast = halfLifeSeconds[m.trendingFast];
  const slow = halfLifeSeconds[m.trendingSlow];
  const steady = fast !== undefined && slow !== undefined ? steadyRatio(fast, slow, DAY) : NaN;
  return {
    activation,
    kinds,
    trendingRatio,
    trendingPace: Number.isFinite(steady) && steady > 0 ? trendingRatio / steady : 0,
    neglectedRatio: ratio(components.neglected, m.neglectedLong, m.neglectedShort),
  };
}
