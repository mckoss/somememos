import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BM25F_PARAMS } from './bm25f.js';
import type { Section } from './document.js';
import { analyzeSection } from './document.js';
import { MemoryKeywordIndex } from './memory-index.js';
import { parseQuery } from './query.js';
import { type Posting, type PostingsSource, searchSource } from './search.js';

// All text here is invented.
const filler = (n: number): string =>
  Array.from({ length: n }, (_, i) => `filler${String.fromCharCode(97 + (i % 26))}`).join(' ');

describe('analyzeSection', () => {
  it('produces per-field term frequencies, positions and lengths', () => {
    const a = analyzeSection({
      title: 'Garden Plans',
      heading: 'Planting tomatoes',
      body: 'Tomatoes need sun. More tomatoes, more sun!',
    });
    expect(a.lengths).toEqual({ title: 2, heading: 2, body: 7 });
    expect(a.terms.get('tomato')).toEqual({
      tf: { title: 0, heading: 1, body: 2 },
      positions: { title: [], heading: [1], body: [0, 4] },
    });
    expect(a.terms.get('plan')?.tf).toEqual({ title: 1, heading: 0, body: 0 });
    expect(a.terms.get('plant')?.tf).toEqual({ title: 0, heading: 1, body: 0 });
    expect(a.terms.get('sun')?.positions.body).toEqual([2, 6]);
  });
});

