// The replay runner (PLAN.md section 5, "Evaluation"; IMPLEMENTATION.md tasks
// 1.20 and 1.22): for each case, fold only the events before the case's time,
// rank with the same pure functions the CLI uses, and score the ranking.
//
// Folding is incremental. Cases are taken in time order, and each distinct
// fold setting (half-lives, burst rule) keeps one in-memory score table that
// advances from one case time to the next: new events are folded with
// `timescore.foldEvents` and combined into the table, and a rename record
// moves the old name's scores to the new name, exactly as `storage.foldPending`
// does for a time-ordered log. Renames at the same second move together, as
// one simultaneous step (`storage.RenameIndex`: they never chain into each
// other, and of several renames of one item the smallest id applies). An
// entry dated at or after a case's time is never folded for that case.

import type { PostingsSource } from '../keyword/search.js';
import { searchSource } from '../keyword/search.js';
import type { HalfLives } from '../storage/types.js';
import { assertValidHalfLives, compareStrings } from '../storage/validate.js';
import { foldEvents, type ItemScores, type ScoreEvent } from '../timescore/events.js';
import { HALF_LIVES } from '../timescore/halfLives.js';
import { EVENT_KINDS } from '../timescore/kinds.js';
import { combine } from '../timescore/timescore.js';
import type { ScoresByKind } from '../timescore/weights.js';
import type { LinkGraph } from '../ranking/activation.js';
import {
  resolveRankingParams,
  spreadingActive,
  type RankMode,
  type RankingParams,
  type RankingParamsInput,
} from '../ranking/params.js';
import {
  rankByActivation,
  rankKeywordHits,
  type NoteMeta,
  type RankContext,
} from '../ranking/rank.js';
import type { EvalCase } from './cases.js';
import {
  collapseBursts,
  isRename,
  timeOrdered,
  type ReplayRename,
  type BurstOptions,
  type ReplayEntry,
} from './log.js';
import {
  DEFAULT_KS,
  aggregate,
  reciprocalRank,
  recallAtK,
  type Aggregate,
  type ScoredCase,
} from './metrics.js';

type Awaitable<T> = T | Promise<T>;

/** Fold-time options of a setting. Changing them needs a separate fold. */
export interface FoldSettings {
  /** Half-lives in seconds, by name. Default `timescore.HALF_LIVES`. */
  readonly halfLives?: HalfLives;
  /** The burst rule. Default off. */
  readonly burst?: BurstOptions;
}

/** One named setting to compare. */
export interface EvalSetting {
  readonly name: string;
  /** The ranking mode. Default `'hot'`. */
  readonly mode?: RankMode;
  readonly ranking?: RankingParamsInput;
  readonly fold?: FoldSettings;
}

export interface ReplayOptions {
  /** The full event log, with rename records, in any order. */
  readonly log: readonly ReplayEntry[];
  readonly cases: readonly EvalCase[];
  readonly settings: readonly EvalSetting[];
  /** The keyword index as of a case's time. Called once per search case; never for orientation cases. */
  readonly indexAt?: (c: EvalCase) => Awaitable<PostingsSource>;
  /** Note metadata (path, title, role) as of a case's time. Called once per case. */
  readonly notesAt: (c: EvalCase) => Awaitable<ReadonlyMap<string, NoteMeta>>;
  /** The link graph as of a case's time. Called once per case, only if a setting spreads. */
  readonly linksAt?: (c: EvalCase) => Awaitable<LinkGraph>;
  /** Recall cutoffs. Default `[1, 5, 10, 20]`. */
  readonly ks?: readonly number[];
  /**
   * Return per-case detail too. Off by default: with a real brain, detail is
   * private and must stay inside the brain's `.somememos/` directory.
   */
  readonly detail?: boolean;
  /** Ranked items kept per case in the detail. Default: the largest k. */
  readonly detailDepth?: number;
}

export interface SettingReport {
  readonly name: string;
  /** Every case. */
  readonly all: Aggregate;
  /** Orientation cases only (null query). */
  readonly orientation: Aggregate;
  /** Search cases only. */
  readonly search: Aggregate;
}

