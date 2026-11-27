import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  EVENT_KINDS,
  FutureEventError,
  HALF_LIFE_NAMES,
  HALF_LIVES,
  InvalidEventError,
  addEvent,
  assertValidEvent,
  combineAll,
  eventScore,
  foldEvents,
  type ScoreEvent,
} from './index.js';
import { T0, arbEvent, arbTime, logTol } from './testing.test.js';

describe('assertValidEvent', () => {
  it('accepts an event at or before now', () => {
    expect(() => assertValidEvent({ kind: 'read', time: T0 }, T0)).not.toThrow();
    expect(() => assertValidEvent({ kind: 'edit', time: T0 - 1, value: 2 }, T0)).not.toThrow();
  });

  it('rejects a future-dated event with a FutureEventError', () => {
    fc.assert(
      fc.property(arbTime, fc.integer({ min: 1, max: 1e8 }), (now, ahead) => {
        let error: unknown;
        try {
          assertValidEvent({ kind: 'read', time: now + ahead }, now);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(FutureEventError);
        expect(error).toBeInstanceOf(RangeError);
        expect((error as FutureEventError).time).toBe(now + ahead);
        expect((error as FutureEventError).now).toBe(now);
      }),
    );
    // Even a fraction of a second.
    expect(() => assertValidEvent({ kind: 'read', time: T0 + 0.001 }, T0)).toThrow(
      FutureEventError,
    );
  });

  it('rejects non-finite times, bad values and unknown kinds', () => {
    for (const time of [NaN, Infinity, -Infinity]) {
      expect(() => assertValidEvent({ kind: 'read', time }, T0)).toThrow(InvalidEventError);
    }
    for (const value of [0, -1, NaN, Infinity, -Infinity]) {
      expect(() => assertValidEvent({ kind: 'read', time: T0, value }, T0)).toThrow(
        InvalidEventError,
      );
    }
    const bogus = { kind: 'search', time: T0 } as unknown as ScoreEvent;
    expect(() => assertValidEvent(bogus, T0)).toThrow(InvalidEventError);
    expect(() => assertValidEvent({ kind: 'read', time: T0 }, NaN)).toThrow(InvalidEventError);
  });
});

describe('foldEvents', () => {
  it('folds events into per-(item, kind, half-life) scores', () => {
    const events: ScoreEvent[] = [
      { item: 'b', kind: 'read', time: T0 },
      { item: 'a', kind: 'edit', time: T0 - 100, value: 2 },
      { item: 'a', kind: 'read', time: T0 - 50 },
      { item: 'a', kind: 'read', time: T0 - 50 },
    ];
    const scores = foldEvents(events, { now: T0 });
    expect([...scores.keys()]).toEqual(['a', 'b']);
    const a = scores.get('a');
    expect(Object.keys(a ?? {})).toEqual(HALF_LIFE_NAMES);
    for (const name of HALF_LIFE_NAMES) {
      const h = HALF_LIVES[name];
      expect(a?.[name]).toEqual({
        read: eventScore(1, T0 - 50, h) + Math.LN2,
        edit: eventScore(2, T0 - 100, h),
      });
      expect(scores.get('b')?.[name]).toEqual({ read: eventScore(1, T0, h) });
    }
  });

  it('gives an empty map for no events', () => {
    expect(foldEvents([]).size).toBe(0);
  });

  it('accepts custom half-lives, for experiments', () => {
    const scores = foldEvents([{ item: 'x', kind: 'mention', time: T0 }], {
      halfLives: { hour: 3600 },
    });
    expect(scores.get('x')).toEqual({ hour: { mention: eventScore(1, T0, 3600) } });
    expect(() => foldEvents([], { halfLives: { bad: 0 } })).toThrow(RangeError);
  });

  it('rejects future-dated events when given now, and invalid events always', () => {
    const future = [{ item: 'x', kind: 'read' as const, time: T0 + 1 }];
    expect(() => foldEvents(future, { now: T0 })).toThrow(FutureEventError);
    expect(() => foldEvents(future)).not.toThrow();
    expect(() => foldEvents([{ item: 'x', kind: 'read', time: NaN }])).toThrow(InvalidEventError);
    expect(() => foldEvents([{ item: 'x', kind: 'read', time: T0, value: 0 }])).toThrow(
      InvalidEventError,
    );
  });

  it('gives the same result, bit for bit, for any permutation of the events', () => {
    fc.assert(
      fc.property(
        fc
          .array(arbEvent, { maxLength: 40 })
          .chain((events) =>
            fc.tuple(
              fc.constant(events),
              fc.shuffledSubarray(events, { minLength: events.length }),
            ),
          ),
        ([events, shuffled]) => {
          const a = foldEvents(events, { now: T0 });
          const b = foldEvents(shuffled, { now: T0 });
          expect([...b.entries()]).toEqual([...a.entries()]);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('agrees with adding the events one at a time within 8 ulps', () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { minLength: 1, maxLength: 40 }), (events) => {
        const folded = foldEvents(events);
        for (const [item, byHalfLife] of folded) {
          for (const name of HALF_LIFE_NAMES) {
            for (const kind of EVENT_KINDS) {
              const mine = events.filter((e) => e.item === item && e.kind === kind);
              const expected = mine.reduce(
                (L, e) => addEvent(L, e.value ?? 1, e.time, HALF_LIVES[name]),
                EMPTY,
              );
              const got = byHalfLife[name][kind];
              if (mine.length === 0) expect(got).toBeUndefined();
              else
                expect(Math.abs((got as number) - expected)).toBeLessThanOrEqual(
                  logTol(expected, 8),
                );
            }
          }
        }
      }),
    );
  });

  it('each score is combineAll of its events', () => {
    const times = [T0 - 3, T0 - 2, T0 - 1];
    const h = HALF_LIVES.month;
    const scores = foldEvents(times.map((time) => ({ item: 'x', kind: 'edit' as const, time })));
    expect(scores.get('x')?.month.edit).toBe(combineAll(times.map((t) => eventScore(1, t, h))));
  });
});
