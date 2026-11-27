// Ranking: pure functions over plain data (IMPLEMENTATION.md task 1.12). The
// store-backed entry points (./stores.ts) and the evaluation harness both call
// these, so an experiment ranks exactly as the CLI does.
//
// Time-invariance (PLAN.md section 5). Every comparison is between stored log
// scores or their differences, never decayed values, so the order is the same
// for any `now`. The one exception is the opt-in `neglectedMinLongScore` guard.

import type { Snippet } from '../keyword/snippet.js';
import type { SearchHit } from '../keyword/search.js';
import { isScoredRole } from '../markdown/roles.js';
import type { NoteRole } from '../storage/types.js';
import { parseSectionId } from '../storage/validate.js';
import type { ItemScores } from '../timescore/events.js';
import { EMPTY, scoreAt, type LogScore } from '../timescore/timescore.js';
import {
  itemActivation,
  modeSignal,
  NO_LINKS,
  type Activation,
  type LinkGraph,
  type ScoreMap,
} from './activation.js';
import type { RankMode, RankingParams } from './params.js';

/** What ranking needs to know about a note. `storage.NoteRecord` fits. */
export interface NoteMeta {
  readonly path: string;
  readonly title: string;
  readonly role: NoteRole;
}

/** The data ranking reads: scores, note metadata and (for spreading) links. */
export interface RankContext {
  /** Every item's folded scores. Items without events are absent. */
  readonly scores: ScoreMap;
  /** Notes by path. A scored item that is not here is a dangling key (see `classifyItem`). */
  readonly notes: ReadonlyMap<string, NoteMeta>;
  /** Needed only when spreading is on. */
  readonly links?: LinkGraph;
}

/** A keyword hit on a section, as `keyword.searchSource` returns it, optionally with display fields. */
export interface SectionHit extends Pick<SearchHit, 'id' | 'score'> {
  readonly heading?: string | null;
}

/** The explanation of a result's rank key (PLAN.md section 5, last bullet). */
export interface RankComponents {
  readonly mode: RankMode;
  /** BM25F relevance `r` of the best section; null without keywords. */
  readonly relevance: number | null;
  /** The item's raw stored log scores, per half-life, per kind (unweighted). */
  readonly kinds: ItemScores<string>;
  /** Weighted totals `L_h` per half-life, after spreading. */
  readonly activation: Readonly<Record<string, LogScore>>;
  /** Weighted totals of the item's own events. */
  readonly ownActivation: Readonly<Record<string, LogScore>>;
  /** What spreading added per half-life (`ln β + combine(L_neighbor)`); null when off. */
  readonly spread: Readonly<Record<string, LogScore>> | null;
  readonly trending: number;
  readonly neglected: number;
  /** The mode's signal (`L_hot`, trending or neglected); EMPTY when the item has none. */
  readonly signal: number;
  /** The signal after the floor; null when it contributed nothing (no finite signal anywhere, or `all`). */
  readonly signalUsed: number | null;
  /** True when `signal` was EMPTY and the floor stood in for it. */
  readonly floored: boolean;
  readonly alpha: number;
  /** True when the item was in the head reordered by `'rerank'`. */
  readonly reranked: boolean;
  /** The two terms of the rank key; `relevance + activation === rankKey`. */
  readonly terms: { readonly relevance: number; readonly activation: number };
}

export interface RankedResult {
  /** The scored item: a note path or a dangling key. */
  readonly item: string;
  /** The note path, or null for a dangling item. */
  readonly path: string | null;
  readonly dangling: boolean;
  /** The note's title, or the dangling key. */
  readonly title: string;
  /** The best-matching section (keyword search only). */
  readonly sectionId: string | null;
  readonly heading: string | null;
  /** Filled in by `rankSearch`; the pure functions leave it null. */
  readonly snippet: Snippet | null;
  /** Higher ranks first. */
  readonly rankKey: number;
  readonly components: RankComponents;
}

/**
 * How an item takes part in activation lists:
 * - `'memo'`: a stored scored note (a memo or a blog post,
 *   `markdown.isScoredRole`): rankable.
 * - `'dangling'`: not a stored note, and not shaped like a note path: a
 *   dangling-link key (keys are lower-cased and never end in `.md`): rankable.
 * - `'excluded'`: a stored note of another role, or a `.md` path that is no
 *   longer stored (a deleted note): not rankable.
 */
