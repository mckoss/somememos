import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { chunkNote, noteTitle, parseNote, scanBlocks, splitLines } from './index.js';

const doc = (...lines: string[]) => lines.join('\n');

describe('splitLines', () => {
  it('handles LF, CRLF, CR, a final newline and a BOM', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\n')).toEqual(['a']);
    expect(splitLines('a\r\nb\rc\n\n')).toEqual(['a', 'b', 'c', '']);
    expect(splitLines('﻿a')).toEqual(['a']);
  });
});

describe('front matter', () => {
  it('extracts a plain title and keeps line numbers', () => {
    const note = parseNote(
      'x.md',
      doc('---', 'tags: [a, b]', 'title: Garden plans', '---', 'Intro', '## Beds', 'Soil'),
    );
    expect(note.title).toBe('Garden plans');
    expect(note.bodyStartLine).toBe(5);
    expect(note.sections.map((s) => [s.heading, s.startLine, s.endLine])).toEqual([
      [null, 5, 5],
      ['Beds', 6, 7],
    ]);
  });

  it.each([
    ['title: "Quoted: with colon"', 'Quoted: with colon'],
    ["title: 'It''s single'", "It's single"],
    ['title: "Esc \\"q\\" \\u00e9"', 'Esc "q" é'],
    ['title: Plain # a comment', 'Plain'],
    ['title: "Trailing" # comment', 'Trailing'],
    ['title:   Ünïcödé 标题  ', 'Ünïcödé 标题'],
  ])('parses %s', (line, title) => {
    expect(noteTitle('fallback.md', doc('---', line, '---'))).toBe(title);
  });

  it('folds a plain title continued on indented lines', () => {
    expect(noteTitle('f.md', doc('---', 'title: A long', '  title here', 'x: 1', '---'))).toBe(
      'A long title here',
    );
  });

  it.each([
    'title:',
    'title: ""',
    'title: ~',
    'title: null',
    'title: [a, b]',
    'title: |',
    'title: "unterminated',
    'title: "bad" trailing',
    '  title: nested',
    'subtitle: no',
  ])('ignores a non-simple title: %s', (line) => {
    expect(noteTitle('memos/Fallback name.md', doc('---', line, '---', '# Heading title'))).toBe(
      'Heading title',
    );
  });

  it('needs a closing delimiter, and accepts ...', () => {
    expect(scanBlocks(doc('---', 'title: x', 'body')).frontMatter).toBeNull();
    expect(scanBlocks(doc('---', 'title: x', '...', 'body')).frontMatter?.title).toBe('x');
    expect(scanBlocks(doc('text', '---', 'title: x', '---')).frontMatter).toBeNull();
  });

  it('works with CRLF line endings', () => {
    const note = parseNote('a.md', '---\r\ntitle: Crlf\r\n---\r\n## One\r\nbody\r\n');
    expect(note.title).toBe('Crlf');
    expect(note.sections).toEqual([
      { index: 0, heading: 'One', body: 'body', startLine: 4, endLine: 5 },
    ]);
  });
});

describe('title', () => {
  it('uses the first level-1 heading, inline markdown stripped', () => {
    expect(noteTitle('a.md', doc('intro', '## Not this', '# The **real** `title` #'))).toBe(
      'The real title',
    );
  });

  it('skips an empty H1 and headings in code', () => {
    expect(noteTitle('a.md', doc('```', '# In code', '```', '#', '# Später')).toString()).toBe(
      'Später',
    );
  });

  it('falls back to the file name without .md', () => {
    expect(noteTitle('memos/sub/Café notes.MD', 'no headings')).toBe('Café notes');
    expect(noteTitle('Top.md', '')).toBe('Top');
  });

  it('does not treat #tags as headings', () => {
    expect(noteTitle('t.md', '#tag only')).toBe('t');
  });
});

