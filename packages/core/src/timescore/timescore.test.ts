import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  HALF_LIFE_ENTRIES,
  HALF_LIFE_NAMES,
  HALF_LIVES,
  addEvent,
  combine,
  combineAll,
  eventScore,
  isEventKind,
  isHalfLifeName,
  scoreAt,
} from './index.js';
import { T0, arbHalfLife, arbTime, arbValue, logTol, ulp } from './testing.test.js';

const HOUR = 3600;

describe('half-lives and kinds', () => {
  it('has the four half-lives in seconds, shortest first', () => {
    expect(HALF_LIVES).toEqual({ day: 86400, week: 604800, month: 2592000, year: 31536000 });
    expect(HALF_LIFE_NAMES).toEqual(['day', 'week', 'month', 'year']);
    expect(HALF_LIFE_ENTRIES).toEqual([
      ['day', 86400],
      ['week', 604800],
      ['month', 2592000],
      ['year', 31536000],
    ]);
    expect(Object.isFrozen(HALF_LIVES)).toBe(true);
  });

  it('recognizes names', () => {
    expect(isHalfLifeName('week')).toBe(true);
    expect(isHalfLifeName('hour')).toBe(false);
    expect(isHalfLifeName('toString')).toBe(false);
    expect(isEventKind('mention')).toBe(true);
    expect(isEventKind('search')).toBe(false);
  });
});

describe('eventScore', () => {
  it('is ln(value) + time·ln2/halfLife', () => {
    expect(eventScore(1, 0, HOUR)).toBe(0);
    expect(eventScore(Math.E, 0, HOUR)).toBe(1);
    expect(eventScore(1, HOUR, HOUR)).toBe(Math.LN2);
  });

  it('rejects values that are not > 0', () => {
    for (const v of [0, -1, NaN, -Infinity]) {
      expect(() => eventScore(v, T0, HOUR)).toThrow(RangeError);
    }
    expect(() => eventScore(0, T0, HOUR)).toThrow('TimeScore values must be greater than 0, not 0');
  });
});

