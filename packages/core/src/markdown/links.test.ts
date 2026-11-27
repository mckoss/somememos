import { describe, expect, it } from 'vitest';
import { parseLinks, parseNote } from './index.js';

const doc = (...lines: string[]) => lines.join('\n');

describe('parseLinks', () => {
  it('finds every link form with line and section', () => {
    const links = parseLinks(
      doc(
        'See [[Alpha]] and [[Beta|the beta]].',
        '## Part',
        'Then [[Gamma#Some heading]] and [[ Delta # Sub | Shown ]].',
        '![[Picture.png]] ![[Epsilon#Intro]]',
      ),
    );
    expect(links).toEqual([
      { target: 'Alpha', embed: false, line: 1, section: 0 },
      { target: 'Beta', alias: 'the beta', embed: false, line: 1, section: 0 },
      { target: 'Gamma', heading: 'Some heading', embed: false, line: 3, section: 1 },
      { target: 'Delta', heading: 'Sub', alias: 'Shown', embed: false, line: 3, section: 1 },
      { target: 'Picture.png', embed: true, line: 4, section: 1 },
      { target: 'Epsilon', heading: 'Intro', embed: true, line: 4, section: 1 },
    ]);
  });

  it('skips links in fenced code, indented code and inline code', () => {
    const links = parseLinks(
      doc(
        'Use `[[not a link]]` but [[Yes]].',
        'A ``code with ` and [[nope]]`` span.',
        '```',
        '[[fenced]]',
        '```',
        '',
        '    [[indented]]',
        '',
        '~~~~',
        '~~~',
        '[[nested fence]]',
        '~~~~',
        'After `unclosed backtick [[Counted]]',
      ),
    );
    expect(links.map((l) => l.target)).toEqual(['Yes', 'Counted']);
  });

  it('masks code spans that cross lines of one paragraph', () => {
    expect(
      parseLinks(doc('start `code', '[[hidden]] end` [[Shown]]')).map((l) => l.target),
    ).toEqual(['Shown']);
  });

  it('ignores empty targets, escapes and links split across lines', () => {
    const links = parseLinks(
      doc('[[]] [[ | x]] [[#Heading only]] \\[[escaped]]', '[[split', 'link]]'),
    );
    expect(links).toEqual([]);
    expect(parseLinks('\\![[NotEmbed]]')).toEqual([
      { target: 'NotEmbed', embed: false, line: 1, section: 0 },
    ]);
  });

  it('reads escaped pipes in tables', () => {
    expect(parseLinks('| [[Note\\|Alias]] | x |')).toEqual([
      { target: 'Note', alias: 'Alias', embed: false, line: 1, section: 0 },
    ]);
  });

  it('counts lines from the file start past front matter and with CRLF', () => {
    const note = parseNote(
      'n.md',
      '---\r\ntitle: [[not here]]\r\n---\r\n\r\n## H\r\nx [[Target]]\r\n',
    );
    expect(note.links).toEqual([{ target: 'Target', embed: false, line: 6, section: 0 }]);
    expect(note.sections[0]?.heading).toBe('H');
  });

  it('finds links in headings and assigns them to that section', () => {
    expect(parseLinks(doc('intro', '## About [[Ünïcode Nöte]]'))).toEqual([
      { target: 'Ünïcode Nöte', embed: false, line: 2, section: 1 },
    ]);
  });

  it('finds links in lists, including nested list content', () => {
    expect(parseLinks(doc('- one [[A]]', '', '    - two [[B]]')).map((l) => l.target)).toEqual([
      'A',
      'B',
    ]);
  });
});
