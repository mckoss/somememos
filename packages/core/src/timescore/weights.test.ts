import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  HALF_LIFE_NAMES,
  HALF_LIVES,
  UNIT_WEIGHTS,
  combineAll,
  eventScore,
  foldEvents,
  weightedTotal,
  type Weights,
} from './index.js';
import { T0, arbEvent, logTol } from './testing.test.js';

const arbWeight = fc.double({ min: 1e-3, max: 1e3, noNaN: true, noDefaultInfinity: true });
const arbWeights = fc.record({ read: arbWeight, edit: arbWeight, mention: arbWeight });

describe('weightedTotal', () => {
  it('is ln Σ w_k e^(L_k)', () => {
    expect(weightedTotal({ read: 0, edit: 0 }, { read: 1, edit: 3, mention: 1 })).toBeCloseTo(
      Math.log(4),
      14,
    );
    expect(weightedTotal({ read: 5 }, UNIT_WEIGHTS)).toBe(5);
  });

  it('treats a missing kind or EMPTY as no contribution', () => {
    expect(weightedTotal({}, UNIT_WEIGHTS)).toBe(EMPTY);
    expect(weightedTotal({ read: EMPTY, edit: EMPTY }, UNIT_WEIGHTS)).toBe(EMPTY);
    expect(weightedTotal({ read: 7, edit: EMPTY }, UNIT_WEIGHTS)).toBe(7);
  });

  it('excludes a kind whose weight is 0', () => {
    const scores = { read: 10, edit: 20, mention: 30 };
    expect(weightedTotal(scores, { read: 1, edit: 0, mention: 0 })).toBe(10);
    expect(weightedTotal(scores, { read: 0, edit: 0, mention: 0 })).toBe(EMPTY);
  });

  it('rejects negative, non-finite or missing weights', () => {
    for (const w of [-1, NaN, Infinity]) {
      expect(() => weightedTotal({}, { read: 1, edit: w, mention: 1 })).toThrow(RangeError);
    }
    expect(() => weightedTotal({}, { read: 1, edit: 1 } as unknown as Weights)).toThrow(RangeError);
  });

  it('weighting at read time equals folding the events with the weights as values', () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { minLength: 1, maxLength: 40 }), arbWeights, (events, w) => {
        // Stored: unweighted value-1 events per kind. Read: weighted.
        const unit = events.map(({ item, kind, time }) => ({ item, kind, time }));
        const folded = foldEvents(unit, { now: T0 });
        for (const [item, byHalfLife] of folded) {
          for (const name of HALF_LIFE_NAMES) {
            const h = HALF_LIVES[name];
            const readTime = weightedTotal(byHalfLife[name], w);
            const recordTime = combineAll(
              unit.filter((e) => e.item === item).map((e) => eventScore(w[e.kind], e.time, h)),
            );
            expect(Math.abs(readTime - recordTime)).toBeLessThanOrEqual(logTol(recordTime, 8));
          }
        }
      }),
    );
  });

  it('a weight of 0 equals leaving that kind out of the log', () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { minLength: 1, maxLength: 40 }), (events) => {
        const w = { read: 1, edit: 0, mention: 1 };
        const all = foldEvents(events);
        const withoutEdits = foldEvents(events.filter((e) => e.kind !== 'edit'));
        for (const [item, byHalfLife] of all) {
          for (const name of HALF_LIFE_NAMES) {
            const expected = withoutEdits.get(item)?.[name] ?? {};
            expect(weightedTotal(byHalfLife[name], w)).toBe(weightedTotal(expected, UNIT_WEIGHTS));
          }
        }
      }),
    );
  });
});
