import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BM25F_PARAMS,
  bm25Idf,
  bm25fPseudoFrequency,
  bm25fScore,
  bm25fTermScore,
  resolveBm25fParams,
} from './bm25f.js';
import { MemoryKeywordIndex } from './memory-index.js';

// A tiny invented corpus, stemming off, default parameters
// (k1 = 1.2; b: title 0.5, heading 0.5, body 0.5; weights: title 5, heading 2, body 1).
//
//   A: title "apple"   heading ""        body "apple banana"               lengths 1/0/2
//   B: title "cherry"  heading "banana"  body "cherry cherry banana date"  lengths 1/1/4
//   C: title "date"    heading ""        body "date"                       lengths 1/0/1
//
//   N = 3; avglen: title 3/3 = 1, heading 1/3, body 7/3.
//
// Query "apple" (df = 1): idf = ln(1 + (3 − 1 + 0.5)/(1 + 0.5)) = ln(8/3) ≈ 0.980829
//   A: title  B = 0.5 + 0.5·1/1 = 1          → 5·1/1      = 5
//      body   B = 0.5 + 0.5·2/(7/3) = 0.928571 → 1·1/0.928571 = 1.076923
//      tf̃ = 6.076923;  s = 0.980829 · 6.076923 · 2.2 / (1.2 + 6.076923) ≈ 1.801989
//
// Query "banana" (df = 2): idf = ln(1 + 1.5/2.5) = ln 1.6 ≈ 0.470004
//   A: body tf̃ = 1.076923;  s = 0.470004 · 1.076923 · 2.2 / 2.276923 ≈ 0.489058
//   B: heading B = 0.5 + 0.5·1/(1/3) = 2 → 2·1/2 = 1
//      body    B = 0.5 + 0.5·4/(7/3) = 1.357143 → 1/1.357143 = 0.736842
//      tf̃ = 1.736842;  s = 0.470004 · 1.736842 · 2.2 / 2.936842 ≈ 0.611510
function tinyCorpus(): MemoryKeywordIndex {
  const index = new MemoryKeywordIndex({ analyzer: { stem: false } });
  index.add('A', { title: 'apple', heading: '', body: 'apple banana' });
  index.add('B', { title: 'cherry', heading: 'banana', body: 'cherry cherry banana date' });
  index.add('C', { title: 'date', heading: '', body: 'date' });
  return index;
}

describe('BM25F by hand', () => {
  it('computes corpus statistics', () => {
    const stats = tinyCorpus().corpusStats();
    expect(stats.sectionCount).toBe(3);
    expect(stats.averageFieldLengths.title).toBe(1);
    expect(stats.averageFieldLengths.heading).toBeCloseTo(1 / 3, 12);
    expect(stats.averageFieldLengths.body).toBeCloseTo(7 / 3, 12);
  });

  it('scores a single-term query', () => {
    expect(bm25Idf(1, 3)).toBeCloseTo(Math.log(8 / 3), 12);
    const hits = tinyCorpus().search('apple');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('A');
    expect(hits[0]!.score).toBeCloseTo(1.801988628, 8);
    expect(hits[0]!.matchedTerms).toEqual(['apple']);
  });

  it('scores across fields and ranks the heading match first', () => {
    const hits = tinyCorpus().search('banana');
    expect(hits.map((h) => h.id)).toEqual(['B', 'A']);
    expect(hits[0]!.score).toBeCloseTo(0.611510098, 8);
    expect(hits[1]!.score).toBeCloseTo(0.48905783, 8);
  });

  it('sums term scores for a multi-term query', () => {
    const hits = tinyCorpus().search('apple banana');
    expect(hits[0]!.id).toBe('A');
    expect(hits[0]!.score).toBeCloseTo(1.801988628 + 0.48905783, 8);
    expect(hits[0]!.matchedTerms).toEqual(['apple', 'banana']);
  });

  it('agrees with the standalone bm25fScore function', () => {
    const index = tinyCorpus();
    const stats = index.corpusStats();
    const tf = new Map(
      ['apple', 'banana'].map((t) => [t, index.postings(t).find((p) => p.id === 'A')!.tf]),
    );
    const df = new Map([
      ['apple', 1],
      ['banana', 2],
    ]);
    const score = bm25fScore(
      ['apple', 'banana'],
      { lengths: { title: 1, heading: 0, body: 2 }, termFrequencies: tf },
      df,
      stats,
    );
    expect(score).toBeCloseTo(index.search('apple banana')[0]!.score, 12);
  });
});

