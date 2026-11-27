// Item activation: from an item's per-kind, per-half-life log scores, the
// weighted totals `L_h` (PLAN.md section 4), optional link spreading, and the
// derived trending and neglected signals (PLAN.md section 3). Pure.

import type { ItemScores } from '../timescore/events.js';
import { neglected, trending } from '../timescore/signals.js';
import { EMPTY, combine, combineAll, type LogScore } from '../timescore/timescore.js';
import { weightedTotal } from '../timescore/weights.js';
import { spreadingActive, type RankingParams, type SpreadDirection } from './params.js';

/** An item's scores as folded: per half-life, per kind. */
export type ScoreMap = ReadonlyMap<string, ItemScores<string>>;

/** The link graph, for spreading. Synchronous; prefetch it from storage. */
export interface LinkGraph {
  /** Targets of the item's outgoing links (note paths or dangling keys). */
  outgoing(item: string): readonly string[];
  /** Notes that link to the item. */
  backlinks(item: string): readonly string[];
}

/** A link graph from plain maps (missing items have no links). */
export function linkGraphFromMaps(
  outgoing: ReadonlyMap<string, readonly string[]>,
  backlinks?: ReadonlyMap<string, readonly string[]>,
): LinkGraph {
  let back = backlinks;
  if (!back) {
    const built = new Map<string, string[]>();
    for (const [source, targets] of outgoing) {
      for (const target of targets) {
        let list = built.get(target);
        if (!list) built.set(target, (list = []));
        list.push(source);
      }
    }
    back = built;
  }
  const b = back;
  return {
    outgoing: (item) => outgoing.get(item) ?? [],
    backlinks: (item) => b.get(item) ?? [],
  };
}

/** The empty graph. */
export const NO_LINKS: LinkGraph = Object.freeze({ outgoing: () => [], backlinks: () => [] });

/** Everything known about an item's activation, for ranking and explaining it. */
export interface Activation {
  /** Weighted totals per half-life, after spreading (equal to `own` when spreading is off). */
  readonly byHalfLife: Readonly<Record<string, LogScore>>;
  /** Weighted totals per half-life of the item's own events. */
  readonly own: Readonly<Record<string, LogScore>>;
  /** `ln β + combine(L_neighbor)` per half-life; null when spreading is off. */
  readonly spread: Readonly<Record<string, LogScore>> | null;
  /** `L_trendingFast − L_trendingSlow` (EMPTY when either is EMPTY). */
  readonly trending: number;
  /** `L_neglectedLong − L_neglectedShort` (EMPTY when either is EMPTY). */
  readonly neglected: number;
}

/** The half-life names an item's scores have, or the mode half-lives when it has none. */
function halfLifeNames(scores: ItemScores<string> | undefined, p: RankingParams): string[] {
  const names = new Set<string>(Object.values(p.halfLives));
  if (scores) for (const name of Object.keys(scores)) names.add(name);
  return [...names].sort();
}

/** Weighted totals `L_h` of one item's own scores, for every half-life it has (and the mode ones). */
export function weightedTotals(
  scores: ItemScores<string> | undefined,
  p: RankingParams,
): Record<string, LogScore> {
  const out: Record<string, LogScore> = {};
  for (const name of halfLifeNames(scores, p)) {
    const byKind = scores?.[name];
    out[name] = byKind ? weightedTotal(byKind, p.weights) : EMPTY;
  }
  return out;
}

/** The distinct neighbors of `item` in `direction`, without `item` itself, sorted. */
export function neighborsOf(item: string, graph: LinkGraph, direction: SpreadDirection): string[] {
  if (direction === 'off') return [];
  const out = new Set<string>();
  if (direction === 'outgoing' || direction === 'both')
    for (const n of graph.outgoing(item)) out.add(n);
  if (direction === 'backlinks' || direction === 'both')
    for (const n of graph.backlinks(item)) out.add(n);
  out.delete(item);
  return [...out].sort();
}

/**
 * An item's activation. With spreading on, each half-life's total is
 * `combine(L_item, ln β + combineAll(L_neighbor))`, one hop, using the
 * neighbors' own (unspread) weighted totals. Trending and neglected are then
 * derived from those effective totals.
 */
export function itemActivation(
  item: string,
  scores: ScoreMap,
  p: RankingParams,
  graph: LinkGraph = NO_LINKS,
): Activation {
  const own = weightedTotals(scores.get(item), p);
  let byHalfLife: Record<string, LogScore> = own;
  let spread: Record<string, LogScore> | null = null;
  if (spreadingActive(p)) {
    const neighbors = neighborsOf(item, graph, p.spreading.direction).map((n) =>
      weightedTotals(scores.get(n), p),
    );
    const lnBeta = Math.log(p.spreading.beta);
    spread = {};
    byHalfLife = {};
    for (const name of Object.keys(own)) {
      const fromNeighbors = combineAll(neighbors.map((n) => n[name] ?? EMPTY));
      const s = fromNeighbors === EMPTY ? EMPTY : lnBeta + fromNeighbors;
      spread[name] = s;
      byHalfLife[name] = combine(own[name] as LogScore, s);
    }
  }
  const h = p.halfLives;
  const at = (name: string): LogScore => byHalfLife[name] ?? EMPTY;
  return {
    byHalfLife,
    own,
    spread,
    trending: trending(at(h.trendingFast), at(h.trendingSlow)),
    neglected: neglected(at(h.neglectedLong), at(h.neglectedShort)),
  };
}

/** The signal a mode ranks by: `L_hot`, trending, or neglected. `all` uses `L_hot` (keyword-less only). */
export function modeSignal(
  activation: Activation,
  mode: 'hot' | 'trending' | 'neglected' | 'all',
  p: RankingParams,
): number {
  if (mode === 'trending') return activation.trending;
  if (mode === 'neglected') return activation.neglected;
  return activation.byHalfLife[p.halfLives.hot] ?? EMPTY;
}
