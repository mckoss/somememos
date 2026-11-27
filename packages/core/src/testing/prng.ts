// A small seeded PRNG (mulberry32) with the helpers the synthetic brain needs.
// Deterministic across platforms: only 32-bit integer math and one division.

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Pick an index with probability proportional to its weight. */
  weighted(weights: readonly number[]): number;
  /** A shuffled copy. */
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  // Mix the seed so that nearby seeds give unrelated streams.
  let state = Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new RangeError('pick from an empty list');
      return items[Math.floor(next() * items.length)]!;
    },
    weighted: (weights) => {
      const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
      if (!(total > 0)) throw new RangeError('weighted pick needs a positive weight');
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= Math.max(0, weights[i]!);
        if (r < 0) return i;
      }
      return weights.length - 1;
    },
    shuffle: (items) => {
      const copy = items.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    },
  };
  return rng;
}
