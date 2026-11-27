import { describe, expect, it } from 'vitest';
import { MemoryKeywordIndex } from '../keyword/memory-index.js';
import { resolveRankingParams } from '../ranking/params.js';
import { rankByActivation, type NoteMeta } from '../ranking/rank.js';
import { sectionId } from '../storage/validate.js';
import { foldEvents } from '../timescore/events.js';
import type { EventKind } from '../timescore/kinds.js';
import { buildOrientationCases, seededRandom, type EvalCase } from './cases.js';
import { expandGrid } from './grid.js';
import { collapseBursts, timeOrdered, type ReplayEntry, type ReplayEvent } from './log.js';
import { DEFAULT_KS, aggregate, meanReciprocalRank, recallAtK, reciprocalRank } from './metrics.js';
import { runReplay, type EvalSetting } from './replay.js';
import { formatReportText, reportToJson } from './report.js';

// All data here is synthetic and invented.
const T = 1_800_000_000;
const DAY = 86_400;
const ev = (item: string, kind: EventKind, time: number): ReplayEvent => ({ item, kind, time });
const memo = (path: string): NoteMeta => ({ path, title: path, role: 'memo' });
const notesOf = (...paths: string[]): Map<string, NoteMeta> =>
  new Map(paths.map((p) => [p, memo(p)]));

describe('metrics', () => {
  it('recall@k on hand-computed cases', () => {
    const ranked = ['a', 'b', 'c', 'd', 'e'];
    expect(recallAtK(ranked, ['b', 'e', 'z'], 1)).toBe(0);
    expect(recallAtK(ranked, ['b', 'e', 'z'], 2)).toBeCloseTo(1 / 3);
    expect(recallAtK(ranked, ['b', 'e', 'z'], 5)).toBeCloseTo(2 / 3);
    expect(recallAtK(ranked, ['b', 'e', 'z'], 100)).toBeCloseTo(2 / 3); // z never ranked
    expect(recallAtK(['a', 'a', 'b'], ['b'], 2)).toBe(1); // repeats ignored
    expect(recallAtK(ranked, [], 5)).toBeNull();
    expect(() => recallAtK(ranked, ['a'], 0)).toThrow(RangeError);
  });

  it('reciprocal rank and MRR', () => {
    expect(reciprocalRank(['a', 'b', 'c'], ['c'])).toBeCloseTo(1 / 3);
    expect(reciprocalRank(['a', 'b', 'c'], ['b', 'c'])).toBe(0.5);
    expect(reciprocalRank(['a', 'b'], ['z'])).toBe(0);
    expect(reciprocalRank(['a'], [])).toBeNull();
    const m = meanReciprocalRank([
      { ranked: ['a', 'b'], relevant: ['a'] }, // 1
      { ranked: ['a', 'b'], relevant: ['b'] }, // 1/2
      { ranked: ['a', 'b'], relevant: ['z'] }, // 0
      { ranked: ['a', 'b'], relevant: [] }, // skipped
    ]);
    expect(m.mrr).toBeCloseTo(0.5);
    expect(m.cases).toBe(3);
    expect(m.skipped).toBe(1);
    expect(meanReciprocalRank([])).toEqual({ mrr: 0, cases: 0, skipped: 0 });
  });

  it('aggregate reports recall for every k, MRR and counts', () => {
    const a = aggregate(
      [
        { ranked: ['a', 'b', 'c'], relevant: ['a', 'c'] }, // R@1 .5, R@2 .5, R@3 1, RR 1
        { ranked: ['x', 'y', 'a'], relevant: ['a'] }, // R@1 0, R@2 0, R@3 1, RR 1/3
        { ranked: ['x'], relevant: [] },
      ],
      [1, 2, 3],
    );
    expect(a.cases).toBe(2);
    expect(a.skipped).toBe(1);
    expect(a.recall[1]).toBeCloseTo(0.25);
    expect(a.recall[2]).toBeCloseTo(0.25);
    expect(a.recall[3]).toBeCloseTo(1);
    expect(a.mrr).toBeCloseTo(2 / 3);
    expect(Object.keys(aggregate([]).recall).map(Number)).toEqual([...DEFAULT_KS]);
  });
});