export function classifyItem(
  item: string,
  notes: ReadonlyMap<string, NoteMeta>,
): 'memo' | 'dangling' | 'excluded' {
  const note = notes.get(item);
  if (note) return isScoredRole(note.role) ? 'memo' : 'excluded';
  return /\.md$/i.test(item) ? 'excluded' : 'dangling';
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function components(
  mode: RankMode,
  relevance: number | null,
  item: string,
  scores: ScoreMap,
  activation: Activation,
  signal: number,
  p: RankingParams,
): Omit<RankComponents, 'signalUsed' | 'floored' | 'reranked' | 'terms'> {
  return {
    mode,
    relevance,
    kinds: scores.get(item) ?? {},
    activation: activation.byHalfLife,
    ownActivation: activation.own,
    spread: activation.spread,
    trending: activation.trending,
    neglected: activation.neglected,
    signal,
    alpha: p.alpha,
  };
}

function limitResults(results: RankedResult[], p: RankingParams): RankedResult[] {
  return p.limit === undefined ? results : results.slice(0, p.limit);
}

interface Candidate {
  readonly item: string;
  readonly hit: SectionHit;
  readonly note: NoteMeta | undefined;
}

/**
 * Groups section hits so each note appears once, with its best section
 * (highest score; ties by section id). Hits whose id is not a section id are
 * ignored; notes whose role is not in `p.searchRoles` are dropped. A hit on
 * a note missing from `notes` is kept (role unknown).
 */
export function groupHitsByNote(
  hits: readonly SectionHit[],
  notes: ReadonlyMap<string, NoteMeta>,
  p: RankingParams,
): Candidate[] {
  const best = new Map<string, SectionHit>();
  for (const hit of hits) {
    const parsed = parseSectionId(hit.id);
    if (!parsed) continue;
    const prev = best.get(parsed.path);
    if (!prev || hit.score > prev.score || (hit.score === prev.score && hit.id < prev.id)) {
      best.set(parsed.path, hit);
    }
  }
  const out: Candidate[] = [];
  for (const [path, hit] of best) {
    const note = notes.get(path);
    if (note && !p.searchRoles.includes(note.role)) continue;
    out.push({ item: path, hit, note });
  }
  return out;
}

/**
 * Ranks keyword hits (one entry per matching section) for a mode:
 *
 * - `all`: `ln(r)` only.
 * - `hot`, `trending`, `neglected` with `combination[mode] === 'sum'`:
 *   `ln(r) + alpha · signal`, where the signal is `L_hot`, `L_fast − L_slow` or
 *   `L_long − L_short`. A candidate without a signal gets the floor
 *   (`p.floor`); `alpha = 0` gives keyword-only order.
 * - with `'rerank'`: the `rerankDepth` most relevant notes, ordered by signal
 *   (floored; ties by relevance), then the rest by relevance. The head's rank
 *   key is its signal, the tail's `ln(r)`.
 *
 * Ties are broken by relevance, then by item.
 */
export function rankKeywordHits(
  hits: readonly SectionHit[],
  ctx: RankContext,
  mode: RankMode,
  p: RankingParams,
): RankedResult[] {
  const candidates = groupHitsByNote(hits, ctx.notes, p);
  const graph = ctx.links ?? NO_LINKS;
  const rows = candidates.map((c) => {
    const activation = itemActivation(c.item, ctx.scores, p, graph);
    const signal = mode === 'all' ? EMPTY : modeSignal(activation, mode, p);
    return { c, activation, signal, lnR: Math.log(c.hit.score) };
  });

  // The floor, from the finite signals of this candidate set.
  let floorValue: number | null = null;
  if (mode !== 'all') {
    if (p.floor.mode === 'absolute') floorValue = p.floor.value;
    else {
      let min = Infinity;
      for (const r of rows) if (Number.isFinite(r.signal) && r.signal < min) min = r.signal;
      floorValue = min === Infinity ? null : min + p.floor.offset;
    }
  }
  const combination = mode === 'all' ? 'sum' : p.combination[mode];

  const build = (
    row: (typeof rows)[number],
    reranked: boolean,
    terms: { relevance: number; activation: number },
    signalUsed: number | null,
  ): RankedResult => ({
    item: row.c.item,
    path: row.c.item,
    dangling: false,
    title: row.c.note?.title ?? row.c.item,
    sectionId: row.c.hit.id,
    heading: row.c.hit.heading ?? null,
    snippet: null,
    rankKey: terms.relevance + terms.activation,
    components: {
      ...components(mode, row.c.hit.score, row.c.item, ctx.scores, row.activation, row.signal, p),
      signalUsed,
      floored: signalUsed !== null && !Number.isFinite(row.signal),
      reranked,
      terms,
    },
  });
  const used = (signal: number): number | null =>
    mode === 'all' ? null : Number.isFinite(signal) ? signal : floorValue;

  let results: RankedResult[];
  if (combination === 'sum') {
    results = rows.map((row) => {
      const s = used(row.signal);
      const activationTerm = s === null || p.alpha === 0 ? 0 : p.alpha * s;
      return build(row, false, { relevance: row.lnR, activation: activationTerm }, s);
    });
    results.sort(
      (a, b) =>
        b.rankKey - a.rankKey ||
        (b.components.relevance as number) - (a.components.relevance as number) ||
        compareStrings(a.item, b.item),
    );
  } else {
    const byRelevance = [...rows].sort(
      (a, b) => b.lnR - a.lnR || compareStrings(a.c.item, b.c.item),
    );
    const head = byRelevance.slice(0, p.rerankDepth);
    const tail = byRelevance.slice(p.rerankDepth);
    const headResults = head
      .map((row) => {
        const s = used(row.signal);
        return build(row, true, { relevance: 0, activation: s ?? 0 }, s);
      })
      .sort(
        (a, b) =>
          b.rankKey - a.rankKey ||
          (b.components.relevance as number) - (a.components.relevance as number) ||
          compareStrings(a.item, b.item),
      );
    const tailResults = tail.map((row) =>
      build(row, false, { relevance: row.lnR, activation: 0 }, used(row.signal)),
    );
    results = [...headResults, ...tailResults];
  }
  return limitResults(results, p);
}

/**
 * Ranks every rankable scored item (memo notes and dangling keys; see
 * `classifyItem`) by activation alone:
 *
 * - `hot` (and `all`): by `L_hot`.
 * - `trending`: among the `trendingCandidates` items with the highest
 *   `L_trendingFast`, by `L_fast − L_slow` (ties by `L_fast`).
 * - `neglected`: among the `neglectedCandidates` items with the highest
 *   `L_neglectedLong` (and, if `neglectedMinLongScore > 0`, a decayed long
 *   score at `now` of at least that), by `L_long − L_short` (ties by `L_long`).
 *
 * Items without the signal are left out. Ties are broken by item.
 */
export function rankByActivation(
  ctx: RankContext,
  mode: RankMode,
  p: RankingParams,
): RankedResult[] {
  const graph = ctx.links ?? NO_LINKS;
  const h = p.halfLives;
  type Row = {
    item: string;
    dangling: boolean;
    activation: Activation;
    signal: number;
    tie: number;
  };
  let rows: Row[] = [];
  for (const item of ctx.scores.keys()) {
    const kind = classifyItem(item, ctx.notes);
    if (kind === 'excluded') continue;
    const activation = itemActivation(item, ctx.scores, p, graph);
    rows.push({
      item,
      dangling: kind === 'dangling',
      activation,
      signal: modeSignal(activation, mode, p),
      tie: 0,
    });
  }

  const at = (row: Row, name: string): LogScore => row.activation.byHalfLife[name] ?? EMPTY;
  const topBy = (name: string, n: number): void => {
    rows = rows
      .filter((r) => Number.isFinite(at(r, name)))
      .sort((a, b) => at(b, name) - at(a, name) || compareStrings(a.item, b.item))
      .slice(0, n);
    for (const r of rows) r.tie = at(r, name);
  };
  if (mode === 'trending') topBy(h.trendingFast, p.trendingCandidates);
  if (mode === 'neglected') {
    topBy(h.neglectedLong, p.neglectedCandidates);
    if (p.neglectedMinLongScore > 0) {
      const now = p.now as number;
      const seconds = (p.halfLifeSeconds as Record<string, number>)[h.neglectedLong];
      if (seconds === undefined) throw new RangeError(`no length for half-life ${h.neglectedLong}`);
      rows = rows.filter(
        (r) => scoreAt(at(r, h.neglectedLong), now, seconds) >= p.neglectedMinLongScore,
      );
    }
  }

  const results = rows
    .filter((r) => Number.isFinite(r.signal))
    .sort((a, b) => b.signal - a.signal || b.tie - a.tie || compareStrings(a.item, b.item))
    .map((r): RankedResult => {
      const note = ctx.notes.get(r.item);
      return {
        item: r.item,
        path: r.dangling ? null : r.item,
        dangling: r.dangling,
        title: note?.title ?? r.item,
        sectionId: null,
        heading: null,
        snippet: null,
        rankKey: r.signal,
        components: {
          ...components(mode, null, r.item, ctx.scores, r.activation, r.signal, p),
          signalUsed: r.signal,
          floored: false,
          reranked: false,
          terms: { relevance: 0, activation: r.signal },
        },
      };
    });
  return limitResults(results, p);
}

/** `rankKeywordHits` when there are hits to rank, else `rankByActivation`: for callers with an optional query. */
export function rank(
  hits: readonly SectionHit[] | null,
  ctx: RankContext,
  mode: RankMode,
  p: RankingParams,
): RankedResult[] {
  return hits === null ? rankByActivation(ctx, mode, p) : rankKeywordHits(hits, ctx, mode, p);
}