describe('IDF', () => {
  it('is positive for every df in [0, N], even for very common terms', () => {
    for (let n = 0; n <= 50; n++) {
      for (let df = 0; df <= n + 3; df++) expect(bm25Idf(df, n)).toBeGreaterThan(0);
    }
  });

  it('decreases as df grows', () => {
    expect(bm25Idf(1, 100)).toBeGreaterThan(bm25Idf(10, 100));
    expect(bm25Idf(10, 100)).toBeGreaterThan(bm25Idf(100, 100));
  });
});

describe('parameters', () => {
  it('merges partial overrides onto the defaults', () => {
    const p = resolveBm25fParams({ k1: 2, b: { body: 0.3 }, weights: { title: 5 } });
    expect(p).toEqual({
      k1: 2,
      b: { title: 0.5, heading: 0.5, body: 0.3 },
      weights: { title: 5, heading: 2, body: 1 },
    });
    expect(resolveBm25fParams()).toEqual(DEFAULT_BM25F_PARAMS);
  });

  it('defaults to the values measured on 2026-11-27 (PLAN.md section 5)', () => {
    expect(DEFAULT_BM25F_PARAMS).toEqual({
      k1: 1.2,
      b: { title: 0.5, heading: 0.5, body: 0.5 },
      weights: { title: 5, heading: 2, body: 1 },
    });
  });

  it('rejects out-of-range values', () => {
    expect(() => resolveBm25fParams({ k1: -1 })).toThrow(RangeError);
    expect(() => resolveBm25fParams({ b: { title: 1.5 } })).toThrow(RangeError);
    expect(() => resolveBm25fParams({ weights: { body: -0.1 } })).toThrow(RangeError);
    expect(() => resolveBm25fParams({ k1: Number.NaN })).toThrow(RangeError);
  });

  it('changes the ranking when field weights change', () => {
    const index = tinyCorpus();
    // With heading weight 0, B's banana comes only from its longer body.
    const hits = index.search('banana', { params: { weights: { heading: 0 } } });
    expect(hits.map((h) => h.id)).toEqual(['A', 'B']);
  });

  it('k1 = 0 gives a binary term model', () => {
    const p = resolveBm25fParams({ k1: 0 });
    expect(bm25fTermScore(2, 0.5, p)).toBeCloseTo(2, 12);
    expect(bm25fTermScore(2, 7, p)).toBeCloseTo(2, 12);
    expect(bm25fTermScore(2, 0, p)).toBe(0);
  });
});

const fieldNums = fc.record({
  title: fc.integer({ min: 0, max: 20 }),
  heading: fc.integer({ min: 0, max: 20 }),
  body: fc.integer({ min: 0, max: 500 }),
});
const unit = fc.double({ min: 0, max: 1, noNaN: true });
const weight = fc.double({ min: 0, max: 10, noNaN: true });
const params = fc.record({
  k1: fc.double({ min: 0, max: 5, noNaN: true }),
  b: fc.record({ title: unit, heading: unit, body: unit }),
  weights: fc.record({ title: weight, heading: weight, body: weight }),
});

describe('BM25F properties', () => {
  it('term scores are finite and non-negative for any valid input', () => {
    fc.assert(
      fc.property(
        fieldNums,
        fieldNums,
        fc.record({
          title: fc.double({ min: 0, max: 20, noNaN: true }),
          heading: fc.double({ min: 0, max: 20, noNaN: true }),
          body: fc.double({ min: 0, max: 500, noNaN: true }),
        }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        params,
        (tf, lengths, avg, df, n, p) => {
          const pf = bm25fPseudoFrequency(tf, lengths, avg, p);
          const s = bm25fTermScore(bm25Idf(df, n), pf, p);
          expect(Number.isFinite(s)).toBe(true);
          expect(s).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('a higher term frequency never lowers the score', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 50 }),
        params,
        (a, extra, p) => {
          const lengths = { title: 0, heading: 0, body: 60 };
          const avg = { title: 1, heading: 1, body: 40 };
          const s1 = bm25fTermScore(
            1,
            bm25fPseudoFrequency({ title: 0, heading: 0, body: a }, lengths, avg, p),
            p,
          );
          const s2 = bm25fTermScore(
            1,
            bm25fPseudoFrequency({ title: 0, heading: 0, body: a + extra }, lengths, avg, p),
            p,
          );
          expect(s2).toBeGreaterThanOrEqual(s1 - 1e-12);
        },
      ),
    );
  });
});