describe('log helpers', () => {
  it('orders by time, events before renames at the same time', () => {
    const log: ReplayEntry[] = [
      { kind: 'rename', item: 'a', to: 'b', time: 10 },
      ev('a', 'edit', 10),
      ev('a', 'edit', 5),
    ];
    expect(timeOrdered(log).map((e) => `${e.kind}@${e.time}`)).toEqual([
      'edit@5',
      'edit@10',
      'rename@10',
    ]);
  });

  it('collapses bursts per item and kind', () => {
    const log = timeOrdered([
      ev('a', 'edit', 0),
      ev('a', 'edit', 30),
      ev('a', 'edit', 59),
      ev('a', 'edit', 60), // 60 s after the last kept: kept
      ev('a', 'edit', 100),
      ev('a', 'mention', 10), // another kind: its own burst
      ev('b', 'edit', 20), // another item
      ev('a', 'read', 15),
      ev('a', 'read', 16),
    ]);
    const count = (entries: readonly ReplayEntry[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const e of entries) out[`${e.item}/${e.kind}`] = (out[`${e.item}/${e.kind}`] ?? 0) + 1;
      return out;
    };
    expect(count(collapseBursts(log, { window: 0 }))).toEqual(count(log));
    expect(count(collapseBursts(log, { window: 60 }))).toEqual({
      'a/edit': 2,
      'a/mention': 1,
      'b/edit': 1,
      'a/read': 1,
    });
    expect(count(collapseBursts(log, { window: 60, kinds: ['edit'] }))['a/read']).toBe(2);
    expect(() => collapseBursts(log, { window: -1 })).toThrow(RangeError);
  });

  it('collapses bursts across a rename, exactly as the live fold does', () => {
    const log: ReplayEntry[] = timeOrdered([
      ev('a', 'edit', 0),
      { kind: 'rename', item: 'a', to: 'b', time: 10 },
      ev('b', 'edit', 30), // the same note, 30 s after its last counted edit: dropped
      ev('b', 'edit', 70), // 70 s after: kept
      ev('a', 'edit', 40), // a new note at the old path: its own history
    ]);
    const kept = collapseBursts(log, { window: 60 }).map((e) => `${e.kind}:${e.item}@${e.time}`);
    expect(kept).toEqual(['edit:a@0', 'rename:a@10', 'edit:a@40', 'edit:b@70']);
  });

  it('seededRandom repeats for a seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const xs = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(Array.from({ length: 5 }, seededRandom(43))).not.toEqual(xs);
  });
});

/** A synthetic log: a few items with different rhythms over ~200 days. */
function syntheticLog(): ReplayEvent[] {
  const log: ReplayEvent[] = [];
  const random = seededRandom(7);
  const items = ['memos/alpha.md', 'memos/beta.md', 'memos/gamma.md', 'memos/delta.md'];
  for (let d = 0; d < 200; d++) {
    // Each item is "in focus" for a stretch of days, and quiet otherwise.
    items.forEach((item, i) => {
      const focus = Math.floor(d / 50) % items.length === i;
      if (random() < (focus ? 0.9 : 0.05)) log.push(ev(item, 'edit', T + d * DAY + 3600 * i));
    });
  }
  return log;
}