describe('worked values from the post', () => {
  // "With an eight-hour half-life it's about 43,000 today, and a double holds
  // that to within about 10^-11" (post dated 2026-11-03, times in ms).
  it('an 8-hour half-life in milliseconds gives a log score of about 43,000', () => {
    const halfLife = 8 * HOUR * 1000;
    const L = eventScore(1, Date.UTC(2026, 10, 3, 18), halfLife);
    expect(Math.round(L / 1000)).toBe(43);
    expect(ulp(L)).toBeLessThan(1e-11);
  });

  // "With an eight-hour half-life, it [Ŝ] passes the largest number a double
  // can hold (2^1024) in less than a year."
  it('Ŝ itself would overflow within a year at an 8-hour half-life', () => {
    const halfLife = 8 * HOUR;
    const t = 1024 * halfLife;
    expect(t / (24 * HOUR)).toBeLessThan(365);
    expect(2 ** (t / halfLife)).toBe(Infinity);
    expect(eventScore(1, t, halfLife)).toBeCloseTo(1024 * Math.LN2, 9);
  });

  // "...which only grows by ln 2 ≈ 0.69 per half-life."
  it('the log grows by ln 2 per half-life', () => {
    for (const [, h] of HALF_LIFE_ENTRIES) {
      const step = eventScore(1, T0 + h, h) - eventScore(1, T0, h);
      expect(Math.abs(step - Math.LN2)).toBeLessThanOrEqual(logTol(eventScore(1, T0, h)));
    }
  });

  // "An item's first event (ln Ŝ = −∞) simply sets ln Ŝ to ln ŝ_i."
  it("an item's first event sets its score to the event's score", () => {
    expect(addEvent(EMPTY, 3, T0, HALF_LIVES.week)).toBe(eventScore(3, T0, HALF_LIVES.week));
    expect(combine(EMPTY, EMPTY)).toBe(EMPTY);
  });

  // "A second like at the same moment as an item's only like doubles its
  // score, adding exactly ln 2."
  it('a second simultaneous like adds ln 2 and doubles the score', () => {
    const h = HALF_LIVES.day;
    const one = addEvent(EMPTY, 1, T0, h);
    const two = addEvent(one, 1, T0, h);
    expect(two).toBe(one + Math.LN2);
    expect(scoreAt(two, T0, h) / scoreAt(one, T0, h)).toBeCloseTo(2, 11);
  });

  // "The answer is the larger log plus a correction between 0 and ln 2."
  it('combine adds a correction between 0 and ln 2 to the larger score', () => {
    fc.assert(
      fc.property(arbValue, arbValue, arbTime, arbTime, arbHalfLife, (v1, v2, t1, t2, [, h]) => {
        const a = eventScore(v1, t1, h);
        const b = eventScore(v2, t2, h);
        const c = combine(a, b) - Math.max(a, b);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(Math.LN2 + logTol(a));
      }),
    );
  });

  // "A like is worth one point when it happens, half a point one half-life
  // later, a quarter after two half-lives."
  it('a value-1 event is worth 1, then 1/2, then 1/4', () => {
    for (const [, h] of HALF_LIFE_ENTRIES) {
      const L = eventScore(1, T0, h);
      expect(scoreAt(L, T0, h)).toBeCloseTo(1, 11);
      expect(scoreAt(L, T0 + h, h)).toBeCloseTo(0.5, 11);
      expect(scoreAt(L, T0 + 2 * h, h)).toBeCloseTo(0.25, 11);
    }
  });

  // Reddit's hot score: "A post needs ten times the votes to make up for
  // being 45,000 seconds (12.5 hours) older. That makes it a TimeScore with a
  // half-life of 12.5 × log10 2 ≈ 3.8 hours."
  it("Reddit's hot ranking is a TimeScore with a 3.8-hour half-life", () => {
    const h = 45_000 * Math.log10(2);
    expect(h / HOUR).toBeCloseTo(3.76, 2);
    const older = eventScore(10, T0, h);
    const newer = eventScore(1, T0 + 45_000, h);
    expect(Math.abs(older - newer)).toBeLessThanOrEqual(logTol(newer));
  });

  // The post's first demo: Red has the most likes, two days old; Blue got its
  // likes over the past half day; Green just got three in the last two hours.
  // Half-life eight hours. "At the start, Red has the most likes, and yet it
  // ranks last." (The like counts here are invented; the post gives none.)
  it('the demo: the most likes, two days old, ranks last', () => {
    const h = 8 * HOUR;
    const now = T0;
    const fold = (times: number[]) => times.reduce((L, t) => addEvent(L, 1, t, h), EMPTY);
    const red = fold(Array.from({ length: 12 }, (_, i) => now - 48 * HOUR - i * 60));
    const blue = fold([0, 3, 6, 9, 12].map((hours) => now - hours * HOUR));
    const green = fold([0.5, 1, 2].map((hours) => now - hours * HOUR));
    const ranked = Object.entries({ red, blue, green })
      .sort(([, a], [, b]) => b - a)
      .map(([name]) => name);
    expect(ranked.at(-1)).toBe('red');
    expect(scoreAt(red, now, h)).toBeCloseTo(12 / 64, 2);
  });

  // From the demo repository's tests (tests/test_build.py): a steady item with
  // value 10 every day for 60 days has week score Σ 10·0.5^((59−n)/7).
  it('the faded sum of a steady item', () => {
    const day = HALF_LIVES.day;
    const h = HALF_LIVES.week;
    let L = EMPTY;
    for (let n = 0; n < 60; n++) L = addEvent(L, 10, T0 + n * day, h);
    let expected = 0;
    for (let n = 0; n < 60; n++) expected += 10 * 0.5 ** ((59 - n) / 7);
    expect(scoreAt(L, T0 + 59 * day, h) / expected).toBeCloseTo(1, 11);
  });
});

