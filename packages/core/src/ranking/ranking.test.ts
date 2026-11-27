import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMemoryStores, type MemoryStores } from '../storage/memory.js';
import { foldPending } from '../storage/fold.js';
import { newEvent } from '../storage/validate.js';
import type { NoteRole } from '../storage/types.js';
import { foldEvents, type ScoreEvent } from '../timescore/events.js';
import { HALF_LIVES } from '../timescore/halfLives.js';
import type { EventKind } from '../timescore/kinds.js';
import { linkGraphFromMaps } from './activation.js';
import { decayed } from './decayed.js';
import { resolveRankingParams, type RankMode, type RankingParamsInput } from './params.js';
import {
  classifyItem,
  rankByActivation,
  rankKeywordHits,
  type NoteMeta,
  type RankContext,
  type RankedResult,
} from './rank.js';
import { rankActivation, rankSearch } from './stores.js';

// All data here is invented.
const NOW = 1_800_000_000;
const DAY = 86_400;

interface NoteSpec {
  path: string;
  title?: string;
  role?: NoteRole;
  body?: string;
  links?: string[];
}

async function brain(
  notes: NoteSpec[],
  events: [item: string, kind: EventKind, daysAgo: number][],
): Promise<MemoryStores> {
  const stores = createMemoryStores({ now: () => NOW });
  for (const n of notes) {
    const title = n.title ?? n.path.replace(/^.*\//, '').replace(/\.md$/, '');
    await stores.notes.upsertNote({
      path: n.path,
      title,
      contentHash: n.path,
      mtime: NOW - 1000 * DAY,
      role: n.role ?? 'memo',
      date: n.role === 'dated' ? '2026-01-01' : null,
    });
    await stores.terms.replaceSections(n.path, title, [{ heading: null, body: n.body ?? '' }]);
    if (n.links) {
      await stores.notes.replaceLinks(
        n.path,
        n.links.map((t) => ({ target: t, dangling: !t.endsWith('.md') })),
      );
    }
  }
  await stores.events.append(
    events.map(([item, kind, daysAgo]) =>
      newEvent({ item, kind, client: 'test', time: NOW - Math.round(daysAgo * DAY) }),
    ),
  );
  await foldPending(stores.events, stores.scores);
  return stores;
}

const items = (results: readonly RankedResult[]): string[] => results.map((r) => r.item);

function ctxFrom(
  events: ScoreEvent[],
  notes: NoteMeta[],
  links?: Map<string, string[]>,
): RankContext {
  return {
    scores: foldEvents(events),
    notes: new Map(notes.map((n) => [n.path, n])),
    ...(links ? { links: linkGraphFromMaps(links) } : {}),
  };
}

const memo = (path: string): NoteMeta => ({ path, title: path, role: 'memo' });

describe('classifyItem', () => {
  const notes = new Map<string, NoteMeta>([
    ['memos/a.md', memo('memos/a.md')],
    ['diary/d.md', { path: 'diary/d.md', title: 'd', role: 'dated' }],
  ]);
  it('accepts memos and dangling keys, excludes other roles and stale note paths', () => {
    expect(classifyItem('memos/a.md', notes)).toBe('memo');
    expect(classifyItem('some idea', notes)).toBe('dangling');
    expect(classifyItem('diary/d.md', notes)).toBe('excluded');
    expect(classifyItem('memos/deleted.md', notes)).toBe('excluded');
  });
});

describe('rankActivation (no keywords)', () => {
  it('hot ranks by week activation and flags dangling items', async () => {
    const stores = await brain(
      [
        { path: 'memos/apple.md' },
        { path: 'memos/pear.md' },
        { path: 'diary/day.md', role: 'dated' },
      ],
      [
        ['memos/apple.md', 'edit', 1],
        ['memos/pear.md', 'edit', 1],
        ['memos/pear.md', 'edit', 2],
        ['quince idea', 'mention', 1.5],
        ['diary/day.md', 'edit', 0],
        ['memos/gone.md', 'edit', 0],
      ],
    );
    const hot = await rankActivation(stores, 'hot');
    expect(items(hot)).toEqual(['memos/pear.md', 'memos/apple.md', 'quince idea']);
    const dangling = hot.find((r) => r.item === 'quince idea');
    expect(dangling?.dangling).toBe(true);
    expect(dangling?.path).toBeNull();
    expect(hot[0]?.dangling).toBe(false);
    expect(hot[0]?.path).toBe('memos/pear.md');
  });

  it('trending ranks only among the top items by week score', async () => {
    const steady: [string, EventKind, number][] = [];
    for (let d = 1; d <= 60; d++) steady.push(['memos/steady.md', 'edit', d]);
    const stores = await brain(
      [{ path: 'memos/steady.md' }, { path: 'memos/spark.md' }, { path: 'memos/rising.md' }],
      [
        ...steady,
        ['memos/spark.md', 'edit', 0.1],
        ['memos/rising.md', 'edit', 0.5],
        ['memos/rising.md', 'edit', 1],
        ['memos/rising.md', 'edit', 2],
      ],
    );
    // Unguarded, the single recent event is "all trend".
    expect(items(await rankActivation(stores, 'trending'))[0]).toBe('memos/spark.md');
    // Among the top 2 by week score only, the spark is not a candidate.
    const guarded = await rankActivation(stores, 'trending', { trendingCandidates: 2 });
    expect(items(guarded)).toEqual(['memos/rising.md', 'memos/steady.md']);
  });

  it('neglected ranks by year over month among the top items by year score', async () => {
    const old: [string, EventKind, number][] = [];
    for (let d = 100; d < 200; d += 5) old.push(['memos/old-core.md', 'edit', d]);
    const stores = await brain(
      [{ path: 'memos/old-core.md' }, { path: 'memos/once.md' }, { path: 'memos/active.md' }],
      [
        ...old,
        ['memos/once.md', 'edit', 300],
        ['memos/active.md', 'edit', 1],
        ['memos/active.md', 'edit', 2],
      ],
    );
    expect(items(await rankActivation(stores, 'neglected'))[0]).toBe('memos/once.md');
    const guarded = await rankActivation(stores, 'neglected', { neglectedCandidates: 2 });
    expect(items(guarded)).toEqual(['memos/old-core.md', 'memos/active.md']);
    const byScore = await rankActivation(stores, 'neglected', {
      neglectedMinLongScore: 2,
      now: NOW,
      halfLifeSeconds: HALF_LIVES,
    });
    expect(items(byScore)).toEqual(['memos/old-core.md']);
  });

  it('limit cuts the list', async () => {
    const stores = await brain(
      [{ path: 'memos/a.md' }, { path: 'memos/b.md' }],
      [
        ['memos/a.md', 'edit', 1],
        ['memos/b.md', 'edit', 2],
      ],
    );
    expect(items(await rankActivation(stores, 'hot', { limit: 1 }))).toEqual(['memos/a.md']);
  });
});

describe('rankSearch (keywords)', () => {
  const notes: NoteSpec[] = [
    { path: 'memos/garden.md', body: 'tomato tomato tomato plants in the garden' },
    { path: 'memos/kitchen.md', body: 'a tomato sauce' },
    { path: 'memos/shed.md', body: 'tools and a tomato' },
    { path: 'memos/other.md', body: 'nothing relevant' },
    { path: 'sources/paper.md', role: 'source', body: 'tomato studies' },
  ];
  const events: [string, EventKind, number][] = [
    ['memos/kitchen.md', 'edit', 0.5],
    ['memos/kitchen.md', 'edit', 1],
    ['memos/kitchen.md', 'edit', 2],
    ['memos/garden.md', 'edit', 300],
  ];

  it('all mode is keyword relevance only, one entry per note, with a snippet', async () => {
    const stores = await brain(notes, events);
    const all = await rankSearch(stores, 'tomato', { mode: 'all' });
    expect(items(all)[0]).toBe('memos/garden.md');
    expect(new Set(items(all)).size).toBe(all.length);
    expect(all.map((r) => r.item)).toContain('sources/paper.md');
    expect(all[0]?.snippet?.text).toContain('tomato');
    expect(all[0]?.sectionId).toBe('memos/garden.md#0');
  });

  it('hot lifts recently active notes; alpha = 0 equals keyword-only order', async () => {
    const stores = await brain(notes, events);
    const hot = await rankSearch(stores, 'tomato');
    expect(items(hot)[0]).toBe('memos/kitchen.md');
    const zero = await rankSearch(stores, 'tomato', { alpha: 0 });
    const all = await rankSearch(stores, 'tomato', { mode: 'all' });
    expect(items(zero)).toEqual(items(all));
  });

  it('items without activation still appear, at the floor', async () => {
    const stores = await brain(notes, events);
    const hot = await rankSearch(stores, 'tomato');
    const shed = hot.find((r) => r.item === 'memos/shed.md');
    expect(shed).toBeDefined();
    expect(shed?.components.floored).toBe(true);
    const min = Math.min(
      ...hot.filter((r) => !r.components.floored).map((r) => r.components.signal),
    );
    expect(shed?.components.signalUsed).toBe(min - Math.LN2);
    const lower = await rankSearch(stores, 'tomato', { floor: { mode: 'relative', offset: -5 } });
    expect(lower.find((r) => r.item === 'memos/shed.md')?.components.signalUsed).toBe(min - 5);
  });

  it('searchRoles filters roles', async () => {
    const stores = await brain(notes, events);
    const memos = await rankSearch(stores, 'tomato', { searchRoles: ['memo'] });
    expect(items(memos)).not.toContain('sources/paper.md');
  });

  it('rerank orders the most relevant head by the signal', async () => {
    const stores = await brain(notes, events);
    const all = await rankSearch(stores, 'tomato', { mode: 'all' });
    const rr = await rankSearch(stores, 'tomato', {
      mode: 'hot',
      combination: { hot: 'rerank' },
      rerankDepth: 2,
    });
    const head = items(all).slice(0, 2);
    expect(new Set(items(rr).slice(0, 2))).toEqual(new Set(head));
    expect(items(rr).slice(2)).toEqual(items(all).slice(2));
    expect(rr.slice(0, 2).every((r) => r.components.reranked)).toBe(true);
  });

  it('components add up to the rank key in every mode and combination', async () => {
    const stores = await brain(notes, events);
    for (const mode of ['hot', 'trending', 'neglected', 'all'] as RankMode[]) {
      for (const combination of ['sum', 'rerank'] as const) {
        const results = await rankSearch(stores, 'tomato', {
          mode,
          alpha: 0.7,
          combination: { hot: combination, trending: combination, neglected: combination },
          rerankDepth: 2,
        });
        for (const r of results) {
          expect(r.components.terms.relevance + r.components.terms.activation).toBe(r.rankKey);
          if (combination === 'sum' && !r.components.reranked) {
            const s = r.components.signalUsed ?? 0;
            expect(r.rankKey).toBeCloseTo(
              Math.log(r.components.relevance as number) + (mode === 'all' ? 0 : 0.7 * s),
              6,
            );
          }
        }
      }
    }
    for (const r of await rankActivation(stores, 'trending')) {
      expect(r.components.terms.activation).toBe(r.rankKey);
    }
  });
});

describe('pure ranking', () => {
  const notes = ['memos/a.md', 'memos/b.md', 'memos/c.md'].map(memo);
  const hits = [
    { id: 'memos/a.md#0', score: 3 },
    { id: 'memos/a.md#1', score: 5 },
    { id: 'memos/b.md#0', score: 4 },
    { id: 'memos/c.md#0', score: 1 },
  ];

  it('groups sections, keeping each note’s best', () => {
    const ctx = ctxFrom([], notes);
    const r = rankKeywordHits(hits, ctx, 'all', resolveRankingParams());
    expect(r.map((x) => [x.item, x.sectionId])).toEqual([
      ['memos/a.md', 'memos/a.md#1'],
      ['memos/b.md', 'memos/b.md#0'],
      ['memos/c.md', 'memos/c.md#0'],
    ]);
  });

  it('a kind with weight 0 has no influence', () => {
    const base: ScoreEvent[] = [
      { item: 'memos/a.md', kind: 'edit', time: NOW - 3 * DAY },
      { item: 'memos/b.md', kind: 'edit', time: NOW - 1 * DAY },
      { item: 'memos/c.md', kind: 'read', time: NOW - 2 * DAY },
    ];
    const mentions: ScoreEvent[] = [
      { item: 'memos/a.md', kind: 'mention', time: NOW },
      { item: 'memos/a.md', kind: 'mention', time: NOW },
      { item: 'memos/c.md', kind: 'mention', time: NOW - DAY },
    ];
    const p = resolveRankingParams({ weights: { mention: 0 } });
    for (const mode of ['hot', 'trending', 'neglected'] as RankMode[]) {
      const without = rankKeywordHits(hits, ctxFrom(base, notes), mode, p);
      const withMentions = rankKeywordHits(hits, ctxFrom([...base, ...mentions], notes), mode, p);
      expect(withMentions.map((r) => [r.item, r.rankKey])).toEqual(
        without.map((r) => [r.item, r.rankKey]),
      );
      expect(items(rankByActivation(ctxFrom([...base, ...mentions], notes), mode, p))).toEqual(
        items(rankByActivation(ctxFrom(base, notes), mode, p)),
      );
    }
  });

  it('spreading off equals beta = 0, and spreading lifts neighbors of active items', () => {
    const events: ScoreEvent[] = [
      { item: 'memos/a.md', kind: 'edit', time: NOW - 10 * DAY },
      { item: 'memos/b.md', kind: 'edit', time: NOW - 9 * DAY },
      { item: 'memos/c.md', kind: 'edit', time: NOW },
      { item: 'memos/c.md', kind: 'edit', time: NOW },
    ];
    const links = new Map([['memos/a.md', ['memos/c.md']]]);
    const ctx = ctxFrom(events, notes, links);
    const strip = (rs: RankedResult[]): unknown =>
      rs.map((r) => [r.item, r.rankKey, r.components.activation]);
    for (const direction of ['outgoing', 'backlinks', 'both'] as const) {
      const off = rankByActivation(ctx, 'hot', resolveRankingParams());
      const zero = rankByActivation(
        ctx,
        'hot',
        resolveRankingParams({ spreading: { direction, beta: 0 } }),
      );
      expect(strip(zero)).toEqual(strip(off));
      const kOff = rankKeywordHits(hits, ctx, 'hot', resolveRankingParams());
      const kZero = rankKeywordHits(
        hits,
        ctx,
        'hot',
        resolveRankingParams({ spreading: { direction, beta: 0 } }),
      );
      expect(strip(kZero)).toEqual(strip(kOff));
    }
    expect(items(rankByActivation(ctx, 'hot', resolveRankingParams()))).toEqual([
      'memos/c.md',
      'memos/b.md',
      'memos/a.md',
    ]);
    const out = rankByActivation(
      ctx,
      'hot',
      resolveRankingParams({ spreading: { direction: 'outgoing', beta: 0.5 } }),
    );
    expect(items(out)).toEqual(['memos/c.md', 'memos/a.md', 'memos/b.md']);
    expect(out[1]?.components.spread?.week).toBeGreaterThan(-Infinity);
    // Backlinks: c is linked from a, so c gains from a (and stays first); a gains nothing.
    const back = rankByActivation(
      ctx,
      'hot',
      resolveRankingParams({ spreading: { direction: 'backlinks', beta: 1 } }),
    );
    expect(back.find((r) => r.item === 'memos/a.md')?.components.spread?.week).toBe(-Infinity);
  });

  it('the order is the same for any now', () => {
    const events: ScoreEvent[] = [
      { item: 'memos/a.md', kind: 'edit', time: NOW - 40 * DAY },
      { item: 'memos/a.md', kind: 'edit', time: NOW - 30 * DAY },
      { item: 'memos/b.md', kind: 'edit', time: NOW - 2 * DAY },
      { item: 'memos/c.md', kind: 'read', time: NOW - 200 * DAY },
    ];
    const ctx = ctxFrom(events, notes);
    for (const mode of ['hot', 'trending', 'neglected', 'all'] as RankMode[]) {
      const at = (now: number): unknown => [
        items(rankByActivation(ctx, mode, resolveRankingParams({ now }))),
        items(rankKeywordHits(hits, ctx, mode, resolveRankingParams({ now }))),
      ];
      expect(at(NOW + 1000 * DAY)).toEqual(at(NOW));
      expect(at(NOW + 1)).toEqual(at(NOW));
    }
  });

  it('property: shifting every event by the same amount keeps every order', () => {
    const arbEvents = fc.array(
      fc.record({
        item: fc.constantFrom('memos/a.md', 'memos/b.md', 'memos/c.md', 'loose idea'),
        kind: fc.constantFrom<EventKind>('read', 'edit', 'mention'),
        time: fc.integer({ min: NOW - 400 * DAY, max: NOW }),
      }),
      { minLength: 1, maxLength: 30 },
    );
    fc.assert(
      fc.property(
        arbEvents,
        fc.integer({ min: 1, max: 2000 }),
        fc.constantFrom<RankMode>('hot', 'trending', 'neglected', 'all'),
        (events, shiftDays, mode) => {
          const shifted = events.map((e) => ({ ...e, time: e.time + shiftDays * DAY }));
          const params: RankingParamsInput = { alpha: 0.5 };
          const p = resolveRankingParams(params);
          for (const fn of [
            (c: RankContext) => rankByActivation(c, mode, p),
            (c: RankContext) => rankKeywordHits(hits, c, mode, p),
          ]) {
            const a = fn(ctxFrom(events, notes));
            const b = fn(ctxFrom(shifted, notes));
            expect(items(b).sort()).toEqual(items(a).sort());
            // Same order, up to rounding-level near-ties.
            const keyA = new Map(a.map((r) => [r.item, r.rankKey]));
            for (let i = 1; i < b.length; i++) {
              const hi = keyA.get(b[i - 1]!.item)!;
              const lo = keyA.get(b[i]!.item)!;
              expect(hi).toBeGreaterThanOrEqual(lo - 1e-6);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('decayed', () => {
  it('converts log scores to scores now', () => {
    const ctx = ctxFrom(
      [
        { item: 'memos/a.md', kind: 'edit', time: NOW },
        { item: 'memos/a.md', kind: 'read', time: NOW - 7 * DAY },
      ],
      [memo('memos/a.md')],
    );
    const [r] = rankByActivation(ctx, 'hot', resolveRankingParams());
    const view = decayed(r!.components, NOW);
    expect(view.activation.week).toBeCloseTo(1.5, 9);
    expect(view.kinds.week?.edit).toBeCloseTo(1, 9);
    expect(view.kinds.week?.read).toBeCloseTo(0.5, 9);
    expect(view.trendingRatio).toBeGreaterThan(0);
    expect(decayed(r!.components, NOW + 7 * DAY).activation.week).toBeCloseTo(0.75, 9);
  });
});
