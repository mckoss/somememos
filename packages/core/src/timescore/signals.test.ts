import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  HALF_LIVES,
  STEADY_TRENDING_RATIO,
  addEvent,
  neglected,
  ratioAt,
  scoreAt,
  steadyRatio,
  trending,
} from './index.js';
import { T0, arbTime, arbValue } from './testing.test.js';

const DAY = HALF_LIVES.day;
const { week: W, month: M, year: Y } = HALF_LIVES;

describe('trending and neglected', () => {
  it('are differences of stored log scores', () => {
    expect(trending(10, 4)).toBe(6);
    expect(neglected(3, 5)).toBe(-2);
  });

  it('are EMPTY when either score is EMPTY', () => {
    expect(trending(EMPTY, EMPTY)).toBe(EMPTY);
    expect(trending(EMPTY, 3)).toBe(EMPTY);
    expect(trending(3, EMPTY)).toBe(EMPTY);
    expect(neglected(EMPTY, EMPTY)).toBe(EMPTY);
    expect(ratioAt(EMPTY, T0, W, M)).toBe(0);
  });

  it('ratioAt gives the ratio of the current scores', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbValue, arbTime), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 30 * DAY }),
        (events, later) => {
          let week = EMPTY;
          let month = EMPTY;
          for (const [v, t] of events) {
            week = addEvent(week, v, t, W);
            month = addEvent(month, v, t, M);
          }
          const now = Math.max(...events.map(([, t]) => t)) + later;
          const direct = scoreAt(week, now, W) / scoreAt(month, now, M);
          expect(ratioAt(trending(week, month), now, W, M) / direct).toBeCloseTo(1, 9);
        },
      ),
    );
  });

  it('ranks a surge above steady activity', () => {
    // Invented items: steady gets 10 a day; surge gets 2 a day,
    // then 20 a day for the last week. 600 days, so
    // the month score has settled (2^-20).
    const items = { steady: { week: EMPTY, month: EMPTY }, surge: { week: EMPTY, month: EMPTY } };
    for (let n = 0; n < 600; n++) {
      const t = T0 - (599 - n) * DAY;
      const values = { steady: 10, surge: n >= 593 ? 20 : 2 };
      for (const key of ['steady', 'surge'] as const) {
        items[key].week = addEvent(items[key].week, values[key], t, W);
        items[key].month = addEvent(items[key].month, values[key], t, M);
      }
    }
    const d = (key: 'steady' | 'surge') => trending(items[key].week, items[key].month);
    expect(d('surge')).toBeGreaterThan(d('steady'));
    // Steady activity, normalized by the steady ratio, is about 1.0.
    expect(ratioAt(d('steady'), T0, W, M) / STEADY_TRENDING_RATIO).toBeCloseTo(1, 2);
    expect(ratioAt(d('surge'), T0, W, M) / STEADY_TRENDING_RATIO).toBeGreaterThan(2);
  });

  it('neglected ranks an item busy long ago above one busy lately', () => {
    let oldYear = EMPTY;
    let oldMonth = EMPTY;
    let newYear = EMPTY;
    let newMonth = EMPTY;
    for (let n = 0; n < 30; n++) {
      const old = T0 - 200 * DAY + n * DAY;
      const recent = T0 - n * DAY;
      oldYear = addEvent(oldYear, 1, old, Y);
      oldMonth = addEvent(oldMonth, 1, old, M);
      newYear = addEvent(newYear, 1, recent, Y);
      newMonth = addEvent(newMonth, 1, recent, M);
    }
    expect(neglected(oldYear, oldMonth)).toBeGreaterThan(neglected(newYear, newMonth));
  });
});

describe('steadyRatio', () => {
  // The post: "With the same activity every day, the week score settles at
  // roughly 0.24 of the month score (close to h_w / h_m)."
  it('week over month with daily activity is about 0.24', () => {
    expect(STEADY_TRENDING_RATIO).toBeCloseTo(0.24, 2);
    expect(STEADY_TRENDING_RATIO).toBeCloseTo(W / M, 1);
    expect(steadyRatio(W, M, DAY)).toBe(STEADY_TRENDING_RATIO);
  });

  it('matches a long run of daily events', () => {
    let week = EMPTY;
    let month = EMPTY;
    for (let n = 0; n < 2000; n++) {
      week = addEvent(week, 1, T0 - n * DAY, W);
      month = addEvent(month, 1, T0 - n * DAY, M);
    }
    expect(ratioAt(trending(week, month), T0, W, M) / STEADY_TRENDING_RATIO).toBeCloseTo(1, 9);
  });
});