describe('combine properties', () => {
  // A log score built from 1–5 realistic events, or EMPTY.
  const arbLogScore = (h: number) =>
    fc.oneof(
      { weight: 1, arbitrary: fc.constant(EMPTY) },
      {
        weight: 9,
        arbitrary: fc
          .array(fc.tuple(arbValue, arbTime), { minLength: 1, maxLength: 5 })
          .map((events) => events.reduce((L, [v, t]) => addEvent(L, v, t, h), EMPTY)),
      },
    );
  // Three log scores with the same half-life.
  const arbScores = arbHalfLife.chain(([, h]) =>
    fc.tuple(arbLogScore(h), arbLogScore(h), arbLogScore(h)),
  );

  it('is commutative, exactly', () => {
    fc.assert(
      fc.property(arbScores, ([a, b]) => {
        expect(combine(a, b)).toBe(combine(b, a));
      }),
    );
  });

  it('is associative within 4 ulps of the result', () => {
    fc.assert(
      fc.property(arbScores, ([a, b, c]) => {
        const left = combine(combine(a, b), c);
        const right = combine(a, combine(b, c));
        if (left === EMPTY) expect(right).toBe(EMPTY);
        else expect(Math.abs(left - right)).toBeLessThanOrEqual(logTol(left));
      }),
      { numRuns: 1000 },
    );
  });

  it('has EMPTY as its identity, exactly', () => {
    fc.assert(
      fc.property(arbScores, ([a]) => {
        expect(combine(a, EMPTY)).toBe(a);
        expect(combine(EMPTY, a)).toBe(a);
      }),
    );
  });

  it('two simultaneous value-1 events add exactly ln 2', () => {
    fc.assert(
      fc.property(arbTime, arbHalfLife, (t, [, h]) => {
        const one = addEvent(EMPTY, 1, t, h);
        const two = addEvent(one, 1, t, h);
        // Bit for bit, the stored score is one + ln 2 rounded once ...
        expect(two).toBe(one + Math.LN2);
        // ... so the step is ln 2 to within half an ulp of the new score.
        expect(Math.abs(two - one - Math.LN2)).toBeLessThanOrEqual(ulp(two) / 2);
      }),
      { numRuns: 1000 },
    );
  });

  it('merges replicas: combining two partial scores equals one score of all events', () => {
    fc.assert(
      fc.property(
        arbHalfLife,
        fc.array(fc.tuple(arbValue, arbTime, fc.boolean()), { minLength: 1, maxLength: 30 }),
        ([, h], events) => {
          let a = EMPTY;
          let b = EMPTY;
          let all = EMPTY;
          for (const [v, t, onA] of events) {
            if (onA) a = addEvent(a, v, t, h);
            else b = addEvent(b, v, t, h);
            all = addEvent(all, v, t, h);
          }
          expect(Math.abs(combine(a, b) - all)).toBeLessThanOrEqual(logTol(all, 8));
        },
      ),
    );
  });
});

describe('combineAll', () => {
  it('handles empty and EMPTY inputs', () => {
    expect(combineAll([])).toBe(EMPTY);
    expect(combineAll([EMPTY, EMPTY])).toBe(EMPTY);
    expect(combineAll([EMPTY, 5])).toBe(5);
    expect(combineAll([1, NaN])).toBeNaN();
  });

  it('equals combine for two scores, exactly', () => {
    fc.assert(
      fc.property(arbHalfLife, arbValue, arbValue, arbTime, arbTime, ([, h], v1, v2, t1, t2) => {
        const a = eventScore(v1, t1, h);
        const b = eventScore(v2, t2, h);
        expect(combineAll([a, b])).toBe(combine(a, b));
      }),
    );
  });

  it('agrees with a left fold of combine within 8 ulps', () => {
    fc.assert(
      fc.property(
        arbHalfLife,
        fc.array(fc.tuple(arbValue, arbTime), { minLength: 1, maxLength: 50 }),
        ([, h], events) => {
          const scores = events.map(([v, t]) => eventScore(v, t, h));
          const folded = scores.reduce(combine, EMPTY);
          expect(Math.abs(combineAll(scores) - folded)).toBeLessThanOrEqual(logTol(folded, 8));
        },
      ),
    );
  });
});

describe('scoreAt', () => {
  it('keeps the order of two items at any later time', () => {
    fc.assert(
      fc.property(
        arbHalfLife,
        fc.array(fc.tuple(arbValue, arbTime), { minLength: 1, maxLength: 10 }),
        fc.array(fc.tuple(arbValue, arbTime), { minLength: 1, maxLength: 10 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        ([, h], ea, eb, f1, f2) => {
          const a = ea.reduce((L, [v, t]) => addEvent(L, v, t, h), EMPTY);
          const b = eb.reduce((L, [v, t]) => addEvent(L, v, t, h), EMPTY);
          // Two moments at or after every event, up to 20 half-lives later
          // (beyond that the smaller scores can underflow to 0 and tie).
          const latest = Math.max(...ea.map(([, t]) => t), ...eb.map(([, t]) => t));
          const now1 = latest + f1 * 20 * h;
          const now2 = latest + f2 * 20 * h;
          const order = (now: number) => Math.sign(scoreAt(a, now, h) - scoreAt(b, now, h));
          expect(order(now1)).toBe(Math.sign(a - b));
          expect(order(now2)).toBe(order(now1));
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('decays as 2^(−Δt/h) to within 8 ulps of the log score at realistic times', () => {
    fc.assert(
      fc.property(
        arbHalfLife,
        arbTime,
        fc.double({ min: 0, max: 5, noNaN: true }),
        ([, h], t, k) => {
          const L = eventScore(1, t, h);
          const s = scoreAt(L, t + k * h, h);
          expect(Math.abs(s / 2 ** -k - 1)).toBeLessThanOrEqual(logTol(L, 8));
        },
      ),
      { numRuns: 2000 },
    );
  });
});
