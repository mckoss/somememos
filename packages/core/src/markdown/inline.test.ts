import { describe, expect, it } from 'vitest';
import { chunkNote } from './chunker.js';
import { splitWikiLink, stripHtmlComments, stripInlineMarkdown } from './inline.js';

describe('stripHtmlComments', () => {
  it('removes comments outside code spans, across lines too', () => {
    expect(stripHtmlComments('a <!-- x --> b <!--> c <!---> d')).toEqual({
      text: 'a  b  c  d',
      open: false,
    });
    expect(stripHtmlComments('keep `<!-- code -->` here')).toEqual({
      text: 'keep `<!-- code -->` here',
      open: false,
    });
    expect(stripHtmlComments('start <!-- open')).toEqual({ text: 'start ', open: true });
    expect(stripHtmlComments('still inside', true)).toEqual({ text: '', open: true });
    expect(stripHtmlComments('ends --> after', true)).toEqual({ text: ' after', open: false });
  });

  it('is linear on many openers', () => {
    const started = performance.now();
    stripHtmlComments('<!-- '.repeat(100_000));
    stripHtmlComments('<!-- a -->'.repeat(100_000));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

/** The regular-expression version of the link, autolink and tag rules, for comparison. */
function stripByRegex(s: string): string {
  return s
    .replace(/!?\[\[([^[\]\n]*)\]\]/g, (_m, inner: string) => {
      const { target, heading, alias } = splitWikiLink(inner);
      return alias ?? (heading ? `${target} > ${heading}` : target);
    })
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/(\*\*|__)(?=\S)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/==(.+?)==/g, '$1')
    .replace(/\*(?=\S)([^*]+?)\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_]+?)_(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('stripInlineMarkdown', () => {
  it('strips links, images, references, autolinks and tags', () => {
    expect(stripInlineMarkdown('A [link](https://example.com) here')).toBe('A link here');
    expect(stripInlineMarkdown('![a picture](pic.png) and [ref][1]')).toBe('a picture and ref');
    expect(stripInlineMarkdown('See <https://example.com/x> or <mailto:a@b.c>')).toBe(
      'See https://example.com/x or mailto:a@b.c',
    );
    expect(stripInlineMarkdown('Some <b>bold</b> <br/> text')).toBe('Some bold text');
    expect(stripInlineMarkdown('**Strong** and [[memos/idea|an idea]]')).toBe('Strong and an idea');
  });

  it('gives the same result as the equivalent regular expressions', () => {
    const alphabet = ['[', ']', '(', ')', '!', '<', '>', '/', 'a', 'Z', ' ', '\n', ':', '*', '_'];
    const words = ['http:', 'https:', 'mailto:', '[[', ']]', '](', '][', '</', '\t'];
    let seed = 12345;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 20_000; round++) {
      let s = '';
      const length = random(24);
      for (let i = 0; i < length; i++) {
        s += random(4) === 0 ? words[random(words.length)] : alphabet[random(alphabet.length)];
      }
      expect(stripInlineMarkdown(s), JSON.stringify(s)).toBe(stripByRegex(s));
    }
  });

  it('takes linear time on hostile headings', () => {
    // These took time quadratic in the length (seconds for tens of kilobytes).
    const n = 400_000;
    for (const hostile of [
      '[['.repeat(n / 2),
      '<a'.repeat(n / 2),
      '[a]('.repeat(n / 4),
      '[a]['.repeat(n / 4),
      '<http:x'.repeat(n / 7),
    ]) {
      const started = performance.now();
      stripInlineMarkdown(hostile);
      chunkNote(`# ${hostile}\n\ntext\n`);
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });
});
