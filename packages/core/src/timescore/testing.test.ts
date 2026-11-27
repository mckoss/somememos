// Shared helpers for the TimeScore tests (named *.test.ts so the build skips it).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { HALF_LIFE_ENTRIES } from './halfLives.js';
import { EVENT_KINDS } from './kinds.js';

/** A realistic "now": 2027-01-15, in Unix seconds. */
export const T0 = 1_800_000_000;

/** The spacing of adjacent doubles at x (one unit in the last place). */
export function ulp(x: number): number {
  const a = Math.abs(x);
  if (a === 0) return Number.MIN_VALUE;
  return 2 ** (Math.floor(Math.log2(a)) - 52);
}

/**
 * Tolerance for comparing two log scores of magnitude about |x|: a few ulps.
 * Measured worst cases at T0 are about 1 ulp for combine() associativity and
 * about 3 ulps for scoreAt(); see the precision tests.
 */
export function logTol(x: number, ulps = 4): number {
  return ulps * ulp(x);
}

/** A whole-second event time within about three years of T0. */
export const arbTime = fc.integer({ min: T0 - 100_000_000, max: T0 });

/** An event value. */
export const arbValue = fc.double({ min: 1e-3, max: 1e3, noNaN: true, noDefaultInfinity: true });

/** One of the four half-lives, as [name, seconds]. */
export const arbHalfLife = fc.constantFrom(...HALF_LIFE_ENTRIES);

export const arbKind = fc.constantFrom(...EVENT_KINDS);

/** A small set of invented item ids, so events collide on items. */
export const arbItem = fc.constantFrom('alpha', 'beta', 'gamma', 'delta');

export const arbEvent = fc.record(
  { item: arbItem, kind: arbKind, time: arbTime, value: arbValue },
  { requiredKeys: ['item', 'kind', 'time'] },
);

describe('test helpers', () => {
  it('ulp is the spacing of adjacent doubles', () => {
    expect(ulp(1)).toBe(Number.EPSILON);
    expect(ulp(14_440)).toBe(2 ** -39);
    expect(1 + ulp(1)).not.toBe(1);
    expect(1 + ulp(1) / 4).toBe(1);
  });
});