describe('buildOrientationCases', () => {
  it('is deterministic for a seed and independent of log order', () => {
    const log = syntheticLog();
    const a = buildOrientationCases(log, { seed: 3, samples: 20, minHistory: 5 });
    const b = buildOrientationCases([...log].reverse(), { seed: 3, samples: 20, minHistory: 5 });
    expect(b).toEqual(a);
    expect(a.cases.length).toBeGreaterThan(0);
    const c = buildOrientationCases(log, { seed: 4, samples: 20, minHistory: 5 });
    expect(c.cases.map((x) => x.time)).not.toEqual(a.cases.map((x) => x.time));
  });

  it('answers are the items with events in the following window', () => {
    const log = [
      ev('x', 'edit', 100),
      ev('y', 'edit', 200),
      ev('z', 'read', 260),
      ev('w', 'edit', 400),
    ];
    const { cases } = buildOrientationCases(log, {
      start: 150,
      end: 300,
      window: 100,
      samples: 50,
      minHistory: 1,
    });
    for (const c of cases) {
      const expected = log
        .filter((e) => e.time >= c.time && e.time < c.time + 100)
        .map((e) => e.item);
      expect(c.answers).toEqual([...new Set(expected)].sort());
      expect(c.query).toBeNull();
    }
    const reads = buildOrientationCases(log, {
      start: 150,
      end: 300,
      window: 100,
      samples: 50,
      minHistory: 1,
      answerKinds: ['read'],
    });
    for (const c of reads.cases) expect(c.answers).toEqual(['z']);
  });

  it('skips times with too little history or no answers', () => {
    const log = [ev('x', 'edit', 0), ev('x', 'edit', 10), ev('x', 'edit', 1000)];
    const r = buildOrientationCases(log, { window: 50, samples: 30, minHistory: 2, end: 2000 });
    expect(r.skipped.history + r.skipped.answers + r.cases.length).toBeGreaterThan(0);
    for (const c of r.cases) expect(c.time).toBeGreaterThan(10);
    const none = buildOrientationCases(log, {
      window: 50,
      samples: 30,
      minHistory: 100,
      end: 2000,
    });
    expect(none.cases).toEqual([]);
    expect(none.skipped.history).toBeGreaterThan(0);
  });

  it('names answers as they were at the case time', () => {
    const log: ReplayEntry[] = [
      ev('old.md', 'edit', 0),
      { kind: 'rename', item: 'old.md', to: 'new.md', time: 150 },
      ev('new.md', 'edit', 160),
    ];
    const { cases } = buildOrientationCases(log, {
      start: 100,
      end: 200,
      window: 100,
      samples: 10,
      minHistory: 1,
    });
    for (const c of cases) expect(c.answers).toEqual(c.time <= 150 ? ['old.md'] : ['new.md']);
  });
});

