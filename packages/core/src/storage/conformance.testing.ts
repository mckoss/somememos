// The storage conformance suite. Every implementation of the storage
// interfaces runs it: memory (core), SQLite (@somememos/sqlite-store, with the
// node:sqlite driver now and the WebAssembly driver in a browser), and Postgres (M3).
//
//   import { describeStorageConformance } from '@somememos/core/testing/storage';
//   describeStorageConformance('sqlite', () => harness);
//
// This module imports vitest and fast-check, so it is test-only: it is not
// part of core's built `dist` (tsconfig.build.json excludes `*.testing.ts`)
// and is exported only under the `source` condition that tests resolve with.
//
// Scores are compared with a tolerance of `SCORE_TOLERANCE_ULPS` ulps of the
// larger log score: incremental folding combines scores in a different order
// than a rebuild, so they agree to rounding, not bit for bit.
//
// All text here is invented.

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryKeywordIndex } from '../keyword/memory-index.js';
import { MAX_TERM_LENGTH } from '../keyword/tokenize.js';
import { searchSource } from '../keyword/search.js';
import { HALF_LIVES } from '../timescore/halfLives.js';
import { FutureEventError, InvalidEventError, type ItemScores } from '../timescore/events.js';
import { EVENT_KINDS, type EventKind } from '../timescore/kinds.js';
import { combine, combineAll, eventScore } from '../timescore/timescore.js';
import { foldPending, rebuildScores } from './fold.js';
import {
  BurstWindowMismatchError,
  FoldConflictError,
  HalfLifeMismatchError,
  type Awaitable,
  type ChangeInput,
  type HalfLives,
  type LogEntry,
  type LogInput,
  type NoteRecord,
  type ScoreStore,
  type SectionInput,
  type StoredRename,
  type Stores,
  type StoresOptions,
} from './types.js';
import { changeOp, sectionId } from './validate.js';

/** How an implementation under test opens stores. */
export interface StorageHarness {
  /** Opens stores over a new, empty location (a fresh database, a temp directory). */
  open(options?: StoresOptions): Awaitable<Stores>;
  /**
   * Opens the location that `stores` (already closed by the caller) used,
   * again, with `options`. Data written before must still be there.
   */
  reopen(stores: Stores, options?: StoresOptions): Awaitable<Stores>;
  /** Releases everything this harness opened. Called after each test. */
  dispose?(): Awaitable<void>;
}

export interface ConformanceOptions {
  /** fast-check runs per property. Default 25. */
  readonly numRuns?: number;
  /** Per-test timeout in ms. Default 60000. */
  readonly timeout?: number;
}

/** Scores may differ by this many ulps of the larger log score. */
export const SCORE_TOLERANCE_ULPS = 64;

/** Whether two log scores agree within `SCORE_TOLERANCE_ULPS` ulps. */
export function scoresClose(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= SCORE_TOLERANCE_ULPS * Number.EPSILON * scale;
}