/** Per-case detail. PRIVATE when the data is real. */
export interface CaseDetail {
  readonly setting: string;
  readonly caseId: string;
  readonly time: number;
  readonly query: string | null;
  readonly answers: readonly string[];
  readonly ranked: readonly string[];
  readonly reciprocalRank: number | null;
  readonly recall: Readonly<Record<number, number | null>>;
}

export interface EvalReport {
  readonly ks: readonly number[];
  /** Setting results, in the order the settings were given. */
  readonly settings: readonly SettingReport[];
  /** Present only when `detail` was requested. */
  readonly detail?: readonly CaseDetail[];
}

/** Item → half-life → kind → log score, mutable. */
type Table = Map<string, Record<string, ScoresByKind>>;

/** One fold setting's incremental replay state. */
class Replayer {
  readonly scores: Table = new Map();
  private pos = 0;
  private readonly entries: readonly ReplayEntry[];
  private readonly halfLives: HalfLives;

  constructor(log: readonly ReplayEntry[], fold: FoldSettings) {
    this.halfLives = fold.halfLives ?? HALF_LIVES;
    assertValidHalfLives(this.halfLives);
    const ordered = timeOrdered(log);
    this.entries = fold.burst ? collapseBursts(ordered, fold.burst) : ordered;
  }

  /** Folds every entry dated strictly before `time`. Times must not decrease. */
  advanceTo(time: number): void {
    let pending: ScoreEvent[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      for (const [item, scores] of foldEvents<string>(pending, { halfLives: this.halfLives })) {
        this.merge(item, scores);
      }
      pending = [];
    };
    while (this.pos < this.entries.length) {
      const entry = this.entries[this.pos] as ReplayEntry;
      if (!(entry.time < time)) break;
      this.pos++;
      if (isRename(entry)) {
        flush();
        // Every rename at this second (they are consecutive: events come first).
        const group: ReplayRename[] = [entry];
        while (this.pos < this.entries.length) {
          const next = this.entries[this.pos] as ReplayEntry;
          if (!isRename(next) || next.time !== entry.time) break;
          group.push(next);
          this.pos++;
        }
        this.moveTogether(group);
      } else {
        pending.push({ item: entry.item, kind: entry.kind, time: entry.time });
      }
    }
    flush();
  }

  private merge(item: string, add: ItemScores<string>): void {
    let target = this.scores.get(item);
    if (!target) this.scores.set(item, (target = {}));
    for (const [name, byKind] of Object.entries(add)) {
      const into = (target[name] ??= {});
      for (const kind of EVENT_KINDS) {
        const s = byKind[kind];
        if (s === undefined) continue;
        const prev = into[kind];
        into[kind] = prev === undefined ? s : combine(prev, s);
      }
    }
  }

  /** Applies renames of one second at once: each item's scores move to where its applying rename says. */
  private moveTogether(group: readonly ReplayRename[]): void {
    const applies = new Map<string, ReplayRename>();
    for (const r of group) {
      const was = applies.get(r.item);
      if (!was || compareStrings(r.id ?? '', was.id ?? '') < 0) applies.set(r.item, r);
    }
    const moving: [string, ItemScores<string>][] = [];
    for (const r of applies.values()) {
      const scores = this.scores.get(r.item);
      if (!scores || r.item === r.to) continue;
      this.scores.delete(r.item);
      moving.push([r.to, scores]);
    }
    for (const [to, scores] of moving) this.merge(to, scores);
  }
}

function foldKey(fold: FoldSettings | undefined): string {
  const halfLives = Object.entries(fold?.halfLives ?? HALF_LIVES).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  const burst = fold?.burst && fold.burst.window > 0 ? fold.burst : null;
  return JSON.stringify({
    halfLives,
    burst: burst
      ? { window: burst.window, kinds: burst.kinds ? [...burst.kinds].sort() : null }
      : null,
  });
}

/**
 * Replays the log over the cases for every setting and scores each ranking
 * against the case's answers. Returns aggregate metrics per setting, and
 * per-case detail only when `detail` is set.
 */