describe('MemoryKeywordIndex ranking behaviour', () => {
  it('a rarer term outweighs a common one', () => {
    const index = new MemoryKeywordIndex();
    for (let i = 0; i < 8; i++) {
      index.add(`common-${i}`, { title: 'Log', heading: '', body: `kettle ${filler(5)}` });
    }
    index.add('rare', { title: 'Log', heading: '', body: `quokka ${filler(5)}` });
    index.add('both-common', { title: 'Log', heading: '', body: `kettle ${filler(5)}` });
    const hits = index.search('quokka kettle');
    expect(hits[0]!.id).toBe('rare');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('a heading match outranks a body match under the default weights', () => {
    const index = new MemoryKeywordIndex();
    index.add('in-heading', { title: 'Journal', heading: 'Zephyr notes', body: filler(20) });
    index.add('in-body', {
      title: 'Journal',
      heading: 'Misc notes',
      body: `zephyr ${filler(19)}`,
    });
    expect(index.search('zephyr').map((h) => h.id)).toEqual(['in-heading', 'in-body']);
  });

  it('a title match outranks a heading match under the default weights', () => {
    const index = new MemoryKeywordIndex();
    index.add('in-title', { title: 'Zephyr', heading: 'Notes', body: filler(10) });
    index.add('in-heading', { title: 'Weather', heading: 'Zephyr', body: filler(10) });
    expect(index.search('zephyr').map((h) => h.id)).toEqual(['in-title', 'in-heading']);
  });

  it('normalizes for length: the same match in a shorter body ranks higher', () => {
    const index = new MemoryKeywordIndex();
    index.add('short', { title: 'T', heading: '', body: `walrus ${filler(5)}` });
    index.add('long', { title: 'T', heading: '', body: `walrus ${filler(200)}` });
    const [first, second] = index.search('walrus');
    expect(first!.id).toBe('short');
    expect(first!.score).toBeGreaterThan(second!.score);
    // With b = 0 for the body, length no longer matters.
    const flat = index.search('walrus', { params: { b: { body: 0 } } });
    expect(flat[0]!.score).toBeCloseTo(flat[1]!.score, 12);
  });

  it('saturates term frequency', () => {
    const index = new MemoryKeywordIndex();
    index.add('one', { title: '', heading: '', body: `ibis ${filler(9)}` });
    index.add('five', { title: '', heading: '', body: `ibis ibis ibis ibis ibis ${filler(5)}` });
    index.add('none', { title: '', heading: '', body: filler(10) });
    const [five, one] = index.search('ibis');
    expect(five!.id).toBe('five');
    expect(five!.score / one!.score).toBeLessThan(5);
    expect(five!.score / one!.score).toBeLessThan(1 + DEFAULT_BM25F_PARAMS.k1);
  });

  it('matches stemmed forms', () => {
    const index = new MemoryKeywordIndex();
    index.add('s', { title: 'Hiking', heading: '', body: 'We hiked the connected trails.' });
    expect(index.search('hike connection trail').map((h) => h.matchedTerms)).toEqual([
      ['hike', 'connect', 'trail'],
    ]);
  });

  it('does not stem when stemming is off', () => {
    const index = new MemoryKeywordIndex({ analyzer: { stem: false } });
    index.add('s', { title: '', heading: '', body: 'We hiked the trails.' });
    expect(index.search('hike')).toEqual([]);
    expect(index.search('hiked').map((h) => h.id)).toEqual(['s']);
  });

  it('OR by default, AND on request', () => {
    const index = new MemoryKeywordIndex();
    index.add('both', { title: '', heading: '', body: 'lantern and compass' });
    index.add('lantern', { title: '', heading: '', body: 'only a lantern' });
    index.add('neither', { title: '', heading: '', body: 'a map' });
    expect(index.search('lantern compass').map((h) => h.id)).toEqual(['both', 'lantern']);
    expect(index.search('lantern compass', { mode: 'all' }).map((h) => h.id)).toEqual(['both']);
    expect(index.search('')).toEqual([]);
    expect(index.search('!!!')).toEqual([]);
  });

  it('supports quoted phrases within a field', () => {
    const index = new MemoryKeywordIndex();
    index.add('phrase', { title: '', heading: '', body: 'the blue heron flew' });
    index.add('apart', { title: '', heading: '', body: 'a heron, blue as the sky' });
    index.add('split', { title: 'Blue', heading: 'Heron', body: '' });
    index.add('version', { title: '', heading: '', body: 'released v1.2.3 today; v1 and 2 3' });
    expect(index.search('"blue heron"').map((h) => h.id)).toEqual(['phrase']);
    expect(index.search('"v1.2.3"').map((h) => h.id)).toEqual(['version']);
    // A phrase and a term: OR semantics. `apart` matches via the term only.
    const hits = index.search('"blue heron" sky');
    expect(hits.map((h) => h.id).sort()).toEqual(['apart', 'phrase']);
    expect(hits.find((h) => h.id === 'apart')!.matchedTerms).toEqual(['sky']);
    expect(index.search('"blue heron" sky', { mode: 'all' })).toEqual([]);
  });

  it('breaks score ties by id and honours limit', () => {
    const index = new MemoryKeywordIndex();
    for (const id of ['c', 'a', 'b']) index.add(id, { title: '', heading: '', body: 'otter' });
    expect(index.search('otter').map((h) => h.id)).toEqual(['a', 'b', 'c']);
    expect(index.search('otter', { limit: 2 }).map((h) => h.id)).toEqual(['a', 'b']);
  });

  it('uses index-level parameter defaults, overridable per search', () => {
    const index = new MemoryKeywordIndex({ params: { weights: { heading: 0 } } });
    index.add('h', { title: '', heading: 'osprey', body: '' });
    expect(index.search('osprey')[0]!.score).toBe(0);
    expect(
      index.search('osprey', { params: { weights: { heading: 2 } } })[0]!.score,
    ).toBeGreaterThan(0);
  });
});

describe('MemoryKeywordIndex maintenance', () => {
  it('add rejects duplicates; replace upserts; remove reports presence', () => {
    const index = new MemoryKeywordIndex();
    index.add('x', { title: 'One', heading: '', body: 'alpha' });
    expect(() => index.add('x', { title: 'Two', heading: '', body: 'beta' })).toThrow();
    index.replace('x', { title: 'Two', heading: '', body: 'beta' });
    index.replace('y', { title: 'Three', heading: '', body: 'gamma' });
    expect(index.size).toBe(2);
    expect(index.search('alpha')).toEqual([]);
    expect(index.search('beta').map((h) => h.id)).toEqual(['x']);
    expect(index.remove('x')).toBe(true);
    expect(index.remove('x')).toBe(false);
    expect(index.has('x')).toBe(false);
    expect(index.documentFrequency('beta')).toBe(0);
    expect(index.statistics()).toEqual({
      sectionCount: 1,
      totalFieldLengths: { title: 1, heading: 0, body: 1 },
      documentFrequencies: [
        ['gamma', 1],
        ['three', 1],
      ],
    });
  });

  it('empty index has zero stats and no hits', () => {
    const index = new MemoryKeywordIndex();
    expect(index.corpusStats()).toEqual({
      sectionCount: 0,
      averageFieldLengths: { title: 0, heading: 0, body: 0 },
    });
    expect(index.search('anything')).toEqual([]);
  });
});

// Random sections over a small vocabulary, so terms collide often.
const word = fc.constantFrom(
  'fox',
  'foxes',
  'den',
  'river',
  'rivers',
  'stone',
  'moss',
  'Owl',
  'v2',
);
const text = fc.array(word, { maxLength: 8 }).map((ws) => ws.join(' '));
const section: fc.Arbitrary<Section> = fc.record({ title: text, heading: text, body: text });
const id = fc.constantFrom('a', 'b', 'c', 'd', 'e');
const op = fc.oneof(
  fc.record({ kind: fc.constant('add' as const), id, section }),
  fc.record({ kind: fc.constant('replace' as const), id, section }),
  fc.record({ kind: fc.constant('remove' as const), id }),
);

describe('MemoryKeywordIndex properties', () => {
  it('stats after any add/replace/remove sequence equal a fresh build of the final content', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), fc.boolean(), (ops, stem) => {
        const index = new MemoryKeywordIndex({ analyzer: { stem } });
        const final = new Map<string, Section>();
        for (const o of ops) {
          if (o.kind === 'add') {
            if (final.has(o.id)) continue;
            index.add(o.id, o.section);
            final.set(o.id, o.section);
          } else if (o.kind === 'replace') {
            index.replace(o.id, o.section);
            final.set(o.id, o.section);
          } else {
            expect(index.remove(o.id)).toBe(final.delete(o.id));
          }
        }
        const fresh = new MemoryKeywordIndex({ analyzer: { stem } });
        for (const [k, s] of [...final].reverse()) fresh.add(k, s);
        expect(index.statistics()).toEqual(fresh.statistics());
        expect(index.corpusStats()).toEqual(fresh.corpusStats());
        for (const q of ['fox', 'river stone', '"moss owl"', 'v2 den']) {
          expect(index.search(q)).toEqual(fresh.search(q));
        }
      }),
    );
  });

  it('scores are non-negative, and positive with positive weights', () => {
    fc.assert(
      fc.property(fc.array(section, { minLength: 1, maxLength: 10 }), text, (sections, q) => {
        const index = new MemoryKeywordIndex();
        sections.forEach((s, i) => index.add(String(i), s));
        for (const hit of index.search(q)) {
          expect(hit.score).toBeGreaterThan(0);
          expect(hit.matchedTerms.length).toBeGreaterThan(0);
        }
      }),
    );
  });

  it('every hit contains a query term, and AND hits are a subset of OR hits', () => {
    fc.assert(
      fc.property(fc.array(section, { minLength: 1, maxLength: 10 }), text, (sections, q) => {
        const index = new MemoryKeywordIndex();
        sections.forEach((s, i) => index.add(String(i), s));
        const any = new Set(index.search(q).map((h) => h.id));
        for (const hit of index.search(q, { mode: 'all' })) expect(any.has(hit.id)).toBe(true);
        const terms = new Set(index.parse(q).terms);
        for (const idx of any) {
          const a = analyzeSection(sections[Number(idx)]!, index.analyzer);
          expect([...a.terms.keys()].some((t) => terms.has(t))).toBe(true);
        }
      }),
    );
  });
});