/** Throws unless both score tables have the same items, half-lives and kinds, with close values. */
export function expectScoresClose(
  actual: ReadonlyMap<string, ItemScores<string>>,
  expected: ReadonlyMap<string, ItemScores<string>>,
): void {
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [item, exp] of expected) {
    const act = actual.get(item) as ItemScores<string>;
    expect(Object.keys(act).sort(), item).toEqual(Object.keys(exp).sort());
    for (const hl of Object.keys(exp)) {
      const e = exp[hl] ?? {};
      const a = act[hl] ?? {};
      expect(Object.keys(a).sort(), `${item} ${hl}`).toEqual(Object.keys(e).sort());
      for (const kind of Object.keys(e) as EventKind[]) {
        const ok = scoresClose(a[kind] as number, e[kind] as number);
        if (!ok) {
          expect.fail(`${item} ${hl} ${kind}: ${a[kind]} is not close to ${e[kind]}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Invented data and an independent model of folding

const NOW = 1_800_000_000;
const T0 = NOW - 3 * 365 * 86_400;
const CLIENT = 'test-client';
const ITEMS = [
  'memos/alpha.md',
  'memos/beta.md',
  'memos/gamma.md',
  'delta topic',
  'memos/delta.md',
];

const ev = (id: string, kind: EventKind, item: string, time: number): LogInput => ({
  id,
  kind,
  item,
  time,
  client: CLIENT,
});
const rn = (id: string, item: string, to: string, time: number): LogInput => ({
  id,
  kind: 'rename',
  item,
  to,
  time,
  client: CLIENT,
});

type Draft =
  | { kind: EventKind; item: string; time: number }
  | { kind: 'rename'; item: string; to: string; time: number };

const draftArb: fc.Arbitrary<Draft> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constantFrom(...EVENT_KINDS),
      item: fc.constantFrom(...ITEMS),
      time: fc.integer({ min: T0, max: NOW }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({
        kind: fc.constant('rename' as const),
        item: fc.constantFrom(...ITEMS),
        to: fc.constantFrom(...ITEMS),
        time: fc.integer({ min: T0, max: NOW }),
      })
      .filter((r) => r.item !== r.to),
  },
);

function toInputs(drafts: readonly Draft[], prefix = 'e'): LogInput[] {
  return drafts.map((d, i) =>
    d.kind === 'rename'
      ? rn(`${prefix}${i}`, d.item, d.to, d.time)
      : ev(`${prefix}${i}`, d.kind, d.item, d.time),
  );
}

/**
 * A deliberately naive model of `foldPending`'s semantics: each event lands
 * on the item that every rename record in the log leads to by time (only
 * renames at or after its time apply, then the next rename of the new name
 * after that one, and so on), whatever order the entries arrived in. Scores
 * are then summed per item with `combineAll`.
 */
function modelScores(
  entries: readonly LogEntry[],
  halfLives: HalfLives = HALF_LIVES,
  burstWindow = 0,
): Map<string, ItemScores<string>> {
  const known = entries.filter((e): e is StoredRename => e.kind === 'rename');
  const lists = new Map<string, { kind: EventKind; time: number }[]>();
  for (const e of entries) {
    if (e.kind === 'rename') continue;
    let item = e.item;
    let at: [number, number] = [e.time, -Infinity];
    for (;;) {
      const next = known
        .filter((r) => r.item === item && (r.time > at[0] || (r.time === at[0] && r.seq > at[1])))
        .sort((a, b) => a.time - b.time || a.seq - b.seq)[0];
      if (!next) break;
      item = next.to;
      at = [next.time, next.seq];
    }
    lists.set(item, [...(lists.get(item) ?? []), { kind: e.kind, time: e.time }]);
  }
  const out = new Map<string, ItemScores<string>>();
  for (const item of [...lists.keys()].sort()) {
    const events = lists.get(item) as { kind: EventKind; time: number }[];
    const scores: ItemScores<string> = {};
    for (const [name, h] of Object.entries(halfLives)) {
      const byKind: Partial<Record<EventKind, number>> = {};
      for (const kind of EVENT_KINDS) {
        const mine = keepBursts(
          events.filter((x) => x.kind === kind).map((x) => x.time),
          burstWindow,
        );
        if (mine.length > 0) byKind[kind] = combineAll(mine.map((t) => eventScore(1, t, h)));
      }
      scores[name] = byKind;
    }
    out.set(item, scores);
  }
  return out;
}

/**
 * The burst rule, written out independently: in time order, keep a time
 * when it is the first or at least `window` after the last kept one.
 */
function keepBursts(times: readonly number[], window: number): number[] {
  if (window === 0) return [...times];
  const kept: number[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const last = kept[kept.length - 1];
    if (last === undefined || t - last >= window) kept.push(t);
  }
  return kept;
}

/** Drafts packed into a few hours, so that bursts, late events and merges are common. */
const burstDraftArb: fc.Arbitrary<Draft> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constantFrom(...EVENT_KINDS),
      item: fc.constantFrom(...ITEMS),
      time: fc.integer({ min: NOW - 6 * 3600, max: NOW }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({
        kind: fc.constant('rename' as const),
        item: fc.constantFrom(...ITEMS),
        to: fc.constantFrom(...ITEMS),
        time: fc.integer({ min: NOW - 6 * 3600, max: NOW }),
      })
      .filter((r) => r.item !== r.to),
  },
);

const WORDS = [
  'lantern',
  'harbor',
  'orbit',
  'maple',
  'compost',
  'tomato',
  'tomatoes',
  'planting',
  'planted',
  'river',
  'quartz',
  'violin',
  'pebble',
  'meadow',
  'glacier',
  'cobalt',
  'saffron',
  'tundra',
  'ember',
  'falcon',
];

const textArb = (min: number, max: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...WORDS), { minLength: min, maxLength: max }).map((w) => w.join(' '));

const sectionArb: fc.Arbitrary<SectionInput> = fc.record({
  heading: fc.option(textArb(1, 3), { nil: null }),
  body: textArb(0, 25),
});

const NOTE_PATHS = [
  'memos/one.md',
  'memos/two.md',
  'memos/three.md',
  'diary/2026/01/2026-01-02.md',
];

type TermOp =
  | { op: 'replace'; path: string; title: string; sections: SectionInput[] }
  | { op: 'remove'; path: string };

const termOpArb: fc.Arbitrary<TermOp> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant('replace' as const),
      path: fc.constantFrom(...NOTE_PATHS),
      title: textArb(1, 3),
      sections: fc.array(sectionArb, { minLength: 0, maxLength: 4 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('remove' as const),
      path: fc.constantFrom(...NOTE_PATHS),
    }),
  },
);

const QUERIES = [
  'tomato',
  'lantern harbor',
  'planting river quartz',
  '"maple compost"',
  '"tomatoes planted" ember',
  'saffron',
  'glacier falcon tundra cobalt',
];

const note = (path: string, overrides: Partial<NoteRecord> = {}): NoteRecord => ({
  path,
  title: `Title of ${path}`,
  contentHash: `hash-${path}`,
  mtime: NOW - 100,
  role: 'memo',
  date: null,
  ...overrides,
});

/** Runs `fn` as a promise, so a synchronous throw becomes a rejection. */
const settle = <T>(fn: () => T): Promise<unknown> => Promise.resolve().then(fn);

function wrapScores(inner: ScoreStore, overrides: Partial<ScoreStore>): ScoreStore {
  return {
    foldState: () => inner.foldState(),
    getItem: (item) => inner.getItem(item),
    getAll: () => inner.getAll(),
    applyFold: (batch) => inner.applyFold(batch),
    burstState: (items) => inner.burstState(items),
    clear: () => inner.clear(),
    ...overrides,
  };
}

async function snapshotAll(stores: Stores) {
  return {
    notes: await stores.notes.listNotes(),
    links: await stores.notes.danglingTargets(),
    stats: await stores.terms.statistics(),
    scores: await stores.scores.getAll(),
    state: await stores.scores.foldState(),
  };
}

// ---------------------------------------------------------------------------
// The suite

/**
 * Registers the conformance tests for one storage implementation. Call it at
 * the top level of a test file.
 */
export function describeStorageConformance(
  name: string,
  makeHarness: () => Awaitable<StorageHarness>,
  options: ConformanceOptions = {},
): void {
  const numRuns = options.numRuns ?? 25;
  const timeout = options.timeout ?? 60_000;

  describe(`storage conformance: ${name}`, () => {
    let harness: StorageHarness;
    let open: Stores[] = [];

    const openStores = async (opts?: StoresOptions): Promise<Stores> => {
      const stores = await harness.open({ now: () => NOW, ...opts });
      open.push(stores);
      return stores;
    };
    const reopen = async (stores: Stores, opts?: StoresOptions): Promise<Stores> => {
      await stores.close();
      const again = await harness.reopen(stores, { now: () => NOW, ...opts });
      open.push(again);
      return again;
    };

    beforeEach(async () => {
      harness = await makeHarness();
      open = [];
    });
    afterEach(async () => {
      for (const s of open) {
        try {
          await s.close();
        } catch {
          // already closed
        }
      }
      await harness.dispose?.();
    });

    // -- Event log ----------------------------------------------------------

    describe('event log', () => {
      it('appends entries in order and reads them after a cursor', { timeout }, async () => {
        const s = await openStores();
        expect(await s.events.lastSeq()).toBe(0);
        const r = await s.events.append([
          ev('a', 'read', 'memos/x.md', NOW - 50),
          ev('b', 'edit', 'memos/x.md', NOW - 40),
          rn('c', 'memos/x.md', 'memos/y.md', NOW - 30),
          ev('d', 'mention', 'dangling key', NOW),
        ]);
        expect(r).toEqual({ appended: 4, duplicates: 0 });
        const all = await s.events.readAfter(0);
        expect(all).toEqual([
          { seq: 1, id: 'a', kind: 'read', item: 'memos/x.md', time: NOW - 50, client: CLIENT },
          { seq: 2, id: 'b', kind: 'edit', item: 'memos/x.md', time: NOW - 40, client: CLIENT },
          {
            seq: 3,
            id: 'c',
            kind: 'rename',
            item: 'memos/x.md',
            to: 'memos/y.md',
            time: NOW - 30,
            client: CLIENT,
          },
          { seq: 4, id: 'd', kind: 'mention', item: 'dangling key', time: NOW, client: CLIENT },
        ]);
        expect((await s.events.readAfter(2)).map((e) => e.id)).toEqual(['c', 'd']);
        expect((await s.events.readAfter(1, { limit: 2 })).map((e) => e.id)).toEqual(['b', 'c']);
        expect(await s.events.readAfter(4)).toEqual([]);
        expect(await s.events.lastSeq()).toBe(4);
        expect(await s.events.countByKind()).toEqual({ read: 1, edit: 1, mention: 1, rename: 1 });
        expect((await s.events.renames()).map((e) => e.id)).toEqual(['c']);
        expect(await s.events.renames({ throughSeq: 2 })).toEqual([]);
      });

      it('ignores an id it already has, within and across batches', { timeout }, async () => {
        const s = await openStores();
        await s.events.append([ev('a', 'read', 'memos/x.md', NOW - 5)]);
        const r = await s.events.append([
          ev('a', 'edit', 'memos/other.md', NOW - 1),
          ev('b', 'read', 'memos/x.md', NOW - 4),
          ev('b', 'read', 'memos/x.md', NOW - 4),
          rn('a', 'memos/x.md', 'memos/z.md', NOW - 2),
        ]);
        expect(r).toEqual({ appended: 1, duplicates: 3 });
        const all = await s.events.readAfter(0);
        expect(all.map((e) => [e.seq, e.id, e.kind])).toEqual([
          [1, 'a', 'read'],
          [2, 'b', 'read'],
        ]);
      });

      it(
        'stores the first copy of each id, whatever the batches (property)',
        { timeout },
        async () => {
          await fc.assert(
            fc.asyncProperty(
              fc.array(
                fc.array(fc.tuple(fc.integer({ min: 0, max: 15 }), draftArb), { maxLength: 8 }),
                { maxLength: 5 },
              ),
              async (batches) => {
                const s = await openStores();
                const expected: string[] = [];
                const seen = new Set<string>();
                for (const batch of batches) {
                  const inputs = batch.map(([n, d]) => toInputs([d], `id${n}-`)[0] as LogInput);
                  // toInputs suffixes the index (always 0 here), so ids repeat when n does.
                  await s.events.append(inputs);
                  for (const e of inputs) {
                    if (!seen.has(e.id)) {
                      seen.add(e.id);
                      expected.push(e.id);
                    }
                  }
                }
                const all = await s.events.readAfter(0);
                expect(all.map((e) => e.id)).toEqual(expected);
                expect(all.map((e) => e.seq)).toEqual(expected.map((_, i) => i + 1));
                await s.close();
              },
            ),
            { numRuns },
          );
        },
      );

      it(
        'rejects future-dated and invalid entries, storing nothing from the batch',
        { timeout },
        async () => {
          const s = await openStores();
          await expect(
            settle(() =>
              s.events.append([
                ev('ok', 'read', 'memos/x.md', NOW),
                ev('late', 'read', 'memos/x.md', NOW + 1),
              ]),
            ),
          ).rejects.toBeInstanceOf(FutureEventError);
          await expect(
            settle(() => s.events.append([rn('r', 'memos/x.md', 'memos/y.md', NOW + 60)])),
          ).rejects.toBeInstanceOf(FutureEventError);
          const bad: unknown[] = [
            { id: 'k', kind: 'like', item: 'memos/x.md', time: NOW, client: CLIENT },
            { id: 't', kind: 'read', item: 'memos/x.md', time: NOW - 0.5, client: CLIENT },
            { id: 'n', kind: 'read', item: 'memos/x.md', time: Number.NaN, client: CLIENT },
            { id: '', kind: 'read', item: 'memos/x.md', time: NOW, client: CLIENT },
            { id: 'i', kind: 'read', item: '', time: NOW, client: CLIENT },
            { id: 'c', kind: 'read', item: 'memos/x.md', time: NOW, client: '' },
            {
              id: 's',
              kind: 'rename',
              item: 'memos/x.md',
              to: 'memos/x.md',
              time: NOW,
              client: CLIENT,
            },
            { id: 'u', kind: 'rename', item: 'memos/x.md', time: NOW, client: CLIENT },
            { id: 'x'.repeat(201), kind: 'read', item: 'memos/x.md', time: NOW, client: CLIENT },
          ];
          for (const entry of bad) {
            await expect(
              settle(() =>
                s.events.append([ev('fine', 'read', 'memos/x.md', NOW), entry as LogInput]),
              ),
            ).rejects.toBeInstanceOf(InvalidEventError);
          }
          // The clock can be overridden per call.
          await expect(
            settle(() =>
              s.events.append([ev('later', 'read', 'memos/x.md', NOW + 10)], { now: NOW + 5 }),
            ),
          ).rejects.toBeInstanceOf(FutureEventError);
          expect(await s.events.readAfter(0)).toEqual([]);
          await s.events.append([ev('later', 'read', 'memos/x.md', NOW + 10)], { now: NOW + 10 });
          expect(await s.events.lastSeq()).toBe(1);
        },
      );

      it('keeps the log across a reopen', { timeout }, async () => {
        let s = await openStores();
        await s.events.append([
          ev('a', 'read', 'memos/x.md', NOW - 5),
          rn('b', 'memos/x.md', 'k', NOW),
        ]);
        await s.events.appendChanges([
          {
            id: 'c1',
            time: NOW,
            client: CLIENT,
            message: 'update x',
            op: 'update',
            paths: ['memos/x.md'],
          },
        ]);
        await s.meta.set('first-indexed', String(NOW));
        s = await reopen(s);
        expect((await s.events.readAfter(0)).map((e) => e.id)).toEqual(['a', 'b']);
        expect((await s.events.changes()).map((c) => c.id)).toEqual(['c1']);
        expect(await s.meta.get('first-indexed')).toBe(String(NOW));
      });
    });

    // -- Change records -----------------------------------------------------

    describe('change records', () => {
      const change = (
        id: string,
        time: number,
        message: string | null,
        paths: string[],
      ): ChangeInput => ({ id, time, client: CLIENT, message, op: changeOp(message), paths });

      it('derives the op from the first word with changeOp', () => {
        expect(changeOp('ingest three new sources')).toBe('ingest');
        expect(changeOp('  lint\nfix links')).toBe('lint');
        expect(changeOp('Ingest capitalized')).toBeNull();
        expect(changeOp('rewrote things')).toBeNull();
        expect(changeOp(null)).toBeNull();
        expect(changeOp('')).toBeNull();
        expect(changeOp('garden notes', ['garden'])).toBe('garden');
      });

      it(
        'appends idempotently and filters by path, op and time, newest first',
        { timeout },
        async () => {
          const s = await openStores();
          const r = await s.events.appendChanges([
            change('c1', NOW - 300, 'ingest the maple source', [
              'sources/maple.md',
              'memos/maple.md',
            ]),
            change('c2', NOW - 200, 'update harbor notes', ['memos/harbor.md', 'memos/harbor.md']),
            change('c3', NOW - 200, null, ['diary/2026/01/2026-01-02.md']),
            change('c4', NOW - 100, 'session planting day', ['memos/maple.md', 'memos/harbor.md']),
            change('c1', NOW - 50, 'duplicate id', ['memos/other.md']),
          ]);
          expect(r).toEqual({ appended: 4, duplicates: 1 });
          const all = await s.events.changes();
          expect(all.map((c) => c.id)).toEqual(['c4', 'c3', 'c2', 'c1']);
          expect(all.find((c) => c.id === 'c2')).toEqual({
            seq: 2,
            id: 'c2',
            time: NOW - 200,
            client: CLIENT,
            message: 'update harbor notes',
            op: 'update',
            paths: ['memos/harbor.md'],
          });
          expect(all.find((c) => c.id === 'c1')?.paths).toEqual([
            'memos/maple.md',
            'sources/maple.md',
          ]);
          expect(all.find((c) => c.id === 'c3')).toMatchObject({ message: null, op: null });
          const ids = async (f: Parameters<Stores['events']['changes']>[0]) =>
            (await s.events.changes(f)).map((c) => c.id);
          expect(await ids({ path: 'memos/maple.md' })).toEqual(['c4', 'c1']);
          expect(await ids({ op: 'update' })).toEqual(['c2']);
          expect(await ids({ since: NOW - 200 })).toEqual(['c4', 'c3', 'c2']);
          expect(await ids({ until: NOW - 200 })).toEqual(['c1']);
          expect(await ids({ since: NOW - 250, until: NOW - 100 })).toEqual(['c3', 'c2']);
          expect(await ids({ path: 'memos/harbor.md', op: 'session' })).toEqual(['c4']);
          expect(await ids({ limit: 2 })).toEqual(['c4', 'c3']);
          expect(await ids({ path: 'memos/none.md' })).toEqual([]);
        },
      );

      it('rejects future-dated and invalid change records', { timeout }, async () => {
        const s = await openStores();
        await expect(
          settle(() =>
            s.events.appendChanges([change('ok', NOW, null, []), change('f', NOW + 1, null, [])]),
          ),
        ).rejects.toBeInstanceOf(FutureEventError);
        await expect(
          settle(() => s.events.appendChanges([{ ...change('p', NOW, null, []), paths: [''] }])),
        ).rejects.toBeInstanceOf(InvalidEventError);
        await expect(
          settle(() => s.events.appendChanges([{ ...change('t', NOW, null, []), time: 1.5 }])),
        ).rejects.toBeInstanceOf(InvalidEventError);
        expect(await s.events.changes()).toEqual([]);
      });
    });

    // -- Scores and folding ---------------------------------------------------

    describe('folding', () => {
      it('folds unweighted per-kind scores for every half-life', { timeout }, async () => {
        const s = await openStores();
        await s.events.append([
          ev('a', 'read', 'memos/x.md', NOW - 86_400),
          ev('b', 'read', 'memos/x.md', NOW),
          ev('c', 'edit', 'memos/x.md', NOW - 10),
          ev('d', 'mention', 'some key', NOW - 20),
        ]);
        const result = await foldPending(s.events, s.scores);
        expect(result).toEqual({
          events: 4,
          renames: 0,
          cursor: 4,
          batches: 1,
          rebuilt: false,
          conflicts: 0,
        });
        expect(await s.scores.foldState()).toEqual({ cursor: 4, halfLives: { ...HALF_LIVES } });
        const x = await s.scores.getItem('memos/x.md');
        expect(Object.keys(x ?? {}).sort()).toEqual(['day', 'month', 'week', 'year']);
        const day = HALF_LIVES.day;
        expect(x?.day?.read).toBe(
          combine(eventScore(1, NOW - 86_400, day), eventScore(1, NOW, day)),
        );
        expect(x?.day?.edit).toBe(eventScore(1, NOW - 10, day));
        expect(x?.day?.mention).toBeUndefined();
        expect(await s.scores.getItem('nothing')).toBeUndefined();
        expect([...(await s.scores.getAll()).keys()]).toEqual(['memos/x.md', 'some key']);
        // Nothing new: nothing changes.
        expect(await foldPending(s.events, s.scores)).toMatchObject({
          events: 0,
          batches: 0,
          cursor: 4,
        });
      });

      it(
        'incremental folding equals a rebuild and the model, with renames (property)',
        { timeout },
        async () => {
          await fc.assert(
            fc.asyncProperty(
              fc.array(draftArb, { maxLength: 60 }),
              fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 8 }),
              fc.integer({ min: 1, max: 7 }),
              async (drafts, chunks, batchSize) => {
                const s = await openStores();
                const inputs = toInputs(drafts);
                let at = 0;
                let c = 0;
                while (at < inputs.length) {
                  const n = chunks[c++ % chunks.length] as number;
                  await s.events.append(inputs.slice(at, at + n));
                  at += n;
                  await foldPending(s.events, s.scores, { batchSize });
                }
                await foldPending(s.events, s.scores, { batchSize });
                const incremental = await s.scores.getAll();
                expect((await s.scores.foldState()).cursor).toBe(inputs.length);
                const model = modelScores(await s.events.readAfter(0));
                expectScoresClose(incremental, model);

                const rebuilt = await rebuildScores(s.events, s.scores);
                expect(rebuilt).toMatchObject({
                  events: drafts.filter((d) => d.kind !== 'rename').length,
                });
                expectScoresClose(await s.scores.getAll(), incremental);
                await s.close();
              },
            ),
            { numRuns },
          );
        },
      );

      it(
        'resumes after a crash between reading and committing, counting nothing twice',
        { timeout },
        async () => {
          const s = await openStores();
          await s.events.append([
            ev('a', 'read', 'memos/x.md', NOW - 9),
            ev('b', 'edit', 'memos/y.md', NOW - 8),
          ]);
          await foldPending(s.events, s.scores);
          const before = await s.scores.getAll();
          await s.events.append([
            ev('c', 'read', 'memos/x.md', NOW - 7),
            rn('d', 'memos/y.md', 'memos/z.md', NOW - 6),
            ev('e', 'read', 'memos/z.md', NOW - 5),
          ]);
          const crashing = wrapScores(s.scores, {
            applyFold: () => {
              throw new Error('simulated crash');
            },
          });
          await expect(foldPending(s.events, crashing)).rejects.toThrow('simulated crash');
          expect((await s.scores.foldState()).cursor).toBe(2);
          expectScoresClose(await s.scores.getAll(), before);

          await foldPending(s.events, s.scores);
          expect((await s.scores.foldState()).cursor).toBe(5);
          expectScoresClose(await s.scores.getAll(), modelScores(await s.events.readAfter(0)));
        },
      );

      it(
        'applies a batch atomically: an invalid op rolls back the ops before it',
        { timeout },
        async () => {
          const s = await openStores();
          await s.events.append([ev('a', 'read', 'memos/x.md', NOW - 9)]);
          await foldPending(s.events, s.scores);
          const before = await snapshotAll(s);
          await expect(
            settle(() =>
              s.scores.applyFold({
                fromCursor: 1,
                toCursor: 2,
                halfLives: HALF_LIVES,
                ops: [
                  { type: 'add', item: 'memos/x.md', kind: 'read', halfLife: 'day', logScore: 1 },
                  { type: 'move', from: 'memos/x.md', to: 'memos/w.md' },
                  {
                    type: 'add',
                    item: 'memos/x.md',
                    kind: 'read',
                    halfLife: 'day',
                    logScore: Number.NaN,
                  },
                ],
              }),
            ),
          ).rejects.toBeInstanceOf(RangeError);
          expect(await snapshotAll(s)).toEqual(before);
        },
      );

      it('refuses a batch computed from a stale cursor', { timeout }, async () => {
        const s = await openStores();
        await s.events.append([ev('a', 'read', 'memos/x.md', NOW - 9)]);
        await foldPending(s.events, s.scores);
        const before = await snapshotAll(s);
        await expect(
          settle(() =>
            s.scores.applyFold({
              fromCursor: 0,
              toCursor: 1,
              halfLives: HALF_LIVES,
              ops: [
                { type: 'add', item: 'memos/x.md', kind: 'read', halfLife: 'day', logScore: 5 },
              ],
            }),
          ),
        ).rejects.toBeInstanceOf(FoldConflictError);
        expect(await snapshotAll(s)).toEqual(before);
      });

      it(
        'retries when another folder commits first, counting nothing twice',
        { timeout },
        async () => {
          const s = await openStores();
          await s.events.append([
            ev('a', 'read', 'memos/x.md', NOW - 9),
            ev('b', 'read', 'memos/x.md', NOW - 8),
          ]);
          let raced = false;
          const racing = wrapScores(s.scores, {
            applyFold: async (batch) => {
              if (!raced) {
                raced = true;
                // Another process folds the same entries first.
                await foldPending(s.events, s.scores);
                await s.events.append([ev('c', 'edit', 'memos/x.md', NOW - 7)]);
              }
              return s.scores.applyFold(batch);
            },
          });
          const result = await foldPending(s.events, racing);
          expect(result.conflicts).toBe(1);
          expect(result.events).toBe(1); // only "c"; the other folder counted "a" and "b"
          expect((await s.scores.foldState()).cursor).toBe(3);
          expectScoresClose(await s.scores.getAll(), modelScores(await s.events.readAfter(0)));
        },
      );

      it('rebuilds when the half-lives change, or throws if asked to', { timeout }, async () => {
        const s = await openStores();
        await s.events.append([ev('a', 'read', 'memos/x.md', NOW - 9)]);
        await foldPending(s.events, s.scores);
        const custom = { hour: 3600, day: 86_400 };
        await expect(
          foldPending(s.events, s.scores, { halfLives: custom, onHalfLifeMismatch: 'throw' }),
        ).rejects.toBeInstanceOf(HalfLifeMismatchError);
        await expect(
          settle(() =>
            s.scores.applyFold({ fromCursor: 1, toCursor: 1, halfLives: custom, ops: [] }),
          ),
        ).rejects.toBeInstanceOf(HalfLifeMismatchError);
        const r = await foldPending(s.events, s.scores, { halfLives: custom });
        expect(r).toMatchObject({ rebuilt: true, events: 1, cursor: 1 });
        expect(await s.scores.foldState()).toEqual({ cursor: 1, halfLives: custom });
        const x = await s.scores.getItem('memos/x.md');
        expect(Object.keys(x ?? {}).sort()).toEqual(['day', 'hour']);
        expect(x?.hour?.read).toBe(eventScore(1, NOW - 9, 3600));
      });

      it('clears scores and the cursor', { timeout }, async () => {
        const s = await openStores();
        await s.events.append([ev('a', 'read', 'memos/x.md', NOW - 9)]);
        await foldPending(s.events, s.scores);
        await s.scores.clear();
        expect(await s.scores.foldState()).toEqual({ cursor: 0, halfLives: null });
        expect((await s.scores.getAll()).size).toBe(0);
        expect(await s.events.lastSeq()).toBe(1);
      });
    });

    describe('the burst rule', () => {
      const H = 3600;
      const day = HALF_LIVES.day as number;

      it(
        'counts one event per window per item and kind, and keeps the state',
        { timeout },
        async () => {
          const s = await openStores();
          await s.events.append([
            ev('a', 'edit', 'memos/x.md', NOW - 5000),
            ev('b', 'edit', 'memos/x.md', NOW - 4000), // within the hour after a: dropped
            ev('c', 'edit', 'memos/x.md', NOW - 1400), // 3600 after a: counts
            ev('d', 'read', 'memos/x.md', NOW - 4000), // another kind: counts
            ev('e', 'edit', 'memos/y.md', NOW - 4000), // another item: counts
            ev('f', 'edit', 'memos/x.md', NOW - 1400), // same second as c: dropped
          ]);
          const r = await foldPending(s.events, s.scores, { burstWindow: H });
          expect(r).toMatchObject({ events: 6, collapsed: 2, cursor: 6, rebuilt: false });
          expect(await s.scores.foldState()).toEqual({
            cursor: 6,
            halfLives: { ...HALF_LIVES },
            burstWindow: H,
          });
          const x = await s.scores.getItem('memos/x.md');
          expect(x?.day?.edit).toBe(
            combineAll([NOW - 5000, NOW - 1400].map((t) => eventScore(1, t, day))),
          );
          expect(x?.day?.read).toBe(eventScore(1, NOW - 4000, day));
          expect(await s.scores.burstState(['memos/x.md', 'memos/y.md', 'memos/none.md'])).toEqual(
            new Map([
              ['memos/x.md', { read: NOW - 4000, edit: NOW - 1400 }],
              ['memos/y.md', { edit: NOW - 4000 }],
            ]),
          );
          // Later events decide from the stored state.
          await s.events.append([
            ev('g', 'edit', 'memos/x.md', NOW - 1000), // dropped
            ev('h', 'edit', 'memos/x.md', NOW), // 1400 after c: dropped
            ev('i', 'edit', 'memos/y.md', NOW - 400), // 3600 after e: counts
          ]);
          const r2 = await foldPending(s.events, s.scores, { burstWindow: H });
          expect(r2).toMatchObject({ events: 3, collapsed: 2 });
          expect(r2.refolded).toBeUndefined();
          expectScoresClose(
            await s.scores.getAll(),
            modelScores(await s.events.readAfter(0), HALF_LIVES, H),
          );
          // A rename carries the state with the scores.
          await s.events.append([rn('r', 'memos/y.md', 'memos/z.md', NOW)]);
          await foldPending(s.events, s.scores, { burstWindow: H });
          expect(await s.scores.burstState(['memos/y.md', 'memos/z.md'])).toEqual(
            new Map([['memos/z.md', { edit: NOW - 400 }]]),
          );
          await s.scores.clear();
          expect(await s.scores.burstState(['memos/x.md', 'memos/z.md'])).toEqual(new Map());
          expect(await s.scores.foldState()).toEqual({ cursor: 0, halfLives: null });
        },
      );

      it(
        'incremental folding equals a rebuild and the model, with renames and late events (property)',
        { timeout },
        async () => {
          await fc.assert(
            fc.asyncProperty(
              fc.array(burstDraftArb, { maxLength: 50 }),
              fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 6 }),
              fc.integer({ min: 1, max: 7 }),
              fc.constantFrom(60, H),
              async (drafts, chunks, batchSize, window) => {
                const s = await openStores();
                const inputs = toInputs(drafts);
                let at = 0;
                let c = 0;
                while (at < inputs.length) {
                  const n = chunks[c++ % chunks.length] as number;
                  await s.events.append(inputs.slice(at, at + n));
                  at += n;
                  await foldPending(s.events, s.scores, { batchSize, burstWindow: window });
                }
                await foldPending(s.events, s.scores, { batchSize, burstWindow: window });
                const incremental = await s.scores.getAll();
                expect((await s.scores.foldState()).cursor).toBe(inputs.length);
                const model = modelScores(await s.events.readAfter(0), HALF_LIVES, window);
                expectScoresClose(incremental, model);
                const state = await s.scores.burstState([...incremental.keys()]);

                await rebuildScores(s.events, s.scores, { burstWindow: window });
                expectScoresClose(await s.scores.getAll(), incremental);
                expect(await s.scores.burstState([...incremental.keys()])).toEqual(state);
                await s.close();
              },
            ),
            { numRuns },
          );
        },
      );

      it(
        'gives the same scores whatever order the entries arrive in (property)',
        { timeout },
        async () => {
          await fc.assert(
            fc.asyncProperty(
              fc.array(burstDraftArb, { minLength: 1, maxLength: 30 }),
              fc.integer({ min: 0, max: 1_000_000 }),
              async (drafts, seed) => {
                const inputs = toInputs(drafts);
                // A seeded shuffle: a second arrival order of the same entries.
                const shuffled = [...inputs];
                let x = seed + 1;
                for (let i = shuffled.length - 1; i > 0; i--) {
                  x = (x * 1103515245 + 12345) % 2147483648;
                  const j = x % (i + 1);
                  [shuffled[i], shuffled[j]] = [shuffled[j] as LogInput, shuffled[i] as LogInput];
                }
                const results: Map<string, ItemScores<string>>[] = [];
                for (const order of [inputs, shuffled]) {
                  const s = await openStores();
                  for (let i = 0; i < order.length; i += 3) {
                    await s.events.append(order.slice(i, i + 3));
                    await foldPending(s.events, s.scores, { burstWindow: H, batchSize: 2 });
                  }
                  results.push(await s.scores.getAll());
                  expectScoresClose(
                    results.at(-1) as Map<string, ItemScores<string>>,
                    modelScores(await s.events.readAfter(0), HALF_LIVES, H),
                  );
                  await s.close();
                }
                expectScoresClose(
                  results[1] as Map<string, ItemScores<string>>,
                  results[0] as Map<string, ItemScores<string>>,
                );
              },
            ),
            { numRuns },
          );
        },
      );

      it(
        'refolds canonically when a late event lands before a counted one',
        { timeout },
        async () => {
          const s = await openStores();
          await s.events.append([
            ev('a', 'edit', 'memos/x.md', NOW - 7000),
            ev('b', 'edit', 'memos/x.md', NOW - 3000), // counts (4000 after a)
          ]);
          await foldPending(s.events, s.scores, { burstWindow: H });
          // Synced late: an edit between them. Now b is within the hour of it.
          await s.events.append([ev('late', 'edit', 'memos/x.md', NOW - 5000)]);
          const r = await foldPending(s.events, s.scores, { burstWindow: H });
          expect(r.refolded).toBe(true);
          const x = await s.scores.getItem('memos/x.md');
          // a counts; late is 2000 after a: dropped; b is 4000 after a: counts. Same as before.
          expect(x?.day?.edit).toBeCloseTo(
            combineAll([NOW - 7000, NOW - 3000].map((t) => eventScore(1, t, day))),
            9,
          );
          await s.events.append([ev('early', 'edit', 'memos/x.md', NOW - 9000)]);
          await foldPending(s.events, s.scores, { burstWindow: H });
          // early counts; a is 2000 after it: dropped; late is 4000 after early: counts; b is 2000 after late: dropped.
          expect((await s.scores.getItem('memos/x.md'))?.day?.edit).toBeCloseTo(
            combineAll([NOW - 9000, NOW - 5000].map((t) => eventScore(1, t, day))),
            9,
          );
          expect(await s.scores.burstState(['memos/x.md'])).toEqual(
            new Map([['memos/x.md', { edit: NOW - 5000 }]]),
          );
        },
      );

      it(
        'refolds when a rename merges two items with events of one kind, following the history',
        { timeout },
        async () => {
          const s = await openStores();
          await s.events.append([
            ev('m1', 'mention', 'ember plan', NOW - 5000),
            ev('m2', 'mention', 'memos/ember.md', NOW - 4000),
            ev('m3', 'mention', 'memos/ember.md', NOW - 1000),
          ]);
          await foldPending(s.events, s.scores, { burstWindow: H });
          await s.events.append([rn('r', 'ember plan', 'memos/ember.md', NOW - 500)]);
          const r = await foldPending(s.events, s.scores, { burstWindow: H });
          expect(r.refolded).toBe(true);
          // One history: m1 counts, m2 (1000 later) does not, m3 (4000 after m1) does.
          expectScoresClose(
            await s.scores.getAll(),
            modelScores(await s.events.readAfter(0), HALF_LIVES, H),
          );
          expect((await s.scores.getItem('memos/ember.md'))?.day?.mention).toBeCloseTo(
            combineAll([NOW - 5000, NOW - 1000].map((t) => eventScore(1, t, day))),
            9,
          );
        },
      );

      it('rebuilds when the window changes, or throws if asked to', { timeout }, async () => {
        const s = await openStores();
        await s.events.append([
          ev('a', 'read', 'memos/x.md', NOW - 90),
          ev('b', 'read', 'memos/x.md', NOW - 50),
        ]);
        await foldPending(s.events, s.scores);
        expect(await s.scores.foldState()).toEqual({ cursor: 2, halfLives: { ...HALF_LIVES } });
        await expect(
          foldPending(s.events, s.scores, { burstWindow: 60, onHalfLifeMismatch: 'throw' }),
        ).rejects.toBeInstanceOf(BurstWindowMismatchError);
        await expect(
          settle(() =>
            s.scores.applyFold({
              fromCursor: 2,
              toCursor: 2,
              halfLives: HALF_LIVES,
              burstWindow: 60,
              ops: [],
            }),
          ),
        ).rejects.toBeInstanceOf(BurstWindowMismatchError);
        const r = await foldPending(s.events, s.scores, { burstWindow: 60 });
        expect(r).toMatchObject({ rebuilt: true, events: 2, collapsed: 1 });
        expect((await s.scores.foldState()).burstWindow).toBe(60);
        expect((await s.scores.getItem('memos/x.md'))?.day?.read).toBe(
          eventScore(1, NOW - 90, day),
        );
        const back = await foldPending(s.events, s.scores, { burstWindow: 0 });
        expect(back).toMatchObject({ rebuilt: true, events: 2 });
        expect(back.collapsed).toBeUndefined();
        expect(await s.scores.foldState()).toEqual({ cursor: 2, halfLives: { ...HALF_LIVES } });
        expect(await s.scores.burstState(['memos/x.md'])).toEqual(new Map());
      });

      it(
        'with a window of 0, folds exactly as without the rule (property)',
        { timeout },
        async () => {
          await fc.assert(
            fc.asyncProperty(
              fc.array(burstDraftArb, { maxLength: 40 }),
              fc.integer({ min: 1, max: 5 }),
              async (drafts, batchSize) => {
                const inputs = toInputs(drafts);
                const fold = async (options: Parameters<typeof foldPending>[2]) => {
                  const s = await openStores();
                  for (let i = 0; i < inputs.length; i += 4) {
                    await s.events.append(inputs.slice(i, i + 4));
                    await foldPending(s.events, s.scores, { batchSize, ...options });
                  }
                  const out = {
                    scores: await s.scores.getAll(),
                    state: await s.scores.foldState(),
                    burst: await s.scores.burstState(ITEMS),
                  };
                  await s.close();
                  return out;
                };
                const plain = await fold({});
                const zero = await fold({ burstWindow: 0 });
                expect(zero).toEqual(plain);
                expect(zero.burst.size).toBe(0);
                expect('burstWindow' in zero.state).toBe(false);
                // And exactly the model's every-event scores (no event is dropped).
                const s = await openStores();
                await s.events.append(inputs);
                await rebuildScores(s.events, s.scores, { burstWindow: 0 });
                expectScoresClose(
                  await s.scores.getAll(),
                  modelScores(await s.events.readAfter(0)),
                );
                await s.close();
              },
            ),
            { numRuns },
          );
        },
      );

      it(
        'retries when another folder commits first, counting nothing twice',
        { timeout },
        async () => {
          const s = await openStores();
          await s.events.append([
            ev('a', 'read', 'memos/x.md', NOW - 9000),
            ev('b', 'read', 'memos/x.md', NOW - 8000),
          ]);
          let raced = false;
          const racing = wrapScores(s.scores, {
            applyFold: async (batch) => {
              if (!raced) {
                raced = true;
                await foldPending(s.events, s.scores, { burstWindow: H });
                await s.events.append([ev('c', 'read', 'memos/x.md', NOW - 100)]);
              }
              return s.scores.applyFold(batch);
            },
          });
          const result = await foldPending(s.events, racing, { burstWindow: H });
          expect(result).toMatchObject({ conflicts: 1, events: 1, collapsed: 0 });
          expectScoresClose(
            await s.scores.getAll(),
            modelScores(await s.events.readAfter(0), HALF_LIVES, H),
          );
          expect(await s.scores.burstState(['memos/x.md'])).toEqual(
            new Map([['memos/x.md', { read: NOW - 100 }]]),
          );
        },
      );

      it('rolls back a batch with an invalid burst op', { timeout }, async () => {
        const s = await openStores();
        await s.events.append([ev('a', 'read', 'memos/x.md', NOW - 9)]);
        await foldPending(s.events, s.scores, { burstWindow: H });
        const before = await snapshotAll(s);
        const state = await s.scores.burstState(['memos/x.md']);
        await expect(
          settle(() =>
            s.scores.applyFold({
              fromCursor: 1,
              toCursor: 2,
              halfLives: HALF_LIVES,
              burstWindow: H,
              ops: [
                { type: 'last', item: 'memos/x.md', kind: 'read', time: NOW },
                { type: 'last', item: 'memos/x.md', kind: 'read', time: 1.5 },
              ],
            }),
          ),
        ).rejects.toBeInstanceOf(RangeError);
        expect(await snapshotAll(s)).toEqual(before);
        expect(await s.scores.burstState(['memos/x.md'])).toEqual(state);
      });
    });

    describe('renames', () => {
      const day = HALF_LIVES.day;

      it('moves history, combining with scores the target already has', { timeout }, async () => {
        const s = await openStores();
        await s.events.append([
          ev('a', 'read', 'memos/old.md', NOW - 100),
          ev('b', 'read', 'memos/new.md', NOW - 90),
          ev('c', 'edit', 'memos/old.md', NOW - 80),
        ]);
        await foldPending(s.events, s.scores);
        await s.events.append([rn('r', 'memos/old.md', 'memos/new.md', NOW - 50)]);
        await foldPending(s.events, s.scores);
        expect(await s.scores.getItem('memos/old.md')).toBeUndefined();
        const moved = await s.scores.getItem('memos/new.md');
        expect(moved?.day?.read).toBe(
          combine(eventScore(1, NOW - 90, day), eventScore(1, NOW - 100, day)),
        );
        expect(moved?.day?.edit).toBe(eventScore(1, NOW - 80, day));
      });

      it('carries a dangling key’s history to the note that resolves it', { timeout }, async () => {
        const s = await openStores();
        await s.events.append([
          ev('m1', 'mention', 'quartz garden', NOW - 500),
          ev('m2', 'mention', 'quartz garden', NOW - 400),
          rn('r', 'quartz garden', 'memos/quartz-garden.md', NOW - 300),
          ev('e', 'edit', 'memos/quartz-garden.md', NOW - 300),
        ]);
        await foldPending(s.events, s.scores);
        expect(await s.scores.getItem('quartz garden')).toBeUndefined();
        const note = await s.scores.getItem('memos/quartz-garden.md');
        expect(note?.day?.mention).toBe(
          combine(eventScore(1, NOW - 500, day), eventScore(1, NOW - 400, day)),
        );
        expect(note?.day?.edit).toBe(eventScore(1, NOW - 300, day));
      });

      it(
        'folds a rename that arrives after later-dated events by time, whatever the arrival order',
        { timeout },
        async () => {
          const entries = [
            ev('o1', 'read', 'memos/x.md', NOW - 100),
            ev('o2', 'read', 'memos/x.md', NOW - 10), // after the rename: a new note at x
            rn('o3', 'memos/x.md', 'memos/y.md', NOW - 50),
            ev('o4', 'edit', 'memos/y.md', NOW - 20),
            rn('o5', 'memos/y.md', 'memos/z.md', NOW - 30), // a chain, also late
          ];
          const day = HALF_LIVES.day as number;
          const results: Map<string, ItemScores<string>>[] = [];
          for (const order of [
            [0, 1, 2, 3, 4],
            [2, 4, 0, 1, 3],
            [4, 3, 1, 0, 2],
          ]) {
            const s = await openStores();
            for (const i of order) {
              await s.events.append([entries[i] as LogInput]);
              await foldPending(s.events, s.scores);
            }
            const scores = await s.scores.getAll();
            expectScoresClose(scores, modelScores(await s.events.readAfter(0)));
            results.push(scores);
            await rebuildScores(s.events, s.scores);
            expectScoresClose(await s.scores.getAll(), scores);
            await s.close();
          }
          expectScoresClose(
            results[1] as Map<string, ItemScores<string>>,
            results[0] as Map<string, ItemScores<string>>,
          );
          expectScoresClose(
            results[2] as Map<string, ItemScores<string>>,
            results[0] as Map<string, ItemScores<string>>,
          );
          const first = results[0] as Map<string, ItemScores<string>>;
          expect(first.get('memos/x.md')?.day?.read).toBe(eventScore(1, NOW - 10, day));
          expect(first.get('memos/z.md')?.day?.read).toBe(eventScore(1, NOW - 100, day));
          expect(first.get('memos/y.md')?.day?.edit).toBe(eventScore(1, NOW - 20, day));
          expect(first.has('memos/y.md') && first.get('memos/y.md')?.day?.read).toBeFalsy();
        },
      );

      it(
        'sends late events dated before a rename to the new name, through chains',
        { timeout },
        async () => {
          const s = await openStores();
          await s.events.append([
            rn('r1', 'memos/a.md', 'memos/b.md', NOW - 300),
            rn('r2', 'memos/b.md', 'memos/c.md', NOW - 200),
          ]);
          await foldPending(s.events, s.scores);
          // Synced late: events that happened before the renames.
          await s.events.append([
            ev('x', 'read', 'memos/a.md', NOW - 400),
            ev('y', 'read', 'memos/b.md', NOW - 250),
            ev('z', 'read', 'memos/a.md', NOW - 300), // at the rename's own second: before it
          ]);
          await foldPending(s.events, s.scores);
          expect([...(await s.scores.getAll()).keys()]).toEqual(['memos/c.md']);
          const c = await s.scores.getItem('memos/c.md');
          expect(c?.day?.read).toBeCloseTo(
            combineAll([NOW - 400, NOW - 250, NOW - 300].map((t) => eventScore(1, t, day))),
            9,
          );
        },
      );

      it(
        'keeps events dated after a rename on the old name, which is a new note',
        { timeout },
        async () => {
          const s = await openStores();
          await s.events.append([
            ev('a', 'edit', 'memos/a.md', NOW - 500),
            rn('r', 'memos/a.md', 'memos/b.md', NOW - 400),
            ev('n', 'edit', 'memos/a.md', NOW - 100), // a new note at the old path
            ev('d', 'mention', 'loose key', NOW - 90),
            rn('r2', 'loose key', 'memos/loose.md', NOW - 80),
            ev('d2', 'mention', 'loose key', NOW - 10), // the key dangles again later
          ]);
          await foldPending(s.events, s.scores);
          expect((await s.scores.getItem('memos/a.md'))?.day?.edit).toBe(
            eventScore(1, NOW - 100, day),
          );
          expect((await s.scores.getItem('memos/b.md'))?.day?.edit).toBe(
            eventScore(1, NOW - 500, day),
          );
          expect((await s.scores.getItem('memos/loose.md'))?.day?.mention).toBe(
            eventScore(1, NOW - 90, day),
          );
          expect((await s.scores.getItem('loose key'))?.day?.mention).toBe(
            eventScore(1, NOW - 10, day),
          );
        },
      );

      it('handles a rename and its reversal', { timeout }, async () => {
        const s = await openStores();
        await s.events.append([
          ev('a', 'read', 'memos/a.md', NOW - 500),
          rn('r1', 'memos/a.md', 'memos/b.md', NOW - 400),
          rn('r2', 'memos/b.md', 'memos/a.md', NOW - 300),
          ev('late', 'read', 'memos/a.md', NOW - 450),
        ]);
        await foldPending(s.events, s.scores);
        expect([...(await s.scores.getAll()).keys()]).toEqual(['memos/a.md']);
        expectScoresClose(await s.scores.getAll(), modelScores(await s.events.readAfter(0)));
      });
    });

    // -- Notes and links -----------------------------------------------------

    describe('notes and links', () => {
      it('upserts, reads, lists and removes notes', { timeout }, async () => {
        const s = await openStores();
        await s.notes.upsertNote(note('memos/b.md'));
        await s.notes.upsertNote(note('memos/a.md', { title: 'First' }));
        await s.notes.upsertNote(
          note('diary/2026/01/2026-01-02.md', { role: 'dated', date: '2026-01-02' }),
        );
        await s.notes.upsertNote(note('memos/a.md', { title: 'Renamed title', contentHash: 'h2' }));
        expect(await s.notes.getNote('memos/a.md')).toEqual(
          note('memos/a.md', { title: 'Renamed title', contentHash: 'h2' }),
        );
        expect(await s.notes.getNote('memos/none.md')).toBeUndefined();
        expect((await s.notes.listNotes()).map((n) => n.path)).toEqual([
          'diary/2026/01/2026-01-02.md',
          'memos/a.md',
          'memos/b.md',
        ]);
        expect((await s.notes.listNotes({ role: 'dated' }))[0]?.date).toBe('2026-01-02');
        expect(await s.notes.removeNote('memos/b.md')).toBe(true);
        expect(await s.notes.removeNote('memos/b.md')).toBe(false);
        expect((await s.notes.listNotes()).length).toBe(2);
        for (const bad of [
          note(''),
          note('memos/x.md', { mtime: 1.5 }),
          note('memos/x.md', { role: 'excluded' as never }),
          note('memos/x.md', { date: 'yesterday' }),
          note('memos/x.md', { contentHash: '' }),
        ]) {
          await expect(
            Promise.resolve().then(() => s.notes.upsertNote(bad)),
          ).rejects.toBeInstanceOf(RangeError);
        }
      });

      it('replaces links and answers backlinks and dangling counts', { timeout }, async () => {
        const s = await openStores();
        await s.notes.replaceLinks('memos/a.md', [
          { target: 'memos/b.md', dangling: false },
          { target: 'cobalt idea', dangling: true },
          { target: 'memos/b.md', dangling: false },
        ]);
        await s.notes.replaceLinks('memos/b.md', [
          { target: 'cobalt idea', dangling: true },
          { target: 'ember plan', dangling: true },
        ]);
        await s.notes.replaceLinks('memos/c.md', [{ target: 'ember plan', dangling: true }]);
        await s.notes.replaceLinks('memos/d.md', [{ target: 'cobalt idea', dangling: true }]);
        expect(await s.notes.linksFrom('memos/a.md')).toEqual([
          { target: 'cobalt idea', dangling: true },
          { target: 'memos/b.md', dangling: false },
        ]);
        expect(await s.notes.backlinks('cobalt idea')).toEqual([
          'memos/a.md',
          'memos/b.md',
          'memos/d.md',
        ]);
        expect(await s.notes.backlinks('memos/b.md')).toEqual(['memos/a.md']);
        expect(await s.notes.danglingTargets()).toEqual([
          { key: 'cobalt idea', display: 'cobalt idea', count: 3 },
          { key: 'ember plan', display: 'ember plan', count: 2 },
        ]);
        await s.notes.replaceLinks('memos/a.md', [{ target: 'memos/c.md', dangling: false }]);
        expect(await s.notes.backlinks('memos/b.md')).toEqual([]);
        await s.notes.upsertNote(note('memos/d.md'));
        await s.notes.removeNote('memos/d.md');
        expect(await s.notes.linksFrom('memos/d.md')).toEqual([]);
        expect(await s.notes.danglingTargets()).toEqual([
          { key: 'ember plan', display: 'ember plan', count: 2 },
          { key: 'cobalt idea', display: 'cobalt idea', count: 1 },
        ]);
        await s.notes.replaceLinks('memos/b.md', []);
        await s.notes.replaceLinks('memos/c.md', []);
        expect(await s.notes.danglingTargets()).toEqual([]);
      });

      it(
        'keeps the display form of dangling links and picks one per key',
        { timeout },
        async () => {
          const s = await openStores();
          await s.notes.replaceLinks('memos/a.md', [
            { target: 'cobalt idea', dangling: true, display: 'Cobalt Idea' },
            { target: 'memos/b.md', dangling: false, display: 'ignored for resolved links' },
          ]);
          await s.notes.replaceLinks('memos/b.md', [
            { target: 'cobalt idea', dangling: true, display: 'cobalt idea' },
            { target: 'ember plan', dangling: true, display: '' },
          ]);
          await s.notes.replaceLinks('memos/c.md', [
            { target: 'cobalt idea', dangling: true, display: 'COBALT idea' },
          ]);
          expect(await s.notes.linksFrom('memos/a.md')).toEqual([
            { target: 'cobalt idea', dangling: true, display: 'Cobalt Idea' },
            { target: 'memos/b.md', dangling: false },
          ]);
          expect(await s.notes.linksFrom('memos/b.md')).toEqual([
            { target: 'cobalt idea', dangling: true, display: 'cobalt idea' },
            { target: 'ember plan', dangling: true },
          ]);
          // One note each: the tie goes to the form that sorts first (compareStrings).
          expect(await s.notes.danglingTargets()).toEqual([
            { key: 'cobalt idea', display: 'COBALT idea', count: 3 },
            { key: 'ember plan', display: 'ember plan', count: 1 },
          ]);
          await s.notes.replaceLinks('memos/d.md', [
            { target: 'cobalt idea', dangling: true, display: 'cobalt idea' },
          ]);
          expect((await s.notes.danglingTargets())[0]).toEqual({
            key: 'cobalt idea',
            display: 'cobalt idea',
            count: 4,
          });
          const again = await reopen(s);
          expect((await again.notes.danglingTargets())[0]?.display).toBe('cobalt idea');
        },
      );
    });

    // -- Term index ------------------------------------------------------------

    describe('term index', () => {
      it('stores sections with stable ids', { timeout }, async () => {
        const s = await openStores();
        await s.terms.replaceSections('memos/garden.md', 'Garden plans', [
          { heading: null, body: 'Tomatoes need sun.', startLine: 1, endLine: 2 },
          { heading: 'Planting', body: 'Planted tomatoes by the river.', startLine: 3, endLine: 6 },
        ]);
        const id = sectionId('memos/garden.md', 1);
        expect(id).toBe('memos/garden.md#1');
        expect(await s.terms.getSection(id)).toEqual({
          id,
          path: 'memos/garden.md',
          index: 1,
          title: 'Garden plans',
          heading: 'Planting',
          body: 'Planted tomatoes by the river.',
          startLine: 3,
          endLine: 6,
          lengths: { title: 2, heading: 1, body: 5 },
        });
        expect((await s.terms.sectionsOf('memos/garden.md')).map((x) => x.heading)).toEqual([
          null,
          'Planting',
        ]);
        expect(await s.terms.getSection('memos/garden.md#7')).toBeUndefined();
        expect(await s.terms.getSection('nonsense')).toBeUndefined();
        expect(await s.terms.removeSections('memos/garden.md')).toBe(true);
        expect(await s.terms.removeSections('memos/garden.md')).toBe(false);
        expect(await s.terms.sectionsOf('memos/garden.md')).toEqual([]);
      });

      it('does not index or search for an over-long word', { timeout }, async () => {
        const s = await openStores();
        // One 600 KB word: far more than a Postgres index row can hold.
        const huge = 'w'.repeat(600_000);
        const long = `${'v'.repeat(MAX_TERM_LENGTH)}x`;
        await s.terms.replaceSections('memos/blob.md', `Lichen ${long}`, [
          { heading: null, body: `granite ${huge} lichen moss` },
        ]);
        expect(await s.terms.documentFrequency('granit')).toBe(1);
        expect(await s.terms.documentFrequency(huge)).toBe(0);
        expect(await s.terms.documentFrequency(long)).toBe(0);
        const fresh = new MemoryKeywordIndex();
        for (const sec of await s.terms.sectionsOf('memos/blob.md')) {
          fresh.add(sec.id, { title: sec.title, heading: sec.heading ?? '', body: sec.body });
        }
        for (const q of ['lichen', '"granite lichen"', '"lichen moss"', long, `granite ${huge}`]) {
          expect(await searchSource(s.terms, q), q.slice(0, 40)).toEqual(fresh.search(q));
        }
        // The word is skipped, not removed: a phrase does not match across it.
        expect(await searchSource(s.terms, '"granite lichen"')).toEqual([]);
        expect((await searchSource(s.terms, long)).length).toBe(0);
        expect((await searchSource(s.terms, `granite ${huge}`)).map((h) => h.id)).toEqual([
          'memos/blob.md#0',
        ]);
      });

      it(
        'matches a fresh MemoryKeywordIndex after any replaces and removes (property)',
        { timeout },
        async () => {
          await fc.assert(
            fc.asyncProperty(fc.array(termOpArb, { maxLength: 12 }), async (ops) => {
              const s = await openStores();
              const final = new Map<string, { title: string; sections: SectionInput[] }>();
              for (const op of ops) {
                if (op.op === 'replace') {
                  await s.terms.replaceSections(op.path, op.title, op.sections);
                  final.set(op.path, { title: op.title, sections: op.sections });
                } else {
                  await s.terms.removeSections(op.path);
                  final.delete(op.path);
                }
              }
              const fresh = new MemoryKeywordIndex();
              for (const [path, { title, sections }] of [...final].sort(([a], [b]) =>
                a < b ? -1 : 1,
              )) {
                sections.forEach((sec, i) =>
                  fresh.add(sectionId(path, i), {
                    title,
                    heading: sec.heading ?? '',
                    body: sec.body,
                  }),
                );
              }
              expect(await s.terms.statistics()).toEqual(fresh.statistics());
              expect(await s.terms.corpusStats()).toEqual(fresh.corpusStats());
              for (const q of QUERIES) {
                expect(await searchSource(s.terms, q), q).toEqual(fresh.search(q));
                expect(await searchSource(s.terms, q, { mode: 'all' }), q).toEqual(
                  fresh.search(q, { mode: 'all' }),
                );
              }
              await s.close();
            }),
            { numRuns },
          );
        },
      );

      it(
        'answers postings with positions, and a phrase query matches the reference',
        { timeout },
        async () => {
          const s = await openStores();
          await s.terms.replaceSections('memos/one.md', 'Maple compost', [
            { heading: 'Tomatoes planted', body: 'tomatoes planted near the maple compost pile' },
            { heading: null, body: 'compost then maple, never maple compost together' },
          ]);
          await s.terms.replaceSections('memos/two.md', 'Harbor', [
            { heading: 'Lantern', body: 'maple and compost separately' },
          ]);
          const postings = [...(await s.terms.postings('mapl', { withPositions: true }))].sort(
            (a, b) => (a.id < b.id ? -1 : 1),
          );
          expect(postings.map((p) => [p.id, p.tf, p.positions])).toEqual([
            [
              'memos/one.md#0',
              { title: 1, heading: 0, body: 1 },
              { title: [0], heading: [], body: [4] },
            ],
            [
              'memos/one.md#1',
              { title: 1, heading: 0, body: 2 },
              { title: [0], heading: [], body: [2, 4] },
            ],
            [
              'memos/two.md#0',
              { title: 0, heading: 0, body: 1 },
              { title: [], heading: [], body: [0] },
            ],
          ]);
          expect(await s.terms.documentFrequency('mapl')).toBe(3);
          expect(await s.terms.documentFrequency('absent')).toBe(0);
          const fresh = new MemoryKeywordIndex();
          for (const sec of await s.terms.sectionsOf('memos/one.md')) {
            fresh.add(sec.id, { title: sec.title, heading: sec.heading ?? '', body: sec.body });
          }
          for (const sec of await s.terms.sectionsOf('memos/two.md')) {
            fresh.add(sec.id, { title: sec.title, heading: sec.heading ?? '', body: sec.body });
          }
          const hits = await searchSource(s.terms, '"maple compost"');
          expect(hits).toEqual(fresh.search('"maple compost"'));
          expect(hits.map((h) => h.id)).toEqual(['memos/one.md#1', 'memos/one.md#0']);
        },
      );

      it('records its analyzer and reports a mismatch until reset', { timeout }, async () => {
        let s = await openStores({ analyzer: { stem: true } });
        expect(s.terms.analyzer).toMatchObject({ stem: true });
        expect(s.terms.analyzerMismatch({ stem: true })).toBeNull();
        expect(s.terms.analyzerMismatch()).toBeNull();
        await s.terms.replaceSections('memos/one.md', 'Tomatoes', [
          { heading: null, body: 'planting' },
        ]);
        s = await reopen(s, { analyzer: { stem: false } });
        expect(s.terms.analyzer).toMatchObject({ stem: true });
        expect(s.terms.analyzerMismatch({ stem: false })).toMatchObject({
          stored: { stem: true },
          requested: { stem: false },
        });
        // Writes keep using the stored analyzer, so the index stays consistent.
        await s.terms.replaceSections('memos/two.md', 'Tomatoes', [
          { heading: null, body: 'planting' },
        ]);
        expect(await s.terms.documentFrequency('plant')).toBe(2);
        await s.resetIndex({ analyzer: { stem: false } });
        expect(s.terms.analyzer).toMatchObject({ stem: false });
        expect(s.terms.analyzerMismatch({ stem: false })).toBeNull();
        await s.terms.replaceSections('memos/one.md', 'Tomatoes', [
          { heading: null, body: 'planting' },
        ]);
        expect(await s.terms.documentFrequency('planting')).toBe(1);
        s = await reopen(s, { analyzer: { stem: false } });
        expect(s.terms.analyzer).toMatchObject({ stem: false });
      });

      it('adopts the requested analyzer when the index is empty', { timeout }, async () => {
        let s = await openStores({ analyzer: { stem: true } });
        s = await reopen(s, { analyzer: { stem: false } });
        expect(s.terms.analyzer).toMatchObject({ stem: false });
        expect(s.terms.analyzerMismatch({ stem: false })).toBeNull();
      });
    });

    // -- The aggregate -------------------------------------------------------------

    describe('stores', () => {
      it('keeps meta and index meta apart', { timeout }, async () => {
        const s = await openStores();
        await s.meta.set('k', 'durable');
        await s.indexMeta.set('k', 'derived');
        expect(await s.meta.get('k')).toBe('durable');
        expect(await s.indexMeta.get('k')).toBe('derived');
        await s.meta.set('k', 'durable 2');
        expect(await s.meta.get('k')).toBe('durable 2');
        await s.indexMeta.delete('k');
        expect(await s.indexMeta.get('k')).toBeUndefined();
        expect(await s.meta.get('missing')).toBeUndefined();
      });

      it('commits an index transaction, or rolls all of it back', { timeout }, async () => {
        const s = await openStores();
        await s.events.append([ev('a', 'read', 'memos/x.md', NOW - 9)]);
        const result = await s.indexTransaction(async () => {
          await s.notes.upsertNote(note('memos/x.md'));
          await s.notes.replaceLinks('memos/x.md', [{ target: 'ember plan', dangling: true }]);
          await s.indexTransaction(() =>
            s.terms.replaceSections('memos/x.md', 'X', [{ heading: null, body: 'harbor lantern' }]),
          );
          await foldPending(s.events, s.scores);
          return 'done';
        });
        expect(result).toBe('done');
        const committed = await snapshotAll(s);
        expect(committed.notes.length).toBe(1);
        expect(committed.state.cursor).toBe(1);

        await s.events.append([ev('b', 'read', 'memos/x.md', NOW - 8)]);
        await expect(
          s.indexTransaction(async () => {
            await s.notes.upsertNote(note('memos/y.md'));
            await s.notes.removeNote('memos/x.md');
            await s.notes.replaceLinks('memos/y.md', [{ target: 'cobalt idea', dangling: true }]);
            await s.terms.replaceSections('memos/x.md', 'X', [{ heading: null, body: 'glacier' }]);
            await s.terms.replaceSections('memos/y.md', 'Y', [
              { heading: 'Meadow', body: 'violin' },
            ]);
            await s.indexMeta.set('scan', 'partial');
            await foldPending(s.events, s.scores);
            throw new Error('index pass failed');
          }),
        ).rejects.toThrow('index pass failed');
        expect(await snapshotAll(s)).toEqual(committed);
        expect(await s.indexMeta.get('scan')).toBeUndefined();
        expect(await s.notes.linksFrom('memos/x.md')).toEqual([
          { target: 'ember plan', dangling: true },
        ]);
        expect(await searchSource(s.terms, 'harbor')).toHaveLength(1);
        expect(await searchSource(s.terms, 'glacier')).toHaveLength(0);
        // Events are not covered by the index transaction.
        expect(await s.events.lastSeq()).toBe(2);
        // And the stores still work afterwards.
        await foldPending(s.events, s.scores);
        expect((await s.scores.foldState()).cursor).toBe(2);
      });

      it(
        'resets derived data, keeps original data, and rebuilds the same scores',
        { timeout },
        async () => {
          let s = await openStores();
          await s.events.append([
            ev('a', 'read', 'memos/x.md', NOW - 900),
            ev('b', 'mention', 'tundra', NOW - 800),
            rn('c', 'tundra', 'memos/tundra.md', NOW - 700),
            ev('d', 'edit', 'memos/tundra.md', NOW - 600),
          ]);
          await s.events.appendChanges([
            { id: 'c1', time: NOW, client: CLIENT, message: null, op: null, paths: ['memos/x.md'] },
          ]);
          await s.meta.set('client', CLIENT);
          await s.indexMeta.set('scan', 'done');
          await s.notes.upsertNote(note('memos/x.md'));
          await s.notes.replaceLinks('memos/x.md', [
            { target: 'memos/tundra.md', dangling: false },
          ]);
          await s.terms.replaceSections('memos/x.md', 'X', [{ heading: null, body: 'tundra' }]);
          await foldPending(s.events, s.scores, { batchSize: 1 });
          const scores = await s.scores.getAll();

          await s.resetIndex();
          expect(await s.notes.listNotes()).toEqual([]);
          expect(await s.notes.linksFrom('memos/x.md')).toEqual([]);
          expect((await s.terms.statistics()).sectionCount).toBe(0);
          expect(await s.scores.foldState()).toEqual({ cursor: 0, halfLives: null });
          expect((await s.scores.getAll()).size).toBe(0);
          expect(await s.indexMeta.get('scan')).toBeUndefined();
          expect(await s.events.lastSeq()).toBe(4);
          expect((await s.events.changes()).length).toBe(1);
          expect(await s.meta.get('client')).toBe(CLIENT);

          s = await reopen(s);
          await foldPending(s.events, s.scores);
          expectScoresClose(await s.scores.getAll(), scores);
        },
      );

      it('keeps derived data across a reopen', { timeout }, async () => {
        let s = await openStores();
        await s.events.append([ev('a', 'read', 'memos/x.md', NOW - 9)]);
        await s.notes.upsertNote(note('memos/x.md'));
        await s.notes.replaceLinks('memos/x.md', [{ target: 'saffron', dangling: true }]);
        await s.terms.replaceSections('memos/x.md', 'X', [
          { heading: 'Falcon', body: 'quartz pebble' },
        ]);
        await s.indexMeta.set('scan', 'done');
        await foldPending(s.events, s.scores);
        const before = await snapshotAll(s);
        s = await reopen(s);
        expect(await snapshotAll(s)).toEqual(before);
        expect(await s.indexMeta.get('scan')).toBe('done');
        expect(await searchSource(s.terms, 'quartz')).toHaveLength(1);
      });
    });
  });
}
