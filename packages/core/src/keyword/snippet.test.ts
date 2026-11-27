import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { makeSnippet, markdownToPlainText } from './snippet.js';

// Invented text only.
const lorem = (n: number, seed = 0): string =>
  Array.from(
    { length: n },
    (_, i) => ['amber', 'quiet', 'meadow', 'lantern', 'pebble'][(i + seed) % 5],
  ).join(' ');

describe('markdownToPlainText', () => {
  it('strips common markdown syntax and keeps the text', () => {
    const md = [
      '## A heading',
      '> quoted **bold** and _kept_snake_case',
      '- [x] done item with [a link](https://example.com)',
      '1. see [[Some Note|the alias]] and [[Other Note]]',
      '```ts',
      'const x = `code`;',
      '```',
      '![diagram](img.png) <br/> ~~gone~~',
    ].join('\n');
    expect(markdownToPlainText(md)).toBe(
      'A heading quoted bold and _kept_snake_case done item with a link see the alias and Other Note const x = code; diagram gone',
    );
  });
});

describe('makeSnippet', () => {
  it('returns short bodies whole, with highlights', () => {
    const s = makeSnippet('The heron waded through *shallow* water.', 'herons water');
    expect(s.text).toBe('The heron waded through shallow water.');
    expect(s.highlights.map((h) => s.text.slice(h.start, h.end))).toEqual(['heron', 'water']);
  });

  it('centres a window of about the target length on the best match, on word boundaries', () => {
    const body = `${lorem(60)} the copper kettle whistled ${lorem(60, 2)}`;
    const s = makeSnippet(body, 'kettle');
    expect(s.text.startsWith('…')).toBe(true);
    expect(s.text.endsWith('…')).toBe(true);
    const inner = s.text.slice(1, -1);
    expect(inner.length).toBeLessThanOrEqual(160);
    expect(inner.length).toBeGreaterThan(120);
    expect(body).toContain(inner);
    // Starts and ends on whole words.
    const words = new Set(body.split(' '));
    for (const w of inner.split(' ')) expect(words.has(w)).toBe(true);
    expect(s.highlights.map((h) => s.text.slice(h.start, h.end))).toEqual(['kettle']);
  });

  it('prefers the region with the most distinct query terms', () => {
    const body = `kettle ${lorem(80)} kettle and copper together ${lorem(80, 1)} copper`;
    const s = makeSnippet(body, 'copper kettle');
    expect(s.text).toContain('kettle and copper together');
  });

  it('falls back to the start of the text when nothing matches', () => {
    const body = lorem(100);
    const s = makeSnippet(body, 'absent');
    expect(s.text.endsWith('…')).toBe(true);
    expect(body.startsWith(s.text.slice(0, -1))).toBe(true);
    expect(s.highlights).toEqual([]);
  });

  it('respects a custom target length and the analyzer options', () => {
    const body = `${lorem(30)} running ${lorem(30)}`;
    expect(makeSnippet(body, 'run', { targetLength: 40 }).text.length).toBeLessThanOrEqual(42);
    expect(makeSnippet(body, 'run', { analyzer: { stem: false } }).highlights).toEqual([]);
  });

  it('never exceeds the target (plus ellipses) unless one match is longer', () => {
    const wordArb = fc.constantFrom(
      'amber',
      'quiet',
      'kettle',
      'meadow',
      'x',
      'supercalifragilistic',
    );
    fc.assert(
      fc.property(
        fc.array(wordArb, { maxLength: 120 }),
        fc.integer({ min: 20, max: 200 }),
        (words, target) => {
          const s = makeSnippet(words.join(' '), 'kettle', { targetLength: target });
          const inner = s.text.replace(/^…/, '').replace(/…$/, '');
          expect(inner.length).toBeLessThanOrEqual(Math.max(target, 'supercalifragilistic'.length));
          for (const h of s.highlights) expect(s.text.slice(h.start, h.end)).toBe('kettle');
        },
      ),
    );
  });
});