describe('runReplay', () => {
  const notes = notesOf('memos/alpha.md', 'memos/beta.md', 'memos/gamma.md', 'memos/delta.md');
  const notesAt = (): Map<string, NoteMeta> => notes;

  it('never uses events at or after the case time', async () => {
    const log = [
      ev('memos/alpha.md', 'edit', T),
      ev('memos/alpha.md', 'edit', T + DAY),
      ev('memos/beta.md', 'edit', T + 2 * DAY),
    ];
    const c: EvalCase = { id: 'c1', time: T + 3 * DAY, query: null, answers: ['memos/alpha.md'] };
    const future = [
      // Exactly at the case time, and after it: had they counted, gamma would rank and beta would be renamed.
      ev('memos/gamma.md', 'edit', T + 3 * DAY),
      ev('memos/gamma.md', 'edit', T + 3 * DAY),
      ev('memos/alpha.md', 'edit', T + 4 * DAY),
      ev('memos/alpha.md', 'edit', T + 4 * DAY),
      { kind: 'rename', item: 'memos/beta.md', to: 'memos/zeta.md', time: T + 3 * DAY } as const,
    ];
    const settings: EvalSetting[] = [{ name: 'hot' }];
    const base = await runReplay({ log, cases: [c], settings, notesAt, detail: true });
    const planted = await runReplay({
      log: [...log, ...future],
      cases: [c],
      settings,
      notesAt,
      detail: true,
    });
    expect(planted).toEqual(base);
    expect(base.detail?.[0]?.ranked).toEqual(['memos/alpha.md', 'memos/beta.md']);
    // Sanity: the planted events would have changed the result had they counted.
    const later = await runReplay({
      log: [...log, ...future],
      cases: [{ ...c, time: T + 5 * DAY }],
      settings,
      notesAt,
      detail: true,
    });
    expect(later.detail?.[0]?.ranked).toContain('memos/gamma.md');
    expect(later.detail?.[0]?.ranked).not.toContain('memos/beta.md');
  });

  it('folds incrementally to the same rankings as a fold from scratch, honoring renames', async () => {
    const log: ReplayEntry[] = [
      ...syntheticLog(),
      { kind: 'rename', item: 'memos/beta.md', to: 'memos/beta2.md', time: T + 120 * DAY },
    ];
    const cases: EvalCase[] = [30, 80, 119, 121, 150, 199].map((d) => ({
      id: `d${d}`,
      time: T + d * DAY,
      query: null,
      answers: ['memos/alpha.md'],
    }));
    const allNotes = notesOf(
      'memos/alpha.md',
      'memos/beta2.md',
      'memos/gamma.md',
      'memos/delta.md',
      'memos/beta.md',
    );
    const report = await runReplay({
      log,
      cases,
      settings: [{ name: 'hot' }, { name: 'trend', mode: 'trending' }],
      notesAt: () => allNotes,
      detail: true,
      detailDepth: 10,
    });
    for (const d of report.detail ?? []) {
      const time = d.time;
      // Reference: apply the rename by hand to events before it, fold from scratch.
      const renamed = time > T + 120 * DAY;
      const events = log
        .filter((e): e is ReplayEvent => e.kind !== 'rename' && e.time < time)
        .map((e) => ({
          ...e,
          item:
            renamed && e.item === 'memos/beta.md' && e.time <= T + 120 * DAY
              ? 'memos/beta2.md'
              : e.item,
        }));
      const mode = d.setting === 'hot' ? 'hot' : 'trending';
      const expected = rankByActivation(
        { scores: foldEvents(events), notes: allNotes },
        mode,
        resolveRankingParams(),
      ).map((r) => r.item);
      expect(d.ranked).toEqual(expected.slice(0, 10));
      if (renamed && d.setting === 'hot') expect(d.ranked).toContain('memos/beta2.md');
    }
  });

  it('a setting that should win does: activation helps when recently active items are the answers', async () => {
    const log = syntheticLog();
    const { cases } = buildOrientationCases(log, {
      seed: 11,
      samples: 30,
      window: 2 * DAY,
      minHistory: 10,
    });
    expect(cases.length).toBeGreaterThan(5);
    const report = await runReplay({
      log,
      cases,
      settings: [
        { name: 'hot', mode: 'hot' },
        { name: 'neglected', mode: 'neglected' },
      ],
      notesAt,
      ks: [1, 2],
    });
    const [hot, neglected] = report.settings;
    expect(hot!.all.mrr).toBeGreaterThan(neglected!.all.mrr);
    expect(hot!.all.recall[1]).toBeGreaterThan(neglected!.all.recall[1]!);
    expect(report.detail).toBeUndefined();

    // Search cases: the answer is the less relevant but recently active note.
    const index = new MemoryKeywordIndex();
    index.add(sectionId('memos/alpha.md', 0), {
      title: 'alpha',
      heading: '',
      body: 'apple apple apple orchard',
    });
    index.add(sectionId('memos/beta.md', 0), { title: 'beta', heading: '', body: 'an apple' });
    const searchLog = [
      ev('memos/alpha.md', 'edit', T - 300 * DAY),
      ev('memos/beta.md', 'edit', T),
      ev('memos/beta.md', 'edit', T + 1),
    ];
    const searchCases: EvalCase[] = [
      { id: 's1', time: T + DAY, query: 'apple', answers: ['memos/beta.md'] },
    ];
    const search = await runReplay({
      log: searchLog,
      cases: searchCases,
      settings: expandGrid({ alpha: [0, 1] }),
      indexAt: () => index,
      notesAt,
    });
    expect(search.settings.map((s) => [s.name, s.search.mrr])).toEqual([
      ['alpha=0', 0.5],
      ['alpha=1', 1],
    ]);
    expect(search.settings[0]?.orientation.cases).toBe(0);
  });

  it('burst collapsing changes the counts that reach the scores', async () => {
    // alpha gets one burst of ten saves; beta gets three spread-out edits.
    const log = [
      ...Array.from({ length: 10 }, (_, i) => ev('memos/alpha.md', 'edit', T + 10 * DAY + i * 30)),
      ev('memos/beta.md', 'edit', T + 9 * DAY),
      ev('memos/beta.md', 'edit', T + 9.5 * DAY),
      ev('memos/beta.md', 'edit', T + 10 * DAY),
    ];
    const c: EvalCase = { id: 'b', time: T + 11 * DAY, query: null, answers: ['memos/beta.md'] };
    const report = await runReplay({
      log,
      cases: [c],
      settings: [{ name: 'off' }, { name: 'burst', fold: { burst: { window: 3600 } } }],
      notesAt,
      detail: true,
    });
    expect(report.detail?.map((d) => d.ranked[0])).toEqual(['memos/alpha.md', 'memos/beta.md']);
  });

  it('requires an index for search cases and unique setting names', async () => {
    const c: EvalCase = { id: 'q', time: T, query: 'x', answers: ['a'] };
    await expect(
      runReplay({ log: [], cases: [c], settings: [{ name: 'a' }], notesAt }),
    ).rejects.toThrow();
    await expect(
      runReplay({ log: [], cases: [], settings: [{ name: 'a' }, { name: 'a' }], notesAt }),
    ).rejects.toThrow(RangeError);
  });
});

