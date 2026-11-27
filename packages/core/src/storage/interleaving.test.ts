// Several folders and appenders over one brain, interleaved by a seeded
// scheduler: every store call yields, and the scheduler picks which pending
// call runs next. This drives, deterministically, the interleavings that
// real processes hit only now and then (a batch computed from a cursor that
// another folder has since moved, a refold racing an incremental batch), so
// fast-check can shrink a failing schedule. The invariant: once every
// folder has folded to the end of the log, the stored scores equal a
// rebuild. All data here is invented.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, type EventKind } from '../timescore/kinds.js';
import { expectScoresClose } from './conformance.testing.js';
import { foldPending, rebuildScores } from './fold.js';
import { createMemoryStores } from './memory.js';
import type { EventLog, LogInput, ScoreStore } from './types.js';

const NOW = 1_800_000_000;
const ITEMS = ['memos/a.md', 'memos/b.md', 'memos/c.md', 'some key', 'memos/k.md'];

/** Releases one waiting store call at a time, chosen by a seeded generator. */
class Scheduler {
  private waiting: (() => void)[] = [];
  private x: number;
  constructor(seed: number) {
    this.x = seed >>> 0 || 1;
  }
  yield(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }
  private next(n: number): number {
    this.x = (Math.imul(this.x, 1103515245) + 12345) >>> 0;
    return (this.x >>> 8) % n;
  }
  /** Runs until `done` settles, releasing one call per step. */
  async run(done: Promise<unknown>): Promise<void> {
    let finished = false;
    void done.then(
      () => (finished = true),
      () => (finished = true),
    );
    for (;;) {
      // Let every runnable task reach its next yield.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      if (finished && this.waiting.length === 0) return;
      if (this.waiting.length === 0) {
        await new Promise((r) => setTimeout(r, 0));
        if (finished && this.waiting.length === 0) return;
        continue;
      }
      const [release] = this.waiting.splice(this.next(this.waiting.length), 1);
      (release as () => void)();
    }
  }
}

function yielding<T extends object>(inner: T, s: Scheduler): T {
  return new Proxy(inner, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await s.yield();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

type Draft =
  | { kind: EventKind; item: string; time: number }
  | { kind: 'rename'; item: string; to: string; time: number };

// Few seconds, so renames of one item in one second, chains and cycles are common.
const timeArb = fc.constantFrom(NOW - 7200, NOW - 3, NOW - 1, NOW);
const draftArb: fc.Arbitrary<Draft> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constantFrom(...EVENT_KINDS),
      item: fc.constantFrom(...ITEMS),
      time: timeArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({
        kind: fc.constant('rename' as const),
        item: fc.constantFrom(...ITEMS),
        to: fc.constantFrom(...ITEMS),
        time: timeArb,
      })
      .filter((r) => r.item !== r.to),
  },
);

const toInput = (d: Draft, id: string): LogInput =>
  d.kind === 'rename'
    ? { id, kind: 'rename', item: d.item, to: d.to, time: d.time, client: 'c' }
    : { id, kind: d.kind, item: d.item, time: d.time, client: 'c' };

async function interleave(
  drafts: readonly Draft[],
  seed: number,
  window: number,
  folders: number,
  batchSize: number,
): Promise<void> {
  const brain = createMemoryStores({ now: () => NOW });
  const s = new Scheduler(seed);
  // Ids unrelated to the order the entries are appended in.
  const inputs = drafts.map((d, i) => toInput(d, `id-${(i * 7919 + seed) % 100_003}`));
  const options = { burstWindow: window, batchSize };
  const tasks: Promise<unknown>[] = [];
  // Appender-folders: each appends its share in small chunks, folding after each.
  for (let f = 0; f < folders; f++) {
    const log = yielding<EventLog>(brain.events, s);
    const scores = yielding<ScoreStore>(brain.scores, s);
    const mine = inputs.filter((_, i) => i % folders === f);
    tasks.push(
      (async () => {
        for (let i = 0; i < mine.length; i += 2) {
          await log.append(mine.slice(i, i + 2));
          await foldPending(log, scores, options);
        }
        await foldPending(log, scores, options);
      })(),
    );
  }
  // A folder that only folds, to race the others.
  tasks.push(
    (async () => {
      const log = yielding<EventLog>(brain.events, s);
      const scores = yielding<ScoreStore>(brain.scores, s);
      for (let i = 0; i < 4; i++) await foldPending(log, scores, options);
    })(),
  );
  const all = Promise.all(tasks);
  await s.run(all);
  await all;
  // Everything appended; one last fold by anyone reaches the end.
  await foldPending(brain.events, brain.scores, options);
  expect((await brain.scores.foldState()).cursor).toBe(inputs.length);
  const folded = await brain.scores.getAll();
  const fresh = createMemoryStores({ now: () => NOW });
  await fresh.events.append(await brain.events.readAfter(0));
  await rebuildScores(fresh.events, fresh.scores, { burstWindow: window });
  expectScoresClose(folded, await fresh.scores.getAll());
  const items = [...folded.keys()];
  expect(await brain.scores.burstState(items)).toEqual(await fresh.scores.burstState(items));
}

describe('folding under interleaved folders', () => {
  it('ends equal to a rebuild after any schedule (property)', { timeout: 300_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(draftArb, { minLength: 1, maxLength: 24 }),
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.constantFrom(0, 3, 3600),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 4 }),
        async (drafts, seed, window, folders, batchSize) => {
          await interleave(drafts, seed, window, folders, batchSize);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('renames of one item in one second, appended while others fold (regression)', async () => {
    // The shape a multi-process test hit: one item renamed four times in one
    // second, ids in another order than arrival, small batches, racing folders.
    const drafts: Draft[] = [];
    for (let r = 0; r < 20; r++) {
      drafts.push({ kind: 'read', item: 'some key', time: NOW - r });
      drafts.push({ kind: 'edit', item: ITEMS[r % 3] as string, time: NOW - 10 * r });
      if (r % 5 === 4) {
        drafts.push({ kind: 'rename', item: 'some key', to: `memos/key-${r}.md`, time: NOW });
      }
    }
    for (let seed = 1; seed <= 60; seed++) {
      await interleave(drafts, seed, 0, 3, 7);
      await interleave(drafts, seed, 3600, 3, 2);
    }
  });
});