describe('searchSource over a PostingsSource', () => {
  it('ranks an async source exactly like the memory index', async () => {
    const index = new MemoryKeywordIndex();
    index.add('1', {
      title: 'Bread',
      heading: 'Starter',
      body: 'Feed the starter flour and water.',
    });
    index.add('2', {
      title: 'Bread',
      heading: 'Baking',
      body: 'Bake the loaf when the starter is ready.',
    });
    index.add('3', { title: 'Soup', heading: '', body: 'Water, leeks and potatoes.' });
    const asyncSource: PostingsSource = {
      analyzer: index.analyzer,
      corpusStats: async () => index.corpusStats(),
      documentFrequency: async (t) => index.documentFrequency(t),
      postings: async (t) => index.postings(t),
    };
    for (const q of ['starter water', '"the starter"', 'loaf']) {
      expect(await searchSource(asyncSource, q)).toEqual(index.search(q));
    }
    expect(await searchSource(asyncSource, 'starter water', { mode: 'all' })).toEqual(
      index.search('starter water', { mode: 'all' }),
    );
  });

  it('asks for positions only for phrase queries, and fails clearly without them', async () => {
    const index = new MemoryKeywordIndex();
    index.add('1', { title: '', heading: '', body: 'red kite over the hill' });
    const asked: boolean[] = [];
    const noPositions: PostingsSource = {
      analyzer: index.analyzer,
      corpusStats: () => index.corpusStats(),
      documentFrequency: (t) => index.documentFrequency(t),
      postings: (t, { withPositions }) => {
        asked.push(withPositions);
        return index.postings(t).map(({ positions: _p, ...rest }): Posting => rest);
      },
    };
    expect((await searchSource(noPositions, 'red kite')).map((h) => h.id)).toEqual(['1']);
    expect(asked).toEqual([false, false]);
    await expect(searchSource(noPositions, '"red kite"')).rejects.toThrow(/positions/);
    expect(asked.slice(2)).toEqual([true, true]);
  });

  it('parses with the source analyzer', () => {
    expect(parseQuery('Running', { stem: false }).terms).toEqual(['running']);
    expect(parseQuery('Running').terms).toEqual(['run']);
  });
});