describe('expandGrid', () => {
  it('expands dotted keys into named settings, last key fastest', () => {
    const settings = expandGrid(
      { alpha: [0, 0.5], 'weights.mention': [0.5, 1], 'fold.burst.window': [60] },
      { ranking: { weights: { read: 2 } } },
    );
    expect(settings.map((s) => s.name)).toEqual([
      'alpha=0,weights.mention=0.5,fold.burst.window=60',
      'alpha=0,weights.mention=1,fold.burst.window=60',
      'alpha=0.5,weights.mention=0.5,fold.burst.window=60',
      'alpha=0.5,weights.mention=1,fold.burst.window=60',
    ]);
    expect(settings[1]).toEqual({
      name: 'alpha=0,weights.mention=1,fold.burst.window=60',
      ranking: { alpha: 0, weights: { read: 2, mention: 1 } },
      fold: { burst: { window: 60 } },
    });
    expect(expandGrid({ mode: ['hot', 'all'] }).map((s) => s.mode)).toEqual(['hot', 'all']);
    expect(expandGrid({})).toHaveLength(1);
    expect(() => expandGrid({ alpha: [] })).toThrow(RangeError);
  });
});

describe('report formatting', () => {
  it('prints aggregates only by default', async () => {
    const report = await runReplay({
      log: [ev('memos/alpha.md', 'edit', T)],
      cases: [{ id: 'c', time: T + 1, query: null, answers: ['memos/alpha.md'] }],
      settings: [{ name: 'hot' }],
      notesAt: () => notesOf('memos/alpha.md'),
      ks: [1, 10],
      detail: true,
    });
    const text = formatReportText(report);
    expect(text.split('\n')[0]).toMatch(/^setting\s+R@1\s+R@10\s+MRR\s+cases\s+skipped$/);
    expect(text).toContain('1.000');
    expect(text).not.toContain('alpha.md');
    const json = JSON.stringify(reportToJson(report));
    expect(json).not.toContain('alpha.md');
    expect(JSON.stringify(reportToJson(report, { includeDetail: true }))).toContain('alpha.md');
  });
});