describe('chunkNote', () => {
  it('splits a preamble and one section per ## heading', () => {
    const sections = chunkNote(
      doc('# Title', 'intro', '', '## First', 'a', '### Sub', 'b', '', '## Second', 'c', ''),
    );
    expect(sections).toEqual([
      { index: 0, heading: null, body: '# Title\nintro', startLine: 1, endLine: 3 },
      { index: 1, heading: 'First', body: 'a\n### Sub\nb', startLine: 4, endLine: 8 },
      { index: 2, heading: 'Second', body: 'c', startLine: 9, endLine: 10 },
    ]);
  });

  it('omits an empty preamble and keeps heading-only sections', () => {
    expect(chunkNote(doc('', '  ', '## A', '## B'))).toEqual([
      { index: 0, heading: 'A', body: '', startLine: 3, endLine: 3 },
      { index: 1, heading: 'B', body: '', startLine: 4, endLine: 4 },
    ]);
    expect(chunkNote('')).toEqual([]);
  });

  it('strips closing hashes and inline markdown from headings', () => {
    const headings = chunkNote(
      doc(
        '## Closing ##',
        '##   Spaced   ###   ',
        '## C# is #1',
        '## ##',
        '## [[Some Note|Alias]] and [[Other#Part]]',
        '## A [link](https://x.test) *em* __strong__ ~~del~~ `co*de*` <b>tag</b> snake_case_word',
        '## Ünïcödé — 見出し',
      ),
    ).map((s) => s.heading);
    expect(headings).toEqual([
      'Closing',
      'Spaced',
      'C# is #1',
      '',
      'Alias and Other > Part',
      'A link em strong del co*de* tag snake_case_word',
      'Ünïcödé — 見出し',
    ]);
  });

  it('requires a space after the hashes and at most 3 spaces of indent', () => {
    expect(chunkNote(doc('##NoSpace', '   ## Indented three', '    ## Indented four'))).toEqual([
      { index: 0, heading: null, body: '##NoSpace', startLine: 1, endLine: 1 },
      {
        index: 1,
        heading: 'Indented three',
        body: '    ## Indented four',
        startLine: 2,
        endLine: 3,
      },
    ]);
  });

  it('ignores headings inside fenced code, including nested and longer fences', () => {
    const sections = chunkNote(
      doc(
        '## Real',
        '````markdown',
        '```',
        '## inside nested fence',
        '```',
        '````',
        '~~~ info string',
        '## inside tilde fence',
        '```',
        '~~~',
        '``` js `bad info`',
        '## after a non-fence',
      ),
    );
    expect(sections.map((s) => s.heading)).toEqual(['Real', 'after a non-fence']);
  });

  it('treats an unclosed fence as running to the end', () => {
    expect(chunkNote(doc('## A', '```', '## hidden')).map((s) => s.heading)).toEqual(['A']);
  });

  it('ignores headings in indented code, but not in list continuations', () => {
    expect(chunkNote(doc('intro', '', '    ## code', '## Real')).map((s) => s.heading)).toEqual([
      null,
      'Real',
    ]);
    const scan = scanBlocks(doc('- item', '', '    nested [[link]]', 'para', '    lazy line'));
    expect(scan.lines.map((l) => l.kind)).toEqual(['text', 'blank', 'text', 'text', 'text']);
    expect(scanBlocks(doc('para', '', '    code')).lines.map((l) => l.kind)).toEqual([
      'text',
      'blank',
      'code',
    ]);
  });

  it('does not treat Setext headings as sections', () => {
    expect(chunkNote(doc('Heading', '---', 'Other', '===')).map((s) => s.heading)).toEqual([null]);
  });

  it('covers every non-front-matter line exactly once, in order', () => {
    const line = fc.oneof(
      fc.constantFrom('## H', '# T', '### S', '```', '~~~~', '', '    code', '- li', 'text', '---'),
      fc.string({ maxLength: 8 }).map((s) => s.replace(/[\r\n]/g, '')),
    );
    fc.assert(
      fc.property(
        fc.array(line, { maxLength: 30 }),
        fc.constantFrom('\n', '\r\n'),
        (lines, eol) => {
          const text = lines.join(eol);
          const scan = scanBlocks(text);
          const sections = chunkNote(text);
          let next = scan.bodyStart + 1;
          const total = scan.lines.length;
          sections.forEach((s, i) => {
            expect(s.index).toBe(i);
            if (i === 0 && s.startLine !== next) {
              // Only an omitted, blank preamble may be skipped.
              for (let l = next; l < s.startLine; l++)
                expect(scan.lines[l - 1]?.kind).toBe('blank');
            } else {
              expect(s.startLine).toBe(next);
            }
            expect(s.endLine).toBeGreaterThanOrEqual(s.startLine);
            next = s.endLine + 1;
          });
          if (sections.length === 0) {
            for (let l = scan.bodyStart; l < total; l++) expect(scan.lines[l]?.kind).toBe('blank');
          } else {
            expect(next).toBe(total + 1);
          }
        },
      ),
    );
  });
});
