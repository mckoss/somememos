import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { analyze } from './analyze.js';
import { tokenize } from './tokenize.js';

const texts = (s: string): string[] => tokenize(s).map((t) => t.text);

describe('tokenize', () => {
  it('lowercases and splits on non-letter, non-digit characters', () => {
    expect(texts('Hello, World! Tea-time at 4pm.')).toEqual([
      'hello',
      'world',
      'tea',
      'time',
      'at',
      '4pm',
    ]);
  });

  it('returns nothing for empty or punctuation-only text', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('  -- !! ** ')).toEqual([]);
  });

  it('strips diacritics, precomposed or combining', () => {
    expect(texts('Café crème Ångström naïve')).toEqual(['cafe', 'creme', 'angstrom', 'naive']);
    expect(texts('café au lait')).toEqual(['cafe', 'au', 'lait']);
  });

  it('applies compatibility folding', () => {
    expect(texts('ﬁle ① Ⅻ ＡＢＣ')).toEqual(['file', '1', 'xii', 'abc']);
  });

  it('keeps letters from other scripts and does not segment them', () => {
    expect(texts('Привет мир 東京タワー')).toEqual(['привет', 'мир', '東京タワー']);
  });

  it('is locale-independent for dotted and dotless i', () => {
    expect(texts('İstanbul DIŞ')).toEqual(['istanbul', 'dis']);
  });

  it('handles identifiers as documented', () => {
    expect(texts('snake_case')).toEqual(['snake', 'case']);
    expect(texts('kebab-case')).toEqual(['kebab', 'case']);
    expect(texts('camelCase PascalCase')).toEqual(['camelcase', 'pascalcase']);
    expect(texts('v1.2.3')).toEqual(['v1', '2', '3']);
    expect(texts('path/to/file.md')).toEqual(['path', 'to', 'file', 'md']);
  });

  it('drops inner apostrophes and splits on others', () => {
    expect(texts("don't Ada's it’s")).toEqual(['dont', 'adas', 'its']);
    expect(texts("the students' 'quoted'")).toEqual(['the', 'students', 'quoted']);
    expect(texts("rock'n'roll")).toEqual(['rocknroll']);
    expect(texts("4'5")).toEqual(['4', '5']);
  });

  it('reports ordinal positions and offsets into the original text', () => {
    const text = 'Crème brûlée, s’il vous plaît';
    const tokens = tokenize(text);
    expect(tokens.map((t) => t.position)).toEqual([0, 1, 2, 3, 4]);
    expect(tokens.map((t) => text.slice(t.start, t.end))).toEqual([
      'Crème',
      'brûlée',
      's’il',
      'vous',
      'plaît',
    ]);
  });

  it('splits a compatibility character that folds to several tokens', () => {
    const tokens = tokenize('x ℀ y');
    expect(tokens.map((t) => t.text)).toEqual(['x', 'a', 'c', 'y']);
    expect(tokens[1]!.start).toBe(tokens[2]!.start);
  });

  it('offsets cover combining marks and astral code points', () => {
    const text = 'été 𝐀𝐁 end';
    const tokens = tokenize(text);
    expect(tokens.map((t) => t.text)).toEqual(['ete', 'ab', 'end']);
    expect(tokens.map((t) => text.slice(t.start, t.end))).toEqual(['été', '𝐀𝐁', 'end']);
  });

  it('is deterministic and every token is non-empty letters and digits', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 60 }), (s) => {
        const a = tokenize(s);
        expect(tokenize(s)).toEqual(a);
        a.forEach((t, i) => {
          expect(t.position).toBe(i);
          expect(t.text).toMatch(/^[\p{L}\p{N}]+$/u);
          expect(t.start).toBeLessThan(t.end);
          // One source character can fold into several tokens (℀ → a/c),
          // which then share its span; otherwise spans are in order.
          if (i > 0) expect(t.start).toBeGreaterThanOrEqual(a[i - 1]!.start);
          if (i > 0) expect(t.end).toBeGreaterThanOrEqual(a[i - 1]!.end);
        });
      }),
    );
  });
});

describe('analyze', () => {
  it('stems ASCII-letter tokens by default', () => {
    expect(analyze('Running connections in v2 cafés').map((t) => t.text)).toEqual([
      'run',
      'connect',
      'in',
      'v2',
      'cafe',
    ]);
  });

  it('can switch stemming off', () => {
    expect(analyze('Running connections', { stem: false }).map((t) => t.text)).toEqual([
      'running',
      'connections',
    ]);
  });
});