export async function runReplay(options: ReplayOptions): Promise<EvalReport> {
  const ks = options.ks ?? DEFAULT_KS;
  for (const k of ks) {
    if (!Number.isSafeInteger(k) || k < 1)
      throw new RangeError(`k must be a positive integer, not ${k}`);
  }
  const names = new Set<string>();
  for (const s of options.settings) {
    if (names.has(s.name)) throw new RangeError(`duplicate setting name ${s.name}`);
    names.add(s.name);
  }
  const depth = options.detailDepth ?? Math.max(0, ...ks);

  // One replayer per distinct fold setting.
  const replayers = new Map<string, Replayer>();
  const settings = options.settings.map((s) => {
    const key = foldKey(s.fold);
    let replayer = replayers.get(key);
    if (!replayer) replayers.set(key, (replayer = new Replayer(options.log, s.fold ?? {})));
    const halfLifeSeconds = s.fold?.halfLives ?? HALF_LIVES;
    const params = resolveRankingParams({ halfLifeSeconds, ...s.ranking });
    return { setting: s, mode: s.mode ?? ('hot' as RankMode), replayer, params };
  });
  const needLinks = settings.some((s) => spreadingActive(s.params));

  const scored = new Map<string, { orientation: ScoredCase[]; search: ScoredCase[] }>(
    settings.map((s) => [s.setting.name, { orientation: [], search: [] }]),
  );
  const detail: CaseDetail[] = [];

  const cases = options.cases
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.time - b.c.time || a.i - b.i)
    .map(({ c }) => c);

  for (const c of cases) {
    if (!Number.isFinite(c.time)) throw new RangeError(`case ${c.id} has no finite time`);
    for (const r of replayers.values()) r.advanceTo(c.time);
    const notes = await options.notesAt(c);
    const links = needLinks && options.linksAt ? await options.linksAt(c) : undefined;
    let index: PostingsSource | undefined;
    if (c.query !== null) {
      if (!options.indexAt) throw new Error(`case ${c.id} has a query, but no indexAt was given`);
      index = await options.indexAt(c);
    }
    const hitsCache = new Map<string, Awaited<ReturnType<typeof searchSource>>>();

    for (const s of settings) {
      const p: RankingParams = { ...s.params, now: c.time };
      const ctx: RankContext = { scores: s.replayer.scores, notes, ...(links ? { links } : {}) };
      let ranked: string[];
      if (c.query === null) {
        ranked = rankByActivation(ctx, s.mode, p).map((r) => r.item);
      } else {
        const key = JSON.stringify([p.matchMode, p.keyword]);
        let hits = hitsCache.get(key);
        if (!hits) {
          hits = await searchSource(index as PostingsSource, c.query, {
            mode: p.matchMode,
            params: p.keyword,
          });
          hitsCache.set(key, hits);
        }
        ranked = rankKeywordHits(hits, ctx, s.mode, p).map((r) => r.item);
      }
      const entry: ScoredCase = { ranked, relevant: c.answers };
      const bucket = scored.get(s.setting.name) as {
        orientation: ScoredCase[];
        search: ScoredCase[];
      };
      (c.query === null ? bucket.orientation : bucket.search).push(entry);
      if (options.detail) {
        const recall: Record<number, number | null> = {};
        for (const k of ks) recall[k] = recallAtK(ranked, c.answers, k);
        detail.push({
          setting: s.setting.name,
          caseId: c.id,
          time: c.time,
          query: c.query,
          answers: c.answers,
          ranked: ranked.slice(0, depth),
          reciprocalRank: reciprocalRank(ranked, c.answers),
          recall,
        });
      }
    }
  }

  const reports: SettingReport[] = settings.map((s) => {
    const b = scored.get(s.setting.name) as { orientation: ScoredCase[]; search: ScoredCase[] };
    return {
      name: s.setting.name,
      all: aggregate([...b.orientation, ...b.search], ks),
      orientation: aggregate(b.orientation, ks),
      search: aggregate(b.search, ks),
    };
  });
  return options.detail ? { ks, settings: reports, detail } : { ks, settings: reports };
}
