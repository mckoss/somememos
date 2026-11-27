import { describe, expect, it } from 'vitest';
import { renderMarkdownUnsafe, splitFrontMatter, type RenderOptions } from './markdown.ts';

const existing = new Set(['quince grafting', 'orchard']);
const options: RenderOptions = {
  resolveLink: (target) => ({
    href: existing.has(target.toLowerCase())
      ? `/note/memos/${target.toLowerCase().replace(/ /g, '-')}.md`
      : `/edit/memos/${encodeURIComponent(target)}.md`,
    exists: existing.has(target.toLowerCase()),
  }),
};
const render = (text: string) => renderMarkdownUnsafe(text, options);

describe('wiki links', () => {
  it('links to existing notes', () => {
    expect(render('See [[Quince Grafting]].')).toContain(
      '<a href="/note/memos/quince-grafting.md" class="wikilink" data-target="Quince Grafting">Quince Grafting</a>',
    );
  });

  it('marks links to notes that do not exist yet', () => {
    const html = render('A [[Compost Tea]] idea');
    expect(html).toContain('class="wikilink wikilink-missing"');
    expect(html).toContain('href="/edit/memos/Compost%20Tea.md"');
    expect(html).toContain('title="Not written yet: opens a new note"');
  });

  it('uses the alias and links to a heading', () => {
    const html = render('[[orchard#Frost Dates|when frost comes]]');
    expect(html).toContain('href="/note/memos/orchard.md#h-frost-dates"');
    expect(html).toContain('>when frost comes</a>');
  });

  it('renders embeds as links', () => {
    expect(render('![[orchard]]')).toContain('class="wikilink wikilink-embed"');
  });

  it('ignores links in code and escaped links', () => {
    expect(render('`[[orchard]]`')).toContain('<code>[[orchard]]</code>');
    expect(render('```\n[[orchard]]\n```')).not.toContain('<a');
    expect(render('\\[[orchard]]')).not.toContain('<a');
  });

  it('escapes link text', () => {
    expect(render('[[<b>x</b>]]')).toContain('&lt;b&gt;x&lt;/b&gt;</a>');
  });

  it('shows a same-note heading link as text', () => {
    expect(render('[[#Recipe]]')).toBe('<p>Recipe</p>\n');
  });
});

describe('the rest of markdown', () => {
  it('gives headings ids', () => {
    expect(render('## Frost *dates*\n\n## Frost dates')).toContain('<h2 id="h-frost-dates-2">');
  });

  it('renders task lists', () => {
    const html = render('- [ ] prune\n- [x] graft');
    expect(html).toContain(
      '<li class="task-list-item"><input type="checkbox" disabled aria-label="Not done"> prune</li>',
    );
    expect(html).toContain('<input type="checkbox" disabled checked aria-label="Done"> graft');
  });

  it('wraps tables so they scroll on their own', () => {
    expect(render('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<div class="table-scroll"');
  });

  it('shows front matter as properties, not as markdown', () => {
    const html = render('---\ntitle: X\npublished: true\n---\n# Post\n');
    expect(html).toContain('<details class="front-matter">');
    expect(html).toContain('title: X\npublished: true');
    expect(html).toContain('<h1 id="h-post">Post</h1>');
  });
});

describe('splitFrontMatter', () => {
  it('splits a block off the top', () => {
    expect(splitFrontMatter('---\na: 1\n---\nBody')).toEqual({ frontMatter: 'a: 1', body: 'Body' });
    expect(splitFrontMatter('---\r\na: 1\r\n---\r\nBody')).toEqual({
      frontMatter: 'a: 1',
      body: 'Body',
    });
    expect(splitFrontMatter('# No\n---\n')).toEqual({ frontMatter: null, body: '# No\n---\n' });
  });
});

describe('hostile input', () => {
  it('renders many unclosed [[ in linear time', () => {
    // An unclosed `[[` used to search the rest of the note for `]]`.
    for (const text of ['[a]['.repeat(100_000), '[['.repeat(200_000)]) {
      const started = performance.now();
      render(text);
      expect(performance.now() - started).toBeLessThan(3000);
    }
  });

  it('links only when the inside has no bracket or line break', () => {
    expect(render('[[orchard]] here')).toContain('data-target="orchard"');
    expect(render('[[a]b]] and [[x\ny]]')).not.toContain('wikilink');
  });
});
